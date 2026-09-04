// Where the packed data bundle lives. Defaults to the copy under public/, so
// a local checkout with `npm run fetch:pack` works with no configuration; the
// deployed app points this at the public GCS bucket instead, which keeps the
// 55 MB bundle out of the container image and lets the browser cache it.
export const PACK = (process.env.NEXT_PUBLIC_PACK_BASE || "/data/pack").replace(/\/$/, "");

export const M = { BDR: 0, BDI: 1, ALR: 2, ALI: 3 };

export const SEQ_BLUE = [
  "#cde2fb",
  "#9ec5f4",
  "#6da7ec",
  "#3987e5",
  "#2a78d6",
  "#1c5cab",
  "#104281",
];
export const SEQ_GOLD = [
  "#fdf0cf",
  "#f9dc94",
  "#f3c65c",
  "#eda100",
  "#c98500",
  "#a06a00",
  "#754e00",
];
export const DIVERGING = [
  "#104281",
  "#2a78d6",
  "#86b6ef",
  "#f0efec",
  "#f0a3a2",
  "#e34948",
  "#a11f1f",
];
/* Relative-to-baseline ramp: red below Feb 2020, green above. Diverging
   around the neutral midpoint at 100%, distinct from the blue magnitude
   ramp used by the total view. */
export const DIVERGING_RG = [
  "#a11f1f",
  "#e34948",
  "#f0a3a2",
  "#f0efec",
  "#a9d8b3",
  "#419c62",
  "#0d5732",
];
export const SEQ_GREEN = [
  "#fcfcfb",
  "#d8ecdc",
  "#a9d8b3",
  "#72bd88",
  "#419c62",
  "#1e7a47",
  "#0d5732",
];
// Income gets magenta because it is the one ramp that has to coexist with
// another: in the income view the areas are magenta while the corridors stay
// on the blue load ramp above them. Violet was the first choice and measured
// deutan dE 4.0 / normal dE 13.7 against that blue -- below the floor, i.e.
// indistinguishable. Magenta measures 13.1 / 23.8 and clears it.
export const SEQ_MAGENTA = [
  "#f6d5e3",
  "#eaadc9",
  "#db84ae",
  "#cb5794",
  "#bc4886",
  "#953469",
  "#6f224c",
];
export const REC_NEVER = "#a11f1f";
export const REC_SMALL = "#c9c8c2";

export function fmt(value) {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US");
}

export function ramp(stops, value) {
  if (!Number.isFinite(value)) return "#d8d7d2";
  const x = Math.max(0, Math.min(1, value)) * (stops.length - 1);
  return stops[Math.round(x)];
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getJson(name) {
  const response = await fetch(`${PACK}/${name}`);
  if (!response.ok) throw new Error(`Could not load ${name} (${response.status})`);
  return response.json();
}

async function getBinary(name, Type) {
  const response = await fetch(`${PACK}/${name}`);
  if (!response.ok) throw new Error(`Could not load ${name} (${response.status})`);
  return new Type(await response.arrayBuffer());
}

function buildRouteSectionIndex(meta) {
  const index = {};
  const sections = meta.geometry.sections;
  for (let sid = 0; sid < sections.route.length; sid += 1) {
    const route = sections.route[sid];
    const era = sections.era[sid];
    if (!index[route]) index[route] = {};
    if (!index[route][era]) index[route][era] = [];
    index[route][era].push(sid);
  }
  return index;
}

function buildDomains(data) {
  const domains = {};
  for (const level of ["group", "tract", "bgroup"]) {
    const store = data.store[level];
    const values = [];
    for (let key = 0; key < store.n; key += 1) {
      for (let week = 0; week < data.W; week += 4) {
        const value = totalAt(data, level, key, week);
        if (value > 0) values.push(value);
      }
    }
    values.sort((a, b) => a - b);
    domains[level] = values.length ? values[Math.floor(values.length * 0.98)] : 1;
  }
  return domains;
}

export async function loadVisualizationData() {
  const meta = await getJson("meta.json");
  const [routeWeeks, stopGroupWeeks, tractWeeks, blockGroupWeeks] = await Promise.all([
    getBinary("route_weeks.u16", Uint16Array),
    getBinary("stopgroup_weeks.u16", Uint16Array),
    getBinary("tract_weeks.u16", Uint16Array),
    getBinary("bgroup_weeks.u16", Uint16Array),
  ]);

  const sections = {};
  const corridors = {};
  const corridorNodes = {};
  await Promise.all(
    Object.entries(meta.sections).map(async ([era, spec]) => {
      const [load, imp, eraCorridors, eraNodes] = await Promise.all([
        getBinary(`section_load_${era}.u16`, Uint16Array),
        getBinary(`section_imp_${era}.u8`, Uint8Array),
        getJson(`corridors_${era}.json`),
        getJson(`nodes_${era}.json`),
      ]);
      sections[era] = {
        load,
        imp,
        scale: Float32Array.from(spec.scale),
        idIndex: new Map(spec.section_ids.map((id, index) => [id, index])),
        weekLo: spec.week_lo,
        nWeeks: spec.n_weeks,
      };
      corridors[era] = eraCorridors;
      corridorNodes[era] = eraNodes;
    }),
  );

  const [tractGeo, blockGroupGeo] = await Promise.all([
    getJson("tracts.geojson"),
    getJson("blockgroups.geojson"),
  ]);

  const data = {
    meta,
    W: meta.n_weeks,
    BASE: meta.baseline_week,
    store: {
      group: {
        q: stopGroupWeeks,
        scale: Float32Array.from(meta.scales.stopgroup),
        n: meta.stop_groups.n,
      },
      tract: {
        q: tractWeeks,
        scale: Float32Array.from(meta.scales.tract),
        n: meta.tracts.length,
      },
      bgroup: {
        q: blockGroupWeeks,
        scale: Float32Array.from(meta.scales.bgroup),
        n: meta.bgroups.length,
      },
    },
    routeW: {
      q: routeWeeks,
      scale: Float32Array.from(meta.route_weeks.scale),
      ix: new Map(meta.route_weeks.routes.map((route, index) => [route, index])),
    },
    sections,
    corridors,
    corridorNodes,
    geo: { tracts: tractGeo, blockgroups: blockGroupGeo },
    routeSections: buildRouteSectionIndex(meta),
    routeNameIx: new Map(meta.route_names.map((route, index) => [route, index])),
    domains: null,
    corridorStats: {},
    corridorDom: null,
    incomeDom: null,
    monthIndex: meta.weeks.map((week) => meta.months.indexOf(week.slice(0, 7))),
  };

  data.domains = buildDomains(data);
  try {
    data.commute = await loadCommuteData();
  } catch {
    data.commute = null;
  }
  return data;
}

export function rawAt(data, level, key, week, measure) {
  const store = data.store[level];
  return store.q[(key * data.W + week) * 4 + measure] * store.scale[key];
}

export function totalAt(data, level, key, week) {
  return (
    rawAt(data, level, key, week, M.BDR) +
    rawAt(data, level, key, week, M.BDI) +
    rawAt(data, level, key, week, M.ALR) +
    rawAt(data, level, key, week, M.ALI)
  );
}

export function imputedAt(data, level, key, week) {
  return rawAt(data, level, key, week, M.BDI) + rawAt(data, level, key, week, M.ALI);
}

export function recoveryAt(data, level, key, threshold) {
  const table = data.meta.recovery[level === "group" ? "stopgroup" : level];
  return table?.[key]?.[threshold] ?? -2;
}

// ACS median household income for an area. A stop group has no income of its
// own, so it reads the tract containing it -- the same tract the area view
// would colour underneath it.
export function incomeAt(data, level, key) {
  const income = data.meta.income;
  if (!income) return null;
  let table = income[level];
  let index = key;
  if (level === "group") {
    index = data.meta.stop_groups.tract[key];
    table = income.tract;
    if (index === undefined || index < 0) return null;
  }
  if (!table) return null;
  const med = table.med[index];
  if (med === null || med === undefined) return null;
  const moe = table.moe[index];
  return {
    med,
    moe: moe ?? null,
    // A top-coded median has no computable MOE; that is not the same as an
    // unknown one, so the two are reported separately.
    topCoded: med >= income.top_code,
    rel: moe && med ? moe / med : null,
  };
}

// Fixed to the tract distribution so the ramp does not rebase when you switch
// between tracts and block groups -- the same colour means the same income at
// both levels, which is the whole point of putting them on one map.
export function incomeDomain(data) {
  if (data.incomeDom) return data.incomeDom;
  const table = data.meta.income?.tract;
  const values = (table?.med || []).filter((v) => v !== null && v !== undefined);
  values.sort((a, b) => a - b);
  data.incomeDom = values.length
    ? [values[Math.floor(values.length * 0.05)], values[Math.floor(values.length * 0.95)]]
    : [0, 1];
  return data.incomeDom;
}

// Uncertainty is drawn as loss of chroma at constant lightness. Fading toward
// the surface instead would be read as a different income: on a dark basemap a
// paler low-income fill darkens, and this ramp already uses dark for high.
// Washing the colour out cannot be confused with moving along the ramp.
function mute(hex, amount) {
  if (amount <= 0) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const t = Math.min(1, amount);
  const mix = (c) => Math.round(c + (grey - c) * t).toString(16).padStart(2, "0");
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

export function incomeColor(data, level, key) {
  const income = incomeAt(data, level, key);
  if (!income) return null;
  const [lo, hi] = incomeDomain(data);
  const base = ramp(SEQ_MAGENTA, (income.med - lo) / Math.max(1, hi - lo));
  // Full colour up to a 20% margin, washed out by 60%, which is roughly the
  // 90th percentile of block-group error. Top-coded medians keep full chroma:
  // "$250,000 or more" is a confident statement, not a noisy one.
  if (income.topCoded || !income.rel) return base;
  return mute(base, Math.max(0, (income.rel - 0.2) / 0.4) * 0.8);
}

export function metricAt(data, level, key, week, view, recThresh) {
  if (view === "income") return incomeAt(data, level, key)?.med ?? NaN;
  const value = totalAt(data, level, key, week);
  if (view === "total") return value;
  if (view === "imp") return value > 0 ? imputedAt(data, level, key, week) / value : NaN;
  if (view === "recovery") return recoveryAt(data, level, key, recThresh);
  const baseline = totalAt(data, level, key, data.BASE);
  return baseline > 0 ? value / baseline : NaN;
}

export function colorFor(data, level, key, week, view, recThresh) {
  if (view === "income") return incomeColor(data, level, key);
  if (view === "recovery") {
    const month = recoveryAt(data, level, key, recThresh);
    if (month === -2) return REC_SMALL;
    if (month === -1) return REC_NEVER;
    const low = data.meta.recovery_baseline_month + 2;
    const span = data.meta.months.length - low;
    return ramp(SEQ_BLUE, (month - low) / span);
  }
  const value = metricAt(data, level, key, week, view, recThresh);
  if (!Number.isFinite(value)) return null;
  if (view === "total") return ramp(SEQ_BLUE, Math.sqrt(value / data.domains[level]));
  if (view === "imp") return ramp(SEQ_GOLD, value);
  return ramp(DIVERGING_RG, value / 2);
}

export function eraForWeek(data, week) {
  for (const [era, spec] of Object.entries(data.meta.sections)) {
    if (week >= spec.week_lo && week < spec.week_lo + spec.n_weeks) return era;
  }
  return null;
}

export function sectionLoad(data, era, sectionId, week) {
  const section = data.sections[era];
  const row = section.idIndex.get(sectionId);
  if (row === undefined) return [0, 0];
  const index = row * section.nWeeks + (week - section.weekLo);
  const load = section.load[index] * section.scale[row];
  return [load, section.imp[index] / 255];
}

// A corridor node is a place the answer changes: a stop group, or a junction
// where routes join or leave. Only the stop-group ones move load -- boardings
// and alightings happen there and nowhere else. The counts are the group's,
// so they cover every route stopping there, which on a shared street is more
// than the corridor the node sits on.
export function nodeFlow(data, era, node, week) {
  if (!node || node.g < 0) return null;
  const board = rawAt(data, "group", node.g, week, 0);
  const boardImp = rawAt(data, "group", node.g, week, 1);
  const alight = rawAt(data, "group", node.g, week, 2);
  const alightImp = rawAt(data, "group", node.g, week, 3);
  return {
    board: board + boardImp,
    boardImp,
    alight: alight + alightImp,
    alightImp,
    net: board + boardImp - alight - alightImp,
    name: data.meta.stop_groups.name[node.g],
  };
}

export function corridorStats(data, era) {
  if (data.corridorStats[era]) return data.corridorStats[era];
  const startMonth = data.meta.months.indexOf("2020-04");
  const features = data.corridors[era];
  const section = data.sections[era];
  const nFeatures = features.length;
  const nMonths = data.meta.months.length;
  const monthly = new Float32Array(nFeatures * nMonths);
  const base = features.map((feature, index) => feature.b ?? data.meta.corridor_base[era]?.[index] ?? 0);
  const sample = [];
  const weekTotals = new Float32Array(nFeatures);

  for (let localWeek = 0; localWeek < section.nWeeks; localWeek += 1) {
    weekTotals.fill(0);
    const globalWeek = section.weekLo + localWeek;
    features.forEach((feature, featureIndex) => {
      for (const sectionId of feature.s) {
        const row = section.idIndex.get(sectionId);
        if (row !== undefined) {
          weekTotals[featureIndex] +=
            section.load[row * section.nWeeks + localWeek] * section.scale[row];
        }
      }
    });
    const monthIndex = data.monthIndex[globalWeek];
    if (monthIndex < 0) continue;
    for (let featureIndex = 0; featureIndex < nFeatures; featureIndex += 1) {
      monthly[featureIndex * nMonths + monthIndex] = weekTotals[featureIndex];
      if (weekTotals[featureIndex] > 0 && (localWeek & 3) === 0) {
        sample.push(weekTotals[featureIndex]);
      }
    }
  }

  const thresholds = data.meta.recovery_thresholds;
  const sustain = 3;
  const recovery = new Int16Array(nFeatures * thresholds.length);
  recovery.fill(-1);
  const monthLimit = nMonths - sustain + 1;
  for (let featureIndex = 0; featureIndex < nFeatures; featureIndex += 1) {
    const baseline = base[featureIndex] || 0;
    if (baseline < 500) {
      for (let threshold = 0; threshold < thresholds.length; threshold += 1) {
        recovery[featureIndex * thresholds.length + threshold] = -2;
      }
      continue;
    }
    for (let threshold = 0; threshold < thresholds.length; threshold += 1) {
      const target = baseline * thresholds[threshold];
      for (let month = Math.max(0, startMonth); month < monthLimit; month += 1) {
        let sustained = true;
        for (let offset = 0; offset < sustain && sustained; offset += 1) {
          sustained = monthly[featureIndex * nMonths + month + offset] >= target;
        }
        if (sustained) {
          recovery[featureIndex * thresholds.length + threshold] = month;
          break;
        }
      }
    }
  }

  const result = { base, recovery, sample };
  data.corridorStats[era] = result;
  return result;
}

export function corridorDomain(data) {
  if (data.corridorDom !== null) return data.corridorDom;
  let values = [];
  for (const era of Object.keys(data.corridors)) {
    values = values.concat(corridorStats(data, era).sample);
  }
  values.sort((a, b) => a - b);
  data.corridorDom = values.length ? values[Math.floor(values.length * 0.98)] : 1;
  return data.corridorDom;
}

export function corridorColor(data, era, index, load, imp, view, recThresh) {
  if (view === "total") return ramp(SEQ_BLUE, Math.sqrt(load / corridorDomain(data)));
  if (view === "imp") return load > 0 ? ramp(SEQ_GOLD, imp / load) : null;
  const stats = corridorStats(data, era);
  if (view === "rel") {
    const baseline = stats.base[index];
    return baseline > 0 ? ramp(DIVERGING_RG, (load / baseline) / 2) : "#d8d7d2";
  }
  const month = stats.recovery[index * data.meta.recovery_thresholds.length + recThresh];
  if (month === -2) return REC_SMALL;
  if (month === -1) return REC_NEVER;
  const low = data.meta.recovery_baseline_month + 2;
  const span = data.meta.months.length - low;
  return ramp(SEQ_BLUE, (month - low) / span);
}

export function routesFor(data, level, key, week) {
  const era = eraForWeek(data, week) || Object.keys(data.meta.routes_by_era)[0];
  const byEra = data.meta.routes_by_era[era] || [];
  const groups = data.meta.stop_groups;
  let routeIndexes = [];
  if (level === "group") {
    routeIndexes = byEra[key] || [];
  } else {
    const field = level === "tract" ? groups.tract : groups.bgroup;
    const routeSet = new Set();
    for (let group = 0; group < groups.n; group += 1) {
      if (field[group] === key) {
        for (const route of byEra[group] || []) routeSet.add(route);
      }
    }
    routeIndexes = [...routeSet];
  }
  return routeIndexes
    .map((index) => data.meta.route_names[index])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function selectionSeries(data, keys) {
  const real = new Float64Array(data.W);
  const imp = new Float64Array(data.W);
  for (const key of keys) {
    for (let week = 0; week < data.W; week += 1) {
      const imputed = imputedAt(data, "group", key, week);
      real[week] += totalAt(data, "group", key, week) - imputed;
      imp[week] += imputed;
    }
  }
  return { real, imp };
}

export function routeBoardings(data, route, week) {
  const row = data.routeW.ix.get(route);
  if (row === undefined) return null;
  const offset = (row * data.W + week) * 2;
  const scale = data.routeW.scale[row];
  return {
    real: data.routeW.q[offset] * scale,
    imp: data.routeW.q[offset + 1] * scale,
  };
}

export function routeOwnSeries(data, route) {
  const real = new Float64Array(data.W);
  const imp = new Float64Array(data.W);
  const byEra = data.routeSections[route] || {};
  const eras = [];
  for (const [era, sectionIds] of Object.entries(byEra)) {
    const section = data.sections[era];
    if (!section) continue;
    let count = 0;
    for (const sectionId of sectionIds) {
      const row = section.idIndex.get(sectionId);
      if (row === undefined) continue;
      count += 1;
      for (let localWeek = 0; localWeek < section.nWeeks; localWeek += 1) {
        const index = row * section.nWeeks + localWeek;
        const load = section.load[index] * section.scale[row];
        const imputed = load * (section.imp[index] / 255);
        real[section.weekLo + localWeek] += load - imputed;
        imp[section.weekLo + localWeek] += imputed;
      }
    }
    if (count) eras.push({ era, nsec: count });
  }
  return { real, imp, eras };
}

export function routeStreetSeries(data, route) {
  const real = new Float64Array(data.W);
  const imp = new Float64Array(data.W);
  const eras = [];
  for (const era of Object.keys(data.corridors)) {
    const section = data.sections[era];
    let count = 0;
    const directions = new Set();
    for (const feature of data.corridors[era]) {
      const mine = feature.r.filter((routeDirection) => routeDirection.split("|")[0] === route);
      if (!mine.length) continue;
      mine.forEach((routeDirection) => directions.add(routeDirection.split("|")[1]));
      const share = 1 / feature.r.length;
      for (const sectionId of feature.s) {
        const row = section.idIndex.get(sectionId);
        if (row === undefined) continue;
        for (let week = section.weekLo; week < section.weekLo + section.nWeeks; week += 1) {
          const index = row * section.nWeeks + (week - section.weekLo);
          const load = section.load[index] * section.scale[row] * share;
          const imputed = load * (section.imp[index] / 255);
          real[week] += load - imputed;
          imp[week] += imputed;
        }
      }
      count += feature.s.length;
    }
    if (count) eras.push({ era, nsec: count, dirs: [...directions] });
  }
  return { real, imp, eras };
}

/* ---------------------------------------------------------------- commute */
/* Average-weekday hourly profiles and inferred O-D flows, built by
   scripts/build_commute_pack.py from raw APC events (capture-corrected and
   NTD-calibrated) for a series of six-month snapshots from Feb 2019 to the
   latest complete month, so pre- and post-pandemic patterns are comparable.
   O-D files are fetched per snapshot on demand. */

async function loadCommuteData() {
  const meta = await getJson("commute_meta.json");
  const hourly = {};
  await Promise.all(
    Object.entries(meta.hourly).map(async ([level, spec]) => {
      const q = await getBinary(spec.file, Uint16Array);
      hourly[level] = {
        q,
        scales: Float32Array.from(spec.scales),
        n: spec.n,
        nP: spec.nP,
      };
    }),
  );
  const baseIdx = meta.periods.findIndex((period) => period.id === meta.base);
  return { meta, hourly, odCache: {}, commuteDomains: {}, baseIdx };
}

// [key][snapshot][measure][hour]; snapshot index into meta.periods.
export function commuteHourly(commute, level, key, p) {
  const store = commute.hourly[level];
  const period = commute.meta.periods[p];
  const scale = store.scales[key] / period.weekdays;
  const base = key * store.nP * 48 + p * 48;
  const bd = new Float64Array(24);
  const al = new Float64Array(24);
  for (let hour = 0; hour < 24; hour += 1) {
    bd[hour] = store.q[base + hour] * scale;
    al[hour] = store.q[base + 24 + hour] * scale;
  }
  return { bd, al };
}

// One O-D file per snapshot, fetched on first use and cached in memory.
export async function loadCommuteOD(commute, anchorId) {
  if (commute.odCache[anchorId]) return commute.odCache[anchorId];
  const spec = commute.meta.od[anchorId];
  const q = await getBinary(spec.am.file, Uint8Array);
  const store = {
    q,
    view: new DataView(q.buffer),
    levels: spec.am.levels,
    offsets: {},
  };
  commute.odCache[anchorId] = store;
  return store;
}

function levelOffsets(store, level) {
  if (store.offsets[level]) return store.offsets[level];
  const spec = store.levels[level];
  const offsets = new Uint32Array(spec.n);
  let pos = spec.offset;
  for (let key = 0; key < spec.n; key += 1) {
    offsets[key] = pos;
    pos += 2 + (store.q[pos] + store.q[pos + 1 + store.q[pos] * 6]) * 6;
  }
  store.offsets[level] = offsets;
  return offsets;
}

function readOdList(store, pos) {
  const count = store.q[pos];
  pos += 1;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      g: store.q[pos] | (store.q[pos + 1] << 8),
      flow: store.view.getFloat32(pos + 2, true),
    });
    pos += 6;
  }
  return [entries, pos];
}

export function commuteODLists(store, level, key) {
  const spec = store.levels[level];
  if (!spec || key >= spec.n) return { in: [], out: [] };
  let pos = levelOffsets(store, level)[key];
  const inbound = readOdList(store, pos);
  pos = inbound[1];
  return { in: inbound[0], out: readOdList(store, pos)[0] };
}

/* Box selection: aggregate the member stop groups' top-K lists into one
   region "to here" (arrivals) / "from here" (departures) pair of lists, with
   flows between members of the region itself dropped. At tract/block-group
   level the entries are re-keyed through the group -> area mapping, so the
   map recolours in the active level's key space. */
export function commuteRegionLists(meta, store, keys, level) {
  const groups = meta.stop_groups;
  const field = level === "tract" ? groups.tract
    : level === "bgroup" ? groups.bgroup : null;
  const keyOf = (g) => (field ? field[g] : g);
  const memberKeys = new Set(keys.map(keyOf).filter((k) => k >= 0));
  const inMap = new Map();
  const outMap = new Map();
  for (const key of keys) {
    const lists = commuteODLists(store, "group", key);
    for (const entry of lists.in) {
      const k = keyOf(entry.g);
      if (!(k >= 0) || memberKeys.has(k)) continue;
      inMap.set(k, (inMap.get(k) || 0) + entry.flow);
    }
    for (const entry of lists.out) {
      const k = keyOf(entry.g);
      if (!(k >= 0) || memberKeys.has(k)) continue;
      outMap.set(k, (outMap.get(k) || 0) + entry.flow);
    }
  }
  const sorted = (m) => [...m]
    .map(([g, flow]) => ({ g, flow }))
    .sort((a, b) => b.flow - a.flow);
  return { in: sorted(inMap), out: sorted(outMap), memberKeys };
}

export function commuteStats(commute, level, key, p) {
  if (!commute || key === undefined || key < 0) return null;
  const store = commute.hourly[level];
  if (!store || key >= store.n || p === undefined || p < 0) return null;
  const windows = commute.meta.windows;
  const now = commuteHourly(commute, level, key, p);
  const base = commuteHourly(commute, level, key, commute.baseIdx);
  const sumRange = (values, lo, hi) => {
    let sum = 0;
    for (let hour = lo; hour < hi; hour += 1) sum += values[hour];
    return sum;
  };
  const total = sumRange(now.bd, 0, 24) + sumRange(now.al, 0, 24);
  const baseTotal = sumRange(base.bd, 0, 24) + sumRange(base.al, 0, 24);
  const amIn = sumRange(now.al, windows.am[0], windows.am[1]);
  const amOut = sumRange(now.bd, windows.am[0], windows.am[1]);
  const pmOut = sumRange(now.bd, windows.pm[0], windows.pm[1]);
  const pmIn = sumRange(now.al, windows.pm[0], windows.pm[1]);
  let maxHour = 6;
  let maxValue = 0;
  let daySum = 0;
  for (let hour = 6; hour <= 21; hour += 1) {
    const value = now.bd[hour] + now.al[hour];
    daySum += value;
    if (value > maxValue) {
      maxValue = value;
      maxHour = hour;
    }
  }
  return {
    total,
    baseTotal,
    amNet: total > 0 ? (amIn - amOut) / total : NaN,
    pmNet: total > 0 ? (pmOut - pmIn) / total : NaN,
    peakRatio: daySum > 0 ? maxValue / (daySum / 16) : NaN,
    peakHour: maxHour,
  };
}

export function commuteDomain(commute, level, p) {
  const cacheKey = `${level}|${p}`;
  if (commute.commuteDomains[cacheKey]) return commute.commuteDomains[cacheKey];
  const store = commute.hourly[level];
  const values = [];
  for (let key = 0; key < store.n; key += 1) {
    const stats = commuteStats(commute, level, key, p);
    if (stats && stats.total > 0) values.push(stats.total);
  }
  values.sort((a, b) => a - b);
  const domain = values.length ? values[Math.floor(values.length * 0.98)] : 1;
  commute.commuteDomains[cacheKey] = domain;
  return domain;
}
