"use client";

/* The methodology, told as one figure that changes under the reader.

   The page is a scrollytelling section: a route diagram held in the middle of
   the frame on one side, passages scrolling past on the other, each passage
   naming the state the figure should be in. It follows the story page's
   mechanic deliberately -- the same scroll, the same sticky frame -- so a
   reader arriving from the story does not have to learn a second way of
   reading.

   The styling is a blackboard rather than a document: one dark plane that
   does not follow the site theme, no panels or cards, and every quantity
   named in the colour of the thing it measures, so the words `coverage
   factor` in a sentence and the green block they put on a bar are
   recognisably the same object. Prose is Georgia; only the formulae are set
   in a maths face.

   Figures in the closing table come from the pipeline artifacts; the
   histogram beside it is built by the same pass (w-histogram.json). */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";

import RouteFigure, { C_PRA, C_ROUTE, N_PRESENT, N_TRIPS, W_IMPUTED } from "./figure";
import HISTOGRAM from "./w-histogram.json";

const TRIGGER = 0.62;

function M({ children }) {
  const html = useMemo(
    () => katex.renderToString(children.trim(), { throwOnError: false, strict: "ignore" }),
    [children],
  );
  return <span className="mth-m" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Eq({ children }) {
  const html = useMemo(
    () => katex.renderToString(children.trim(), { displayMode: true, throwOnError: false, strict: "ignore" }),
    [children],
  );
  return <div className="mth-eq"><div className="mth-eq-body" dangerouslySetInnerHTML={{ __html: html }} /></div>;
}

/* A term in the colour of the thing it names in the figure. */
function C({ c, children }) {
  return <span className={`mth-c mth-c-${c}`}>{children}</span>;
}

/* Each entry is one passage and the figure state it puts on screen. A state
   repeated across passages simply holds, which is what lets a single idea run
   over two paragraphs without the diagram flickering. */
const STEPS = [
  {
    state: "observed",
    body: (
      <>
        <p>
          This is an example of a bus route. Buses pick up and drop off people from each station. Some bus
          trips don’t have sensor information. We can find trips that aren’t observed through schedules
          published by AC Transit, known as GTFS feeds. These public schedules are how applications like
          Google Maps calculate bus arrival times.
        </p>
      </>
    ),
  },
  {
    state: "observed",
    body: (
      <p>
        The <C c="observed">blue bars</C> represent observed data from the trip-level public records
        request. However, this is not a complete picture of ridership.
      </p>
    ),
  },
  {
    state: "coverage",
    body: (
      <>
        <p>
          First, we get a <C c="coverage">coverage factor</C> of the line{" "}
          <M>{String.raw`\textcolor{#83C167}{c_{route}} = N_{present}/N_{total}`}</M>. This is the percent
          of trips that are covered by the route. This assumes that missing trips are similar to other
          trips.
        </p>
        <p className="mth-aside">
          Here {N_PRESENT} of {N_TRIPS} trips reported, so{" "}
          <M>{String.raw`\textcolor{#83C167}{c_{route}}`}</M> is {C_ROUTE}.
        </p>
      </>
    ),
  },
  {
    state: "coverage",
    body: (
      <p>
        Each stop’s ridership is divided by <M>{String.raw`\textcolor{#83C167}{c_{route}}`}</M>, leading to
        increased ridership. This keeps the distribution of the line.
      </p>
    ),
  },
  {
    state: "calibration",
    body: (
      <>
        <p>
          As a <C c="calibration">calibration factor</C>, we use the existing public records request, which
          has an accurate count for total ridership <M>{String.raw`r_{route}`}</M> over the entire route.
          We collect{" "}
          <M>{String.raw`\textcolor{#5CD0B3}{c_{pra}} = (r_{observed} \cdot \textcolor{#83C167}{c_{route}}) / r_{pra}`}</M>
          , the factor by which ridership differs from AC Transit’s published ridership. We then multiply
          every stop by this factor.
        </p>
      </>
    ),
  },
  {
    state: "sparse",
    body: (
      <p>
        Some routes have significant data loss, like the routes introduced in 2025 under the Realign
        program. For this profound data loss, we find other routes that cover the same stops. As an example,
        the 27 and the 51B cover the same stops near UC Berkeley.
      </p>
    ),
  },
  {
    state: "donors",
    body: (
      <p>
        Using the existing public records request and the GTFS schedule for the number of trips and the
        total ridership, the distribution of ridership over the stop is estimated.
      </p>
    ),
  },
  {
    state: "donorFill",
    body: <p className="mth-aside">The <C c="donor">estimated distribution</C>, in purple.</p>,
  },
  {
    state: "weeks",
    body: (
      <p>
        Our data is presented by week, not by month. Some weeks in a month may have 10 times the sensors
        reporting with the same service. Because there is no calibration available, we must use our public
        schedules.
      </p>
    ),
  },
  {
    state: "weeks",
    body: (
      <>
        <p>We collect a percentage <M>w</M> of trips that do not meet requirements for inclusion.</p>
        <ul className="mth-list">
          <li>Under 40% of trips reported</li>
          <li>Under 70% of average reported trips for that route</li>
          <li>Under 70% of days have a single trip</li>
        </ul>
        <p>
          Rides in this category are weighted out and replaced with a distribution based on the level of
          service in the <C c="schedule">published schedules</C>.
        </p>
        <Eq>
          {String.raw`r_{week} = r_{month}\bigl(\textcolor{#F0AC5F}{w \cdot p_{schedule}} + \textcolor{#58C4DD}{(1-w) \cdot p_{week}}\bigr)`}
        </Eq>
      </>
    ),
  },
  {
    state: "mix",
    body: (
      <>
        <p>
          <M>w</M> is the % imputed figure shown on the website. Ridership derived from <M>w</M> is still
          from monthly data, and <M>w</M> is derived from the quality of the monthly data.
        </p>
        <p className="mth-aside">
          Drawn at <M>{String.raw`w = ${W_IMPUTED}`}</M>. Neither bar is invented: the{" "}
          <C c="imputed">imputed share</C> is the same month as the <C c="real">measured</C> one, held at
          the level the schedule expects instead of at the level the counters happened to see.
        </p>
      </>
    ),
  },
  { state: "blend", body: <p>This is what is shown on the website.</p> },
];

const CASES = [
  ["No data estimated (w=0)", "6,874", "61.1%"],
  ["Some data estimated (w>0)", "1,765", "15.7%"],
  ["All data estimated (w=1)", "2,241", "19.9%"],
  ["No sensors at all", "325", "2.9%"],
];

function Histogram() {
  const { edges, all, y2019 } = HISTOGRAM;
  const max = Math.max(...all);
  const w = 560;
  const h = 230;
  const pad = { l: 16, r: 16, t: 20, b: 40 };
  const bw = (w - pad.l - pad.r) / all.length;
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  return (
    <figure className="mth-hist">
      <svg viewBox={`0 0 ${w} ${h}`} role="img"
        aria-label="Distribution of the imputed share across route-months, with 2019 highlighted">
        {all.map((value, i) => (
          <g key={i}>
            <rect className="mth-fig-bar" x={pad.l + i * bw + 1.5} width={bw - 3} y={y(value)}
              height={h - pad.b - y(value)}
              style={{ fill: "var(--mth-observed)", stroke: "var(--mth-observed)" }} />
            <rect className="mth-fig-bar" x={pad.l + i * bw + 1.5} width={bw - 3} y={y(y2019[i])}
              height={h - pad.b - y(y2019[i])}
              style={{ fill: "var(--mth-schedule)", stroke: "var(--mth-schedule)" }} />
          </g>
        ))}
        <rect className="mth-fig-axis" x={pad.l} y={h - pad.b} width={w - pad.l - pad.r} height={1} />
        {[0, 0.5, 1].map((t) => (
          <text key={t} className="mth-fig-tick" x={pad.l + t * (w - pad.l - pad.r)} y={h - pad.b + 20}>
            {`w = ${t}`}
          </text>
        ))}
        <text className="mth-fig-num" x={pad.l + 2} y={y(max) - 8} textAnchor="start">
          {max.toLocaleString()}
        </text>
      </svg>
      <figcaption>
        Route-months by imputed share, all {HISTOGRAM.n_all.toLocaleString()} of them in{" "}
        <C c="observed">blue</C> and the {HISTOGRAM.n_2019.toLocaleString()} from 2019 in{" "}
        <C c="schedule">gold</C>. The distribution is bimodal: a route-month is usually either wholly
        measured or wholly estimated, and 2019 supplies most of the second group.
      </figcaption>
    </figure>
  );
}

export default function Methodology() {
  const [active, setActive] = useState(0);
  const cardRefs = useRef([]);
  const sectionRef = useRef(null);

  const update = useCallback(() => {
    const section = sectionRef.current;
    if (!section) return;
    const viewport = window.innerHeight;
    const box = section.getBoundingClientRect();
    if (box.bottom < -viewport || box.top > viewport * 2) return;
    const trigger = viewport * TRIGGER;
    let next = 0;
    cardRefs.current.forEach((card, index) => {
      if (card && card.getBoundingClientRect().top < trigger) next = index;
    });
    setActive(next);
  }, []);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(() => { frame = 0; update(); });
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [update]);

  return (
    <div className="mth">
      <header className="mth-hero">
        <h1>Methodology</h1>
        <p className="mth-kicker">AC Transit ridership · 2019–2026</p>
        <p className="mth-links">
          <a href="/">Explore the map</a> · <a href="/story">Read the story</a> ·{" "}
          <a href="/buslanes">Bus lanes</a>
        </p>
      </header>

      <div className="mth-intro">
        <p>
          At the core of this visualization is drop-offs and boardings per stop. This is collected by
          physical sensors, known as APCs, on buses. However, this information isn’t reported all time in
          the per-stop dataset. Importantly, the data loss is present in entire bus trips, not just at
          specific stops.
        </p>
        <p>
          To address this, <em>The Daily Californian</em> used an existing public records request that
          collected ridership per route, per month. This ridership is derived from AC Transit’s own
          estimation methods, and is what is reported by the agency itself.
        </p>
        <p>
          The gap between the APC dataset and the per-route-month dataset is significant. 27% of boardings
          do not exist in the APC dataset. Most of the missing data is before the pandemic.
        </p>
        <p className="mth-turn">We need to bridge this gap. The data loss is not uniform.</p>
      </div>

      <section className="mth-scrolly" ref={sectionRef}>
        <div className="mth-sticky">
          <div className="mth-frame">
            <RouteFigure state={STEPS[active].state} />
            <p className="mth-legend">
              <span className="mth-c mth-c-observed">observed</span>
              <span className="mth-c mth-c-coverage">coverage factor</span>
              <span className="mth-c mth-c-calibration">calibration</span>
              <span className="mth-c mth-c-donor">borrowed shape</span>
              <span className="mth-c mth-c-schedule">from the schedule</span>
            </p>
          </div>
        </div>
        <div className="mth-steps">
          {STEPS.map((step, index) => (
            <div className="mth-step" key={index}>
              <div
                className={`mth-card${index === active ? " is-active" : ""}`}
                ref={(element) => { cardRefs.current[index] = element; }}
              >
                {step.body}
              </div>
            </div>
          ))}
          <div className="mth-tail" />
        </div>
      </section>

      <section className="mth-close">
        <p className="mth-turn">Most routes are unaffected by this imputation, and are only calibrated.</p>
        <div className="mth-table-wrap">
          <table className="mth-table">
            <thead>
              <tr>
                <th>Case</th>
                <th className="num">Route-months (e.g. Route 51B, Jan 2020)</th>
                <th className="num">%</th>
              </tr>
            </thead>
            <tbody>
              {CASES.map(([label, n, pct]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{n}</td>
                  <td className="num">{pct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Histogram />
        <p className="mth-links"><a href="/">Explore the map →</a></p>
        <p className="mth-foot">
          Code is MIT; data is CC BY 4.0. The counter records originate with the Alameda–Contra Costa
          Transit District. This project is not affiliated with or endorsed by AC Transit.
        </p>
      </section>
    </div>
  );
}
