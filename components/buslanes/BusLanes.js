"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PACK } from "../ridership-data";
import { T, t } from "../../lib/i18n";

function monthLabel(id) {
  if (!id) return t("numbers.missing");
  const [year, month] = id.split("-").map(Number);
  return t("dates.monthYear", { month: t(`dates.monthsShort.${month - 1}`), year });
}

function pct(after, before) {
  if (!(after > 0) || !(before > 0)) return null;
  return (after / before - 1) * 100;
}

function signed(value, digits = 1) {
  if (value === null || !Number.isFinite(value)) return t("numbers.missing");
  const n = Math.abs(value).toFixed(digits);
  if (value > 0) return t("numbers.percentUp", { n });
  if (value < 0) return t("numbers.percentDown", { n });
  return t("numbers.percentFlat", { n });
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
  for (let tick = lo; tick <= hi; tick += 1) ticks.push(tick);

  return (
    <div className="bl-figure">
      <div className="bl-legend" aria-hidden="true">
        <span><i className="bl-key-dot before" />{t("busLanes.legendBefore")}</span>
        <span><i className="bl-key-dot after" />{t("busLanes.legendAfter")}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="bl-svg" role="img"
        aria-label={t("busLanes.dumbbellAria")}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} x2={x(tick)} y1={top - 6} y2={height - 6} className="bl-grid" />
            <text x={x(tick)} y={top - 12} className="bl-tick" textAnchor="middle">{tick}</text>
          </g>
        ))}
        <text x={changeX} y={top - 12} className="bl-tick strong" textAnchor="end">{t("busLanes.colChange")}</text>
        <text x={networkX} y={top - 12} className="bl-tick strong" textAnchor="end">{t("busLanes.colNetwork")}</text>
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
              <text x={0} y={y + 13} className="bl-row-sub">
                {t("busLanes.laneSubtitle", { city: lane.city, month: monthLabel(lane.installed) })}
              </text>
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
      <p className="bl-caption">{t("busLanes.dumbbellCaption")}</p>
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
  for (let tick = Math.ceil(lo / step) * step; tick <= hi; tick += step) yTicks.push(tick);
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
          aria-label={t("busLanes.laneChartAria", { name: lane.name })}
          onPointerMove={onMove}
          onPointerLeave={() => setAt(null)}
        >
          {before ? (
            <rect x={x(before[0])} width={x(before[1]) - x(before[0])} y={pad.top} height={height - pad.top - pad.bottom} className="bl-band" />
          ) : null}
          {after ? (
            <rect x={x(after[0])} width={x(after[1]) - x(after[0])} y={pad.top} height={height - pad.top - pad.bottom} className="bl-band" />
          ) : null}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="bl-grid" />
              <text x={pad.left - 6} y={y(tick) + 3} textAnchor="end" className="bl-tick">{tick}</text>
            </g>
          ))}
          {years.map(([id, index]) => (
            <text key={id} x={x(index)} y={height - 8} textAnchor="middle" className="bl-tick">{id.slice(0, 4)}</text>
          ))}
          {installed >= 0 ? (
            <g>
              <line x1={x(installed)} x2={x(installed)} y1={pad.top} y2={height - pad.bottom} className="bl-install" />
              <text x={x(installed) + 4} y={pad.top + 9} className="bl-tick strong">{t("busLanes.laneAdded")}</text>
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
            <div><i className="bl-key-line lane" />
              <b>{Number.isFinite(series[at]) ? t("units.mph", { n: series[at].toFixed(1) }) : t("numbers.missing")}</b> {lane.name}</div>
            <div><i className="bl-key-line network" />
              <b>{Number.isFinite(net[at]) ? t("units.mph", { n: net[at].toFixed(1) }) : t("numbers.missing")}</b> {t("busLanes.colNetwork")}</div>
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
        if (!response.ok) {
          throw new Error(t("errors.loadFailed", { name: "buslanes.json", status: response.status }));
        }
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
        <p className="bl-kicker">{t("busLanes.kicker")}</p>
        <h1>{t("busLanes.title")}</h1>
        <p className="bl-lede">{t("busLanes.lede")}</p>
        <p className="bl-links">
          <a href="/">{t("busLanes.linkExplore")}</a> · <a href="/story">{t("busLanes.linkStory")}</a>
          {" · "}<a href="/methodology">{t("busLanes.linkMethodology")}</a>
        </p>
      </header>

      {error ? <p className="bl-error">{t("busLanes.error", { message: error.message })}</p> : null}
      {!data && !error ? <p className="bl-loading">{t("busLanes.loading")}</p> : null}

      {data ? (
        <>
          <section className="bl-section">
            <h2>{t("busLanes.headingBeforeAfter")}</h2>
            <Dumbbell lanes={lanes} />
          </section>

          <section className="bl-section">
            <h2>{t("busLanes.headingMonthly")}</h2>
            <div className="bl-legend" aria-hidden="true">
              <span><i className="bl-key-line lane" />{t("busLanes.legendLane")}</span>
              <span><i className="bl-key-line network" />{t("busLanes.legendNetwork")}</span>
              <span><i className="bl-key-band" />{t("busLanes.legendBands")}</span>
            </div>
            <div className="bl-grid-charts">
              {lanes.map((lane) => (
                <LaneChart key={lane.id} lane={lane} network={data.network} months={data.months} />
              ))}
            </div>
          </section>

          <section className="bl-section">
            <h2>{t("busLanes.headingLanes")}</h2>
            <div className="bl-table-wrap">
              <table className="bl-table">
                <thead>
                  <tr>
                    <th>{t("busLanes.colStreet")}</th>
                    <th>{t("busLanes.colInstalled")}</th>
                    <th className="num">{t("busLanes.colBefore")}</th>
                    <th className="num">{t("busLanes.colAfter")}</th>
                    <th className="num">{t("busLanes.colChange")}</th>
                    <th className="num">{t("busLanes.colNetwork")}</th>
                  </tr>
                </thead>
                <tbody>
                  {lanes.map((lane) => (
                    <tr key={lane.id}>
                      <td>
                        <T id="busLanes.laneRowName" c={[<b />]}
                          vars={{ name: lane.name, city: lane.city }} />
                        <div className="bl-sub">{lane.extent}</div>
                        {lane.note ? <div className="bl-sub">{lane.note}</div> : null}
                        <div className="bl-sub">
                          {t("busLanes.sources")}{" "}
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
                        {lane.before.mph ? t("units.mph", { n: lane.before.mph.toFixed(1) }) : t("numbers.missing")}
                        <div className="bl-sub">{t("dates.monthRange", {
                          from: monthLabel(lane.before.from), to: monthLabel(lane.before.to) })}</div>
                      </td>
                      <td className="num">
                        {lane.after.mph ? t("units.mph", { n: lane.after.mph.toFixed(1) }) : t("numbers.missing")}
                        <div className="bl-sub">
                          {t("dates.monthRange", {
                            from: monthLabel(lane.after.from), to: monthLabel(lane.after.to) })}
                          {lane.after.months < data.window
                            ? t("busLanes.partialMonths", { n: lane.after.months }) : ""}
                        </div>
                      </td>
                      <td className="num">{signed(pct(lane.after.mph, lane.before.mph))}</td>
                      <td className="num">{signed(pct(lane.network_after, lane.network_before))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>{t("busLanes.headingUndated")}</h3>
            <p>{t("busLanes.undatedNote")}</p>
            <ul className="bl-undated">
              {data.undated.map((lane) => (
                <li key={lane.name}>
                  <T id="busLanes.undatedItem" c={[<b />]} vars={{
                    name: lane.name, city: lane.city,
                    km: lane.osm_km.toFixed(2), note: lane.note }} />
                </li>
              ))}
            </ul>
          </section>

          <section className="bl-section bl-method">
            <h2>{t("busLanes.headingMethod")}</h2>
            <p>{t("busLanes.method1")}</p>
            <p>{t("busLanes.method2")}</p>
            <p>{t("busLanes.method3")}</p>
            <p>{t("busLanes.method4")}</p>
            <p className="bl-sub">{data.osm_note}</p>
          </section>
        </>
      ) : null}
    </article>
  );
}
