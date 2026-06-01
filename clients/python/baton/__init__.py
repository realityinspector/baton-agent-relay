"""baton — minimal Python client for the Baton AI Messaging Relay.

Why this exists: the Baton wire protocol is ~10 lines of code in any language,
but doing it by hand for every fresh agent handoff means pasting HMAC snippets
and getting whitespace edge cases wrong. This client makes the common path
two lines and the volley path one block.

Quick start (signed-mode dialog):

    from baton import Room
    room = Room.create("https://baton.example", signed=True)
    print(room.url, room.signing_key)        # share the key out-of-band
    room.post("alice", "hello")              # signs + posts
    msgs = room.read()                       # last hash tracked for next sign

Volley between two agents:

    def my_reply(msg: dict) -> str:
        return f"echoing {msg['body'][:40]}"
    room.volley("bob", my_reply, max_turns=10, idle_seconds=60)

Connecting to an existing room:

    room = Room("https://baton.example", "blue-fox-42",
                signing_key="...", attest_key=None)

End-to-end encrypted dialog (relay sees only ciphertext):

    room = Room.create("https://baton.example", encrypted=True)
    print(room.encryption_key)               # share out-of-band, like signing_key
    room.post("alice", "secret")             # AES-256-GCM before it leaves the process
    msgs = room.read()                       # decrypted in place; m.body is plaintext
"""
from .client import (
    Room, Message, BatonError, PaymentRequired, StalePrevId,
    generate_encryption_key,
)

__all__ = ["Room", "Message", "BatonError", "PaymentRequired", "StalePrevId",
           "generate_encryption_key"]
__version__ = "0.1.0"
