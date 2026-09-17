// The story's copy and the map state each passage drives. A step's `scene`
// is layered over the step before it, so a step only states what changes --
// the same way the script reads ("switch to block groups", "zoom out").
//
// Weeks are the Monday a week starts on, as meta.weeks labels them. Each is a
// representative week in the month the script names, clear of holidays:
// 2020-02-03 is the app's own Feb 2020 baseline week.

export const WEEKS = {
  feb2020: "2020-02-03",
  apr2020: "2020-04-20",
  jul2021: "2021-07-19",
  nov2021: "2021-11-08",
  jul2022: "2022-07-11",
  aug2023: "2023-08-28",
  feb2026: "2026-02-09",
};

// [[south, west], [north, east]]
export const BOUNDS = {
  berkeley: [[37.848, -122.318], [37.9065, -122.235]],
  eastBay: [[37.718, -122.405], [37.905, -122.15]],
  campusFlows: [[37.8, -122.33], [37.9, -122.215]],
};

export const RECOVERY_THRESHOLD = 5; // meta.recovery_thresholds[5] = 100%

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
    scene: { level: "bgroup", routes: false },
    text: [
      "Six years on, the landscape of ridership in Berkeley looks very different. Ridership is up in central and downtown Berkeley and down in the edges of the city. In particular, ridership in the Berkeley Hills sits at 30% of pre-pandemic ridership.",
    ],
  },
  {
    // From here the city bars use the past year against the year before the
    // pandemic, the basis this passage quotes.
    scene: { mask: false, bounds: "eastBay", series: "system", compare: "year" },
    text: [
      "Over the past year, Berkeley’s bus stops saw 88% as many riders as in the year before the pandemic. That is ahead of Oakland at 84%, Richmond at 74% and Alameda at 64%, though Berkeley’s smaller neighbors Albany and Emeryville have come back further, to 100% and 93%. Much of Alameda, East Oakland, and Transbay service to San Francisco has never seen bus service return to 80% of February 2020’s level.",
    ],
  },
  {
    scene: { callout: "tempo", trace: ["1T", "1"] },
    text: [
      "The Tempo bus rapid transit line on International Boulevard, the 1T highlighted here, was completed during the pandemic and led to an increase in local ridership.",
    ],
  },
  {
    scene: { callout: "transbay" },
    text: [
      "AC Transit’s Transbay buses, which cross the Bay Bridge to the Salesforce Transit Center in San Francisco, carried 48% as many riders over the past year as in the year before the pandemic.",
      "The all-day lines have come back: the F carries slightly more riders than before, and the NL about three-quarters as many. Most weekday rush-hour lines, such as the J, P and V, carry a quarter to a third of their former riders, and nine lines have not run since March 2020.",
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
      bounds: "campusFlows",
      week: "feb2026",
      focus: { region: "campus", mode: "from" },
    },
    text: [
      "Bus counters record how many people get on and off at each stop, not where each person rides. Using the method above, this map estimates where riders who board at stops around the UC Berkeley campus on a weekday morning get off. Greener dots mean more estimated riders.",
      "In the interactive app, the same map is the “Inferred from here” option: choose the Commute pattern view and click any stop or area.",
    ],
  },
  {
    scene: { focus: { region: "campus", mode: "to" } },
    text: [
      "Reversed, the map estimates where riders arriving at campus stops in the morning got on. In the app, this is “Inferred to here.”",
    ],
  },
  {
    scene: { marks: ["rockridge", "ucVillage"] },
    text: [
      "Commuters to UC Berkeley are estimated to come from Rockridge BART and UC Village more than other places.",
    ],
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
  let current = { focus: null, recThresh: RECOVERY_THRESHOLD };
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
