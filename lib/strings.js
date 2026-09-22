/* Every string the app puts on screen, in one place.

   Edit the text here; the components read it through `t()` and `<T>` in
   ./i18n.js. Nothing else in the app should contain display copy, so a copy
   pass or a translation is a pass over this file alone.

   Two conventions inside a string:

     <0>...</0>  inline markup -- a link, a bold run, a coloured term. The
                 number picks the component the caller passed in `c`, so the
                 sentence stays whole and the markup can move with the words.
     {name}      a value the caller passes in `vars`.

   Both are documented per-string below where they appear. Keys are grouped by
   where they show up, and within a group they run in reading order rather
   than alphabetically, so a key's neighbours are what the reader sees next.

   `npm run check:strings` verifies that every key here is referenced and that
   no component still holds a hard-coded string. */

export const strings = {
  /* ------------------------------------------------------------------ */
  /* Story: the scrollytelling article at /story                         */
  /* ------------------------------------------------------------------ */
  story: {
    kicker: "AC Transit, 2019–2026",
    title: "See how AC Transit ridership recovered from the pandemic",
    byline: "John Schultz",
    lede:
      "While AC Transit ridership has increased from the pandemic, the recovery has been uneven. "
      + "Some places have fully reached pre-pandemic levels of ridership while some have still yet "
      + "to reach half of pre-pandemic ridership.",
    // {message} is the underlying fetch error.
    error: "The ridership data could not be loaded: {message}",
    scrollCue: "Scroll ↓",

    // Accessible names for the three sticky maps.
    mapOneLabel:
      "Map of AC Transit ridership in Berkeley and the East Bay compared with February 2020",
    mapTwoLabel: "Map of inferred morning bus trips to UC Berkeley",
    mapThreeLabel: "Map of observed AC Transit bus speeds on Berkeley streets",

    // Prose between the maps. <0> is a link.
    visitApp: "To see this data, visit the <0>interactive app</0>.",
    headingWhereDo: "Where do people go on AC Transit?",
    headingTraffic: "Traffic",
    methodologyNote:
      "How every figure here is made — the counter correction, the weekly blend that carries it, "
      + "and where the result is known to be wrong — is set out on the <0>methodology page</0>.",
    seeData: "See the data →",
    seeMethodology: "See our methodology →",

    // First map: the pandemic and the recovery.
    one: {
      records:
        "Through a public records request, The Daily Californian was able to obtain a trip-level "
        + "accounting of AC Transit’s ridership from January 2019 through May 2026. Ridership is "
        + "counted through automatic people counters, sensors on AC Transit buses that detect when "
        + "people leave and enter.",
      simulated:
        "However, especially pre-pandemic, many buses did not have these counters. The Daily "
        + "Californian simulated rides using statistical methods based on route-level total "
        + "ridership estimates from AC Transit. Estimated rides make up about 40% of rides in 2019, "
        + "but decline to under 8% of rides after 2021. For new routes created after the Realign "
        + "changes in 2025, 100% of rides are estimated.",
      berkeley2020:
        "This is the city of Berkeley’s AC Transit ridership in February 2020. Each dot represents "
        + "a stop, and each line is one or more AC Transit routes. The size of the dots represent "
        + "the number of people who boarded or left a bus.",
      pandemic:
        "During the pandemic, ridership sharply declined by almost 80% throughout the city, falling "
        + "as much as 88% below pre-pandemic levels. In stops near UC Berkeley, ridership declined "
        + "by as much as 97%.",
      sanPablo:
        "San Pablo Avenue’s transit corridor remained at about 50% of pre-pandemic ridership.",
      stagnant:
        "Even as BUSD schools partially reopened, ridership was largely stagnant until August 2021, "
        + "when UC Berkeley returned to class.",
      returned:
        "When Berkeley returned to school, the campus and major routes returned to 80% of "
        + "pre-pandemic ridership. Minor routes still remained at around 30%.",
      breaks:
        "During school breaks and the summer, ridership on campus lines falls to pandemic levels. "
        + "Lines outside the university in West Berkeley are unaffected by these breaks",
      recovered2023:
        "When UC Berkeley returned to campus in 2023, ridership finally recovered to pre-pandemic "
        + "levels, and exceeded it in some Northside stations on Shattuck Avenue",
      fullyReturned:
        "After UC Berkeley fully returned to pre-pandemic policies, bus ridership slowly recovered "
        + "throughout the city.",
      sixYearsOn:
        "Six years on, the landscape of ridership in Berkeley looks very different. Ridership is up "
        + "in central and downtown Berkeley and down in the edges of the city. In particular, "
        + "ridership in the Berkeley Hills sits at 30% of pre-pandemic ridership.",
      eastBay:
        "Berkeley fared similarly to the rest of the East Bay. Ridership in Berkeley is at 75% of "
        + "pre-pandemic ridership, while Oakland is at 85%. South East Bay communities hang in the "
        + "sixties.",
      tempo:
        "The Tempo bus rapid transit system, completed during the pandemic, led to an increase in "
        + "local ridership along International Blvd.",
      transbay: "Transbay service has remained at around 40% of pre-pandemic levels.",
      // {pct} comes from numbers.json, resolved by build_story_numbers.py.
      highIncome:
        "High-income areas saw the largest post-pandemic decline, at {pct}% of pre-pandemic "
        + "ridership.",
      lowIncome: "Low-income areas saw the best recovery, at {pct}% of pre-pandemic ridership.",
    },

    // Second map: inferred origins and destinations.
    two: {
      ipf:
        "Using Iterative Proportional Fitting (IPF), the origins and destinations of bus riders can "
        + "be estimated. Current data doesn’t collect the trips that riders make, only that a "
        + "certain number of people entered and exited the bus at a given stop.",
      ipfAccuracy:
        "Like all estimation methods, the estimation is not perfect. When tested against BART, "
        + "which does collect these trips, our model achieves 78% forecast accuracy on the flows "
        + "the app displays. The model is unable to estimate basic elements of "
        + "bus usage, like transfers between buses.",
      toCampus:
        "These are estimated riders that travel to UC Berkeley in the morning on weekdays. We can "
        + "infer that these are commuters.",
      marks:
        "Commuters to UC Berkeley are estimated to come from UC Village more "
        + "than other places.",
      acHome:
        "This is where AC Transit commuters are estimated to live. Riders leave there in the "
        + "morning and come back in the evening.",
      compare:
        "This is AC Transit commuters as a percentage of all commuters, according to the US "
        + "Census’s LODES survey. In some areas, over 5% of commuters commute via AC Transit.",
      southEastBay:
        "AC Transit is used heavily in Oakland and Alameda, but in southern communities like "
        + "Fremont, less than 0.5% of commuters use AC Transit.",
      southEastBayHint:
        "To see estimated trips, select “Commute pattern” and select one or more block groups, "
        + "Census tracts, or stop groups.",
    },

    // Third map: bus speeds.
    three: {
      speed:
        "Because we collect per-trip information, the timestamps of each stop can be derived. This "
        + "is the speed, in miles per hour, that buses travel at on Berkeley streets. This figure "
        + "is slower than the speeds cars would experience traveling through Berkeley because buses "
        + "must stop off for passengers.",
      pandemicTraffic:
        "During the pandemic, bus speeds weren\u2019t as affected as bus ridership was. Traffic "
        + "spots, like areas near the university, remained at low speeds, while arterial roads "
        + "eased up.",
      // {pct} is the night-versus-peak difference.
      timeOfDay:
        "Bus speeds differ vastly throughout the day. Surface speeds at night and at rush hour "
        + "(peak) differ by {pct}%.",
      timeOfDayHint: "To see traffic speeds throughout the East Bay, select “Speed per corridor”.",
    },
  },

  /* ------------------------------------------------------------------ */
  /* Shared: units, states and errors used across views                  */
  /* ------------------------------------------------------------------ */
  units: {
    // {n} is already rounded/formatted by the caller.
    minutes: "{n} min",
    hours: "{n} h",
    mph: "{n} mph",
    noService: "no service",
    // Bare unit words, used where the legend composes its own label.
    minutesShort: "min",
    mphShort: "mph",
    noValue: "-",
  },

  errors: {
    // {name} is the pack file, {status} the HTTP status.
    loadFailed: "Could not load {name} ({status})",
  },

  /* ------------------------------------------------------------------ */
  /* Speed-vs-ridership scatter (explorer side panel)                    */
  /* ------------------------------------------------------------------ */
  speedChart: {
    loading: "Loading bus speeds\u2026",
    empty: "No bus speed data inside this box.",
    legend: "Each dot is a month, joined in time order",
    ariaLabel:
      "Monthly average bus speed against riders per week for the selected area, joined in time "
      + "order",
    axisSpeed: "Average bus speed, mph",
    axisRiders: "Riders per week",
    // <0> wraps the figure. {mph} / {riders} are preformatted.
    tooltipSpeed: "<0>{mph} mph</0> average bus speed",
    tooltipRiders: "<0>{riders}</0> riders a week",
    tooltipStreetChange: "Street map updated this month",
  },

  /* ------------------------------------------------------------------ */
  /* Dates and number formats                                            */
  /* ------------------------------------------------------------------ */
  dates: {
    // Indexed by month - 1. Kept short because they label chart axes.
    monthsShort: ["Jan.", "Feb.", "March", "April", "May", "June",
      "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."],
    monthsFull: ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"],
    monthYear: "{month} {year}",
    // A full date, e.g. "Feb. 3, 2020".
    monthDayYear: "{month} {day}, {year}",
  },

  numbers: {
    // A percentage. {n} is already rounded by the caller.
    percentFlat: "{n}%",
    // Placeholder where a figure does not exist.
    missing: "\u2013",
  },


  /* ------------------------------------------------------------------ */
  /* Story map: the sticky map's legend, callouts and tooltips           */
  /* ------------------------------------------------------------------ */
  storyMap: {
    loading: "Loading ridership data…",

    // Commute view
    commuteKicker: "Inferred morning trips",
    // {month} is a full month name, e.g. "February".
    commuteTitle: "{month} {year}",
    // {direction} is one of the two words below.
    commuteNote: "Average weekday, 5–11 a.m., {direction} UC Berkeley.",
    commuteLeaving: "leaving",
    commuteArriving: "arriving at",
    commuteRampLow: "Fewer",
    commuteRampHigh: "More inferred riders",
    commuteMember: "UC Berkeley stop groups",

    // Recovery view
    recoveryKicker: "Recovery time",
    recoveryTitle: "First month back to {pct}%",
    recoveryNote:
      "When each block group first held {pct}% of its Feb. 2020 ridership for three straight "
      + "months.",
    recoveryNever: "Not yet",
    recoverySmall: "Too little 2020 service to judge",

    weekOf: "Week of",

    // Speed view. <0> wraps each figure.
    speedNote: "Berkeley bus speed: <0>{mph} mph</0> in the middle",
    speedRidership: " · ridership <0>{pct}%</0> of Feb. 2020",
    speedSpread:
      "Slowest tenth of bus-km under <0>{low}</0>, fastest tenth over <1>{high}</1> mph.",
    // Key for the two-line chart above the note.
    speedChartKey: "Solid: bus speed. Dashed: ridership. Both against Feb. 2020.",
    speedRamp: ["6 mph", "12 mph", "20 mph"],

    // Ridership view
    seriesSystem: "Systemwide",
    seriesBerkeley: "Berkeley",
    // <0> wraps the percentage.
    ridershipNote: "{scope} ridership: <0>{pct}</0> of Feb. 2020",
    ridershipRamp: ["0%", "100%", "200%"],

    dotScaleAria: "Dot size scale",
    dotScaleUnit: "riders per week",

    // City comparison
    citiesTitleYear: "",
    citiesTitleWeek: "",

    // Map callouts and hover tooltips.
    calloutPrePandemic: "{pct}% of pre-pandemic riders",
    calloutOfBaseline: "{pct}% of Feb. 2020",
    // A ringed tract's AC Transit commuters over all its commuters. {pct} is
    // already formatted, e.g. "5.2" or "0.43".
    calloutOfTraffic: "{pct}% of total traffic",
    tipCommuteMember: "UC Berkeley stop group",
    tipInferredRiders: "{n} inferred riders / weekday",
    tipRidersThisWeek: "{n} riders this week",
    tipNoBaseline: "No Feb. 2020 service",
    tipBlockGroup: "Block group {id}",
    tipRecoveredIn: "Back to Feb. 2020 in {month}",
    tipNotYet: "Not yet back to Feb. 2020",
    tipTooLittle: "Too little Feb. 2020 service to judge",

    calloutOfTraffic: "{pct}% of total traffic",
  },

  /* ------------------------------------------------------------------ */
  /* Methodology page (/methodology)                                     */
  /* ------------------------------------------------------------------ */
  /* Sentences here carry two kinds of placeholder. <0>, <1>... are the
     coloured terms (<C>) and the inline formulae (<M>) -- the formula's LaTeX
     stays in the component, because it is code, not copy. {n}-style values are
     figures resolved from the pipeline artifacts. */
  methodology: {
    title: "Methodology",
    kicker: "AC Transit ridership · 2019–2026",
    linkExplore: "Explore the map",
    linkStory: "Read the story",
    linkExploreArrow: "Explore the map →",

    intro1:
      "At the core of this visualization is drop-offs and boardings per stop. This is collected by "
      + "physical sensors, known as APCs, on buses. However, this information isn’t reported "
      + "all time in the per-stop dataset. Importantly, the data loss is present in entire bus "
      + "trips, not just at specific stops.",
    // <0> is the publication name, set in italics.
    intro2:
      "To address this, <0>The Daily Californian</0> used an existing public records request that "
      + "collected ridership per route, per month. This ridership is derived from AC "
      + "Transit’s own estimation methods, and is what is reported by the agency itself.",
    intro3:
      "The gap between the APC dataset and the per-route-month dataset is significant. 27% of "
      + "boardings do not exist in the APC dataset. Most of the missing data is before the "
      + "pandemic.",
    introTurn: "We need to bridge this gap. The data loss is not uniform.",

    // The scrollytelling passages, in order.
    step: {
      intro:
        "This is an example of a bus route. Buses pick up and drop off people from each station. "
        + "Some bus trips don’t have sensor information. We can find trips that aren’t "
        + "observed through schedules published by AC Transit, known as GTFS feeds. These public "
        + "schedules are how applications like Google Maps calculate bus arrival times.",
      // <0> is the coloured term "blue bars".
      observed:
        "The <0>blue bars</0> represent observed data from the trip-level public records request. "
        + "However, this is not a complete picture of ridership.",
      // <0> coloured term, <1> the inline formula.
      coverage:
        "First, we get a <0>coverage factor</0> of the line <1/>. This is the percent of trips "
        + "that are covered by the route. This assumes that missing trips are similar to other "
        + "trips.",
      // <0> is the formula. {present}/{total} trips, {c} the resulting factor.
      coverageAside: "Here {present} of {total} trips reported, so <0/> is {c}.",
      // <0> is the formula.
      coverageApplied:
        "Each stop’s ridership is divided by <0/>, leading to increased ridership. This keeps "
        + "the distribution of the line.",
      // <0> coloured term, <1> <2> formulae.
      calibration:
        "As a <0>calibration factor</0>, we use the existing public records request, which has an "
        + "accurate count for total ridership <1/> over the entire route. We collect <2/>, the "
        + "factor by which ridership differs from AC Transit’s published ridership. We then "
        + "multiply every stop by this factor.",
      sparse:
        "Some routes have significant data loss, like the routes introduced in 2025 under the "
        + "Realign program. For this profound data loss, we find other routes that cover the same "
        + "stops. As an example, the 27 and the 51B cover the same stops near UC Berkeley.",
      donors:
        "Using the existing public records request and the GTFS schedule for the number of trips "
        + "and the total ridership, the distribution of ridership over the stop is estimated.",
      // <0> is the coloured term.
      donorFill: "The <0>estimated distribution</0>, in purple.",
      weeks:
        "Our data is presented by week, not by month. Some weeks in a month may have 10 times the "
        + "sensors reporting with the same service. Because there is no calibration available, we "
        + "must use our public schedules.",
      // <0> is the formula for w.
      weightIntro: "We collect a percentage <0/> of trips that do not meet requirements for inclusion.",
      exclude1: "Under 40% of trips reported",
      exclude2: "Under 70% of average reported trips for that route",
      exclude3: "Under 70% of days have a single trip",
      // <0> is the coloured term.
      weightApplied:
        "Rides in this category are weighted out and replaced with a distribution based on the "
        + "level of service in the <0>published schedules</0>.",
      // <0> <1> <2> are all the formula for w.
      mix:
        "<0/> is the % imputed figure shown on the website. Ridership derived from <1/> is still "
        + "from monthly data, and <2/> is derived from the quality of the monthly data.",
      // <0> the formula, <1> and <2> coloured terms.
      mixAside:
        "Drawn at <0/>. Neither bar is invented: the <1>imputed share</1> is the same month as the "
        + "<2>measured</2> one, held at the level the schedule expects instead of at the level the "
        + "counters happened to see.",
      blend: "This is what is shown on the website.",
    },

    // Legend under the sticky figure.
    legendObserved: "observed",
    legendCoverage: "coverage factor",
    legendCalibration: "calibration",
    legendDonor: "borrowed shape",
    legendSchedule: "from the schedule",

    closeTurn: "Most routes are unaffected by this imputation, and are only calibrated.",
    colCase: "Case",
    colRouteMonths: "Route-months (e.g. Route 51B, Jan 2020)",
    colPercent: "%",
    case0: "No data estimated (w=0)",
    case1: "Some data estimated (w>0)",
    case2: "All data estimated (w=1)",
    case3: "No sensors at all",

    histogramAria:
      "Distribution of the imputed share across route-months, with 2019 highlighted",
    // {t} is 0, 0.5 or 1.
    histogramTick: "w = {t}",
    // <0> and <1> are coloured terms; {all} and {y2019} are counts.
    histogramCaption:
      "Route-months by imputed share, all {all} of them in <0>blue</0> and the {y2019} from 2019 "
      + "in <1>gold</1>. The distribution is bimodal: a route-month is usually either wholly "
      + "measured or wholly estimated, and 2019 supplies most of the second group.",

    footer:
      "Code is MIT; data is CC BY 4.0. The counter records originate with the Alameda–Contra "
      + "Costa Transit District. This project is not affiliated with or endorsed by AC Transit.",
  },

  /* ------------------------------------------------------------------ */
  /* Methodology figures (the sticky diagram and the standalone panels)  */
  /* ------------------------------------------------------------------ */
  /* `tex*` keys are LaTeX. They are here because the reader reads them as
     sentences, so a copy pass should reach them -- but the markup around the
     words is real LaTeX and has to survive an edit. Change only the prose
     inside \text{...}; pure formulae live in the component, not here. */
  figure: {
    routeAria:
      "A seven-stop bus route, its ridership corrected for the trips its counters missed",
    weekAria:
      "One week's ridership as two bars, measured and from the schedule, each holding the same "
      + "monthly route",
    monthAria:
      "The month's ridership at every stop, and under it the same stops week by week, with the "
      + "share the schedule carries in gold",
    braceReported: "reported",
    braceMissing: "missing",
    routeA: "Route A",
    routeB: "Route B",
    theMonth: "the month",
    // {n} is a week number; {pct} a percentage.
    weekN: "week {n}",
    pctOfMonth: "{pct}% of the month",
    pctShift: "{from}% → {to}%",
    pctOfWeek: "{pct}% of the week",
    // A week's share of the month before and after the blend, under the heading.
    pctShift: "{from}% → {to}%",
    pctOfMonthHeading: "% of month",
    texOfTrips: String.raw`\tfrac{12}{20}\ \text{of the trips}`,
    texTooLittle: String.raw`\tfrac{1}{20}\ \text{— too little to scale}`,
    texBorrowShape: String.raw`\text{borrow the shape}`,
    texSameMonth:
      String.raw`\text{the same month in both bars: only the level it is held at differs}`,
    texGoldIsMonth:
      String.raw`\text{at } w = 0.3\text{, the gold in every week is the month above it}`,
    pctOfMonthHeading: "% ofm month",
  },

  /* ------------------------------------------------------------------ */
  /* Methodology diagrams (pipeline, capture grid, blend, O-D, corridor) */
  /* ------------------------------------------------------------------ */
  diagrams: {
    pipelineAria:
      "Flow diagram of the ridership pipeline from raw counter events to the packed bundle",
    pipelineCaption:
      "The two paths are independent estimates of the same ridership, so they are selected between "
      + "and blended, never added. The counters decide distribution; the control decides level.",
    stepRaw: "Raw APC events",
    stepRawSub: "5.9 GB · 89 months",
    stepCapture: "Capture correction",
    stepCaptureSub: "÷ ĉ per route-month",
    stepCalibration: "Calibration",
    stepCalibrationSub: "level ← PRA control",
    stepPra: "PRA control",
    stepPraSub: "+ GTFS calendars",
    stepReconstruction: "Reconstruction",
    stepReconstructionSub: "no counters at all",
    stepBlend: "Weekly blend",
    stepBlendSub: "shape ← both",
    stepBundle: "Packed bundle",
    stepBundleSub: "u16 · u8 arrays",
    laneMeasured: "MEASURED",
    laneModelled: "MODELLED",

    captureAria:
      "Grid of scheduled trip slots by service day, with the slots whose counter reported marked",
    captureCaption:
      "Each square is one scheduled trip on one day. Filled where the counter reported at least one "
      + "boarding for the whole trip, hollow where it reported nothing — which means a dead "
      + "counter, not an empty bus. Whole rows and columns go dark together because a counter fails "
      + "for a bus-day at a time.",
    captureScope: "one route · one direction · one month · weekdays",
    captureDays: "service days →",
    captureSlots: "trip slots",
    captureReporting: "reporting",
    captureOf: "of",
    captureFraction: "capture fraction",
    // {n} is the raw boarding count at the example stop.
    captureStop: "a stop counting {n} boardings",

    blendAria: "Weekly boardings before and after the blend, against counter uptime",
    // <0> and <1> are the two colour swatches, so they sit with the word they key.
    blendCaption:
      "Weekly boardings, millions, spring 2019. Left: the month-grain correction read at week grain "
      + "— the dotted line is the share of trips whose counter reported, and the bars follow "
      + "it, not the riders. Scheduled service across these weeks was flat at about 46,600 trips. "
      + "Right: the same weeks after the blend, split <0/> observed and <1/> imputed. The two "
      + "panels sum to the same month totals. Schematic apart from the two labelled weeks, which "
      + "are measured.",
    blendUptime: "uptime",
    blendUpHigh: "39.6% up",
    blendUpLow: "5.3% up",
    blendPanelBefore: "Reported — tracks the counters",
    blendPanelAfter: "After the blend — tracks the service",
    blendMonthTotal: "month total",
    blendMonthTotalSame: "month total — identical",

    odAria: "Boardings and drop-offs along a route, and the fitted origin-destination matrix",
    odCaption:
      "Left: one route-direction's average morning profile — boardings above the line, "
      + "drop-offs below. Right: the flow matrix fitted to it. Only the upper triangle can be "
      + "filled, because a rider cannot get off before they get on; the row sums are the boardings "
      + "and the column sums the drop-offs. The matrix shown was produced by running the fit in "
      + "§2.4 on the profile beside it.",
    odCounters: "What the counters see",
    odOn: "on",
    odOff: "off",
    odStops: "stops in the order the buses reach them",
    odFit: "fit",
    odInferred: "What is inferred",
    odFrom: "from",
    odTo: "to",

    corridorAria:
      "Three separate route shapes on one street, and the single matched corridor they become",
    corridorCaption:
      "Left: GTFS gives every route its own polyline, so three routes down one street are three "
      + "near-parallel lines and “same road” is not answerable from the shapes. Right: "
      + "each pattern is map-matched onto the OpenStreetMap network, so a stretch of road becomes "
      + "an edge id and routes sharing it merge by set union. The corridor is cut wherever its "
      + "contributing set changes, which puts a node at every stop group and every junction "
      + "— and makes the onboard load constant between nodes.",
    corridorThree: "Three shapes",
    corridorThreeSub: "3 routes · 3 polylines · no shared identity",
    corridorHmm: "HMM",
    corridorOne: "One corridor",
    corridorJoin: "routes join",
    corridorLeave: "one leaves",
    corridorWidth: "width = riders on board · node = where it changes",
  },

  /* ------------------------------------------------------------------ */
  /* Explorer: the main map at /                                         */
  /* ------------------------------------------------------------------ */
  explorer: {
    title: "AC Transit Ridership",
    subtitle: "Weekly boardings and drop-offs, 2019–2026",

    // Stat rows in the detail sidebar.
    rowBoardings: "Boardings",
    rowDropOffs: "Drop-offs",
    rowRidership: "Ridership",
    rowImputed: "Imputed",
    rowVsBaseline: "vs Feb 2020",
    rowAcShare: "AC Transit ÷ all commuters",
    rowAllRiders: "All riders / weekday",
    rowRecovered: "Recovered",
    rowOnboardLoad: "Onboard load / wk",
    // {week} is the week's start date.
    rowBoardingsWeekOf: "Boardings / wk, week of {week}",
    rowShareOfStreet: "Share of street boardings",
    rowSectionsPerRider: "Sections per rider",

    // {label} is the commute snapshot, e.g. "Feb 2024".
    commutersHeading: "Commuters · {label}",
    headingWeekly: "Weekly ridership 2019-2026",
    headingRecovery: "Recovery to Feb 2020",
    // {pct} is a threshold like 50.
    recoveryThreshold: "{pct}% of Feb 2020",
    recoveryTooSmall: "baseline too small",
    recoveryNotYet: "not yet",
    // {era} is the GTFS signup, e.g. "Aug2025".
    headingRoutes: "Routes ({era} signup)",
    eraCurrent: "current",
    noRouteGeometry: "No route geometry in this era.",
    // {n} stops in the clicked group.
    headingStopsOne: "{n} stop in group",
    headingStopsMany: "{n} stops in group",

    // Route detail
    modeOwn: "This route",
    modeStreet: "Streets it uses",
    headingRouteWeeklyOwn: "Weekly boardings on this route, 2019-2026",
    headingRouteWeeklyStreet: "Weekly boardings on the lines using its streets, 2019-2026",
    // <0> is a bold run.
    scheduleWarning:
      "None of this line’s buses had a working passenger counter, so the figures above are "
      + "estimated from its schedule and from how riders used the stops of the lines it replaced. "
      + "How full the bus is along the route is <0>not reliable</0> here; the weekly boardings are "
      + "the better guide.",
    hintRouteOwn:
      "Boardings per week on this route, each rider counted once per trip. The same rider changing "
      + "buses counts again.",
    hintRouteStreet:
      "Boardings per week on every line that uses the same streets as this route, this route "
      + "included. It shows how busy the streets are, not this line alone.",

    // Level-of-service table
    headingService: "Level of service · {label}",
    colHeadway: "Headway",
    colTrips: "Trips",
    colSpeed: "Speed",
    hintService:
      "From the bus counters. Trips are the distinct scheduled starts seen that month, both "
      + "directions (weekend: Saturday and Sunday averaged); headway is the hours the line runs in "
      + "the period over its trips per direction. Speed includes dwell. Hover a row for its hours.",

    // {id} is the route name.
    routeTitle: "Route {id}",
    closeDetails: "Close details",
    closeChart: "Close chart",
    clearFocus: "Clear focus",
    closeMark: "X",

    // About modal
    aboutTitle: "About this data",
    about1:
      "These maps show AC Transit bus ridership from January 2019 to May 2026. The counts come "
      + "from automatic passenger counters: sensors at bus doors that record how many people get "
      + "on and off at each stop.",
    about2:
      "Not every bus had a working counter, especially before 2021. Where a route’s counters "
      + "were missing or unreliable for a month, its riders were estimated from AC Transit’s "
      + "route totals, and all counts were adjusted to match the ridership AC Transit reports to "
      + "the federal National Transit Database.",
    // <0> is the bold total, <1> the gold estimated part.
    about3:
      "Numbers on the map read as a total followed by the estimated part in gold: <0>1,200</0> "
      + "<1>(300)</1> means 1,200 riders, 300 of them estimated.",
    about4:
      "Trips between places, commute patterns, speeds and bus frequency are all calculated from "
      + "these counts. They are estimates, not records of individual trips.",
    aboutStory: "Read the story →",
    aboutMethodology: "Methodology →",
    aboutExplore: "Explore the map",

    // View picker
    headingView: "View",
    viewTotal: "Total ridership",
    viewRel: "Relative to Feb 2020",
    viewRecovery: "Recovery time",
    viewCommute: "Commute pattern",
    viewSpeed: "Speed per corridor",
    viewLos: "Level of service",
    viewImp: "Percent imputed",
    descTotal:
      "How many times people got on or off an AC Transit bus at each place during the selected "
      + "week. Larger, darker circles and areas mean more riders.",
    descRel:
      "Riders at each place in the selected week as a share of the week of Feb. 3, 2020. 100% "
      + "means the same number of boardings and drop-offs as that week; green is above it and red "
      + "below.",
    descRecovery:
      "The first month in which each place's ridership held the chosen share of its February 2020 "
      + "level for three months in a row. It does not change with the time bar.",
    descCommute:
      "Where commuters live. AC Transit commuters is an estimate from the bus counters: a morning "
      + "trip counts only when the same trip is made in reverse that evening. All commuters is the "
      + "Census Bureau's count of employed residents. Compare divides the first by the second for "
      + "each Census tract.",
    descSpeed:
      "The average speed of buses on each street, in miles per hour, from the times their doors "
      + "opened at one stop and the next. It includes time spent at stops and traffic lights.",
    descLos:
      "How often a bus comes on each street, counting every route that uses it: the average number "
      + "of minutes between buses in one direction during the chosen time of day.",
    descImp:
      "The share of each place's count that is estimated rather than measured. Estimates fill in "
      + "for buses without working passenger counters, and for new routes after the August 2025 "
      + "service changes.",

    reachedLabel: "Reached",
    ofBaseline: "of Feb 2020",
    hintServicePeriods: "Hover a street for every time of day, or open a route for its own table.",

    focusTo: "Inferred to here",
    focusFrom: "Inferred from here",
    hintFocusFlows:
      "Green = stronger flow. Grey: nothing above the floor. Click another place to re-focus.",
    hintFocusLoading: "Loading inferred flows...",
    // {label} is the selected measure.
    hintCommuteSingle: "{label} living in each place.",
    hintCommuteCompare:
      "AC Transit commuters divided by all commuters living in each Census tract.",
    hintLodesAbsent:
      " All commuters needs lodes.json, which this data bundle does not include.",
    // {label} is the snapshot, e.g. "Feb 2024".
    hintCommutePeriod:
      "{label}, average weekday. Click a place to see estimated morning trips to or from it.",

    // Level picker
    headingLevel: "Level",
    levelGroup: "Stop groups",
    levelBgroup: "Block groups",
    levelTract: "Census tracts",
    levelCity: "Cities",
    levelNone: "Corridors",
    hintTractOnly: "All commuters is published only for Census tracts.",

    headingLegend: "Legend",
    headingSelection: "Selection",
    hintSelection:
      "Click a stop, an area or a street to see its numbers. To chart several places together, "
      + "hold Shift and drag a box across the map.",
    clearSelection: "Clear selection",

    ctxRoutes: "Routes on this corridor",
    ctxInferredTo: "Inferred to here (arrivals)",
    ctxInferredFrom: "Inferred from here (departures)",
    ctxWeeklyChart: "Weekly chart",

    searchPlaceholder: "Find a route...",
    searchAria: "Find a route",
    tabSpeed: "Riders and bus speed",
    tabRiders: "Observed vs. estimated",
    // Tabs in a place's detail panel.
    tabOverTime: "Ridership over time",
    tabWeekdayPattern: "Weekday pattern",

    playLabel: "Play",
    pauseLabel: "Pause",
    playMark: ">",
    pauseMark: "||",
    weekOf: "Week of {week}",
    systemRidership: "System ridership",
    loadingApp: "Loading ridership data...",
    loadingView: "Loading data for this view...",
    errorTitle: "Unable to load the visualization",

    // Corridor hover
    rowBoardingsWk: "Boardings / wk",
    rowDropOffsWk: "Drop-offs / wk",
    rowNetAtGroup: "Net at this stop group",
    tipNoPeak: "no peak",
    tipLine: "Line",
    tipClickToPick: "Click to pick a line",
    amArrive: "arrive",
    amDepart: "depart",
    // {sign} is "+" or empty, {pct} the value, {dir} one of the two words above.
    balanceValue: "{sign}{pct}% {dir}",
    peakRatio: "{n}×",

    // Selection chart / speed tab
    selectionCount: "{n} stop group{s} selected",
    exportPng: "Export PNG",
    speedStatLabel: "Average bus speed, 2019–2026:",
    speedNoData: "no bus data here",
    speedLoading: "loading…",
    hintSpeedScatter:
      "Each dot is a month: average bus speed on every street inside the box (from the bus "
      + "counters, including time at stops and lights) against average weekly boardings and "
      + "drop-offs at the selected stops. Ringed dots are the two months the street map was "
      + "updated (January 2022, April 2025); part of any jump there comes from that change, not "
      + "from traffic.",

    // Map hover tooltips
    tipMedianIncome: "Median income",
    tipMedianIncomeBg: "Median income (block group)",
    tipNotPublished: "not published",
    tipIncomeTopCoded: "$250,000+",
    tipStopsOne: "{n} stop",
    tipStopsMany: "{n} stops",
    // {year} is the LODES vintage.
    tipLodesLabel: "{label} ({year})",
    tipLinesMore: "+{n} more",
    tipLines: "{n} lines",

    // Weekday profile panel
    headingWeekdayProfile: "Weekday profile · {label}",
    // {base} is the comparison period label.
    hintWeekdayProfile:
      "Boardings above the line, drop-offs below, average weekday. Grey outline: {base}.",
    rowRidersWeekday: "Riders / weekday",
    rowAmBalance: "AM balance",
    rowPmBalance: "PM balance",
    rowPeakStrength: "Peak strength",

    // Legend
    loadingLevel: "Loading this level...",
    legendStreetsOnly:
      "Streets only. Wider, darker lines carry more riders; hover a street for the routes on it.",
    // {measure} {year} {table} name the ACS source.
    hintIncome:
      "{measure}, ACS {year} 5-year ({table}). Fixed to the tract range, so a colour means the "
      + "same income at either level. Grey: not published. Corridors keep showing onboard load.",
    hintIncomeStatic:
      "One figure for the whole period: ACS does not track week to week, so the time bar does not "
      + "move it.",
    // {lo}/{hi} are dollar amounts already formatted.
    legendIncomeLow: "${lo}k",
    legendIncomeHigh: "${hi}k+",
    commuteUnavailable: "Commute pack unavailable — run scripts/build_commute_pack.py.",
    legendNoFlow: "no inferred flow",
    // {n} riders per weekday.
    legendRidersWkday: "{n} riders / wkday",
    // <0> is the focused place's name. {direction} and {kind} are the words below.
    hintCommuteFocus:
      "Morning (5-11am) inferred riders {direction} <0>{label}</0>, {period} snapshot. Dot size and "
      + "colour both scale with the inferred flow; outlined dots are the selected {kind}. Click "
      + "another place to re-focus; X in the sidebar clears.",
    focusLeaving: "leaving",
    focusArriving: "arriving at",
    focusRegion: "region",
    focusPlace: "place",
    // <0> is a <code> element naming the missing file. {label} is the measure.
    hintLodesMissing:
      "{label} needs <0>lodes.json</0> at tract level, which this bundle does not carry — run "
      + "scripts/build_lodes_pack.py and sync the pack.",
    hintLodesAll: "Employed residents living in each tract, Census LODES {year}.",
    hintCommuteRoundTrip:
      "Estimated AC Transit commuters living in each place on an average weekday: morning riders "
      + "whose trip is repeated in reverse that evening. Grey: under {min} riders per weekday.",
    hintCommuteDepartures:
      "Morning departures on an average weekday. Grey: under {min} riders per weekday.",
    legendOrLess: "{pct} or less",
    legendPlus: "{pct}+",
    // {a} and {b} are the two measure names, {pct} the median share.
    hintCompare:
      "{a} ÷ {b} living in each tract (LODES {year}). White is the median tract, {pct}; red "
      + "tracts have a higher share, blue a lower one. Grey: under {min} riders per weekday, or no "
      + "workers to divide by.",
    legendPerWeek: "{n}+ / wk",
    hintTotal: "Boardings plus drop-offs per week. Larger circles mean more riders.",
    legendImputedHigh: "100% imputed",
    hintImputed: "Share of ridership from route-months failing the reliability gate.",
    legendNeverSustained: "never sustained by 2026-05",
    legendBaselineTooSmall: "baseline too small to assess",
    hintRecovery: "First month holding {pct}% of Feb 2020 for three straight months.",
    // {week} is the baseline week label.
    hintRelative:
      "Grey is approximately 100%: back to the week of {week}. Red below baseline, green above.",

    // Commute measures
    cellAcHome: "AC Transit commuters",
    cellAllHome: "All commuters",
    modeCompare: "Compare",

    // Service legend
    noSnapshot: "No counter snapshot covers this week's corridors.",
    // {limit}/{lower} are numbers, {unit} is "min" or "mph".
    legendUnder: "under {limit} {unit}",
    legendOver: "{lower}+ {unit}",
    legendBetween: "{lower}-{limit} {unit}",
    legendNoTrips: "no trips in this period",
    // {shown} is the snapshot on screen, {target} the one still loading.
    hintShowingWhileLoading: "Showing {shown} while {target} loads.",
    daysWeekend: "Sat & Sun",
    daysWeekday: "Mon-Fri",
    // {period} {snapshot} {days} {hours} {era} describe the service window.
    hintServiceWindow:
      "{period}, {snapshot}: {days} {hours}. The hours come from the {era} GTFS schedule: where "
      + "its buses-in-service profile steps up and down. ",
    hintHeadwayMethod:
      "Corridor headway counts every line on the street: the hours it runs over its trips per "
      + "direction, averaged over the directions served.",
    hintSpeedMethod:
      "Average speed between stop groups from door-open times, dwell included, weighted by trips.",
    hintFromCounters: " From the bus counters; width encodes onboard load.",
  },
};
