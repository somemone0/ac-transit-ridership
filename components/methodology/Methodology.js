/* Methodology page. A server component: KaTeX runs at render time and the
   page ships as static HTML with no client JavaScript at all -- only the
   KaTeX stylesheet, which app/methodology/page.js imports.

   Imputation comes first because it is the step that decides whether any
   other number on the site means anything. Everything here is sourced from
   the build: vis/DATA.md, replicate/PIPELINE_PLAIN_ENGLISH.md, and the
   docstrings of the scripts named in each section. */

import katex from "katex";

import { BlendChart, CaptureGrid, CorridorDiagram, OdDiagram, PipelineFlow } from "./diagrams";

/* throwOnError so a malformed formula fails the build rather than rendering a
   red blob into the page. */
function render(src, displayMode) {
  return katex.renderToString(src.trim(), { displayMode, throwOnError: true, strict: "ignore" });
}

function M({ children }) {
  return <span className="mth-m" dangerouslySetInnerHTML={{ __html: render(children, false) }} />;
}

function Eq({ children, note }) {
  return (
    <div className="mth-eq">
      <div className="mth-eq-body" dangerouslySetInnerHTML={{ __html: render(children, true) }} />
      {note ? <p className="mth-eq-note">{note}</p> : null}
    </div>
  );
}

function Key({ children }) {
  return <aside className="mth-key">{children}</aside>;
}

const SECTIONS = [
  ["imputation", "1. Imputation"],
  ["od", "2. Where riders go"],
  ["corridors", "3. Corridors"],
  ["speed", "4. Speed and service"],
  ["validation", "5. What is known to be wrong"],
  ["code", "6. Code and sources"],
];

export default function Methodology() {
  return (
    <div className="mth">
      <header className="mth-hero">
        <p className="mth-kicker">AC Transit ridership · 2019–2026</p>
        <h1>How these numbers are made</h1>
        <p className="mth-lede">
          Every number on this site starts as a door-open event on a bus. The counter that recorded it may
          not have been working. This page explains what is measured, what is inferred and where the
          numbers are known to be wrong.
        </p>
        <p className="mth-links">
          <a href="/">Explore the map</a> · <a href="/story">Read the story</a> ·{" "}
          <a href="/buslanes">Bus lanes</a>
        </p>
      </header>

      <div className="mth-cols">
        <nav className="mth-toc" aria-label="Contents">
          <p className="mth-toc-h">Contents</p>
          <ol>
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ol>
        </nav>

        <main className="mth-body">
          <section className="mth-intro">
            <p>
              The site uses two sources that never see each other. The automatic passenger counters on the
              buses record boardings and alightings at every stop, the only stop-level measurement that
              exists, and they fail often enough that the raw feed is unusable on its own. AC Transit’s
              monthly route totals are reliable at the level of a route and a month, and say nothing about
              stops or days. The two sources reached this project through separate public records requests:
              the route-level totals used as the control came from one request, the event-level counter
              extracts from the other.
            </p>
            <p>
              The pipeline lets each source do what it can. The control sets how many riders a route carried
              in a month. The counters decide how those riders are distributed across stops, days and
              directions. The two are never added together.
            </p>
            <PipelineFlow />
          </section>

          {/* ================================================== 1. imputation */}
          <section id="imputation">
            <p className="mth-eyebrow">Part one</p>
            <h2>1. Imputation</h2>
            <p className="mth-standfirst">
              The counters see between 19 and 90 of every 100 boardings, depending on the month. Correcting
              that undercount is the most consequential step in the pipeline. The obvious way to do it
              produces numbers that are badly, invisibly wrong.
            </p>

            <h3>1.1 Notation</h3>
            <p>
              Throughout, a route is <M>{String.raw`r`}</M>, a direction <M>{String.raw`u`}</M>, a month{" "}
              <M>{String.raw`m`}</M>, a day type <M>{String.raw`\tau`}</M> (weekday, Saturday, Sunday), a
              stop <M>{String.raw`s`}</M>, a service day <M>{String.raw`d`}</M>, and a week{" "}
              <M>{String.raw`w`}</M>. A cell <M>{String.raw`(r,u,m,\tau)`}</M> is the unit the correction is
              estimated on.
            </p>

            <h3>1.2 Finding the trips</h3>
            <p>
              The feed has no trip identifier and no direction column. Two fields carry them.{" "}
              <code>route_id</code> is not a route. It is the trip’s scheduled start time as{" "}
              <code>HHMM</code>. The low bit of the vehicle’s door-and-lift flag field separates the two
              buses that leave on the same minute in opposite directions. So
            </p>
            <Eq note="The bit takes values 0, 1, 2, 3 and 8 across the system, so it is always read modulo 2.">
              {String.raw`\text{trip} \;=\; \bigl(r,\; d,\; \texttt{route\_id},\; u\bigr),
              \qquad u \;=\; \texttt{door\_lift\_flags} \bmod 2`}
            </Eq>
            <p>
              Stop identifiers in the feed are five digits and join GTFS <code>stop_code</code>, not{" "}
              <code>stop_id</code>; joining on the wrong column silently matches nothing. About 1.5% of
              boardings arrive on events with a null stop and are dropped from every stop-level product.
              316 stops carrying 1.3% of boardings had no coordinates in any GTFS feed; they were recovered
              as the median position of their own raw events.
            </p>

            <h3>1.3 The schedule, recovered from the data</h3>
            <p>
              A capture rate needs a denominator: how many trips ran. The published timetable cannot supply
              it, because outside its own signup window it counts COVID-cut and summer-school service that
              never operated. The distinct start times seen across a month of one day type can: with
              counters on twenty-odd weekdays, every scheduled slot is seen at least once. Checked against
              the GTFS feed inside its coverage window, the two counts agree to a median of 0%.
            </p>
            <p>
              Holidays run a different timetable. They are removed before the slot set is counted, then
              given the month’s ordinary capture rate.
            </p>

            <h3>1.4 Dead counters</h3>
            <p>
              A trip whose counter reported zero boardings from first stop to last is not an empty bus; it
              is a broken sensor. About 27 of every 100 trips in the feed are like this. They are excluded
              from the numerator, not averaged in as zeroes.
            </p>
            <CaptureGrid />

            <h3>1.5 The capture fraction and the ratio estimator</h3>
            <p>
              For each cell, the capture fraction is the share of scheduled trips whose counter reported:
            </p>
            <Eq>
              {String.raw`\hat c_{\,r,u,m,\tau} \;=\; \frac{G_{\,r,u,m,\tau}}{N_{\,r,u,m,\tau}}`}
            </Eq>
            <p>and every raw count in that cell is divided by it:</p>
            <Eq note="One factor per cell, applied to every stop and every day inside it: a pure multiplicative scaling.">
              {String.raw`\tilde b_{\,s,d} \;=\; \frac{b^{\text{raw}}_{\,s,d}}{\hat c_{\,r,u,m,\tau}}`}
            </Eq>
            <p>
              Because the correction is one scalar per cell, it transfers to alightings untouched. That is
              checked, not assumed: the alightings-to-boardings ratio is flat across all ten capture
              deciles, 0.9935 to 1.0054 over 32 million boardings. A dead counter loses both directions of
              flow together.
            </p>
            <p>
              Onboard load is <em>not</em> scaled. It is an intensive per-event mean, and multiplying a mean
              by <M>{String.raw`1/\hat c`}</M> is meaningless. It also degrades where capture is low (1.46 in
              the bottom decile against about 6.6 system-wide). The site takes section load as cumulative
              boardings minus alightings instead.
            </p>

            <h3>1.6 Reliability gates</h3>
            <p>A cell is marked reliable when all three of these hold:</p>
            <Eq
              note="A cell that fails still gets a corrected count. It is flagged, not discarded, and the flag drives the imputed share shown throughout the app."
            >
              {String.raw`\hat c \ \ge\ 0.4,
              \qquad \frac{N}{\bar N_{r,u}} \ \ge\ 0.7,
              \qquad \frac{\lvert \{d : \text{route ran}\}\rvert}{\lvert \{d \in \tau\}\rvert} \ \ge\ 0.7`}
            </Eq>

            <h3>1.7 Level from the control, distribution from the counters</h3>
            <p>
              Calibration is per route-month, against the control. One factor per route per month, rather
              than one for the system, so it can correct how ridership is allocated between routes and not
              only the total:
            </p>
            <Eq note="C is the control's route-month total; the denominator is the capture-corrected sum over that route-month.">
              {String.raw`k_{r,m} \;=\; \frac{C_{r,m}}{\displaystyle\sum_{s}\ \sum_{d \in m} \tilde b_{\,s,d}}`}
            </Eq>
            <p>
              The counters no longer set any route’s monthly level. They decide only how it is distributed:
              across stops, days, directions and the observed/imputed split. Four cases arise:
            </p>
            <div className="mth-table-wrap">
              <table className="mth-table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th className="num">Route-months</th>
                    <th>Treatment</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Label present in both sources</td>
                    <td className="num">9,719</td>
                    <td>
                      factor <M>{String.raw`= C / \text{APC}`}</M>
                    </td>
                  </tr>
                  <tr>
                    <td>Counter label, no control row</td>
                    <td className="num">880</td>
                    <td>month’s volume-weighted matched factor</td>
                  </tr>
                  <tr>
                    <td>Control label, no counter rows</td>
                    <td className="num">325</td>
                    <td>schedule reconstruction, 100% imputed</td>
                  </tr>
                  <tr>
                    <td>
                      Counters too thin (<M>{String.raw`{>}5\times`}</M> stretch)
                    </td>
                    <td className="num">250</td>
                    <td>schedule reconstruction, 100% imputed</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              That last rule matters. Some May–July 2019 route-months needed factors between 500 and 1700 to
              reach the control. A stretch that large is not a scaling problem; it is a handful of
              surviving events inflated into a month of ridership. Those months go to the schedule
              reconstruction instead. The result: 83 of the 85 months the control covers land within
              ±2.3% of it, median +0.5%.
            </p>

            <h3>1.8 Why a monthly correction cannot be read weekly</h3>
            <p>
              The capture fraction is estimated per month, and the site displays weeks. Within a month the
              correction is a constant, so on its own it would leave the weekly values proportional to the
              raw counts — and the raw counts track how many counters were working that week.
            </p>
            <Key>
              <p>
                <strong>In the spring of 2019:</strong> week 18 recovered 39.6% of its trips and reported
                1.62 million boardings. Week 20 recovered 5.3% and reported 0.16 million. Scheduled service
                across those weeks was flat, at about 46,600 trips a week.
              </p>
              <p>
                Across 2019 weekly system totals, the correlation between sensor uptime and reported
                ridership is <strong>0.391</strong>. Between scheduled trips and reported ridership it is{" "}
                <strong>−0.011</strong>. The reported number was measuring the sensors, not the riders. In
                the worst month, the busiest week came out 29× the quietest.
              </p>
            </Key>

            <p className="mth-pull">
              The universe of trips that operated is only observable <em>through</em> the sensor being
              corrected.
            </p>
            <p>
              That is why the fix cannot come from the counters. A GTFS-derived timetable is stale outside
              its signup; it implies 24–41% annual uptime against 82% measured inside the feed’s coverage
              window. A timetable derived from observations shrinks exactly when uptime drops, inheriting
              the bias it would need to remove. The week has to be shaped by something that never sees the
              sensor at all.
            </p>

            <h3>1.9 The weekly blend</h3>
            <p>
              What works is to take the <em>shape</em> of the week from a source that cannot see the sensor,
              and keep the <em>level</em> from the calibrated month. Within each stop-month, with{" "}
              <M>{String.raw`a`}</M> the counter series and <M>{String.raw`\sigma`}</M> the schedule-only
              reconstruction:
            </p>
            <Eq
              note="w is the stop-month's reliable share from §1.6, so a healthy stop keeps its measured shape and a collapsed one is carried by the schedule."
            >
              {String.raw`\hat b_{\,s,d} \;=\;
              \underbrace{\Bigl[\, w_{s,m}\,\frac{a_{s,d}}{A_{s,m}}
              \;+\; (1 - w_{s,m})\,\frac{\sigma_{s,d}}{\Sigma_{s,m}} \Bigr]}_{\text{shape, from both}}
              \;\cdot\;
              \underbrace{\vphantom{\Bigl[\Bigr]} A_{s,m}}_{\text{level, from the control}}`}
            </Eq>
            <p>
              The construction is mean-preserving: both shape terms sum to one across the month.
            </p>
            <Eq>
              {String.raw`\sum_{d \in m} \hat b_{\,s,d}
              \;=\; \Bigl[\, w_{s,m} + (1 - w_{s,m}) \Bigr] A_{s,m}
              \;=\; A_{s,m}`}
            </Eq>
            <p>
              Month totals are byte-identical and the calibration of §1.7 still holds exactly. The
              reconstruction contributes shape only and is never summed with the counter series.
            </p>
            <BlendChart />
            <p>
              This is not smoothing. Where the counters were healthy (<M>{String.raw`w \to 1`}</M>) the real
              weekly signal survives untouched. Where they collapsed (<M>{String.raw`w \to 0`}</M>) the
              schedule carries the week. Healthy years barely move:
            </p>
            <div className="mth-table-wrap">
              <table className="mth-table">
                <thead>
                  <tr>
                    <th>Within-month weekly volatility</th>
                    <th className="num" colSpan={2}>
                      Before
                    </th>
                    <th className="num" colSpan={2}>
                      After
                    </th>
                  </tr>
                  <tr className="mth-subhead">
                    <th />
                    <th className="num">mean CV</th>
                    <th className="num">worst</th>
                    <th className="num">mean CV</th>
                    <th className="num">worst</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>2019</td>
                    <td className="num">0.231</td>
                    <td className="num">29.0×</td>
                    <td className="num">0.090</td>
                    <td className="num">2.8×</td>
                  </tr>
                  <tr>
                    <td>2020</td>
                    <td className="num">0.103</td>
                    <td className="num">5.2×</td>
                    <td className="num">0.081</td>
                    <td className="num">3.6×</td>
                  </tr>
                  <tr>
                    <td>2021–2025</td>
                    <td className="num">~0.06</td>
                    <td className="num">~1.7×</td>
                    <td className="num">~0.06</td>
                    <td className="num">~1.5×</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3>1.10 The other estimate: schedule-only reconstruction</h3>
            <p>
              The shape the blend borrows comes from a parallel estimate built without touching the counter
              feed. Monthly control levels are allocated to days in proportion to scheduled trips, a
              mean-preserving split, with holiday dips from the GTFS calendar exceptions. Route-day totals
              are distributed over stops using share vectors learned from reliable counter history per route
              and era.
            </p>
            <p>
              Routes renamed in the 2025 Realign have no history of their own, so their shares come from
              blends of predecessors (9 from 10, 99 and 801; 22 from 29, 7 and 51B; 1T from “1”), and
              school trippers are matched across eras through GTFS. Boarding and alighting shares are
              learned separately, because a stop where everyone gets on is not a stop where everyone gets
              off. Backtested, the transfer beats a uniform split: cosine similarity 0.73–0.95 against 0.21,
              WAPE 0.36–0.72 against 1.63.
            </p>

            <h3>1.11 Selected, never summed</h3>
            <p>
              The two estimates cover the same ridership, so the packing step chooses between them by
              whether the question depends on a route label:
            </p>
            <ul className="mth-list">
              <li>
                <strong>Stops, tracts, block groups and cities</strong> come from the counters alone. A
                boarding happens at a stop whatever the route is called, and the counter feed covers all
                2,706 service dates. Adding reconstruction rows on top would double-count.
              </li>
              <li>
                <strong>Route sections</strong> are label-dependent, and there the counter feed genuinely
                fails: it kept pre-Realign labels, so GTFS knows route 9 and the counters never do.
                Sections take the counters where the label exists on that date and the reconstruction where
                it does not. That gives 100% label coverage of the Realign era, flagged imputed.
              </li>
            </ul>

            <h3>1.12 What “imputed” means on screen</h3>
            <p>
              Every value in the app splits into an observed and an imputed part using the same weight:
            </p>
            <Eq>
              {String.raw`\text{observed} \;=\; w_{s,m}\,\hat b_{\,s,d},
              \qquad
              \text{imputed} \;=\; (1 - w_{s,m})\,\hat b_{\,s,d}`}
            </Eq>
            <p>
              The interface renders these as <span className="mth-eg">Total (imputed)</span>, with the
              imputed figure <span className="gold">in gold</span>. It is a continuous share of a
              reliability-weighted blend. It is not a confidence interval and should not be read as one.
            </p>
          </section>

          {/* ========================================================= 2. O-D */}
          <section id="od">
            <p className="mth-eyebrow">Part two</p>
            <h2>2. Where riders go</h2>
            <p className="mth-standfirst">
              AC Transit riders do not tap off, so nobody knows where a trip ended. The commute view’s
              flows are inferred from the shape of boardings and alightings along each route. They are a
              reasonable aggregate picture, not a record of anyone’s journey.
            </p>

            <h3>2.1 Stop order from the buses, not the timetable</h3>
            <p>
              A flow matrix needs stops in the order the buses reach them. GTFS sequences are missing stops
              the buses serve; dropping those events lost up to a quarter of a direction’s boardings.
              Instead each stop is placed by its median minutes into the trip, over the stops at least 5% of
              trips serve.
            </p>

            <h3>2.2 Screening and balancing</h3>
            <p>
              A trip whose boardings and alightings differ by 5 or more is dropped from the fit, TCRP
              Report 113’s screening rule, since such a trip cannot be a closed system. The rest are scaled
              to the mean of their two totals, which balances them without changing average trip length:
            </p>
            <Eq>
              {String.raw`\mathbf{b}' = \mathbf{b}\,\frac{\bar t}{\lVert \mathbf{b} \rVert_1},
              \quad
              \mathbf{a}' = \mathbf{a}\,\frac{\bar t}{\lVert \mathbf{a} \rVert_1},
              \quad
              \bar t = \tfrac{1}{2}\bigl(\lVert \mathbf{b} \rVert_1 + \lVert \mathbf{a} \rVert_1\bigr)`}
            </Eq>

            <h3>2.3 The fit</h3>
            <p>
              Boardings give the row sums of a flow matrix and alightings the column sums. Only the upper
              triangle can be non-zero, because a rider cannot alight before boarding. Iterative
              proportional fitting finds the matrix that matches both margins.
            </p>
            <OdDiagram />

            <h3>2.4 Per trip, not per month</h3>
            <p>
              Fitting the summed month in one pass throws away the most informative thing in the data:
              which stops fill up together on the same bus. Each trip is fitted against a shared base, and
              the base is rebuilt from the sum of those fits, for a few passes. This is the approximate EM
              scheme of Ji, Mishalani and McCord (2014). With <M>{String.raw`U`}</M> the upper-triangular
              mask and <M>{String.raw`v`}</M> indexing trips:
            </p>
            <Eq
              note="Starting from a uniform upper-triangular base. A small weight on the lower triangle keeps trips with locally inconsistent counts solvable; only forward mass carries into the next pass."
            >
              {String.raw`T^{(k)}_{v} = \operatorname{IPF}\!\Bigl(
              \tfrac{P^{(k-1)}}{\lVert P^{(k-1)} \rVert_1}
              \;;\; \mathbf{b}_v,\ \mathbf{a}_v \Bigr),
              \qquad
              P^{(k)} = \Bigl[\,\sum_{v} T^{(k)}_{v} \Bigr] \odot U`}
            </Eq>
            <p>
              How many passes is not assumed. For each route-direction, a base fitted on odd days predicts
              every even day’s alightings from its boardings, and vice versa, scoring{" "}
              <M>{String.raw`\lVert \mathbf{b}_v P - \mathbf{a}_v \rVert`}</M> on the held-out days. Three
              passes, eight passes and the old summed fit compete; the winner is used. Thin routes and some
              with loops do better on the summed fit, and get it.
            </p>
            <p>
              The chosen structure is raked to the capture-corrected morning boarding and alighting totals.
              Stop-to-stop flows are aggregated to stop-group, tract and block-group pairs. Only the morning
              matrix (trips starting 05:00–09:00) is shipped. It carries the commute in both directions: a
              key’s inbound list is who arrives and its outbound list is who leaves.
            </p>

            <h3>2.5 Separating commuters from everyone else</h3>
            <p>
              A morning arrival cannot distinguish a commuter from a shopper, a student or someone changing
              to BART. An evening matrix (16:00–19:00) is inferred too, never shipped, purely to score
              which morning trips come back. Writing <M>{String.raw`\alpha_{ij}`}</M> and{" "}
              <M>{String.raw`\pi_{ij}`}</M> for morning and evening flows as shares of their own window’s
              total:
            </p>
            <Eq note="On shares, not levels, because the evening window carries about 1.4× the morning's riders.">
              {String.raw`\operatorname{net}_{ij} \;=\;
              \min\bigl(\alpha_{ij},\, \pi_{ji}\bigr)
              \;-\;
              \min\bigl(\alpha_{ji},\, \pi_{ij}\bigr)`}
            </Eq>
            <p>
              The first term is the paired volume: a morning{" "}
              <M>{String.raw`i \to j`}</M> trip counts only where an evening <M>{String.raw`j \to i`}</M>{" "}
              trip returns it. The subtraction makes this a measure of workplaces rather than of busyness.
              Buses run both ways all day, so the fit hands nearly every busy pair a return leg. Without it,
              a two-way corridor scores at both ends and the ranking fills with tracts that have many
              residents and few jobs. A symmetric all-day corridor now cancels to about zero, while a
              genuine commute pair keeps its volume and its sign.
            </p>
            <Key>
              <p>
                Against LODES workplace-ness ({" "}
                <M>{String.raw`\log(\text{jobs} / \text{resident workers})`}</M> per tract), the net
                round-trip measure reaches <strong>ρ 0.45</strong>. Raw morning arrivals reach{" "}
                <strong>0.22</strong>. It holds across the 2019, 2023 and 2026 snapshots while raw arrivals
                decay.
              </p>
            </Key>
            <p>
              The evening window starts at 16:00 deliberately: schools dismiss between 13:00 and 16:00, and
              their round trips mirror as cleanly as commutes do.
            </p>

            <h3>2.6 Two corrections specific to this view</h3>
            <p>
              Counters fail more at some hours than others, so commute counts are capture-corrected per
              route, subfleet and time-of-day band of the trip start: early, AM peak, midday, PM peak,
              evening. The band factors only redistribute a route’s month across the day; each route keeps
              the level its route-month factor gave it, so the totals still reconcile with the weekly
              numbers elsewhere on the site. Weekly counts are spread from month totals with the
              proportional Denton method, so they move smoothly across month boundaries instead of
              stepping.
            </p>
          </section>

          {/* =================================================== 3. corridors */}
          <section id="corridors">
            <p className="mth-eyebrow">Part three</p>
            <h2>3. Corridors</h2>
            <p className="mth-standfirst">
              For routes sharing a street to share a line on the map, “same street” has to be answerable.
              From the GTFS shapes alone, it is not.
            </p>
            <p>
              Every route carries its own polyline down a street it shares with nine others, drawn to its
              own tolerance. The fix is to give the road an identity of its own. The OpenStreetMap network
              the shapes run on is cached, filtered to roads within 150 m of a shape, and every route-
              direction pattern is map-matched onto it with a Newson–Krumm hidden Markov model. A stretch of
              road becomes an OSM edge id, and routes sharing it merge by set union, with no distance
              tolerance anywhere in the pipeline.
            </p>
            <CorridorDiagram />
            <p>
              A corridor is cut wherever its set of contributing sections changes. Sections run stop to stop,
              so that rule puts a node at every stop group and every junction where routes join or leave. It
              also makes onboard load constant along a corridor, so the corridor’s value is well defined and
              the step across a node is exactly that stop group’s boardings minus its alightings.
            </p>
            <p>
              Patterns the matcher cannot place, like a busway missing from OSM or a transit-centre loop,
              keep their raw GTFS geometry and do not merge with anything, so nothing disappears from the
              map. Geometry is carried for three GTFS eras, since stop sequences changed between them:
              November 2019 (used through 2021), December 2024 (2022 to March 2025) and August 2025
              (April 2025 onward). Mid-era detours render on the nearest era’s path.
            </p>
          </section>

          {/* ======================================================= 4. speed */}
          <section id="speed">
            <p className="mth-eyebrow">Part four</p>
            <h2>4. Speed and service</h2>
            <p className="mth-standfirst">
              Speeds are observed, not scheduled. Every figure comes from the times the doors actually
              opened.
            </p>
            <p>
              Within one bus-day, the first door-open at each stop is paired with the first door-open at the
              next stop that bus reached. Distance is the along-route distance between the two on the
              route-direction’s section chain, the same polylines the map draws. The pair’s elapsed time is
              spread over the sections it spans in proportion to their length. Corridor and route speeds are
              then
            </p>
            <Eq note="A ratio of totals, so dwell time at stops and delay at signals are both inside it: the speed a rider actually travels at, not a running speed.">
              {String.raw`v \;=\; \frac{\sum_{p} \ell_p}{\sum_{p} \Delta t_p}`}
            </Eq>
            <p>
              Pairs faster than 65 mph, slower than 1 mph or longer than an hour are dropped as GPS or
              stop-matching glitches, and so are pairs over 5 km that skip stops on the route. Adjacent
              stops count at any distance, which keeps genuine no-stop runs like the Bay Bridge crossing.
              Directions are assigned per trip from the stops it served, not from the door-flag bit, which
              stopped being reliable in 2020.
            </p>
            <p>
              Headways come from the trip slots themselves: the distinct starts seen across a month of one
              day type, with no capture scaling, since a slot counts once however many days saw it. Where a
              mid-month signup change leaves two timetables in one month, only starts that ran on at least
              half the days of their route-direction’s best-seen start in the same hour are counted. That
              keeps the timetable in force longest.
            </p>
            <p>
              The four periods (weekday peak, daytime, night, weekend) are not fixed clock hours. They are
              read off each signup’s scheduled buses-in-service profile: trips counted from first stop time
              to last, so the profile reflects the longer runs and extra buses that make a peak, which trip
              starts alone hide. Hours below half the busiest hour are night; the rest of the day is split
              where the level of service changes.
            </p>
            <p>
              Folding the four periods into one all-day figure needs a weighted harmonic mean, because each
              trip covers the same distance and it is time that varies:
            </p>
            <Eq note="n is trips per period, from period hours × days × 60 ÷ headway. A corridor's weight for combining across a region is its bus-km: trips × length.">
              {String.raw`v_{\text{all-day}} \;=\; \frac{\sum_{p} n_p}{\displaystyle\sum_{p} \frac{n_p}{v_p}}`}
            </Eq>
          </section>

          {/* ================================================== 5. validation */}
          <section id="validation">
            <p className="mth-eyebrow">Part five</p>
            <h2>5. What is known to be wrong</h2>

            <h3>5.1 Realign routes are not added at all</h3>
            <p>
              The counter feed kept its pre-Realign route labels through May 2026. After the August 2025
              Realign it drops 10, 99, 29 and 79 without ever adopting their successors 9, 22, 27 and 72L,
              so those four corridors have no counter rows anywhere in the data. They exist on the map only
              because the schedule reconstruction carries them, and every rider on them is imputed.
            </p>
            <p>
              The same feed never adopted “1T” after the August 2020 rename either. That one is handled
              explicitly, because the corridor is unambiguous: control “1T” is read as counter “1” from
              August 2020, 30 million boardings, with the ratio between the two sources verified at
              1.01–1.28 across the years. No other rename is inferred. A label the counters do not carry is
              left to the reconstruction rather than matched to a plausible neighbour.
            </p>

            <h3>5.2 The second records request is not accurate either</h3>
            <p>
              The route-level control is the anchor for every level on this site, and it does not agree with
              AC Transit’s own National Transit Database figures. Both are official. NTD divided by the
              control, by year:
            </p>
            <div className="mth-table-wrap">
              <table className="mth-table">
                <thead>
                  <tr>
                    <th>NTD ÷ control</th>
                    {["2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026"].map((y) => (
                      <th key={y} className="num">
                        {y}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>ratio</td>
                    {["1.029", "1.013", "0.960", "0.915", "0.948", "0.922", "0.916", "0.904"].map((v, i) => (
                      <td key={i} className="num">
                        {v}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              The gap is not noise and it is not shrinking: the two sources were within 3% of each other in
              2019 and are nearly 10% apart by 2026. This site calibrates to the control, so its totals sit
              above the NTD dashboard’s by roughly that margin in recent years. Comparing any figure here
              against an outside source means reading it against the system ratio for that month, not
              against 1.0.
            </p>
            <p>
              The control is also not internally clean. It double-counts the parent and split transbay
              families by about 4.3%, flat across years, which is deduplicated before it anchors anything.
              And it is only reliable at the grain it is published at. Normalised to each month’s system
              ratio, a route’s share of system ridership matches the control at median 0.983 (IQR
              0.917–1.019), and 98% of regular routes with 24 or more months sit within ±20%. Routes
              matching 6xx and 7xx, the school trippers, reach a median of 0.754, with only 24% inside ±20%.
              They are under-attributed by about a quarter: short, infrequent runs are the likeliest to fail
              the reliability gate, and their trips are the ones the stop-share vectors cover worst.{" "}
              <strong>Treat per-route school tripper figures as indicative only.</strong>
            </p>

            <h3>5.3 The control ends before the counters do</h3>
            <p>
              The control runs to January 2026. The counter feed runs to May 2026. For those four months
              there is no published route-month total to calibrate against, so each route and day type’s
              last observed level is carried forward and the result is flagged.
            </p>
            <p>
              This matters less than it sounds, because the counters are healthy there — 97% of boardings in
              that stretch are reliable — so the carried level is doing little work beyond setting a scale.
              It bites only on the 2.3% of boardings sitting in fully gated route-months, where the
              reconstruction is carrying the shape as well. Read the last four months of any route-level
              series as provisional: the distribution across stops and days is measured, the level is an
              assumption.
            </p>

            <h3>5.4 UC employees are missing from the workplace data</h3>
            <p>
              The commute view’s <em>All workplaces</em> and <em>All homes</em> cells come from LEHD LODES,
              which is built from state unemployment-insurance records. The University of California sits
              outside that coverage, so its employees are absent from LODES entirely.
            </p>
            <p>
              The effect is concentrated and large. Berkeley’s campus tract reads far emptier than it is on
              the all-workplaces cell, while the bus data’s own round-trip measure ranks it a top-five
              destination in the network. Neither side is wrong: the counters see people arriving at the
              campus and going home again, and LODES sees the jobs a state UI file knows about. Any ratio
              between the two cells over that tract is comparing against a denominator that is missing the
              largest employer in the city.
            </p>
            <p>
              The LODES cells are tract-level throughout, which is the finest grain LODES publishes, so they
              do not refine when the map is switched to block groups.
            </p>
          </section>

          {/* ======================================================== 6. code */}
          <section id="code">
            <p className="mth-eyebrow">Part six</p>
            <h2>6. Code and sources</h2>
            <p>
              Event-level counter extracts are published as a HuggingFace dataset,{" "}
              <a href="https://huggingface.co/datasets/somemone/ac-transit-apc" target="_blank" rel="noreferrer">
                somemone/ac-transit-apc
              </a>
              : 89 monthly Parquet files, about 5.9 GB, January 2019 through May 2026, one row per stop
              event. The packed bundle this site reads is a public bucket,{" "}
              <a
                href="https://storage.googleapis.com/ac-transit-ridership-pack/pack/manifest.json"
                target="_blank"
                rel="noreferrer"
              >
                ac-transit-ridership-pack
              </a>
              , whose <code>manifest.json</code> lists every file.
            </p>
            <div className="mth-table-wrap">
              <table className="mth-table">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Script</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Capture correction, reliability gates</td>
                    <td>
                      <code>build_capture.py</code>, <code>build_final.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Alightings and load</td>
                    <td>
                      <code>build_alightings.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Per route-month calibration</td>
                    <td>
                      <code>build_pra_calibration.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Schedule-only reconstruction</td>
                    <td>
                      <code>reconstruct_daily.py</code>, <code>stop_distribution.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>The weekly blend (§1.9)</td>
                    <td>
                      <code>build_weekly_blend.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Map matching and corridors</td>
                    <td>
                      <code>fetch_osm.py</code>, <code>map_match.py</code>,{" "}
                      <code>build_corridor_graph.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Packing to binary</td>
                    <td>
                      <code>build_prepack.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Commute profiles and O–D</td>
                    <td>
                      <code>build_commute_pack.py</code>
                    </td>
                  </tr>
                  <tr>
                    <td>Speeds, headways, bus lanes</td>
                    <td>
                      <code>build_service_pack.py</code>, <code>build_speed_pack.py</code>,{" "}
                      <code>build_buslanes_pack.py</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3>References</h3>
            <ul className="mth-refs">
              <li>
                Ji, Y., Mishalani, R. G., &amp; McCord, M. R. (2014). Estimating transit route OD flow
                matrices from APC data on multiple bus trips using the IPF method with an iteratively
                improved base.
              </li>
              <li>
                Newson, P., &amp; Krumm, J. (2009). Hidden Markov map matching through noise and sparseness.
              </li>
              <li>TCRP Report 113. Using archived AVL–APC data to improve transit performance and management.</li>
              <li>Denton, F. T. (1971). Adjustment of monthly or quarterly series to annual totals.</li>
            </ul>
            <p className="mth-foot">
              Code is MIT; data is CC BY 4.0. The counter records originate with the Alameda–Contra Costa
              Transit District. This project is not affiliated with or endorsed by AC Transit.
            </p>
            <p className="mth-links">
              <a href="/">Explore the map →</a>
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
