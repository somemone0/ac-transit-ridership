"""Build the commute pack: average-weekday hourly profiles + inferred O-D flows.

Sources: raw APC event parquet for a series of six-month snapshot months (Feb
and Aug of each year, plus the latest available month), downloaded from
gs://ac-transit-stops and cached locally. Values are capture-corrected per
(route, bit) with the pipeline's capture_table.parquet and NTD-calibrated per
month, so these figures reconcile with the app's weekly numbers.

Snapshots let the commute view compare pre- and post-pandemic patterns; rerun
this script every ~6 months (or after each new GCS month lands) and it picks
up the newest anchor automatically.

O-D inference: per (raw route, bit) matched to the *era-matched* GTFS (route,
dir) stop sequence by stop-set overlap, IPF (Furness) on AM (5-9)
boardings/alightings marginals with a soft backward weight, then stop-to-stop
flows aggregated to stop-group / tract / block-group pairs. Top-K lists per
key are written per snapshot; the client fetches one snapshot's file on
demand. PM O-D is not built — the AM matrix carries the commute story in both
directions (in-list = who arrives here, out-list = who leaves here).

Outputs (nextjsvis/public/data/pack/):
  commute_meta.json
  commute_hourly_{group,tract,bgroup,route}.bin   u16 [key][snapshot][measure][hour]
  commute_od_{YYYY-MM}.bin                        top-K AM flows per key, 3 levels

Corridor/section geometry is NOT touched here (that work lives elsewhere).
"""
import datetime as dt
import json
import os
import struct
import subprocess
import sys
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

# Raw APC event parquet, partitioned year=/month=. Mirrored as a public
# HuggingFace dataset -- see the README.
BUCKET = os.environ.get(
    "ACPRA_BUCKET", "gs://ac-transit-stops/partitioned-final/ac_transit_parquet"
)
AM = (5, 9)    # hours 5..8 inclusive
N_HOURS = 24
K_GROUP = 48
K_AREA = 24
MATCH_MIN = 0.40   # min stop-set Jaccard to accept a route/dir match
FLOW_MIN = 0.01    # min avg-weekday riders per stop pair to keep
LEVELS = ["group", "tract", "bgroup", "route"]
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
    """Capture- and NTD-corrected weekday events for one month (cached)."""
    out = CACHE / f"corr_{y}_{m:02d}.parquet"
    if out.exists():
        return pd.read_parquet(out)
    path = fetch_month(y, m)
    t = pq.read_table(
        path,
        columns=["route", "stop_id", "service_date", "event_timestamp",
                 "boardings", "alightings", "door_lift_flags_possibly"],
    ).to_pandas()
    t = t.dropna(subset=["route", "stop_id"])
    d = pd.DatetimeIndex(t.service_date)
    keep = (d.dayofweek < 5) & ~is_holiday(d)
    keep &= (d.year == y) & (d.month == m)
    t = t[keep].copy()
    t["bit"] = t.door_lift_flags_possibly.astype(int) % 2
    t["hour"] = pd.DatetimeIndex(t.event_timestamp).hour.astype(np.int8)
    t = t.rename(columns={"boardings": "raw_bd", "alightings": "raw_al"})

    cap = pd.read_parquet(REPL / "derived" / "capture_table.parquet")
    cap = cap[(cap.day_type == "Weekday") & (cap.year == y) & (cap["period"] == m)]
    cap = cap[["route", "bit", "capture", "reliable"]].copy()
    cap["bit"] = cap["bit"].astype(np.int8)
    cap["scale"] = np.where(cap.capture > 0, 1.0 / cap.capture.clip(upper=1.0), 1.0)
    t["bit"] = t["bit"].astype(np.int8)
    t = t.merge(cap[["route", "bit", "scale", "reliable"]], on=["route", "bit"], how="left")
    t["scale"] = t["scale"].fillna(1.0)
    t["reliable"] = t["reliable"].fillna(False)

    ntd = pd.read_parquet(REPL / "derived" / "ntd_calibration.parquet")
    row = ntd[(ntd.year == y) & (ntd.month == m)]
    ntd_scale = float(row.ntd_scale.iloc[0]) if len(row) else 1.0

    t["bd"] = (t.raw_bd * t.scale * ntd_scale).astype(np.float32)
    t["al"] = (t.raw_al * t.scale * ntd_scale).astype(np.float32)
    t["imp"] = ~t.reliable
    t = t[["route", "bit", "stop_id", "hour", "bd", "al", "imp"]]
    t["stop_id"] = t.stop_id.astype(str)
    t["route"] = t.route.astype(str)
    t.to_parquet(out, index=False)
    return t


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
    (PACK / name).write_bytes(bytes(blob))
    return offsets, (PACK / name).stat().st_size


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
    period_meta = []
    od_meta = {}

    # group -> tract / bgroup index maps (group_id is unique per stop cluster)
    ok = stops.group_id.notna() & stops.tract_ix.notna() & (stops.tract_ix >= 0)
    g2t = dict(zip(stops.group_id[ok].astype(int), stops.tract_ix[ok].astype(int)))
    okb = stops.group_id.notna() & stops.bgroup_ix.notna() & (stops.bgroup_ix >= 0)
    g2b = dict(zip(stops.group_id[okb].astype(int), stops.bgroup_ix[okb].astype(int)))

    seq_cache = {}
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

        unmatched = sorted(set(ev.route.unique()) - set(alias))
        unmatched_bd = float(ev[ev.route.isin(unmatched)].bd.sum())
        total_bd = float(ev.bd.sum())
        coverage = 1 - unmatched_bd / max(total_bd, 1)

        matrices = {lv: {} for lv in ("group", "tract", "bgroup")}
        grp = stops.group_id
        for (route, bit), key in sorted(assign.items()):
            seq = seqs[key]
            evp = ev[(ev.route == route) & (ev.bit == bit)
                     & (ev.hour >= AM[0]) & (ev.hour < AM[1])]
            if evp.empty:
                continue
            bm = evp.groupby("stop_id").bd.sum() / nwd
            am_ = evp.groupby("stop_id").al.sum() / nwd
            bvec = bm.reindex(seq).fillna(0.0).to_numpy()
            avec = am_.reindex(seq).fillna(0.0).to_numpy()
            if bvec.sum() < 0.5 or avec.sum() < 0.5:
                continue
            T = ipf_od(bvec, avec)
            ii, jj = np.nonzero(T > FLOW_MIN)
            g1s = [grp.get(seq[i]) for i in ii]
            g2s = [grp.get(seq[j]) for j in jj]
            flows = T[ii, jj]
            for g1, g2, flow in zip(g1s, g2s, flows):
                if pd.isna(g1) or pd.isna(g2) or g1 == g2 or g1 < 0 or g2 < 0:
                    continue
                d = matrices["group"]
                d[(int(g1), int(g2))] = d.get((int(g1), int(g2)), 0.0) + float(flow)
        for (u, v), flow in list(matrices["group"].items()):
            tu, tv = g2t.get(u), g2t.get(v)
            if tu is not None and tv is not None and tu != tv:
                matrices["tract"][(tu, tv)] = matrices["tract"].get((tu, tv), 0.0) + flow
            bu, bv = g2b.get(u), g2b.get(v)
            if bu is not None and bv is not None and bu != bv:
                matrices["bgroup"][(bu, bv)] = matrices["bgroup"].get((bu, bv), 0.0) + flow

        anchor_id = f"{y}-{m:02d}"
        per_level = {lv: topk_lists(matrices[lv], sizes[lv], ks[lv])
                     for lv in ("group", "tract", "bgroup")}
        offsets, size = write_od(f"commute_od_{anchor_id}.bin", per_level, sizes, ks)
        od_meta[anchor_id] = {"am": {"file": f"commute_od_{anchor_id}.bin",
                                     "levels": offsets}}
        period_meta[p]["odCoverage"] = round(coverage, 3)
        print(f"  {label}: {len(assign)} (route,bit) matches, "
              f"unmatched routes {unmatched_bd / max(total_bd, 1):.1%} of bd, "
              f"od {size / 1e6:.2f} MB")

    # ---- write hourly bins ----
    hourly_section = {}
    for lv in LEVELS:
        arr = hourly[lv].reshape(sizes[lv], n_p, 2, N_HOURS)
        mx = arr.reshape(arr.shape[0], -1).max(axis=1)
        scale = np.where(mx > 0, mx / 65535.0, 1.0).astype(np.float64)
        q = np.round(arr / scale[:, None, None, None]).clip(0, 65535).astype("<u2")
        name = f"commute_hourly_{lv}.bin"
        (PACK / name).write_bytes(q.tobytes())
        hourly_section[lv] = {
            "file": name,
            "n": sizes[lv],
            "nP": n_p,
            "scales": [round(float(v), 6) for v in scale],
        }
        print(f"  {name} {(PACK / name).stat().st_size / 1e6:.2f} MB")

    out = {
        "periods": period_meta,
        "latest": f"{latest[0]}-{latest[1]:02d}",
        "base": "2020-02",
        "windows": {"am": list(AM), "pm": (15, 19)},
        "hourly": hourly_section,
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
