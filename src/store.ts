// Storage layer. Redis in prod, in-memory fallback for tests / no-redis dev.
import { Redis } from "ioredis";

export type Message = {
  id: number;
  from: string;
  body: string;
  ts: number;
};

export type Room = {
  slug: string;
  createdAt: number;
  private: boolean;
  // secret stored only for private rooms; never returned after creation
};

export interface Store {
  createRoom(slug: string, isPrivate: boolean, secret?: string): Promise<void>;
  getRoom(slug: string): Promise<Room | null>;
  getRoomSecret(slug: string): Promise<string | null>;
  appendMessage(slug: string, m: Omit<Message, "id">): Promise<Message>;
  listMessages(slug: string, sinceId?: number): Promise<Message[]>;
  messageCount(slug: string): Promise<number>;
  markPaid(slug: string, paymentId: string): Promise<boolean>; // true if newly recorded
  publish(slug: string, m: Message): Promise<void>;
  subscribe(slug: string, cb: (m: Message) => void): Promise<() => void>;
}

class MemoryStore implements Store {
  rooms = new Map<string, Room>();
  secrets = new Map<string, string>();
  messages = new Map<string, Message[]>();
  paidPayments = new Set<string>();
  subs = new Map<string, Set<(m: Message) => void>>();

  async createRoom(slug: string, isPrivate: boolean, secret?: string) {
    if (this.rooms.has(slug)) throw new Error("collision");
    this.rooms.set(slug, { slug, createdAt: Date.now(), private: isPrivate });
    if (secret) this.secrets.set(slug, secret);
    this.messages.set(slug, []);
  }
  async getRoom(slug: string) { return this.rooms.get(slug) ?? null; }
  async getRoomSecret(slug: string) { return this.secrets.get(slug) ?? null; }
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
  async markPaid(slug: string, paymentId: string) {
    const k = `${slug}:${paymentId}`;
    if (this.paidPayments.has(k)) return false;
    this.paidPayments.add(k);
    return true;
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
    msgs: (s: string) => `baton:msgs:${s}`,
    paid: (s: string, p: string) => `baton:paid:${s}:${p}`,
    chan: (s: string) => `baton:msg:${s}`,
  };
  async createRoom(slug: string, isPrivate: boolean, secret?: string) {
    const ok = await this.cmd.setnx(this.k.room(slug), JSON.stringify({
      slug, createdAt: Date.now(), private: isPrivate,
    }));
    if (!ok) throw new Error("collision");
    if (secret) await this.cmd.set(this.k.secret(slug), secret);
  }
  async getRoom(slug: string) {
    const raw = await this.cmd.get(this.k.room(slug));
    return raw ? JSON.parse(raw) as Room : null;
  }
  async getRoomSecret(slug: string) {
    return await this.cmd.get(this.k.secret(slug));
  }
  async appendMessage(slug: string, m: Omit<Message, "id">) {
    const id = await this.cmd.rpush(this.k.msgs(slug), "placeholder");
    const msg: Message = { ...m, id };
    await this.cmd.lset(this.k.msgs(slug), id - 1, JSON.stringify(msg));
    return msg;
  }
  async listMessages(slug: string, sinceId = 0) {
    const raw = await this.cmd.lrange(this.k.msgs(slug), sinceId, -1);
    return raw.map(r => JSON.parse(r) as Message);
  }
  async messageCount(slug: string) {
    return await this.cmd.llen(this.k.msgs(slug));
  }
  async markPaid(slug: string, paymentId: string) {
    const ok = await this.cmd.set(this.k.paid(slug, paymentId), "1", "EX", 86400, "NX");
    return ok === "OK";
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
