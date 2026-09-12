"""Compare our inferred AM tract-to-tract O-D flows with real LODES.

Quick version: reads the pack's top-K O-D lists (no rebuild needed), joins
LODES8 OD main tables (JT01 primary jobs, 2020 block geography) aggregated to
tracts, and compares spatial patterns: top-destination overlap per origin,
per-origin rank correlation, and origin/destination attraction marginals.

Levels are NOT comparable (avg-weekday bus riders vs all UI-covered primary
jobs); only patterns are. Both sides exclude intra-tract flows. Our side is
inferred (IPF), not observed. LODES year = snapshot year (Feb snapshot).

Usage: python3 scripts/compare_lodes.py [snapshot ...]   (default 2019-02 2023-02)

Outputs: printed summary; per-origin CSV in vis/data/lodes_cache/.
"""
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
import pandas as pd

NEXT = Path(__file__).resolve().parent.parent
PACK = Path(os.environ.get("ACPRA_PACK", NEXT / "public" / "data" / "pack"))
CACHE = (Path(os.environ.get("ACPRA_VIS", NEXT.parent / "vis"))
         / "data" / "lodes_cache")

COUNTIES = ["06001", "06013", "06085", "06075", "06081"]


def parse_od(snapshot, level="tract"):
    """(ins, outs) from the pack's top-K lists: ins[dest][origin], outs[origin][dest].

    ins and outs are the same flows seen from each end, each truncated to the
    top-K of its own row/column.
    """
    cm = json.loads((PACK / "commute_meta.json").read_text())
    sec = cm["od"][snapshot]["am"]
    lv = sec["levels"][level]
    blob = (PACK / sec["file"]).read_bytes()
    ins, outs = {}, {}
    pos = lv["offset"]
    for key in range(lv["n"]):
        n_in = blob[pos]
        pos += 1
        ins[key] = {}
        for _ in range(n_in):
            other, flow = struct.unpack_from("<Hf", blob, pos)
            pos += 6
            ins[key][int(other)] = float(flow)
        n_out = blob[pos]
        pos += 1
        outs[key] = {}
        for _ in range(n_out):
            other, flow = struct.unpack_from("<Hf", blob, pos)
            pos += 6
            outs[key][int(other)] = float(flow)
    return ins, outs


def parse_outs(snapshot, level="tract"):
    """{origin_key: {dest_key: flow}} from the pack's top-K out-lists."""
    return parse_od(snapshot, level)[1]


def am_marginals(snapshot, level="tract"):
    """Avg-weekday AM boardings and alightings per key, from hourly bins."""
    cm = json.loads((PACK / "commute_meta.json").read_text())
    sec = cm["hourly"][level]
    arr = np.frombuffer((PACK / sec["file"]).read_bytes(), dtype="<u2")
    arr = arr.reshape(sec["n"], sec["nP"], 2, 24)
    scales = np.asarray(sec["scales"])
    wd = np.asarray([p["weekdays"] for p in cm["periods"]])
    p = [q["id"] for q in cm["periods"]].index(snapshot)
    bd = arr[:, p, 0, 5:9].sum(axis=1) * scales / wd[p]
    al = arr[:, p, 1, 5:9].sum(axis=1) * scales / wd[p]
    return bd, al


def lodes_od(year):
    """(pair flows, h-tract totals, w-tract totals) from the LODES OD file."""
    path = CACHE / f"ca_od_main_JT01_{year}.csv.gz"
    if not path.exists():
        url = ("https://lehd.ces.census.gov/data/lodes/LODES8/ca/od/"
               f"ca_od_main_JT01_{year}.csv.gz")
        sys.exit(f"missing {path}\ndownload it first:\n  curl -o {path} {url}")
    rows = []
    for chunk in pd.read_csv(path, usecols=["w_geocode", "h_geocode", "S000"],
                             dtype={"w_geocode": str, "h_geocode": str},
                             chunksize=2_000_000):
        hc, wc = chunk.h_geocode.str[:5], chunk.w_geocode.str[:5]
        keep = hc.isin(COUNTIES) | wc.isin(COUNTIES)
        rows.append(chunk[keep])
    df = pd.concat(rows, ignore_index=True)
    df["h"] = df.h_geocode.str[:11]
    df["w"] = df.w_geocode.str[:11]
    pair = (df.groupby(["h", "w"]).S000.sum()
            .rename("jobs").reset_index())
    h_tot = pair.groupby("h").jobs.sum()
    w_tot = pair.groupby("w").jobs.sum()
    return pair, h_tot, w_tot


def topk(d, k):
    return [v for v, _ in sorted(d.items(), key=lambda kv: -kv[1])[:k]]


def spearman(a, b):
    sa, sb = pd.Series(a).astype(float), pd.Series(b).astype(float)
    if len(sa) < 3 or sa.nunique() < 2 or sb.nunique() < 2:
        return np.nan
    return sa.corr(sb, method="spearman")


def compare(snapshot, tracts, outdir):
    year = int(snapshot[:4])
    ix = {g: i for i, g in enumerate(tracts)}
    # out-list keys are indexes into the tracts array; keep in-set destinations
    ours = {}
    for o, dests in parse_outs(snapshot).items():
        if o < len(tracts):
            ours[o] = {d: f for d, f in dests.items() if d < len(tracts)}

    bd, al = am_marginals(snapshot)
    pair, h_tot, w_tot = lodes_od(year)
    pair = pair[pair.h.isin(tracts) & pair.w.isin(tracts) & (pair.h != pair.w)]
    lp = {(ix[a], ix[b]): f for a, b, f in
          zip(pair.h, pair.w, pair.jobs)}

    cov_h = pair.h.nunique()
    cov_w = pair.w.nunique()
    print(f"\n=== {snapshot} vs LODES {year} (JT01 primary jobs) ===")
    print(f"our tracts: {len(tracts)}; LODES covers {cov_h} as home, "
          f"{cov_w} as workplace; pairs: ours {sum(len(d) for d in ours.values())}, "
          f"LODES {len(lp)}")

    # ---- per-origin top-destination overlap and rank correlation ----
    k_s = (5, 10)
    recs = []
    for o, dests in ours.items():
        if not dests:
            continue
        ldests_all = {d[1]: f for d, f in lp.items() if d[0] == o}
        tot_o = sum(dests.values())
        tl_sum = sum(ldests_all.values())
        row = {"tract": tracts[o], "our_flows": round(tot_o, 1),
               "lodes_jobs": int(tl_sum)}
        for k in k_s:
            to, tl = topk(dests, k), topk(ldests_all, k)
            if len(to) >= k and len(tl) >= k:
                row[f"ov{k}"] = len(set(to) & set(tl)) / k
        union = sorted(set(topk(dests, 10)) | set(topk(ldests_all, 10)))
        if len(union) >= 5:
            row["rho"] = spearman([dests.get(d, 0) for d in union],
                                  [ldests_all.get(d, 0) for d in union])
        recs.append(row)
    r = pd.DataFrame(recs)
    ov10 = r.ov10.dropna()
    rho = r.rho.dropna()
    wgt = (r.assign(w=r.our_flows * r.ov10.fillna(0))
           .w.sum() / r.our_flows[r.ov10.notna()].sum())
    print(f"top-10 destination overlap: mean {ov10.mean():.2f}, "
          f"median {ov10.median():.2f} over {len(ov10)} tracts "
          f"(volume-weighted {wgt:.2f}); top-5: {r.ov5.mean():.2f}")
    print(f"per-origin rank correlation (shares, top-10 union): median "
          f"{rho.median():.2f} over {len(rho)} tracts")

    # ---- marginals: where riders/jobs are (destination), where they live (origin) ----
    our_al = pd.Series(al[:len(tracts)], index=tracts)
    our_bd = pd.Series(bd[:len(tracts)], index=tracts)
    lod_w = w_tot.reindex(tracts).fillna(0)
    lod_h = h_tot.reindex(tracts).fillna(0)
    keep = our_al > 0
    print(f"destination attraction (AM alightings vs LODES workplace jobs): "
          f"rho = {spearman(our_al[keep], lod_w[keep]):.2f} over {keep.sum()} tracts")
    keep = our_bd > 0
    print(f"origin residences (AM boardings vs LODES resident workers): "
          f"rho = {spearman(our_bd[keep], lod_h[keep]):.2f} over {keep.sum()} tracts")

    # ---- examples: biggest LODES workplace tracts ----
    print("\nbiggest destination tracts (ours = avg-wkday AM riders, "
          "LODES = primary jobs):")
    for g in lod_w.sort_values(ascending=False).index[:4]:
        o = ix[g]
        to = topk(ours.get(o, {}), 5)
        tl = topk({d[1]: f for d, f in lp.items() if d[0] == o}, 5)
        fmt = lambda ks: ", ".join(tracts[t][5:] + f" ({ours.get(o, {}).get(t, 0):.0f})"
                                   if t in ours.get(o, {}) else tracts[t][5:]
                                   for t in ks)
        print(f"  {g}: jobs {int(lod_w[g]):>6}, riders {al[o]:>6.0f} | ours: {fmt(to)}")
        print(f"      {'':>32}| lodes: {', '.join(tracts[t][5:] for t in tl)}")

    out = outdir / f"od_compare_{snapshot}.csv"
    r.sort_values("our_flows", ascending=False).to_csv(out, index=False)
    print(f"\nper-tract detail: {out}")


def main():
    snapshots = sys.argv[1:] or ["2019-02", "2023-02"]
    tracts = json.loads((PACK / "meta.json").read_text())["tracts"]
    outdir = CACHE
    outdir.mkdir(parents=True, exist_ok=True)
    for s in snapshots:
        compare(s, tracts, outdir)


if __name__ == "__main__":
    main()
