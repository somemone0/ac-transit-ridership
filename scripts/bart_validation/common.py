"""Shared: the project's ipf_od, assignment of true O-D to line-directions, metrics."""
import json
import numpy as np
import pandas as pd
from pathlib import Path
from scipy.stats import spearmanr

HERE = Path(__file__).resolve().parent


# ---- verbatim from scripts/build_commute_pack.py:175 ----
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


def ipf_unconstrained(B, A, max_iter=200, tol=1e-4):
    """Variant (b): uniform seed, zero diagonal, no sequence mask."""
    n = len(B)
    B = np.asarray(B, float).copy()
    A = np.asarray(A, float).copy()
    total = (B.sum() + A.sum()) / 2
    if total <= 0:
        return np.zeros((n, n))
    B *= total / B.sum()
    A *= total / A.sum()
    T = np.ones((n, n))
    np.fill_diagonal(T, 0.0)
    for _ in range(max_iter):
        rs = T.sum(axis=1)
        T = T * np.divide(B, rs, out=np.zeros_like(B), where=rs > 0)[:, None]
        cs = T.sum(axis=0)
        T = T * np.divide(A, cs, out=np.zeros_like(A), where=cs > 0)[None, :]
        if max(np.abs(T.sum(axis=1) - B).max(),
               np.abs(T.sum(axis=0) - A).max()) < tol:
            break
    return T


def gravity(B, A, mask=None):
    """Naive baseline: T[i][j] ~ B[i]*A[j], zero diagonal, scaled to total."""
    B = np.asarray(B, float)
    A = np.asarray(A, float)
    total = (B.sum() + A.sum()) / 2
    T = np.outer(B, A).astype(float)
    np.fill_diagonal(T, 0.0)
    if mask is not None:
        T = T * mask
    s = T.sum()
    return T * (total / s) if s > 0 else T


# ---- per-trip path, verbatim from scripts/build_commute_pack.py:256-325 ----
MIN_OD_TRIPS = 20      # fewer screened trips than this -> summed fit, no holdout
TRIP_PASSES = (3, 8)   # candidate pass counts for the per-trip fit


def balance(B, A):
    """Scale ons and offs to their mean total along the last axis (TCRP 113's
    proportional balancing, which leaves average trip length unchanged)."""
    tb, ta = B.sum(-1, keepdims=True), A.sum(-1, keepdims=True)
    target = (tb + ta) / 2
    return (B * np.divide(target, tb, out=np.zeros_like(tb), where=tb > 0),
            A * np.divide(target, ta, out=np.zeros_like(ta), where=ta > 0))


def ipf_batch(T, rows, cols, max_iter=100, tol=1e-4):
    """Biproportional fit of seeds T (..., n, n) to rows/cols (..., n), in place."""
    for _ in range(max_iter):
        rs = T.sum(-1)
        T *= np.divide(rows, rs, out=np.zeros_like(rs), where=rs > 0)[..., :, None]
        cs = T.sum(-2)
        T *= np.divide(cols, cs, out=np.zeros_like(cs), where=cs > 0)[..., None, :]
        if np.abs(T.sum(-1) - rows).max() < tol:
            break
    return T


def trip_bases(B, A, passes, backward=1e-3):
    """Base matrix after each of 1..max(passes) per-trip passes: fit every
    trip's own counts against the base, rebuild the base from the sum (Ji,
    Mishalani & McCord 2014). The small upstream weight keeps trips with
    locally inconsistent counts solvable; only forward mass carries over."""
    n = B.shape[1]
    B, A = balance(B, A)
    i, j = np.indices((n, n))
    fwd = (i < j).astype(float)
    up = backward / fwd.sum() * (i > j)
    base, out = fwd, {}
    for k in range(1, max(passes) + 1):
        seed = np.broadcast_to(base / base.sum() + up, (len(B), n, n)).copy()
        base = ipf_batch(seed, B, A).sum(0) * fwd
        if k in passes:
            out[k] = base
    return out


def rake(base, boardings, alightings, backward=1e-3):
    """Fit a base structure to boarding/alighting totals."""
    n = len(boardings)
    b, a = balance(np.asarray(boardings, float), np.asarray(alightings, float))
    i, j = np.indices((n, n))
    seed = base + base.mean() * (backward * (i > j) + 1e-9 * (i < j))
    return ipf_batch(seed, b, a, max_iter=500, tol=1e-6)


def holdout_rmse(T, B, A):
    """Predict each trip's alightings from its boardings, B @ P(alight | board)."""
    rs = T.sum(1, keepdims=True)
    P = np.divide(T, rs, out=np.zeros_like(T), where=rs > 0)
    B, A = balance(B, A)
    return float(np.sqrt(((B @ P - A) ** 2).mean()))


def choose_passes(B, A, day):
    """0 (summed fit) or a per-trip pass count, by odd/even-day holdout."""
    folds = (day % 2 == 0, day % 2 == 1)
    if len(B) < MIN_OD_TRIPS or min(f.sum() for f in folds) < 5:
        return 0
    score = dict.fromkeys((0,) + TRIP_PASSES, 0.0)
    for train in folds:
        test = ~train
        b, a = B[train].sum(0), A[train].sum(0)
        score[0] += holdout_rmse(ipf_od(b, a), B[test], A[test])
        for k, base in trip_bases(B[train], A[train], TRIP_PASSES).items():
            score[k] += holdout_rmse(rake(base, b, a), B[test], A[test])
    return min(score, key=score.get)


def load_truth():
    m = pd.read_parquet(HERE / "od_am_matrix.parquet")
    m["orig"] = m.orig.astype(str)
    m["dest"] = m.dest.astype(str)
    return m


def load_lines():
    return json.loads((HERE / "line_sequences.json").read_text())


def assign_to_lines(truth, lines):
    """Split each true O-D pair equally across line-directions serving it in order.

    A line-direction L serves (o,d) if both are in L's sequence and
    idx_L(o) < idx_L(d). Trips are divided equally among all qualifying
    line-directions (no service-frequency weighting).
    Returns: {line: DataFrame(orig,dest,flow)}, plus coverage stats.
    """
    pos = {ln: {s: i for i, s in enumerate(seq)} for ln, seq in lines.items()}
    buckets = {ln: {} for ln in lines}
    assigned = unassigned = 0.0
    n_unassigned_pairs = 0
    for o, d, f in truth[["orig", "dest", "flow"]].itertuples(index=False):
        if o == d:
            continue
        cands = [ln for ln, p in pos.items()
                 if o in p and d in p and p[o] < p[d]]
        if not cands:
            unassigned += f
            n_unassigned_pairs += 1
            continue
        assigned += f
        share = f / len(cands)
        for ln in cands:
            buckets[ln][(o, d)] = buckets[ln].get((o, d), 0.0) + share
    out = {}
    for ln, d in buckets.items():
        if not d:
            continue
        out[ln] = pd.DataFrame(
            [(o, dd, v) for (o, dd), v in d.items()],
            columns=["orig", "dest", "flow"])
    stats = {"assigned": assigned, "unassigned": unassigned,
             "coverage": assigned / (assigned + unassigned),
             "unassigned_pairs": n_unassigned_pairs}
    return out, stats


def to_matrix(df, seq):
    ix = {s: i for i, s in enumerate(seq)}
    M = np.zeros((len(seq), len(seq)))
    for o, d, f in df[["orig", "dest", "flow"]].itertuples(index=False):
        M[ix[o], ix[d]] += f
    return M


# ---------------- metrics ----------------
def gini(x):
    x = np.asarray(x, float)
    x = x[x >= 0]
    if x.sum() <= 0:
        return float("nan")
    x = np.sort(x)
    n = len(x)
    return float((2 * np.arange(1, n + 1) - n - 1).dot(x) / (n * x.sum()))


def top_share(x, frac=0.10):
    x = np.sort(np.asarray(x, float))[::-1]
    if x.sum() <= 0:
        return float("nan")
    k = max(1, int(round(len(x) * frac)))
    return float(x[:k].sum() / x.sum())


def topk_metrics(P, Aa, k=5):
    """Per-origin top-k agreement between predicted P and actual Aa."""
    n = P.shape[0]
    ov, hit1, rhos, used = [], [], [], 0
    for i in range(n):
        a, p = Aa[i], P[i]
        if a.sum() <= 0 or p.sum() <= 0:
            continue
        nz = int((a > 0).sum())
        if nz < 2:
            continue
        kk = min(k, nz)
        ta = set(np.argsort(-a)[:kk])
        tp = set(np.argsort(-p)[:kk])
        ov.append(len(ta & tp) / kk)
        hit1.append(int(np.argmax(a) == np.argmax(p)))
        m = a > 0
        if m.sum() >= 3:
            r = spearmanr(a[m], p[m]).statistic
            if np.isfinite(r):
                rhos.append(r)
        used += 1
    return {
        "top5_overlap": float(np.mean(ov)) if ov else float("nan"),
        "top1_hit": float(np.mean(hit1)) if hit1 else float("nan"),
        "spearman": float(np.mean(rhos)) if rhos else float("nan"),
        "n_origins": used,
    }


def cell_metrics(P, Aa):
    p, a = P.ravel(), Aa.ravel()
    tot = a.sum()
    diff = p - a
    ae = np.abs(diff).sum()
    over = diff[diff > 0].sum()
    under = -diff[diff < 0].sum()
    ss_res = float(((a - p) ** 2).sum())
    ss_tot = float(((a - a.mean()) ** 2).sum())
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    if p.std() > 0 and a.std() > 0:
        pear = float(np.corrcoef(p, a)[0, 1])
    else:
        pear = float("nan")
    return {
        "wmape": float(ae / tot) if tot > 0 else float("nan"),
        "r2": float(r2),
        "pearson": pear,
        "over_share": float(over / tot) if tot > 0 else float("nan"),
        "under_share": float(under / tot) if tot > 0 else float("nan"),
        "total_flow": float(tot),
    }


def length_bias(P, Aa, edges=(1, 2, 3, 5, 8, 12, 100)):
    """predicted/actual ratio bucketed by station separation j-i (forward pairs)."""
    n = P.shape[0]
    i, j = np.indices((n, n))
    sep = j - i
    rows = []
    lo = 1
    for hi in edges[1:]:
        m = (sep >= lo) & (sep < hi)
        a, p = Aa[m].sum(), P[m].sum()
        rows.append({"sep_lo": lo, "sep_hi": hi - 1,
                     "actual": float(a), "pred": float(p),
                     "ratio": float(p / a) if a > 0 else float("nan")})
        lo = hi
    return rows
