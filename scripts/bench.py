#!/usr/bin/env python3
"""Tiny perf probe for a Baton instance.

Reports latency on a clean path (one writer, no contention, no rate-limit
saturation). For end-to-end throughput numbers under contention, see the
notes printed at the bottom.

Usage: python scripts/bench.py https://baton.example
"""
import sys, time, statistics
sys.path.insert(0, "clients/python")
from baton import Room  # type: ignore

if len(sys.argv) < 2:
    sys.exit("usage: bench.py <baton-host>")
HOST = sys.argv[1].rstrip("/")
N = 8  # under both the 10-msg free quota and 30-POSTs/10s rate limit
# pacing between sections so we don't trip the rate limiter on subsequent sections

def section(label: str, fn):
    print(f"\n=== {label} ===")
    times: list[float] = []
    errs: list[str] = []
    fn(times, errs)
    if times:
        print(f"  posts:    {len(times)} successful, {len(errs)} errors")
        print(f"  latency:  p50={statistics.median(times)*1000:.0f}ms  p95={sorted(times)[int(len(times)*0.95)]*1000:.0f}ms  max={max(times)*1000:.0f}ms")
    for e in errs[:3]: print(f"  err: {e}")

def unsigned_writer(times, errs):
    room = Room.create(HOST)  # public unsigned
    for i in range(N):
        t0 = time.time()
        try:
            room.post("bench", f"msg-{i:03d}")
            times.append(time.time() - t0)
        except Exception as e:
            errs.append(str(e))

def signed_writer(times, errs):
    room = Room.create(HOST, signed=True)
    for i in range(N):
        t0 = time.time()
        try:
            room.post("bench", f"msg-{i:03d}")  # SDK auto-tracks chain
            times.append(time.time() - t0)
        except Exception as e:
            errs.append(str(e))

def long_poll_wake(times, errs):
    """Wake-on-message latency via long-poll."""
    import threading
    room = Room.create(HOST)
    for i in range(5):
        reader = Room(HOST, room.slug)
        reader._last_id = room._last_id  # start polling from current head
        t0 = time.time()
        result = []
        def go():
            msgs = reader.read(wait_seconds=10)
            result.append((time.time() - t0, msgs))
        th = threading.Thread(target=go); th.start()
        time.sleep(0.05)  # ensure long-poll is established before write
        room.post("bench", f"wake-{i}")
        th.join(timeout=12)
        if result and result[0][1]:
            times.append(result[0][0])
        else:
            errs.append("no message received within 10s")

def cool_off():
    print("  (cooling 12s for rate window to reset)")
    time.sleep(12)

section("public unsigned, 1 writer, sequential", unsigned_writer)
cool_off()
section("signed, 1 writer, sequential (HMAC + chain)", signed_writer)
cool_off()
section("long-poll wake latency (writer + reader)", long_poll_wake)

print("\nNotes:")
print("- Default rate limit is 30 POSTs/IP/10s. Multi-worker throughput from")
print("  one IP saturates that quickly; raise BATON_RATE_MAX on the server")
print("  for real load tests.")
print("- Signed rooms serialize via prev_id by design — multiple writers to")
print("  the same room compete and lose with 409. The SDK refreshes + retries.")
print("- For honest throughput numbers, scale via many rooms or many IPs.")
