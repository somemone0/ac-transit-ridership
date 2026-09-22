# O-D methodology

How the commute view's origin–destination flows are estimated, how they are
validated, and where they are weak. Written for someone auditing or changing
`scripts/build_commute_pack.py`; the operational side (uploading and deploying
a rebuilt pack) is in `DEPLOY.md`.

Companions: `IMPUTATION.md` covers the underlying ridership imputation;
`scripts/bart_validation/REPORT.md` is the backtest of the inference itself.

## What is produced

Per snapshot month (Feb and Aug of each year, plus the latest available month),
the pipeline writes to `public/data/pack/`:

| Output | Shape | Used for |
| --- | --- | --- |
| `commute_od_<YYYY-MM>.<hash>.bin` | Top-K AM flows per stop group, tract and block group | The commute map's "inferred riders to/from here" lists |
| `commute_rt_{group,tract,bgroup}.<hash>.bin` | `[key][snapshot][workplace, home]` u16 + per-key scales | The net round-trip commuter measure (AC Transit row in the explorer) |
| `commute_hourly_<level>.<hash>.bin` | `[key][snapshot][boardings, alightings][hour]` u16 | Hourly profile chart; AM/PM balance stats |
| `commute_meta.json` | File names, offsets, windows, snapshots | Entry point the client fetches first |

Binaries are content-hashed on write (`publish`, line 425), and the meta names
the exact files it was built with, so a cached meta never points at a later
build's binaries. `meta.windows` carries `am`, `pm` and `pmWork`; the client
uses `am`/`pm` for its balance stats and chart shading.

**The flow matrix is inferred, not observed.** Nothing in the bus data says
where a rider got off. Everything below is an attempt to get the most defensible
matrix out of boarding and alighting counts.

## Pipeline

```
raw APC parquet (GCS)
  -> weekday/non-holiday filter + capture, band and NTD correction   load_events
  -> for each route-direction inside the AM window:                  route_od
       stop sequence from median minutes into the trip
       per-trip boarding/alighting vectors
       summed IPF  and/or  per-trip iterated-base fit                ipf_od / trip_bases
       model chosen per route-direction by odd/even-day holdout      choose_passes
       raked to the corrected window totals                          rake
  -> aggregate to stop group / tract / block group, top-K             window_matrices
  -> evening pass -> round-trip workplace score                       round_trip
```

### 1. Inputs and corrections (`load_events`, line 163)

Raw APC events come from `gs://ac-transit-stops/partitioned-final/ac_transit_parquet`
(partitioned `year=/month=`, mirror of the public HuggingFace dataset). Each
snapshot month is filtered to non-holiday weekdays.

The counts are corrected in three multiplicative steps, all recorded per
route-direction (route + door/lift "bit"):

1. **Counter coverage** (`capture_table.parquet`): `1 / capture`, clipped at 1,
   per route-bit-month.
2. **Time-of-day band** (`capture_band_table.parquet`): `1 / capture_band` for
   the band of the trip's start hour, then renormalised so the band factors
   reshape the day without changing the route-month level. Bands flagged
   unreliable are noted (`imp`) but still included.
3. **NTD calibration** (`ntd_calibration.parquet`): one monthly factor, so the
   totals reconcile with the agency's National Transit Database report.

The corrected columns are `bd` / `al`; the raw counts (`raw_bd` / `raw_al`) are
kept because the per-trip fit uses raw trip-level counts while the marginal
totals that anchor the fit are corrected.

### 2. Window

`AM = (5, 11)` (`build_commute_pack.py:87`): trips whose **start hour** is
5:00–10:59. The window is part of the output, not a display choice — the flow
matrix is fitted to the boardings and alightings inside it. See
"Windows and why" below for how 5–11 was chosen.

### 3. Stop sequence (`route_od`, line 328)

Within one route-direction and one window, events are grouped into trips by
`(service_date, route_id)`. Each stop's position is the **median minutes from
that trip's first event**, and a stop joins the sequence if at least 5% of the
trips serve it (`MIN_STOP_SHARE`). The sequence is these stops sorted by
position, requiring at least two.

Two consequences: the GTFS shape is not trusted (it misses stops the buses
actually serve), and stops served by only a handful of trips are dropped rather
than allowed to create phantom endpoints.

### 4. Trip-level counts and screening

For each trip, `B[trip, stop]` and `A[trip, stop]` are the **raw** boarding and
alighting counts; `bvec` / `avec` are the corrected totals per stop divided by
the number of weekdays. Trips whose boardings and alightings differ by
`IMBALANCE_MAX = 5` or more are screened out of the fit (TCRP Report 113's
rule); they still contribute to the marginal totals.

### 5. Summed fit (`ipf_od`, line 232)

Iterative proportional fitting (Furness) on `bvec` / `avec` with a soft
backward mask: the seed is 1 for `i < j`, `backward_weight` (default 0.02) for
`i > j`, and 0 on the diagonal. Each iteration alternately rescales rows to
`bvec` and columns to `avec`. The mask embodies "a rider cannot get off before
they get on"; the small backward weight keeps trips solvable when the direction
assignment is wrong (loops, short-turns). The mask is the only thing this fit
contributes over a gravity model — without it, Furness on the same marginals
reproduces `B[i]·A[j]` (see `bart_validation/stage8_check.py`).

### 6. Per-trip fit and model selection (`trip_bases`, `choose_passes`, lines 277, 313)

Summing a month of trips before fitting throws away which stops fill up
together on the same bus. The per-trip path instead:

1. balances each trip's own `B`/`A` to their mean total (`balance`, line 256);
2. fits every trip to the current base matrix (`ipf_batch`, line 265), then
   rebuilds the base from the summed fits, keeping only forward mass — an
   approximate EM after Ji, Mishalani & McCord (2014);
3. repeats this for up to 8 passes, retaining the bases after pass 3 and pass 8.

Which structure ships is chosen **per route-direction** by an odd/even-day
holdout: fit on even days, predict odd days' alightings from their boardings
(`holdout_rmse`, line 305), and vice versa; pick the option (summed, 3 passes,
8 passes) with the lowest held-out error. Fewer than 20 trips, or a thin day
fold, falls back to the summed fit (`MIN_OD_TRIPS = 20`).

The chosen base is then **raked** (`rake`, line 296) to the corrected window
totals: a long biproportional fit (500 iterations) with a tiny backward seed
and almost no forward seed, so the totals are exact and only the structure
comes from the trips.

### 7. Aggregation and packing (`window_matrices`, line 441)

Cells below `FLOW_MIN = 0.01` riders/weekday are dropped. Stop-to-stop flows are
summed to stop groups, then to census tracts and block groups through the stop
group table; flows inside the same area and into unmapped stops are excluded.
Each key keeps its top `K_GROUP = 48` / `K_AREA = 24` arrivals and departures
(the out-list is "leaving here", the in-list "arriving here"; both are written
so the client never needs the full matrix). Only the AM matrix is shipped — it
carries the commute story in both directions.

### 8. Evening pass and the round-trip score (`round_trip`, line 480)

A second pass runs the same inference for the evening window
(`PM_WORK = (14, 22)`) but is never shipped: the 12 MB of binaries a second
matrix would add is not worth it. What survives is a per-key workplace score:

- normalise each window's flows to shares of that window's own total (the
  evening carries more riders, so raw levels are not comparable);
- a morning `i -> j` counts only as far as it is matched by an evening
  `j -> i`, i.e. `min(AM_share[i->j], PM_share[j->i])`;
- subtract the opposite story, `min(AM_share[j->i], PM_share[i->j])`, so an
  all-day two-way corridor cancels to ~zero and what is left is
  workplace-specific.

Positive net mass lands on `j` as a workplace and `i` as a home; the result is
scaled back to morning riders and packed as the `commute_rt_*` files. This is
the measure the explorer's AC Transit row displays, and the one scored against
LODES below.

### 9. Windows and why

| Window | Value | Role |
| --- | --- | --- |
| `am` | 5–11 | The shipped flow matrix |
| `pmWork` | 14–22 | Round-trip scoring only (never shipped) |
| `pm` | 14–22 | Client-side PM balance and chart shading |

The morning window was widened from 5–9 to 5–11 in September 2026: it catches
roughly half again more riders in the shipped top-K lists (pooled pre-era flows
+43%, post-era +55%), and the LODES pattern scores are unchanged. The evening
window was widened from 16–19 to 14–22 at the same time. That trade was
measured: against LODES workplace-ness (log jobs ÷ resident workers) the
round-trip measure scores ρ 0.46–0.47 at 14–22 versus 0.49 at 16–19, because
schools dismiss 13–16 and their round trips mirror as cleanly as commutes
(see the comment at `build_commute_pack.py:88`). Aggregate flows are
unaffected; the dilution is in the workplace ranking.

## Validation

### BART backtest (`scripts/bart_validation/`)

BART publishes the actual station-to-station matrix, so it can be collapsed to
per-station marginals, re-inferred with the project's own code, and scored
against truth. At the 5–11 window, 249 weekdays of 2025:

| Measure | Summed fit | Per-trip chosen | Gravity |
| --- | --- | --- | --- |
| Network WMAPE | 0.289 | **0.262** | 0.408 |
| Top-5 destination overlap | 0.841 | **0.853** | 0.776 |
| Displayed-cell WMAPE (top-5 per origin) | 0.229 | **0.216** | 0.274 |
| Displayed cells off ≥2× | 9.8% | **8.9%** | 13.4% |
| Recall of true top-5's flow | 96.8% | **97.1%** | 94.9% |

The holdout picked the better branch on all 12 BART lines. Both numbers are
**ceilings**: BART hands the fit clean fare-gate marginals, and the per-trip
test uses synthetic runs drawn from the true matrix (design and caveats in
`bart_validation/README.md`). Known systematic errors on displayed cells:
adjacent-stop flows inflated ~55%, 5–7-stop trips understated up to 16%,
quality correlated with destination concentration
(`corr(dest HHI, WMAPE) = −0.671`).

### LODES comparison (`scripts/compare_lodes.py`, `scripts/commute_patterns.py`)

Against LODES workplace and residence totals for 2019/2023: destination
attraction ρ ≈ 0.41–0.43 on served tracts; origin residences show no signal
(ρ ≈ −0.07, expected — bus boardings reflect service, not residence); the
round-trip workplace measure scores ρ 0.46–0.47. Pooled per-origin rank
correlations on top-K lists are unstable and tie-heavy; treat them as
diagnostic only.

### What the numbers support

- Which destinations matter is reliable (top-5 overlap ~0.85, recovering ~97%
  of the true top-5's flow).
- Individual cell values carry roughly ±25–50% error, occasionally 2× or more.
  Read them as one or two significant figures.
- Aggregate totals are safe by construction (the fit preserves the marginals);
  the split between destinations is what is uncertain.
- Dispersed reverse-commute directions are the weakest (WMAPE ~0.39 vs ~0.26
  inbound on BART), so treat those maps with more caution.

## Reproducing

```bash
# Full pipeline (needs the sibling checkouts that hold the correction tables)
python3 scripts/build_commute_pack.py        # or: npm run build:commute

# Backtest
cd scripts/bart_validation && python3 run_all.py

# LODES checks (needs vis/data/lodes_cache downloads)
python3 scripts/compare_lodes.py 2019-02 2023-02
python3 scripts/commute_patterns.py
```

The script reads two intermediates that live in sibling repos, neither
published here. Point `ACPRA_ROOT` at a checkout holding `replicate/` and
`vis/`, or set `ACPRA_REPLICATE`, `ACPRA_VIS`, `ACPRA_PACK` (output pack dir)
and `ACPRA_CACHE` individually; `ACPRA_BUCKET` overrides the raw parquet
source. The app itself needs none of this — it only reads the packed bundle.

After rebuilding, upload per `DEPLOY.md` ("Updating only the commute pack"):
hashed binaries first with a one-day cache, then `commute_meta.json` with a
five-minute cache, then the regenerated `manifest.json`. Old binaries stay in
the bucket for at least a day so cached metas can still resolve.

## Limits

- Flows are per route-direction leg, not whole journeys: a rider who transfers
  appears in two matrices, and transfer-only O-D pairs are not represented.
- The APC counts are corrected estimates; none of the correction noise is
  simulated in the BART ceiling.
- The evening window is a heuristic, not an observation: there is no ground
  truth for "this person is commuting".
