"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SelectionChart } from "../Charts";
import { ensureData, everything, loadVisualizationData, selectionSeries } from "../ridership-data";
import StoryMap from "./StoryMap";
import { prepareStory, resolvePlaces } from "./prepare";
import { BOUNDS, MAP_ONE, MAP_TWO, RECOVERY_SCENE, resolveScene, resolveScenes } from "./steps";

// Where in the viewport a passage has to reach before the map switches to it.
const TRIGGER = 0.62;
// Where the top of a scrub step's empty stretch has to reach to start moving
// the week.
const SCRUB_START = 0.1;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// A sticky map with passages scrolling over it. The passage that has crossed
// the trigger line owns the map; on a `scrub` step the week is instead
// interpolated across the gap before its passage, so scrolling through that
// empty stretch drives the time bar the way dragging it in the app would.
function ScrollySection({ data, places, steps, label, first = "85vh" }) {
  const apiRef = useRef(null);
  const stepRefs = useRef([]);
  const cardRefs = useRef([]);
  const sectionRef = useRef(null);
  const scenes = useMemo(
    () => (data && places ? resolveScenes(steps, data, places) : null),
    [data, places, steps],
  );

  const update = useCallback(() => {
    const api = apiRef.current;
    const section = sectionRef.current;
    if (!api || !scenes || !section) return;
    const viewport = window.innerHeight;
    const box = section.getBoundingClientRect();
    if (box.bottom < -viewport || box.top > viewport * 2) return;
    const trigger = viewport * TRIGGER;
    const cards = cardRefs.current.map((card) => card.getBoundingClientRect());
    let active = 0;
    cards.forEach((rect, index) => {
      if (rect.top < trigger) active = index;
    });
    let week = scenes[active].weekIndex;
    const next = active + 1;
    if (next < steps.length && steps[next].scrub) {
      // The scrub waits until the passage before it has all but left the
      // screen, so what that passage describes stays on the map while it is
      // being read, and finishes as the new passage reaches the trigger.
      const stepTop = stepRefs.current[next].getBoundingClientRect().top;
      const start = viewport * SCRUB_START;
      const end = trigger - (cards[next].top - stepTop);
      if (stepTop < start && start > end) {
        const progress = clamp01((start - stepTop) / (start - end));
        week = Math.round(scenes[active].weekIndex + (scenes[next].weekIndex - scenes[active].weekIndex) * progress);
      }
    }
    const rect = cards[active];
    const alpha = clamp01((viewport * 0.95 - rect.top) / (viewport * 0.2))
      * clamp01((rect.bottom - viewport * 0.04) / (viewport * 0.18));
    api.update(scenes[active], week, { rect, alpha });
  }, [scenes, steps]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          update();
        });
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

  const initialBounds = BOUNDS[steps[0].scene.bounds];
  return (
    <section className="scrolly" ref={sectionRef}>
      <div className="scrolly-graphic">
        <StoryMap data={data} initialBounds={initialBounds} apiRef={apiRef} onReady={update} label={label} />
      </div>
      <div className="scrolly-steps">
        {steps.map((step, index) => (
          <div
            className={`scrolly-step${step.scrub ? " scrub" : ""}`}
            key={step.text[0]}
            ref={(element) => { stepRefs.current[index] = element; }}
            style={index === 0 ? { paddingTop: first } : undefined}
          >
            <div className="scrolly-card" ref={(element) => { cardRefs.current[index] = element; }}>
              {step.text.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </div>
          </div>
        ))}
        <div className="scrolly-tail" />
      </div>
    </section>
  );
}

function RecoveryFigure({ data, places }) {
  const apiRef = useRef(null);
  const scene = useMemo(
    () => (data && places ? resolveScene({ ...RECOVERY_SCENE, marks: [] }, data, places) : null),
    [data, places],
  );
  const show = useCallback(() => {
    if (apiRef.current && scene) apiRef.current.update(scene, scene.weekIndex, null);
  }, [scene]);
  useEffect(show, [show]);
  return (
    <figure className="story-figure wide">
      <div className="story-figure-map">
        <StoryMap
          data={data}
          initialBounds={BOUNDS[RECOVERY_SCENE.bounds]}
          apiRef={apiRef}
          onReady={show}
          layout="figure"
          label="Map of when each East Bay block group returned to its February 2020 ridership"
        />
      </div>
      <figcaption>
        Recovery time, block groups. Colour marks the first month a block group held 100% of its
        February 2020 ridership for three straight months; red areas have not yet.
      </figcaption>
    </figure>
  );
}

function CampusChart({ data }) {
  const prep = data ? prepareStory(data) : null;
  const series = useMemo(() => (data && prep ? selectionSeries(data, prep.campusKeys) : null), [data, prep]);
  return (
    <figure className="story-figure">
      <div className="story-chart">
        {series ? <SelectionChart series={series} meta={data.meta} /> : <div className="story-chart-loading">Loading…</div>}
      </div>
      <figcaption>
        Weekly boardings and alightings at the {prep ? prep.campusKeys.length : ""} stop groups around the UC Berkeley
        campus, January 2019 through May 2026. Blue: observed by automatic people counters. Gold: estimated.
      </figcaption>
    </figure>
  );
}

export default function Story() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // The story reads block groups, every era's corridors and the commute
    // profiles, so it loads everything the explorer would fetch on demand.
    loadVisualizationData()
      .then(async (loaded) => {
        await ensureData(loaded, everything(loaded));
        return loaded;
      })
      .then((loaded) => { if (!cancelled) setData(loaded); })
      .catch((loadError) => { if (!cancelled) setError(loadError); });
    return () => { cancelled = true; };
  }, []);

  const places = useMemo(() => (data ? resolvePlaces(data) : null), [data]);

  return (
    <article className="story">
      <header className="story-hero">
        <p className="story-kicker">AC Transit, 2019–2026</p>
        <h1>An uneven recovery</h1>
        <p className="story-lede">
          While AC Transit ridership has increased from the pandemic, the recovery has been uneven. Some places
          have fully reached pre-pandemic levels of ridership while some have still yet to reach half of
          pre-pandemic ridership.
        </p>
        {error ? (
          <p className="story-error">The ridership data could not be loaded: {error.message}</p>
        ) : null}
        <p className="story-scroll-cue" aria-hidden="true">Scroll ↓</p>
      </header>

      <ScrollySection
        data={data}
        places={places}
        steps={MAP_ONE}
        label="Map of AC Transit ridership in Berkeley and the East Bay compared with February 2020"
      />

      <div className="story-body">
        <p>
          This data and more are available on an <a href="/">interactive app</a>.
        </p>

        <h2>Inferred rides</h2>
        <p>
          Using Iterative Proportional Fitting (IPF), the origins and destinations of bus riders can be estimated.
          Current data doesn’t collect the trips that riders make, only that a certain number of people entered and
          exited the bus at a given stop.
        </p>
        <p>
          Like all estimation methods, the estimation is not perfect. When tested against BART, which does collect
          these trips, this method achieved an 80% accuracy rate. The model is unable to estimate basic elements of
          bus usage, like transfers between buses.
        </p>
        <p>
          To see estimated trips, select “Commute pattern” and select one or more block groups, Census tracts, or
          stop groups.
        </p>
      </div>

      <ScrollySection
        data={data}
        places={places}
        steps={MAP_TWO}
        first="70vh"
        label="Map of inferred morning bus trips to and from UC Berkeley"
      />

      <div className="story-body">
        <h2>Recovery Time</h2>
        <p>
          The recovery time view shows when a stop group, block group, or Census tract reached its pre-pandemic
          level of ridership.
        </p>
      </div>

      <RecoveryFigure data={data} places={places} />

      <div className="story-body">
        <h2>Selection View</h2>
      </div>

      <CampusChart data={data} />

      <div className="story-body">
        <p>
          Shift-clicking and selecting a section of the map will show a graph of ridership over time. The blue
          section is for observed ridership from the sensors, and the gold section is for estimated data from total
          ridership from buses without sensor technology.
        </p>
        <p className="story-cta-wrap">
          <a className="story-cta" href="/">See the data →</a>
        </p>
      </div>
    </article>
  );
}
