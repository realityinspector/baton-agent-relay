// Storage layer. Redis in prod, in-memory fallback for tests / no-redis dev.
import { Redis } from "ioredis";

export type Message = {
  id: number;
  from: string;
  body: string;
  ts: number;
  // Optional fields. Populated only when relevant; omitted in JSON when undefined.
  reply_to?: number;       // id of the message this is a reply to (correlation primitive)
  prev_hash?: string;      // hash of the previous message; "" for id=1. Hex sha256.
  hash?: string;           // hash of THIS message: sha256(prev_hash|id|from|body). Hex.
  pubkey?: string;         // ed25519 pubkey (hex) of the author, attest mode only
  sig?: string;            // ed25519 signature (hex), attest mode only
};

export type RoomMode = "public" | "private" | "signed" | "attest";

export type Room = {
  slug: string;
  createdAt: number;
  private: boolean;
  signed: boolean;
  attest?: boolean;
  // bearer secret (private rooms) and signing key (signed rooms) are stored
  // separately and never returned after creation.
};

// Constraints attached to a derived (macaroon-style) write capability.
export type KeyCaveats = {
  master: string;          // the slug of the room this derived key authorizes
  parent: string;          // the parent signingKey it was derived from (for audit)
  expires: number;         // unix ms; 0 = no expiry
  maxUses: number;         // 0 = unlimited
  fromPrefix: string;      // "" = no constraint; otherwise from must startWith
};

export interface Store {
  createRoom(
    slug: string,
    isPrivate: boolean,
    isSigned: boolean,
    isAttest: boolean,
    secret?: string,
    signingKey?: string,
  ): Promise<void>;
  getRoom(slug: string): Promise<Room | null>;
  getRoomSecret(slug: string): Promise<string | null>;
  getRoomSigningKey(slug: string): Promise<string | null>;
  appendMessage(slug: string, m: Omit<Message, "id">): Promise<Message>;
  listMessages(slug: string, sinceId?: number): Promise<Message[]>;
  messageCount(slug: string): Promise<number>;
  lastHash(slug: string): Promise<string>; // "" when no messages
  markPaid(slug: string, paymentId: string): Promise<boolean>; // true if newly recorded
  // Idempotency: simple read + NX-write. Caller pattern: peek; if null, do
  // work; NX-write the result. Concurrent retries both do the work; the
  // first to write wins, subsequent retries replay the winner.
  getIdempotency(slug: string, key: string): Promise<string | null>;
  setIdempotency(slug: string, key: string, value: string, ttlSec: number): Promise<void>;
  // Attest-mode TOFU pubkey registry: returns the existing pubkey for `from`
  // if any, else stores `pubkey` and returns it.
  registerOrCheckPubkey(slug: string, from: string, pubkey: string): Promise<string>;
  // Derived-key caveat storage.
  putDerivedKey(derivedKey: string, caveats: KeyCaveats): Promise<void>;
  getDerivedKey(derivedKey: string): Promise<KeyCaveats | null>;
  incrDerivedKeyUses(derivedKey: string): Promise<number>; // returns new count
  // Rate-limit token bucket. Fixed-window per (bucket, windowSec). Returns
  // the post-increment count. Caller compares to capacity.
  incrRateBucket(bucket: string, windowSec: number): Promise<number>;
  publish(slug: string, m: Message): Promise<void>;
  subscribe(slug: string, cb: (m: Message) => void): Promise<() => void>;
}

class MemoryStore implements Store {
  rooms = new Map<string, Room>();
  secrets = new Map<string, string>();
  signingKeys = new Map<string, string>();
  messages = new Map<string, Message[]>();
  paidPayments = new Set<string>();
  subs = new Map<string, Set<(m: Message) => void>>();

  idem = new Map<string, { value: string; expires: number }>();
  pubkeys = new Map<string, string>(); // key: `${slug}:${from}`
  derivedKeys = new Map<string, KeyCaveats>();
  derivedKeyUses = new Map<string, number>();

  async createRoom(slug: string, isPrivate: boolean, isSigned: boolean, isAttest: boolean, secret?: string, signingKey?: string) {
    if (this.rooms.has(slug)) throw new Error("collision");
    this.rooms.set(slug, { slug, createdAt: Date.now(), private: isPrivate, signed: isSigned, attest: isAttest });
    if (secret) this.secrets.set(slug, secret);
    if (signingKey) this.signingKeys.set(slug, signingKey);
    this.messages.set(slug, []);
  }
  async getRoom(slug: string) { return this.rooms.get(slug) ?? null; }
  async getRoomSecret(slug: string) { return this.secrets.get(slug) ?? null; }
  async getRoomSigningKey(slug: string) { return this.signingKeys.get(slug) ?? null; }
  async appendMessage(slug: string, m: Omit<Message, "id">) {
    const arr = this.messages.get(slug)!;
    const msg: Message = { ...m, id: arr.length + 1 };
    arr.push(msg);
    return msg;
  }
  async listMessages(slug: string, sinceId = 0) {
    return (this.messages.get(slug) ?? []).filter(m => m.id > sinceId);
  }
  async messageCount(slug: string) { return (this.messages.get(slug) ?? []).length; }
  async lastHash(slug: string) {
    const arr = this.messages.get(slug) ?? [];
    if (arr.length === 0) return "";
    return arr[arr.length - 1].hash ?? "";
  }
  async markPaid(slug: string, paymentId: string) {
    const k = `${slug}:${paymentId}`;
    if (this.paidPayments.has(k)) return false;
    this.paidPayments.add(k);
    return true;
  }
  async getIdempotency(slug: string, key: string) {
    const k = `${slug}:${key}`;
    const e = this.idem.get(k);
    if (e && e.expires > Date.now()) return e.value;
    return null;
  }
  async setIdempotency(slug: string, key: string, value: string, ttlSec: number) {
    const k = `${slug}:${key}`;
    if (this.idem.has(k) && (this.idem.get(k)!.expires > Date.now())) return; // NX
    this.idem.set(k, { value, expires: Date.now() + ttlSec * 1000 });
  }
  async registerOrCheckPubkey(slug: string, from: string, pubkey: string) {
    const k = `${slug}:${from}`;
    const existing = this.pubkeys.get(k);
    if (existing) return existing;
    this.pubkeys.set(k, pubkey);
    return pubkey;
  }
  async putDerivedKey(derivedKey: string, caveats: KeyCaveats) {
    this.derivedKeys.set(derivedKey, caveats);
    this.derivedKeyUses.set(derivedKey, 0);
  }
  async getDerivedKey(derivedKey: string) {
    return this.derivedKeys.get(derivedKey) ?? null;
  }
  async incrDerivedKeyUses(derivedKey: string) {
    const n = (this.derivedKeyUses.get(derivedKey) ?? 0) + 1;
    this.derivedKeyUses.set(derivedKey, n);
    return n;
  }
  rateBuckets = new Map<string, { count: number; expires: number }>();
  async incrRateBucket(bucket: string, windowSec: number) {
    const now = Date.now();
    const k = `${bucket}:${Math.floor(now / (windowSec * 1000))}`;
    const e = this.rateBuckets.get(k);
    if (!e || e.expires < now) {
      this.rateBuckets.set(k, { count: 1, expires: now + windowSec * 1000 });
      return 1;
    }
    e.count++;
    return e.count;
  }
  async publish(slug: string, m: Message) {
    const set = this.subs.get(slug);
    if (set) for (const cb of set) cb(m);
  }
  async subscribe(slug: string, cb: (m: Message) => void) {
    let set = this.subs.get(slug);
    if (!set) { set = new Set(); this.subs.set(slug, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }
}

class RedisStore implements Store {
  pub: Redis;
  sub: Redis;
  cmd: Redis;
  channels = new Map<string, Set<(m: Message) => void>>();
  constructor(url: string) {
    this.cmd = new Redis(url);
    this.pub = new Redis(url);
    this.sub = new Redis(url);
    this.sub.on("message", (chan, raw) => {
      const slug = chan.replace(/^baton:msg:/, "");
      const set = this.channels.get(slug);
      if (!set) return;
      const m = JSON.parse(raw) as Message;
      for (const cb of set) cb(m);
    });
  }
  k = {
    room: (s: string) => `baton:room:${s}`,
    secret: (s: string) => `baton:secret:${s}`,
    sigkey: (s: string) => `baton:sigkey:${s}`,
    msgs: (s: string) => `baton:msgs:${s}`,
    lasthash: (s: string) => `baton:lasthash:${s}`,
    paid: (s: string, p: string) => `baton:paid:${s}:${p}`,
    chan: (s: string) => `baton:msg:${s}`,
    idem: (s: string, k: string) => `baton:idem:${s}:${k}`,
    pubkey: (s: string, f: string) => `baton:pubkey:${s}:${f}`,
    derived: (k: string) => `baton:derived:${k}`,
    derivedUses: (k: string) => `baton:derived-uses:${k}`,
  };
  async createRoom(slug: string, isPrivate: boolean, isSigned: boolean, isAttest: boolean, secret?: string, signingKey?: string) {
    const ok = await this.cmd.setnx(this.k.room(slug), JSON.stringify({
      slug, createdAt: Date.now(), private: isPrivate, signed: isSigned, attest: isAttest,
    }));
    if (!ok) throw new Error("collision");
    if (secret) await this.cmd.set(this.k.secret(slug), secret);
    if (signingKey) await this.cmd.set(this.k.sigkey(slug), signingKey);
  }
  async getRoom(slug: string) {
    const raw = await this.cmd.get(this.k.room(slug));
    if (!raw) return null;
    const r = JSON.parse(raw) as Room;
    // backwards-compat: rooms created before signed flag existed
    if (typeof (r as any).signed !== "boolean") (r as any).signed = false;
    if (typeof (r as any).attest !== "boolean") (r as any).attest = false;
    return r;
  }
  async getRoomSecret(slug: string) {
    return await this.cmd.get(this.k.secret(slug));
  }
  async getRoomSigningKey(slug: string) {
    return await this.cmd.get(this.k.sigkey(slug));
  }
  async appendMessage(slug: string, m: Omit<Message, "id">) {
    const id = await this.cmd.rpush(this.k.msgs(slug), "placeholder");
    const msg: Message = { ...m, id };
    await this.cmd.lset(this.k.msgs(slug), id - 1, JSON.stringify(msg));
    if (msg.hash) await this.cmd.set(this.k.lasthash(slug), msg.hash);
    return msg;
  }
  async listMessages(slug: string, sinceId = 0) {
    const raw = await this.cmd.lrange(this.k.msgs(slug), sinceId, -1);
    return raw.map(r => JSON.parse(r) as Message);
  }
  async messageCount(slug: string) {
    return await this.cmd.llen(this.k.msgs(slug));
  }
  async lastHash(slug: string) {
    return (await this.cmd.get(this.k.lasthash(slug))) || "";
  }
  async markPaid(slug: string, paymentId: string) {
    const ok = await this.cmd.set(this.k.paid(slug, paymentId), "1", "EX", 86400, "NX");
    return ok === "OK";
  }
  async getIdempotency(slug: string, key: string) {
    return await this.cmd.get(this.k.idem(slug, key));
  }
  async setIdempotency(slug: string, key: string, value: string, ttlSec: number) {
    await this.cmd.set(this.k.idem(slug, key), value, "EX", ttlSec, "NX");
  }
  async registerOrCheckPubkey(slug: string, from: string, pubkey: string) {
    const k = this.k.pubkey(slug, from);
    const ok = await this.cmd.set(k, pubkey, "NX");
    if (ok === "OK") return pubkey;
    return (await this.cmd.get(k)) || pubkey;
  }
  async putDerivedKey(derivedKey: string, caveats: KeyCaveats) {
    const ttl = caveats.expires > 0 ? Math.max(1, Math.ceil((caveats.expires - Date.now()) / 1000)) : 0;
    if (ttl > 0) await this.cmd.set(this.k.derived(derivedKey), JSON.stringify(caveats), "EX", ttl);
    else await this.cmd.set(this.k.derived(derivedKey), JSON.stringify(caveats));
  }
  async getDerivedKey(derivedKey: string) {
    const raw = await this.cmd.get(this.k.derived(derivedKey));
    return raw ? JSON.parse(raw) as KeyCaveats : null;
  }
  async incrDerivedKeyUses(derivedKey: string) {
    return await this.cmd.incr(this.k.derivedUses(derivedKey));
  }
  async incrRateBucket(bucket: string, windowSec: number) {
    const window = Math.floor(Date.now() / (windowSec * 1000));
    const key = `baton:rl:${bucket}:${window}`;
    const n = await this.cmd.incr(key);
    if (n === 1) await this.cmd.expire(key, windowSec + 1);
    return n;
  }
  async publish(slug: string, m: Message) {
    await this.pub.publish(this.k.chan(slug), JSON.stringify(m));
  }
  async subscribe(slug: string, cb: (m: Message) => void) {
    let set = this.channels.get(slug);
    if (!set) {
      set = new Set();
      this.channels.set(slug, set);
      await this.sub.subscribe(this.k.chan(slug));
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.channels.delete(slug);
        this.sub.unsubscribe(this.k.chan(slug)).catch(() => {});
      }
    };
  }
}

export function makeStore(): Store {
  const url = process.env.REDIS_URL;
  if (url) return new RedisStore(url);
  return new MemoryStore();
}
