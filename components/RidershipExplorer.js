"use client";

import { useEffect, useRef, useState } from "react";
import { HourlyChart, SelectionChart, SeriesChart } from "./Charts";
import {
  DIVERGING,
  DIVERGING_RG,
  REC_NEVER,
  REC_SMALL,
  SEQ_BLUE,
  SEQ_GOLD,
  SEQ_GREEN,
  SEQ_MAGENTA,
  colorFor,
  commuteDomain,
  commuteHourly,
  commuteODLists,
  commuteRegionLists,
  commuteStats,
  corridorColor,
  corridorDomain,
  corridorStats,
  eraForWeek,
  escapeHtml,
  fmt,
  imputedAt,
  incomeAt,
  incomeDomain,
  loadCommuteOD,
  loadVisualizationData,
  nodeFlow,
  ramp,
  rawAt,
  routeBoardings,
  routeOwnSeries,
  routeStreetSeries,
  routesFor,
  sectionLoad,
  selectionSeries,
  totalAt,
} from "./ridership-data";

// Optional CARTO basemap key. Unset (the default) falls back to the
// plain OSM tile server, which needs no credential.
const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_KEY || "";
const BASE_ZOOM = 12;
const MAX_DOT_R = 13;
// Stop groups are clustered at 100 m and sit roughly 200 m apart along a
// route. At zoom 14 that is ~26 px between them, so dots up to 6 px across
// read as separate points on a line; at 13 it is ~13 px and they merge into a
// dotted smear, which is what the whole network looked like at 12.
const NODE_MIN_ZOOM = 14;
// Beyond this the tooltip is taller than the map is useful; the click menu
// lists every line without truncation.
const ROUTE_LIST_MAX = 10;

function discloseHtml(real, imp) {
  return `${fmt(real + imp)} <span class="gold">(${fmt(imp)})</span>`;
}

function DisclosureValue({ real, imp }) {
  return (
    <>
      {fmt(real + imp)} <span className="gold">({fmt(imp)})</span>
    </>
  );
}

function Row({ label, children }) {
  return (
    <div className="row">
      <span className="k">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function StatRows({ data, level, keyIndex, week }) {
  const boardReal = rawAt(data, level, keyIndex, week, 0);
  const boardImp = rawAt(data, level, keyIndex, week, 1);
  const alightReal = rawAt(data, level, keyIndex, week, 2);
  const alightImp = rawAt(data, level, keyIndex, week, 3);
  const total = boardReal + boardImp + alightReal + alightImp;
  const imputed = boardImp + alightImp;
  const baseline = totalAt(data, level, keyIndex, data.BASE);
  return (
    <>
      <Row label="Boardings">
        <DisclosureValue real={boardReal} imp={boardImp} />
      </Row>
      <Row label="Alightings">
        <DisclosureValue real={alightReal} imp={alightImp} />
      </Row>
      <Row label="Ridership">
        <DisclosureValue real={boardReal + alightReal} imp={imputed} />
      </Row>
      <Row label="Imputed">{total > 0 ? `${(100 * imputed / total).toFixed(1)}%` : "-"}</Row>
      <Row label="vs Feb 2020">{baseline > 0 ? `${(100 * total / baseline).toFixed(0)}%` : "-"}</Row>
    </>
  );
}

function AreaDetail({ data, detail, week, onRouteClick, commute, periodIdx }) {
  const { meta } = data;
  const { lv: level, key: keyIndex } = detail;
  const group = meta.stop_groups;
  const routes = routesFor(data, level, keyIndex, week);
  const recoveryTable = meta.recovery[level === "group" ? "stopgroup" : level]?.[keyIndex] || [];
  const label = detail.label;
  const series = selectionSeries(data, [keyIndex]);
  const members = level === "group" ? group.members[keyIndex] || [] : [];

  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <StatRows data={data} level={level} keyIndex={keyIndex} week={week} />
      </div>
      <h4>Weekly ridership 2019-2026</h4>
      <SeriesChart series={series} meta={meta} />
      <CommutePanel
        data={data}
        commute={commute}
        level={level}
        keyIndex={keyIndex}
        p={periodIdx}
      />
      <h4>Recovery to Feb 2020</h4>
      {meta.recovery_thresholds.map((threshold, index) => {
        const month = recoveryTable[index];
        return (
          <div className="rec-row" key={threshold}>
            <span className="k">{(threshold * 100).toFixed(0)}% of Feb 2020</span>
            <span className={month < 0 ? "never" : undefined}>
              {month === -2 ? "baseline too small" : month === -1 ? "not yet" : meta.months[month]}
            </span>
          </div>
        );
      })}
      <h4>Routes ({eraForWeek(data, week) || "current"} signup)</h4>
      {routes.length ? (
        <div className="chips">
          {routes.map((route) => (
            <button className="chip" type="button" key={route} onClick={() => onRouteClick(route)}>
              {route}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">No route geometry in this era.</p>
      )}
      {level === "group" ? (
        <>
          <h4>{members.length} stop{members.length === 1 ? "" : "s"} in group</h4>
          <div className="stoplist">
            {members.map(([id, name]) => (
              <div key={`${id}-${name}`}>
                {name} <span style={{ opacity: 0.55 }}>#{id}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function getCachedRouteSeries(data, route) {
  if (!data.routeSeriesCache) data.routeSeriesCache = {};
  if (!data.routeSeriesCache[route]) {
    data.routeSeriesCache[route] = {
      own: routeOwnSeries(data, route),
      street: routeStreetSeries(data, route),
    };
  }
  return data.routeSeriesCache[route];
}

function RouteDetail({ data, route, week, routeMode, onModeChange, commute, periodIdx }) {
  const { meta } = data;
  const cached = getCachedRouteSeries(data, route);
  const own = cached.own;
  const street = cached.street;
  const series = routeMode === "own" ? own : street;
  const eras = own.eras.length ? own.eras : street.eras;
  const currentLoad = series.real[week] + series.imp[week];
  const streetLoad = street.real[week] + street.imp[week];
  const boardings = routeBoardings(data, route, week);
  const isScheduleOnly = (meta.sched_only_routes || []).includes(route);
  const directionsByEra = {};
  for (const era of street.eras) directionsByEra[era.era] = era.dirs;
  const directionText = (directions) =>
    directions
      .map((direction) => direction === "0" ? "outbound" : "inbound")
      .sort()
      .join(" + ") || "-";

  return (
    <>
      <div className="seg">
        <button
          className={`segbtn${routeMode === "own" ? " on" : ""}`}
          type="button"
          onClick={() => onModeChange("own")}
        >
          This route
        </button>
        <button
          className={`segbtn${routeMode === "street" ? " on" : ""}`}
          type="button"
          onClick={() => onModeChange("street")}
        >
          Streets it uses
        </button>
      </div>
      <div style={{ marginBottom: 6 }}>
        <Row label={`Onboard load / wk, week of ${meta.weeks[week]}`}>
          <DisclosureValue real={series.real[week]} imp={series.imp[week]} />
        </Row>
        <Row label="Imputed">
          {currentLoad > 0 ? `${(100 * series.imp[week] / currentLoad).toFixed(1)}%` : "-"}
        </Row>
        <Row label="Share of street total">
          {streetLoad > 0 ? `${(100 * (own.real[week] + own.imp[week]) / streetLoad).toFixed(0)}%` : "-"}
        </Row>
        {boardings ? (
          <>
            <Row label="Boardings / wk">
              <DisclosureValue real={boardings.real} imp={boardings.imp} />
            </Row>
            <Row label="Sections per rider">
              {boardings.real + boardings.imp > 0 && !isScheduleOnly
                ? ((own.real[week] + own.imp[week]) / (boardings.real + boardings.imp)).toFixed(1)
                : "-"}
            </Row>
          </>
        ) : null}
      </div>
      <h4>Weekly onboard load (person-segments) 2019-2026</h4>
      <SeriesChart series={series} meta={meta} />
      <CommutePanel
        data={data}
        commute={commute}
        level="route"
        keyIndex={data.routeNameIx.get(route)}
        p={periodIdx}
      />
      {isScheduleOnly ? (
        <p className="hint schedule-warning">
          This line has no APC coverage, so its load profile is reconstructed and <b>not reliable</b>.
          Section load is cumulative boardings minus alightings, but the reconstruction spreads
          alightings by an unordered share vector, so the profile never builds. Use the boardings figure instead.
        </p>
      ) : null}
      <p className="hint">
        {routeMode === "own"
          ? `Sum of onboard load over this route's own ${eras.reduce((sum, era) => sum + era.nsec, 0)} stop-to-stop sections - no apportionment. This is not a headcount: it integrates each rider over every section they ride, so it exceeds boardings by the average trip length shown above.`
          : "Total load on every line using these streets, this route included. Answers how busy is this corridor, not how busy is this line."} Zero weeks = no geometry in that signup.
      </p>
      <h4>Geometry by signup</h4>
      {eras.length ? (
        eras.map((era) => (
          <div className="row" key={era.era}>
            <span className="k">{era.era}</span>
            <span>
              {era.nsec} section{era.nsec === 1 ? "" : "s"} · {directionText(directionsByEra[era.era] || [])}
            </span>
          </div>
        ))
      ) : (
        <p className="hint">No corridor geometry for this route.</p>
      )}
    </>
  );
}

function DetailPanel({ data, detail, week, routeMode, onRouteClick, onModeChange, onClose, commute, periodIdx }) {
  return (
    <aside id="detailPanel">
      <div className="cp-head">
        <span id="dTitle">{detail.lv === "route" ? `Route ${detail.key}` : detail.label}</span>
        <button className="btn small ghost" type="button" aria-label="Close details" onClick={onClose}>
          X
        </button>
      </div>
      {detail.lv === "route" ? (
        <RouteDetail
          data={data}
          route={detail.key}
          week={week}
          routeMode={routeMode}
          onModeChange={onModeChange}
          commute={commute}
          periodIdx={periodIdx}
        />
      ) : (
        <AreaDetail
          data={data}
          detail={detail}
          week={week}
          onRouteClick={onRouteClick}
          commute={commute}
          periodIdx={periodIdx}
        />
      )}
    </aside>
  );
}

function Legend({ data, view, level, recThresh, commute, commuteMode, period, commuteFocus, commuteFocusMode, focusMax }) {
  if (!data) return null;
  const { meta } = data;
  const bar = (colors) => (
    <div className="legend-bar">
      {colors.map((color) => <span key={color} style={{ background: color }} />)}
    </div>
  );
  const labels = (left, right) => (
    <div className="legend-labels"><span>{left}</span><span>{right}</span></div>
  );

  if (level === "none") {
    return <p className="hint">Areas hidden. Corridor width and colour show onboard load; hover any corridor for its routes.</p>;
  }
  if (view === "income") {
    const [lo, hi] = incomeDomain(data);
    const income = data.meta.income;
    return (
      <>
        {bar(SEQ_MAGENTA)}
        {labels(`$${Math.round(lo / 1000)}k`, `$${Math.round(hi / 1000)}k+`)}
        <p className="hint">
          {income.measure}, ACS {income.year} 5-year ({income.table}). Fixed to the
          tract range, so a colour means the same income at either level. Washed-out
          fills are estimates with a wide margin of error &mdash; hover for the
          &plusmn; figure. Grey: not published. Corridors keep showing onboard load.
        </p>
        <p className="hint">
          One figure for the whole period: ACS does not track week to week, so the
          time bar does not move it.
        </p>
      </>
    );
  }
  if (view === "commute") {
    if (!commute) {
      return <p className="hint">Commute pack unavailable — run scripts/build_commute_pack.py.</p>;
    }
    if (commuteFocus) {
      return (
        <>
          {bar(SEQ_GREEN)}
          {labels("no inferred flow", `${fmt(focusMax)} riders / wkday`)}
          <p className="hint">
            Morning (5-9am) inferred riders {commuteFocusMode === "from" ? "leaving" : "arriving at"}{" "}
            <b>{commuteFocus.label}</b>, {period.label} snapshot. Grey: no flow above the floor.
            Click another place to re-focus; X in the sidebar clears.
          </p>
        </>
      );
    }
    if (commuteMode === "peaks") {
      return (
        <>
          {bar(SEQ_BLUE)}
          {labels("flat all day", "sharp AM+PM peaks")}
          <p className="hint">Peak-hour riding vs the daytime average — which places have commuting peaks. Size still encodes volume.</p>
        </>
      );
    }
    return (
      <>
        {bar(DIVERGING)}
        {labels("homes (leave AM)", "workplaces (arrive AM)")}
        <p className="hint">Morning balance of boardings vs alightings, {period.label} average weekday. Grey: too little service to judge. Click any place to recolour the map by inferred riders {commuteFocusMode === "from" ? "from" : "to"} it.</p>
      </>
    );
  }
  if (view === "total") {
    return (
      <>
        {bar(SEQ_BLUE)}
        {labels("0", `${fmt(data.domains[level])}+ / wk`)}
        <p className="hint">Boardings + alightings per week. Circle size also encodes volume.</p>
      </>
    );
  }
  if (view === "imp") {
    return (
      <>
        {bar(SEQ_GOLD)}
        {labels("0%", "100% imputed")}
        <p className="hint">Share of ridership from route-months failing the reliability gate.</p>
      </>
    );
  }
  if (view === "recovery") {
    const low = meta.recovery_baseline_month + 2;
    return (
      <>
        {bar(SEQ_BLUE)}
        {labels(meta.months[low], meta.months[meta.months.length - 1])}
        <div className="legend-swatch"><span style={{ background: REC_NEVER }} /><span>never sustained by 2026-05</span></div>
        <div className="legend-swatch"><span style={{ background: REC_SMALL }} /><span>baseline too small to assess</span></div>
        <p className="hint">
          First month holding {(meta.recovery_thresholds[recThresh] * 100).toFixed(0)}% of Feb 2020 for three straight months.
        </p>
      </>
    );
  }
  return (
    <>
      {bar(DIVERGING_RG)}
      {labels("0%", "200%")}
      <p className="hint">Grey is approximately 100%: back to the week of {meta.baseline_label}. Red below baseline, green above.</p>
    </>
  );
}

function RouteSearch({ data, week, onPick }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const routes = Object.keys(data.routeSections).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const normalized = query.trim().toLowerCase();
  const hits = (normalized
    ? routes.filter((route) => route.toLowerCase().startsWith(normalized))
      .concat(routes.filter((route) => !route.toLowerCase().startsWith(normalized) && route.toLowerCase().includes(normalized)))
    : routes).slice(0, 40);
  const era = eraForWeek(data, week);
  const pick = (route) => {
    setOpen(false);
    setCursor(-1);
    setQuery("");
    onPick(route);
  };

  return (
    <div id="routeSearch">
      <input
        id="rsInput"
        type="search"
        value={query}
        placeholder="Find a route..."
        autoComplete="off"
        spellCheck="false"
        aria-label="Find a route"
        onChange={(event) => { setQuery(event.target.value); setCursor(-1); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.currentTarget.blur();
          } else if (hits.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
            setCursor((current) => (current + (event.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
          } else if (hits.length && event.key === "Enter") {
            event.preventDefault();
            pick(hits[cursor >= 0 ? cursor : 0]);
          }
        }}
      />
      {open && hits.length ? (
        <ul id="rsList">
          {hits.map((route, index) => {
            const sectionCount = ((data.routeSections[route] || {})[era] || []).length;
            return (
              <li
                className={index === cursor ? "on" : undefined}
                key={route}
                onMouseDown={(event) => { event.preventDefault(); pick(route); }}
              >
                <span>{route}</span>
                <span className="sub">{sectionCount ? `${sectionCount} sections` : `not in ${era}`}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function SelectionPanel({ data, selection, week, canvasRef, onClear }) {
  const series = selectionSeries(data, selection);
  const exportPng = () => {
    if (!canvasRef.current) return;
    const link = document.createElement("a");
    link.download = `ac-transit-recovery-${data.meta.weeks[week]}.png`;
    link.href = canvasRef.current.toDataURL("image/png");
    link.click();
  };
  return (
    <div id="chartPanel">
      <div className="cp-head">
        <span id="cpTitle">{selection.length} stop group{selection.length === 1 ? "" : "s"} selected</span>
        <span className="cp-actions">
          <button className="btn small" type="button" onClick={exportPng}>Export PNG</button>
          <button className="btn small ghost" type="button" aria-label="Close chart" onClick={onClear}>X</button>
        </span>
      </div>
      <SelectionChart series={series} meta={data.meta} canvasRef={canvasRef} />
    </div>
  );
}

// One row, with the margin of error beside the figure rather than buried. ACS
// block-group medians carry a median error of about a third of the estimate,
// so a bare number here would claim precision the survey does not have.
function incomeRowHtml(data, level, keyIndex) {
  const income = incomeAt(data, level, keyIndex);
  const label = level === "group" ? "Median income (tract)" : "Median income";
  if (!income) {
    return `<div class="row"><span class="k">${label}</span><span>not published</span></div>`;
  }
  const value = income.topCoded ? "$250,000+" : `$${Math.round(income.med).toLocaleString()}`;
  const error = income.topCoded || !income.moe
    ? ""
    : ` <span class="k">&plusmn; ${Math.round(income.moe).toLocaleString()}</span>`;
  return `<div class="row"><span class="k">${label}</span><span>${value}${error}</span></div>`;
}

function statHtml(data, level, keyIndex, week) {
  const boardReal = rawAt(data, level, keyIndex, week, 0);
  const boardImp = rawAt(data, level, keyIndex, week, 1);
  const alightReal = rawAt(data, level, keyIndex, week, 2);
  const alightImp = rawAt(data, level, keyIndex, week, 3);
  const total = boardReal + boardImp + alightReal + alightImp;
  const imputed = boardImp + alightImp;
  const baseline = totalAt(data, level, keyIndex, data.BASE);
  return `<div class="row"><span class="k">Boardings</span><span>${discloseHtml(boardReal, boardImp)}</span></div>
    <div class="row"><span class="k">Alightings</span><span>${discloseHtml(alightReal, alightImp)}</span></div>
    <div class="row"><span class="k">Ridership</span><span>${discloseHtml(boardReal + alightReal, imputed)}</span></div>
    <div class="row"><span class="k">Imputed</span><span>${total > 0 ? `${(100 * imputed / total).toFixed(1)}%` : "-"}</span></div>
    <div class="row"><span class="k">vs Feb 2020</span><span>${baseline > 0 ? `${(100 * total / baseline).toFixed(0)}%` : "-"}</span></div>
    ${incomeRowHtml(data, level, keyIndex)}`;
}

function groupTipHtml(data, keyIndex, week) {
  const group = data.meta.stop_groups;
  return `<div style="font-size:12px"><b>${escapeHtml(group.name[keyIndex])}</b>
    <span style="opacity:.65">${group.n_stops[keyIndex]} stop${group.n_stops[keyIndex] > 1 ? "s" : ""}</span>
    <div style="margin-top:4px">${statHtml(data, "group", keyIndex, week)}</div></div>`;
}

function areaTipHtml(data, level, keyIndex, props, week) {
  const name = props.name || props.geoid;
  return `<div style="font-size:12px"><b>${escapeHtml(name)}</b>
    <div style="margin-top:4px">${statHtml(data, level, keyIndex, week)}</div></div>`;
}

function areaStyle(state, level, index) {
  let color = null;
  let edge = { color: "#fcfcfb", weight: 0.7 };
  const focus = state.view === "commute" ? state.commuteFocus : null;
  if (index !== undefined) {
    if (state.view === "commute" && state.commute) {
      if (focus && focus.lists) {
        const flow = state.commuteFocusMap.get(index);
        if (flow) color = ramp(SEQ_GREEN, Math.sqrt(flow / state.commuteFocusMax));
        if (index === focus.key) edge = { color: "#0d5732", weight: 2 };
        else if (state.commuteFocusMembers?.has(index)) {
          edge = { color: "#419c62", weight: 1.5 };
        }
      } else {
        color = commuteValue(
          state.commute,
          level,
          index,
          state.commuteMode,
          state.commutePeriodIdx,
        ).color;
      }
    } else {
      color = colorFor(state.data, level, index, state.week, state.view, state.recThresh);
    }
  }
  return {
    fillColor: color || "#e8e7e2",
    fillOpacity: color ? 0.68 : 0.15,
    ...edge,
  };
}

function renderDataLayer(api, data, options) {
  const { L, dataLayer } = api;
  const { week, view, level, recThresh } = options;
  api.renderState = options;

  if (level === "none") {
    if (api.dataMode !== "none") {
      dataLayer.clearLayers();
      api.dataMode = "none";
    }
    return;
  }

  const commute = view === "commute" ? options.commute : null;
  const focus = view === "commute" ? options.commuteFocus : null;
  let focusMap = null;
  let focusMax = 1;
  if (focus && focus.lists) {
    const entries = options.commuteFocusMode === "from" ? focus.lists.out : focus.lists.in;
    focusMap = new Map(entries.map((entry) => [entry.g, entry.flow]));
    focusMax = entries.length ? entries[0].flow : 1;
  }
  // areaStyle reads these off the render state; options IS api.renderState.
  options.commuteFocusMap = focusMap;
  options.commuteFocusMax = focusMax;
  options.commuteFocusMembers = focus && focus.kind === "region" && focus.lists
    ? focus.lists.memberKeys
    : null;

  if (level === "group") {
    if (!api.groupMarkers) {
      const groups = data.meta.stop_groups;
      api.groupMarkers = [];
      for (let index = 0; index < groups.n; index += 1) {
        const marker = L.circleMarker([groups.lat[index], groups.lon[index]], {
          radius: 1,
          fillColor: "#e8e7e2",
          fillOpacity: 0,
          opacity: 0,
          color: "#fcfcfb",
          weight: 1,
        })
          .bindTooltip(() => (api.renderState.view === "commute" && api.renderState.commute
            ? commuteTipHtml(data, "group", index, groups.name[index], api.renderState.commutePeriodIdx)
            : groupTipHtml(data, index, api.renderState.week)), { sticky: true })
          .on("click", () => api.renderState.callbacks.onMapClick("group", index, groups.name[index]));
        api.groupMarkers.push(marker);
      }
    }
    if (api.dataMode !== "group") {
      dataLayer.clearLayers();
      api.groupMarkers.forEach((marker) => marker.addTo(dataLayer));
      api.dataMode = "group";
    }
    const groups = data.meta.stop_groups;
    const domain = commute ? commuteDomain(commute, "group", options.commutePeriodIdx) : data.domains.group;
    api.groupMarkers.forEach((marker, index) => {
      let value;
      let color;
      let edge = {};
      if (commute) {
        if (focusMap) {
          const stats = commuteStats(commute, "group", index, options.commutePeriodIdx);
          value = stats ? stats.total : 0;
          const flow = focusMap.get(index);
          color = flow ? ramp(SEQ_GREEN, Math.sqrt(flow / focusMax)) : null;
          if (focus.kind === "region") {
            if (options.commuteFocusMembers?.has(index)) {
              edge = { color: "#419c62", weight: 1.5, opacity: 1 };
            }
          } else if (index === focus.key) {
            edge = { color: "#0d5732", weight: 2, opacity: 1 };
          }
        } else {
          const result = commuteValue(commute, "group", index, options.commuteMode, options.commutePeriodIdx);
          value = result.value;
          color = result.color;
        }
      } else {
        value = totalAt(data, "group", index, week);
        color = colorFor(data, "group", index, week, view, recThresh);
      }
      const visible = value > 0 && !!(color || edge.color);
      marker.setRadius(visible ? Math.min(MAX_DOT_R, 2.5 + Math.sqrt(value / domain) * 11) : 1);
      marker.setStyle({
        fillColor: color || "#e8e7e2",
        fillOpacity: visible ? (color ? 0.82 : 0.35) : 0,
        opacity: visible ? 1 : 0,
        color: "#fcfcfb",
        weight: 1,
        ...edge,
      });
      marker.options.interactive = visible;
    });
    return;
  }

  const source = level === "tract" ? "tracts" : "blockgroups";
  if (!api.geoLayers) api.geoLayers = {};
  if (!api.geoIndexes) api.geoIndexes = {};
  if (!api.geoLayers[level]) {
    const ids = level === "tract" ? data.meta.tracts : data.meta.bgroups;
    const index = new Map(ids.map((id, index) => [String(id), index]));
    api.geoIndexes[level] = index;
    api.geoLayers[level] = L.geoJSON(data.geo[source], {
      style: (feature) => areaStyle(
        api.renderState,
        level,
        index.get(String(feature.properties?.geoid)),
      ),
      onEachFeature: (feature, layer) => {
        const featureIndex = index.get(String(feature.properties?.geoid));
        if (featureIndex === undefined) return;
        layer
          .bindTooltip(() => (api.renderState.view === "commute" && api.renderState.commute
            ? commuteTipHtml(
              data,
              level,
              featureIndex,
              feature.properties?.name || feature.properties?.geoid,
              api.renderState.commutePeriodIdx,
            )
            : areaTipHtml(data, level, featureIndex, feature.properties || {}, api.renderState.week)), { sticky: true })
          .on("click", () => api.renderState.callbacks.onMapClick(
            level,
            featureIndex,
            feature.properties?.name || feature.properties?.geoid,
          ));
      },
    });
  }
  if (api.dataMode !== level) {
    dataLayer.clearLayers();
    api.geoLayers[level].addTo(dataLayer);
    api.dataMode = level;
  }
  const index = api.geoIndexes[level];
  api.geoLayers[level].eachLayer((layer) => {
    const featureIndex = index.get(String(layer.feature?.properties?.geoid));
    layer.setStyle(areaStyle(api.renderState, level, featureIndex));
  });
}

function distanceToSegment(point, first, second) {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - first.x, point.y - first.y);
  const t = Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (first.x + t * dx), point.y - (first.y + t * dy));
}

function pointBounds(points) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}

function corridorMetrics(data, era, index, week, view, recThresh) {
  let load = 0;
  let imp = 0;
  for (const sectionId of data.corridors[era][index].s) {
    const [sectionLoadValue, imputedFraction] = sectionLoad(data, era, sectionId, week);
    load += sectionLoadValue;
    imp += sectionLoadValue * imputedFraction;
  }
  if (load <= 0 && view !== "recovery" && view !== "rel") return null;
  const color = corridorColor(data, era, index, load, imp, view, recThresh);
  if (!color) return null;
  return { load, imp, color, thickness: Math.min(1, Math.sqrt(load / corridorDomain(data))) };
}

function createRouteCanvasLayer(map, L, getCallbacks, mapWrapRef) {
  const canvas = L.DomUtil.create("canvas", "route-canvas", map.getPane("routeCanvasPane"));
  const hitCellSize = 64;
  let options = null;
  let drawPending = false;
  let hitRecords = [];
  let hitGrid = new Map();
  let projectionCache = null;
  let tooltip = null;
  // A scheduled redraw can fire after map.remove() during a React remount;
  // touching the map then throws (_leaflet_pos gone with the panes).
  let mapRemoved = false;
  map.on("unload", () => { mapRemoved = true; });
  let groupDiscs = [];

  const closeTooltip = () => {
    if (tooltip) {
      map.closeTooltip(tooltip);
      tooltip = null;
    }
  };

  const hitTest = (point) => {
    const hits = [];
    const cellX = Math.floor(point.x / hitCellSize);
    const cellY = Math.floor(point.y / hitCellSize);
    const candidates = new Set();
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const record of hitGrid.get(`${cellX + dx},${cellY + dy}`) || []) candidates.add(record);
      }
    }
    for (const record of candidates) {
      if (
        point.x < record.minX - record.hitWidth ||
        point.x > record.maxX + record.hitWidth ||
        point.y < record.minY - record.hitWidth ||
        point.y > record.maxY + record.hitWidth
      ) continue;
      for (let index = 1; index < record.points.length; index += 1) {
        if (distanceToSegment(point, record.points[index - 1], record.points[index]) <= record.hitWidth) {
          hits.push(record);
          break;
        }
      }
    }
    return hits;
  };

  const draw = () => {
    drawPending = false;
    if (mapRemoved) {
      canvas.style.display = "none";
      return;
    }
    const features = options?.features;
    const data = options?.data;
    if (!features || !data || !options.visible) {
      canvas.style.display = "none";
      hitRecords = [];
      hitGrid = new Map();
      closeTooltip();
      return;
    }
    canvas.style.display = "block";
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.x * dpr;
    canvas.height = size.y * dpr;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    const origin = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, origin);
    const zoom = map.getZoom();
    const projectionSource = features;
    if (!projectionCache || projectionCache.source !== projectionSource || projectionCache.zoom !== zoom) {
      projectionCache = { source: projectionSource, zoom, points: new Map() };
    }
    const pixelOrigin = map.getPixelOrigin();
    const worldPointsFor = (key, coordinates) => {
      if (!projectionCache.points.has(key)) {
        projectionCache.points.set(key, coordinates.map((coordinate) => map.project(coordinate, zoom)));
      }
      return projectionCache.points.get(key);
    };
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.x, size.y);

    const records = [];
    const selectedRoute = options.selectedRoute;
    features.forEach((feature, index) => {
      const metrics = corridorMetrics(data, options.era, index, options.week, options.view, options.recThresh);
      if (!metrics) return;
      const selectedCorridor = selectedRoute && feature.r.some(
        (routeDirection) => routeDirection.split("|")[0] === selectedRoute,
      );
      const points = worldPointsFor(index, feature.c).map((projected) => ({
        x: projected.x - pixelOrigin.x - origin.x,
        y: projected.y - pixelOrigin.y - origin.y,
      }));
      const bounds = pointBounds(points);
      if (bounds.maxX < -80 || bounds.minX > size.x + 80 || bounds.maxY < -80 || bounds.minY > size.y + 80) return;
      const routes = [...new Set(feature.r.map((routeDirection) => routeDirection.split("|")[0]))];
      records.push({
        points,
        ...bounds,
        routes,
        route: routes[0],
        load: metrics.load,
        imp: metrics.imp,
        color: metrics.color,
        weight: (selectedCorridor ? 2.5 : 1) + metrics.thickness * (selectedCorridor ? 8 : 7),
        opacity: selectedCorridor ? 0.95 : selectedRoute ? 0.07 : 0.32 + metrics.thickness * 0.35,
        corridorIndex: index,
        selected: !!selectedCorridor,
      });
    });

    // Draw the selected line last so it remains legible over the stacked network.
    records.sort((first, second) => Number(first.selected) - Number(second.selected));
    for (const record of records) {
      context.beginPath();
      record.points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.strokeStyle = record.color;
      context.globalAlpha = record.opacity;
      context.lineWidth = record.weight;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
      record.hitWidth = Math.max(7, record.weight / 2 + 3);
    }
    context.globalAlpha = 1;

    // Nodes mark where the corridor's answer changes. Only the stop-group ones
    // are drawn: those are where load actually steps, and a dot on every
    // junction where routes merely diverge would bury the network in dots.
    // They are meaningless when zoomed out past the point corridors resolve.
    // Stop groups sit on corridors by definition, so a click anywhere on a
    // bubble used to land on the road underneath it instead. Their discs are
    // projected here, in the same frame as the corridors, so the hit test can
    // stand aside for them without re-projecting 2,987 markers per mousemove.
    groupDiscs = [];
    for (const marker of options.groupMarkers || []) {
      if (!marker.options.interactive) continue;
      const projected = map.project(marker.getLatLng(), zoom);
      groupDiscs.push({
        x: projected.x - pixelOrigin.x - origin.x,
        y: projected.y - pixelOrigin.y - origin.y,
        r: (marker.options.radius || 0) + 1,
      });
    }

    const nodes = options.nodes;
    if (nodes && zoom >= NODE_MIN_ZOOM) {
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.g < 0) continue;
        const flow = nodeFlow(data, options.era, node, options.week);
        if (!flow || flow.board + flow.alight <= 0) continue;
        const projected = map.project(node.p, zoom);
        const point = {
          x: projected.x - pixelOrigin.x - origin.x,
          y: projected.y - pixelOrigin.y - origin.y,
        };
        if (point.x < -20 || point.x > size.x + 20 || point.y < -20 || point.y > size.y + 20) continue;
        // Sized off the stop-group domain, not the corridor one: this is a
        // boarding count, and the two are orders of magnitude apart. Kept
        // small deliberately -- the node marks a place on the line, and the
        // line is what carries the value.
        const radius = Math.min(6, 1.2 + Math.sqrt((flow.board + flow.alight) / data.domains.group) * 5);
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = "#fcfcfb";
        context.globalAlpha = 0.85;
        context.fill();
        context.lineWidth = 1;
        context.strokeStyle = "#3d3a33";
        context.globalAlpha = 0.6;
        context.stroke();
        records.push({
          points: [point, point],
          minX: point.x,
          maxX: point.x,
          minY: point.y,
          maxY: point.y,
          hitWidth: Math.max(6, radius + 2),
          node: true,
          tooltipHtml: nodeHoverHtml(flow),
        });
      }
      context.globalAlpha = 1;
    }

    hitRecords = records;
    hitGrid = new Map();
    for (const record of records) {
      const minCellX = Math.floor(record.minX / hitCellSize);
      const maxCellX = Math.floor(record.maxX / hitCellSize);
      const minCellY = Math.floor(record.minY / hitCellSize);
      const maxCellY = Math.floor(record.maxY / hitCellSize);
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
          const key = `${cellX},${cellY}`;
          if (!hitGrid.has(key)) hitGrid.set(key, []);
          hitGrid.get(key).push(record);
        }
      }
    }
  };

  const redraw = () => {
    if (drawPending) return;
    drawPending = true;
    window.requestAnimationFrame(draw);
  };

  // A visible stop group takes the click, and the hover with it -- otherwise
  // the tooltip would offer a line while the click opened a stop group.
  const overGroup = (point) => groupDiscs.some((disc) => {
    const dx = point.x - disc.x;
    const dy = point.y - disc.y;
    return dx * dx + dy * dy <= disc.r * disc.r;
  });

  const eventPoint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const onMove = (event) => {
    const point = eventPoint(event);
    if (overGroup(point)) {
      closeTooltip();
      return;
    }
    const hits = hitTest(point);
    map.getContainer().style.cursor = hits.length ? "pointer" : "";
    if (!hits.length) {
      closeTooltip();
      return;
    }
    // A corridor under the cursor wins over the area beneath it. Stopping the
    // event here is what makes that true: Leaflet's own renderer listens on
    // the overlay canvas, and at tract level that canvas covers every pixel,
    // so letting the event through would open the tract's tooltip on top of
    // this one everywhere on the map.
    event.stopPropagation();
    const record = hits.find((hit) => hit.node) || hits[0];
    const latLng = map.containerPointToLatLng([
      event.clientX - map.getContainer().getBoundingClientRect().left,
      event.clientY - map.getContainer().getBoundingClientRect().top,
    ]);
    if (!tooltip) tooltip = L.tooltip({ sticky: true });
    const tooltipHtml = record.tooltipHtml || corridorHoverHtml(
      options.data,
      options.era,
      record.corridorIndex,
      record.load,
      record.imp,
      options.view,
      options.recThresh,
    );
    tooltip
      .setContent(tooltipHtml)
      .setLatLng(latLng)
      .addTo(map);
  };

  const onClick = (event) => {
    const point = eventPoint(event);
    if (overGroup(point)) return;
    const hits = hitTest(point).filter((hit) => !hit.node);
    if (!hits.length) return;
    event.preventDefault();
    event.stopPropagation();
    const routes = [...new Set(hits.flatMap((record) => record.routes))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const wrapBounds = mapWrapRef.current.getBoundingClientRect();
    getCallbacks().onContext({
      x: Math.max(8, Math.min(event.clientX - wrapBounds.left, wrapBounds.width - 220)),
      y: Math.max(8, Math.min(event.clientY - wrapBounds.top, wrapBounds.height - 420)),
      routes,
    });
  };

  // The listeners go on the map container, in the capture phase, not on the
  // canvas. The corridor pane sits at z-index 350, below Leaflet's overlay
  // pane at 400, so the overlay canvas is the top element over the whole map
  // and the corridor canvas never receives a real mouse event -- which is why
  // corridors had no tooltip and no click menu. Capturing on the container
  // runs the corridor hit test before the overlay canvas sees the event,
  // while leaving the drawing order alone.
  canvas.style.pointerEvents = "none";
  const container = map.getContainer();
  container.addEventListener("mousemove", onMove, true);
  container.addEventListener("mouseleave", closeTooltip, true);
  container.addEventListener("click", onClick, true);
  map.on("move zoom resize", redraw);

  return {
    setOptions(nextOptions) {
      options = nextOptions;
      redraw();
    },
    redraw,
    remove() {
      mapRemoved = true;
      map.off("move zoom resize", redraw);
      container.removeEventListener("mousemove", onMove, true);
      container.removeEventListener("mouseleave", closeTooltip, true);
      container.removeEventListener("click", onClick, true);
      closeTooltip();
      canvas.remove();
    },
  };
}

// The counts are the stop group's, covering every route that stops there --
// which is not necessarily only the routes on the corridor under the cursor.
// So the net is reported as the group's, not as this corridor's load step.
function nodeHoverHtml(flow) {
  const arrow = flow.net >= 0 ? "&#9650;" : "&#9660;";
  return `<div style="font-size:12px"><div class="row"><span class="k">${flow.name}</span></div>
    <div class="row"><span class="k">Boarding / wk</span><span>${discloseHtml(flow.board - flow.boardImp, flow.boardImp)}</span></div>
    <div class="row"><span class="k">Alighting / wk</span><span>${discloseHtml(flow.alight - flow.alightImp, flow.alightImp)}</span></div>
    <div class="row"><span class="k">Net at this stop group</span><span>${arrow} ${Math.abs(Math.round(flow.net)).toLocaleString()}</span></div></div>`;
}

function corridorHoverHtml(data, era, index, load, imp, view, recThresh) {
  let extra = "";
  const stats = corridorStats(data, era);
  const baseline = stats.base[index];
  if (view === "rel") {
    extra = baseline > 0
      ? `<div class="row"><span class="k">vs Feb 2020</span><span>${(100 * load / baseline).toFixed(0)}%</span></div>`
      : "";
  } else if (view === "imp" && load > 0) {
    extra = `<div class="row"><span class="k">Imputed</span><span>${(100 * imp / load).toFixed(1)}%</span></div>`;
  } else if (view === "recovery") {
    const month = stats.recovery[index * data.meta.recovery_thresholds.length + recThresh];
    extra = `<div class="row"><span class="k">Recovered</span><span>${month === -2 ? "baseline too small" : month === -1 ? "not yet" : data.meta.months[month]}</span></div>`;
  }
  // Name the lines that make up the corridor, not just its total. A corridor
  // is a union of route-directions sharing a street, so the number above is a
  // sum over all of them; without the list it reads as one route's load.
  // Opposite directions collapse to one name -- they are the same line here,
  // and the click menu opens them the same way.
  const feature = data.corridors[era]?.[index];
  const names = [...new Set((feature?.r || []).map((rd) => rd.split("|")[0]))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const shown = names.slice(0, ROUTE_LIST_MAX).map(escapeHtml).join(", ");
  const rest = names.length - ROUTE_LIST_MAX;
  const routeRow = names.length
    ? `<div class="row"><span class="k">${names.length === 1 ? "Line" : `${names.length} lines`}</span>
       <span>${shown}${rest > 0 ? ` +${rest} more` : ""}</span></div>`
    : "";
  return `<div style="font-size:12px">${routeRow}<div class="row"><span class="k">Onboard load / wk</span>
    <span>${discloseHtml(load - imp, imp)}</span></div>${extra}
    <div class="row hint-row"><span class="k">Click to pick a line</span></div></div>`;
}

/* ------------------------------------------------------------- commute view */

const COMMUTE_MIN = 20;   // riders/weekday below which a place is left grey

function peakLabel(hour) {
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

function commuteValue(commute, level, key, mode, p) {
  const stats = commuteStats(commute, level, key, p);
  if (!stats || stats.total < COMMUTE_MIN) {
    return { color: null, value: stats ? stats.total : 0 };
  }
  if (mode === "peaks") {
    const t = Math.max(0, Math.min(1, (stats.peakRatio - 1) / 3));
    return { color: ramp(SEQ_BLUE, Math.sqrt(t)), value: stats.total };
  }
  // Positive AM net = riders arrive in the morning = workplace (red side of
  // the diverging ramp); negative = riders leave = residential (blue side).
  const t = Math.max(0.06, Math.min(0.94, 0.5 + stats.amNet * 2.2));
  return { color: ramp(DIVERGING, t), value: stats.total };
}

function commuteTipHtml(data, level, keyIndex, name, p) {
  const stats = commuteStats(data.commute, level, keyIndex, p);
  if (!stats) return "";
  const growth = stats.baseTotal > 0 ? `${(100 * stats.total / stats.baseTotal).toFixed(0)}%` : "-";
  return `<div style="font-size:12px"><b>${escapeHtml(name)}</b>
    <div class="row"><span class="k">Riders / weekday</span><span>${fmt(stats.total)}</span></div>
    <div class="row"><span class="k">vs Feb 2020</span><span>${growth}</span></div>
    <div class="row"><span class="k">AM balance</span><span>${stats.amNet >= 0 ? "+" : ""}${(100 * stats.amNet).toFixed(0)}%</span></div>
    <div class="row"><span class="k">Peak strength</span><span>${Number.isFinite(stats.peakRatio) ? `${stats.peakRatio.toFixed(1)}×` : "-"}</span></div>
  </div>`;
}

function CommutePanel({ data, commute, level, keyIndex, p }) {
  if (!commute) return null;
  const stats = commuteStats(commute, level, keyIndex, p);
  if (!stats || stats.total <= 0) return null;
  const now = commuteHourly(commute, level, keyIndex, p);
  const base = commuteHourly(commute, level, keyIndex, commute.baseIdx);
  const period = commute.meta.periods[p];
  const growth = stats.baseTotal > 0 && p !== commute.baseIdx
    ? `${(100 * stats.total / stats.baseTotal).toFixed(0)}%`
    : "-";
  return (
    <>
      <h4>Weekday profile · {period.label}</h4>
      <HourlyChart now={now} base={base} windows={commute.meta.windows} />
      <p className="hint">
        Boardings above the line, alightings below, average weekday. Grey outline: {commute.meta.base_label ?? "Feb 2020"}.
      </p>
      <div style={{ marginBottom: 6 }}>
        <Row label="Riders / weekday">{fmt(stats.total)}</Row>
        <Row label="vs Feb 2020">{growth}</Row>
        <Row label="AM balance">
          {stats.amNet >= 0 ? "+" : ""}{(100 * stats.amNet).toFixed(0)}%{" "}
          {stats.amNet >= 0 ? "arrive" : "depart"}
        </Row>
        <Row label="PM balance">
          {stats.pmNet >= 0 ? "+" : ""}{(100 * stats.pmNet).toFixed(0)}%{" "}
          {stats.pmNet >= 0 ? "depart" : "arrive"}
        </Row>
        <Row label="Peak strength">
          {Number.isFinite(stats.peakRatio) ? `${stats.peakRatio.toFixed(1)}×` : "-"}
        </Row>
      </div>
    </>
  );
}

function renderMapLayers(api, data, options) {
  const { routeCanvas } = api;
  const { week, view, level, showRoutes, detail, recThresh } = options;
  renderDataLayer(api, data, options);

  if (!showRoutes) {
    routeCanvas?.setOptions({ visible: false });
    return;
  }
  const era = eraForWeek(data, week);
  if (!era || !data.corridors[era]) {
    routeCanvas?.setOptions({ visible: false });
    return;
  }
  corridorStats(data, era);
  corridorDomain(data);
  const features = data.corridors[era];
  const selectedRoute = detail?.lv === "route" ? detail.key : null;

  // Corridors are the shared street representation. Each path is drawn once
  // and carries all routes that use it, so overlapping services do not turn
  // into a stack of parallel lines at close zoom. The commute view only
  // recolours areas, so corridors keep the plain magnitude ramp there.
  routeCanvas?.setOptions({
    visible: true,
    data,
    era,
    features,
    week,
    view: view === "commute" || view === "income" ? "total" : view,
    recThresh,
    selectedRoute,
    nodes: data.corridorNodes?.[era] || null,
    groupMarkers: level === "group" ? api.groupMarkers : null,
  });
}

export default function RidershipExplorer() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [week, setWeek] = useState(0);
  const [view, setView] = useState("total");
  const [level, setLevel] = useState("group");
  const [showRoutes, setShowRoutes] = useState(true);
  const [recThresh, setRecThresh] = useState(3);
  const [playing, setPlaying] = useState(false);
  const [detail, setDetail] = useState(null);
  const [selection, setSelection] = useState(null);
  const [routeMode, setRouteMode] = useState("own");
  const [contextMenu, setContextMenu] = useState(null);
  const [commuteMode, setCommuteMode] = useState("character");
  const [commuteFocus, setCommuteFocus] = useState(null);
  const [commuteFocusMode, setCommuteFocusMode] = useState("to");
  const [regionChooser, setRegionChooser] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const mapContainerRef = useRef(null);
  const mapWrapRef = useRef(null);
  const mapApiRef = useRef(null);
  const selectionCanvasRef = useRef(null);
  const callbacksRef = useRef({});

  useEffect(() => {
    let cancelled = false;
    loadVisualizationData()
      .then((loaded) => {
        if (cancelled) return;
        setData(loaded);
        setWeek(loaded.BASE);
        setLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const openDetail = (lv, key, label) => {
    setSelection(null);
    setContextMenu(null);
    setDetail({ lv, key, label });
  };
  const openRouteDetail = (route) => {
    setSelection(null);
    setContextMenu(null);
    setDetail({ lv: "route", key: route, label: `Route ${route}` });
  };
  const closeDetail = () => setDetail(null);
  const clearSelection = () => setSelection(null);

  const commute = data?.commute || null;
  // The commute snapshot follows the time bar: the latest snapshot month at
  // or before the selected week (clamped to the first snapshot for the
  // pre-2019-02 weeks).
  let commutePeriodIdx = 0;
  if (commute) {
    const month = data.meta.weeks[week].slice(0, 7);
    const periods = commute.meta.periods;
    for (let i = 0; i < periods.length; i += 1) {
      if (periods[i].id <= month) commutePeriodIdx = i;
      else break;
    }
  }
  const odInFlightRef = useRef(null);

  // Clicking a place in the commute view recolours the map by inferred flows
  // to (or from) it; the O-D file for the time bar's snapshot is fetched on
  // demand and refetched here whenever the snapshot moves under an active
  // focus (the week slider drives the snapshot).
  useEffect(() => {
    if (!commute || !commuteFocus) return;
    const anchorId = commute.meta.periods[commutePeriodIdx].id;
    if (commuteFocus.anchor !== anchorId) {
      setCommuteFocus((current) => current ? { ...current, anchor: anchorId, lists: null } : current);
      return;
    }
    if (commuteFocus.lists) return;
    const token = `${anchorId}|${commuteFocus.level}|${commuteFocus.key}`;
    if (odInFlightRef.current === token) return;
    odInFlightRef.current = token;
    loadCommuteOD(commute, anchorId)
      .then((store) => {
        setCommuteFocus((current) => {
          if (!current || current.anchor !== anchorId
            || current.level !== commuteFocus.level) return current;
          if (current.kind === "region") {
            return { ...current, lists: commuteRegionLists(data.meta, store, current.keys, current.level) };
          }
          if (current.key !== commuteFocus.key) return current;
          return { ...current, lists: commuteODLists(store, current.level, current.key) };
        });
      })
      .catch(() => {
        setCommuteFocus((current) => current && current.anchor === anchorId
          ? { ...current, lists: { in: [], out: [] } }
          : current);
      })
      .finally(() => {
        if (odInFlightRef.current === token) odInFlightRef.current = null;
      });
  }, [commute, commuteFocus, commutePeriodIdx]);

  callbacksRef.current = {
    onDetail: openDetail,
    onContext: setContextMenu,
    onMapClick: (lv, key, label) => {
      openDetail(lv, key, label);
      if (view === "commute" && commute && lv !== "route") {
        setCommuteFocus({
          kind: "place",
          level: lv,
          key,
          label,
          anchor: commute.meta.periods[commutePeriodIdx].id,
          lists: null,
        });
      }
    },
    onBoxSelect: (northWest, southEast) => {
      if (!data) return;
      const groups = data.meta.stop_groups;
      const picked = [];
      for (let index = 0; index < groups.n; index += 1) {
        if (
          groups.lat[index] <= northWest.lat &&
          groups.lat[index] >= southEast.lat &&
          groups.lon[index] >= northWest.lng &&
          groups.lon[index] <= southEast.lng
        ) picked.push(index);
      }
      if (!picked.length) return;
      // In the commute view a box can become a region origin ("from") or
      // destination ("to") for the inferred-riders recolouring.
      if (view === "commute" && commute && level !== "none") {
        const api = mapApiRef.current;
        const point = api?.map ? api.map.latLngToContainerPoint([northWest.lat, northWest.lng]) : null;
        const wrap = mapWrapRef.current?.getBoundingClientRect();
        setSelection(null);
        setDetail(null);
        setContextMenu(null);
        setRegionChooser({
          keys: picked,
          x: point ? Math.max(8, Math.min(point.x, (wrap?.width || 800) - 260)) : 20,
          y: point ? Math.max(8, Math.min(point.y, (wrap?.height || 600) - 170)) : 20,
        });
        return;
      }
      setSelection(picked);
      setDetail(null);
      setContextMenu(null);
    },
  };

  // Dismiss the box-selection chooser on any click outside it.
  useEffect(() => {
    if (!regionChooser) return undefined;
    const dismiss = (event) => {
      if (!event.target.closest?.("#regionChooser")) setRegionChooser(null);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [regionChooser]);

  const chooseRegion = (mode) => {
    if (!regionChooser || !commute) return;
    setCommuteFocusMode(mode);
    setSelection(null);
    setDetail(null);
    setCommuteFocus({
      kind: "region",
      level,
      keys: regionChooser.keys,
      label: `${regionChooser.keys.length} stop group${regionChooser.keys.length === 1 ? "" : "s"}`,
      anchor: commute.meta.periods[commutePeriodIdx].id,
      lists: null,
    });
    setRegionChooser(null);
  };

  useEffect(() => {
    if (!data || !mapContainerRef.current) return undefined;
    let disposed = false;
    let map;
    let resizeObserver;

    import("leaflet").then((leafletModule) => {
      if (disposed || !mapContainerRef.current) return;
      const L = leafletModule.default || leafletModule;
      const basemap = CARTO_KEY
        ? {
            url: `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`,
            attribution: "&copy; OpenStreetMap &copy; CARTO",
            className: "basemap-carto",
          }
        : {
            url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            attribution: "&copy; OpenStreetMap contributors",
            className: "basemap-muted",
          };
      map = L.map(mapContainerRef.current, {
        renderer: L.canvas({ padding: 0.12 }),
        preferCanvas: true,
        boxZoom: false,
      }).setView([37.804, -122.271], BASE_ZOOM);
      L.tileLayer(basemap.url, { attribution: basemap.attribution, maxZoom: 19, className: basemap.className }).addTo(map);
      map.createPane("routeCanvasPane");
      map.getPane("routeCanvasPane").style.zIndex = 350;
      const dataLayer = L.layerGroup().addTo(map);
      const api = {
        L,
        map,
        dataLayer,
        disposed: false,
      };
      api.routeCanvas = createRouteCanvasLayer(map, L, () => callbacksRef.current, mapWrapRef);
      mapApiRef.current = api;

      const onMapClick = () => callbacksRef.current.onContext(null);
      map.on("click", onMapClick);

      let start = null;
      let box = null;
      const onMouseDown = (event) => {
        if (!event.shiftKey || event.button !== 0) return;
        if (event.target?.closest?.(".leaflet-control")) return;
        event.preventDefault();
        map.dragging.disable();
        const bounds = mapWrapRef.current.getBoundingClientRect();
        start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        box = document.createElement("div");
        box.className = "box-select";
        mapWrapRef.current.appendChild(box);
      };
      const onMouseMove = (event) => {
        if (!start || !box || !mapWrapRef.current) return;
        const bounds = mapWrapRef.current.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        Object.assign(box.style, {
          left: `${Math.min(start.x, x)}px`,
          top: `${Math.min(start.y, y)}px`,
          width: `${Math.abs(x - start.x)}px`,
          height: `${Math.abs(y - start.y)}px`,
        });
      };
      const onMouseUp = (event) => {
        if (!start || !mapWrapRef.current) return;
        map.dragging.enable();
        const bounds = mapWrapRef.current.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        const first = map.containerPointToLatLng([Math.min(start.x, x), Math.min(start.y, y)]);
        const second = map.containerPointToLatLng([Math.max(start.x, x), Math.max(start.y, y)]);
        box?.remove();
        start = null;
        box = null;
        if (Math.abs(second.lat - first.lat) < 1e-4) return;
        callbacksRef.current.onBoxSelect(first, second);
      };
      mapContainerRef.current.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => map.invalidateSize());
        resizeObserver.observe(mapWrapRef.current);
      }
      setMapReady(true);

      api.cleanup = () => {
        map.off("click", onMapClick);
        mapContainerRef.current?.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        resizeObserver?.disconnect();
        api.routeCanvas?.remove();
        if (start) map.dragging.enable();
        box?.remove();
      };
    }).catch((mapError) => {
      if (!disposed) {
        setError(mapError);
        setLoading(false);
      }
    });

    return () => {
      disposed = true;
      if (mapApiRef.current) {
        mapApiRef.current.disposed = true;
        mapApiRef.current.cleanup?.();
      }
      if (map) map.remove();
      mapApiRef.current = null;
      setMapReady(false);
    };
  }, [data]);

  useEffect(() => {
    const api = mapApiRef.current;
    if (!data || !mapReady || !api || api.disposed) return;
    renderMapLayers(api, data, {
      // `areaStyle` reads state.data to colour a tract or block group. It is
      // handed api.renderState, i.e. this object, so leaving data out of it
      // broke every area level for every view -- colorFor was being called
      // with undefined.
      data,
      week,
      view,
      level,
      showRoutes,
      detail,
      recThresh,
      commute: data.commute,
      commuteMode,
      commutePeriodIdx,
      commuteFocus,
      commuteFocusMode,
      callbacks: {
        onDetail: (...args) => callbacksRef.current.onDetail(...args),
        onContext: (...args) => callbacksRef.current.onContext(...args),
        onMapClick: (...args) => callbacksRef.current.onMapClick(...args),
      },
    });
  }, [data, mapReady, week, view, level, showRoutes, detail, recThresh, commuteMode, commutePeriodIdx, commuteFocus, commuteFocusMode]);

  useEffect(() => {
    if (!playing || !data) return undefined;
    const timer = window.setInterval(() => setWeek((current) => (current + 1) % data.W), 220);
    return () => window.clearInterval(timer);
  }, [playing, data]);

  let systemTotal = 0;
  let systemImputed = 0;
  if (data) {
    for (let index = 0; index < data.store.group.n; index += 1) {
      systemTotal += totalAt(data, "group", index, week);
      systemImputed += imputedAt(data, "group", index, week);
    }
  }

  return (
    <>
      <div id="app">
        <aside id="sidebar">
          <h1>AC Transit Ridership</h1>
          <p className="sub">Weekly boardings + alightings, 2019-2026</p>

          <section>
            <h2>View</h2>
            {[
              ["total", "Total ridership"],
              ["rel", "Relative to Feb 2020"],
              ["imp", "Percent imputed"],
              ["recovery", "Recovery time"],
              ...(data?.meta?.income ? [["income", "Median income"]] : []),
              ...(data?.commute ? [["commute", "Commute pattern"]] : []),
            ].map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="view"
                  value={value}
                  checked={view === value}
                  onChange={(event) => {
                    setView(event.target.value);
                    if (event.target.value !== "commute") setCommuteFocus(null);
                  }}
                />
                {label}
              </label>
            ))}
            {view === "recovery" ? (
              <div id="recCtl">
                <label className="inline">
                  Reached
                  <select value={recThresh} onChange={(event) => setRecThresh(Number(event.target.value))}>
                    {[
                      [0, "50%"], [1, "60%"], [2, "70%"], [3, "80%"], [4, "90%"], [5, "100%"],
                    ].map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                  </select>
                  of Feb 2020
                </label>
                <p className="hint">Colour = when the area first held that level for three straight months. Independent of the time bar.</p>
              </div>
            ) : null}
            {view === "commute" && data?.commute ? (
              <div id="recCtl">
                {commuteFocus ? (
                  <>
                    <div className="focus-banner">
                      <span className="focus-name" title={commuteFocus.label}>{commuteFocus.label}</span>
                      <button
                        className="btn small ghost"
                        type="button"
                        aria-label="Clear focus"
                        onClick={() => setCommuteFocus(null)}
                      >
                        X
                      </button>
                    </div>
                    <div className="seg">
                      {[
                        ["to", "Inferred to here"],
                        ["from", "Inferred from here"],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={`segbtn${commuteFocusMode === value ? " on" : ""}`}
                          onClick={() => setCommuteFocusMode(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="hint">
                      {commuteFocus.lists
                        ? "Green = stronger flow. Grey: nothing above the floor. Click another place to re-focus."
                        : "Loading inferred flows..."}
                    </p>
                  </>
                ) : (
                  <div className="seg">
                    {[
                      ["character", "Workplaces / homes"],
                      ["peaks", "Peak strength"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`segbtn${commuteMode === value ? " on" : ""}`}
                        onClick={() => setCommuteMode(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <p className="hint">
                  Showing the {data.commute.meta.periods[commutePeriodIdx].label} average weekday
                  ({data.commute.meta.periods[commutePeriodIdx].weekdays} weekdays, APC-corrected) —
                  the snapshot follows the time bar, so scrub it to compare pre- and post-pandemic
                  patterns.{" "}
                  {Math.round((1 - data.commute.meta.periods[commutePeriodIdx].reliable) * 100)}% of
                  volume is imputed
                  {data.commute.meta.periods[commutePeriodIdx].odCoverage < 0.99
                    ? `; inferred flows cover ${Math.round(data.commute.meta.periods[commutePeriodIdx].odCoverage * 100)}% of ridership`
                    : ""}
                  .
                </p>
              </div>
            ) : null}
          </section>

          <section>
            <h2>Level</h2>
            {[
              ["group", "Stop groups"],
              ["bgroup", "Block groups"],
              ["tract", "Census tracts"],
              ["none", "None (routes only)"],
            ].map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="level"
                  value={value}
                  checked={level === value}
                  onChange={(event) => {
                    const nextLevel = event.target.value;
                    setLevel(nextLevel);
                    setCommuteFocus(null);
                    setDetail((current) => current && current.lv !== "route" && current.lv !== nextLevel ? null : current);
                  }}
                />
                {label}
              </label>
            ))}
          </section>

          <section>
            <h2>Routes</h2>
            <label>
              <input type="checkbox" checked={showRoutes} onChange={(event) => setShowRoutes(event.target.checked)} />
              Show corridors
            </label>
            <p className="hint">Line width = onboard load; line colour follows the active view (same ramps as the areas). Corridors merge routes sharing a road. Click a corridor to pick a line.</p>
          </section>

          <section id="legendBox">
            <h2>Legend</h2>
            <Legend
              data={data}
              view={view}
              level={level}
              recThresh={recThresh}
              commute={data?.commute}
              commuteMode={commuteMode}
              period={data?.commute ? data.commute.meta.periods[commutePeriodIdx] : null}
              commuteFocus={commuteFocus}
              commuteFocusMode={commuteFocusMode}
              focusMax={commuteFocus?.lists
                ? (commuteFocusMode === "from"
                  ? commuteFocus.lists.out[0]?.flow
                  : commuteFocus.lists.in[0]?.flow) || 1
                : 1}
            />
          </section>

          <section>
            <h2>Selection</h2>
            <p className="hint">Click any stop group or area for details. Shift-drag to chart a whole region.</p>
            <button className="btn" type="button" disabled={!selection} onClick={clearSelection}>Clear selection</button>
          </section>

          <p className="disclosure">
            Every figure reads <b>Real+Imputed</b> <span className="gold">(Imputed)</span>.
            Imputed covers APC route-months failing the reliability gate - including the May-Jul 2019 fleet collapse - and post-Realign labels reconstructed from schedule + predecessor stop shares.
          </p>
        </aside>

        <main id="mapWrap" ref={mapWrapRef}>
          <div id="map" ref={mapContainerRef} />
          {contextMenu ? (
            <div className="ctx-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <div className="ctx-head">Routes on this corridor</div>
              {contextMenu.routes.map((route) => (
                <button className="ctx-item" type="button" key={route} onClick={() => openRouteDetail(route)}>
                  {route}
                </button>
              ))}
            </div>
          ) : null}
          {regionChooser ? (
            <div className="ctx-menu" id="regionChooser" style={{ left: regionChooser.x, top: regionChooser.y }}>
              <div className="ctx-head">
                {regionChooser.keys.length} stop group{regionChooser.keys.length === 1 ? "" : "s"} selected
              </div>
              <button className="ctx-item" type="button" onClick={() => chooseRegion("to")}>
                Inferred to here (arrivals)
              </button>
              <button className="ctx-item" type="button" onClick={() => chooseRegion("from")}>
                Inferred from here (departures)
              </button>
              <button
                className="ctx-item"
                type="button"
                onClick={() => {
                  setSelection(regionChooser.keys);
                  setDetail(null);
                  setRegionChooser(null);
                }}
              >
                Weekly chart
              </button>
            </div>
          ) : null}
          {data ? <RouteSearch data={data} week={week} onPick={openRouteDetail} /> : null}
          {detail && data ? (
            <DetailPanel
              data={data}
              detail={detail}
              week={week}
              routeMode={routeMode}
              onRouteClick={openRouteDetail}
              onModeChange={setRouteMode}
              onClose={closeDetail}
              commute={data.commute}
              periodIdx={commutePeriodIdx}
            />
          ) : null}
          {selection && data ? (
            <SelectionPanel
              data={data}
              selection={selection}
              week={week}
              canvasRef={selectionCanvasRef}
              onClear={clearSelection}
            />
          ) : null}
        </main>

        <footer id="timebar">
          <button className="btn" type="button" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((current) => !current)}>
            {playing ? "||" : ">"}
          </button>
          <div id="weekLabel">{data ? `Week of ${data.meta.weeks[week]}` : "-"}</div>
          <input
            type="range"
            id="weekSlider"
            min="0"
            max={data ? data.W - 1 : 386}
            value={data ? week : 0}
            step="1"
            disabled={!data}
            onChange={(event) => setWeek(Number(event.target.value))}
          />
          <div id="weekTotal">
            {data ? <>System ridership <DisclosureValue real={systemTotal - systemImputed} imp={systemImputed} /></> : null}
          </div>
        </footer>
      </div>
      {loading ? <div id="loading">Loading ~30 MB of prepacked data...</div> : null}
      {error ? (
        <div className="error-state">
          <div><strong>Unable to load the visualization</strong>{error.message}</div>
        </div>
      ) : null}
    </>
  );
}
