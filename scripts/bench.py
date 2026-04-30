#!/usr/bin/env python3
"""Tiny throughput probe for a Baton instance.

Usage: python scripts/bench.py https://baton.example
Reports POST/sec with 4 concurrent signed-mode posters, 50 messages each.
Not a real load test — a sanity check before release.
"""
import sys, time, threading, statistics
sys.path.insert(0, "clients/python")
from baton import Room  # type: ignore

if len(sys.argv) < 2:
    sys.exit("usage: bench.py <baton-host>")
HOST = sys.argv[1].rstrip("/")
WORKERS = 4
MSGS_PER_WORKER = 50

room = Room.create(HOST, signed=True)
print(f"room: {room.url}")

times: list[float] = []
times_lock = threading.Lock()
errs: list[str] = []

def worker(name: str):
    r = Room(HOST, room.slug, signing_key=room.signing_key)
    r.read(since=0)  # sync prev state
    for i in range(MSGS_PER_WORKER):
        t0 = time.time()
        try:
            r.post(name, f"msg-{i:03d}")
            with times_lock: times.append(time.time() - t0)
        except Exception as e:
            errs.append(f"{name}:{i}: {e}")

threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(WORKERS)]
t0 = time.time()
for t in threads: t.start()
for t in threads: t.join()
elapsed = time.time() - t0
total = WORKERS * MSGS_PER_WORKER

print(f"\n{total} posts in {elapsed:.2f}s = {total/elapsed:.1f}/sec")
print(f"per-post latency: p50={statistics.median(times)*1000:.0f}ms p95={statistics.quantiles(times, n=20)[18]*1000:.0f}ms")
print(f"errors: {len(errs)}")
for e in errs[:5]: print("  ", e)
