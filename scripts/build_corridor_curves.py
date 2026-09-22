"""Add smooth Bezier geometry to the packed corridors: corridors_<era>.json.

The corridor pieces are already cut where the answer changes -- at stop groups
and where routes join or leave (see vis/build_corridor_graph.py) -- but their
geometry is raw OSM road centreline. Drawn as-is the network looks rough: the
lines jog wherever OSM digitised a kink, corners are hard, and the pieces do
not meet. Only 44% of piece ends coincide with another piece's end; the rest
stop a few metres short, overlap, or sit either side of a carriageway fold, so
every join draws as a bead or a notch.

This adds a `b` field to each piece -- a chain of cubic Bezier segments -- and
leaves everything else alone. The pieces keep their order and their `c`
polyline, so every array indexed by corridor (section loads, the service
months, corridor_base, pack_index.json) stays valid with no rebuild.

Per era:
  1. Joins. Piece ends within SNAP_M of each other are clustered, closest
     pairs first, and moved to one shared point: the stop-group node's own
     position when the cluster holds one (so node markers stay on the line),
     else the members' mean. Both ends of one piece never share a cluster, so
     a short piece cannot collapse to a point.
  2. Through-lines. At each cluster, ends are paired as a street carrying on
     through the node: the pair whose directions leaving the node are closest
     to opposite, within THROUGH_DEG of straight, taken best-first (shared
     routes break ties). A paired end borrows the partner's neighbouring point
     when its tangent is computed, so both sides get the same tangent and the
     curve passes through the node without a kink -- the chunk boundary shows
     only as a change of colour and width. Unpaired ends (terminals, a branch
     leaving the street) keep the direction of their own first segment.
  3. Smoothing. Interior vertices are thinned by Douglas-Peucker at
     SIMPLIFY_M, which removes digitising jitter but keeps real bends. Each
     remaining vertex gets the tangent bisecting its two segments, and each
     segment becomes a cubic whose handles run along those tangents, a third
     of the segment long but never more than HANDLE_M. That keeps the curve
     inside the road's corridor: straight runs stay straight, bends turn
     smoothly, and a right-angle turn becomes a corner of bounded radius
     instead of a bulge.

`b` is flat: [lat0, lon0, then per segment c1lat, c1lon, c2lat, c2lon, lat, lon]
at 6 decimals. Run after anything that rewrites corridors_<era>.json; running
it again recomputes `b` from `c`.

Usage: python3 scripts/build_corridor_curves.py
"""
import json
import math
import os
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

NEXT = Path(__file__).resolve().parent.parent
PACK = Path(os.environ.get("ACPRA_PACK", NEXT / "public" / "data" / "pack"))
ERAS = ["Nov2019", "Dec2024", "Aug2025"]

SNAP_M = 15.0        # piece ends closer than this are one join
TRIM_M = 3.0         # interior vertices this close to a moved end are dropped
SIMPLIFY_M = 4.0     # Douglas-Peucker tolerance for road-centreline jitter
HANDLE_M = 12.0      # longest control handle: bounds how wide a corner swings
THROUGH_DEG = 40.0   # an end pair within this of straight is a through-line
LEAD_M = 15.0        # how far along a piece its leaving direction is measured
SHORT_M = 12.0       # pieces shorter than this may not turn back on themselves
LAT0 = 37.8
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 111320.0


def to_xy(latlon):
    return np.array([[p[1] * KX, p[0] * KY] for p in latlon], dtype=np.float64)


def to_latlon(x, y):
    return round(y / KY, 6), round(x / KX, 6)


def simplify(points, tol):
    """Douglas-Peucker keeping both ends."""
    if len(points) <= 2:
        return points
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = points[i], points[j]
        ab = b - a
        seg = np.hypot(*ab)
        rel = points[i + 1:j] - a
        if seg < 1e-9:
            dist = np.hypot(rel[:, 0], rel[:, 1])
        else:
            dist = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / seg
        k = int(np.argmax(dist))
        if dist[k] > tol:
            mid = i + 1 + k
            keep[mid] = True
            stack.append((i, mid))
            stack.append((mid, j))
    return points[keep]


def lead_point(points, from_end):
    """A point about LEAD_M along the piece from one end, for its direction."""
    seq = points if from_end == 0 else points[::-1]
    start, travelled = seq[0], 0.0
    for a, b in zip(seq, seq[1:]):
        step = np.hypot(*(b - a))
        if travelled + step >= LEAD_M and step > 0:
            return a + (b - a) * ((LEAD_M - travelled) / step)
        travelled += step
    return seq[-1] if np.hypot(*(seq[-1] - start)) > 0 else start + np.array([1e-3, 0])


def cluster_ends(ends, nodes_xy):
    """Union ends into joins, closest pairs first, never joining a piece to itself."""
    xy = np.array([e["xy"] for e in ends])
    parent = list(range(len(ends)))
    members = [{e["piece"]} for e in ends]

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    pairs = sorted(cKDTree(xy).query_pairs(SNAP_M, output_type="ndarray").tolist(),
                   key=lambda p: np.hypot(*(xy[p[0]] - xy[p[1]])))
    for i, j in pairs:
        ri, rj = find(i), find(j)
        if ri == rj or members[ri] & members[rj]:
            continue
        parent[rj] = ri
        members[ri] |= members[rj]

    groups = defaultdict(list)
    for i in range(len(ends)):
        groups[find(i)].append(i)

    node_tree = cKDTree(nodes_xy) if len(nodes_xy) else None
    for idx in groups.values():
        pts = xy[idx]
        centre = pts.mean(axis=0)
        position = centre
        if node_tree is not None:
            # a stop-group node is drawn on the line, so the join moves to it
            dist, k = node_tree.query(pts)
            exact = dist < 0.5
            if exact.any():
                position = nodes_xy[k[np.argmax(exact)]]
        for i in idx:
            ends[i]["join"] = idx
            ends[i]["pos"] = position


def pair_through(ends, pieces):
    """Pair ends at each join into straight-through continuations."""
    done = set()
    for end in ends:
        idx = end["join"]
        key = tuple(idx)
        if key in done or len(idx) < 2:
            continue
        done.add(key)
        cands = []
        for a in range(len(idx)):
            for b in range(a + 1, len(idx)):
                ea, eb = ends[idx[a]], ends[idx[b]]
                da, db = ea["dir"], eb["dir"]
                cos = float(np.dot(da, db))
                if cos > -math.cos(math.radians(THROUGH_DEG)):
                    continue
                ra, rb = pieces[ea["piece"]]["routes"], pieces[eb["piece"]]["routes"]
                shared = len(ra & rb) / max(1, len(ra | rb))
                cands.append((-cos + 0.2 * shared, idx[a], idx[b]))
        taken = set()
        for _, a, b in sorted(cands, reverse=True):
            if a in taken or b in taken:
                continue
            taken.update((a, b))
            ends[a]["partner"], ends[b]["partner"] = b, a


def unit(v):
    n = np.hypot(*v)
    return v / n if n > 1e-9 else np.zeros(2)


def curve(points, before, after):
    """Cubic Bezier chain through points; `before`/`after` are phantom
    neighbours beyond each end (None = keep the end's own segment direction)."""
    n = len(points)
    length = float(np.hypot(*np.diff(points, axis=0).T).sum())
    tangents = []
    for i in range(n):
        prev = points[i - 1] if i > 0 else before
        nxt = points[i + 1] if i < n - 1 else after
        if prev is None:
            t = unit(points[1] - points[0])
        elif nxt is None:
            t = unit(points[-1] - points[-2])
        else:
            t = unit(unit(points[i] - prev) + unit(nxt - points[i]))
            if not t.any():
                t = unit(nxt - prev)
        tangents.append(t)
    if length < SHORT_M:
        # A stub this short (a U-turn hook, a sliver between two cuts) has no
        # room to turn around in: a tangent pointing back against it curls the
        # curve into a knot, so that tangent follows the chord instead. The
        # others are kept, so the stub still joins its neighbours smoothly.
        chord = unit(points[-1] - points[0])
        tangents = [t if np.dot(t, chord) > 0 else chord for t in tangents]
    flat = list(to_latlon(*points[0]))
    for i in range(n - 1):
        a, b = points[i], points[i + 1]
        handle = min(np.hypot(*(b - a)) / 3.0, HANDLE_M)
        c1 = a + tangents[i] * handle
        c2 = b - tangents[i + 1] * handle
        for p in (c1, c2, b):
            flat.extend(to_latlon(*p))
    return flat


def build(era):
    path = PACK / f"corridors_{era}.json"
    features = json.loads(path.read_text())
    nodes = json.loads((PACK / f"nodes_{era}.json").read_text())
    nodes_xy = to_xy([n["p"] for n in nodes if n.get("g", -1) >= 0]) if nodes else np.zeros((0, 2))

    pieces, ends = [], []
    for index, feature in enumerate(features):
        pts = to_xy(feature["c"])
        # drop repeated vertices so every segment has a direction
        keep = np.concatenate([[True], np.hypot(*np.diff(pts, axis=0).T) > 1e-6])
        pts = pts[keep]
        if len(pts) < 2:
            pts = np.vstack([pts[0], pts[0] + [1e-3, 0]])
        pieces.append({"pts": pts, "routes": {r.split("|")[0] for r in feature["r"]}})
        for side in (0, 1):
            anchor = pts[0] if side == 0 else pts[-1]
            ends.append({"piece": index, "side": side, "xy": anchor,
                         "dir": unit(lead_point(pts, side) - anchor), "partner": None})

    cluster_ends(ends, nodes_xy)
    moved = [np.hypot(*(e["pos"] - e["xy"])) for e in ends]
    pair_through(ends, pieces)

    # snap ends, trim interior vertices crowding a moved end, then thin jitter
    shaped = []
    for index, piece in enumerate(pieces):
        start, end = ends[2 * index]["pos"], ends[2 * index + 1]["pos"]
        inner = piece["pts"][1:-1]
        if len(inner):
            far = (np.hypot(*(inner - start).T) > TRIM_M) & (np.hypot(*(inner - end).T) > TRIM_M)
            inner = inner[far]
        pts = np.vstack([start, *inner, end]) if len(inner) else np.vstack([start, end])
        if np.hypot(*(pts[-1] - pts[0])) < 1e-6 and len(pts) == 2:
            pts[1] = pts[1] + [1e-3, 0]
        shaped.append(simplify(pts, SIMPLIFY_M))

    def phantom(end_index):
        partner = ends[end_index]["partner"]
        if partner is None:
            return None
        other = shaped[ends[partner]["piece"]]
        # the partner's first vertex away from the shared join
        return other[1] if ends[partner]["side"] == 0 else other[-2]

    out_vertices = 0
    for index, feature in enumerate(features):
        pts = shaped[index]
        feature["b"] = curve(pts, phantom(2 * index), phantom(2 * index + 1))
        out_vertices += len(pts)
    path.write_text(json.dumps(features, separators=(",", ":")))

    moved = np.array(moved)
    paired = sum(1 for e in ends if e["partner"] is not None)
    joined = sum(1 for e in ends if len(e["join"]) > 1)
    print(f"{era}: {len(features):,} pieces, {sum(len(p['pts']) for p in pieces):,} -> "
          f"{out_vertices:,} vertices; ends joined {joined / len(ends):.0%}, "
          f"through-paired {paired / len(ends):.0%}; ends moved p50 {np.median(moved):.1f} m, "
          f"p99 {np.percentile(moved, 99):.1f} m; {path.stat().st_size / 1e6:.1f} MB")


def main():
    for era in ERAS:
        build(era)


if __name__ == "__main__":
    main()
