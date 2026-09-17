"use client";

import { useEffect, useRef, useState } from "react";
import {
  DIVERGING_RG,
  REC_NEVER,
  REC_SMALL,
  SEQ_BLUE,
  SEQ_GREEN,
  colorFor,
  commuteDomain,
  commuteRegionLists,
  commuteStats,
  corridorColor,
  corridorDomain,
  corridorStats,
  eraForWeek,
  escapeHtml,
  fmt,
  loadCommuteOD,
  ramp,
  recoveryAt,
  sectionLoad,
  totalAt,
} from "../ridership-data";
import { mercator, prepareStory } from "./prepare";

const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_KEY || "";
// Dot sizing, fills and outlines follow the explorer's renderDataLayer so a
// step here looks like the same view in the app.
const MAX_DOT_R = 13;
const EDGE = "#fcfcfb";
const NO_DATA = "#e8e7e2";
const MEMBER_EDGE = "#419c62";
const FADE_MS = 220;

const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function apDate(label) {
  const [year, month, day] = label.split("-").map(Number);
  return `${AP_MONTHS[month - 1]} ${day}, ${year}`;
}

function apMonth(label) {
  const [year, month] = label.split("-").map(Number);
  return `${AP_MONTHS[month - 1]} ${year}`;
}

function cssVar(name, fallback) {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// The commute snapshot a week belongs to: the latest one at or before it.
function periodIndex(data, week) {
  const periods = data.commute.meta.periods;
  const month = data.meta.weeks[week].slice(0, 7);
  let index = 0;
  for (let i = 0; i < periods.length; i += 1) {
    if (periods[i].id <= month) index = i;
    else break;
  }
  return index;
}

// Inferred flows to and from the campus region. The O-D file is fetched once
// per snapshot and shared by every map on the page.
const odLoading = new Map();
function campusFlows(data, prep, period, onLoaded) {
  if (prep.odLists[period]) return prep.odLists[period];
  if (!odLoading.has(period)) {
    odLoading.set(period, loadCommuteOD(data.commute, period)
      .then((store) => {
        prep.odLists[period] = commuteRegionLists(data.meta, store, prep.campusKeys, "group");
      })
      .catch(() => {
        prep.odLists[period] = { in: [], out: [], memberKeys: new Set(prep.campusKeys) };
      }));
  }
  odLoading.get(period).then(onLoaded);
  return null;
}

export function relativeFor(data, level, keys, week) {
  let now = 0;
  let base = 0;
  for (const key of keys) {
    now += totalAt(data, level, key, week);
    base += totalAt(data, level, key, data.BASE);
  }
  return base > 0 ? now / base : NaN;
}

// Room left for the passages and the HUD when fitting a scene. On desktop the
// passages run down a left column; on a phone they cross the lower part of
// the screen, so the map is framed above them.
function fitPadding(width, height, layout) {
  if (layout === "figure") {
    return width >= 761
      ? { paddingTopLeft: [16, 16], paddingBottomRight: [290, 16] }
      : { paddingTopLeft: [12, 118], paddingBottomRight: [12, 12] };
  }
  const column = Math.max(24, width * 0.05) + 400 + 24;
  if (width >= 1100) return { paddingTopLeft: [column, 24], paddingBottomRight: [300, 24] };
  if (width >= 761) return { paddingTopLeft: [column, 132], paddingBottomRight: [24, 24] };
  return { paddingTopLeft: [12, 112], paddingBottomRight: [12, Math.round(height * 0.4)] };
}

function createEngine({ map, container, canvas, svg, tip, getData, layout, onHud }) {
  const context = canvas.getContext("2d");
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const alpha = { dots: 0, areas: 0, routes: 0, outside: 1, mask: 0 };
  const target = { ...alpha };
  let scene = null;
  let week = 0;
  let card = null;
  let boundsKey = null;
  let frame = 0;
  let lastTime = 0;
  let hits = { dots: [], areas: [] };
  let removed = false;
  let hudKey = "";

  const retarget = () => {
    target.dots = scene.level === "group" ? 1 : 0;
    target.areas = scene.level === "bgroup" ? 1 : 0;
    target.routes = scene.routes ? 1 : 0;
    target.outside = scene.mask ? 0 : 1;
    target.mask = scene.mask ? 1 : 0;
  };

  const fly = (animate) => {
    if (!scene?.boundsLatLng) return;
    const padding = fitPadding(container.clientWidth, container.clientHeight, layout);
    if (!animate || reduceMotion) {
      map.fitBounds(scene.boundsLatLng, { ...padding, animate: false });
    } else {
      map.flyToBounds(scene.boundsLatLng, { ...padding, duration: 1.3, easeLinearity: 0.2 });
    }
  };

  const request = () => {
    if (!frame && !removed) frame = window.requestAnimationFrame(tick);
  };

  const tick = (now) => {
    frame = 0;
    const dt = lastTime ? Math.min(64, now - lastTime) : 16;
    const step = 1 - Math.exp(-dt / FADE_MS);
    let settling = false;
    for (const key of Object.keys(alpha)) {
      const delta = target[key] - alpha[key];
      if (Math.abs(delta) > 0.004) {
        alpha[key] += delta * step;
        settling = true;
      } else {
        alpha[key] = target[key];
      }
    }
    draw();
    if (settling) {
      lastTime = now;
      request();
    } else {
      lastTime = 0;
    }
  };

  const draw = () => {
    const data = getData();
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size.x * dpr) || canvas.height !== Math.round(size.y * dpr)) {
      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.x, size.y);
    if (!data || !scene) {
      svg.innerHTML = "";
      return;
    }
    const prep = prepareStory(data);
    const zoom = map.getZoom();
    const k = 2 ** zoom;
    const center = map.getCenter();
    const [cx, cy] = mercator(center.lat, center.lng);
    const tx = size.x / 2 - cx * k;
    const ty = size.y / 2 - cy * k;
    const onScreen = (bounds, pad) => (
      bounds[2] * k + tx >= -pad && bounds[0] * k + tx <= size.x + pad
      && bounds[3] * k + ty >= -pad && bounds[1] * k + ty <= size.y + pad
    );
    const tracePath = (path, pts) => {
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i] * k + tx;
        const y = pts[i + 1] * k + ty;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
    };

    const berkeley = new Path2D();
    tracePath(berkeley, prep.berkeley);
    berkeley.closePath();
    const outside = new Path2D();
    outside.rect(-10, -10, size.x + 20, size.y + 20);
    outside.addPath(berkeley);

    // Outside Berkeley the basemap is dimmed and the data faded out, so the
    // opening reads as one city; zooming out lifts both.
    if (alpha.mask > 0.01) {
      context.save();
      context.globalAlpha = 0.6 * alpha.mask;
      context.fillStyle = cssVar("--plane", "#f9f9f7");
      context.fill(outside, "evenodd");
      context.restore();
    }

    const regions = alpha.outside >= 0.995
      ? [["all", 1]]
      : alpha.outside <= 0.005 ? [["in", 1]] : [["in", 1], ["out", alpha.outside]];
    const inRegion = (region, drawLayer) => {
      context.save();
      if (region === "in") context.clip(berkeley);
      if (region === "out") context.clip(outside, "evenodd");
      drawLayer();
      context.restore();
    };

    hits = { dots: [], areas: [] };
    if (alpha.areas > 0.01) {
      const areas = [];
      for (const area of prep.areas) {
        if (!onScreen(area.bounds, 4)) continue;
        const path = new Path2D();
        for (const ring of area.rings) {
          tracePath(path, ring);
          path.closePath();
        }
        const color = colorFor(data, "bgroup", area.key, week, scene.view, scene.recThresh);
        areas.push({ path, color, key: area.key, inBerkeley: area.inBerkeley });
      }
      for (const [region, regionAlpha] of regions) {
        inRegion(region, () => {
          const layerAlpha = regionAlpha * alpha.areas;
          context.lineWidth = 0.7;
          context.strokeStyle = EDGE;
          for (const area of areas) {
            context.globalAlpha = (area.color ? 0.68 : 0.15) * layerAlpha;
            context.fillStyle = area.color || NO_DATA;
            context.fill(area.path, "evenodd");
            context.globalAlpha = layerAlpha;
            context.stroke(area.path);
          }
        });
      }
      if (alpha.areas > 0.5) {
        hits.areas = areas.filter((area) => area.inBerkeley || alpha.outside > 0.5);
      }
    }

    const era = eraForWeek(data, week);
    if (alpha.routes > 0.01 && era && prep.corridors[era]) {
      corridorStats(data, era);
      const domain = corridorDomain(data);
      const features = data.corridors[era];
      const geometry = prep.corridors[era];
      // The commute and recovery steps keep corridors on the load ramp, as the
      // explorer does for views that only recolour areas.
      const corridorView = scene.view === "rel" ? "rel" : "total";
      const lines = [];
      for (let index = 0; index < features.length; index += 1) {
        if (!onScreen(geometry[index].bounds, 20)) continue;
        let load = 0;
        let imp = 0;
        for (const sectionId of features[index].s) {
          const [value, imputed] = sectionLoad(data, era, sectionId, week);
          load += value;
          imp += value * imputed;
        }
        if (load <= 0 && corridorView !== "rel") continue;
        const color = corridorColor(data, era, index, load, imp, corridorView, scene.recThresh);
        if (!color) continue;
        const thickness = Math.min(1, Math.sqrt(load / domain));
        lines.push({ pts: geometry[index].pts, color, thickness });
      }
      for (const [region, regionAlpha] of regions) {
        inRegion(region, () => {
          // Flat ends: the curved pieces butt together at shared nodes, and
          // round ends would overlap there into darker beads.
          context.lineCap = "butt";
          context.lineJoin = "round";
          for (const line of lines) {
            context.beginPath();
            tracePath(context, line.pts);
            context.globalAlpha = (0.32 + line.thickness * 0.35) * regionAlpha * alpha.routes;
            context.strokeStyle = line.color;
            context.lineWidth = 1 + line.thickness * 7;
            context.stroke();
          }
        });
      }
    }

    if (alpha.dots > 0.01) {
      const groups = data.meta.stop_groups;
      const commute = scene.view === "commute" ? data.commute : null;
      let domain = data.domains.group;
      let p = 0;
      let flows = null;
      let flowMax = 1;
      let members = null;
      if (commute) {
        p = periodIndex(data, week);
        domain = commuteDomain(commute, "group", p);
        const lists = scene.focus ? campusFlows(data, prep, commute.meta.periods[p].id, request) : null;
        if (lists) {
          const entries = scene.focus.mode === "from" ? lists.out : lists.in;
          flows = new Map(entries.map((entry) => [entry.g, entry.flow]));
          flowMax = entries.length ? entries[0].flow : 1;
          members = lists.memberKeys;
        }
      }
      // A phone frames the same city in a third of the pixels.
      const dotScale = size.x < 761 ? 0.65 : 1;
      const dots = [];
      for (let key = 0; key < groups.n; key += 1) {
        const regionAlpha = prep.groupInBerkeley[key] ? 1 : alpha.outside;
        if (regionAlpha < 0.01) continue;
        const x = prep.gx[key] * k + tx;
        const y = prep.gy[key] * k + ty;
        if (x < -16 || y < -16 || x > size.x + 16 || y > size.y + 16) continue;
        let value;
        let color = null;
        let member = false;
        let sizeDomain = domain;
        if (commute) {
          if (!flows) continue;
          if (members.has(key)) {
            const stats = commuteStats(commute, "group", key, p);
            value = stats ? stats.total : 0;
            member = true;
          } else {
            value = flows.get(key) || 0;
            sizeDomain = flowMax;
            color = value ? ramp(SEQ_GREEN, Math.sqrt(value / flowMax)) : null;
          }
        } else {
          value = totalAt(data, "group", key, week);
          color = colorFor(data, "group", key, week, scene.view, scene.recThresh);
        }
        if (!(value > 0) || !(color || member)) continue;
        const r = dotScale * Math.min(MAX_DOT_R, 2.5 + Math.sqrt(value / sizeDomain) * 11);
        dots.push({ x, y, r, color, member, key, value, alpha: regionAlpha });
      }
      // Largest first, so a small stop beside a busy one is not buried.
      dots.sort((first, second) => second.r - first.r);
      for (const dot of dots) {
        context.beginPath();
        context.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
        context.globalAlpha = (dot.color ? 0.82 : 0.35) * dot.alpha * alpha.dots;
        context.fillStyle = dot.color || NO_DATA;
        context.fill();
        context.globalAlpha = dot.alpha * alpha.dots;
        context.strokeStyle = dot.member ? MEMBER_EDGE : EDGE;
        context.lineWidth = dot.member ? 1.5 : 1;
        context.stroke();
      }
      if (alpha.dots > 0.5) hits.dots = dots.filter((dot) => dot.alpha > 0.5).reverse();
    }

    if (alpha.mask > 0.01) {
      context.save();
      context.globalAlpha = 0.85 * alpha.mask;
      context.strokeStyle = cssVar("--text-secondary", "#52514e");
      context.lineWidth = 1.4;
      context.setLineDash([5, 4]);
      context.stroke(berkeley);
      context.restore();
    }
    context.globalAlpha = 1;

    drawAnnotations(data, (lat, lon) => {
      const [x, y] = mercator(lat, lon);
      return [x * k + tx, y * k + ty];
    }, size);
  };

  // Callouts are the script's "line to" directions: a leader from the passage
  // to the place it names, labelled with that place's live figure. Marks are
  // labels without a leader.
  const drawAnnotations = (data, project, size) => {
    const parts = [];
    const label = (x, y, lines, anchorRight) => {
      const flip = anchorRight || x > size.x - 210;
      const lx = flip ? x - 17 : x + 17;
      const anchor = flip ? "end" : "start";
      lines.forEach((line, index) => {
        parts.push(
          `<text x="${lx}" y="${y - 3 + index * 15}" text-anchor="${anchor}" class="${index ? "sub" : "name"}">${escapeHtml(line)}</text>`,
        );
      });
    };
    const ring = (x, y) => {
      parts.push(`<circle cx="${x}" cy="${y}" r="12" class="ring" />`);
    };

    for (const place of scene.markPlaces || []) {
      const [x, y] = project(place.lat, place.lon);
      ring(x, y);
      label(x, y, [place.label]);
    }

    const place = scene.calloutPlace;
    if (place && card && card.alpha > 0.01) {
      const [x, y] = project(place.lat, place.lon);
      const bounds = container.getBoundingClientRect();
      const rect = {
        left: card.rect.left - bounds.left,
        right: card.rect.right - bounds.left,
        top: card.rect.top - bounds.top,
        bottom: card.rect.bottom - bounds.top,
      };
      let start = null;
      if (rect.right + 12 < x) {
        start = [rect.right, Math.max(rect.top + 22, Math.min(rect.bottom - 22, y))];
      } else if (rect.top > y + 16) {
        start = [Math.max(rect.left + 22, Math.min(rect.right - 22, x)), rect.top];
      } else if (rect.bottom < y - 16) {
        start = [Math.max(rect.left + 22, Math.min(rect.right - 22, x)), rect.bottom];
      }
      parts.push(`<g style="opacity:${card.alpha.toFixed(3)}">`);
      if (start) {
        const dx = x - start[0];
        const dy = y - start[1];
        const length = Math.hypot(dx, dy) || 1;
        const endX = x - (dx / length) * 13;
        const endY = y - (dy / length) * 13;
        parts.push(`<line x1="${start[0]}" y1="${start[1]}" x2="${endX}" y2="${endY}" class="leader" />`);
        parts.push(`<circle cx="${start[0]}" cy="${start[1]}" r="2.5" class="leader-end" />`);
      }
      ring(x, y);
      const share = relativeFor(data, place.level, place.keys, week);
      const figure = Number.isFinite(share) ? `${Math.round(share * 100)}% of Feb. 2020` : "";
      label(x, y, figure ? [place.label, figure] : [place.label], start && start[0] > x);
      parts.push("</g>");
    }
    svg.setAttribute("viewBox", `0 0 ${size.x} ${size.y}`);
    svg.innerHTML = parts.join("");
  };

  const tooltipHtml = (hit, kind) => {
    const data = getData();
    const { meta } = data;
    if (kind === "dot") {
      const name = meta.stop_groups.name[hit.key];
      if (scene.view === "commute") {
        return `<b>${escapeHtml(name)}</b><div>${hit.member
          ? "UC Berkeley stop group"
          : `${fmt(hit.value)} inferred riders / weekday`}</div>`;
      }
      const share = relativeFor(data, "group", [hit.key], week);
      return `<b>${escapeHtml(name)}</b><div>${fmt(hit.value)} riders this week</div>
        <div>${Number.isFinite(share) ? `${Math.round(share * 100)}% of Feb. 2020` : "No Feb. 2020 service"}</div>`;
    }
    if (scene.view === "recovery") {
      const month = recoveryAt(data, "bgroup", hit.key, scene.recThresh);
      const text = month === -2 ? "Too little Feb. 2020 service to judge"
        : month === -1 ? "Not yet back to Feb. 2020" : `Back to Feb. 2020 in ${apMonth(meta.months[month])}`;
      return `<b>Block group ${escapeHtml(meta.bgroups[hit.key])}</b><div>${text}</div>`;
    }
    const share = relativeFor(data, "bgroup", [hit.key], week);
    return `<b>Block group ${escapeHtml(meta.bgroups[hit.key])}</b>
      <div>${fmt(totalAt(data, "bgroup", hit.key, week))} riders this week</div>
      <div>${Number.isFinite(share) ? `${Math.round(share * 100)}% of Feb. 2020` : "No Feb. 2020 service"}</div>`;
  };

  const onMove = (event) => {
    if (!scene || !getData()) return;
    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    let html = null;
    const dot = hits.dots.find((candidate) => Math.hypot(candidate.x - x, candidate.y - y) <= candidate.r + 1);
    if (dot) {
      html = tooltipHtml(dot, "dot");
    } else if (hits.areas.length) {
      const dpr = window.devicePixelRatio || 1;
      context.setTransform(1, 0, 0, 1, 0, 0);
      const area = hits.areas.find((candidate) => context.isPointInPath(candidate.path, x * dpr, y * dpr, "evenodd"));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (area) html = tooltipHtml(area, "area");
    }
    if (!html) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const flip = x > bounds.width - 240;
    tip.style.left = `${flip ? x - 14 - tip.offsetWidth : x + 14}px`;
    tip.style.top = `${Math.max(8, y - 12)}px`;
  };
  const onLeave = () => { tip.hidden = true; };
  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseleave", onLeave);
  map.on("move zoom resize", request);

  return {
    update(nextScene, nextWeek, nextCard) {
      if (removed || !nextScene) return;
      if (nextScene !== scene) {
        const first = !scene;
        scene = nextScene;
        retarget();
        if (first) {
          Object.assign(alpha, target);
        }
        if (scene.bounds !== boundsKey) {
          boundsKey = scene.bounds;
          fly(!first);
        }
      }
      week = nextWeek;
      card = nextCard || null;
      const key = `${scene.view}|${scene.level}|${scene.series}|${scene.focus?.mode}|${week}`;
      if (key !== hudKey) {
        hudKey = key;
        onHud({ scene, week });
      }
      request();
    },
    refit() {
      map.invalidateSize({ animate: false });
      fly(false);
      request();
    },
    redraw: request,
    remove() {
      removed = true;
      if (frame) window.cancelAnimationFrame(frame);
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      map.off("move zoom resize", request);
    },
  };
}

function Sparkline({ series, week, meta }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !series) return;
    const width = canvas.clientWidth || 232;
    const height = 58;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const ink = cssVar("--text-primary", "#0b0b0b");
    const muted = cssVar("--text-muted", "#84837c");
    const rule = cssVar("--rule", "#e4e3de");
    const accent = cssVar("--accent", "#2a78d6");
    const top = 4;
    const bottom = 14;
    const max = 1.4;
    const x = (index) => (index / (series.length - 1)) * width;
    const y = (value) => top + (1 - Math.min(max, Math.max(0, value)) / max) * (height - top - bottom);

    context.strokeStyle = rule;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(0, y(1));
    context.lineTo(width, y(1));
    context.stroke();
    context.setLineDash([]);

    const trace = (from, to) => {
      context.beginPath();
      let started = false;
      for (let index = from; index <= to; index += 1) {
        if (!Number.isFinite(series[index])) continue;
        if (!started) context.moveTo(x(index), y(series[index]));
        else context.lineTo(x(index), y(series[index]));
        started = true;
      }
      context.stroke();
    };
    context.lineWidth = 1.2;
    context.strokeStyle = muted;
    context.globalAlpha = 0.5;
    trace(week, series.length - 1);
    context.globalAlpha = 1;
    context.lineWidth = 1.6;
    context.strokeStyle = ink;
    trace(0, week);
    context.fillStyle = accent;
    context.beginPath();
    context.arc(x(week), y(series[week]), 3.5, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = muted;
    context.font = "10px ui-sans-serif, system-ui, sans-serif";
    context.textBaseline = "bottom";
    context.textAlign = "left";
    // Week 0 starts on 2018-12-31, so label the ends by the data's date range.
    context.fillText(meta.date_range[0].slice(0, 4), 0, height);
    context.textAlign = "right";
    context.fillText(meta.date_range[1].slice(0, 4), width, height);
    context.textAlign = "center";
    context.fillText("100%", Math.min(width - 16, Math.max(16, width / 2)), y(1) - 1);
  }, [series, week, meta]);
  return <canvas ref={canvasRef} className="story-spark" height="58" />;
}

function Ramp({ colors, labels }) {
  return (
    <>
      <div className="story-ramp">
        {colors.map((color) => <span key={color} style={{ background: color }} />)}
      </div>
      <div className="story-ramp-labels">
        {labels.map((text) => <span key={text}>{text}</span>)}
      </div>
    </>
  );
}

function Hud({ data, scene, week }) {
  const { meta } = data;
  if (scene.view === "commute") {
    const commute = data.commute;
    const period = commute ? commute.meta.periods[periodIndex(data, week)] : null;
    const [year, month] = (period?.id || "2026-02").split("-").map(Number);
    return (
      <>
        <div className="story-hud-kicker">Inferred morning trips</div>
        <div className="story-hud-title">{FULL_MONTHS[month - 1]} {year}</div>
        <p className="story-hud-note">
          Average weekday, 5–9 a.m., {scene.focus?.mode === "from" ? "leaving" : "arriving at"} UC Berkeley.
        </p>
        <Ramp colors={SEQ_GREEN.slice(1)} labels={["Fewer", "More inferred riders"]} />
        <div className="story-swatch"><span className="member" />UC Berkeley stop groups</div>
      </>
    );
  }
  if (scene.view === "recovery") {
    const low = meta.recovery_baseline_month + 2;
    const threshold = Math.round(meta.recovery_thresholds[scene.recThresh] * 100);
    return (
      <>
        <div className="story-hud-kicker">Recovery time</div>
        <div className="story-hud-title">First month back to {threshold}%</div>
        <p className="story-hud-note">
          When each block group first held {threshold}% of its Feb. 2020 ridership for three straight months.
        </p>
        <Ramp colors={SEQ_BLUE} labels={[apMonth(meta.months[low]), apMonth(meta.months[meta.months.length - 1])]} />
        <div className="story-swatch"><span style={{ background: REC_NEVER }} />Not yet</div>
        <div className="story-swatch"><span style={{ background: REC_SMALL }} />Too little 2020 service to judge</div>
      </>
    );
  }
  const prep = prepareStory(data);
  const series = scene.series === "system" ? prep.series.system : prep.series.berkeley;
  const share = series[week];
  return (
    <>
      <div className="story-hud-kicker">Week of</div>
      <div className="story-hud-title">{apDate(meta.weeks[week])}</div>
      <Sparkline series={series} week={week} meta={meta} />
      <p className="story-hud-note">
        {scene.series === "system" ? "Systemwide" : "Berkeley"} ridership:{" "}
        <b>{Number.isFinite(share) ? `${Math.round(share * 100)}%` : "–"}</b> of Feb. 2020
      </p>
      <Ramp colors={DIVERGING_RG} labels={["0%", "100%", "200%"]} />
      <p className="story-hud-note subtle">
        {scene.level === "group"
          ? "Each dot is a stop; size shows riders per week. Colour compares the week to Feb. 2020."
          : "Block groups coloured by ridership compared with Feb. 2020."}
      </p>
    </>
  );
}

export default function StoryMap({ data, initialBounds, apiRef, onReady, layout = "scrolly", label }) {
  const containerRef = useRef(null);
  const dataRef = useRef(data);
  const engineRef = useRef(null);
  const onReadyRef = useRef(onReady);
  const [hud, setHud] = useState(null);
  dataRef.current = data;
  onReadyRef.current = onReady;

  useEffect(() => {
    let disposed = false;
    let map = null;
    let observer = null;
    import("leaflet").then((module) => {
      if (disposed || !containerRef.current) return;
      const L = module.default || module;
      const container = containerRef.current;
      map = L.map(container, {
        zoomControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false,
        zoomSnap: 0,
        zoomAnimation: false,
        inertia: false,
      });
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
      L.tileLayer(basemap.url, { attribution: basemap.attribution, maxZoom: 19, className: basemap.className }).addTo(map);
      map.fitBounds(initialBounds, {
        ...fitPadding(container.clientWidth, container.clientHeight, layout),
        animate: false,
      });
      // Created here rather than rendered by React: they live inside Leaflet's
      // container, which React does not manage the children of.
      const canvas = document.createElement("canvas");
      canvas.className = "story-layer";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "story-annotations");
      const tip = document.createElement("div");
      tip.className = "story-tip";
      tip.hidden = true;
      container.append(canvas, svg, tip);
      const engine = createEngine({
        map,
        container,
        canvas,
        svg,
        tip,
        getData: () => dataRef.current,
        layout,
        onHud: setHud,
      });
      engineRef.current = engine;
      if (apiRef) apiRef.current = engine;
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => engine.refit());
        observer.observe(container);
      }
      onReadyRef.current?.();
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      engineRef.current?.remove();
      engineRef.current = null;
      if (apiRef) apiRef.current = null;
      map?.remove();
    };
    // The map is created once; scenes arrive through the engine's update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.redraw();
    if (data) onReadyRef.current?.();
  }, [data]);

  return (
    <div className="story-map" aria-label={label} role="img">
      <div ref={containerRef} className="story-map-canvas" />
      {data && hud ? (
        <div className="story-hud">
          <Hud data={data} scene={hud.scene} week={hud.week} />
        </div>
      ) : null}
      {!data ? <div className="story-map-loading">Loading ridership data…</div> : null}
    </div>
  );
}
