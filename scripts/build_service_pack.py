"""Build the service pack: observed speeds and headways per route and per
corridor, from the bus counters, for every month in meta.json.

Everything is read from the raw APC events, not from the published schedule.
Months the commute cache already holds are read from it; the rest are
downloaded one at a time and deleted once read. Each month's result is kept
in vis/data/service_cache, so a rerun only builds what is missing; pass
YYYY-MM arguments to rebuild those months.

Trips. `route_id` in the APC feed is the trip's scheduled start as HHMM, so a
trip slot is (route, bit, start) and one bus-day of it is that slot on a
service date. The distinct slots seen across a month of one day type are that
day type's schedule: counters on ~20 weekdays (or 4-5 Saturdays) see every
slot at least once, which build_capture.py validated against GTFS at a median
0% error. That is the frequency here -- no capture scaling, because a slot is
counted once however many days saw it.

A mid-month signup change leaves two timetables in one month; only starts
seen on at least SLOT_DAYS of the days of their route-direction's best-seen
start in the same hour count toward frequency, which keeps the timetable in force longest.

Directions are assigned per trip from the stops it served -- see
assign_directions() for why the door-flag bit stopped working in 2020.

Speeds. Within one bus-day, the first door-open at each stop is paired with
the first door-open at the next stop the bus reached. Distance is the
along-route distance between the two on the route-direction's section chain
(the polylines the map draws); the pair's time is spread over the sections it
spans in proportion to their length. Corridor and route speeds are
sum(distance) / sum(time), so they include dwell and signal delay -- the speed
a rider actually travels at. Pairs faster than MAX_MPH, slower than MIN_MPH
or longer than MAX_PAIR_S are dropped as GPS or stop-matching glitches, and so
are pairs longer than MAX_PAIR_M that skip stops on the route; neighbouring
stops count at any distance, which keeps no-stop runs like the Bay Bridge.

Passing times. A slot passes a section at the interpolated time between its
two bracketing door-opens; its time for the month is the median across days.

Periods come from the published GTFS schedule of the month's era (Nov 2019,
Dec 2024, Aug 2025), so every month of a signup shares the same hours:
  The profile is scheduled buses in service per hour on a representative
  weekday, and on Saturday and Sunday averaged -- each trip from its first to
  its last stop time. Trip starts alone are nearly flat all day and hide the
  longer trips and extra runs that make a peak. Hours below DAY_SHARE of the
  busiest hour are night. The rest of the day is split into DAY_RUNS steps by
  least squares (optimal segmentation, dynamic programming), and a step is a
  peak when it runs more buses than the steps on both sides of it and more
  than the median daytime hour. A fixed lift cutoff did not survive both
  eras: the 2019 AM peak is only 9% over its day, while a PM peak can be 36%. Everything else in the service day is
  daytime. Weekend: the hours above DAY_SHARE of the weekend's busiest hour.
  The schedule is steadier than a month of counters, whose peaks flickered in
  and out month to month; the price is that the pandemic months (still on the
  Nov 2019 era) keep 2019's peak hours.

Headway = active minutes / trips per direction, averaged over the directions
served, where active minutes are the period's hours in which that route or
corridor has at least one trip. A route that stops at 22:00 is not charged
for the owl hours, and a corridor's night headway is the gap while it runs.
A corridor's directions come from each section's bearing along the corridor,
so a one-way street reads its one direction's headway.

Outputs (public/data/pack/):
  service_meta.json          months: label, era, derived periods, file names
  service_<YYYY-MM>.<hash>.u16
                             u16 [corridor][period][headway, mph], tenths;
                             65535 = no data. Corridors in the order of
                             corridors_<era>.json for the month's era.
  service_routes_<YYYY-MM>.<hash>.json
                             per-route headway / trips / mph

Usage: python3 scripts/build_service_pack.py [--jobs N] [YYYY-MM ...]
"""
import argparse
import csv
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collections import defaultdict  # noqa: E402

import subprocess  # noqa: E402
from concurrent.futures import ProcessPoolExecutor  # noqa: E402

from build_commute_pack import (  # noqa: E402
    BUCKET, CACHE, MATCH_MIN, REPL, MONTH_NAMES, PACK, VIS, era_for, era_sequences, is_holiday,
    publish,
)

FEEDS = {
    "Nov2019": REPL / "gtfs" / "Nov2019",
    "Dec2024": REPL / "gtfs" / "Dec2024" / "Dec2024",
    "Aug2025": REPL / "gtfs" / "Aug2025",
}

# Per-month results, so an interrupted run resumes where it stopped.
MONTH_CACHE = VIS / "data" / "service_cache"

PERIOD_IDS = ["peak", "day", "night", "weekend"]
PERIOD_LABELS = ["Weekday peak", "Weekday daytime", "Weekday night", "Weekend"]
N_HOURS = 32          # extended clock: service days run past midnight
MIN_MPH, MAX_MPH = 1.0, 65.0
MAX_PAIR_M = 5000
MAX_PAIR_S = 60 * 60
EARTH_M = 6371008.8
M_PER_MILE = 1609.344
NULL = 65535
SLOT_DAYS = 0.5       # a trip start must run half as often as its route's most-seen one
TRIP_SHARE = 0.5      # a trip's direction must hold at least half its stops
DAY_SHARE = 0.5       # below half the day's busiest hour is night
DAY_RUNS = 5          # daytime is split into this many steps of service


def polyline_m(coords):
    total = 0.0
    for (la1, lo1), (la2, lo2) in zip(coords, coords[1:]):
        p1, p2 = math.radians(la1), math.radians(la2)
        dp, dl = p2 - p1, math.radians(lo2 - lo1)
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 2 * EARTH_M * math.asin(math.sqrt(a))
    return total


# ------------------------------------------------------------------ periods

def segment(profile, k):
    """Split a profile into k contiguous runs minimising within-run squared
    error. Returns the run boundaries as [(start, end), ...]."""
    n = len(profile)
    csum = np.concatenate([[0], np.cumsum(profile)])
    csq = np.concatenate([[0], np.cumsum(np.square(profile))])

    def cost(i, j):
        m = j - i
        s = csum[j] - csum[i]
        return csq[j] - csq[i] - s * s / m

    best = np.full((k + 1, n + 1), np.inf)
    back = np.zeros((k + 1, n + 1), dtype=int)
    best[0, 0] = 0
    for runs in range(1, k + 1):
        for j in range(runs, n + 1):
            for i in range(runs - 1, j):
                c = best[runs - 1, i] + cost(i, j)
                if c < best[runs, j]:
                    best[runs, j], back[runs, j] = c, i
    bounds, j = [], n
    for runs in range(k, 0, -1):
        i = back[runs, j]
        bounds.append((i, j))
        j = i
    return bounds[::-1]


def derive_periods(weekday_profile, weekend_profile):
    """Hour -> period index for weekdays and weekends, and the windows.

    Profiles are buses in service per hour. See the module docstring."""
    weekday = np.full(N_HOURS, 2)            # night unless the steps say otherwise
    top = weekday_profile.max()
    day = np.nonzero(weekday_profile >= DAY_SHARE * top)[0]
    weekday[day.min():day.max() + 1] = 1
    lo, hi = int(day.min()), int(day.max()) + 1
    base = np.median(weekday_profile[lo:hi])
    runs = [(lo + a, lo + b) for a, b in segment(weekday_profile[lo:hi], DAY_RUNS)]
    level = [weekday_profile[a:b].mean() for a, b in runs]
    for i in range(1, len(runs) - 1):
        if level[i] > max(level[i - 1], level[i + 1]) and level[i] >= base:
            weekday[runs[i][0]:runs[i][1]] = 0

    weekend = np.full(N_HOURS, -1)
    served = np.nonzero(weekend_profile >= DAY_SHARE * weekend_profile.max())[0]
    weekend[served.min():served.max() + 1] = 3

    def windows(labels, index):
        out, start = [], None
        for h in range(N_HOURS + 1):
            inside = h < N_HOURS and labels[h] == index
            if inside and start is None:
                start = h
            if not inside and start is not None:
                out.append([start, h])
                start = None
        return out

    periods = [
        {"id": PERIOD_IDS[p], "label": PERIOD_LABELS[p],
         "days": "weekend" if p == 3 else "weekday",
         "windows": windows(weekend if p == 3 else weekday, p)}
        for p in range(4)
    ]
    return weekday, weekend, periods


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def service_dates(feed):
    """service_id sets per date across the feed's calendar range."""
    calendar = read_csv(feed / "calendar.txt")
    exceptions = defaultdict(list)
    if (feed / "calendar_dates.txt").exists():
        for row in read_csv(feed / "calendar_dates.txt"):
            exceptions[row["date"]].append((row["service_id"], row["exception_type"].strip()))
    lo = min(dt.datetime.strptime(r["start_date"], "%Y%m%d").date() for r in calendar)
    hi = max(dt.datetime.strptime(r["end_date"], "%Y%m%d").date() for r in calendar)
    names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    out, day = {}, lo
    while day <= hi:
        key = day.strftime("%Y%m%d")
        on = {r["service_id"] for r in calendar
              if r[names[day.weekday()]].strip() == "1" and r["start_date"] <= key <= r["end_date"]}
        for sid, kind in exceptions.get(key, []):
            (on.add if kind == "1" else on.discard)(sid)
        out[day] = on
        day += dt.timedelta(days=1)
    return out


def gtfs_periods(era):
    """Service periods for an era from its published GTFS schedule.

    The buses-in-service profile is built from the scheduled first and last
    stop time of every trip on a representative day of each type: the date
    whose trip count is the most common for that day type (Tue-Thu for
    weekdays), which skips holidays and one-off service days. Saturday and
    Sunday are averaged. derive_periods() then finds the steps.
    """
    feed = FEEDS[era]
    trips = {t["trip_id"]: t["service_id"] for t in read_csv(feed / "trips.txt")}
    per_service = defaultdict(int)
    for sid in trips.values():
        per_service[sid] += 1
    dates = service_dates(feed)
    chosen = {}
    for kind, weekdays in {"weekday": [1, 2, 3], "saturday": [5], "sunday": [6]}.items():
        counts = {d: sum(per_service[s] for s in on) for d, on in dates.items()
                  if d.weekday() in weekdays}
        counts = {d: c for d, c in counts.items() if c > 0}
        mode = pd.Series(list(counts.values())).mode().iloc[0]
        chosen[kind] = min(d for d, c in counts.items() if c == mode)

    span = {}
    with open(feed / "stop_times.txt", newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            h, mi, se = (int(x) for x in r["departure_time"].strip().split(":"))
            t = h + mi / 60 + se / 3600
            lo, hi = span.get(r["trip_id"], (t, t))
            span[r["trip_id"]] = (min(lo, t), max(hi, t))

    profiles = {}
    for kind, day in chosen.items():
        profile = np.zeros(N_HOURS)
        for tid, sid in trips.items():
            if sid in dates[day] and tid in span:
                lo, hi = span[tid]
                for hour in range(int(lo), min(N_HOURS, int(hi) + 1)):
                    profile[hour] += max(0.0, min(hi, hour + 1) - max(lo, hour))
        profiles[kind] = profile
    print(f"  {era}: GTFS periods from {({k: str(v) for k, v in chosen.items()})}", flush=True)
    return derive_periods(profiles["weekday"], (profiles["saturday"] + profiles["sunday"]) / 2)


# ------------------------------------------------------------------ geometry

def section_chains(era, sections):
    """(route, dir) -> (stop code -> chain index, [section ids], cumulative m)."""
    sec = sections[sections.era == era]
    chains = {}
    for (route, dirn), g in sec.groupby(["route", "dir"]):
        g = g.sort_values("seq")
        ids = [int(i) for i in g.index]
        stops = [str(s) for s in g.from_stop] + [str(g.to_stop.iloc[-1])]
        lengths = [polyline_m(json.loads(c)) for c in g.coords]
        cum = np.concatenate([[0.0], np.cumsum(lengths)])
        index = {}
        for k, code in enumerate(stops):
            index.setdefault(code, k)
        chains[(route, str(dirn))] = (index, ids, cum)
    return chains


def corridor_directions(era, sections):
    """Exploded (section, corridor, direction) for an era's corridors."""
    features = json.loads((PACK / f"corridors_{era}.json").read_text())
    sec = sections[sections.era == era]
    ends = {int(i): json.loads(c) for i, c in sec.coords.items()}
    rows = []
    for ci, feature in enumerate(features):
        (la1, lo1), (la2, lo2) = feature["c"][0], feature["c"][-1]
        ref = ((lo2 - lo1) * math.cos(math.radians(la1)), la2 - la1)
        for sid in feature["s"]:
            if sid not in ends:
                continue
            (sa, so), (ea, eo) = ends[sid][0], ends[sid][-1]
            dot = (eo - so) * math.cos(math.radians(sa)) * ref[0] + (ea - sa) * ref[1]
            rows.append((sid, ci, 0 if dot >= 0 else 1))
    return len(features), pd.DataFrame(rows, columns=["section", "corridor", "cdir"])


# ------------------------------------------------------------------ one month

def month_source(y, m):
    """The raw month, and whether it is a temporary download to delete.

    The commute cache already holds the snapshot months; every other month is
    downloaded beside the per-month results and removed once read, since all
    89 months (~6.3 GB) will not fit on disk at once."""
    cached = CACHE / f"raw_{y}_{m:02d}.parquet"
    if cached.exists():
        return cached, False
    tmp = MONTH_CACHE / f"raw_{y}_{m:02d}.parquet"
    if not tmp.exists():
        part = tmp.with_suffix(".part")
        subprocess.run(["gcloud", "storage", "cp",
                        f"{BUCKET}/year={y}/month={m}/data_0.parquet", str(part)],
                       check=True, capture_output=True, timeout=1800)
        part.rename(tmp)
    return tmp, True


def load_month(y, m):
    source, temporary = month_source(y, m)
    t = pq.read_table(
        source,
        columns=["route", "route_id", "stop_id", "service_date", "event_timestamp",
                 "door_lift_flags_possibly"],
    ).to_pandas()
    if temporary:
        source.unlink()
    t = t.dropna(subset=["route", "stop_id", "route_id"])
    d = pd.DatetimeIndex(t.service_date)
    t = t[(d.year == y) & (d.month == m) & ~is_holiday(d)].copy()
    dow = pd.DatetimeIndex(t.service_date).dayofweek
    t["daytype"] = np.where(dow == 5, 1, np.where(dow == 6, 2, 0)).astype(np.int8)
    t["route"] = t.route.astype(str)
    t["stop_id"] = t.stop_id.astype(str)
    t["route_id"] = t.route_id.astype(str)
    t["bit"] = (t.door_lift_flags_possibly.astype(int) % 2).astype(np.int8)
    t["start"] = pd.to_numeric(t.route_id, errors="coerce")
    t = t.dropna(subset=["start"])
    t["start"] = t.start.astype(np.int32)
    return t.drop(columns=["door_lift_flags_possibly"])


def assign_directions(ev, seqs):
    """Put every trip on a GTFS route and direction by the stops it served.

    The door-flag bit used to split a route's two directions, and matching
    each (route, bit) as a whole worked until mid-2020. From Aug 2020 each bit
    carries both directions (route 1 went from ~100 stops per bit to 195), the
    mixed stop sets matched neither direction, and half the routes -- and a
    fifth of the corridors -- fell out. So direction is decided per trip:
      * APC route label -> GTFS route: the same name when the era has it,
        otherwise the route whose stops (both directions) best match the
        label's month of stops by Jaccard, at MATCH_MIN or better.
      * trip (service date, label, bit, start) -> direction: the one holding
        most of the trip's stops, if it holds at least TRIP_SHARE of them and
        more than the other direction does.
    Afterwards `route` is the GTFS route name and `bit` the direction id, so
    everything downstream keys trips the same way it did before.
    """
    by_route = defaultdict(dict)
    for (route, dirn), seq in seqs.items():
        by_route[route][str(dirn)] = set(seq)
    union = {route: set().union(*dirs.values()) for route, dirs in by_route.items()}
    names = {}
    for label, stops in ev.groupby("route").stop_id.agg(set).items():
        if label in by_route:
            names[label] = label
            continue
        score, best = max(((len(stops & u) / len(stops | u), r) for r, u in union.items()),
                          default=(0, None))
        if score >= MATCH_MIN:
            names[label] = best
    ev = ev.assign(gtfs=ev.route.map(names)).dropna(subset=["gtfs"])

    member = pd.DataFrame(
        [(route, dirn, stop) for route, dirs in by_route.items()
         for dirn, stops in dirs.items() for stop in stops],
        columns=["gtfs", "dir", "stop_id"])
    trip = ["service_date", "route", "bit", "start"]
    stops = ev[trip + ["gtfs", "stop_id"]].drop_duplicates()
    size = stops.groupby(trip).size().rename("n")
    hits = stops.merge(member, on=["gtfs", "stop_id"]).groupby(trip + ["dir"]).size()
    hits = hits.rename("hits").reset_index().sort_values("hits", ascending=False)
    top = hits.drop_duplicates(trip)
    runner = hits[hits.duplicated(trip)].drop_duplicates(trip).rename(columns={"hits": "second"})
    top = (top.merge(runner[trip + ["second"]], on=trip, how="left")
              .merge(size.reset_index(), on=trip))
    top = top[(top.hits >= TRIP_SHARE * top.n) & (top.hits > top.second.fillna(0))]

    before = len(ev)
    ev = ev.merge(top[trip + ["dir"]], on=trip)
    print(f"    direction assigned to {len(ev) / max(before, 1):.0%} of events "
          f"({ev.route.nunique()} labels -> {ev.gtfs.nunique()} routes)", flush=True)
    ev["route"] = ev.gtfs
    ev["bit"] = ev.dir.astype(int).astype(np.int8)
    return ev.drop(columns=["gtfs", "dir"])


def build_snapshot(y, m, sections, chains_cache, corr_cache, seq_cache):
    era = era_for(y, m)
    if era not in chains_cache:
        chains_cache[era] = section_chains(era, sections)
        corr_cache[era] = corridor_directions(era, sections)
        seq_cache[era] = era_sequences(era)
        chains_cache[(era, "periods")] = gtfs_periods(era)
    chains = chains_cache[era]
    n_corr, corr = corr_cache[era]
    ev = assign_directions(load_month(y, m), seq_cache[era])

    # ---- trip slots and the system profile that sets the periods ----
    ev["h"] = ((ev.event_timestamp - pd.to_datetime(ev.service_date)).dt.total_seconds() / 3600)
    busday = ev.groupby(["daytype", "service_date", "route", "bit", "start"]).h.agg(["min", "max"])
    slots = busday.groupby(["daytype", "route", "bit", "start"]).median().reset_index()
    weekday_lab, weekend_lab, periods = chains_cache[(era, "periods")]
    # A signup change mid-month leaves two timetables in the month, and their
    # union reads as double the service (51A, Aug 2020: 5 days at 15 min, 16
    # at 12). Keep the timetable in force for most of it: a start counts only
    # if it ran on at least SLOT_DAYS of the days the best-seen start of its
    # route-direction in the same hour did -- per hour, because counters catch
    # night trips on fewer days than daytime ones.
    seen = busday.reset_index().groupby(["daytype", "route", "bit", "start"]).service_date.nunique()
    seen = seen.reset_index()
    seen["hour"] = seen.start // 100
    most = seen.groupby(["daytype", "route", "bit", "hour"]).service_date.transform("max")
    seen = seen.set_index(["daytype", "route", "bit", "start"]).service_date
    most.index = seen.index
    slots = slots.merge((seen >= SLOT_DAYS * most).rename("kept").reset_index(),
                        on=["daytype", "route", "bit", "start"])
    kept_slots = slots[slots.kept][["daytype", "route", "bit", "start"]]
    slots = slots[slots.kept][["route", "bit", "start", "daytype"]].copy()
    slots["hour"] = (slots.start // 100).clip(0, N_HOURS - 1)

    def period_of(daytype, hour):
        hour = np.clip(hour, 0, N_HOURS - 1)
        return np.where(daytype == 0, weekday_lab[hour], weekend_lab[hour])

    # ---- place each event on its route-direction's section chain ----
    ev = ev.reset_index(drop=True)
    rd_names = sorted(rd for rd in chains)
    rd_code = {rd: i for i, rd in enumerate(rd_names)}
    ev["rd"] = np.array([rd_code.get((r, str(bt)), -1) for r, bt in zip(ev.route, ev.bit)],
                        dtype=np.int32)
    ev = ev[ev.rd >= 0].reset_index(drop=True)
    pos = np.full(len(ev), np.nan)
    k_idx = np.full(len(ev), -1)
    for code, rows in ev.groupby("rd").indices.items():
        index, _, cum = chains[rd_names[code]]
        k = ev.stop_id.iloc[rows].map(index)
        ok = k.notna().to_numpy()
        rows = rows[ok]
        k_idx[rows] = k[ok].astype(int).to_numpy()
        pos[rows] = cum[k_idx[rows]]
    ev["k"], ev["pos"] = k_idx, pos
    ev = ev[ev.k >= 0]

    # first door-open per stop per bus-day, in time order
    ev = ev.sort_values(["service_date", "route", "bit", "start", "event_timestamp"])
    last = ev.groupby(["service_date", "route", "bit", "start", "k"]).event_timestamp.transform("max")
    ev = ev.assign(last=last).drop_duplicates(["service_date", "route", "bit", "start", "k"])
    # A bus opens its doors at the first stop and then waits out its layover;
    # timing the first leg from arrival would book the layover as travel.
    first = ~ev.duplicated(["service_date", "route", "bit", "start"])
    ev.loc[first, "event_timestamp"] = ev.loc[first, "last"]
    same = ((ev.service_date.values[1:] == ev.service_date.values[:-1])
            & (ev.route.values[1:] == ev.route.values[:-1])
            & (ev.bit.values[1:] == ev.bit.values[:-1])
            & (ev.start.values[1:] == ev.start.values[:-1]))
    a, b = ev.iloc[:-1][same], ev.iloc[1:][same]
    dpos = b.pos.to_numpy() - a.pos.to_numpy()
    dsec = (b.event_timestamp.to_numpy() - a.event_timestamp.to_numpy()) / np.timedelta64(1, "s")
    kb = b.k.to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        mph = dpos / dsec / M_PER_MILE * 3600
    # The distance cap is for pairs that skip stops on the chain -- a missed
    # door-open stitching two far-apart stops together. Neighbouring stops are
    # kept at any distance: the Transbay lines run 9-14 km over the Bay Bridge
    # without a stop, and capping those dropped every bridge crossing.
    adjacent = kb == a.k.to_numpy() + 1
    keep = ((kb > a.k.to_numpy()) & (dpos > 0) & (adjacent | (dpos <= MAX_PAIR_M)) & (dsec > 0)
            & (dsec <= MAX_PAIR_S) & (mph >= MIN_MPH) & (mph <= MAX_MPH))
    a, dpos, dsec, kb = a[keep], dpos[keep], dsec[keep], kb[keep]
    t0 = ((a.event_timestamp - pd.to_datetime(a.service_date)).dt.total_seconds()).to_numpy()

    # ---- spread each pair over the sections it spans ----
    ka = a.k.to_numpy()
    span = kb - ka
    rep = np.repeat(np.arange(len(a)), span)
    kk = ka[rep] + (np.arange(len(rep)) - np.repeat(np.cumsum(span) - span, span))
    rds = a.rd.to_numpy()[rep]
    sec_id = np.empty(len(rep), dtype=np.int64)
    sec_len = np.empty(len(rep))
    sec_start = np.empty(len(rep))
    for rd in np.unique(rds):
        _, ids, cum = chains[rd_names[rd]]
        on = rds == rd
        sec_id[on] = np.asarray(ids)[kk[on]]
        sec_len[on] = np.diff(cum)[kk[on]]
        sec_start[on] = cum[kk[on]]
    pos_a = a.pos.to_numpy()[rep]
    frac_t = dsec[rep] / dpos[rep]
    part = pd.DataFrame({
        "section": sec_id,
        "daytype": a.daytype.to_numpy()[rep],
        "dist": sec_len,
        "secs": sec_len * frac_t,
        "pass_h": (t0[rep] + (sec_start - pos_a) * frac_t) / 3600,
        "route": a.route.to_numpy()[rep],
        "bit": a.bit.to_numpy()[rep],
        "start": a.start.to_numpy()[rep],
    })
    part["period"] = period_of(part.daytype.to_numpy(), part.pass_h.astype(int).to_numpy())
    part = part[part.period >= 0]
    print(f"  {y}-{m:02d} ({era}): {len(a):,} stop pairs, {len(part):,} section passes, "
          f"periods {[(p['id'], p['windows']) for p in periods]}", flush=True)

    # ---- speeds ----
    speed = part.groupby(["section", "period"])[["dist", "secs"]].sum().reset_index()
    cs = speed.merge(corr, on="section").groupby(["corridor", "period"])[["dist", "secs"]].sum()

    # ---- corridor headways: distinct slots per direction, median passing hour ----
    passes = (part.merge(kept_slots, on=["daytype", "route", "bit", "start"])
                  .groupby(["section", "daytype", "route", "bit", "start"]).pass_h
                  .median().reset_index())
    passes["period"] = period_of(passes.daytype.to_numpy(), passes.pass_h.astype(int).to_numpy())
    passes = passes[passes.period >= 0]
    passes["hour"] = passes.pass_h.astype(int)
    cp = passes.merge(corr, on="section").drop_duplicates(
        ["corridor", "cdir", "daytype", "route", "bit", "start"])
    # weekend = Saturday and Sunday averaged, so each weekend slot counts half
    cp["w"] = np.where(cp.daytype == 0, 1.0, 0.5)
    trips = cp.groupby(["corridor", "period", "cdir"]).w.sum()
    active = cp.groupby(["corridor", "period"]).hour.nunique()

    out = np.full((n_corr, 4, 2), NULL, dtype=np.uint16)
    for (ci, p), n_hours in active.items():
        per_dir = trips.loc[(ci, p)]
        served = per_dir[per_dir > 0]
        if len(served):
            out[ci, p, 0] = min(NULL - 1, round(10 * n_hours * 60 / served.mean()))
    for (ci, p), row in cs.iterrows():
        if row.secs > 0:
            out[ci, p, 1] = min(NULL - 1, round(10 * row.dist / row.secs / M_PER_MILE * 3600))

    # ---- routes ----
    slots["period"] = period_of(slots.daytype.to_numpy(), slots.hour.to_numpy())
    slots = slots[slots.period >= 0]
    slots["name"] = slots.route
    slots["w"] = np.where(slots.daytype == 0, 1.0, 0.5)
    slots = slots.dropna(subset=["name"])
    part["name"] = part.route
    route_speed = part.groupby(["name", "period"])[["dist", "secs"]].sum()
    routes = {}
    for name, g in slots.groupby("name"):  # "bit" is the direction from here on
        headway, count, speeds = [], [], []
        for p in range(4):
            gp = g[g.period == p]
            per_bit = gp.groupby("bit").w.sum()
            per_bit = per_bit[per_bit > 0]
            n_hours = gp.hour.nunique()
            headway.append(round(n_hours * 60 / per_bit.mean(), 1) if len(per_bit) else None)
            count.append(round(float(gp.w.sum()), 1))
            if (name, p) in route_speed.index and route_speed.loc[(name, p)].secs > 0:
                r = route_speed.loc[(name, p)]
                speeds.append(round(r.dist / r.secs / M_PER_MILE * 3600, 1))
            else:
                speeds.append(None)
        routes[name] = {"headway": headway, "trips": count, "mph": speeds}

    return {
        "id": f"{y}-{m:02d}",
        "era": era,
        "periods": periods,
        "routes": routes,
    }, out


_worker = {}


def build_month(ym):
    """Build one month into MONTH_CACHE; runs in a worker process."""
    y, m = ym
    if "sections" not in _worker:
        sections = pd.read_parquet(VIS / "data" / "sections.parquet")
        sections["dir"] = sections["dir"].astype(str)
        _worker.update(sections=sections, chains={}, corr={}, seq={})
    key = f"{y}-{m:02d}"
    try:
        meta, arr = build_snapshot(y, m, _worker["sections"], _worker["chains"],
                                   _worker["corr"], _worker["seq"])
    except subprocess.CalledProcessError:
        print(f"  {key}: no raw month in the bucket, skipped", flush=True)
        return key, False
    meta["label"] = f"{MONTH_NAMES[m - 1]} {y}"
    (MONTH_CACHE / f"{key}.u16").write_bytes(arr.astype("<u2").tobytes())
    (MONTH_CACHE / f"{key}.json").write_text(json.dumps(meta, separators=(",", ":"), default=float))
    return key, True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("months", nargs="*", help="YYYY-MM months to rebuild")
    parser.add_argument("--jobs", type=int, default=1, help="months built in parallel")
    args = parser.parse_args()
    months = [(int(k[:4]), int(k[5:])) for k in json.loads((PACK / "meta.json").read_text())["months"]]
    MONTH_CACHE.mkdir(parents=True, exist_ok=True)
    todo = [(y, m) for y, m in months
            if f"{y}-{m:02d}" in args.months or not (MONTH_CACHE / f"{y}-{m:02d}.json").exists()]
    print(f"{len(todo)} of {len(months)} months to build, {args.jobs} at a time", flush=True)
    if args.jobs > 1:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for key, ok in pool.map(build_month, todo):
                print(f"  done {key}" if ok else f"  skipped {key}", flush=True)
    else:
        for ym in todo:
            build_month(ym)

    # One pair of files per month, so the client fetches only the month the
    # time bar sits in. service_meta.json stays small: labels, eras, periods
    # and the two file names per month, no route tables.
    for old in PACK.glob("service_corridors*.bin"):
        old.unlink()
    snapshots, total = [], 0
    for y, m in months:
        key = f"{y}-{m:02d}"
        if not (MONTH_CACHE / f"{key}.json").exists():
            continue
        meta = json.loads((MONTH_CACHE / f"{key}.json").read_text())
        data = (MONTH_CACHE / f"{key}.u16").read_bytes()
        routes = json.dumps(meta.pop("routes"), separators=(",", ":")).encode()
        meta["n"] = len(data) // 16
        meta["file"] = publish(f"service_{key}.u16", data)
        meta["routes_file"] = publish(f"service_routes_{key}.json", routes)
        total += len(data) + len(routes)
        snapshots.append(meta)

    (PACK / "service_meta.json").write_text(json.dumps(
        {"null": NULL, "snapshots": snapshots}, separators=(",", ":")))
    print(f"wrote service_meta.json ({(PACK / 'service_meta.json').stat().st_size / 1e3:.0f} KB) "
          f"+ {len(snapshots)} months ({total / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
