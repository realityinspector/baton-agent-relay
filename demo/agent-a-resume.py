#!/usr/bin/env python3
"""Resume Agent A on an EXISTING Baton room (after a crash).

Reads the room state, re-enters the volley loop with the same reply logic.
Will pick up any pending agent-b messages and respond.

Usage: BATON_SLUG=<slug> BATON_KEY=<key> python demo/agent-a-resume.py
"""
import os, sys, importlib.util

# Load the same reply / find_relevant / make_handoff logic from agent-a.py
_a_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-a.py")
_spec = importlib.util.spec_from_file_location("agent_a", _a_path)
_a = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_a)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "clients", "python"))
from baton import Room  # noqa: E402

HOST = os.environ.get("BATON_HOST", "https://baton-app-production-90c3.up.railway.app")
SLUG = os.environ["BATON_SLUG"]
KEY  = os.environ["BATON_KEY"]

room = Room(HOST, SLUG, signing_key=KEY)
print(f"Resuming agent-a on {room.url}", flush=True)

sent = room.volley(
    "agent-a", _a.reply,
    peer_from="agent-b",
    max_turns=20,
    idle_seconds=7200,
    on_message=lambda m: print(f"  [{m.id}] {m.from_}: {m.body[:80]}{'…' if len(m.body) > 80 else ''}", flush=True),
)
print(f"Volley ended. Posted {len(sent)} replies.", flush=True)
