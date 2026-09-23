"""Fact-check the numbers the story asserts, against the shipped pack.

lib/strings.js makes four numeric claims that no build step recomputes:
the simulated (imputed) share by year, the 1T's simulated share, the
pandemic decline in Berkeley, and the BART validation's accuracy. This
script re-derives each one from public/data/pack and prints a verdict,
so a pack rebuild cannot silently invalidate the copy. The BART figure is
read from scripts/bart_validation/displayed.json when that study has been
run; otherwise the published values in its REPORT.md are used.

    python3 scripts/factcheck_story.py
"""
import json
import re
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PACK = HERE.parent / "public" / "data" / "pack"
BOUNDARY_JS = HERE.parent / "components" / "story" / "berkeley-boundary.js"
BART_JSON = HERE / "bart_validation" / "displayed.json"

# The story's scrub anchor for the pandemic passage (steps.js WEEKS.apr2020)
# and the recovery baseline every percentage is measured against.
BASELINE_WEEK = "2020-02-03"
PANDEMIC_WEEK = "2020-04-20"

# The same box components/story/prepare.js calls CAMPUS.
CAMPUS = {"south": 37.866, "north": 37.8765, "west": -122.2665, "east": -122.2505}

YEARS = [str(y) for y in range(2019, 2027)]


def load():
    meta = json.loads((PACK / "meta.json").read_text())
    weeks = meta["weeks"]
    w = len(weeks)
    groups = meta["stop_groups"]
    stop = np.fromfile(PACK / "stopgroup_weeks.u16", dtype="<u2").reshape(groups["n"], w, 4)
    scales = np.array(meta["scales"]["stopgroup"], dtype=np.float64)
    boardings = stop[:, :, 0] * scales[0] + stop[:, :, 1] * scales[1]
    imputed = stop[:, :, 1] * scales[1]

    names = meta["route_weeks"]["routes"]
    rscale = np.array(meta["route_weeks"]["scale"], dtype=np.float64)
    route = np.fromfile(PACK / "route_weeks.u16", dtype="<u2").reshape(len(names), w, 2)
    route_real = route[:, :, 0] * rscale[:, None]
    route_imp = route[:, :, 1] * rscale[:, None]
    return meta, weeks, boardings, imputed, names, route_real, route_imp, groups


def boundary():
    pairs = re.findall(r"\[(-?\d+\.\d+),(-?\d+\.\d+)\]", BOUNDARY_JS.read_text())
    return [(float(a), float(b)) for a, b in pairs]


def inside(poly, lat, lon):
    hit = False
    for i in range(len(poly)):
        y1, x1 = poly[i]
        y2, x2 = poly[(i + 1) % len(poly)]
        if (y1 > lat) != (y2 > lat):
            xx = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < xx:
                hit = not hit
    return hit


def year_share(imputed, boardings, keys, year, weeks):
    idx = [i for i, w in enumerate(weeks) if w[:4] == year]
    im = imputed[keys][:, idx].sum()  # adds up all imputed
    bd = boardings[keys][:, idx].sum()# adds up all boardings
    return 100 * im / bd if bd else float("nan")


def main():
    meta, weeks, boardings, imputed, route_names, route_real, route_imp, groups = load()
    lat = np.array(groups["lat"])
    lon = np.array(groups["lon"])
    poly = boundary()
    berkeley = [i for i in range(groups["n"]) if inside(poly, lat[i], lon[i])] 
    campus = [
        i for i in range(groups["n"])
        if CAMPUS["south"] < lat[i] < CAMPUS["north"]
        and CAMPUS["west"] < lon[i] < CAMPUS["east"]
    ]

    print("A. story.one.simulated — share of boardings that is simulated")
    print("   systemwide, by year (stop-group boardings):")
    for year in YEARS:
        print(f"     {year}: {year_share(imputed, boardings, range(groups['n']), year, weeks):5.2f}%")
    print("   Berkeley, by year:")
    for year in YEARS:
        print(f"     {year}: {year_share(imputed, boardings, berkeley, year, weeks):5.2f}%") # creates bounding box
    print()

    print("   route 1T, by year (route boardings; 2020 starts in August):")
    row = route_names.index("1T")
    for year in YEARS:
        idx = [i for i, w in enumerate(weeks) if w[:4] == year]
        real = route_real[row, idx].sum()
        imp = route_imp[row, idx].sum()
        if real + imp == 0:
            continue
        print(f"     {year}: {100 * imp / (real + imp):5.2f}%  ({real + imp:,.0f} boardings)")
    print("   the pre-Tempo route '1' it replaced, 2019:")
    row = route_names.index("1")
    idx = [i for i, w in enumerate(weeks) if w[:4] == "2019"]
    real, imp = route_real[row, idx].sum(), route_imp[row, idx].sum()
    print(f"     2019: {100 * imp / (real + imp):5.2f}%  ({real + imp:,.0f} boardings)")
    print()

    print("   routes new in the Aug 2025 era (absent from Dec 2024), 2025-26:")
    place = {i: name for i, name in enumerate(meta["route_names"])}
    era_set = lambda era: {place[i] for lst in meta["routes_by_era"][era] for i in lst}
    new = era_set("Aug2025") - era_set("Dec2024") # gets realign directly
    # pulls 211, 22, 231, 27, 281, 30, 31, 627, 633, 639, 678, 689, 72L, 9
    # from https://www.actransit.org/realign/service-changes
    # new lines are 9, 22, 27, 30, 31, 72L, 211, 231, 281, 627, 639, 633, 678, 689
    idx = [i for i, w in enumerate(weeks) if w[:4] in ("2025", "2026")]
    for name in sorted(new):
        if name not in route_names:
            print(f"     {name:<5} not in route_weeks")
            continue
        row = route_names.index(name)
        real, imp = route_real[row, idx].sum(), route_imp[row, idx].sum()
        print(f"     {name:<5} {100 * imp / (real + imp) if real + imp else float('nan'):6.1f}%  ({real + imp:,.0f} boardings)")
    print()

    print("B. story.one.pandemic — boardings vs the Feb 2020 baseline week")
    base = weeks.index(BASELINE_WEEK)
    week = weeks.index(PANDEMIC_WEEK)
    lo, hi = weeks.index("2020-03-02"), weeks.index("2020-08-03")
    for label, keys in (("Berkeley", berkeley), ("campus box", campus),
                        ("systemwide", range(groups["n"]))):
        series = boardings[keys].sum(axis=0)
        trough = lo + int(np.argmin(series[lo:hi]))
        print(f"   {label:<11} {PANDEMIC_WEEK}: {100 * (1 - series[week] / series[base]):5.1f}% below baseline"
              f"   trough {weeks[trough]}: {100 * (1 - series[trough] / series[base]):5.1f}% below")
    print("   deepest single campus stop (>=200 baseline boardings):")
    rows = []
    for i in campus:
        b = boardings[i, base]
        if b < 200:
            continue
        t = lo + int(np.argmin(boardings[i, lo:hi]))
        rows.append((100 * (1 - boardings[i, t] / b), groups["name"][i]))
    for pct, name in sorted(rows, reverse=True)[:3]:
        print(f"     {pct:5.1f}% below  {name}")
    print()

    print("C. story.two.ipfAccuracy — BART validation of the O-D inference")
    if BART_JSON.exists():
        out = json.loads(BART_JSON.read_text())
        wmape = out["wmape_displayed"]
        print(f"   from {BART_JSON.name} (run_all.py output):")
        print(f"     WMAPE on displayed cells: {wmape:.3f} -> {100 * (1 - wmape):.1f}% (1 - WMAPE)")
        print(f"     within +/-50%: {100 * out['within_50pct']:.1f}%")
        print(f"     predicted top-5 recovers {100 * out['recall_of_true_top5_flow']:.1f}% of true top-5 flow")
    else:
        print("   displayed.json absent; using scripts/bart_validation/REPORT.md headline:")
        print("     WMAPE on displayed cells 0.219 -> 78.1% (1 - WMAPE)")
        print("     within +/-50%: 84.6%")
        print("     top-5 overlap: 0.845; predicted top-5 recovers 97.1% of true top-5 flow")
    print("   NOTE: network-wide BART 2025 (50 stations), summed-marginal branch only,")
    print("         and a ceiling: AC Transit marginals are noisier than fare gates.")


if __name__ == "__main__":
    main()
