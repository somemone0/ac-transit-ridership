"""Stage 3: run IPF variants (a) per line-direction and (b) whole network; score."""
import json
import numpy as np
import pandas as pd
from pathlib import Path
import common as C

HERE = Path(__file__).resolve().parent
BW = 0.02

def length_bias_buckets(sep_acc, edges=(1, 2, 3, 5, 8, 12, 100)):
    """Bucket sequence separations; sep = j-i, so intervening stations = sep-1."""
    rows, lo = [], edges[0]
    for hi in edges[1:]:
        a = sum(v[0] for s, v in sep_acc.items() if lo <= s < hi)
        p = sum(v[1] for s, v in sep_acc.items() if lo <= s < hi)
        rows.append({"sep_lo": lo, "sep_hi": hi - 1, "actual": a, "pred": p,
                     "ratio": (p / a) if a > 0 else float("nan")})
        lo = hi
    return rows


truth = C.load_truth()
lines = C.load_lines()
per_line, cov = C.assign_to_lines(truth, lines)
print(f"assignment coverage: {cov['coverage']:.3%} of AM trips "
      f"({cov['unassigned']:.0f} trips on {cov['unassigned_pairs']} "
      f"transfer-only pairs dropped)")

stations = sorted(set(truth.orig) | set(truth.dest))
six = {s: i for i, s in enumerate(stations)}
N = len(stations)

# ---------- variant (a): per line-direction ----------
rows = []
net_pred = np.zeros((N, N))       # app-style aggregate of IPF output
net_pred_grav = np.zeros((N, N))
net_true = np.zeros((N, N))       # assigned truth, same support
pooled = {"P": [], "A": []}
# trip-length bias accumulated in LINE-SEQUENCE space (sep = j - i)
sep_acc = {}                      # sep -> [actual, pred]

for ln, seq in sorted(lines.items()):
    if ln not in per_line:
        continue
    df = per_line[ln]
    Aa = C.to_matrix(df, seq)
    B, Al = Aa.sum(axis=1), Aa.sum(axis=0)
    if B.sum() < 0.5:
        continue
    P = C.ipf_od(B, Al, backward_weight=BW)
    n = len(seq)
    i, j = np.indices((n, n))
    G = C.gravity(B, Al)

    m = C.cell_metrics(P, Aa)
    t = C.topk_metrics(P, Aa)
    mg = C.cell_metrics(G, Aa)
    tg = C.topk_metrics(G, Aa)
    rows.append({
        "line": ln, "n_stations": n, "am_trips": round(float(Aa.sum()), 1),
        **{k: round(v, 4) for k, v in m.items()},
        **{k: (round(v, 4) if isinstance(v, float) else v) for k, v in t.items()},
        "gravity_wmape": round(mg["wmape"], 4),
        "gravity_top5_overlap": round(tg["top5_overlap"], 4),
        "true_gini": round(C.gini(Aa[Aa > 0]), 4),
        "pred_gini": round(C.gini(P[P > 0]), 4),
    })
    pooled["P"].append(P.ravel())
    pooled["A"].append(Aa.ravel())
    sep = (j - i)
    for s in range(1, n):
        m = sep == s
        cur = sep_acc.setdefault(s, [0.0, 0.0])
        cur[0] += float(Aa[m].sum())
        cur[1] += float(P[m].sum())

    for a_ in range(n):
        for b_ in range(n):
            if a_ == b_:
                continue
            u, v = six[seq[a_]], six[seq[b_]]
            net_pred[u, v] += P[a_, b_]
            net_pred_grav[u, v] += G[a_, b_]
            net_true[u, v] += Aa[a_, b_]

ld = pd.DataFrame(rows).sort_values("am_trips", ascending=False)
ld.to_csv(HERE / "per_line_direction_metrics.csv", index=False)

# pooled cell metrics across all line-directions (every cell of every line)
Pp = np.concatenate(pooled["P"])
Ap = np.concatenate(pooled["A"])
pool_cells = C.cell_metrics(Pp, Ap)

# app-style: aggregate line-direction outputs into one network matrix
net_cells = C.cell_metrics(net_pred, net_true)
net_top = C.topk_metrics(net_pred, net_true)
net_cells_g = C.cell_metrics(net_pred_grav, net_true)
net_top_g = C.topk_metrics(net_pred_grav, net_true)

# ---------- variant (b): whole network, unconstrained ----------
FULL = np.zeros((N, N))
for o, d, f in truth[["orig", "dest", "flow"]].itertuples(index=False):
    if o != d:
        FULL[six[o], six[d]] += f
Bn, An = FULL.sum(axis=1), FULL.sum(axis=0)
Pb = C.ipf_unconstrained(Bn, An)
Gb = C.gravity(Bn, An)
b_cells, b_top = C.cell_metrics(Pb, FULL), C.topk_metrics(Pb, FULL)
bg_cells, bg_top = C.cell_metrics(Gb, FULL), C.topk_metrics(Gb, FULL)

res = {
    "coverage": cov,
    "n_stations": N,
    "am_trips_total": float(truth.flow.sum()),
    "variant_a_pooled_cells": pool_cells,
    "variant_a_network_cells": net_cells,
    "variant_a_network_topk": net_top,
    "variant_a_network_gravity_cells": net_cells_g,
    "variant_a_network_gravity_topk": net_top_g,
    "variant_a_length_bias": length_bias_buckets(sep_acc),
    "variant_b_cells": b_cells, "variant_b_topk": b_top,
    "variant_b_gravity_cells": bg_cells, "variant_b_gravity_topk": bg_top,
    "concentration": {
        "true_gini": C.gini(net_true[net_true > 0]),
        "pred_gini": C.gini(net_pred[net_pred > 0]),
        "true_top10pct_share": C.top_share(net_true[net_true > 0]),
        "pred_top10pct_share": C.top_share(net_pred[net_pred > 0]),
        "true_nonzero_cells": int((net_true > 0).sum()),
        "pred_nonzero_cells": int((net_pred > 0.01).sum()),
        "b_true_gini": C.gini(FULL[FULL > 0]),
        "b_pred_gini": C.gini(Pb[Pb > 0]),
    },
}
(HERE / "results_main.json").write_text(json.dumps(res, indent=1, default=float))
np.save(HERE / "net_true.npy", net_true)
np.save(HERE / "net_pred.npy", net_pred)
json.dump(stations, open(HERE / "stations.json", "w"))

print("\n--- variant (a) per line-direction (worst->best by WMAPE) ---")
print(ld[["line", "am_trips", "wmape", "r2", "top5_overlap", "top1_hit",
          "gravity_wmape"]].to_string(index=False))
print("\npooled cells:", {k: round(v, 3) for k, v in pool_cells.items()})
print("network agg :", {k: round(v, 3) for k, v in net_cells.items()})
print("network topk:", {k: round(v, 3) if isinstance(v, float) else v
                        for k, v in net_top.items()})
print("network gravity:", round(net_cells_g["wmape"], 3),
      round(net_top_g["top5_overlap"], 3))
print("\nvariant (b) cells:", {k: round(v, 3) for k, v in b_cells.items()})
print("variant (b) topk:", {k: round(v, 3) if isinstance(v, float) else v
                            for k, v in b_top.items()})
print("variant (b) gravity:", round(bg_cells["wmape"], 3),
      round(bg_top["top5_overlap"], 3))
print("\nlength bias:")
for r in res["variant_a_length_bias"]:
    print(f"  sep {r['sep_lo']}-{r['sep_hi']}: actual={r['actual']:9.0f} "
          f"pred={r['pred']:9.0f} ratio={r['ratio']:.3f}")
print("\nconcentration:", {k: (round(v, 3) if isinstance(v, float) else v)
                           for k, v in res["concentration"].items()})
