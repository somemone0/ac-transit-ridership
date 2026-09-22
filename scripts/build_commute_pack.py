"""Build the commute pack: average-weekday hourly profiles + inferred O-D flows.

Sources: raw APC event parquet for a series of six-month snapshot months (Feb
and Aug of each year, plus the latest available month), downloaded from
gs://ac-transit-stops and cached locally. Values are NTD-calibrated per month
and capture-corrected per (route, bit, time-of-day band of the trip start)
with capture_band_table.parquet. Band factors only redistribute a route-bit's
month across the day: each route-bit keeps the level the route-month factor
gives it, so totals still reconcile with the app's weekly numbers.

Snapshots let the commute view compare pre- and post-pandemic patterns; rerun
this script every ~6 months (or after each new GCS month lands) and it picks
up the newest anchor automatically.

O-D inference, per (route, bit) for trips starting 5-11 a.m.:
  * Stop order comes from the trips themselves -- each stop's median minutes
    into the trip, over the stops at least MIN_STOP_SHARE of trips serve. The
    GTFS era sequences are missing stops the buses serve, and dropping those
    events lost up to a quarter of a direction's boardings.
  * Each trip's own boarding/alighting vector is fitted against a shared base
    matrix, and the base is rebuilt from the summed trip fits, for a few
    passes (Ji, Mishalani & McCord 2014 -- an approximate EM). Summing a
    month of trips before one fit, as this script used to, throws away which
    stops fill up together on the same bus. Trips whose ons and offs differ by
    IMBALANCE_MAX or more are left out of the fit (TCRP Report 113 screening).
  * The number of passes -- or the old summed fit (0 passes), which does
    better on a few routes with loops and on thin routes -- is chosen per
    route-bit by predicting each even-day trip's alightings from its
    boardings with a fit on odd days, and vice versa.
  * The chosen structure is raked to the corrected AM boarding/alighting
    totals, and stop-to-stop flows are aggregated to stop-group / tract /
    block-group pairs.
Top-K lists per key are written per snapshot; the client fetches one
snapshot's file on demand. Only the AM matrix is shipped — it carries the
commute story in both directions (in-list = who arrives here, out-list = who
leaves here).

A second, evening pass (PM_WORK) is inferred but not shipped. It exists only
to score which morning trips come back, because a morning arrival on its own
cannot tell a commuter from a shopper, a student or someone changing to BART.
See round_trip() for the statistic and why it nets the two directions against
each other; the per-key totals are all that is written out.

Outputs (nextjsvis/public/data/pack/):
  commute_meta.json                                     names the files below
  commute_hourly_{group,tract,bgroup,route}.<hash>.bin  u16 [key][snapshot][measure][hour]
  commute_rt_{group,tract,bgroup}.<hash>.bin            u16 [key][snapshot][workplace, home]
  commute_od_{YYYY-MM}.<hash>.bin                       top-K AM flows per key, 3 levels

Corridor/section geometry is NOT touched here (that work lives elsewhere).
"""
import datetime as dt
import hashlib
import json
import os
import struct
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

# This script is the upstream half of the pipeline: it reads the raw APC
# parquet plus two intermediates that live in sibling repos, neither of which
# is published here. Point ACPRA_ROOT at the checkout that holds them, or set
# ACPRA_REPLICATE / ACPRA_VIS individually. The app itself needs none of this
# -- it only reads the packed bundle these scripts produce.
NEXT = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ.get("ACPRA_ROOT", NEXT.parent))
REPL = Path(os.environ.get("ACPRA_REPLICATE", ROOT / "replicate"))
VIS = Path(os.environ.get("ACPRA_VIS", ROOT / "vis"))
PACK = Path(os.environ.get("ACPRA_PACK", NEXT / "public" / "data" / "pack"))
CACHE = Path(os.environ.get("ACPRA_CACHE", VIS / "data" / "commute_cache"))
CACHE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(REPL))
from holidays import is_holiday  # noqa: E402
from build_capture import band_of_hour, start_hour  # noqa: E402

# Raw APC event parquet, partitioned year=/month=. Mirrored as a public
# HuggingFace dataset -- see the README.
BUCKET = os.environ.get(
    "ACPRA_BUCKET", "gs://ac-transit-stops/partitioned-final/ac_transit_parquet"
)
AM = (5, 11)   # trip start hours 5..10 inclusive
# Evening window used only to score which morning trips come back. Widened
# from 16-19 to 14-22: it catches roughly half again more O-D riders, but
# dilutes the workplace signal, because schools dismiss 13-16 and their round
# trips mirror as cleanly as commutes do. Measured against LODES
# workplace-ness (log jobs/resident workers), 14-22 scores rho 0.46-0.47
# where 16-19 scores 0.49.
PM_WORK = (14, 22)
N_HOURS = 24
K_GROUP = 48
K_AREA = 24
MATCH_MIN = 0.40   # min stop-set Jaccard to accept a route/dir match
FLOW_MIN = 0.01    # min avg-weekday riders per stop pair to keep
MIN_STOP_SHARE = 0.05  # a stop joins the O-D sequence if this share of trips serve it
IMBALANCE_MAX = 5      # |ons - offs| per trip at or above this is screened out (STM's rule)
MIN_OD_TRIPS = 20      # fewer screened trips than this -> summed fit, no holdout
TRIP_PASSES = (3, 8)   # candidate pass counts for the per-trip fit
LEVELS = ["group", "tract", "bgroup", "route"]
RT_LEVELS = ["group", "tract", "bgroup"]   # round-trip scores; routes have no O-D
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
# era whose GTFS stop sequences match an anchor date (matches vis eras)
ERA_RANGES = {
    "Nov2019": (dt.date(2019, 1, 1), dt.date(2021, 12, 31)),
    "Dec2024": (dt.date(2022, 1, 1), dt.date(2025, 3, 31)),
    "Aug2025": (dt.date(2025, 4, 1), dt.date(2099, 12, 31)),
}


def era_for(y, m):
    d = dt.date(y, m, 1)
    for name, (lo, hi) in ERA_RANGES.items():
        if lo <= d <= hi:
            return name
    return "Aug2025"


def detect_latest():
    """Newest month present on GCS, probing backwards from today."""
    today = dt.date.today()
    for y in range(today.year, 2018, -1):
        for m in range(12, 0, -1):
            if (y, m) < (today.year, today.month):
                remote = f"{BUCKET}/year={y}/month={m}/data_0.parquet"
                probe = subprocess.run(
                    ["gcloud", "storage", "ls", remote],
                    capture_output=True, timeout=60,
                )
                if probe.returncode == 0:
                    return (y, m)
    return (2026, 5)


def compute_anchors(latest):
    anchors = []
    for y in range(2019, latest[0] + 1):
        for m in (2, 8):
            if (y, m) <= latest:
                anchors.append((y, m))
    if latest not in anchors:
        anchors.append(latest)
    return anchors


def fetch_month(y, m):
    raw = CACHE / f"raw_{y}_{m:02d}.parquet"
    if not raw.exists():
        remote = f"{BUCKET}/year={y}/month={m}/data_0.parquet"
        print(f"downloading {remote}")
        subprocess.run(
            ["gcloud", "storage", "cp", remote, str(raw)],
            check=True, capture_output=True, timeout=900,
        )
    return raw


def load_events(y, m):
    """Capture- and NTD-corrected weekday events for one month.

    Not cached: the O-D step needs trip identity and event times, and a
    corrected copy of every snapshot month would not fit beside the raw cache.
    """
    path = fetch_month(y, m)
    t = pq.read_table(
        path,
        columns=["route", "route_id", "stop_id", "service_date", "event_timestamp",
                 "boardings", "alightings", "door_lift_flags_possibly"],
    ).to_pandas()
    t = t.dropna(subset=["route", "stop_id", "route_id"])
    d = pd.DatetimeIndex(t.service_date)
    keep = (d.dayofweek < 5) & ~is_holiday(d)
    keep &= (d.year == y) & (d.month == m)
    t = t[keep].copy()
    t["route"] = t.route.astype(str)
    t["stop_id"] = t.stop_id.astype(str)
    t["route_id"] = t.route_id.astype(str)
    t["bit"] = (t.door_lift_flags_possibly.astype(int) % 2).astype(np.int8)
    t["hour"] = pd.DatetimeIndex(t.event_timestamp).hour.astype(np.int8)
    t["start_hr"] = start_hour(t.route_id).fillna(-1).astype(np.int16)
    t["band"] = band_of_hour(t.start_hr.clip(lower=0))
    t = t.rename(columns={"boardings": "raw_bd", "alightings": "raw_al"})

    key = ["route", "bit"]
    cap = pd.read_parquet(REPL / "derived" / "capture_table.parquet")
    cap = cap[(cap.day_type == "Weekday") & (cap.year == y) & (cap["period"] == m)].copy()
    cap["bit"] = cap["bit"].astype(np.int8)
    cap["scale"] = np.where(cap.capture > 0, 1.0 / cap.capture.clip(upper=1.0), 1.0)
    band = pd.read_parquet(REPL / "derived" / "capture_band_table.parquet")
    band = band[(band.day_type == "Weekday") & (band.year == y) & (band["period"] == m)].copy()
    band["bit"] = band["bit"].astype(np.int8)
    band["scale_band"] = np.where(band.capture_band > 0,
                                  1.0 / band.capture_band.clip(upper=1.0), 1.0)
    t = t.merge(cap[key + ["scale"]], on=key, how="left")
    t = t.merge(band[key + ["band", "scale_band", "reliable_band"]],
                on=key + ["band"], how="left")
    t["scale"] = t["scale"].fillna(1.0)
    t["scale_band"] = t["scale_band"].fillna(t["scale"])
    t["reliable_band"] = t["reliable_band"].astype("boolean").fillna(False).astype(bool)

    # band factors fix the shape of the day; the route-month factor keeps
    # each route-bit's month level, which is what the weekly data carries
    lvl = (t.assign(month=t.raw_bd * t.scale, banded=t.raw_bd * t.scale_band)
            .groupby(key)[["month", "banded"]].sum())
    norm = (lvl.month / lvl.banded).where(lvl.banded > 0, 1.0).rename("band_norm")
    t = t.join(norm, on=key)

    ntd = pd.read_parquet(REPL / "derived" / "ntd_calibration.parquet")
    row = ntd[(ntd.year == y) & (ntd.month == m)]
    ntd_scale = float(row.ntd_scale.iloc[0]) if len(row) else 1.0

    s = t.scale_band * t.band_norm * ntd_scale
    t["bd"] = (t.raw_bd * s).astype(np.float32)
    t["al"] = (t.raw_al * s).astype(np.float32)
    t["imp"] = ~t.reliable_band
    return t[["route", "bit", "stop_id", "service_date", "route_id", "event_timestamp",
              "hour", "start_hr", "raw_bd", "raw_al", "bd", "al", "imp"]]


def weekday_count(y, m):
    t = pq.read_table(fetch_month(y, m), columns=["service_date"]).to_pandas()
    d = pd.DatetimeIndex(t.service_date)
    wd = (d.dayofweek < 5) & ~is_holiday(d) & (d.year == y) & (d.month == m)
    return int(d[wd].nunique())


def ipf_od(boardings, alightings, max_iter=200, tol=1e-4, backward_weight=0.02):
    """Furness with a soft backward mask (ports replicate/ipf_od.py)."""
    n = len(boardings)
    B = np.asarray(boardings, dtype=float)
    A = np.asarray(alightings, dtype=float)
    total = (B.sum() + A.sum()) / 2
    if total <= 0:
        return np.zeros((n, n))
    if B.sum() > 0:
        B = B * total / B.sum()
    if A.sum() > 0:
        A = A * total / A.sum()
    i, j = np.indices((n, n))
    T = np.where(i < j, 1.0, np.where(i > j, backward_weight, 0.0))
    for _ in range(max_iter):
        rs = T.sum(axis=1)
        T = T * np.divide(B, rs, out=np.zeros_like(B), where=rs > 0)[:, None]
        cs = T.sum(axis=0)
        T = T * np.divide(A, cs, out=np.zeros_like(A), where=cs > 0)[None, :]
        if max(np.abs(T.sum(axis=1) - B).max(), np.abs(T.sum(axis=0) - A).max()) < tol:
            break
    return T


def balance(B, A):
    """Scale ons and offs to their mean total along the last axis (TCRP 113's
    proportional balancing, which leaves average trip length unchanged)."""
    tb, ta = B.sum(-1, keepdims=True), A.sum(-1, keepdims=True)
    target = (tb + ta) / 2
    return (B * np.divide(target, tb, out=np.zeros_like(tb), where=tb > 0),
            A * np.divide(target, ta, out=np.zeros_like(ta), where=ta > 0))


def ipf_batch(T, rows, cols, max_iter=100, tol=1e-4):
    """Biproportional fit of seeds T (..., n, n) to rows/cols (..., n), in place."""
    for _ in range(max_iter):
        rs = T.sum(-1)
        T *= np.divide(rows, rs, out=np.zeros_like(rs), where=rs > 0)[..., :, None]
        cs = T.sum(-2)
        T *= np.divide(cols, cs, out=np.zeros_like(cs), where=cs > 0)[..., None, :]
        if np.abs(T.sum(-1) - rows).max() < tol:
            break
    return T


def trip_bases(B, A, passes, backward=1e-3):
    """Base matrix after each of 1..max(passes) per-trip passes: fit every
    trip's own counts against the base, rebuild the base from the sum (Ji,
    Mishalani & McCord 2014). The small upstream weight keeps trips with
    locally inconsistent counts solvable; only forward mass carries over."""
    n = B.shape[1]
    B, A = balance(B, A)
    i, j = np.indices((n, n))
    fwd = (i < j).astype(float)
    up = backward / fwd.sum() * (i > j)
    base, out = fwd, {}
    for k in range(1, max(passes) + 1):
        seed = np.broadcast_to(base / base.sum() + up, (len(B), n, n)).copy()
        base = ipf_batch(seed, B, A).sum(0) * fwd
        if k in passes:
            out[k] = base
    return out


def rake(base, boardings, alightings, backward=1e-3):
    """Fit a base structure to boarding/alighting totals."""
    n = len(boardings)
    b, a = balance(np.asarray(boardings, float), np.asarray(alightings, float))
    i, j = np.indices((n, n))
    seed = base + base.mean() * (backward * (i > j) + 1e-9 * (i < j))
    return ipf_batch(seed, b, a, max_iter=500, tol=1e-6)


def holdout_rmse(T, B, A):
    """Predict each trip's alightings from its boardings, B @ P(alight | board)."""
    rs = T.sum(1, keepdims=True)
    P = np.divide(T, rs, out=np.zeros_like(T), where=rs > 0)
    B, A = balance(B, A)
    return float(np.sqrt(((B @ P - A) ** 2).mean()))


def choose_passes(B, A, day):
    """0 (summed fit) or a per-trip pass count, by odd/even-day holdout."""
    folds = (day % 2 == 0, day % 2 == 1)
    if len(B) < MIN_OD_TRIPS or min(f.sum() for f in folds) < 5:
        return 0
    score = dict.fromkeys((0,) + TRIP_PASSES, 0.0)
    for train in folds:
        test = ~train
        b, a = B[train].sum(0), A[train].sum(0)
        score[0] += holdout_rmse(ipf_od(b, a), B[test], A[test])
        for k, base in trip_bases(B[train], A[train], TRIP_PASSES).items():
            score[k] += holdout_rmse(rake(base, b, a), B[test], A[test])
    return min(score, key=score.get)


def route_od(ev, nwd, window=AM):
    """Stop-to-stop flows (avg-weekday riders) for one (route, bit).

    `window` is the trip-start hour range: AM for the shipped commute matrix,
    PM_WORK when scoring which of those morning trips return in the evening.

    Returns (stop sequence, flow matrix, passes used, riders kept), or None.
    """
    ev = ev[(ev.start_hr >= window[0]) & (ev.start_hr < window[1])]
    if ev.empty:
        return None
    trip, trips = pd.factorize(ev.service_date.astype(str) + "|" + ev.route_id)
    t0 = ev.groupby(trip).event_timestamp.transform("min")
    mins = (ev.event_timestamp - t0).dt.total_seconds().to_numpy()
    stops = (pd.DataFrame({"stop": ev.stop_id.to_numpy(), "mins": mins, "trip": trip})
               .groupby("stop").agg(pos=("mins", "median"), n=("trip", "nunique")))
    seq = stops[stops.n >= MIN_STOP_SHARE * len(trips)].sort_values("pos").index
    n = len(seq)
    if n < 2:
        return None
    k = pd.Series(np.arange(n), index=seq).reindex(ev.stop_id).to_numpy()
    on = ~np.isnan(k)
    k, tr = k[on].astype(np.int64), trip[on]
    evk = ev[on]
    B = np.zeros((len(trips), n))
    A = np.zeros_like(B)
    np.add.at(B, (tr, k), evk.raw_bd.to_numpy())
    np.add.at(A, (tr, k), evk.raw_al.to_numpy())
    bvec = np.bincount(k, weights=evk.bd.to_numpy(), minlength=n) / nwd
    avec = np.bincount(k, weights=evk.al.to_numpy(), minlength=n) / nwd
    if bvec.sum() < 0.5 or avec.sum() < 0.5:
        return None

    tb, ta = B.sum(1), A.sum(1)
    ok = (tb > 0) & (np.abs(tb - ta) < IMBALANCE_MAX)
    day = pd.to_datetime(pd.Series(trips).str[:10]).dt.day.to_numpy()
    passes = choose_passes(B[ok], A[ok], day[ok])
    if passes == 0:
        T = ipf_od(bvec, avec)
    else:
        T = rake(trip_bases(B[ok], A[ok], (passes,))[passes], bvec, avec)
    return list(seq), T, passes, float(bvec.sum())


def era_sequences(era):
    """(route, dir) -> ordered stop list, per GTFS era."""
    secs = pd.read_parquet(VIS / "data" / "sections.parquet")
    secs = secs[secs.era == era]
    seqs = {}
    for (route, dirn), g in secs.groupby(["route", "dir"]):
        g = g.sort_values("seq")
        seq = []
        for s in list(g.from_stop.astype(str)) + [str(int(g.to_stop.iloc[-1]))]:
            if not seq or seq[-1] != s:
                seq.append(s)
        seqs[(route, dirn)] = seq
    return seqs


def resolve_aliases(events, seq_sets):
    """raw (route, bit) -> GTFS (route, dir) by stop-set Jaccard."""
    obs = events.groupby(["route", "bit"]).stop_id.agg(set)
    pairs = []
    for (route, bit), stops in obs.items():
        for key, seq_stops in seq_sets.items():
            union = len(stops | seq_stops)
            if not union:
                continue
            j = len(stops & seq_stops) / union
            if j >= MATCH_MIN:
                pairs.append((j, route, bit, key))
    pairs.sort(reverse=True)
    assign, used = {}, set()
    for j, route, bit, key in pairs:
        if (route, bit) in assign or key in used:
            continue
        assign[(route, bit)] = key
        used.add(key)
    alias = {}
    for (route, bit), key in assign.items():
        alias.setdefault(route, key[0])
    return assign, alias


def topk_lists(matrix, n, k):
    ins = [[] for _ in range(n)]
    outs = [[] for _ in range(n)]
    for (u, v), flow in matrix.items():
        outs[u].append((v, flow))
        ins[v].append((u, flow))
    for lst in (ins, outs):
        for i, entries in enumerate(lst):
            entries.sort(key=lambda e: -e[1])
            lst[i] = entries[:k]
    return ins, outs


def publish(name, data):
    """Write a bundle file under a content-addressed name and return it.

    The bucket serves every object with a one-day cache, and the binaries are
    only readable with the offsets and scales in the commute_meta.json that
    was built with them. Hashed names mean a cached meta always points at its
    own binaries, which stay in the bucket, never at a later build's.
    """
    stem, ext = name.rsplit(".", 1)
    for old in [PACK / name, *PACK.glob(f"{stem}.*.{ext}")]:
        old.unlink(missing_ok=True)
    final = f"{stem}.{hashlib.sha1(data).hexdigest()[:10]}.{ext}"
    (PACK / final).write_bytes(data)
    return final


def window_matrices(ev, nwd, window, stops, g2t, g2b, pool):
    """Inferred flows for one trip-start window, at all three area levels.

    Returns (matrices, window riders/weekday, riders kept by the fit, pass
    counts chosen). Lifted out of main so the evening pass can reuse it.
    """
    sub = ev[(ev.start_hr >= window[0]) & (ev.start_hr < window[1])]
    total = float(sub.bd.sum()) / nwd
    matrices = {lv: {} for lv in ("group", "tract", "bgroup")}
    grp = stops.group_id
    kept_sum, chosen = 0.0, {}
    # biggest route-bits first so the pool finishes evenly
    groups = sorted((g for _, g in sub.groupby(["route", "bit"], sort=True)),
                    key=len, reverse=True)
    n = len(groups)
    for res in pool.map(route_od, groups, [nwd] * n, [window] * n):
        if res is None:
            continue
        seq, T, passes, kept = res
        kept_sum += kept
        chosen[passes] = chosen.get(passes, 0) + 1
        ii, jj = np.nonzero(T > FLOW_MIN)
        g1s = [grp.get(seq[i]) for i in ii]
        g2s = [grp.get(seq[j]) for j in jj]
        for g1, g2, flow in zip(g1s, g2s, T[ii, jj]):
            if pd.isna(g1) or pd.isna(g2) or g1 == g2 or g1 < 0 or g2 < 0:
                continue
            d = matrices["group"]
            d[(int(g1), int(g2))] = d.get((int(g1), int(g2)), 0.0) + float(flow)
    for (u, v), flow in matrices["group"].items():
        tu, tv = g2t.get(u), g2t.get(v)
        if tu is not None and tv is not None and tu != tv:
            matrices["tract"][(tu, tv)] = matrices["tract"].get((tu, tv), 0.0) + flow
        bu, bv = g2b.get(u), g2b.get(v)
        if bu is not None and bv is not None and bu != bv:
            matrices["bgroup"][(bu, bv)] = matrices["bgroup"].get((bu, bv), 0.0) + flow
    return matrices, total, kept_sum, chosen


def round_trip(am, pm, n):
    """Net round-trip riders per key: (workplace end, home end).

    A morning i->j trip counts as commuting only if it comes back as an
    evening j->i trip, so the paired volume is min(AM[i->j], PM[j->i]) -- on
    shares of each window's own total, because the evening carries about 1.4x
    the morning's riders and levels would not be comparable.

    Subtracting the same quantity for the opposite story, min(AM[j->i],
    PM[i->j]), is what makes this a workplace measure rather than a busyness
    one. Buses run both ways all day, so the fit hands nearly every busy pair
    a return leg; without the subtraction a two-way corridor scores at both
    ends and the ranking fills with tracts that have few jobs and many
    residents. A symmetric all-day corridor now cancels to about zero, while a
    genuine commute pair keeps its volume and its sign.
    """
    am_tot, pm_tot = sum(am.values()), sum(pm.values())
    if not (am_tot > 0 and pm_tot > 0):
        return np.zeros(n), np.zeros(n)
    am_s = {k: v / am_tot for k, v in am.items()}
    pm_s = {k: v / pm_tot for k, v in pm.items()}
    work, home = np.zeros(n), np.zeros(n)
    for (i, j), f in am_s.items():
        net = (min(f, pm_s.get((j, i), 0.0))
               - min(am_s.get((j, i), 0.0), pm_s.get((i, j), 0.0)))
        if net > 0:
            work[j] += net
            home[i] += net
    return work * am_tot, home * am_tot


def write_od(name, per_level, sizes, ks):
    """Per level, per key: u8 inCount + entries, u8 outCount + entries."""
    blob = bytearray()
    offsets = {}
    for lv in ["group", "tract", "bgroup"]:
        offsets[lv] = {"offset": len(blob), "n": sizes[lv], "k": ks[lv]}
        ins, outs = per_level[lv]
        for key in range(sizes[lv]):
            blob += struct.pack("<B", len(ins[key]))
            for other, flow in ins[key]:
                blob += struct.pack("<Hf", other, flow)
            blob += struct.pack("<B", len(outs[key]))
            for other, flow in outs[key]:
                blob += struct.pack("<Hf", other, flow)
        offsets[lv]["bytes"] = len(blob) - offsets[lv]["offset"]
    return offsets, publish(name, bytes(blob)), len(blob)


def main():
    latest = detect_latest()
    anchors = compute_anchors(latest)
    n_p = len(anchors)
    print(f"snapshots: {[f'{y}-{m:02d}' for y, m in anchors]}")

    meta_pack = json.loads((PACK / "meta.json").read_text())
    route_names = meta_pack["route_names"]
    n_group = meta_pack["stop_groups"]["n"]
    n_tract = len(meta_pack["tracts"])
    n_bgroup = len(meta_pack["bgroups"])

    stops = pd.read_parquet(VIS / "data" / "stop_groups.parquet")
    assert stops.group_id.max() + 1 == n_group, "stop group count drift"
    stops = stops.set_index("stop_id")
    mappings = {
        "group": stops.group_id,
        "tract": stops.tract_ix,
        "bgroup": stops.bgroup_ix,
    }
    tr = sorted(stops.tract_ix.dropna().unique())
    assert len(tr) == n_tract, f"tract count drift {len(tr)} vs {n_tract}"
    bg = sorted(stops.bgroup_ix.dropna().unique())
    assert len(bg) == n_bgroup, f"bgroup count drift {len(bg)} vs {n_bgroup}"

    sizes = {"group": n_group, "tract": n_tract, "bgroup": n_bgroup,
             "route": len(route_names)}
    ks = {"group": K_GROUP, "tract": K_AREA, "bgroup": K_AREA}

    hourly = {lv: np.zeros(sizes[lv] * n_p * 2 * N_HOURS, dtype=np.float64)
              for lv in LEVELS}
    # net round-trip riders per key/snapshot: [key][snapshot][workplace, home]
    rt = {lv: np.zeros((sizes[lv], n_p, 2), dtype=np.float64)
          for lv in RT_LEVELS}
    period_meta = []
    od_meta = {}

    # group -> tract / bgroup index maps (group_id is unique per stop cluster)
    ok = stops.group_id.notna() & stops.tract_ix.notna() & (stops.tract_ix >= 0)
    g2t = dict(zip(stops.group_id[ok].astype(int), stops.tract_ix[ok].astype(int)))
    okb = stops.group_id.notna() & stops.bgroup_ix.notna() & (stops.bgroup_ix >= 0)
    g2b = dict(zip(stops.group_id[okb].astype(int), stops.bgroup_ix[okb].astype(int)))

    seq_cache = {}
    pool = ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 2))
    for p, (y, m) in enumerate(anchors):
        label = f"{MONTH_NAMES[m - 1]} {y}"
        ev = load_events(y, m)
        nwd = weekday_count(y, m)
        rel = float(1 - ev.imp.mean())
        period_meta.append({"id": f"{y}-{m:02d}", "label": label,
                            "weekdays": nwd, "reliable": round(rel, 3),
                            "odCoverage": 0.0})

        # ---- hourly for this snapshot ----
        for level, stop_key in mappings.items():
            keys = stop_key.reindex(ev.stop_id).to_numpy()
            okk = keys >= 0
            evk = ev[okk]
            k = keys[okk].astype(np.int64)
            for meas, col in enumerate(["bd", "al"]):
                idx = (k * (n_p * 48) + p * 48 + meas * 24
                       + evk.hour.to_numpy())
                np.add.at(hourly[level], idx, evk[col].to_numpy())

        # ---- OD for this snapshot ----
        era = era_for(y, m)
        if era not in seq_cache:
            seq_cache[era] = era_sequences(era)
        seqs = seq_cache[era]
        assign, alias = resolve_aliases(ev, {k: set(v) for k, v in seqs.items()})

        route_keys = ev.route.map(alias).map(
            {r: i for i, r in enumerate(route_names)}).fillna(-1).to_numpy()
        okr = route_keys >= 0
        evr = ev[okr]
        rk = route_keys[okr].astype(np.int64)
        for meas, col in enumerate(["bd", "al"]):
            idx = (rk * (n_p * 48) + p * 48 + meas * 24 + evr.hour.to_numpy())
            np.add.at(hourly["route"], idx, evr[col].to_numpy())

        matrices, total_am, kept_am, chosen = window_matrices(
            ev, nwd, AM, stops, g2t, g2b, pool)

        # The evening pass is scored, never shipped: only the per-key round-trip
        # totals below survive it, which is a few hundred KB against the ~12 MB
        # a second set of O-D binaries would add.
        evening, total_pm, _, _ = window_matrices(
            ev, nwd, PM_WORK, stops, g2t, g2b, pool)
        for lv in RT_LEVELS:
            work, home = round_trip(matrices[lv], evening[lv], sizes[lv])
            rt[lv][:, p, 0] = work
            rt[lv][:, p, 1] = home
        print(f"    evening {PM_WORK[0]}-{PM_WORK[1]}: {total_pm:,.0f} riders/wkday; "
              f"round-trip {rt['tract'][:, p, 0].sum():,.0f} of {total_am:,.0f} AM "
              f"({rt['tract'][:, p, 0].sum() / max(total_am, 1e-9):.0%})", flush=True)

        anchor_id = f"{y}-{m:02d}"
        per_level = {lv: topk_lists(matrices[lv], sizes[lv], ks[lv])
                     for lv in ("group", "tract", "bgroup")}
        offsets, od_file, size = write_od(f"commute_od_{anchor_id}.bin", per_level, sizes, ks)
        od_meta[anchor_id] = {"am": {"file": od_file, "levels": offsets}}
        coverage = kept_am / max(total_am, 1e-9)
        period_meta[p]["odCoverage"] = round(coverage, 3)
        fits = ", ".join(f"{'summed' if k == 0 else f'{k} passes'}: {v}"
                         for k, v in sorted(chosen.items()))
        print(f"  {label}: {sum(chosen.values())} route-bits ({fits}); "
              f"O-D covers {coverage:.1%} of AM boardings, od {size / 1e6:.2f} MB",
              flush=True)

    pool.shutdown()

    # ---- write hourly bins ----
    hourly_section = {}
    for lv in LEVELS:
        arr = hourly[lv].reshape(sizes[lv], n_p, 2, N_HOURS)
        mx = arr.reshape(arr.shape[0], -1).max(axis=1)
        scale = np.where(mx > 0, mx / 65535.0, 1.0).astype(np.float64)
        q = np.round(arr / scale[:, None, None, None]).clip(0, 65535).astype("<u2")
        name = publish(f"commute_hourly_{lv}.bin", q.tobytes())
        hourly_section[lv] = {
            "file": name,
            "n": sizes[lv],
            "nP": n_p,
            "scales": [round(float(v), 6) for v in scale],
        }
        print(f"  {name} {(PACK / name).stat().st_size / 1e6:.2f} MB")

    # ---- write round-trip bins ----
    # Same u16-plus-per-key-scale shape as the hourly bins, one sixth their
    # size: [key][snapshot][workplace, home].
    rt_section = {}
    for lv in RT_LEVELS:
        arr = rt[lv]
        mx = arr.reshape(arr.shape[0], -1).max(axis=1)
        scale = np.where(mx > 0, mx / 65535.0, 1.0).astype(np.float64)
        q = np.round(arr / scale[:, None, None]).clip(0, 65535).astype("<u2")
        name = publish(f"commute_rt_{lv}.bin", q.tobytes())
        rt_section[lv] = {
            "file": name,
            "n": sizes[lv],
            "nP": n_p,
            "scales": [round(float(v), 6) for v in scale],
        }
        print(f"  {name} {(PACK / name).stat().st_size / 1e3:.0f} KB")

    out = {
        "periods": period_meta,
        "latest": f"{latest[0]}-{latest[1]:02d}",
        "base": "2020-02",
        "windows": {"am": list(AM), "pm": list(PM_WORK), "pmWork": list(PM_WORK)},
        "hourly": hourly_section,
        "rt": rt_section,
        "od": od_meta,
    }
    (PACK / "commute_meta.json").write_text(json.dumps(out, separators=(",", ":")))

    # ---- validation ----
    ld = pd.read_parquet(REPL / "derived" / "line_day.parquet")
    names = meta_pack["stop_groups"]["name"]

    def key_name(key):
        return names[key]

    for p, (y, m) in enumerate(anchors):
        d = ld[(ld.service_date.dt.year == y) & (ld.service_date.dt.month == m)]
        d = d[d.service_date.dt.dayofweek < 5]
        d = d[~is_holiday(pd.DatetimeIndex(d.service_date))]
        official = float(d.adjusted_bd.sum())
        mine = float(hourly["group"].reshape(n_group, n_p, 2, N_HOURS)[:, p, 0, :].sum())
        print(f"{y}-{m:02d}: line_day weekday bd {official:,.0f}; "
              f"hourly stop-mapped {mine:,.0f} ({mine / official:.1%})")

    def net_shares(p):
        gh = hourly["group"].reshape(n_group, n_p, 2, N_HOURS)
        nwd = period_meta[p]["weekdays"]
        am_al = gh[:, p, 1, AM[0]:AM[1]].sum(axis=1) / nwd
        am_bd = gh[:, p, 0, AM[0]:AM[1]].sum(axis=1) / nwd
        daily = gh[:, p].sum(axis=(1, 2)) / nwd
        return (am_al - am_bd) / np.where(daily > 0, daily, 1), daily

    pre_p = [i for i, a in enumerate(anchors) if a == (2019, 2)][0]
    post_p = len(anchors) - 1
    for tag, p in (("Feb 2019 (pre)", pre_p), (f"{period_meta[post_p]['label']} (post)", post_p)):
        net, daily = net_shares(p)
        order = np.argsort(-net)
        print(f"\ntop AM workplaces {tag}:")
        shown = 0
        for k in order:
            if daily[k] < 300:
                continue
            print(f"  {key_name(int(k))}: net {net[k]:+.2f}, {daily[k]:,.0f} riders/wkday")
            shown += 1
            if shown >= 8:
                break
    print("\ncommute pack written")


if __name__ == "__main__":
    main()
