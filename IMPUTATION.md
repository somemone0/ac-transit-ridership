# How imputation works

Every ridership figure on this site is built from three sources by four
methods. This document says what each source contains, which method runs in
which case, and the equation each method applies.

Notation throughout: route `r`, direction `u`, month `m`, day type `τ`
(weekday / Saturday / Sunday), stop `s`, service day `d`, week `w`.

---

## 1. The sources

| | What it is | Grain | Read by |
| --- | --- | --- | --- |
| **Trip-PRA** | The event dataset, ~50 GB raw, obtained under a public records request. Published as a 5.9 GB extract. | One row per door-open: route, trip start time, stop, boardings, alightings, direction bit | `replicate/extract_month_al.py` |
| **Route-PRA** | `PRA 26-48.xlsx`, a second records request. 22,731 rows, 85 months. | route × month × day type → `Daily Px` (average daily passengers) | `vis/build_pra_calibration.py:load_pra` |
| **GTFS** | Three signup feeds: Nov 2019, Dec 2024, Aug 2025. | Stop sequences, shapes, service calendars with holiday exceptions | `vis/reconstruct_daily.py:load_feed` |

None of the three is sufficient alone:

- Trip-PRA knows where and when every counted rider boarded, and undercounts
  by between 10% and 81% depending on the month.
- Route-PRA knows how many rode, and only per route per month per day type.
- GTFS knows what service was scheduled, and nothing about riders.

Trip-PRA has no trip identifier and no direction column. Both are recovered
from fields that carry them incidentally: `route_id` is the trip's scheduled
start time as `HHMM`, and the low bit of the vehicle's door-and-lift flag
separates the two buses leaving on the same minute in opposite directions.

```
trip = (route, service_date, route_id, u)        u = door_lift_flags mod 2
```

Stop ids in Trip-PRA are five digits and join GTFS `stop_code`, not
`stop_id`. Joining on the wrong column matches nothing and raises no error.

---

## 2. Which method runs

`vis/build_pra_calibration.py` outer-joins Trip-PRA against Route-PRA per
route-month and writes a `mode` column. That branch decides everything
downstream.

| Case | Condition | Route-months | Mode | Methods |
| --- | --- | ---: | --- | --- |
| **A** | Label in both sources | 9,719 | `apc` | 1 → 2 → 4 |
| **B** | Trip-PRA rows, no Route-PRA row | 880 | `apc` | 1 → 2 → 4 |
| **C** | Route-PRA row, no Trip-PRA rows | 325 | `schedule` | 3 |
| **D** | Trip-PRA rows too thin (>5× stretch) | 250 | `schedule` | 3 |

Case D exists because some May–July 2019 route-months needed factors between
500 and 1700 to reach the control. Scaling a handful of surviving events into
a month of ridership is worse than modelling the month, so those go to
method 3.

Within cases A and B, each cell `(r, u, m, τ)` is separately marked reliable
or not, and that flag sets how much of method 3's shape method 4 mixes in.

---

## 3. Method 1 — capture correction

**Source: Trip-PRA alone. Runs in cases A and B.**
**Code: `replicate/build_capture.py`, `replicate/build_final.py`.**

Corrects for trips whose counter reported nothing. Two counts per cell, both
taken from Trip-PRA itself:

```
N = number of distinct route_id seen in cell (r, u, m, τ)     holidays removed first
G = number of those trips that reported at least one boarding
```

`N` is the operated-trip universe. It is derived from the data rather than
from GTFS because a feed applied outside its own signup counts COVID-cut and
summer-school service that never ran — that implies 24–41% annual uptime
against 82% measured inside the feed's coverage window. **GTFS enters here
only as a check**: `build_capture.py` validated `N` against the feed inside
its coverage window at a median 0% error.

`G < N` because a trip reporting zero boardings from first stop to last is a
dead counter, not an empty bus. About 27 of every 100 trips are like this.

```
ĉ(r,u,m,τ) = G / N

b̃(s,d) = b_raw(s,d) / ĉ(r,u,m,τ)
```

One scalar per cell, applied to every stop and every day inside it. Because
it is a pure multiplicative factor it transfers to alightings unchanged —
checked, not assumed: the alightings-to-boardings ratio is flat across all
ten capture deciles (0.9935 to 1.0054 over 32 M boardings).

Onboard load is **not** scaled. It is an intensive per-event mean, so
multiplying it by `1/ĉ` has no meaning. Section load is reconstructed instead
as cumulative `bd − al` along the stop sequence.

Three gates then mark the cell:

```
reliable  =  ĉ ≥ 0.4
         AND  N / N̄(r,u) ≥ 0.7          trip count not 30% below normal
         AND  days_served / days_of_τ ≥ 0.7
```

A failing cell still gets its `b̃`. The flag is what becomes the imputed share
in method 4.

---

## 4. Method 2 — level from Route-PRA

**Source: Route-PRA. Runs in cases A and B.**
**Code: `vis/build_pra_calibration.py`.**

Route-PRA publishes an average per day type, so `load_pra` multiplies by the
number of days of that type in the month before summing:

```
C(r,m) = Σ_τ  Daily_Px(r,m,τ) × n_τ(m)
```

The factor is then per route-month:

```
k(r,m) = C(r,m) / Σ_{s, d ∈ m} b̃(s,d)

b̂(s,d) = k(r,m) · b̃(s,d)
```

- **Case A** — `k = pra / apc` for that route-month directly.
- **Case B** — no control row exists, so `k` is that month's volume-weighted
  mean `k` across the routes that did match. Mostly 2026-02 to 2026-05, past
  the end of the control.

After this step the counters set no route's monthly level. They decide only
how that level is distributed: across stops, days, direction, and the
observed/imputed split.

Result: 83 of the 85 months the control covers land within ±2.3% of it,
median +0.5%. The exceptions are 2019-06 (−6.3%) and 2019-07 (−6.6%), where
neither source fully covers the month.

---

## 5. Method 3 — schedule reconstruction

**Sources: Route-PRA for level, GTFS for shape, Trip-PRA for stop shares.
Runs in cases C and D, and supplies shape to method 4 everywhere.**
**Code: `vis/reconstruct_daily.py`, `vis/stop_distribution.py`.**

No counter data enters the level. This is the estimate that method 4 borrows
shape from, which is only possible because it cannot see the sensor at all.

### 5.1 Route to day

`T(r,d)` is the number of trips scheduled on calendar date `d`, expanded from
the nearest era's GTFS calendar with holiday exceptions applied.

```
T̄(r,m,τ) = mean of T(r,d) over the dates of type τ in month m

est_px(r,d) = Daily_Px(r,m,τ(d)) × T(r,d) / T̄(r,m,τ)
```

The mean over each day type in the month is preserved exactly, and holidays
dip through the service level rather than being special-cased. Where no
schedule exists for the route at all, the allocation is flat:
`est_px = Daily_Px`.

### 5.2 Day to stop

Share vectors are learned from **reliable Trip-PRA rows only**, per
(route, era bucket), normalised to sum to 1:

```
est_boardings(r,s,d)  = est_px(r,d) × σ_bd(r,s)
est_alightings(r,s,d) = est_px(r,d) × σ_al(r,s)
```

Boarding and alighting vectors are learned separately, because a stop where
everyone boards is not a stop where everyone alights.

A route label with no Trip-PRA history gets a predecessor blend matched by
GTFS stop overlap — 9 from 10/99/801, 22 from 29/7/51B, 27 from 79/7/51B,
1T from "1", school trippers by cross-era GTFS match. Backtested against a
uniform spread, the transfer wins decisively: cosine similarity 0.73–0.95
against 0.21, WAPE 0.36–0.72 against 1.63.

---

## 6. Method 4 — weekly blend

**Mixes methods 1 and 3. Runs in cases A and B.**
**Code: `vis/build_weekly_blend.py`.**

Methods 1 and 2 are both estimated at month grain. The site displays weeks,
and within a month `ĉ` and `k` are constants, so the weekly values would sit
proportional to the raw counts — and the raw counts track how many counters
were working that week.

Measured on 2019 weekly system totals:

```
corr(sensor uptime,   reported ridership) =  0.391
corr(scheduled trips, reported ridership) = -0.011
```

Week 18 of 2019 recovered 39.6% of its trips and reported 1.62 M boardings.
Week 20 recovered 5.3% and reported 0.16 M. Scheduled service across those
weeks was flat at about 46,600 trips. In the worst month the busiest week
came out 29× the quietest.

The fix takes the shape of the week from method 3 and keeps the level from
method 2. Per (stop, month), with `a` the APC series and `σ` the
reconstruction:

```
w = the stop-month's reliable share

shape_d = w · a_d/A_m  +  (1 − w) · σ_d/Σ_m
value_d = shape_d × A_m
```

Both shape terms sum to 1 across the month, so

```
Σ_{d ∈ m} value_d = [w + (1 − w)] · A_m = A_m
```

The month total is untouched, method 2's calibration still holds exactly, and
the reconstruction contributes shape only — it is never added to the counter
series. Where the counters were healthy (`w → 1`) the measured weekly signal
survives unchanged. Where they collapsed (`w → 0`) the week is carried by the
schedule.

| Within-month weekly volatility | Before (CV / worst) | After (CV / worst) |
| --- | --- | --- |
| 2019 | 0.231 / 29.0× | 0.090 / 2.8× |
| 2020 | 0.103 / 5.2× | 0.081 / 3.6× |
| 2021–2025 | ~0.06 / ~1.7× | ~0.06 / ~1.5× |

### 6.1 Month boundaries

Scaling each month on its own is pro-rata distribution, which makes the ratio
of the series to its indicator jump at every month boundary; weeks that
straddle one step when service did not. `build_weekly_blend.py` finishes with
the proportional Denton method, per stop:

```
indicator_d = shape_d × Σ_m                  continuous across months
value_d     = indicator_d × r_d

minimise  Σ_d (r_d − r_{d−1})²
subject to  Σ_{d ∈ m} value_d = A_m
```

Month totals hold exactly, the within-month shape still comes from the blend,
and the level moves smoothly from one month into the next.

---

## 7. What "imputed" means

`w` doubles as the disclosure split:

```
observed(s,d) = w · value_d          imputed(s,d) = (1 − w) · value_d
```

The interface renders these as `Total (imputed)` with the imputed figure in
gold. It is a continuous share of a reliability-weighted blend. It is not a
confidence interval.

Cases C and D carry `w = 0` throughout and are 100% imputed.

### Counts

Of the 11,114 route-months carrying any ridership:

| | Route-months | Share |
| --- | ---: | ---: |
| No imputation at all | 6,929 | 62.3% |
| Partly imputed | 1,754 | 15.8% |
| Fully imputed | 2,431 | 21.9% |

Of the 2,431 fully imputed, 527 are cases C and D; the other 1,904 had
counter rows that failed the reliability gate everywhere.

Weighted by ridership rather than by route-month, 81.1% of all boardings sit
in route-months with zero imputation, and 12.85% of boardings on the counter
path are imputed. The gap between 62.3% and 81.1% is school trippers: 41.9%
of 6xx/7xx route-months are fully observed against 76.1% of everything else.
Short, infrequent runs fail the capture and presence gates most often.

By year, fully observed route-months and the share of that year's boardings
they carry:

| Year | Route-months | No imputation | % | Share of boardings |
| --- | ---: | ---: | ---: | ---: |
| 2019 | 1,622 | 587 | 36.2% | 47.1% |
| 2020 | 1,328 | 732 | 55.1% | 72.9% |
| 2021 | 1,272 | 863 | 67.8% | 87.7% |
| 2022 | 1,478 | 1,008 | 68.2% | 86.1% |
| 2023 | 1,499 | 1,091 | 72.8% | 87.6% |
| 2024 | 1,450 | 1,163 | 80.2% | 94.0% |
| 2025 | 1,398 | 1,043 | 74.6% | 92.6% |
| 2026 | 540 | 442 | 81.9% | 95.6% |

2019 is the system-wide counter collapse.

---

## 8. Summary

```
Trip-PRA ──> method 1 ──> b̃        capture-corrected, month grain
                           │
Route-PRA ─> method 2 ──> b̂        level set per route-month
                           │
                           ├──> method 4 ──> value_d    cases A, B
                           │        ↑
Route-PRA ─┐               │        │ shape
GTFS ──────┼> method 3 ────┴────────┘
Trip-PRA ──┘   (shares)    └──────────────> est_px      cases C, D
```

Both estimates cover the same ridership, so `vis/build_prepack.py` selects
between them rather than summing:

- **Stops, tracts, block groups, cities** come from the counter path alone. A
  boarding happens at a stop whatever the route is called, and Trip-PRA
  covers all 2,706 service dates.
- **Route sections** take the counter path where the label exists on that
  date and the reconstruction where it does not, which gives 100% label
  coverage of the Realign era.
