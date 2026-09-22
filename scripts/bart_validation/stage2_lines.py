"""Stage 2: ordered station sequence per BART line-direction from GTFS."""
import csv, json, collections
from pathlib import Path

HERE = Path(__file__).resolve().parent
G = HERE / "gtfs"

stop2st = {}
with open(G / "stops.txt") as f:
    for r in csv.DictReader(f):
        if r["zone_id"]:
            stop2st[r["stop_id"]] = r["zone_id"]

routes = {}
with open(G / "routes.txt") as f:
    for r in csv.DictReader(f):
        if r["route_type"] == "1":  # rail only, drop bus bridges
            routes[r["route_id"]] = r["route_short_name"]

trip2route = {}
with open(G / "trips.txt") as f:
    for r in csv.DictReader(f):
        if r["route_id"] in routes:
            trip2route[r["trip_id"]] = r["route_id"]

# ordered stop list per trip
trip_seq = collections.defaultdict(list)
with open(G / "stop_times.txt") as f:
    for r in csv.DictReader(f):
        t = r["trip_id"]
        if t in trip2route:
            st = stop2st.get(r["stop_id"])
            if st:
                trip_seq[t].append((int(r["stop_sequence"]), st))

# per route: the most common full-length pattern (longest, then most frequent)
patterns = collections.defaultdict(collections.Counter)
for t, items in trip_seq.items():
    items.sort()
    seq = []
    for _, st in items:
        if not seq or seq[-1] != st:
            seq.append(st)
    patterns[trip2route[t]][tuple(seq)] += 1

lines = {}
for rid, cnt in patterns.items():
    best = max(cnt.items(), key=lambda kv: (len(kv[0]), kv[1]))[0]
    lines[routes[rid]] = list(best)

out = {k: v for k, v in sorted(lines.items())}
(HERE / "line_sequences.json").write_text(json.dumps(out, indent=1))
for k, v in out.items():
    print(f"{k:9s} n={len(v):2d}  {v[0]} -> {v[-1]}")
print("total line-directions:", len(out))
print("stations covered:", len(set().union(*[set(v) for v in out.values()])))
