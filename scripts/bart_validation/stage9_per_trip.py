"""Stage 9: the per-trip path (trip_bases/rake/choose_passes) against BART truth.

BART publishes only the mean matrix, so there is no per-trip structure to fit.
Synthesize it: each true passenger is drawn as (origin, destination, train),
which gives every train its own stop-level boarding/alighting vector exactly as
a bus run has in the APC data. The production `choose_passes` / `trip_bases` /
`rake` code then runs on those trips unchanged and is scored against the same
mean matrix every other stage is scored against.

The synthetic design is fixed: 20 weekdays x 20 runs per line-direction, each
day's passenger total Poisson-drawn around the true mean and each passenger's
OD pair drawn from the true matrix; trains are assigned uniformly. Seeded per
line so the numbers are stable across runs.
"""
import json
import zlib
import numpy as np
import pandas as pd
from pathlib import Path
import common as C

HERE = Path(__file__).resolve().parent
N_DAYS = 20
TRAINS_PER_DAY = 20
SEED = 20260921


def synth_trips(M, n_days=N_DAYS, trains=TRAINS_PER_DAY, seed=SEED):
    """(B, A, day) for one line-direction: passengers drawn from M onto runs."""
    rng = np.random.default_rng(seed)
    n = M.shape[0]
    total = M.sum()
    if total <= 0:
        return None, None, None
    p = (M / total).ravel()
    n_trips = n_days * trains
    B = np.zeros((n_trips, n))
    A = np.zeros_like(B)
    day = np.repeat(np.arange(n_days), trains)
    for d in range(n_days):
        k = rng.poisson(total)
        if k == 0:
            continue
        flat = rng.choice(n * n, size=k, p=p)
        o, dest = flat // n, flat % n
        which = rng.integers(0, trains, size=k) + d * trains
        np.add.at(B, (which, o), 1.0)
        np.add.at(A, (which, dest), 1.0)
    return B, A, day


def fit_branches(B, A, M, day):
    """Production selections plus fixed branches; returns {(name, passes): P}."""
    bvec, avec = M.sum(axis=1), M.sum(axis=0)
    out = {}
    out["summed"] = C.ipf_od(bvec, avec)
    bases = C.trip_bases(B, A, C.TRIP_PASSES)
    for k, base in bases.items():
        out[f"{k}-pass"] = C.rake(base, bvec, avec)
    chosen = C.choose_passes(B, A, day)
    out["chosen"] = out["summed"] if chosen == 0 else out[f"{chosen}-pass"]
    out["gravity"] = C.gravity(bvec, avec)
    return out, chosen


def displayed_metrics(P, A, k=5):
    """Same top-5-per-origin cells stage7 scores, for any branch."""
    def select(M):
        sel = np.zeros_like(M, dtype=bool)
        for i in range(M.shape[0]):
            if M[i].sum() <= 0:
                continue
            for j in np.argsort(-M[i])[:k]:
                if M[i, j] > 0:
                    sel[i, j] = True
        return sel
    sel, tsel = select(P), select(A)
    pv, av = P[sel], A[sel]
    ok = av > 0
    rel = pv[ok] / av[ok]
    return {
        "displayed_cells": int(sel.sum()),
        "share_true_flow": float(av.sum() / A.sum()),
        "wmape_displayed": float(np.abs(pv - av).sum() / av.sum()),
        "within_25pct": float(((rel > .75) & (rel < 1.25)).mean()),
        "within_50pct": float(((rel > .5) & (rel < 1.5)).mean()),
        "factor2_or_worse": float(((rel > 2) | (rel < .5)).mean()),
        "recall_of_true_top5_flow": float(A[sel].sum() / A[tsel].sum()),
        "pct": {f"p{q}": float(np.percentile(rel, q)) for q in (5, 25, 50, 75, 95)},
    }


truth = C.load_truth()
lines = C.load_lines()
per_line, cov = C.assign_to_lines(truth, lines)
print(f"assignment coverage: {cov['coverage']:.3%} of AM trips")

stations = sorted(set(truth.orig) | set(truth.dest))
six = {s: i for i, s in enumerate(stations)}
N = len(stations)
BRANCHES = ["summed", "3-pass", "8-pass", "chosen", "gravity"]

rows = []
per_line_rows = []
net_true = np.zeros((N, N))
net_pred = {b: np.zeros((N, N)) for b in BRANCHES}
chosen_counts = {}
branch_flow = {b: 0.0 for b in BRANCHES}
oracle_hits = 0
used = 0

for ln, seq in sorted(lines.items()):
    if ln not in per_line:
        continue
    M = C.to_matrix(per_line[ln], seq)
    if M.sum() < 0.5:
        continue
    B, A, day = synth_trips(M, seed=SEED + zlib.crc32(ln.encode()) % 10_000)
    if B is None:
        continue
    P, chosen = fit_branches(B, A, M, day)
    chosen_counts[chosen] = chosen_counts.get(chosen, 0) + 1
    used += 1

    line_wmape = {}
    for b in BRANCHES:
        m = C.cell_metrics(P[b], M)
        t = C.topk_metrics(P[b], M)
        line_wmape[b] = m["wmape"]
        branch_flow[b] += float(P[b].sum())
        per_line_rows.append({"line": ln, "branch": b, "passes_chosen": chosen,
                              "am_trips": round(float(M.sum()), 1),
                              **{k: round(v, 4) for k, v in m.items()},
                              **{k: (round(v, 4) if isinstance(v, float) else v)
                                 for k, v in t.items()}})
    if np.isclose(line_wmape["chosen"],
                  min(line_wmape[b] for b in BRANCHES[:-1])):
        oracle_hits += 1
    rows.append({"line": ln, "am_trips": round(float(M.sum()), 1),
                 "chosen": chosen,
                 **{f"wmape_{b}": round(line_wmape[b], 4) for b in BRANCHES},
                 "true_gini": round(C.gini(M[M > 0]), 4)})

    n = len(seq)
    for a_ in range(n):
        for b_ in range(n):
            if a_ != b_:
                net_true[six[seq[a_]], six[seq[b_]]] += M[a_, b_]
    for b in BRANCHES:
        for a_ in range(n):
            for b_ in range(n):
                if a_ != b_:
                    net_pred[b][six[seq[a_]], six[seq[b_]]] += P[b][a_, b_]

ld = pd.DataFrame(rows).sort_values("am_trips", ascending=False)
ld.to_csv(HERE / "per_line_per_trip.csv", index=False)

summary = {"coverage": cov, "n_stations": N, "n_lines": used,
           "am_trips_total": float(truth.flow.sum()),
           "synthetic": {"n_days": N_DAYS, "trains_per_day": TRAINS_PER_DAY,
                         "seed": SEED},
           "passes_chosen": chosen_counts,
           "oracle_agreement": oracle_hits / used if used else float("nan"),
           "branches": {}}
print("\n--- per line-direction ---")
print(ld.to_string(index=False))

print("\n--- network aggregate (app-style: line outputs summed) ---")
for b in BRANCHES:
    m = C.cell_metrics(net_pred[b], net_true)
    t = C.topk_metrics(net_pred[b], net_true)
    d = displayed_metrics(net_pred[b], net_true)
    summary["branches"][b] = {"cells": m, "topk": t, "displayed": d,
                              "pred_flow": float(net_pred[b].sum())}
    print(f"  {b:8s} WMAPE {m['wmape']:.3f}  R2 {m['r2']:.3f}  "
          f"top5 {t['top5_overlap']:.3f}  top1 {t['top1_hit']:.3f}  "
          f"rho {t['spearman']:.3f}  | displayed WMAPE "
          f"{d['wmape_displayed']:.3f}  >=2x {d['factor2_or_worse']:.1%}  "
          f"recall {d['recall_of_true_top5_flow']:.1%}")

print("\npasses chosen:", chosen_counts,
      f"| oracle agreement {summary['oracle_agreement']:.2f}")

pd.DataFrame(per_line_rows).to_csv(HERE / "per_line_per_trip_branches.csv",
                                   index=False)
json.dump(summary, open(HERE / "results_per_trip.json", "w"),
          indent=1, default=float)
