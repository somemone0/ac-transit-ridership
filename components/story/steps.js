// The story's copy and the map state each passage drives. A step's `scene`
// is layered over the step before it, so a step only states what changes --
// the same way the script reads ("switch to block groups", "zoom out").
//
// Weeks are the Monday a week starts on, as meta.weeks labels them. Each is a
// representative week in the month the script names, clear of holidays:
// 2020-02-03 is the app's own Feb 2020 baseline week.
//
// Figures quoted in the copy come from numbers.json, resolved once by
// scripts/build_story_numbers.py rather than recomputed in the browser.
import NUMBERS from "./numbers.json";

export const WEEKS = {
  feb2020: "2020-02-03",
  apr2020: "2020-04-20",
  jul2021: "2021-07-19",
  nov2021: "2021-11-08",
  jul2022: "2022-07-11",
  aug2023: "2023-08-28",
  dec2020: "2020-12-07",
  sep2021: "2021-09-13",
  feb2026: "2026-02-09",
};

// [[south, west], [north, east]]
export const BOUNDS = {
  berkeley: [[37.848, -122.318], [37.9065, -122.235]],
  eastBay: [[37.718, -122.405], [37.905, -122.15]],
  campusFlows: [[37.8, -122.33], [37.9, -122.215]],
  southEastBay: [[37.49, -122.42], [37.9, -121.92]],
};

export const RECOVERY_THRESHOLD = 5; // meta.recovery_thresholds[5] = 100%

const { income, speeds } = NUMBERS;

export const MAP_ONE = [
  {
    scene: {
      view: "rel",
      level: "group",
      routes: true,
      mask: true,
      bounds: "berkeley",
      week: "feb2020",
      series: "berkeley",
    },
    text: [
      "Through a public records request, The Daily Californian was able to obtain a trip-level accounting of AC Transit’s ridership from January 2019 through May 2026. Ridership is counted through automatic people counters, sensors on AC Transit buses that detect when people leave and enter.",
    ],
  },
  {
    text: [
      "However, especially pre-pandemic, many buses did not have these counters. The Daily Californian simulated rides using statistical methods based on route-level total ridership estimates from AC Transit. Simulated rides make up about 40% of rides in 2019, but decline to under 5% of rides after 2021. For some routes like the 1T in East Oakland and new routes after the 2025 Realign changes, simulated rides make up the majority of rides.",
    ],
    link: { href: "/methodology", label: "See our methodology →" },
  },
  {
    text: [
      "This is the city of Berkeley’s AC Transit ridership in February 2020. Each dot represents a stop, and each line is one or more AC Transit routes. The size of the dots represent the number of people who boarded or left a bus.",
    ],
  },
  {
    scrub: true,
    scene: { week: "apr2020", callout: "bancroft" },
    text: [
      "During the pandemic, ridership sharply declined by 80% throughout the city. In stops near UC Berkeley, ridership declined by as much as 97%.",
    ],
  },
  {
    scene: { callout: "sanPablo" },
    text: ["San Pablo Avenue’s transit corridor remained at about 50% of pre-pandemic ridership."],
  },
  {
    scrub: true,
    scene: { week: "jul2021" },
    text: [
      "Even as BUSD schools partially reopened, ridership was largely stagnant until August 2021, when UC Berkeley returned to class.",
    ],
  },
  {
    scrub: true,
    scene: { week: "nov2021" },
    text: [
      "When Berkeley returned to school, the campus and major routes returned to 80% of pre-pandemic ridership. Minor routes still remained at around 30%.",
    ],
  },
  {
    scrub: true,
    scene: { week: "jul2022" },
    text: [
      "During school breaks and the summer, ridership on campus lines falls to pandemic levels. Lines outside the university in West Berkeley are unaffected by these breaks",
    ],
  },
  {
    scrub: true,
    scene: { week: "aug2023" },
    text: [
      "When UC Berkeley returned to campus in 2023, ridership finally recovered to pre-pandemic levels, and exceeded it in some Northside stations on Shattuck Avenue",
    ],
  },
  {
    scrub: true,
    scene: { week: "feb2026" },
    text: [
      "After UC Berkeley fully returned to pre-pandemic policies, bus ridership slowly recovered throughout the city.",
    ],
  },
  {
    scene: { level: "tract", routes: false },
    text: [
      "Six years on, the landscape of ridership in Berkeley looks very different. Ridership is up in central and downtown Berkeley and down in the edges of the city. In particular, ridership in the Berkeley Hills sits at 30% of pre-pandemic ridership.",
    ],
  },
  {
    scene: { mask: false, bounds: "eastBay", series: "system" },
    text: [
      "Berkeley fared similarly to the rest of the East Bay. Ridership in Berkeley is at 75% of pre-pandemic ridership, while Oakland is at 85%. South East Bay communities hang in the sixties.",
    ],
  },
  {
    scene: { callout: "tempo", trace: ["1T", "1"] },
    text: [
      "The Tempo bus rapid transit system, completed during the pandemic, led to an increase in local ridership along International Blvd.",
    ],
  },
  {
    scene: { callout: "transbay" },
    text: ["Transbay service has remained at around 40% of pre-pandemic levels."],
  },
  {
    // Deciles are of tract median household income (ACS 2024 5-year B19013);
    // the recovery figure is the two groups' riders in the story's week over
    // the same tracts' riders in the Feb 2020 baseline week.
    scene: { income: "high", callout: null },
    text: [
      `High-income areas saw the largest post-pandemic decline, at ${income.high_recovery_pct}% of pre-pandemic ridership.`,
    ],
  },
  {
    scene: { income: "low" },
    text: [
      `Low-income areas saw the best recovery, at ${income.low_recovery_pct}% of pre-pandemic ridership.`,
    ],
  },
];

export const MAP_TWO = [
  {
    scene: {
      view: "commute",
      level: "group",
      routes: false,
      mask: false,
      income: null,
      bounds: "campusFlows",
      week: "feb2026",
      focus: { region: "campus", mode: "from" },
    },
    text: [
      "Using Iterative Proportional Fitting (IPF), the origins and destinations of bus riders can be estimated. Current data doesn’t collect the trips that riders make, only that a certain number of people entered and exited the bus at a given stop.",
      "Like all estimation methods, the estimation is not perfect. When tested against BART, which does collect these trips, this method achieved an 80% accuracy rate. The model is unable to estimate basic elements of bus usage, like transfers between buses.",
    ],
  },
  {
    text: ["These are estimated riders that travel from UC Berkeley in the morning on weekdays."],
  },
  {
    scene: { focus: { region: "campus", mode: "to" } },
    text: [
      "These are estimated riders that travel to UC Berkeley in the morning on weekdays. We can infer that these are commuters.",
    ],
  },
  {
    scene: { marks: ["rockridge", "ucVillage"] },
    text: [
      "Commuters to UC Berkeley are estimated to come from Rockridge BART and UC Village more than other places.",
    ],
  },
  {
    scene: { level: "tract", commuteMeasure: "acHome", focus: null },
    text: [
      "This is where AC Transit commuters are estimated to live. Riders leave there in the morning and come back in the evening.",
    ],
  },
  {
    scene: { commuteMeasure: "compare" },
    text: [
      "This is AC Transit commuters as a percentage of all commuters, according to the US Census’s LODES survey. In some areas, over 5% of commuters commute via AC Transit.",
    ],
  },
  {
    scene: { bounds: "southEastBay" },
    text: [
      "AC Transit is used heavily in Oakland and Alameda, but in southern communities like Fremont, less than 0.5% of commuters use AC Transit.",
      "To see estimated trips, select “Commute pattern” and select one or more block groups, Census tracts, or stop groups.",
    ],
    link: { href: "/", label: "See the data →" },
  },
];

export const MAP_THREE = [
  {
    scene: {
      view: "speed",
      period: "day",
      level: "group",
      routes: true,
      mask: true,
      commuteMeasure: null,
      bounds: "berkeley",
      week: "feb2020",
      series: "speed",
    },
    text: [
      "Because we collect per-trip information, the timestamps of each stop can be derived. This is the speed, in miles per hour, that buses travel at on Berkeley streets. This figure is slower than the speeds cars would experience traveling through Berkeley because buses must stop off for passengers.",
    ],
  },
  {
    scrub: true,
    scene: { week: "dec2020" },
    text: [
      `Like ridership, traffic in Berkeley declines during the pandemic. The median bus speed in Berkeley rose from ${speeds.feb2020.day.p50} mph to ${speeds.dec2020.day.p50} mph, the slowest tenth of bus-km from ${speeds.feb2020.day.p10} to ${speeds.dec2020.day.p10}, and the fastest tenth from ${speeds.feb2020.day.p90} to ${speeds.dec2020.day.p90}.`,
    ],
  },
  {
    scrub: true,
    scene: { week: "sep2021" },
    text: [
      "Traffic followed the same pattern as ridership, only increasing when UC Berkeley students returned, and returning to normal when UC Berkeley fully ended pandemic measures in 2023.",
    ],
  },
  {
    scrub: true,
    scene: { week: "feb2026" },
    text: [
      `Bus speeds differ vastly throughout the day. Surface speeds at night and at rush hour (peak) differ by ${speeds.night_vs_peak_pct}%.`,
      "To see traffic speeds throughout the East Bay, select “Speed per corridor”.",
    ],
    link: { href: "/", label: "See the data →" },
  },
];

export const RECOVERY_SCENE = {
  view: "recovery",
  level: "bgroup",
  routes: false,
  mask: false,
  bounds: "eastBay",
  week: "feb2026",
  recThresh: RECOVERY_THRESHOLD,
};

// Fold each step's scene over the ones before it and turn names into indexes.
// Callouts, marks and traced lines point at what one passage is talking about,
// so they belong to that step alone and are not carried forward.
export function resolveScenes(steps, data, places) {
  let current = { focus: null, recThresh: RECOVERY_THRESHOLD, income: null, commuteMeasure: null };
  return steps.map((step) => {
    const { callout = null, marks = [], trace = null, ...inherited } = step.scene || {};
    current = { ...current, ...inherited };
    return resolveScene({ ...current, callout, marks, trace }, data, places);
  });
}

export function resolveScene(scene, data, places) {
  const index = data.meta.weeks.indexOf(WEEKS[scene.week]);
  return {
    ...scene,
    weekIndex: index >= 0 ? index : data.BASE,
    boundsLatLng: BOUNDS[scene.bounds],
    calloutPlace: scene.callout ? places[scene.callout] : null,
    markPlaces: (scene.marks || []).map((name) => places[name]),
  };
}
