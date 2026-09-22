"""The whole imputation, in one file.

This is §1 of the methodology page (/methodology#imputation) implemented end
to end: raw APC door-open events in, a daily stop-level ridership estimate
split into observed and imputed parts out, with a validation report that
prints each number the page claims beside the number this run actually got.

The production pipeline spreads the same work over eight scripts in two
sibling directories (build_capture.py, build_output.py, build_alightings.py,
build_pra_calibration.py, reconstruct_daily.py, stop_distribution.py,
build_weekly_blend.py, build_prepack.py). Nothing here is a new method; it is
those scripts collapsed into one readable pass so the chain from an event to
a displayed number can be read in a single sitting, and re-run anywhere.

    stage 1  events -> trips + stop-days           §1.2  trip identity
    stage 2  trips  -> capture fractions + gates   §1.3-1.6
    stage 3  ratio estimator on stops              §1.5
    stage 4  the control, per route-month          §1.7
    stage 5  schedule-only reconstruction          §1.10
    stage 6  stop shares for the reconstruction    §1.10
    stage 7  the weekly blend + Denton             §1.9, §1.12
    stage 8  validation report                     §1.3-1.9

One simplification worth stating, because it changes the code and not the
numbers. The repo applies a system-wide NTD monthly scalar first
(build_output.py) and the per-route-month control factor on top of it
(build_pra_calibration.py). The control factor is C / APC with the NTD scalar
already inside APC, and the scalar is constant within a month, so it cancels
exactly -- for matched route-months cell by cell, and for the volume-weighted
fallback because a common factor divides out of a ratio of sums. This file
therefore goes straight from the ratio estimator to the control, which is
what the methodology page describes, and lands on the same values.

Not implemented here, none of it part of §1: the BigQuery extraction that
produces the raw parquet, the null-route recovery pass in build_alightings.py
(0.166% of boardings), the recovery of 316 stops' coordinates from event
medians, and the time-of-day capture band table, which exists for the commute
view (§2.6) rather than for the weekly numbers.

Usage
-----
    python3 impute.py --raw RAW_DIR --gtfs GTFS_DIR --control PRA.xlsx \
                      --out OUT_DIR [--months 2019-02,2019-08,...]

RAW_DIR holds raw_YYYY_MM.parquet, one row per door-open event. Stage 1
writes trip_YYYY_MM.parquet and stopal_YYYY_MM.parquet next to the outputs;
--aggregates DIR skips stage 1 and reads those two products from DIR instead,
which is how a long history runs without re-reading every event.

GTFS_DIR holds one subdirectory per feed era (Nov2019, Dec2024, Aug2025),
each an unzipped static GTFS feed.
"""
import argparse
import calendar as calmod
import csv
import datetime as dt
import gc
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import scipy.sparse as sp
import scipy.sparse.linalg as spla

# --------------------------------------------------------------------------
# constants: every one of these is quoted in the methodology page
# --------------------------------------------------------------------------
MIN_CAPTURE = 0.4        # §1.6 gate 1: enough working counters to trust
MIN_STABILITY = 0.7      # §1.6 gate 2: schedule not collapsed vs typical
MIN_PRESENCE = 0.7       # §1.6 gate 3: route actually ran most days
MAX_FACTOR = 5.0         # §1.7: beyond this the control is not scaling, it is inventing
RENAME = {"1T": "1"}     # §5.1: the one rename the feed never adopted
# §5.2: the control reports parent and split transbay families separately
SPLIT = {"F1": "F", "F2": "F", "NL1": "NL", "NL2": "NL", "O1": "O", "O2": "O",
         "NX1": "NX", "NX2": "NX", "NX4": "NX", "NXC": "NX"}
SCHEDULE_ALIAS = {**SPLIT, "CB": "CB", "OX": "OX"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday",
        "saturday", "sunday"]
# §1.10: share vectors are learned per route per era, because a route's stop
# pattern and its riders both move over seven years
BUCKETS = {"2019": (2019, 2019), "2020-21": (2020, 2021),
           "2022-23": (2022, 2023), "2024-25": (2024, 2026)}
ERA_RANGES = {"Nov2019": (dt.date(2019, 1, 1), dt.date(2021, 12, 31)),
              "Dec2024": (dt.date(2022, 1, 1), dt.date(2025, 3, 31)),
              "Aug2025": (dt.date(2025, 4, 1), dt.date(2099, 12, 31))}
CONTROL_CARRY_END = (2026, 5)   # §5.3: the control stops in Jan 2026

T0 = time.time()


def say(msg=""):
    if msg:
        print(f"[{time.time() - T0:7.1f}s] {msg}", flush=True)
    else:
        print(flush=True)


def head(title):
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}", flush=True)


# --------------------------------------------------------------------------
# calendar
# --------------------------------------------------------------------------
def nth_weekday(y, m, wd, n):
    days = [dt.date(y, m, d) for d in range(1, calmod.monthrange(y, m)[1] + 1)
            if dt.date(y, m, d).weekday() == wd]
    return days[n - 1] if n > 0 else days[n]


def holiday_name(d):
    """US federal holidays plus the two days AC Transit visibly cuts service.

    Two holiday sets exist in the production pipeline and both are kept here,
    because they answer different questions. This rule-based one drives the
    reconstruction and the control's day-type counts: it wants the dates the
    agency actually runs a Sunday timetable, which includes Christmas Eve and
    the day after Thanksgiving and does not include a Monday observance of a
    Saturday holiday. FEDERAL below drives the capture denominator, where the
    question is only whether a day's trip start times belong in the ordinary
    grid.
    """
    y, m, day = d.year, d.month, d.day
    if (m, day) == (1, 1):
        return "newyear"
    if (m, day) == (6, 19) and y >= 2021:
        return "juneteenth"
    if (m, day) == (7, 4):
        return "jul4"
    if (m, day) == (11, 11):
        return "veterans"
    if (m, day) == (12, 25):
        return "christmas"
    if (m, day) == (12, 24):
        return "christmas_eve"
    if m == 1 and d == nth_weekday(y, 1, 0, 3):
        return "mlk"
    if m == 2 and d == nth_weekday(y, 2, 0, 3):
        return "presidents"
    if m == 5 and d == nth_weekday(y, 5, 0, -1):
        return "memorial"
    if m == 9 and d == nth_weekday(y, 9, 0, 1):
        return "labor"
    if m == 10 and d == nth_weekday(y, 10, 0, 2):
        return "columbus"
    thx = nth_weekday(y, 11, 3, 4)
    if d == thx:
        return "thanksgiving"
    if d == thx + dt.timedelta(days=1):
        return "dayafter"
    return None


def _federal_set():
    from pandas.tseries.holiday import USFederalHolidayCalendar
    h = pd.DatetimeIndex(USFederalHolidayCalendar().holidays(
        start="2018-01-01", end="2027-12-31"))
    thx = h[(h.month == 11) & (h.day >= 22) & (h.day <= 28)]
    return h.union(thx + pd.Timedelta(days=1))


FEDERAL = _federal_set()


def is_holiday(dates):
    return pd.DatetimeIndex(dates).isin(FEDERAL)


def day_type(dates):
    dow = pd.DatetimeIndex(dates).dayofweek
    return np.where(dow == 5, "Saturday", np.where(dow == 6, "Sunday", "Weekday"))


def add_calendar_fields(df, col="service_date"):
    d = pd.DatetimeIndex(df[col])
    df = df.copy()
    df["year"] = d.year
    df["month"] = d.month
    df["day_type"] = day_type(d)
    df["holiday"] = is_holiday(d)
    return df


def daytype_counts(y, m):
    """Days of each type in a month, with weekday holidays moved to Sunday.

    A holiday weekday runs Sunday service, so counting it as a weekday
    multiplies a weekday's ridership onto a day that carried a Sunday's.
    Left in, it inflates a monthly control total by ~1.5% system-wide.
    """
    n = {"Weekday": 0, "Saturday": 0, "Sunday": 0}
    for d in range(1, calmod.monthrange(y, m)[1] + 1):
        dd = dt.date(y, m, d)
        k = ("Weekday" if dd.weekday() < 5
             else ("Saturday" if dd.weekday() == 5 else "Sunday"))
        n["Sunday" if holiday_name(dd) else k] += 1
    return n


def bucket_of(year):
    for name, (lo, hi) in BUCKETS.items():
        if lo <= year <= hi:
            return name
    return "2024-25"


def era_for_date(d):
    for name, (lo, hi) in ERA_RANGES.items():
        if lo <= d <= hi:
            return name
    return "Aug2025"


# ==========================================================================
# STAGE 1  -- events to trips and stop-days                            §1.2
# ==========================================================================
RAW_COLS = ["route", "route_id", "stop_id", "service_date",
            "boardings", "alightings", "passenger_load",
            "door_lift_flags_possibly"]


def stage1_extract(path, out_dir, ym):
    """One month of door-open events -> a trip table and a stop-day table.

    The feed has no trip id and no direction column, so both are recovered:
    `route_id` is not a route, it is the trip's scheduled start as HHMM, and
    the low bit of the door-and-lift flag separates the two buses leaving on
    the same minute in opposite directions (the field takes values 0,1,2,3,8
    across the system, hence mod 2). The trip is then the tuple

        (route, service_date, route_id, bit)

    which is what a capture fraction counts, and the stop table is the same
    events grouped the other way, which is what the correction is applied to.
    """
    df = pq.read_table(path, columns=RAW_COLS).to_pandas()
    n_events = len(df)
    # A null route must become a label, not stay null. groupby drops rows
    # with a null key, so leaving it would silently delete every event whose
    # route was lost -- 20k boardings in Feb 2019 alone -- from the trip
    # table that the capture numerator is counted on. The production pipeline
    # relies on astype(str) rendering None as "None", which it does under
    # pandas 2 and does not under pandas 3, where the string dtype keeps NA
    # as NA. Doing it explicitly makes the behaviour the same on both.
    df["route"] = df["route"].astype(object).fillna("None").astype(str)
    df["bit"] = pd.to_numeric(df["door_lift_flags_possibly"],
                              errors="coerce").fillna(0).astype(int) % 2
    df["service_date"] = pd.to_datetime(df["service_date"])
    null_stop = df["stop_id"].isna()
    bd_null = float(df.loc[null_stop, "boardings"].sum())

    trip = (df.groupby(["route", "service_date", "route_id", "bit"], sort=False)
              ["boardings"].sum().rename("bd").reset_index())
    stop = (df[~null_stop]
            .groupby(["route", "service_date", "stop_id", "bit"], sort=False)
            .agg(raw_bd=("boardings", "sum"), raw_al=("alightings", "sum"),
                 load_sum=("passenger_load", "sum"), n_events=("boardings", "size"))
            .reset_index())

    y, m = ym
    trip.to_parquet(out_dir / f"trip_{y}_{m:02d}.parquet", index=False)
    stop.to_parquet(out_dir / f"stopal_{y}_{m:02d}.parquet", index=False)
    del df
    gc.collect()
    return dict(ym=f"{y}-{m:02d}", events=n_events, trips=len(trip),
                stop_rows=len(stop), bd=float(trip.bd.sum()),
                null_stop_bd=bd_null)


def load_aggregates(agg_dir, months):
    trips, stops = [], []
    for (y, m) in months:
        t = agg_dir / f"trip_{y}_{m:02d}.parquet"
        s = agg_dir / f"stopal_{y}_{m:02d}.parquet"
        if not (t.exists() and s.exists()):
            continue
        trips.append(pd.read_parquet(t))
        sd = pd.read_parquet(s)
        stops.append(sd)
    trip = pd.concat(trips, ignore_index=True)
    stop = pd.concat(stops, ignore_index=True)
    for d in (trip, stop):
        d["route"] = d["route"].astype(object).fillna("None").astype(str)
    trip["service_date"] = pd.to_datetime(trip["service_date"])
    stop["service_date"] = pd.to_datetime(stop["service_date"])
    return trip, stop


# ==========================================================================
# STAGE 2  -- capture fractions and the reliability gates          §1.3-1.6
# ==========================================================================
def build_capture(trip):
    """Capture fraction per (route, direction, month, day type).

    The denominator is the hard part. A capture rate needs to know how many
    trips were scheduled, and the published timetable cannot say: outside its
    own signup window it counts COVID-cut and summer-school service that never
    operated. The distinct start times seen across a month of one day type
    can, because with counters on twenty-odd weekdays every scheduled slot is
    seen at least once. That denominator is free of the sensor's health in a
    way a count of observed trips is not: a slot counts once whether one bus
    or twenty reported it.

    The numerator excludes dead counters. A trip reporting zero boardings
    from first stop to last is a broken sensor, not an empty bus, and ~27% of
    trips in the feed look like that. Averaged in as zeroes they would halve
    every correction.

    Month grain, for all three day types. Quarter grain was tried for
    weekends on the theory that 4-5 samples a month is too thin, and it is
    wrong twice over: weekend timetables have far fewer distinct slots so they
    saturate just as fast, and pooling a quarter spans a signup change, which
    inflates the denominator for the whole bucket (Jul-Sep silently pools
    summer service with the school-year ramp, a systematic 50-80% overshoot).
    """
    t = add_calendar_fields(trip)
    t["productive"] = t["bd"] > 0
    t["period"] = t["month"]
    reg = t[~t["holiday"]]
    key = ["route", "bit", "year", "day_type", "period"]

    den = reg.groupby(key)["route_id"].nunique().rename("den").reset_index()
    daily = (reg.groupby(key + ["service_date"])
                .agg(prod=("productive", "sum")).reset_index())
    agg = (daily.groupby(key)
                .agg(prod_sum=("prod", "sum"), n_days_present=("service_date", "nunique"))
                .reset_index())

    cal = pd.DataFrame({"service_date": pd.date_range("2018-01-01", "2027-01-01", freq="D")})
    cal = add_calendar_fields(cal)
    cal["period"] = cal["month"]
    cal = cal[~cal.holiday]
    total_days = (cal.groupby(["year", "day_type", "period"])["service_date"]
                     .nunique().rename("n_days_total").reset_index())

    m = den.merge(agg, on=key, how="outer").merge(
        total_days, on=["year", "day_type", "period"], how="left")
    m[["den", "prod_sum", "n_days_present"]] = m[["den", "prod_sum", "n_days_present"]].fillna(0)

    m["capture"] = np.where(m.den * m.n_days_present > 0,
                            (m.prod_sum / (m.den * m.n_days_present)).clip(upper=1.0), 0.0)
    m["presence"] = m.n_days_present / m.n_days_total
    # stability compares this month's recovered schedule with the route's own
    # typical one, so a month where half the route stopped being observed is
    # caught even when the trips that remain all reported
    ref = (m[m.den > 0].groupby(["route", "bit", "day_type"])["den"]
             .median().rename("den_ref").reset_index())
    m = m.merge(ref, on=["route", "bit", "day_type"], how="left")
    m["stability"] = np.where(m.den_ref > 0, m.den / m.den_ref, 0.0)

    m["reliable"] = ((m.capture >= MIN_CAPTURE) & (m.stability >= MIN_STABILITY)
                     & (m.presence >= MIN_PRESENCE))
    m["scale"] = np.where(m.capture > 0, 1.0 / m.capture, np.nan)
    return m, t


# ==========================================================================
# STAGE 3  -- the ratio estimator                                      §1.5
# ==========================================================================
def apply_capture(stop, cap):
    """Divide every raw count in a cell by that cell's capture fraction.

    One scalar per cell, applied to every stop and every day inside it. That
    is why it transfers to alightings untouched: capture measures how much of
    the trip universe was observed, not a boardings-specific bias, and a dead
    counter loses both directions of flow together. The report checks it
    rather than assuming it.

    Onboard load is deliberately not scaled. It is an intensive per-event
    mean, and multiplying a mean by 1/c is meaningless.
    """
    s = add_calendar_fields(stop)
    s["period"] = s["month"]
    key = ["route", "bit", "year", "day_type", "period"]
    j = s.merge(cap[key + ["scale", "reliable", "capture"]], on=key, how="left")
    j["scale"] = j["scale"].fillna(1.0)
    j["reliable"] = j["reliable"].astype("boolean").fillna(False).astype(bool)
    j["corrected_bd"] = j["raw_bd"] * j["scale"]
    j["corrected_al"] = j["raw_al"] * j["scale"]
    return j


# ==========================================================================
# STAGE 4  -- the control, per route-month                             §1.7
# ==========================================================================
def load_control(xlsx):
    """Route x month x day-type average daily passengers -> monthly totals.

    Two corrections before it can anchor anything. The control reports the
    parent and the split children of the transbay families (F/F1/F2 and so
    on) in the same months, which double-counts by about 4%; the children are
    dropped wherever the parent is present. And the feed never adopted the
    1T label after the Aug 2020 rename, so the control's 1T is read as the
    counters' 1 -- 30M boardings, verified at a 1.01-1.28 source ratio.
    """
    import openpyxl
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    rows = []
    for i, r in enumerate(wb["Sheet1"].iter_rows(values_only=True)):
        if i == 0 or r[0] is None or r[2] is None or r[1] not in MONTHS:
            continue
        try:
            px, yr = float(r[2]), int(r[4])
        except (TypeError, ValueError):
            continue
        rows.append((str(r[0]).strip(), yr, MONTHS.index(r[1]) + 1,
                     str(r[3]).strip(), px))
    df = pd.DataFrame(rows, columns=["route", "y", "m", "day_type", "daily"])
    nd_cache = {}
    def nd(y, m, t):
        if (y, m) not in nd_cache:
            nd_cache[(y, m)] = daytype_counts(y, m)
        return nd_cache[(y, m)].get(t, 0)
    df["nd"] = [nd(r.y, r.m, r.day_type) for r in df.itertuples()]
    df["pra"] = df.daily * df.nd
    level = {(r.route, r.y, r.m, r.day_type): r.daily for r in df.itertuples()}

    mon = df.groupby(["route", "y", "m"], as_index=False).pra.sum()
    gross = mon.pra.sum()
    have = set(zip(mon.route, mon.y, mon.m))
    kids = mon.assign(par=mon.route.map(SPLIT)).dropna(subset=["par"])
    drop = {(r.route, r.y, r.m) for r in kids.itertuples()
            if (r.par, r.y, r.m) in have}
    mon = mon[~mon.set_index(["route", "y", "m"]).index.isin(drop)]
    dedup_pct = 100 * (1 - mon.pra.sum() / gross)
    mon["route"] = mon.route.replace(RENAME)
    mon = mon.groupby(["route", "y", "m"], as_index=False).pra.sum()
    return mon, level, dedup_pct, len(drop)


def route_month_factors(corrected, control):
    """One factor per route per month: the control's total over the counters'.

    After this the counters no longer set any route's monthly level. They
    decide only how it is distributed -- across stops, days, directions and
    the observed/imputed split.

    Four cases, and the fourth is the one that matters. Some May-July 2019
    route-months would need a factor between 500 and 1700 to reach the
    control. That is not a scaling problem; it is a handful of surviving
    events inflated into a month of ridership. Past a 5x stretch the
    route-month is handed to the schedule reconstruction instead and counted
    as fully imputed.
    """
    apc = (corrected.assign(y=corrected.year, m=corrected.month)
                    .groupby(["route", "y", "m"], as_index=False)
                    .corrected_bd.sum().rename(columns={"corrected_bd": "apc"}))
    apc = apc[apc.route.notna() & (apc.route != "None")]

    j = apc.merge(control, on=["route", "y", "m"], how="outer", indicator=True)
    matched = j[j._merge == "both"].copy()
    matched["factor"] = matched.pra / matched.apc.where(matched.apc > 0)
    matched["kind"], matched["mode"] = "matched", "apc"

    a_only = j[j._merge == "left_only"].copy()
    mfac = (matched.groupby(["y", "m"]).pra.sum()
            / matched.groupby(["y", "m"]).apc.sum())
    a_only["factor"] = [mfac.get((r.y, r.m), 1.0) for r in a_only.itertuples()]
    a_only["kind"], a_only["mode"] = "no_control_row", "apc"

    p_only = j[j._merge == "right_only"].copy()
    p_only["factor"] = 1.0
    p_only["kind"], p_only["mode"] = "no_apc_rows", "schedule"

    cols = ["route", "y", "m", "factor", "kind", "mode", "apc", "pra"]
    fac = pd.concat([matched[cols], a_only[cols], p_only[cols]], ignore_index=True)
    fac = fac[(fac["mode"] == "schedule") | (fac.factor.notna() & (fac.factor > 0))]
    over = (fac.factor > MAX_FACTOR) & (fac["mode"] == "apc")
    fac.loc[over, "kind"] = "apc_too_thin"
    fac.loc[over, "mode"] = "schedule"
    fac["factor"] = fac.factor.clip(upper=MAX_FACTOR)
    inv = {v: k for k, v in RENAME.items()}
    fac["sched_route"] = fac.route.map(lambda r: inv.get(r, r))
    return fac


# ==========================================================================
# STAGE 5  -- the schedule-only reconstruction                        §1.10
# ==========================================================================
def feed_dir(d):
    """Some unzipped feeds nest the files one level down (Dec2024/Dec2024)."""
    if (d / "routes.txt").exists():
        return d
    for sub in sorted(x for x in d.iterdir() if x.is_dir()):
        if (sub / "routes.txt").exists():
            return sub
    return d


def load_feed(d):
    d = feed_dir(d)
    routes = {r["route_id"]: (r.get("route_short_name") or "").strip() or r["route_id"]
              for r in csv.DictReader(open(d / "routes.txt", encoding="utf-8-sig"))}
    trips, trips_dir = Counter(), Counter()
    by_route = defaultdict(set)
    for t in csv.DictReader(open(d / "trips.txt", encoding="utf-8-sig")):
        short = routes.get(t["route_id"], t["route_id"])
        sid = t["service_id"]
        trips[(short, sid)] += 1
        trips_dir[(short, (t.get("direction_id", "").strip() or "0"), sid)] += 1
        by_route[short].add(sid)
    cal = {}
    for c in csv.DictReader(open(d / "calendar.txt", encoding="utf-8-sig")):
        cal[c["service_id"]] = (tuple(int(c[k]) for k in DAYS),
                                c["start_date"], c["end_date"])
    exc = defaultdict(lambda: ([], []))
    seen = set(cal)
    for e in csv.DictReader(open(d / "calendar_dates.txt", encoding="utf-8-sig")):
        day = dt.datetime.strptime(e["date"], "%Y%m%d").date()
        if e["exception_type"] == "2":
            exc[day][0].append(e["service_id"])
        else:
            exc[day][1].append(e["service_id"])
            seen.add(e["service_id"])
    for sid in seen - set(cal):
        cal[sid] = ((0,) * 7, "19000101", "29991231")
    lo = min(v[1] for v in cal.values() if v[1] != "19000101")
    hi = max(v[2] for v in cal.values() if v[2] != "29991231")
    return {"trips": trips, "trips_dir": trips_dir, "cal": cal, "exc": exc,
            "by_route": by_route, "routes": set(by_route),
            "cov": (dt.datetime.strptime(lo, "%Y%m%d").date(),
                    dt.datetime.strptime(hi, "%Y%m%d").date())}


def holiday_templates(feeds):
    """Each feed's own holiday exceptions, keyed by holiday, so a holiday in
    a year the feed does not cover still dips."""
    tmpl = defaultdict(dict)
    for name, f in feeds.items():
        for d, (rem, add) in f["exc"].items():
            h = holiday_name(d)
            if h and (rem or add):
                tmpl[name].setdefault(h, (d, set(rem), set(add)))
    return tmpl


def active_services(f, d, th, bounded):
    out = set()
    ds = d.strftime("%Y%m%d")
    for sid, (mask, start, end) in f["cal"].items():
        if mask[d.weekday()] and (not bounded or start <= ds <= end):
            out.add(sid)
    if bounded and d in f["exc"]:
        rem, add = f["exc"][d]
        out = (out - set(rem)) | set(add)
    elif th:
        _, rem, add = th
        out = (out - rem) | add
    return out


def make_sched_trips(feeds, tmpl):
    """trips(route, date) from the era feed, falling back to neighbouring eras.

    The fallback is not cosmetic. The Aug2025 feed's calendar ends 2025-12-06;
    evaluating later dates with calendar bounds matches no service at all, and
    the month's control then piles onto the handful of days that survived.
    Post-Realign routes exist in no older feed, so they would vanish outright.
    """
    order_cache = {}
    names = list(ERA_RANGES)

    def order_for(d):
        e = era_for_date(d)
        if e not in order_cache:
            i = names.index(e)
            order_cache[e] = [e] + [names[j] for dist in (1, 2)
                                    for j in (i - dist, i + dist)
                                    if 0 <= j < len(names)]
        return order_cache[e]

    def sched_trips(short, d):
        for fname in order_for(d):
            f = feeds[fname]
            if short not in f["by_route"]:
                continue
            lo, hi = f["cov"]
            bounded = lo <= d <= hi
            th = None if bounded else tmpl[fname].get(holiday_name(d) or "")
            act = active_services(f, d, th, bounded)
            n = sum(f["trips"].get((short, sid), 0) for sid in act)
            if n == 0:
                continue
            d0 = sum(f["trips_dir"].get((short, "0", sid), 0) for sid in act)
            return n, d0, fname
        return None
    return sched_trips


def reconstruct_daily(level, feeds, months):
    """Monthly control levels allocated to days in proportion to scheduled trips.

    No counter data is touched anywhere in this function. That is the whole
    point: §1.9 needs a weekly shape from a source that cannot see the sensor
    it is correcting, and a timetable is the only such source available.

        est(route, d) = level(route, month, day type)
                        * trips(route, d) / mean(trips over that month's
                                                 days of the same day type)

    which preserves the month/day-type mean exactly and lets holidays dip
    through the service level rather than through a special case.
    """
    tmpl = holiday_templates(feeds)
    sched_trips = make_sched_trips(feeds, tmpl)
    want = {(y, m) for (y, m) in months}

    # §5.3: the control ends before the counters do. Carry each route and
    # day type's last observed level forward, and flag it.
    level = dict(level)
    carried = set()
    last_ym = max((y, m) for _, y, m, _ in level)
    tail = [(y, m) for y in range(last_ym[0], CONTROL_CARRY_END[0] + 1)
            for m in range(1, 13) if last_ym < (y, m) <= CONTROL_CARRY_END]
    for (route, y, m, dtp), px in list(level.items()):
        if (y, m) != last_ym:
            continue
        for ty, tm in tail:
            if (route, ty, tm, dtp) not in level:
                level[(route, ty, tm, dtp)] = px
                carried.add((route, ty, tm, dtp))

    rows = []
    flat = 0
    for (route, y, m, dtp), px in sorted(level.items()):
        if (y, m) not in want:
            continue
        sched_route = SCHEDULE_ALIAS.get(route, route)
        ndays = calmod.monthrange(y, m)[1]
        dates = [dt.date(y, m, d) for d in range(1, ndays + 1)]
        dates = [d for d in dates
                 if ("Weekday" if d.weekday() < 5 else
                     ("Saturday" if d.weekday() == 5 else "Sunday")) == dtp]
        st = {d: sched_trips(sched_route, d) for d in dates}
        w = {d: v[0] for d, v in st.items() if v}
        src = "carried" if (route, y, m, dtp) in carried else "control"
        if w:
            wbar = sum(w.values()) / len(dates)
            for d in dates:
                v = st[d]
                n, d0 = (v[0], v[1]) if v else (0, 0)
                est = px * (w.get(d, 0) / wbar) if wbar else 0.0
                rows.append((route, pd.Timestamp(d), dtp, n, est, src))
        else:
            flat += len(dates)
            for d in dates:
                rows.append((route, pd.Timestamp(d), dtp, 0, px, src))
    rd = pd.DataFrame(rows, columns=["route", "date", "day_type",
                                     "trips_sched", "est_px", "level_source"])
    return rd, len(carried), flat


# ==========================================================================
# STAGE 6  -- stop shares for the reconstruction                      §1.10
# ==========================================================================
def learn_shares(corrected):
    """Per (route, era) stop share vectors, from reliable counter history.

    Boardings and alightings get separate vectors: a stop where everyone gets
    on is not a stop where everyone gets off, and the difference between them
    is exactly what the load view is made of.
    """
    r = corrected[corrected.reliable & (corrected.capture > MIN_CAPTURE)]
    r = r.assign(bucket=r.year.map(bucket_of))
    g = (r.groupby(["route", "bucket", "stop_id"], as_index=False)
          [["corrected_bd", "corrected_al"]].sum())
    shares, shares_al = {}, {}
    for (route, bucket), grp in g.groupby(["route", "bucket"]):
        tb, ta = grp.corrected_bd.sum(), grp.corrected_al.sum()
        if tb > 0:
            shares[(route, bucket)] = dict(zip(grp.stop_id, grp.corrected_bd / tb))
        if ta > 0:
            shares_al[(route, bucket)] = dict(zip(grp.stop_id, grp.corrected_al / ta))
    return shares, shares_al


def gtfs_pattern_stops(gtfs_dir, routes_wanted):
    """stop_code sets per route, unioned over feeds.

    stop_code, not stop_id: the five-digit identifiers in the counter feed
    join GTFS stop_code, and joining on stop_id silently matches nothing.
    """
    out = defaultdict(set)
    for era in ("Aug2025", "Dec2024", "Nov2019"):
        if not (gtfs_dir / era).exists():
            continue
        d = feed_dir(gtfs_dir / era)
        routes = {r["route_id"]: (r.get("route_short_name") or "").strip() or r["route_id"]
                  for r in csv.DictReader(open(d / "routes.txt", encoding="utf-8-sig"))}
        id2code = {s["stop_id"]: (s.get("stop_code") or s["stop_id"]).strip()
                   for s in csv.DictReader(open(d / "stops.txt", encoding="utf-8-sig"))}
        trip2route = {t["trip_id"]: routes.get(t["route_id"], t["route_id"])
                      for t in csv.DictReader(open(d / "trips.txt", encoding="utf-8-sig"))}
        for row in csv.DictReader(open(d / "stop_times.txt", encoding="utf-8-sig")):
            rt = trip2route.get(row["trip_id"])
            if rt in routes_wanted:
                out[rt].add(id2code.get(row["stop_id"], row["stop_id"]))
    return out


def map_predecessors(shares, new_stops, ref="2024-25"):
    """Which old routes' share vectors to borrow for a label with no history.

    A route renamed in the Realign has no counter history of its own, so its
    shares come from a blend of the routes whose stops it took over, weighted
    by how much of the new pattern each covers and how much of the old
    route's ridership sits on the overlap.
    """
    preds = []
    for (route, bucket), sh in shares.items():
        if bucket != ref:
            continue
        inter = new_stops & set(sh)
        recall = len(inter) / max(len(new_stops), 1)
        mass = sum(sh[s] for s in inter)
        if recall >= 0.15 and mass >= 0.15:
            preds.append((route, recall * mass))
    return sorted(preds, key=lambda x: -x[1])


def blend_shares(shares, preds, new_stops, ref="2024-25"):
    tot = sum(w for _, w in preds) or 1.0
    acc, covered = defaultdict(float), set()
    for route, w in preds:
        for stop, s in shares.get((route, ref), {}).items():
            if stop in new_stops:
                acc[stop] += (w / tot) * s
                covered.add(stop)
    vec = dict(acc)
    resid = 1.0 - sum(vec.values())
    missing = new_stops - covered
    if missing and resid > 0:
        for s in missing:
            vec[s] = resid / len(missing)
    n = sum(vec.values()) or 1.0
    return {k: v / n for k, v in vec.items()}


def backtest_shares(corrected):
    """Does a transferred share vector beat a uniform split? (§1.10)

    Learn each route's shares on odd-numbered months and score them against
    the even ones, with a uniform spread over the same stops as the control.
    """
    r = corrected[corrected.reliable & (corrected.capture > MIN_CAPTURE)]
    if r.empty:
        return None
    r = r.assign(bucket=r.year.map(bucket_of))
    g = (r.groupby(["route", "bucket", "stop_id"], as_index=False).corrected_bd.sum())
    order = list(BUCKETS)
    rows = []
    for route, grp in g.groupby("route"):
        buckets = [b for b in order if b in set(grp.bucket)]
        if len(buckets) < 2:
            # only one era of history: fall back to an odd/even month split,
            # which is easier and is reported as such
            sub = r[r.route == route]
            sub = sub.assign(h=np.where(sub.month % 2 == 1, "train", "test"))
            gg = sub.groupby(["h", "stop_id"], as_index=False).corrected_bd.sum()
            tr = gg[gg.h == "train"].set_index("stop_id").corrected_bd
            te = gg[gg.h == "test"].set_index("stop_id").corrected_bd
        else:
            tr = grp[grp.bucket == buckets[0]].set_index("stop_id").corrected_bd
            te = grp[grp.bucket == buckets[-1]].set_index("stop_id").corrected_bd
        if len(tr) < 5 or len(te) < 5 or tr.sum() <= 0 or te.sum() <= 0:
            continue
        stops = sorted(set(tr.index) | set(te.index))
        a = tr.reindex(stops).fillna(0).to_numpy() / tr.sum()
        b = te.reindex(stops).fillna(0).to_numpy() / te.sum()
        u = np.full(len(stops), 1 / len(stops))
        cos = lambda x, y: float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-12))
        wape = lambda x, y: float(np.abs(x - y).sum() / (y.sum() + 1e-12))
        rows.append((cos(a, b), cos(u, b), wape(a, b), wape(u, b)))
    if not rows:
        return None
    arr = np.array(rows)
    return dict(cos_transfer=float(np.median(arr[:, 0])),
                cos_uniform=float(np.median(arr[:, 1])),
                wape_transfer=float(np.median(arr[:, 2])),
                wape_uniform=float(np.median(arr[:, 3])), n=len(rows))


def disperse_to_stops(rd, shares, shares_al, mapping, mapping_al, carried_keys):
    """Route-day totals -> stop-days, via the share vectors.

    Done month by month and aggregated over routes as it goes. The full
    route-level product is 112 million rows over seven years, and the blend
    only ever needs it summed over routes -- except for the route-months the
    counters cannot carry at all, where the control total has to be spread
    over one route's own stops before anything is added up. Those are a few
    hundred route-months, so they are kept separately and in full.
    """
    rd = rd.assign(bucket=rd.date.dt.year.map(bucket_of))
    order = list(BUCKETS)
    cache = {}

    def vecs(route, bucket):
        k = (route, bucket)
        if k in cache:
            return cache[k]
        got = (None, None)
        for cand in (route, SPLIT.get(route)):
            if cand is None:
                continue
            if cand in mapping:
                got = (mapping[cand], mapping_al.get(cand, {}))
                break
            found = False
            for b in [bucket] + [b for b in order if b != bucket]:
                if (cand, b) in shares:
                    got = (shares[(cand, b)], shares_al.get((cand, b), {}))
                    found = True
                    break
            if found:
                break
        cache[k] = got
        return got

    arr_cache = {}

    def arrays(route, bucket):
        """(stop ids, boarding shares, alighting shares) as aligned arrays."""
        k = (route, bucket)
        if k not in arr_cache:
            sh, sh_al = vecs(route, bucket)
            if sh is None:
                arr_cache[k] = None
            else:
                stops = sorted(set(sh) | set(sh_al or {}))
                arr_cache[k] = (
                    np.array(stops, dtype=object),
                    np.array([sh.get(x, 0.0) for x in stops]),
                    np.array([(sh_al or {}).get(x, 0.0) for x in stops]))
        return arr_cache[k]

    unresolved = set()
    agg_parts, car_parts = [], []
    rd = rd[rd.trips_sched > 0]
    for ym, month_rows in rd.groupby(rd.date.dt.strftime("%Y-%m"), sort=True):
        stop_chunks, date_chunks, bd_chunks, al_chunks = [], [], [], []
        for (route, bucket), grp in month_rows.groupby(["route", "bucket"], sort=False):
            a = arrays(route, bucket)
            if a is None:
                unresolved.add(route)
                continue
            stops, sbd, sal = a
            est = grp.est_px.to_numpy()
            dates = grp.date.to_numpy()
            n_s, n_d = len(stops), len(est)
            stop_chunks.append(np.tile(stops, n_d))
            date_chunks.append(np.repeat(dates, n_s))
            bd_chunks.append((est[:, None] * sbd[None, :]).ravel())
            al_chunks.append((est[:, None] * sal[None, :]).ravel())
            if (route, int(ym[:4]), int(ym[5:7])) in carried_keys:
                car_parts.append(pd.DataFrame({
                    "route": route,
                    "stop_id": np.tile(stops, n_d),
                    "date": np.repeat(dates, n_s),
                    "est_bd": (est[:, None] * sbd[None, :]).ravel(),
                    "est_al": (est[:, None] * sal[None, :]).ravel()}))
        if not stop_chunks:
            continue
        m = pd.DataFrame({
            "stop_id": np.concatenate(stop_chunks),
            "date": np.concatenate(date_chunks),
            "est_bd": np.concatenate(bd_chunks),
            "est_al": np.concatenate(al_chunks)})
        agg_parts.append(m.groupby(["stop_id", "date"], as_index=False)
                          [["est_bd", "est_al"]].sum())
        del m, stop_chunks, date_chunks, bd_chunks, al_chunks
        gc.collect()

    agg = (pd.concat(agg_parts, ignore_index=True) if agg_parts
           else pd.DataFrame(columns=["stop_id", "date", "est_bd", "est_al"]))
    car = (pd.concat(car_parts, ignore_index=True) if car_parts
           else pd.DataFrame(columns=["route", "stop_id", "date", "est_bd", "est_al"]))
    return agg, car, unresolved


# ==========================================================================
# STAGE 7  -- the weekly blend                                    §1.9, 1.12
# ==========================================================================
def denton_run(ind, mpos, bench):
    """Proportional Denton: the smoothest set of daily ratios that still hits
    every month's benchmark exactly.

    Pro-rata distribution scales each month on its own, so the ratio of the
    final series to its indicator jumps at every month boundary and a week
    straddling one steps when service did not. Minimising the squared change
    in that ratio, subject to the month totals, removes the step without
    touching the totals.
    """
    n, M = len(ind), len(bench)
    if M == 1:
        return np.full(n, bench[0] / ind.sum())
    main = np.full(n, 2.0)
    main[0] = main[-1] = 1.0
    H = sp.diags([main, -np.ones(n - 1), -np.ones(n - 1)], [0, -1, 1])
    C = sp.csr_matrix((ind, (mpos, np.arange(n))), shape=(M, n))
    K = sp.bmat([[H, C.T], [C, None]], format="csc")
    return spla.spsolve(K, np.concatenate([np.zeros(n), bench]))[:n]


def denton_stop(shape, month, apc_m, sched_m):
    x = np.zeros_like(shape)
    r = np.zeros_like(shape)
    r_pr = np.zeros_like(shape)
    months, first = np.unique(month, return_index=True)
    Y, S = apc_m[first], sched_m[first]
    both = (S > 0) & (Y > 0)
    level = S.copy()
    if both.any():
        level[S <= 0] = Y[S <= 0] * np.median(S[both] / Y[both])
    else:
        level = Y.copy()
    fell_back = False
    live = (Y > 0) & (level > 0)
    brk = np.flatnonzero(~live | np.r_[True, np.diff(months) != 1])
    starts = np.r_[brk, len(months)]
    for a, b in zip(starts[:-1], starts[1:]):
        if not live[a]:
            a += 1
        if a >= b:
            continue
        keep = np.isin(month, months[a:b]) & (shape > 0)
        if not keep.any():
            continue
        mix = np.searchsorted(months, month[keep])
        ind = shape[keep] * level[mix]
        run_months = np.unique(mix)
        pos = np.searchsorted(run_months, mix)
        ind_sum = np.bincount(pos, weights=ind)
        pro = (Y[run_months] / ind_sum)[pos]
        rr = denton_run(ind, pos, Y[run_months])
        if (rr < 0).any() or not np.isfinite(rr).all():
            rr, fell_back = pro, True
        x[keep] = ind * rr
        r[keep] = rr
        r_pr[keep] = pro
    return x, r, r_pr, fell_back


def weekly_blend(corrected, fac, sched_agg, sched_car):
    """Shape from both sources, level from the control alone.

    Within each stop-month, with a the counter series, s the schedule-only
    reconstruction and w the stop-month's reliable share:

        value_d = [ w * a_d/A_m + (1-w) * s_d/S_m ] * A_m

    Both shape terms sum to one across the month, so the month total is
    exactly A_m whatever w is: the reconstruction contributes shape and never
    level, and the calibration of §1.7 survives byte for byte. Where the
    counters were healthy the real weekly signal passes through untouched;
    where they collapsed the schedule carries the week.
    """
    f = fac.set_index(["route", "y", "m"])
    c = corrected.assign(y=corrected.year, m=corrected.month)
    c = c.join(f[["factor", "mode"]], on=["route", "y", "m"])
    c["factor"] = c["factor"].fillna(1.0)
    c["mode"] = c["mode"].fillna("apc")
    live = c[c["mode"] == "apc"]
    apc = (live.assign(bd=live.corrected_bd * live.factor,
                       al=live.corrected_al * live.factor)
               .assign(bdr=lambda d: np.where(d.reliable, d.bd, 0.0),
                       alr=lambda d: np.where(d.reliable, d.al, 0.0))
               .groupby(["stop_id", "service_date"], as_index=False)
               [["bd", "al", "bdr", "alr"]].sum())

    # route-months the counters cannot carry: take the reconstruction's stop
    # distribution and scale it to the control, wholly imputed
    carried_f = fac[(fac["mode"] == "schedule") & (fac.pra > 0)]
    sd = sched_car.assign(y=sched_car.date.dt.year, m=sched_car.date.dt.month) \
        if len(sched_car) else sched_car.assign(y=[], m=[])
    car = sd.merge(carried_f[["sched_route", "y", "m", "pra"]],
                   left_on=["route", "y", "m"],
                   right_on=["sched_route", "y", "m"], how="inner") \
        if len(sd) else sd.assign(pra=[])
    if len(car):
        tot = car.groupby(["route", "y", "m"])[["est_bd", "est_al"]].transform("sum")
        car = car.assign(bd=car.est_bd / tot.est_bd.replace(0, np.nan) * car.pra,
                         al=car.est_al / tot.est_al.replace(0, np.nan) * car.pra)
        car = (car.dropna(subset=["bd"])
                  .groupby(["stop_id", "date"], as_index=False)[["bd", "al"]].sum()
                  .rename(columns={"date": "service_date"}))
        car["bdr"] = 0.0
        car["alr"] = 0.0
        apc = pd.concat([apc, car], ignore_index=True)
        apc = apc.groupby(["stop_id", "service_date"], as_index=False).sum()
        carried_by_month = (car.assign(mid=car.service_date.dt.year * 12
                                       + car.service_date.dt.month)
                               .groupby("mid").bd.sum())
    else:
        carried_by_month = pd.Series(dtype=float)

    sch = (sched_agg.groupby(["stop_id", "date"], as_index=False)
           [["est_bd", "est_al"]].sum().rename(columns={"date": "service_date"}))

    j = apc.merge(sch, on=["stop_id", "service_date"], how="outer").fillna(0.0)
    j["mid"] = j.service_date.dt.year * 12 + j.service_date.dt.month
    m = (j.groupby(["stop_id", "mid"], as_index=False)
          .agg(A_bd=("bd", "sum"), A_al=("al", "sum"),
               A_bdr=("bdr", "sum"), A_alr=("alr", "sum"),
               S_bd=("est_bd", "sum"), S_al=("est_al", "sum")))
    j = j.merge(m, on=["stop_id", "mid"], how="left")

    w = np.where(j.A_bd > 0, j.A_bdr / j.A_bd.replace(0, np.nan), 1.0)
    j["w"] = np.nan_to_num(w, nan=1.0)
    w_al = np.where(j.A_al > 0, j.A_alr / j.A_al.replace(0, np.nan), 1.0)
    j["w_al"] = np.nan_to_num(w_al, nan=1.0)

    def shape(num_a, den_a, num_s, den_s, weight):
        a = np.where(den_a > 0, num_a / np.where(den_a > 0, den_a, 1), 0.0)
        s = np.where(den_s > 0, num_s / np.where(den_s > 0, den_s, 1), a)
        return np.where(den_a > 0, weight * a + (1 - weight) * s, 0.0)

    j["shape_bd"] = shape(j.bd.to_numpy(), j.A_bd.to_numpy(),
                          j.est_bd.to_numpy(), j.S_bd.to_numpy(), j.w.to_numpy())
    j["shape_al"] = shape(j.al.to_numpy(), j.A_al.to_numpy(),
                          j.est_al.to_numpy(), j.S_al.to_numpy(), j.w_al.to_numpy())

    j = j[(j.shape_bd > 0) | (j.shape_al > 0)].sort_values(["stop_id", "service_date"])
    stop = j.stop_id.to_numpy()
    edges = np.r_[0, np.flatnonzero(stop[1:] != stop[:-1]) + 1, len(stop)]
    bd = np.zeros(len(stop))
    al = np.zeros(len(stop))
    mid = j.mid.to_numpy()
    fallbacks = 0
    jump_pr, jump_dn = [], []
    cols = {c: j[c].to_numpy() for c in
            ("shape_bd", "shape_al", "A_bd", "A_al", "S_bd", "S_al")}
    for a, b in zip(edges[:-1], edges[1:]):
        s = slice(a, b)
        for out, sh, A, S in ((bd, "shape_bd", "A_bd", "S_bd"),
                              (al, "shape_al", "A_al", "S_al")):
            x, r, r_pr, fb = denton_stop(cols[sh][s], mid[s],
                                         cols[A][s], cols[S][s])
            out[s] = x
            fallbacks += fb
            if sh == "shape_bd":
                liv = (r > 0) & (r_pr > 0)
                bnd = np.flatnonzero((np.diff(mid[s]) == 1) & liv[1:] & liv[:-1])
                if len(bnd):
                    jump_pr.append(float(np.abs(np.log(r_pr[bnd + 1] / r_pr[bnd])).mean()))
                    jump_dn.append(float(np.abs(np.log(r[bnd + 1] / r[bnd])).mean()))

    wv, wa = j.w.to_numpy(), j.w_al.to_numpy()
    out = pd.DataFrame({
        "stop_id": j.stop_id.to_numpy(), "service_date": j.service_date.to_numpy(),
        "bd_real": bd * wv, "bd_imp": bd * (1 - wv),
        "al_real": al * wa, "al_imp": al * (1 - wa),
    })
    return out[(bd > 0) | (al > 0)], fallbacks, jump_pr, jump_dn, carried_by_month


# ==========================================================================
# STAGE 8  -- validation                                          §1.3-1.9
# ==========================================================================
def pct(x):
    return "n/a" if x is None or not np.isfinite(x) else f"{x:+.1f}%"


def check_alighting_transfer(corrected):
    """§1.5: the correction is one scalar per cell, so it must transfer to
    alightings. Flat al/bd across capture deciles is the evidence."""
    # NB: no raw_bd > 0 filter. A terminal stop where everyone alights has
    # zero boardings and large alightings; dropping those rows would bias the
    # ratio far below 1 and destroy the very flatness being tested.
    c = corrected[corrected.capture > 0]
    if c.empty:
        return None
    d = pd.qcut(c.capture, 10, labels=False, duplicates="drop")
    g = c.groupby(d).agg(bd=("raw_bd", "sum"), al=("raw_al", "sum"),
                         load=("load_sum", "sum"), ev=("n_events", "sum"))
    g["ratio"] = g.al / g.bd
    g["mean_load"] = g.load / g.ev.replace(0, np.nan)
    return g


def weekly_volatility(daily, value_col, group_col="stop_id"):
    """Within-month week-to-week coefficient of variation of system totals."""
    d = daily.copy()
    iso = d.service_date.dt.isocalendar()
    d["iso"] = iso.year.astype(int) * 100 + iso.week.astype(int)
    # a week belongs to the month holding its Thursday (the ISO rule), so
    # every week counted is a whole week and month edges do not masquerade
    # as collapses in service
    thu = d.service_date + pd.to_timedelta(3 - d.service_date.dt.dayofweek, unit="D")
    d["year"] = thu.dt.year
    d["mid"] = thu.dt.year * 12 + thu.dt.month
    wk = d.groupby(["year", "mid", "iso"], as_index=False)[value_col].sum()
    out = []
    for (y, mid), g in wk.groupby(["year", "mid"]):
        v = g[value_col].to_numpy()
        v = v[v > 0]
        if len(v) < 3:
            continue
        out.append((y, float(v.std(ddof=0) / v.mean()), float(v.max() / v.min())))
    if not out:
        return None
    df = pd.DataFrame(out, columns=["year", "cv", "ratio"])
    return df.groupby("year").agg(mean_cv=("cv", "mean"), worst=("ratio", "max"))


def uptime_correlation(trip_cal, rd):
    """§1.8: in 2019 the reported number tracked the sensors, not the riders.

    Both series have to be measured against something the sensor cannot move.
    Uptime is productive trips over *scheduled* trips, the schedule coming
    from the reconstruction (GTFS x the control, no counter data anywhere);
    counting observed trips in the denominator instead would divide the
    sensor's collapse out of the very quantity being tested. The scheduled
    trip count is that same sensor-free series, and its near-zero correlation
    with reported ridership is the point: service was flat while the reported
    number swung.
    """
    t = trip_cal.copy()
    thu = t.service_date + pd.to_timedelta(3 - t.service_date.dt.dayofweek, unit="D")
    t["year"], t["iso"] = thu.dt.year, thu.dt.strftime("%G-%V")
    g = t.groupby(["year", "iso"]).agg(n_prod=("productive", "sum"), bd=("bd", "sum"))

    r = rd.copy()
    thu_r = r.date + pd.to_timedelta(3 - r.date.dt.dayofweek, unit="D")
    r["year"], r["iso"] = thu_r.dt.year, thu_r.dt.strftime("%G-%V")
    sched = r.groupby(["year", "iso"]).trips_sched.sum().rename("sched")

    g = g.join(sched, how="inner")
    g = g[g.sched > 0]
    g["uptime"] = g["n_prod"] / g["sched"]
    out = {}
    for y, grp in g.groupby("year"):
        if len(grp) < 8:
            continue
        out[int(y)] = (float(grp.uptime.corr(grp.bd)),
                       float(grp["sched"].corr(grp.bd)), len(grp),
                       float(grp["sched"].mean()))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, help="dir of raw_YYYY_MM.parquet event files")
    ap.add_argument("--aggregates", type=Path,
                    help="dir of trip_/stopal_ parquet; skips stage 1")
    ap.add_argument("--gtfs", type=Path, required=True, help="dir of GTFS era feeds")
    ap.add_argument("--control", type=Path, required=True, help="the PRA xlsx")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--months", help="comma-separated YYYY-MM; default is all found")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    src = args.raw or args.aggregates
    if src is None:
        ap.error("one of --raw or --aggregates is required")
    pat = "raw_*.parquet" if args.raw else "trip_*.parquet"
    found = sorted(int(x) * 100 + int(y) for x, y in
                   (re.search(r"_(\d{4})_(\d{2})\.parquet$", p.name).groups()
                    for p in src.glob(pat)))
    months = [(k // 100, k % 100) for k in found]
    if args.months:
        want = {tuple(int(v) for v in s.split("-")) for s in args.months.split(",")}
        months = [ym for ym in months if ym in want]
    if not months:
        ap.error(f"no months found in {src}")

    head("AC Transit imputation, end to end")
    print(f"source      : {src}")
    print(f"months      : {len(months)}  "
          f"({months[0][0]}-{months[0][1]:02d} .. {months[-1][0]}-{months[-1][1]:02d})")
    print(f"gtfs        : {sorted(p.name for p in args.gtfs.iterdir() if p.is_dir())}")
    print(f"control     : {args.control.name}")

    # ---------------- stage 1 ----------------
    if args.raw:
        head("STAGE 1  events -> trips and stop-days                       (§1.2)")
        stats = []
        for (y, m) in months:
            p = args.raw / f"raw_{y}_{m:02d}.parquet"
            s = stage1_extract(p, args.out, (y, m))
            stats.append(s)
            say(f"{s['ym']}: {s['events']:>9,} events -> {s['trips']:>7,} trips, "
                f"{s['stop_rows']:>8,} stop-days, {s['bd']:>10,.0f} boardings")
        st = pd.DataFrame(stats)
        print(f"\ntotal        : {st.events.sum():,} events, {st.trips.sum():,} trips, "
              f"{st.bd.sum():,.0f} raw boardings")
        print(f"null stop_id : {st.null_stop_bd.sum() / st.bd.sum():.2%} of boardings "
              f"(page says ~1.5%; dropped from every stop-level product)")
        agg_dir = args.out
    else:
        agg_dir = args.aggregates

    trip, stop = load_aggregates(agg_dir, months)
    say(f"loaded {len(trip):,} trip rows and {len(stop):,} stop-day rows")

    # ---------------- stage 2 ----------------
    head("STAGE 2  capture fractions and reliability gates          (§1.3-1.6)")
    cap, trip_cal = build_capture(trip)
    cap.to_parquet(args.out / "capture_table.parquet", index=False)
    dead = 1 - trip_cal.productive.mean()
    print(f"dead counters      : {dead:.1%} of trips report zero boardings "
          f"first stop to last")
    print(f"                     page says ~27%, which is the Nov 2019 diagnosis "
          f"sample; it runs\n                     2.9% to 37% by route and "
          f"11.7% over the whole 2019-2026 feed")
    print(f"capture fraction   : median {cap.capture.median():.3f}, "
          f"p10 {cap.capture.quantile(.1):.3f}, p90 {cap.capture.quantile(.9):.3f} "
          f"over cells")
    print(f"gates              : capture>={MIN_CAPTURE} {100*(cap.capture>=MIN_CAPTURE).mean():.1f}% pass, "
          f"stability>={MIN_STABILITY} {100*(cap.stability>=MIN_STABILITY).mean():.1f}%, "
          f"presence>={MIN_PRESENCE} {100*(cap.presence>=MIN_PRESENCE).mean():.1f}%")
    print(f"reliable cells     : {cap.reliable.mean():.1%} of "
          f"{len(cap):,} (route, direction, month, day type) cells")
    print(cap.groupby("day_type").reliable.mean().round(3).to_string())

    # ---------------- stage 3 ----------------
    head("STAGE 3  the ratio estimator                                   (§1.5)")
    corrected = apply_capture(stop, cap)
    say(f"corrected {len(corrected):,} stop-route-day rows")
    print(f"raw boardings      : {corrected.raw_bd.sum():,.0f}")
    print(f"corrected          : {corrected.corrected_bd.sum():,.0f} "
          f"({corrected.corrected_bd.sum() / corrected.raw_bd.sum():.2f}x)")
    seen = (corrected.groupby(["year", "month"])
            .apply(lambda g: g.raw_bd.sum() / g.corrected_bd.sum(),
                   include_groups=False))
    print(f"boardings seen     : {seen.min():.0%} to {seen.max():.0%} by month "
          f"(page: 19-90% across the full feed)")
    g = check_alighting_transfer(corrected)
    if g is not None:
        print("\nal/bd ratio by capture decile -- flat means the one scalar per cell")
        print("transfers to alightings untouched (page: 0.9935 to 1.0054):")
        print(f"  ratio      min {g.ratio.min():.4f}  max {g.ratio.max():.4f}")
        print(f"  mean load  bottom decile {g.mean_load.iloc[0]:.2f} vs "
              f"top {g.mean_load.iloc[-1]:.2f}  <- why load is not scaled")

    # ---------------- stage 4 ----------------
    head("STAGE 4  the control, per route-month                           (§1.7)")
    control_all, level, dedup_pct, n_drop = load_control(args.control)
    run_months = {(y, m) for y, m in months}
    control = control_all[[(r.y, r.m) in run_months
                           for r in control_all.itertuples()]].copy()
    print(f"control            : {len(control_all):,} route-months total, "
          f"{len(control):,} in the months being run "
          f"({control.pra.sum():,.0f} boardings)")
    print(f"split-family dedup : {n_drop} rows, {dedup_pct:.1f}% removed  (page: ~4.3%)")
    fac = route_month_factors(corrected, control)
    fac.to_parquet(args.out / "route_month_factor.parquet", index=False)
    tab = fac.groupby(["mode", "kind"]).agg(n=("factor", "size"),
                                            control_bd=("pra", "sum")).round(0)
    print("\nfour cases (page, full history: 9,719 / 880 / 325 / 250):")
    print(tab.to_string())
    ap_f = fac[fac["mode"] == "apc"]
    print(f"\nfactor (matched)   : median {ap_f.factor.median():.2f}, "
          f"p10 {ap_f.factor.quantile(.1):.2f}, p90 {ap_f.factor.quantile(.9):.2f}")

    # ---------------- stage 5 ----------------
    head("STAGE 5  schedule-only reconstruction                          (§1.10)")
    feeds = {}
    for d in sorted(p for p in args.gtfs.iterdir() if p.is_dir()):
        feeds[d.name] = load_feed(d)
        lo, hi = feeds[d.name]["cov"]
        print(f"  feed {d.name:<8} {len(feeds[d.name]['routes']):>3} routes, "
              f"service window {lo} -> {hi}")
    rd, n_carried, n_flat = reconstruct_daily(level, feeds, months)
    rd.to_parquet(args.out / "route_day_sched.parquet", index=False)
    print(f"\nroute-days         : {len(rd):,} over {rd.route.nunique()} routes")
    print(f"carried levels     : {n_carried} route/day-type levels past the "
          f"control's end   (§5.3)")
    print(f"flat-allocated     : {n_flat} route-days with no schedule anywhere")

    # §1.3's claim: the recovered slot count matches GTFS inside its window
    st_fn = make_sched_trips(feeds, holiday_templates(feeds))
    chk = []
    for (route, bit, y, m, dtp), den in zip(
            zip(cap.route, cap.bit, cap.year, cap.period, cap.day_type), cap.den):
        if bit != 0 or den <= 0:
            continue
        era = era_for_date(dt.date(y, m, 15))
        lo, hi = feeds[era]["cov"] if era in feeds else (None, None)
        if lo is None or not (lo <= dt.date(y, m, 15) <= hi):
            continue
        d = next((dt.date(y, m, k) for k in range(1, 29)
                  if (("Weekday" if dt.date(y, m, k).weekday() < 5 else
                       ("Saturday" if dt.date(y, m, k).weekday() == 5 else "Sunday"))
                      == dtp) and not holiday_name(dt.date(y, m, k))), None)
        if d is None:
            continue
        v = st_fn(route, d)
        if v and v[0] > 0:
            # cap.den counts one direction's slots; GTFS counts both
            chk.append(den * 2 / v[0] - 1)
    if chk:
        print(f"\nschedule-free denominator vs GTFS, inside the feed's own window:")
        print(f"  median error {np.median(chk):+.1%} over {len(chk)} route-months "
              f"(page: median 0%)")

    # ---------------- stage 6 ----------------
    head("STAGE 6  stop shares for the reconstruction                    (§1.10)")
    shares, shares_al = learn_shares(corrected)
    print(f"share vectors      : {len(shares)} route-era (boardings), "
          f"{len(shares_al)} (alightings)")
    bt = backtest_shares(corrected)
    if bt:
        print(f"backtest           : cosine {bt['cos_transfer']:.2f} vs "
              f"{bt['cos_uniform']:.2f} uniform, WAPE {bt['wape_transfer']:.2f} vs "
              f"{bt['wape_uniform']:.2f}  ({bt['n']} routes)")
        print(f"                     page: cosine 0.73-0.95 vs 0.21, "
              f"WAPE 0.36-0.72 vs 1.63")
    apc_labels = {r for r, _ in shares}
    new_labels = sorted({r for (r, _, _, _) in level} - apc_labels)
    mapping, mapping_al = {}, {}
    if new_labels:
        patterns = gtfs_pattern_stops(args.gtfs, set(new_labels) | {"1T"})
        for nl in new_labels:
            ns = patterns.get(nl, set())
            if not ns:
                continue
            preds = map_predecessors(shares, ns)
            if not preds:
                continue
            mapping[nl] = blend_shares(shares, preds, ns)
            mapping_al[nl] = blend_shares(shares_al, preds, ns)
            print(f"  {nl:<5} {len(ns):>3} stops <- "
                  + ", ".join(f"{r}({w / sum(x for _, x in preds):.0%})"
                              for r, w in preds[:4]))
    carried_keys = {(r.sched_route, r.y, r.m)
                    for r in fac[fac["mode"] == "schedule"].itertuples()}
    sched_agg, sched_car, unresolved = disperse_to_stops(
        rd, shares, shares_al, mapping, mapping_al, carried_keys)
    say(f"schedule stop-days : {len(sched_agg):,} rows (summed over routes), "
        f"{sched_agg.est_bd.sum():,.0f} boardings")
    if unresolved:
        print(f"unresolvable       : {sorted(unresolved)[:10]}")

    # ---------------- stage 7 ----------------
    head("STAGE 7  the weekly blend                                 (§1.9, 1.12)")
    blended, fallbacks, jpr, jdn, carried_m = weekly_blend(
        corrected, fac, sched_agg, sched_car)
    blended.to_parquet(args.out / "stop_day_blended.parquet", index=False)
    say(f"blended {len(blended):,} stop-days")
    tot = blended.bd_real.sum() + blended.bd_imp.sum()
    print(f"boardings          : {tot:,.0f}  "
          f"({blended.bd_imp.sum() / tot:.1%} imputed)")
    if jpr:
        print(f"month-boundary jump: pro-rata {np.expm1(np.median(jpr)):.1%} -> "
              f"Denton {np.expm1(np.median(jdn)):.2%}")
    print(f"pro-rata fallbacks : {fallbacks} stop-measure series")

    # ---------------- stage 8 ----------------
    head("STAGE 8  validation                                       (§1.3-1.9)")

    # mean preservation: the month total must be untouched by the blend
    b = blended.assign(mid=blended.service_date.dt.year * 12
                       + blended.service_date.dt.month)
    bm = b.groupby("mid").apply(lambda g: g.bd_real.sum() + g.bd_imp.sum(),
                                include_groups=False)
    c = corrected.assign(mid=corrected.year * 12 + corrected.month)
    c = c.join(fac.set_index(["route", "y", "m"])[["factor", "mode"]],
               on=["route", "year", "month"])
    c["factor"] = c["factor"].fillna(1.0)
    c["mode"] = c["mode"].fillna("apc")
    am = (c[c["mode"] == "apc"].assign(v=lambda d: d.corrected_bd * d.factor)
           .groupby("mid").v.sum())
    am = am.add(carried_m, fill_value=0)
    both = pd.concat([bm.rename("blend"), am.rename("apc")], axis=1).dropna()
    both["ratio"] = both.blend / both.apc
    print("§1.9 mean preservation -- the blend moves shape, never level")
    print(f"  month total ratio  min {both.ratio.min():.6f}  "
          f"max {both.ratio.max():.6f}   (must be 1.0)")

    # what the control asked for but nothing could carry: route-months whose
    # label has no counter history and no usable predecessor shares
    want_car = (fac[fac["mode"] == "schedule"].assign(mid=lambda d: d.y * 12 + d.m)
                   .groupby("mid").pra.sum())
    placed = float(carried_m.sum()) if len(carried_m) else 0.0
    if want_car.sum() > 0:
        print(f"  schedule-carried   {placed:,.0f} of {want_car.sum():,.0f} "
              f"control boardings placed ({placed / want_car.sum():.1%}); the rest "
              f"is\n                     route-months with no share vector to "
              f"disperse them over")

    # calibration against the control
    print("\n§1.7 calibration against the control")
    # the end-to-end comparison: everything the blend produced for a month,
    # against everything the control says that month carried
    site = bm.rename("site")
    ctl = (control.assign(mid=control.y * 12 + control.m)
                  .groupby("mid").pra.sum().rename("control"))
    cmp = pd.concat([site, ctl], axis=1).dropna()
    if len(cmp):
        err = (cmp.site / cmp.control - 1) * 100
        print(f"  months compared    {len(cmp)}")
        print(f"  median error       {err.median():+.2f}%   (page: +0.5%)")
        print(f"  within +/-2.3%     {(err.abs() <= 2.3).sum()} of {len(err)}"
              f"   (page: 83 of 85)")

    # weekly volatility, before and after
    print("\n§1.9 within-month weekly volatility of system boardings")
    raw_daily = (corrected.groupby("service_date", as_index=False)
                 .agg(raw=("raw_bd", "sum")))
    before = weekly_volatility(raw_daily.assign(stop_id="x"), "raw")
    after_src = (blended.assign(v=blended.bd_real + blended.bd_imp)
                 .groupby("service_date", as_index=False).v.sum())
    after = weekly_volatility(after_src.assign(stop_id="x"), "v")
    if before is not None and after is not None:
        j = before.join(after, lsuffix="_before", rsuffix="_after")
        j.columns = ["mean CV before", "worst before", "mean CV after", "worst after"]
        print(j.round(3).to_string())
        print("  page, 2019: 0.231 / 29.0x  ->  0.090 / 2.8x")

    # what the raw weekly number was actually measuring
    print("\n§1.8 what the uncorrected weekly number tracks")
    uc = uptime_correlation(trip_cal, rd)
    if uc:
        print("  year   corr(uptime, reported)   corr(scheduled trips, reported)"
              "   weeks   mean trips/wk")
        for y, (a, bq, n, sc) in sorted(uc.items()):
            print(f"  {y}        {a:+.3f}                   {bq:+.3f}"
                  f"                        {n:>3}   {sc:>10,.0f}")
        print("  page, 2019: +0.391 and -0.011, on ~46,600 scheduled trips a week")

    # imputed share, which is what the app shows in gold
    print("\n§1.12 observed / imputed split")
    by_year = b.assign(year=b.service_date.dt.year).groupby("year").agg(
        real=("bd_real", "sum"), imp=("bd_imp", "sum"))
    by_year["imputed %"] = 100 * by_year.imp / (by_year.real + by_year.imp)
    print(by_year.round(1).to_string())

    summary = {
        "months": [f"{y}-{m:02d}" for y, m in months],
        "dead_counter_share": float(dead),
        "reliable_cell_share": float(cap.reliable.mean()),
        "raw_boardings": float(corrected.raw_bd.sum()),
        "corrected_boardings": float(corrected.corrected_bd.sum()),
        "final_boardings": float(tot),
        "imputed_share": float(blended.bd_imp.sum() / tot),
        "month_total_ratio": [float(both.ratio.min()), float(both.ratio.max())],
        "runtime_s": round(time.time() - T0, 1),
    }
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2))
    head(f"done in {time.time() - T0:.0f}s -> {args.out}")


if __name__ == "__main__":
    main()
