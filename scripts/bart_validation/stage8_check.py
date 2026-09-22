"""Stage 8: is unconstrained IPF (variant b) literally the gravity baseline?"""
import numpy as np
import common as C

truth = C.load_truth()
stations = sorted(set(truth.orig) | set(truth.dest))
six = {s: i for i, s in enumerate(stations)}
N = len(stations)
F = np.zeros((N, N))
for o, d, f in truth[["orig", "dest", "flow"]].itertuples(index=False):
    if o != d:
        F[six[o], six[d]] += f
B, A = F.sum(axis=1), F.sum(axis=0)
P = C.ipf_unconstrained(B, A)
G = C.gravity(B, A)
den = max(P.sum(), 1e-9)
print("max |ipf - gravity| / total:", float(np.abs(P - G).max() / den))
print("sum |ipf - gravity| / total:", float(np.abs(P - G).sum() / den))
print("corr:", float(np.corrcoef(P.ravel(), G.ravel())[0, 1]))
print("ipf wmape :", round(C.cell_metrics(P, F)["wmape"], 5))
print("grav wmape:", round(C.cell_metrics(G, F)["wmape"], 5))
