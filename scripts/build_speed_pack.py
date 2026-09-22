"""Build the monthly all-day bus speed files: speed_<era>.<hash>.u16.

The service months (scripts/build_service_pack.py, cached in
vis/data/service_cache) hold four speeds per corridor per month -- weekday peak,
daytime, night and weekend. Charting speed over time needs one: this folds the
four into an all-day average, weighted by how much bus service each period
carries, so a street's figure leans on the hours its buses actually run.

Per corridor, per month:
  trips per direction in a period  = period hours x days x 60 / headway
                                     (weekday periods x 5 days, weekend x 2)
  all-day mph                      = sum(trips) / sum(trips / mph)
  weight                           = sum(trips) x corridor length (bus-km)

The mph is a harmonic mean because each trip covers the same distance: it is
total distance over total time. The weight lets a region's speed be combined
the same way across corridors: sum(weight) / sum(weight / mph). Period hours
are the whole window, so the night period (whose buses run only part of it) is
somewhat overweighted; its headways are long, which keeps that small.

Output (public/data/pack/):
  speed_<era>.<hash>.u16   [corridor][month][mph x 10, weight / scale]; 65535 = none
  speed_meta.json          per era: file, months (YYYY-MM, in order), corridor count,
                           weight scale

Usage: python3 scripts/build_speed_pack.py
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_commute_pack import PACK, VIS, publish  # noqa: E402

CACHE = VIS / "data" / "service_cache"
NULL = 65535
KX = 111320.0 * math.cos(math.radians(37.8))
KY = 111320.0


def length_km(coords):
    return sum(math.hypot((b[1] - a[1]) * KX, (b[0] - a[0]) * KY) for a, b in zip(coords, coords[1:])) / 1000


def period_hours(period):
    return sum(b - a for a, b in period["windows"])


def main():
    meta = json.loads((PACK / "meta.json").read_text())
    months = meta["months"]
    by_era = {}
    for month in months:
        path = CACHE / f"{month}.json"
        if not path.exists():
            continue
        snap = json.loads(path.read_text())
        by_era.setdefault(snap["era"], []).append((month, snap))

    out = {"null": NULL, "eras": {}}
    for era, snaps in by_era.items():
        corridors = json.loads((PACK / f"corridors_{era}.json").read_text())
        lengths = np.array([length_km(feature["c"]) for feature in corridors])
        n = len(corridors)
        mph = np.full((n, len(snaps)), np.nan)
        weight = np.zeros((n, len(snaps)))
        for m, (month, snap) in enumerate(snaps):
            q = np.fromfile(CACHE / f"{month}.u16", dtype="<u2").reshape(n, 4, 2).astype(float)
            headway = np.where(q[:, :, 0] == NULL, np.nan, q[:, :, 0] / 10)
            speed = np.where(q[:, :, 1] == NULL, np.nan, q[:, :, 1] / 10)
            trips = np.zeros((n, 4))
            for p, period in enumerate(snap["periods"]):
                days = 2 if period["days"] == "weekend" else 5
                with np.errstate(invalid="ignore", divide="ignore"):
                    trips[:, p] = period_hours(period) * days * 60 / headway[:, p]
            ok = np.isfinite(trips) & np.isfinite(speed) & (speed > 0) & (trips > 0)
            t = np.where(ok, trips, 0)
            time = np.where(ok, t / np.where(ok, speed, 1), 0)
            total = t.sum(1)
            has = total > 0
            mph[has, m] = total[has] / time.sum(1)[has]
            weight[:, m] = total * lengths
        scale = max(1.0, float(np.nanmax(weight)) / (NULL - 1))
        arr = np.full((n, len(snaps), 2), NULL, dtype=np.uint16)
        good = np.isfinite(mph)
        arr[:, :, 0][good] = np.clip(np.round(mph[good] * 10), 0, NULL - 1)
        arr[:, :, 1][good] = np.clip(np.round(weight[good] / scale), 1, NULL - 1)
        name = publish(f"speed_{era}.u16", arr.astype("<u2").tobytes())
        out["eras"][era] = {"file": name, "months": [month for month, _ in snaps], "n": n, "scale": scale}
        network = (np.nansum(np.where(good, weight, 0), 0)
                   / np.nansum(np.where(good, weight / np.where(good, mph, 1), 0), 0))
        print(f"{era}: {n:,} corridors x {len(snaps)} months -> {name} "
              f"({arr.nbytes / 1e6:.1f} MB); network mph {network.min():.1f}-{network.max():.1f}")
    (PACK / "speed_meta.json").write_text(json.dumps(out, separators=(",", ":")))
    print("wrote speed_meta.json")


if __name__ == "__main__":
    main()
