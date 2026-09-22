"""Stage 6: why do some line-directions reconstruct better? Destination concentration."""
import json
import numpy as np
import pandas as pd
from pathlib import Path
import common as C

HERE = Path(__file__).resolve().parent
truth = C.load_truth()
lines = C.load_lines()
per_line, _ = C.assign_to_lines(truth, lines)

rows = []
for ln, seq in sorted(lines.items()):
    if ln not in per_line:
        continue
    M = C.to_matrix(per_line[ln], seq)
    if M.sum() < 100:
        continue
    B, A = M.sum(axis=1), M.sum(axis=0)
    P = C.ipf_od(B, A, backward_weight=0.02)
    m, t = C.cell_metrics(P, M), C.topk_metrics(P, M)
    ash = A / A.sum()
    bsh = B / B.sum()
    rows.append({
        "line": ln,
        "am_trips": round(float(M.sum()), 1),
        "wmape": round(m["wmape"], 4),
        "r2": round(m["r2"], 4),
        "pearson": round(m["pearson"], 4),
        "top5_overlap": round(t["top5_overlap"], 4),
        "top1_hit": round(t["top1_hit"], 4),
        "spearman": round(t["spearman"], 4),
        # destination concentration: does the line have one dominant sink?
        "top_dest": seq[int(np.argmax(A))],
        "top_dest_share": round(float(ash.max()), 4),
        "dest_hhi": round(float((ash ** 2).sum()), 4),
        "orig_hhi": round(float((bsh ** 2).sum()), 4),
        "true_gini": round(C.gini(M[M > 0]), 4),
        "pred_gini": round(C.gini(P[P > 0]), 4),
    })

d = pd.DataFrame(rows).sort_values("wmape")
d.to_csv(HERE / "per_line_direction_metrics.csv", index=False)
print(d.to_string(index=False))
print("\ncorr(dest_hhi, wmape) =", round(d.dest_hhi.corr(d.wmape), 3))
print("corr(top_dest_share, wmape) =", round(d.top_dest_share.corr(d.wmape), 3))
print("corr(dest_hhi, top5_overlap) =", round(d.dest_hhi.corr(d.top5_overlap), 3))
sb = d[d.line.str.endswith("-S")]
nb = d[d.line.str.endswith("-N")]
print(f"\nsouthbound/inbound mean WMAPE: {sb.wmape.mean():.3f} "
      f"(dest_hhi {sb.dest_hhi.mean():.3f})")
print(f"northbound/outbound mean WMAPE: {nb.wmape.mean():.3f} "
      f"(dest_hhi {nb.dest_hhi.mean():.3f})")
json.dump(rows, open(HERE / "per_line.json", "w"), indent=1)
