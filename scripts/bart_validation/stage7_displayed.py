"""Stage 7: accuracy of exactly the cells the app DISPLAYS (top-5 per origin)."""
import json
import numpy as np
from pathlib import Path
import common as C

HERE = Path(__file__).resolve().parent
P = np.load(HERE / "net_pred.npy")
A = np.load(HERE / "net_true.npy")
stations = json.load(open(HERE / "stations.json"))
K = 5

sel = np.zeros_like(P, dtype=bool)
for i in range(P.shape[0]):
    if P[i].sum() <= 0:
        continue
    for j in np.argsort(-P[i])[:K]:
        if P[i, j] > 0:
            sel[i, j] = True

pv, av = P[sel], A[sel]
print(f"displayed cells: {sel.sum()} of {(A > 0).sum()} true-nonzero cells")
print(f"they carry {av.sum() / A.sum():.1%} of true AM flow "
      f"and {pv.sum() / P.sum():.1%} of predicted flow")
print(f"WMAPE on displayed cells: {np.abs(pv - av).sum() / av.sum():.4f}")
print(f"total pred/actual on displayed cells: {pv.sum() / av.sum():.4f}")

# per-cell relative error distribution on displayed cells
ok = av > 0
rel = pv[ok] / av[ok]
qs = [5, 25, 50, 75, 95]
print("pred/actual percentiles on displayed cells:",
      {f"p{q}": round(float(np.percentile(rel, q)), 3) for q in qs})
print(f"within +/-25%: {float(((rel > .75) & (rel < 1.25)).mean()):.1%}")
print(f"within +/-50%: {float(((rel > .5) & (rel < 1.5)).mean()):.1%}")
print(f"factor-of-2 or worse: {float(((rel > 2) | (rel < .5)).mean()):.1%}")

# how much true flow do the app's displayed cells capture vs the true top-5?
tsel = np.zeros_like(A, dtype=bool)
for i in range(A.shape[0]):
    if A[i].sum() <= 0:
        continue
    for j in np.argsort(-A[i])[:K]:
        if A[i, j] > 0:
            tsel[i, j] = True
print(f"\ntrue top-5 cells carry {A[tsel].sum() / A.sum():.1%} of true flow")
print(f"predicted top-5 cells capture {A[sel].sum() / A[tsel].sum():.1%} "
      f"of the flow the TRUE top-5 carries")

out = {
    "displayed_cells": int(sel.sum()),
    "share_true_flow": float(av.sum() / A.sum()),
    "wmape_displayed": float(np.abs(pv - av).sum() / av.sum()),
    "within_25pct": float(((rel > .75) & (rel < 1.25)).mean()),
    "within_50pct": float(((rel > .5) & (rel < 1.5)).mean()),
    "factor2_or_worse": float(((rel > 2) | (rel < .5)).mean()),
    "true_top5_flow_share": float(A[tsel].sum() / A.sum()),
    "recall_of_true_top5_flow": float(A[sel].sum() / A[tsel].sum()),
    "pct": {f"p{q}": float(np.percentile(rel, q)) for q in qs},
}
json.dump(out, open(HERE / "displayed.json", "w"), indent=1)
