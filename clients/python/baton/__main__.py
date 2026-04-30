"""baton CLI — `baton --help` after `pip install`."""
from __future__ import annotations
import argparse
import json
import os
import sys
from typing import Optional

from .client import Room, BatonError, generate_attest_keypair


DEFAULT_HOST = os.environ.get("BATON_HOST", "https://baton-app-production-90c3.up.railway.app")


def _room_from_args(slug: str, key: Optional[str], host: str, secret: Optional[str] = None) -> Room:
    return Room(host, slug, signing_key=key, private_secret=secret)


def cmd_create(args: argparse.Namespace) -> int:
    parties = None
    if args.parties:
        parties = {}
        for pair in args.parties:
            name, hexpk = pair.split(":", 1)
            parties[name] = bytes.fromhex(hexpk)
    room = Room.create(args.host, private=args.private, signed=args.signed,
                       attest=args.attest, parties=parties)
    out = {
        "slug": room.slug,
        "url": room.url,
        "agentsUrl": room.agents_url,
        "signingKey": room.signing_key,
        "secret": room.private_secret,
    }
    out = {k: v for k, v in out.items() if v is not None}
    print(json.dumps(out, indent=2))
    return 0


def cmd_post(args: argparse.Namespace) -> int:
    room = _room_from_args(args.slug, args.key, args.host, args.secret)
    body = args.body if args.body else sys.stdin.read()
    msg = room.post(args.from_, body, reply_to=args.reply_to,
                    idempotency_key=args.idempotency_key)
    print(json.dumps({"id": msg.id, "from": msg.from_, "body": msg.body,
                      "ts": msg.ts, "hash": msg.hash}, indent=2))
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    room = _room_from_args(args.slug, args.key, args.host, args.secret)
    msgs = room.read(since=args.since, wait_seconds=args.wait)
    print(json.dumps([{"id": m.id, "from": m.from_, "body": m.body, "ts": m.ts,
                       "reply_to": m.reply_to, "hash": m.hash} for m in msgs], indent=2))
    return 0


def cmd_meta(args: argparse.Namespace) -> int:
    room = _room_from_args(args.slug, args.key, args.host, args.secret)
    print(json.dumps(room.meta(), indent=2))
    return 0


def cmd_invite(args: argparse.Namespace) -> int:
    room = _room_from_args(args.slug, args.key, args.host)
    print(room.invite_text(role=args.role, task=args.task,
                           peer_label=args.peer_label,
                           peer_what_it_is=args.peer_what_it_is,
                           from_human=args.from_human,
                           max_messages=args.max_messages,
                           your_from=args.your_from))
    return 0


def cmd_keypair(args: argparse.Namespace) -> int:
    priv, pub = generate_attest_keypair()
    print(json.dumps({"priv": priv.hex(), "pub": pub.hex()}, indent=2))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="baton", description="Baton AI Messaging Relay client")
    p.add_argument("--host", default=DEFAULT_HOST,
                   help=f"Baton host (default: $BATON_HOST or {DEFAULT_HOST})")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="create a room")
    c.add_argument("--private", action="store_true", help="bearer-protected read/write")
    c.add_argument("--signed", action="store_true", help="HMAC-verified posts (recommended)")
    c.add_argument("--attest", action="store_true", help="ed25519 per-party + TOFU pubkey lock")
    c.add_argument("--parties", nargs="*", metavar="name:hex",
                   help="(attest only) pre-register pubkeys, e.g. alice:abc123...")
    c.set_defaults(func=cmd_create)

    common_room = lambda x: (
        x.add_argument("slug"),
        x.add_argument("--key", default=os.environ.get("BATON_KEY"),
                       help="signing key (default: $BATON_KEY)"),
        x.add_argument("--secret", default=os.environ.get("BATON_SECRET"),
                       help="bearer secret for private rooms"),
    )

    po = sub.add_parser("post", help="post a message")
    common_room(po)
    po.add_argument("--from", dest="from_", required=True, help='"from" name')
    po.add_argument("-m", "--body", help="message body (else read from stdin)")
    po.add_argument("--reply-to", type=int, help="id of msg this replies to")
    po.add_argument("--idempotency-key", help="X-Idempotency-Key for retry safety")
    po.set_defaults(func=cmd_post)

    rd = sub.add_parser("read", help="list messages (optionally long-poll)")
    common_room(rd)
    rd.add_argument("--since", type=int, default=0, help="only messages with id > since")
    rd.add_argument("--wait", type=int, default=0, help="long-poll up to N seconds (max 60)")
    rd.set_defaults(func=cmd_read)

    mt = sub.add_parser("meta", help="show the room's _meta envelope")
    common_room(mt)
    mt.set_defaults(func=cmd_meta)

    iv = sub.add_parser("invite", help="generate a paste-able invite for another agent")
    common_room(iv)
    iv.add_argument("--role", required=True, help="what the receiver should do")
    iv.add_argument("--task", required=True, help="title shown to the receiver")
    iv.add_argument("--peer-label", default="another agent")
    iv.add_argument("--peer-what-it-is", default="a Python script on my local machine, not an LLM")
    iv.add_argument("--from-human", default="I'm running a small Baton demo")
    iv.add_argument("--max-messages", type=int, default=None)
    iv.add_argument("--your-from", default="agent-b", help='"from" the receiver should sign as')
    iv.set_defaults(func=cmd_invite)

    kp = sub.add_parser("keypair", help="generate an ed25519 keypair (for attest mode)")
    kp.set_defaults(func=cmd_keypair)

    args = p.parse_args(argv)
    try:
        return args.func(args)
    except BatonError as e:
        print(f"baton: {e.status}: {json.dumps(e.body) if e.body else e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
