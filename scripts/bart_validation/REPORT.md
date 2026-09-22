# Validating `ipf_od` against BART ground truth

*Run 2026-09-08 against BART 2025 O-D. See README.md for what this does and does not
say about the pipeline as it stands today — `build_commute_pack.py` gained a per-trip
fit on 2026-09-11, after this ran.*

The explorer infers origin–destination flows from boarding and alighting marginals using
iterative proportional fitting (`scripts/build_commute_pack.py`, `ipf_od`). BART
publishes the actual station-to-station matrix, so it can be collapsed to marginals,
re-inferred, and scored against truth.

**Data.** The `64.111.127.166` host in BART's older documentation now redirects to a
phpMyAdmin login; the current location is
`https://afcweb.bart.gov/ridership/origin-destination/date-hour-soo-dest-2025.csv.gz`.
2025, 248 non-holiday weekdays, hours 5–8, 50 stations, 2,496 pairs,
**41,084.5 mean-weekday AM trips**. `ipf_od` was copied verbatim, not reimplemented.

## Headline

| Metric | (a) line-direction IPF | Naive gravity B[i]·A[j] | (b) whole-network IPF |
|---|---|---|---|
| **WMAPE** | **0.281** | 0.395 | 0.433 |
| R² | 0.921 | 0.880 | 0.841 |
| Pearson r | 0.960 | 0.938 | 0.917 |
| **Top-5 overlap** | **0.845** | 0.808 | 0.792 |
| Top-1 hit | 0.898 | 0.878 | 0.700 |
| Spearman ρ | 0.899 | 0.719 | 0.756 |

Assignment coverage 96.36% (equal split across line-directions serving a pair in forward
order; 1,485 trips on 758 transfer-only pairs dropped). Over- and under-prediction are
exactly equal at 14.05% each — IPF preserves the grand total, so error is pure
misallocation, never level bias.

**Key structural finding:** variant (b) unconstrained IPF *is* the gravity baseline —
they differ by 1.9% of total flow, correlation 0.9996 (`stage8_check.py`). The
forward-sequence mask is the only thing IPF contributes over multiplying marginals:
0.281 vs 0.395, a 29% error reduction. Real, but the summed-marginal path is doing
"marginals plus a direction constraint," not sophisticated inference.

**On top-1 specifically:** 0.898 is the weakest number in this table, not the
strongest. Naive gravity scores 0.878 on the same matrix, so almost all of it comes
from the marginals pointing at Embarcadero and Montgomery rather than from the
inference. Quote WMAPE, where the method actually separates from the baseline.

## The cells the app actually displays (top-5 per origin, 246 cells)

| | Value |
|---|---|
| Share of true AM flow | 63.3% |
| **WMAPE on displayed cells** | **0.219** |
| Within ±25% / ±50% | 66.7% / 84.6% |
| **Off by ≥2×** | **8.9%** |
| pred/actual p5 / p50 / p95 | 0.72 / 0.98 / 3.33 |
| **Predicted top-5 recovers this share of true top-5's flow** | **97.1%** |

## Trip-length bias — U-shaped, not monotone

| Separation | Actual | Predicted | Ratio |
|---|---|---|---|
| 1 | 1,601 | 2,496 | **1.559** |
| 2 | 2,429 | 2,684 | 1.105 |
| 3–4 | 6,698 | 6,014 | 0.898 |
| 5–7 | 11,303 | 9,401 | **0.832** |
| 8–11 | 11,224 | 10,776 | 0.960 |
| 12+ | 6,047 | 7,300 | **1.207** |

IPF over-predicts the shortest hops by 56% and the longest trips by 21%, while
under-predicting the 5–11-stop commute core by up to 17%. This contradicts the
"max-entropy favours long trips" prior: the uniform seed makes every ordered pair
equally admissible, so it cannot represent a characteristic trip length.

## Concentration

| | True | Predicted |
|---|---|---|
| Gini, network | 0.708 | 0.678 |
| Top-10% pair share | 59.5% | 57.0% |
| Gini, variant (b) | 0.763 | 0.705 |
| Gini, *within* one line (Green-S) | 0.643 | **0.785** |

IPF erases less lumpiness than expected, because the marginals are themselves lumpy
(EMBR/MONT dominate). Within a single line it is *more* concentrated than reality — a
Furness fit on one line is near rank-1, overloading the big-origin × big-destination
corner. The effects partly cancel on aggregation.

## Per line-direction (best → worst)

| Line-dir | AM trips | WMAPE | R² | Top-5 | Top dest | Dest HHI |
|---|---|---|---|---|---|---|
| Green-S | 4,324 | 0.203 | 0.965 | 0.920 | EMBR | 0.162 |
| Blue-S | 4,103 | 0.209 | 0.965 | 0.938 | EMBR | 0.177 |
| Red-S | 6,122 | 0.235 | 0.956 | 0.873 | EMBR | 0.120 |
| Yellow-S | 10,084 | 0.293 | 0.927 | 0.846 | EMBR | 0.134 |
| Orange-N | 1,807 | 0.315 | 0.869 | 0.874 | 12TH | 0.111 |
| Orange-S | 1,872 | 0.324 | 0.890 | 0.790 | DBRK | 0.064 |
| Blue-N | 1,897 | 0.380 | 0.903 | 0.888 | MONT | 0.115 |
| Red-N | 3,406 | 0.409 | 0.832 | 0.836 | MONT | 0.102 |
| Green-N | 2,263 | 0.419 | 0.883 | 0.810 | MONT | 0.084 |
| Yellow-N | 3,423 | 0.435 | 0.854 | 0.839 | MONT | 0.095 |

Note these per-line top-1 figures (in `per_line_direction_metrics.csv`, 0.63–0.82) are
computed *within* each line over that line's stations only, and so are not comparable to
the 0.898 in the headline table, which is computed on the aggregated 50×50 network
matrix. Aggregation raises top-1 because summing across lines reinforces the dominant
downtown destinations.

The dominant-destination hypothesis holds quantitatively: **corr(dest HHI, WMAPE) =
−0.746**, **corr(dest HHI, top-5 overlap) = +0.924**. Inbound peak directions average
WMAPE 0.253; dispersed reverse-commute directions 0.392. (Grey/OAK two-station shuttles
carry ~2 trips and are excluded as degenerate.)

## `backward_weight` — two sweeps, because the obvious one is rigged

**Sweep 1** (`stage4_sweep.py`; pairs assigned only in forward order, so the true
backward share is 0% *by construction* — a lower weight must win. This is nearly
uninformative and must **not** be read as "set it to 0"):

| bw | WMAPE | Top-5 | Top-1 |
|---|---|---|---|
| 0.00 | **0.2679** | 0.8367 | 0.8776 |
| 0.01 | 0.2751 | **0.8490** | 0.8980 |
| **0.02 (default)** | 0.2811 | 0.8449 | 0.8980 |
| 0.05 | 0.2942 | 0.8286 | 0.8776 |
| 0.10 | 0.3094 | 0.8163 | 0.8776 |
| 0.20 | 0.3293 | 0.8163 | 0.8776 |

**Sweep 2** (`stage5_backward_fair.py`) — the fair test: each undirected line gets one
fixed sequence, pairs assigned in *either* order, reproducing bus direction-bit noise.
True backward share **32.6%**:

| bw | WMAPE | R² | Top-5 |
|---|---|---|---|
| 0.00 | 0.9145 | 0.118 | 0.513 |
| **0.02** | 0.5327 | 0.780 | 0.675 |
| 0.05 | 0.4686 | 0.829 | 0.694 |
| 0.10 | 0.4179 | 0.861 | 0.715 |
| 0.20 | 0.3719 | 0.884 | 0.714 |
| **0.75** | **0.3340** | 0.895 | 0.723 |
| 1.00 | 0.3384 | 0.891 | **0.735** |

The optimal `backward_weight` simply tracks the true share of travel running against the
sequence — ~0 at 0% backward, ~0.75 at 32.6%. The loss is steeply asymmetric: too low
when backward travel exists is catastrophic (0.91 WMAPE), too high when it doesn't is
nearly free (bw = 0.20 costs only 0.033). Since `resolve_aliases` assigns direction by
stop-set Jaccard and can mis-assign on loops and short-turns, **0.05–0.10 is cheap
insurance** on the summed-marginal path. That is the one directly actionable parameter
change this study supports.

## Caveats — this is a ceiling, not an estimate

1. **BART riders aren't bus riders.** Rail O-D is far more concentrated and
   downtown-oriented; IPF's advantage here comes largely from lumpy marginals doing the
   work. Expect worse on AC Transit.
2. **This hands IPF clean marginals.** BART's are fare-gate counts, essentially exact.
   AC Transit's are APC-derived — noisy and capture-corrected. None of that noise is
   simulated here.
3. **BART counts fare-gate entries/exits**, so within-system transfers collapse into one
   pair; bus APCs record every boarding and alighting including transfer legs. There is
   more marginal-level ambiguity in the bus case.
4. **The assignment rule is an idealisation** — equal split, 3.6% of trips dropped. Real
   assignment would weight by frequency and travel time.
5. **GTFS vintage mismatch** — 2025 O-D against the then-current 2026 feed. All 50
   station codes reconcile and line structure was stable, but the sequences aren't
   contemporaneous.
6. **The sequence is exogenously correct here.** On a bus route with loops and branches
   it may not be — an error mode this test cannot see, and sweep 2 shows how badly IPF
   degrades when it is violated.

## Bottom line

**Trust the shape, not the size — and even the shape only on peak-direction routes.**

- **The set of important partners is reliable.** Top-5 overlap 0.845, and the predicted
  top-5 recovers **97.1%** of the flow the true top-5 carries. If the app shows a
  corridor as a main destination, it almost certainly is one. This is the defensible
  claim.
- **Individual numbers carry ±25–50% error.** WMAPE 0.219 on displayed cells; **8.9%
  wrong by ≥2×**; p95 ratio 3.3×. Print one or two significant figures, and don't invite
  comparison between two similarly-sized flows.
- **Whole-matrix error is 28% of total flow.** The total is exact by construction, so
  aggregate ridership statements are safe; the *split* is uncertain.
- **It beats the dumbest baseline only modestly** (0.281 vs 0.395), and unconstrained
  IPF *is* gravity to within 1.9%.
- **Two systematic distortions:** adjacent-stop flows inflated ~56%; mid-length commute
  trips understated up to 17%.
- **Quality is strongly route-dependent** (corr 0.924 with destination concentration).
  The app presents dispersed reverse-commute routes with the same confidence as trunk
  routes, overstating confidence exactly where it is weakest.

Suggested caption for the app:

> Flows are inferred from boarding and alighting counts, not observed. Which
> destinations matter is reliable; the numbers are estimates, typically within ±25–50%
> and occasionally off by 2× or more. Short hops between adjacent stops are
> systematically overstated.

The true AC Transit error is bounded below by 0.28 WMAPE and is very likely meaningfully
worse.
