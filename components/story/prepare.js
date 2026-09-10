import { totalAt } from "../ridership-data";
import { BERKELEY_BOUNDARY } from "./berkeley-boundary";

// Web Mercator at zoom 0 (a 256 px world), identical to Leaflet's EPSG:3857
// projection. Everything the story draws is projected once into this space;
// a frame only has to scale by 2^zoom and translate, which is what keeps the
// map smooth while the camera flies and the week scrubs underneath it.
export function mercator(lat, lon) {
  const sin = Math.sin((lat * Math.PI) / 180);
  return [
    ((lon + 180) / 360) * 256,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 256,
  ];
}

export function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function projectRing(coordinates, lonLat) {
  const out = new Float64Array(coordinates.length * 2);
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  coordinates.forEach((coordinate, index) => {
    const [x, y] = lonLat ? mercator(coordinate[1], coordinate[0]) : mercator(coordinate[0], coordinate[1]);
    out[index * 2] = x;
    out[index * 2 + 1] = y;
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  });
  return { pts: out, bounds };
}

// The stop groups around the UC Berkeley campus: Bancroft, Durant, Hearst,
// Gayley, Piedmont and the Oxford/University edge. The same set drives the
// inferred-trips region and the weekly ridership chart.
const CAMPUS = { south: 37.866, north: 37.8765, west: -122.2665, east: -122.2505 };

function relativeSeries(data, keys) {
  const series = new Float32Array(data.W);
  let base = 0;
  for (const key of keys) base += totalAt(data, "group", key, data.BASE);
  for (let week = 0; week < data.W; week += 1) {
    let sum = 0;
    for (const key of keys) sum += totalAt(data, "group", key, week);
    series[week] = base > 0 ? sum / base : NaN;
  }
  return series;
}

const cache = new WeakMap();

export function prepareStory(data) {
  if (cache.has(data)) return cache.get(data);
  const { meta } = data;
  const groups = meta.stop_groups;

  const gx = new Float64Array(groups.n);
  const gy = new Float64Array(groups.n);
  const groupInBerkeley = new Uint8Array(groups.n);
  const berkeleyGroups = [];
  const campusKeys = [];
  for (let key = 0; key < groups.n; key += 1) {
    const [x, y] = mercator(groups.lat[key], groups.lon[key]);
    gx[key] = x;
    gy[key] = y;
    if (pointInRing(groups.lat[key], groups.lon[key], BERKELEY_BOUNDARY)) {
      groupInBerkeley[key] = 1;
      berkeleyGroups.push(key);
    }
    if (
      groups.lat[key] > CAMPUS.south && groups.lat[key] < CAMPUS.north
      && groups.lon[key] > CAMPUS.west && groups.lon[key] < CAMPUS.east
    ) campusKeys.push(key);
  }

  const bgroupIndex = new Map(meta.bgroups.map((id, index) => [String(id), index]));
  const areas = [];
  for (const feature of data.geo.blockgroups.features) {
    const key = bgroupIndex.get(String(feature.properties?.geoid));
    if (key === undefined || !feature.geometry) continue;
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    const rings = [];
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    let latSum = 0;
    let lonSum = 0;
    let count = 0;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const projected = projectRing(ring, true);
        rings.push(projected.pts);
        bounds[0] = Math.min(bounds[0], projected.bounds[0]);
        bounds[1] = Math.min(bounds[1], projected.bounds[1]);
        bounds[2] = Math.max(bounds[2], projected.bounds[2]);
        bounds[3] = Math.max(bounds[3], projected.bounds[3]);
      }
      for (const [lon, lat] of polygon[0]) {
        lonSum += lon;
        latSum += lat;
        count += 1;
      }
    }
    areas.push({
      key,
      rings,
      bounds,
      inBerkeley: count > 0 && pointInRing(latSum / count, lonSum / count, BERKELEY_BOUNDARY),
    });
  }

  const corridors = {};
  for (const [era, features] of Object.entries(data.corridors)) {
    corridors[era] = features.map((feature) => projectRing(feature.c, false));
  }

  const prepared = {
    gx,
    gy,
    groupInBerkeley,
    berkeleyGroups,
    campusKeys,
    areas,
    corridors,
    berkeley: projectRing(BERKELEY_BOUNDARY, false).pts,
    series: {
      berkeley: relativeSeries(data, berkeleyGroups),
      system: relativeSeries(data, Array.from({ length: groups.n }, (_, key) => key)),
    },
    odLists: {},
  };
  cache.set(data, prepared);
  return prepared;
}

// Named places the copy points at. `keys` picks what the on-map label
// measures, at the level it is measured: a stop group where the story is
// about a stop, block groups where the stop groups changed underneath it --
// Tempo's median stations are new stop groups with no 2020 baseline, so only
// the areas around International Blvd can show its growth.
export function resolvePlaces(data) {
  const groups = data.meta.stop_groups;
  const named = (pattern) => {
    const keys = [];
    for (let key = 0; key < groups.n; key += 1) if (pattern.test(groups.name[key])) keys.push(key);
    return keys;
  };
  const areasOf = (keys) => [...new Set(keys.map((key) => groups.bgroup[key]).filter((key) => key >= 0))];
  return {
    bancroft: {
      label: "Bancroft Way & College Ave.",
      lat: 37.86929, lon: -122.25513, level: "group", keys: named(/^Bancroft Way & College Av$/),
    },
    sanPablo: {
      label: "San Pablo Ave. & University Ave.",
      lat: 37.86912, lon: -122.29206, level: "group", keys: named(/^University Av & San Pablo Av$/),
    },
    tempo: {
      label: "International Blvd.",
      lat: 37.75911, lon: -122.18647, level: "bgroup", keys: areasOf(named(/International Blvd/)),
    },
    transbay: {
      label: "Salesforce Transit Center",
      lat: 37.78976, lon: -122.39606, level: "group", keys: named(/^Salesforce Transit Center/),
    },
    rockridge: { label: "Rockridge BART", lat: 37.84469, lon: -122.25186 },
    ucVillage: { label: "UC Village", lat: 37.88428, lon: -122.29889 },
  };
}
