# BART validation of the O-D inference

The explorer's origin–destination flows are inferred, not observed: the pipeline in
`../build_commute_pack.py` takes a route–direction's boarding and alighting totals and
fits a flow matrix consistent with them. Nothing in the APC data says where anyone
actually went, so on AC Transit there is nothing to check the answer against.

BART is the nearest system that publishes the matrix itself. Collapsing BART's real
station-to-station counts down to per-station boardings and alightings, re-inferring
with the same code, and scoring the reconstruction gives an error bar for the method —
on a different network, but a real one.

`REPORT.md` has the findings. The short version: at the shipped 5–11 a.m. window, the
summed fit scores 0.289 WMAPE / 0.841 top-5 overlap, the per-trip path that
`choose_passes` selects on most routes improves that to 0.262 / 0.853, and on the
top-5 cells the UI actually displays the error is 0.216 WMAPE with 8.9% of cells wrong
by 2× or more. Because BART hands the method clean fare-gate marginals, **all of these
are ceilings** — the AC Transit error is very likely worse.

## Running it

```bash
python3 run_all.py
```

Downloads BART's 2025 O-D file (~34 MB) and GTFS feed on first run, then executes the
nine stages in order. Takes roughly 10–15 minutes, most of it the download. Needs
`pandas`, `numpy`, `scipy`, `pyarrow`. The O-D host 403s urllib's default User-Agent,
so `run_all.py` sends a browser one.

Everything it writes — inputs and derived outputs alike — is gitignored; `run_all.py`
regenerates all of it.

| Stage | Does |
| --- | --- |
| `stage1_truth.py` | Mean-weekday AM (05:00–10:59, the app's 5–11 window) matrix over 249 non-holiday weekdays → `od_am_matrix.parquet` |
| `stage2_lines.py` | Ordered station sequences per line-direction from GTFS |
| `stage3_score.py` | Summed IPF variants + gravity baseline; the headline metrics |
| `stage4_sweep.py` | `backward_weight` sweep (forward-assigned — see the report, it is rigged) |
| `stage5_backward_fair.py` | `backward_weight` sweep with realistic backward travel |
| `stage6_diag.py` | Trip-length bias and concentration |
| `stage7_displayed.py` | Error restricted to the top-5 cells the UI actually shows |
| `stage8_check.py` | Confirms unconstrained IPF ≡ the gravity baseline |
| `stage9_per_trip.py` | Per-trip path (`trip_bases`/`rake`/`choose_passes`) on synthetic trips, plus displayed-cell metrics for every branch |

`common.py` holds verbatim copies of `ipf_od` and the per-trip machinery (`balance`,
`ipf_batch`, `trip_bases`, `rake`, `holdout_rmse`, `choose_passes`) so the test cannot
silently drift from a reimplementation; it also holds the line-assignment rule and
every metric.

## What this covers and does not cover

Both branches the pipeline ships are now exercised at the 5–11 window:

- **Summed** (`choose_passes` returns 0) — `ipf_od` on the window totals, validated on
  the real BART matrix itself.
- **Per-trip** (3 or 8 passes) — covered by `stage9_per_trip.py`, which synthesizes
  run-level boardings/alightings from the true matrix (20 weekdays × 20 runs per
  line-direction, Poisson passenger totals). This exercises the selection mechanism
  and the iterated-base fit, but the synthetic runs are the truth plus Poisson noise:
  no direction-bit error, no transfers split into legs, no missed boardings. The
  0.262 WMAPE is an upper bound for the same reason the summed fit's 0.289 is.
- Thin lines still fall back, faithfully: the two 2-station Grey shuttles drop below
  `MIN_OD_TRIPS` and take the summed path.

Not covered:

- **The evening/round-trip side.** BART has no commuter label, so the 14–22
  round-trip scoring and its netting cannot be scored here. That side is checked
  against LODES workplace-ness on AC Transit itself in `../compare_lodes.py`.
- **The `backward_weight` recommendation** (0.05–0.10, from sweep 2) has not been
  tested against AC Transit's own holdout inside `choose_passes`, which would be a
  better judge than BART.

The earlier 5–8 study is in git history (`b9d5e89`); widening the window moved the
summed network WMAPE 0.281 → 0.289 and changed no conclusion.
