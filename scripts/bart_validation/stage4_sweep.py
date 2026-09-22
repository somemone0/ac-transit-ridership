"""Stage 4: sensitivity of variant (a) to backward_weight."""
import json
import numpy as np
import pandas as pd
from pathlib import Path
import common as C

HERE = Path(__file__).resolve().parent

truth = C.load_truth()
lines = C.load_lines()
per_line, cov = C.assign_to_lines(truth, lines)
stations = sorted(set(truth.orig) | set(truth.dest))
six = {s: i for i, s in enumerate(stations)}
N = len(stations)

SWEEP = [0.0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5]
rows = []
per_line_rows = []
for bw in SWEEP:
    net_pred = np.zeros((N, N))
    net_true = np.zeros((N, N))
    for ln, seq in sorted(lines.items()):
        if ln not in per_line:
            continue
        Aa = C.to_matrix(per_line[ln], seq)
        B, Al = Aa.sum(axis=1), Aa.sum(axis=0)
        if B.sum() < 0.5:
            continue
        P = C.ipf_od(B, Al, backward_weight=bw)
        n = len(seq)
        m = C.cell_metrics(P, Aa)
        t = C.topk_metrics(P, Aa)
        per_line_rows.append({"backward_weight": bw, "line": ln,
                              "wmape": m["wmape"],
                              "top5_overlap": t["top5_overlap"]})
        for a_ in range(n):
            for b_ in range(n):
                if a_ != b_:
                    u, v = six[seq[a_]], six[seq[b_]]
                    net_pred[u, v] += P[a_, b_]
                    net_true[u, v] += Aa[a_, b_]
    m = C.cell_metrics(net_pred, net_true)
    t = C.topk_metrics(net_pred, net_true)
    rows.append({"backward_weight": bw, "wmape": round(m["wmape"], 4),
                 "r2": round(m["r2"], 4), "pearson": round(m["pearson"], 4),
                 "top5_overlap": round(t["top5_overlap"], 4),
                 "top1_hit": round(t["top1_hit"], 4),
                 "spearman": round(t["spearman"], 4),
                 "pred_gini": round(C.gini(net_pred[net_pred > 0]), 4)})

sw = pd.DataFrame(rows)
sw.to_csv(HERE / "backward_weight_sweep.csv", index=False)
print(sw.to_string(index=False))
best_w = sw.loc[sw.wmape.idxmin()]
best_t = sw.loc[sw.top5_overlap.idxmax()]
print("\nbest by WMAPE:", dict(best_w))
print("best by top5 :", dict(best_t))

# what share of TRUE flow is actually backward along each line sequence?
back = fwd = 0.0
for ln, seq in lines.items():
    if ln not in per_line:
        continue
    Aa = C.to_matrix(per_line[ln], seq)
    n = len(seq)
    i, j = np.indices((n, n))
    back += float(Aa[i > j].sum())
    fwd += float(Aa[i < j].sum())
print(f"\ntrue backward share within assigned line-dirs: "
      f"{back / (back + fwd):.4%} (by construction ~0)")

pd.DataFrame(per_line_rows).to_csv(HERE / "sweep_per_line.csv", index=False)
json.dump(rows, open(HERE / "sweep.json", "w"), indent=1)
