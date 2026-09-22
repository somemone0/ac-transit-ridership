# Validating the O-D inference against BART ground truth

*Run 2026-09-21 against BART 2025 O-D, hours 05:00–10:59 (the app's shipped
5–11 a.m. window), 249 non-holiday weekdays. `run_all.py` regenerates every
number here. The earlier 5–8 study is in git history (`b9d5e89`); widening the
window moves the summed-fit network WMAPE 0.281 → 0.289 and leaves every
conclusion intact.*

The explorer infers origin–destination flows from boarding and alighting counts.
BART publishes the actual station-to-station matrix, so it can be collapsed to
marginals, re-inferred with the project's own code, and scored against truth.
Both fits the pipeline ships are exercised:

- **summed** — `ipf_od` on the window's boarding/alighting totals;
- **per-trip** — `trip_bases` / `rake` (Ji, Mishalani & McCord 2014), chosen per
  route–direction by `choose_passes`'s odd/even-day holdout. BART has no
  per-trip data, so stage 9 synthesizes it: each true passenger becomes an
  (origin, destination, run) draw, giving every run its own stop-level
  boardings and alightings exactly as a bus run has in the APC data.

**Data.** 2025, 249 non-holiday weekdays, hours 5–10, 50 stations, 2,500 pairs,
**61,771.8 mean-weekday AM trips**. `ipf_od`, `trip_bases`, `rake` and
`choose_passes` were copied verbatim, not reimplemented.

## Headline — summed fit (`stage3_score.py`)

| Metric | (a) line-direction IPF | Naive gravity B[i]·A[j] | (b) whole-network IPF |
|---|---|---|---|
| **WMAPE** | **0.289** | 0.408 | 0.438 |
| R² | 0.913 | 0.867 | 0.826 |
| Pearson r | 0.956 | 0.931 | 0.909 |
| **Top-5 overlap** | **0.841** | 0.776 | 0.816 |
| Top-1 hit | 0.878 | 0.878 | 0.700 |
| Spearman ρ | 0.910 | 0.726 | 0.759 |

Assignment coverage 96.31% (equal split across line-directions serving a pair in
forward order; 2,263 trips on 762 transfer-only pairs dropped). Over- and
under-prediction are exactly equal at 14.44% each — IPF preserves the grand
total, so error is pure misallocation, never level bias.

**Key structural finding:** variant (b) unconstrained IPF *is* the gravity
baseline — they differ by 1.99% of total flow, correlation 0.9995
(`stage8_check.py`). The forward-sequence mask is the only thing IPF contributes
over multiplying marginals: 0.289 vs 0.408, a 29% error reduction. On top-1 the
two are identical (0.878); the marginals alone point at Embarcadero and
Montgomery, so quote WMAPE, where the method separates from the baseline.

## Headline — per-trip fit (`stage9_per_trip.py`, synthetic trips)

20 weekdays × 20 runs per line-direction; each day's passenger total is
Poisson-drawn around the true mean and each passenger's OD pair is drawn from
the true matrix. The production `choose_passes` sees 400 runs per line.

| Metric | summed | 3-pass | 8-pass | **chosen** | gravity |
|---|---|---|---|---|---|
| **WMAPE** | 0.289 | 0.270 | 0.262 | **0.262** | 0.408 |
| R² | 0.913 | 0.918 | 0.922 | **0.922** | 0.867 |
| Pearson r | 0.956 | 0.958 | 0.961 | **0.961** | 0.931 |
| Top-5 overlap | 0.841 | 0.857 | 0.853 | **0.853** | 0.776 |
| Spearman ρ | 0.910 | 0.925 | 0.929 | **0.929** | 0.726 |
| **Displayed-cell WMAPE** | 0.229 | 0.221 | 0.216 | **0.216** | 0.274 |
| Displayed cells off ≥2× | 9.8% | 9.4% | 8.9% | **8.9%** | 13.4% |
| Recall of true top-5 flow | 96.8% | 97.2% | 97.1% | **97.1%** | 94.9% |

`choose_passes` picked the per-line-best branch on 12 of 12 lines (oracle
agreement 1.00): 8 passes for every full line, and the summed fallback for the
two 2-station Grey shuttles, which are degenerate (1.9–3.5 trips/day). On this
data the per-trip path buys about 9% of WMAPE over the summed fit.

## The cells the app actually displays (top-5 per origin, 246 cells)

| | summed | chosen |
|---|---|---|
| Share of true AM flow | 62.8% | 62.9% |
| **WMAPE on displayed cells** | 0.229 | **0.216** |
| Within ±25% / ±50% | 62.6% / 84.1% | 66.3% / 86.6% |
| **Off by ≥2×** | 9.8% | **8.9%** |
| pred/actual p5 / p50 / p95 | 0.71 / 0.97 / 2.94 | 0.72 / 0.98 / 2.92 |
| **Predicted top-5 recovers this share of true top-5's flow** | 96.8% | **97.1%** |

## Trip-length bias — U-shaped, not monotone

| Separation | Actual | Predicted | Ratio |
|---|---|---|---|
| 1 | 2,519 | 3,915 | **1.554** |
| 2 | 3,832 | 4,180 | 1.091 |
| 3–4 | 10,348 | 9,227 | 0.892 |
| 5–7 | 16,687 | 13,976 | **0.838** |
| 8–11 | 16,847 | 15,979 | 0.948 |
| 12+ | 8,767 | 10,756 | **1.227** |

IPF over-predicts adjacent-stop hops by 55% and the longest trips by 23%, while
under-predicting the 5–7-stop commute core by 16%. A uniform seed makes every
ordered pair equally admissible, so the summed fit cannot represent a
characteristic trip length. The per-trip path tempers this by construction; the
bias table is for the summed branch.

## Concentration

| | True | Predicted |
|---|---|---|
| Gini, network | 0.700 | 0.669 |
| Top-10% pair share | 58.6% | 56.1% |
| Gini, variant (b) | 0.756 | 0.697 |
| Gini, *within* one line (Green-S) | 0.637 | **0.781** |

The marginals are themselves lumpy, so network-level concentration survives;
within a single line the summed fit is *more* concentrated than reality, loading
the big-origin × big-destination corner. The effects partly cancel on
aggregation.

## Per line-direction (summed fit, best → worst)

| Line-dir | AM trips | WMAPE | R² | Top-5 | Top dest |
|---|---|---|---|---|---|
| Green-S | 6,457 | 0.233 | 0.953 | 0.910 | EMBR |
| Blue-S | 6,091 | 0.242 | 0.955 | 0.925 | EMBR |
| Red-S | 9,347 | 0.245 | 0.949 | 0.882 | EMBR |
| Yellow-S | 14,443 | 0.290 | 0.933 | 0.837 | EMBR |
| Orange-N | 2,757 | 0.303 | 0.884 | 0.874 | DBRK |
| Orange-S | 2,739 | 0.308 | 0.905 | 0.811 | DBRK |
| Blue-N | 2,913 | 0.384 | 0.894 | 0.875 | MONT |
| Red-N | 5,507 | 0.408 | 0.810 | 0.855 | MONT |
| Green-N | 3,405 | 0.416 | 0.877 | 0.820 | MONT |
| Yellow-N | 5,334 | 0.434 | 0.838 | 0.814 | MONT |

**corr(dest HHI, WMAPE) = −0.671**, **corr(dest HHI, top-5 overlap) = +0.874**.
Inbound peak directions average WMAPE 0.264; dispersed reverse-commute
directions 0.392. Grey/OAK two-station shuttles are excluded as degenerate.

## `backward_weight` — two sweeps, because the obvious one is rigged

**Sweep 1** (`stage4_sweep.py`; pairs assigned only in forward order, so the
true backward share is 0% *by construction* — a lower weight must win. This is
nearly uninformative and must **not** be read as "set it to 0"):

| bw | WMAPE | Top-5 | Top-1 |
|---|---|---|---|
| 0.00 | **0.275** | **0.857** | 0.878 |
| 0.01 | 0.283 | 0.845 | 0.878 |
| **0.02 (default)** | 0.289 | 0.841 | 0.878 |
| 0.05 | 0.303 | 0.849 | 0.878 |
| 0.10 | 0.319 | 0.829 | 0.878 |
| 0.20 | 0.339 | 0.825 | 0.878 |

**Sweep 2** (`stage5_backward_fair.py`) — the fair test: each undirected line gets
one fixed sequence, pairs assigned in *either* order, reproducing bus
direction-bit noise. True backward share **33.8%**:

| bw | WMAPE | R² | Top-5 |
|---|---|---|---|
| 0.00 | 0.964 | −0.07 | 0.512 |
| **0.02** | 0.561 | 0.746 | 0.682 |
| 0.05 | 0.492 | 0.805 | 0.696 |
| 0.10 | 0.438 | 0.842 | 0.729 |
| 0.20 | 0.388 | 0.870 | 0.729 |
| **0.75** | **0.346** | 0.883 | 0.749 |
| 1.00 | 0.350 | 0.878 | **0.760** |

The optimal `backward_weight` tracks the true share of travel running against
the sequence — ~0 at 0% backward, ~0.75 at 33.8%. The loss is steeply
asymmetric: too low when backward travel exists is catastrophic (0.96 WMAPE),
too high when it doesn't is nearly free (bw = 0.20 costs only 0.033). Since
`resolve_aliases` assigns direction by stop-set Jaccard and can mis-assign on
loops and short-turns, **0.05–0.10 remains cheap insurance** on the summed
path. Note the per-trip path does not use `backward_weight` for its base
(`backward=1e-3`); the default only governs the summed branch and the holdout's
`ipf_od`.

## Caveats — this is a ceiling, not an estimate

1. **BART riders aren't bus riders.** Rail O-D is far more concentrated and
   downtown-oriented; IPF's advantage here comes largely from lumpy marginals
   doing the work. Expect worse on AC Transit.
2. **This hands both fits clean marginals.** BART's are fare-gate counts,
   essentially exact. AC Transit's are APC-derived — noisy and
   capture-corrected. None of that noise is simulated here.
3. **The per-trip test is synthetic.** Runs and passengers are drawn from the
   true matrix, so the run-level structure is exactly the truth plus Poisson
   noise: no direction-bit error, no transfers as separate legs, no missed
   boardings. It exercises `choose_passes`/`trip_bases`/`rake` faithfully but
   cannot show how those behave on dirtier APC vectors. The 0.262 WMAPE is an
   upper bound, as with the summed fit.
4. **Assignment rule is an idealisation** — equal split, 3.69% of trips
   dropped. Real assignment would weight by frequency and travel time.
5. **GTFS vintage mismatch** — 2025 O-D against the then-current 2026 feed. All
   50 station codes reconcile and line structure was stable, but the sequences
   aren't contemporaneous.
6. **The sequence is exogenously correct here.** On a bus route with loops and
   branches it may not be — an error mode this test cannot see, and sweep 2
   shows how badly the summed fit degrades when it is violated.
7. **The evening/round-trip window is not covered.** BART has no commuter
   label, so the 14–22 round-trip scoring and the netting that removes two-way
   corridors cannot be scored here. That side is validated against LODES
   workplace-ness on AC Transit itself (`../compare_lodes.py`), where the
   shipped measure scores ρ 0.46–0.47.

## Bottom line

**Trust the shape, not the size — and even the shape only on peak-direction
routes.**

- **The set of important partners is reliable.** Predicted top-5 overlaps the
  true top-5 0.84–0.85 of the time and recovers **97%** of the flow the true
  top-5 carries. If the app shows a corridor as a main destination, it almost
  certainly is one. This is the defensible claim.
- **Use the per-trip path.** It improves every metric over the summed fit
  (network WMAPE 0.262 vs 0.289, displayed 0.216 vs 0.229) and the holdout
  picks the better branch on all 12 BART lines.
- **Individual numbers carry ±25–50% error.** Displayed-cell WMAPE 0.216–0.229;
  **~9% wrong by ≥2×**; p95 ratio ~2.9×. Print one or two significant figures,
  and don't invite comparison between two similarly-sized flows.
- **Whole-matrix error is ~26–29% of total flow.** The total is exact by
  construction, so aggregate ridership statements are safe; the *split* is
  uncertain.
- **It beats the dumbest baseline only modestly** (0.289 vs 0.408 summed), and
  unconstrained IPF *is* gravity to within 2%.
- **Two systematic distortions:** adjacent-stop flows inflated ~55%; mid-length
  commute trips understated up to 16%.
- **Quality is strongly route-dependent** (corr 0.874 with destination
  concentration). The app presents dispersed reverse-commute routes with the
  same confidence as trunk routes, overstating confidence exactly where it is
  weakest.

Suggested caption for the app:

> Flows are inferred from boarding and alighting counts, not observed. Which
> destinations matter is reliable; the numbers are estimates, typically within
> ±25–50% and occasionally off by 2× or more. Short hops between adjacent stops
> are systematically overstated.

The true AC Transit error is bounded below by ~0.26 WMAPE and is very likely
meaningfully worse.
