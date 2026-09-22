# BART validation of the O-D inference

The explorer's origin–destination flows are inferred, not observed: `ipf_od` in
`../build_commute_pack.py` takes a route–direction's boarding and alighting totals and
fits the most even flow matrix consistent with them. Nothing in the APC data says where
anyone actually went, so on AC Transit there is nothing to check the answer against.

BART is the nearest system that publishes the matrix itself. Collapsing BART's real
station-to-station counts down to per-station boardings and alightings, re-inferring
with the same code, and scoring the reconstruction gives an error bar for the method —
on a different network, but a real one.

`REPORT.md` has the findings. The short version: the *set* of important destinations is
reliable (top-5 overlap 0.845, and the predicted top-5 recovers 97.1% of the flow the
true top-5 carries), individual flow numbers are not (8.9% of displayed cells are wrong
by 2× or more), and because BART hands the method clean fare-gate marginals, its 0.281
WMAPE is a **ceiling** — the AC Transit error is very likely worse.

## Running it

```bash
python3 run_all.py
```

Downloads BART's 2025 O-D file (~34 MB) and GTFS feed on first run, then executes the
eight stages in order. Takes roughly 10–15 minutes, most of it the download. Needs
`pandas`, `numpy`, `scipy`, `pyarrow`.

Everything it writes — inputs and derived outputs alike — is gitignored; `run_all.py`
regenerates all of it.

| Stage | Does |
| --- | --- |
| `stage1_truth.py` | Mean-weekday AM (05:00–08:59) matrix over 248 non-holiday weekdays → `od_am_matrix.parquet` |
| `stage2_lines.py` | Ordered station sequences per line-direction from GTFS |
| `stage3_score.py` | Both IPF variants + gravity baseline; the headline metrics |
| `stage4_sweep.py` | `backward_weight` sweep (forward-assigned — see the report, it is rigged) |
| `stage5_backward_fair.py` | `backward_weight` sweep with realistic backward travel |
| `stage6_diag.py` | Trip-length bias and concentration |
| `stage7_displayed.py` | Error restricted to the top-5 cells the UI actually shows |
| `stage8_check.py` | Confirms unconstrained IPF ≡ the gravity baseline |

`common.py` holds a verbatim copy of `ipf_od` (so the test cannot silently drift from a
reimplementation), the line-assignment rule, and every metric.

## What this does and does not cover

This ran on **2026-09-08**, against the pipeline as it stood then. On **2026-09-11**
`build_commute_pack.py` gained a per-trip fit, and `route_od` now chooses per
route–direction by odd/even-day holdout:

- `choose_passes` returns `0` → `ipf_od(bvec, avec)`. **This is the path validated
  here.**
- `choose_passes` returns 3 or 8 → `rake(trip_bases(...))`, a per-trip iterated base
  (Ji, Mishalani & McCord 2014) with `backward=1e-3`. **Not covered by this study.**

So the results still describe the summed-marginal branch, which is still live, but they
no longer describe every route. The per-trip path learns its structure from individual
trips rather than leaning on the forward mask, so neither the `backward_weight`
recommendation nor the U-shaped trip-length bias should be assumed to transfer to it
without a separate test.

Two things worth redoing when there is reason to:

- **Re-run against the per-trip path.** `common.py` would need `trip_bases`/`rake`
  alongside `ipf_od`, and BART's O-D has no per-trip structure, so this needs a
  different design — probably synthetic trips drawn from the true matrix.
- **The `backward_weight` question is open on the current code.** The report argues
  0.05–0.10 for `ipf_od` on asymmetric-loss grounds. That has not been tested against
  AC Transit's own holdout, which now exists in `choose_passes` and would be a better
  judge than BART.

Related: `../compare_lodes.py` checks inferred workplaces against LODES, which is the
independent check on AC Transit's own network that this study cannot be.
