"""Compute every figure the story quotes, once, into components/story/numbers.json.

The story's copy names percentages and speeds. Recomputing those in the
browser would mean shipping and decoding the whole pack on a page that only
needs four numbers, so they are resolved here at build time and imported as
data. Re-run after a pack rebuild:

    python3 scripts/build_story_numbers.py
"""
import json
import math
import re
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PACK = HERE.parent / "public" / "data" / "pack"
OUT = HERE.parent / "components" / "story" / "numbers.json"
INCOME = HERE.parent.parent / "vis" / "data" / "income.json"
BOUNDARY_JS = HERE.parent / "components" / "story" / "berkeley-boundary.js"

STORY_WEEK = "2026-02-09"      # the week the story ends on
MPH_SCALE = 10.0               # service pack stores tenths


def load_meta():
    return json.loads((PACK / "meta.json").read_text())


def level_totals(meta, level, file, week_index):
    """Total riders per key in one week: the four measures, unscaled."""
    keys = meta[{"tract": "tracts", "bgroup": "bgroups"}[level]]
    scales = np.array(meta["scales"][level], dtype=np.float64)
    n, w, c = len(keys), meta["n_weeks"], len(meta["measures"])
    arr = np.fromfile(PACK / file, dtype="<u2").reshape(n, w, c)
    return keys, arr[:, week_index, :].sum(axis=1) * scales


def boundary():
    txt = BOUNDARY_JS.read_text()
    pairs = re.findall(r"\[(-?\d+\.\d+),(-?\d+\.\d+)\]", txt)
    return [(float(a), float(b)) for a, b in pairs]


def inside(poly, lat, lon):
    """Ray casting in (lat, lon)."""
    hit = False
    n = len(poly)
    for i in range(n):
        y1, x1 = poly[i]
        y2, x2 = poly[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            xx = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < xx:
                hit = not hit
    return hit


def haversine_m(a, b):
    r = 6371008.8
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def corridor_geometry(era):
    corridors = json.loads((PACK / f"corridors_{era}.json").read_text())
    lengths, centroids = [], []
    for c in corridors:
        pts = c["c"]
        length = sum(haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
        lat = sum(p[0] for p in pts) / len(pts)
        lon = sum(p[1] for p in pts) / len(pts)
        lengths.append(length)
        centroids.append((lat, lon))
    return np.array(lengths), centroids


def service_month(snapshots, month):
    snap = next(s for s in snapshots if s["id"] == month)
    raw = np.fromfile(PACK / snap["file"], dtype="<u2").reshape(snap["n"], 4, 2)
    return snap, raw


PS = (0.1, 0.5, 0.9)


def weighted_quantiles(values, weights, ps=PS):
    """Quantiles of a weighted sample, each value placed at the midpoint of the
    weight it occupies and read off by linear interpolation between neighbours.
    """
    order = np.argsort(values)
    v = values[order]
    w = weights[order]
    cum = np.cumsum(w)
    at = (cum - w / 2) / cum[-1]
    return [float(np.interp(p, at, v)) for p in ps]


def period_speed(snap, raw, mask, period_id, null):
    """The spread of corridor speed over the masked corridors, weighted by
    bus-km so a busy arterial counts for more than a lightly served side
    street -- the same weight build_speed_pack.py folds with, but kept as a
    distribution. A single mean says what the network does on average; the
    tenth and ninetieth say how far apart its slowest and fastest streets are,
    which is the thing that actually moves between 2019 and 2026.
    """
    idx = next(i for i, p in enumerate(snap["periods"]) if p["id"] == period_id)
    hours = sum(hi - lo for lo, hi in snap["periods"][idx]["windows"])
    days = 2 if snap["periods"][idx]["days"] == "weekend" else 5
    headway = raw[:, idx, 0].astype(np.float64) / MPH_SCALE
    mph = raw[:, idx, 1].astype(np.float64) / MPH_SCALE
    ok = mask & (raw[:, idx, 0] != null) & (raw[:, idx, 1] != null) & (mph > 0) & (headway > 0)
    if not ok.any():
        return None
    trips = hours * days * 60 / headway[ok]
    weight = trips * LENGTHS[ok]
    p10, p50, p90 = weighted_quantiles(mph[ok], weight)
    return {"p10": p10, "p50": p50, "p90": p90}


def pct(x):
    return round(100 * x, 1)


meta = load_meta()
weeks = meta["weeks"]
week_index = weeks.index(STORY_WEEK)
base_index = meta["baseline_week"]

# ---------------------------------------------------------------- income
tracts, now = level_totals(meta, "tract", "tract_weeks.u16", week_index)
_, base = level_totals(meta, "tract", "tract_weeks.u16", base_index)
income = json.loads(INCOME.read_text())["tract"]

# income.json stores [estimate, margin of error]; a missing estimate is null
def median_income(geoid):
    v = income.get(geoid)
    return v[0] if v and v[0] and v[0] > 0 else None


rows = [(t, median_income(t), now[i], base[i]) for i, t in enumerate(tracts)]
rows = [r for r in rows if r[1] and r[3] > 0]
rows.sort(key=lambda r: r[1])
cut = len(rows) // 5                      # two deciles = a fifth
low, high = rows[:cut], rows[-cut:]


def recovery(group):
    return sum(r[2] for r in group) / sum(r[3] for r in group)


out = {
    "_source": "scripts/build_story_numbers.py",
    "week": STORY_WEEK,
    "baseline": meta["baseline_label"],
    "income": {
        "tracts_ranked": len(rows),
        "per_group": cut,
        "high_recovery_pct": pct(recovery(high)),
        "low_recovery_pct": pct(recovery(low)),
        "high_median_income": int(high[0][1]),
        "low_median_income": int(low[-1][1]),
    },
}

# ---------------------------------------------------------------- speeds
svc = json.loads((PACK / "service_meta.json").read_text())
null = svc["null"]
snapshots = svc["snapshots"]
poly = boundary()

speeds = {}
for label, month in (("feb2020", "2020-02"), ("dec2020", "2020-12"), ("feb2026", "2026-02")):
    snap, raw = service_month(snapshots, month)
    LENGTHS, centroids = corridor_geometry(snap["era"])
    mask = np.array([inside(poly, lat, lon) for lat, lon in centroids])
    speeds[label] = {
        "month": month,
        "corridors_in_berkeley": int(mask.sum()),
        "day": period_speed(snap, raw, mask, "day", null),
        "peak": period_speed(snap, raw, mask, "peak", null),
        "night": period_speed(snap, raw, mask, "night", null),
    }

for key, value in speeds.items():
    for p in ("day", "peak", "night"):
        if value[p] is not None:
            value[p] = {q: round(mph, 1) for q, mph in value[p].items()}
out["speeds"] = speeds
# The night/peak gap is quoted from the middle of each distribution.
night, peak = speeds["feb2026"]["night"]["p50"], speeds["feb2026"]["peak"]["p50"]
out["speeds"]["night_vs_peak_pct"] = round(100 * (night - peak) / peak, 1)

OUT.write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out, indent=2))
