"""Stage 5: a backward_weight sweep where genuine backward flow EXISTS.

Stage 4's sweep is tautological: pairs are only assigned to a line-direction
that serves them in forward order, so true backward flow is 0 and bw=0 must win.
Here each undirected LINE gets ONE fixed sequence (its '-S' direction) and every
pair the line serves in EITHER order is assigned to it. That reproduces the bus
situation where the stop sequence is right but the direction bit is imperfect,
so a nonzero backward share is really present and backward_weight is testable.
"""
import json
import numpy as np
import pandas as pd
from pathlib import Path
import common as C

HERE = Path(__file__).resolve().parent
truth = C.load_truth()
lines = C.load_lines()

# one canonical sequence per undirected line
canon = {ln[:-2]: seq for ln, seq in lines.items() if ln.endswith("-S")}
pos = {ln: {s: i for i, s in enumerate(seq)} for ln, seq in canon.items()}

buckets = {ln: {} for ln in canon}
assigned = unassigned = 0.0
for o, d, f in truth[["orig", "dest", "flow"]].itertuples(index=False):
    if o == d:
        continue
    cands = [ln for ln, p in pos.items() if o in p and d in p]
    if not cands:
        unassigned += f
        continue
    assigned += f
    for ln in cands:
        buckets[ln][(o, d)] = buckets[ln].get((o, d), 0.0) + f / len(cands)

print(f"coverage (either order): {assigned / (assigned + unassigned):.3%}")

mats = {}
back = fwd = 0.0
for ln, seq in canon.items():
    if not buckets[ln]:
        continue
    df = pd.DataFrame([(o, d, v) for (o, d), v in buckets[ln].items()],
                      columns=["orig", "dest", "flow"])
    M = C.to_matrix(df, seq)
    mats[ln] = (M, seq)
    n = len(seq)
    i, j = np.indices((n, n))
    back += float(M[i > j].sum())
    fwd += float(M[i < j].sum())
true_back = back / (back + fwd)
print(f"true backward share on canonical sequences: {true_back:.3%}")

rows = []
for bw in [0.0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0]:
    Ps, As = [], []
    ov, h1 = [], []
    for ln, (M, seq) in mats.items():
        B, A = M.sum(axis=1), M.sum(axis=0)
        if B.sum() < 0.5:
            continue
        P = C.ipf_od(B, A, backward_weight=bw)
        Ps.append(P.ravel()); As.append(M.ravel())
        t = C.topk_metrics(P, M)
        if np.isfinite(t["top5_overlap"]):
            ov.append(t["top5_overlap"]); h1.append(t["top1_hit"])
    m = C.cell_metrics(np.concatenate(Ps), np.concatenate(As))
    rows.append({"backward_weight": bw, "wmape": round(m["wmape"], 4),
                 "r2": round(m["r2"], 4),
                 "top5_overlap": round(float(np.mean(ov)), 4),
                 "top1_hit": round(float(np.mean(h1)), 4)})

sw = pd.DataFrame(rows)
sw.to_csv(HERE / "backward_weight_sweep_fair.csv", index=False)
print(sw.to_string(index=False))
best = sw.loc[sw.wmape.idxmin()]
print("\nbest by WMAPE:", dict(best))
print("best by top5 :", dict(sw.loc[sw.top5_overlap.idxmax()]))
json.dump({"true_backward_share": true_back, "sweep": rows},
          open(HERE / "sweep_fair.json", "w"), indent=1)
