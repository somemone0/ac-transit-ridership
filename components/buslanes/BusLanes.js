"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PACK } from "../ridership-data";

const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

function monthLabel(id) {
  if (!id) return "–";
  const [year, month] = id.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

function pct(after, before) {
  if (!(after > 0) || !(before > 0)) return null;
  return (after / before - 1) * 100;
}

function signed(value, digits = 1) {
  if (value === null || !Number.isFinite(value)) return "–";
  const text = Math.abs(value).toFixed(digits);
  return value > 0 ? `+${text}%` : value < 0 ? `−${text}%` : `${text}%`;
}

/* ------------------------------------------------------------ dumbbell */
/* One row per lane: its speed in the 12 months before the lane (grey dot) and
   the 12 months after (blue dot), on one mph axis. Values are direct-labelled;
   the network's change over the same months is set beside each row. */

function Dumbbell({ lanes }) {
  const [hover, setHover] = useState(null);
  const rows = lanes.filter((lane) => lane.before.mph && lane.after.mph);
  const values = rows.flatMap((lane) => [lane.before.mph, lane.after.mph]);
  const lo = Math.floor(Math.min(...values) - 1);
  const hi = Math.ceil(Math.max(...values) + 1);
  const width = 660;
  const left = 190;
  const right = 170;
  const changeX = width - right + 70;
  const networkX = width - 4;
  const rowH = 46;
  const top = 26;
  const height = top + rows.length * rowH + 10;
  const x = (mph) => left + ((mph - lo) / (hi - lo)) * (width - left - right);
  const ticks = [];
  for (let t = lo; t <= hi; t += 1) ticks.push(t);

  return (
    <div className="bl-figure">
      <div className="bl-legend" aria-hidden="true">
        <span><i className="bl-key-dot before" />12 months before the lane</span>
        <span><i className="bl-key-dot after" />12 months after</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="bl-svg" role="img"
        aria-label="Average bus speed on each bus lane before and after it was added">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={top - 6} y2={height - 6} className="bl-grid" />
            <text x={x(t)} y={top - 12} className="bl-tick" textAnchor="middle">{t}</text>
          </g>
        ))}
        <text x={changeX} y={top - 12} className="bl-tick strong" textAnchor="end">Change</text>
        <text x={networkX} y={top - 12} className="bl-tick strong" textAnchor="end">Network</text>
        {rows.map((lane, index) => {
          const y = top + index * rowH + rowH / 2;
          const change = pct(lane.after.mph, lane.before.mph);
          const network = pct(lane.network_after, lane.network_before);
          const on = hover === lane.id;
          return (
            <g
              key={lane.id}
              className={`bl-row${on ? " on" : ""}`}
              tabIndex={0}
              onPointerEnter={() => setHover(lane.id)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(lane.id)}
              onBlur={() => setHover(null)}
            >
              <rect x={0} y={y - rowH / 2} width={width} height={rowH} className="bl-hit" />
              <text x={0} y={y - 3} className="bl-row-name">{lane.name}</text>
              <text x={0} y={y + 13} className="bl-row-sub">{lane.city} · {monthLabel(lane.installed)}</text>
              <line x1={x(lane.before.mph)} x2={x(lane.after.mph)} y1={y} y2={y} className="bl-link" />
              <circle cx={x(lane.before.mph)} cy={y} r={5} className="bl-dot before" />
              <circle cx={x(lane.after.mph)} cy={y} r={5} className="bl-dot after" />
              <text
                x={x(lane.before.mph) + (lane.after.mph >= lane.before.mph ? -9 : 9)}
                y={y + 4}
                textAnchor={lane.after.mph >= lane.before.mph ? "end" : "start"}
                className="bl-value muted"
              >
                {lane.before.mph.toFixed(1)}
              </text>
              <text
                x={x(lane.after.mph) + (lane.after.mph >= lane.before.mph ? 9 : -9)}
                y={y + 4}
                textAnchor={lane.after.mph >= lane.before.mph ? "start" : "end"}
                className="bl-value"
              >
                {lane.after.mph.toFixed(1)}
              </text>
              <text x={changeX} y={y + 4} className="bl-value" textAnchor="end">{signed(change)}</text>
              <text x={networkX} y={y + 4} className="bl-value muted" textAnchor="end">{signed(network)}</text>
            </g>
          );
        })}
      </svg>
      <p className="bl-caption">
        Average bus speed in miles per hour, all day, including time at stops and lights. “Network” is the change
        across every AC Transit street over the same months.
      </p>
    </div>
  );
}

/* --------------------------------------------------------- small multiple */
/* A lane's monthly speed (blue) against the whole network's (grey, same mph
   axis), with the before and after windows shaded and the install month
   marked. A crosshair snaps to the nearest month and reads out both. */

function LaneChart({ lane, network, months }) {
  const [at, setAt] = useState(null);
  const svgRef = useRef(null);
  const width = 560;
  const height = 210;
  const pad = { left: 38, right: 12, top: 14, bottom: 26 };
  const series = lane.monthly.map((point) => point.mph);
  const net = network.map((point) => point.mph);
  const all = [...series, ...net].filter((v) => Number.isFinite(v));
  const lo = Math.floor(Math.min(...all) - 0.5);
  const hi = Math.ceil(Math.max(...all) + 0.5);
  const x = (index) => pad.left + (index / (months.length - 1)) * (width - pad.left - pad.right);
  const y = (mph) => pad.top + (1 - (mph - lo) / (hi - lo)) * (height - pad.top - pad.bottom);
  const path = (values) => {
    let d = "";
    let pen = false;
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const indexOf = (id) => months.indexOf(id);
  const installed = indexOf(lane.installed);
  const band = (from, to) => (from && to ? [indexOf(from), indexOf(to)] : null);
  const before = band(lane.before.from, lane.before.to);
  const after = band(lane.after.from, lane.after.to);
  const yTicks = [];
  const step = hi - lo > 6 ? 2 : 1;
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) yTicks.push(t);
  const years = months.map((id, index) => [id, index]).filter(([id]) => id.endsWith("-01"));

  const onMove = (event) => {
    const box = svgRef.current.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const index = Math.round(((px - pad.left) / (width - pad.left - pad.right)) * (months.length - 1));
    setAt(Math.max(0, Math.min(months.length - 1, index)));
  };

  return (
    <figure className="bl-lane-chart">
      <figcaption>
        <b>{lane.name}</b> <span>{lane.city}</span>
      </figcaption>
      <div className="bl-chart-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className="bl-svg"
          role="img"
          aria-label={`Monthly average bus speed on ${lane.name} and across the network, 2019 to 2026`}
          onPointerMove={onMove}
          onPointerLeave={() => setAt(null)}
        >
          {before ? (
            <rect x={x(before[0])} width={x(before[1]) - x(before[0])} y={pad.top} height={height - pad.top - pad.bottom} className="bl-band" />
          ) : null}
          {after ? (
            <rect x={x(after[0])} width={x(after[1]) - x(after[0])} y={pad.top} height={height - pad.top - pad.bottom} className="bl-band" />
          ) : null}
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="bl-grid" />
              <text x={pad.left - 6} y={y(t) + 3} textAnchor="end" className="bl-tick">{t}</text>
            </g>
          ))}
          {years.map(([id, index]) => (
            <text key={id} x={x(index)} y={height - 8} textAnchor="middle" className="bl-tick">{id.slice(0, 4)}</text>
          ))}
          {installed >= 0 ? (
            <g>
              <line x1={x(installed)} x2={x(installed)} y1={pad.top} y2={height - pad.bottom} className="bl-install" />
              <text x={x(installed) + 4} y={pad.top + 9} className="bl-tick strong">Lane added</text>
            </g>
          ) : null}
          <path d={path(net)} className="bl-line network" />
          <path d={path(series)} className="bl-line lane" />
          {at !== null ? (
            <g>
              <line x1={x(at)} x2={x(at)} y1={pad.top} y2={height - pad.bottom} className="bl-crosshair" />
              {Number.isFinite(series[at]) ? <circle cx={x(at)} cy={y(series[at])} r={4} className="bl-dot after ringed" /> : null}
              {Number.isFinite(net[at]) ? <circle cx={x(at)} cy={y(net[at])} r={4} className="bl-dot before ringed" /> : null}
            </g>
          ) : null}
          <rect x={pad.left} y={pad.top} width={width - pad.left - pad.right} height={height - pad.top - pad.bottom} className="bl-hit" />
        </svg>
        {at !== null ? (
          <div className="bl-tooltip" style={{ left: `${(x(at) / width) * 100}%` }}>
            <div className="bl-tooltip-title">{monthLabel(months[at])}</div>
            <div><i className="bl-key-line lane" /><b>{Number.isFinite(series[at]) ? `${series[at].toFixed(1)} mph` : "–"}</b> {lane.name}</div>
            <div><i className="bl-key-line network" /><b>{Number.isFinite(net[at]) ? `${net[at].toFixed(1)} mph` : "–"}</b> Network</div>
          </div>
        ) : null}
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ page */

export default function BusLanes() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${PACK}/buslanes.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load buslanes.json (${response.status})`);
        return response.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((loadError) => { if (!cancelled) setError(loadError); });
    return () => { cancelled = true; };
  }, []);

  const lanes = useMemo(() => data?.lanes || [], [data]);

  return (
    <article className="bl">
      <header className="bl-hero">
        <p className="bl-kicker">AC Transit, 2019–2026</p>
        <h1>Bus lanes and bus speeds</h1>
        <p className="bl-lede">
          Four streets in the AC Transit service area gained bus lanes with a documented start date between 2019
          and 2026. This page compares how fast buses moved on each in the year before and the year after.
        </p>
        <p className="bl-links"><a href="/">Explore the map</a> · <a href="/story">Read the story</a> · <a href="/methodology">Methodology</a></p>
      </header>

      {error ? <p className="bl-error">The data could not be loaded: {error.message}</p> : null}
      {!data && !error ? <p className="bl-loading">Loading…</p> : null}

      {data ? (
        <>
          <section className="bl-section">
            <h2>Speed before and after</h2>
            <Dumbbell lanes={lanes} />
          </section>

          <section className="bl-section">
            <h2>Month by month</h2>
            <div className="bl-legend" aria-hidden="true">
              <span><i className="bl-key-line lane" />Bus lane street</span>
              <span><i className="bl-key-line network" />All AC Transit streets</span>
              <span><i className="bl-key-band" />Before and after windows</span>
            </div>
            <div className="bl-grid-charts">
              {lanes.map((lane) => (
                <LaneChart key={lane.id} lane={lane} network={data.network} months={data.months} />
              ))}
            </div>
          </section>

          <section className="bl-section">
            <h2>The lanes</h2>
            <div className="bl-table-wrap">
              <table className="bl-table">
                <thead>
                  <tr>
                    <th>Street</th>
                    <th>Installed</th>
                    <th className="num">Before</th>
                    <th className="num">After</th>
                    <th className="num">Change</th>
                    <th className="num">Network</th>
                  </tr>
                </thead>
                <tbody>
                  {lanes.map((lane) => (
                    <tr key={lane.id}>
                      <td>
                        <b>{lane.name}</b>, {lane.city}
                        <div className="bl-sub">{lane.extent}</div>
                        {lane.note ? <div className="bl-sub">{lane.note}</div> : null}
                        <div className="bl-sub">
                          Sources:{" "}
                          {lane.sources.map((source, index) => (
                            <span key={source.url}>
                              {index ? "; " : ""}
                              <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>{lane.installed_label}</td>
                      <td className="num">
                        {lane.before.mph ? `${lane.before.mph.toFixed(1)} mph` : "–"}
                        <div className="bl-sub">{monthLabel(lane.before.from)}–{monthLabel(lane.before.to)}</div>
                      </td>
                      <td className="num">
                        {lane.after.mph ? `${lane.after.mph.toFixed(1)} mph` : "–"}
                        <div className="bl-sub">
                          {monthLabel(lane.after.from)}–{monthLabel(lane.after.to)}
                          {lane.after.months < data.window ? ` (${lane.after.months} months)` : ""}
                        </div>
                      </td>
                      <td className="num">{signed(pct(lane.after.mph, lane.before.mph))}</td>
                      <td className="num">{signed(pct(lane.network_after, lane.network_before))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Other bus lanes without a start date</h3>
            <p>
              These are mapped as bus lanes in OpenStreetMap, but no source gave a date they were added, so they are
              not compared.
            </p>
            <ul className="bl-undated">
              {data.undated.map((lane) => (
                <li key={lane.name}>
                  <b>{lane.name}</b>, {lane.city} ({lane.osm_km.toFixed(2)} km mapped). {lane.note}
                </li>
              ))}
            </ul>
          </section>

          <section className="bl-section bl-method">
            <h2>How this was measured</h2>
            <p>
              Speeds come from AC Transit’s automatic passenger counters. For each trip, the time between the doors
              opening at one stop and the next is divided into the distance between them, so the figures include
              time spent at stops and traffic lights. They are averaged by month over every trip on each street,
              weighted by how much service runs at each time of day.
            </p>
            <p>
              A street segment counts as part of a lane when most of it lies within 15 meters of the lane as mapped in
              OpenStreetMap. “Before” is the 12 months ending the month before the lane was added and “after” the 12
              months starting the month after; the month itself is left out.
            </p>
            <p>
              A before-and-after comparison cannot separate a lane from everything else that changed at the same time.
              Traffic fell sharply across the region in 2020, when the International Blvd. and Broadway lanes opened;
              the 1T replaced the local route 1 with fewer stops the same day Tempo opened; and AC Transit redesigned its
              routes in August 2025, around the Durant Ave. and Bancroft Way projects. The network column shows how
              speeds changed everywhere over the same months, for comparison.
            </p>
            <p>
              The street map these speeds are measured on was updated in January 2022 and April 2025. A street’s speed
              can shift a little at those dates because its segments are drawn differently, not because buses changed
              speed. The Durant Ave. and Bancroft Way comparisons span the April 2025 update, so treat their small
              changes with extra caution.
            </p>
            <p className="bl-sub">{data.osm_note}</p>
          </section>
        </>
      ) : null}
    </article>
  );
}
