"""Build buslanes.json: AC Transit-area bus lanes added 2019-2026, and bus
speeds on them before and after.

Lanes. Geometry comes from OpenStreetMap (ways tagged busway / bus:lanes /
lanes:bus / psv lanes, extracted into vis/data/osm_buslanes.json). Install
dates come from the agencies and press, cited per lane below; OSM has no
reliable dates. Lanes found in OSM with no install date we could source are
listed separately and not analysed.

Matching. A corridor piece belongs to a lane when at least MATCH_SHARE of the
points along it lie within MATCH_M of the lane's OSM geometry, so cross streets
that only touch the lane at an intersection are left out.

Speeds. Monthly all-day bus speed from speed_<era>.u16 (scripts/build_speed_pack.py):
a lane's month is sum(weight) / sum(weight / mph) over its pieces, the same
distance-over-time average used for the whole network. Before is the WINDOW
months ending the month before the install month; after is the WINDOW months
starting the month after (fewer when the data ends sooner). The install month
itself is left out of both.

The network's change over the same two windows is reported beside each lane.
It is a control, not a correction: 2020 traffic fell sharply everywhere, so a
lane whose buses sped up by about as much as the network's did cannot be
credited with the difference.

Usage: python3 scripts/build_buslanes_pack.py
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_commute_pack import PACK, VIS  # noqa: E402

WINDOW = 12
MATCH_M = 15.0
MATCH_SHARE = 0.7
STEP_M = 8.0
KX = 111320.0 * math.cos(math.radians(37.8))
KY = 111320.0

LANES = [
    {
        "id": "tempo",
        "name": "International Blvd. (Tempo)",
        "city": "Oakland and San Leandro",
        "extent": "Median bus lanes from 14th Ave. to the San Leandro border, used by the 1T",
        "installed": "2020-08",
        "installed_label": "Aug. 9, 2020 (Tempo opened)",
        "osm_names": ["International Boulevard", "East 14th Street"],
        "note": "The 1T replaced the local route 1 the same day, with fewer stops, so faster buses here "
                "reflect the new service as well as the lanes. Quick-build delineators were added along the "
                "lanes later, completed October 2024.",
        "sources": [
            {"title": "Tempo (bus rapid transit), Wikipedia", "url": "https://en.wikipedia.org/wiki/Tempo_(bus_rapid_transit)"},
            {"title": "Quick Build International Blvd., AC Transit", "url": "https://www.actransit.org/quick-builds/international-qb"},
        ],
    },
    {
        "id": "broadway",
        "name": "Broadway",
        "city": "Oakland",
        "extent": "Transit-only lanes from 11th St. to 20th St., downtown",
        "installed": "2020-08",
        "installed_label": "August 2020",
        "osm_names": ["Broadway"],
        "note": "",
        "sources": [
            {"title": "Broadway Bus Lanes & Pedestrian Safety Improvements, City of Oakland",
             "url": "https://www.oaklandca.gov/Government/Oakland-Improvement-Projects/Broadway-Bus-Lanes-Pedestrian-Safety-Improvements"},
            {"title": "Red Carpet Lanes in Oakland, Streetsblog SF (Aug. 18, 2020)",
             "url": "https://sf.streetsblog.org/2020/08/18/red-carpet-lanes-in-oakland"},
        ],
    },
    {
        "id": "durant",
        "name": "Durant Ave.",
        "city": "Berkeley",
        "extent": "Eastbound bus-only lane from Fulton St. to College Ave.",
        "installed": "2025-06",
        "installed_label": "Complete by June 2025",
        "osm_names": ["Durant Avenue"],
        "note": "AC Transit reports construction complete as of June 2025; parts of the lane may have been in "
                "use earlier during the Southside project.",
        "sources": [
            {"title": "Durant Avenue Project, AC Transit", "url": "https://www.actransit.org/quick-builds/durant-ave"},
            {"title": "Bus-only lane coming to Durant Avenue, Berkeleyside (March 22, 2024)",
             "url": "https://www.berkeleyside.org/2024/03/22/berkeley-bus-lane-durant-ac-transit"},
        ],
    },
    {
        "id": "bancroft",
        "name": "Bancroft Way",
        "city": "Berkeley",
        "extent": "Bus lane repainted and extended to run from College Ave. to Shattuck Ave.",
        "installed": "2025-10",
        "installed_label": "Oct. 1, 2025 (Southside project ribbon-cutting)",
        "osm_names": ["Bancroft Way"],
        "note": "Bancroft already had a bus lane; this was an extension. Only seven months of data follow it.",
        "sources": [
            {"title": "Southside: Now safer and easier to walk, bike, take transit, City of Berkeley",
             "url": "https://berkeleyca.gov/community-recreation/news/southside-now-safer-and-easier-walk-bike-take-transit"},
            {"title": "Southside Complete Streets Project, City of Berkeley",
             "url": "https://berkeleyca.gov/your-government/our-work/capital-projects/southside-complete-streets-project"},
        ],
    },
]

# In OSM, but no install date found; listed, not analysed.
UNDATED = [
    {"name": "11th St. and 12th St.", "city": "Oakland", "osm_names": ["11th Street", "12th Street"],
     "note": "Downtown one-way pair; no install date found."},
    {"name": "40th St.", "city": "Emeryville", "osm_names": ["40th Street"],
     "note": "Emeryville's 40th Street Multimodal Project was still in environmental review in November 2025; "
             "the short stretch mapped in OSM could not be dated."},
    {"name": "West Atlantic Ave.", "city": "Alameda", "osm_names": ["West Atlantic Avenue"],
     "note": "No install date found."},
]


def xy(lat, lon):
    return (lon * KX, lat * KY)


def lane_tree(ways):
    points = []
    for way in ways:
        geom = way.get("geometry", [])
        for a, b in zip(geom, geom[1:]):
            pa, pb = np.array(xy(a["lat"], a["lon"])), np.array(xy(b["lat"], b["lon"]))
            steps = max(1, int(np.hypot(*(pb - pa)) / 3))
            for k in range(steps + 1):
                points.append(pa + (pb - pa) * (k / steps))
    return cKDTree(np.array(points)) if points else None


def lane_km(ways):
    total = 0.0
    for way in ways:
        geom = way.get("geometry", [])
        total += sum(math.hypot(*(np.subtract(xy(b["lat"], b["lon"]), xy(a["lat"], a["lon"]))))
                     for a, b in zip(geom, geom[1:]))
    return total / 1000


def samples(coords):
    pts = [np.array(xy(*coords[0]))]
    for a, b in zip(coords, coords[1:]):
        pa, pb = np.array(xy(*a)), np.array(xy(*b))
        steps = max(1, int(np.hypot(*(pb - pa)) / STEP_M))
        pts.extend(pa + (pb - pa) * (k / steps) for k in range(1, steps + 1))
    return np.array(pts)


def match(tree, corridors):
    if tree is None:
        return []
    out = []
    for index, feature in enumerate(corridors):
        pts = samples(feature["c"])
        if len(pts) < 2 or np.hypot(*(pts[-1] - pts[0])) < 15:
            continue
        dist, _ = tree.query(pts)
        if np.mean(dist <= MATCH_M) >= MATCH_SHARE:
            out.append(index)
    return out


def main():
    osm = json.loads((VIS / "data" / "osm_buslanes.json").read_text())["elements"]
    speed_meta = json.loads((PACK / "speed_meta.json").read_text())
    null = speed_meta["null"]
    eras = {}
    for era, spec in speed_meta["eras"].items():
        corridors = json.loads((PACK / f"corridors_{era}.json").read_text())
        arr = np.fromfile(PACK / spec["file"], dtype="<u2").reshape(spec["n"], len(spec["months"]), 2).astype(float)
        mph = np.where(arr[:, :, 0] == null, np.nan, arr[:, :, 0] / 10)
        weight = np.where(arr[:, :, 1] == null, 0, arr[:, :, 1] * spec["scale"])
        eras[era] = {"corridors": corridors, "months": spec["months"], "mph": mph, "weight": weight}
    months = sorted(m for e in eras.values() for m in e["months"])

    def series(pieces_by_era):
        out = {}
        for era, e in eras.items():
            idx = pieces_by_era.get(era, [])
            for m, month in enumerate(e["months"]):
                mph, w = e["mph"][idx, m], e["weight"][idx, m]
                ok = np.isfinite(mph) & (w > 0)
                out[month] = (w[ok].sum(), (w[ok] / mph[ok]).sum()) if ok.any() else (0.0, 0.0)
        return out

    def window_speed(s, chosen):
        w = sum(s[m][0] for m in chosen)
        t = sum(s[m][1] for m in chosen)
        return w / t if t > 0 else None

    network = series({era: list(range(len(e["corridors"]))) for era, e in eras.items()})
    lanes_out = []
    for lane in LANES:
        ways = [el for el in osm if el.get("tags", {}).get("name") in lane["osm_names"]]
        tree = lane_tree(ways)
        pieces = {era: match(tree, e["corridors"]) for era, e in eras.items()}
        s = series(pieces)
        at = months.index(lane["installed"])
        before = [m for m in months[max(0, at - WINDOW):at] if s[m][1] > 0]
        after = [m for m in months[at + 1:at + 1 + WINDOW] if s[m][1] > 0]
        b, a = window_speed(s, before), window_speed(s, after)
        nb, na = window_speed(network, before), window_speed(network, after)
        record = {k: lane[k] for k in ("id", "name", "city", "extent", "installed", "installed_label", "note", "sources")}
        record.update({
            "osm_km": round(lane_km(ways), 2),
            "pieces": {era: len(v) for era, v in pieces.items()},
            "monthly": [{"month": m, "mph": round(s[m][0] / s[m][1], 2) if s[m][1] > 0 else None} for m in months],
            "before": {"from": before[0] if before else None, "to": before[-1] if before else None,
                       "months": len(before), "mph": round(b, 2) if b else None},
            "after": {"from": after[0] if after else None, "to": after[-1] if after else None,
                      "months": len(after), "mph": round(a, 2) if a else None},
            "network_before": round(nb, 2) if nb else None,
            "network_after": round(na, 2) if na else None,
        })
        lanes_out.append(record)
        change = f"{(a / b - 1) * 100:+.1f}%" if a and b else "n/a"
        nchange = f"{(na / nb - 1) * 100:+.1f}%" if na and nb else "n/a"
        print(f"{lane['name']:30} OSM {record['osm_km']:5.2f} km, pieces {record['pieces']}; "
              f"before {record['before']['mph']} ({len(before)} mo) after {record['after']['mph']} ({len(after)} mo) "
              f"lane {change} network {nchange}")

    undated = []
    for lane in UNDATED:
        ways = [el for el in osm if el.get("tags", {}).get("name") in lane["osm_names"]]
        undated.append({**{k: lane[k] for k in ("name", "city", "note")}, "osm_km": round(lane_km(ways), 2)})

    out = {
        "window": WINDOW,
        "months": months,
        "network": [{"month": m, "mph": round(network[m][0] / network[m][1], 2) if network[m][1] > 0 else None}
                    for m in months],
        "lanes": lanes_out,
        "undated": undated,
        "osm_note": "Lane geometry © OpenStreetMap contributors (ODbL), extracted September 2026.",
    }
    (PACK / "buslanes.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote buslanes.json ({(PACK / 'buslanes.json').stat().st_size / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
