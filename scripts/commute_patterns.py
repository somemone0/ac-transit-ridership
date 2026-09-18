"""Pool the half-year snapshots into era-level commute patterns, and compare
the pooled patterns with LODES.

Every snapshot's O-D flows are avg-weekday AM riders for its month, so an
equal-weight average across snapshots is a mean avg-weekday flow over the
sampled months. Pooling also washes out most of the per-snapshot IPF noise
(and the tie-heavy flows that made per-origin rank correlations unstable).

Eras: "pre" = Feb 2019-Feb 2020, "post" = Feb 2022-present, "all" = every
snapshot. The pandemic collapse means all-era pooling blends two different
transit worlds; pre/post are the interpretable ones.

Usage: python3 scripts/commute_patterns.py

Outputs: printed summary; CSVs beside the LODES cache.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_lodes import (CACHE, PACK, am_marginals, lodes_od, parse_od,
                           spearman)

SF = "06075"


def pool_od(snapshots, level="tract"):
    """Pooled (avg per-snapshot) in- and out-lists across snapshots.

    Each snapshot contributes only its top-K lists, so a pair that drops out
    of the top-K in some snapshots is averaged as if it were zero there: the
    pooled flow is a floor for marginal pairs, exact for the big ones.
    """
    acc_out, acc_in = {}, {}
    for s in snapshots:
        ins, outs = parse_od(s, level)
        for o, dests in outs.items():
            for d, f in dests.items():
                acc_out[(o, d)] = acc_out.get((o, d), 0.0) + f
        for d, origs in ins.items():
            for o, f in origs.items():
                acc_in[(d, o)] = acc_in.get((d, o), 0.0) + f
    n = len(snapshots)
    return ({k: v / n for k, v in acc_out.items()},
            {k: v / n for k, v in acc_in.items()})


def pool_marginals(snapshots):
    bds, als = zip(*(am_marginals(s) for s in snapshots))
    return np.mean(bds, axis=0), np.mean(als, axis=0)


def topk(d, k):
    """The k keys with the largest values, largest first."""
    return [key for key, _ in sorted(d.items(), key=lambda kv: -kv[1])[:k]]


def top_names(d, tracts, k=4):
    """'400100 (123), ...' for the k biggest entries of {key: flow}, or '-'."""
    items = sorted(d.items(), key=lambda kv: -kv[1])[:k]
    return ", ".join(f"{tracts[t][5:]} ({f:.0f})" for t, f in items) or "-"


def compare_pooled(label, pooled_out, bd, al, lodes_year, tracts):
    """LODES agreement of a pooled era: overlap, per-origin rho, marginals."""
    ix = {g: i for i, g in enumerate(tracts)}
    pair, h_tot, w_tot = lodes_od(lodes_year)
    pair = pair[pair.h.isin(tracts) & pair.w.isin(tracts) & (pair.h != pair.w)]
    lp = {}
    for a, b, f in zip(pair.h, pair.w, pair.jobs):
        lp[(ix[a], ix[b])] = f

    print(f"\n--- {label} vs LODES {lodes_year} (JT01) ---")
    print(f"pooled pairs: {len(pooled_out)}, avg-wkday AM riders: "
          f"{sum(pooled_out.values()):,.0f} | LODES pairs: {len(lp)}, "
          f"primary jobs: {pair.jobs.sum():,.0f}")

    ovs, rhos = [], []
    by_origin = {}
    for (o, d), f in pooled_out.items():
        by_origin.setdefault(o, {})[d] = f
    lodes_by_origin = {}
    for (o, d), f in lp.items():
        lodes_by_origin.setdefault(o, {})[d] = f
    for o, dests in by_origin.items():
        ldests = lodes_by_origin.get(o, {})
        to, tl = topk(dests, 10), topk(ldests, 10)
        if len(to) >= 10 and len(tl) >= 10:
            ovs.append(len(set(to) & set(tl)) / 10)
        union = sorted(set(to) | set(tl))
        if len(union) >= 5:
            r = spearman([dests.get(d, 0) for d in union],
                         [ldests.get(d, 0) for d in union])
            if not np.isnan(r):
                rhos.append(r)
    mean_ov = np.mean(ovs) if ovs else np.nan
    med_ov = np.median(ovs) if ovs else np.nan
    med_rho = np.median(rhos) if rhos else np.nan
    print(f"top-10 destination overlap: mean {mean_ov:.2f} "
          f"(median {med_ov:.2f}, n={len(ovs)}); "
          f"per-origin rank rho: median {med_rho:.2f} (n={len(rhos)})")

    ixg = np.array(tracts)
    our_al = pd.Series(al, index=ixg)
    our_bd = pd.Series(bd, index=ixg)
    lod_w = w_tot.reindex(ixg).fillna(0)
    lod_h = h_tot.reindex(ixg).fillna(0)

    for tag, mask in (("all tracts", np.ones(len(ixg), bool)),
                      ("served tracts", our_al > 0),
                      ("served, excl SF",
                       (our_al > 0) & ~np.char.startswith(ixg, SF))):
        k = our_al[mask] > 0 if "served" in tag else np.ones(mask.sum(), bool)
        if k.sum() > 2:
            print(f"destination attraction rho ({tag}): "
                  f"{spearman(our_al[mask][k], lod_w[mask][k]):.2f} (n={k.sum()})")
    for tag, mask in (("all tracts", np.ones(len(ixg), bool)),
                      ("served tracts", our_bd > 0)):
        k = our_bd[mask] > 0 if "served" in tag else np.ones(mask.sum(), bool)
        if k.sum() > 2:
            print(f"origin residences rho ({tag}): "
                  f"{spearman(our_bd[mask][k], lod_h[mask][k]):.2f} (n={k.sum()})")

    big = sorted(by_origin, key=lambda o: -sum(by_origin[o].values()))[:3]
    print("eyeball check, biggest origins (ours vs LODES top-8 destinations):")
    for o in big:
        ldests = lodes_by_origin.get(o, {})
        print(f"  {tracts[o]} (riders {sum(by_origin[o].values()):.0f}, "
              f"lodes-out {sum(ldests.values()):.0f})")
        print(f"    ours : {', '.join(f'{tracts[d][5:]} ({by_origin[o][d]:.1f})' for d in topk(by_origin[o], 8))}")
        print(f"    lodes: {', '.join(f'{tracts[d][5:]} ({ldests[d]:.0f})' for d in topk(ldests, 8))}")
    return {"overlap10": np.mean(ovs) if ovs else np.nan,
            "rho_origin": np.median(rhos) if rhos else np.nan,
            "rho_dest": spearman(our_al[our_al > 0], lod_w[our_al > 0]),
            "lodes_w": lod_w, "lodes_h": lod_h}


def shift_table(pre, post, tracts, tag):
    """Biggest share-of-system gains/losers between two eras."""
    pre, post = np.asarray(pre, float), np.asarray(post, float)
    sp = pre / max(pre.sum(), 1e-9)
    st = post / max(post.sum(), 1e-9)
    d = st - sp
    order = np.argsort(-np.abs(d))
    print(f"\nbiggest {tag}-share shifts (pre -> post, percentage points):")
    for i in order[:10]:
        print(f"  {tracts[i]}: {sp[i]:.2%} -> {st[i]:.2%} ({d[i]:+.2%}, "
              f"{pre[i]:.0f} -> {post[i]:.0f} riders)")


def main():
    meta = json.loads((PACK / "commute_meta.json").read_text())
    ids = [p["id"] for p in meta["periods"]]
    tracts = json.loads((PACK / "meta.json").read_text())["tracts"]

    eras = {
        "pre": [s for s in ids if s < "2020-08"],
        "post": [s for s in ids if s >= "2022-02"],
        "all": ids,
    }
    print(f"snapshots {len(ids)}: {ids[0]}..{ids[-1]}")
    for k, v in eras.items():
        print(f"  {k}: {len(v)} snapshots")

    pooled, marg = {}, {}
    for era, snaps in eras.items():
        pooled[era] = pool_od(snaps)
        marg[era] = pool_marginals(snaps)

    results = {}
    results["pre"] = compare_pooled("pre (Feb 2019-Feb 2020)", pooled["pre"][0],
                                    *marg["pre"], 2019, tracts)
    results["post"] = compare_pooled("post (Feb 2022-May 2026)", pooled["post"][0],
                                     *marg["post"], 2023, tracts)

    # ---- the commute patterns themselves ----
    for era in ("pre", "post"):
        out, ins = pooled[era]
        bd, al = marg[era]
        by_origin, by_dest = {}, {}
        for (o, d), f in out.items():
            by_origin.setdefault(o, {})[d] = f
        for (d, o), f in ins.items():
            by_dest.setdefault(d, {})[o] = f
        print(f"\n=== {era}: top destination tracts (avg-wkday AM arrivals) ===")
        for i in np.argsort(-al)[:8]:
            catchment = top_names(by_dest.get(i, {}), tracts)
            print(f"  {tracts[i]}: {al[i]:,.0f} riders | catchment: {catchment}")
        print(f"=== {era}: top residence tracts (avg-wkday AM boardings) ===")
        for i in np.argsort(-bd)[:8]:
            dests = top_names(by_origin.get(i, {}), tracts)
            print(f"  {tracts[i]}: {bd[i]:,.0f} riders | top destinations: {dests}")
        print(f"=== {era}: biggest O-D pairs ===")
        for (o, d), f in sorted(out.items(), key=lambda kv: -kv[1])[:8]:
            print(f"  {tracts[o][5:]} -> {tracts[d][5:]}: {f:,.0f} riders/wkday")

    shift_table(marg["pre"][1], marg["post"][1], tracts, "workplace (arrivals)")
    shift_table(marg["pre"][0], marg["post"][0], tracts, "residence (boardings)")

    # ---- CSVs ----
    CACHE.mkdir(parents=True, exist_ok=True)
    tab = pd.DataFrame({"tract": tracts})
    for era in ("pre", "post", "all"):
        bd, al = marg[era]
        tab[f"boardings_{era}"] = np.round(bd, 1)
        tab[f"arrivals_{era}"] = np.round(al, 1)
    tab["lodes_jobs_2023"] = results["post"]["lodes_w"].values
    tab["lodes_workers_2023"] = results["post"]["lodes_h"].values
    tab.to_csv(CACHE / "pooled_marginals.csv", index=False)

    rows = []
    for era in ("pre", "post", "all"):
        for (o, d), f in pooled[era][0].items():
            rows.append({"era": era, "origin": tracts[o], "dest": tracts[d],
                         "riders_wkday": round(f, 2)})
    pd.DataFrame(rows).to_csv(CACHE / "pooled_od.csv", index=False)
    print(f"\nwrote {CACHE/'pooled_marginals.csv'}, {CACHE/'pooled_od.csv'}")


if __name__ == "__main__":
    main()
