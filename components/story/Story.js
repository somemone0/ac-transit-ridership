"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureData, everything, loadVisualizationData } from "../ridership-data";
import StoryMap from "./StoryMap";
import { resolvePlaces } from "./prepare";
import { BOUNDS, MAP_ONE, MAP_THREE, MAP_TWO, resolveScenes } from "./steps";

// Where in the viewport a passage has to reach before the map switches to it.
const TRIGGER = 0.62;
// Where the top of a scrub step's empty stretch has to reach to start moving
// the week.
const SCRUB_START = 0.1;
// The months the traffic passages name, which must be loaded exactly.
const SPEED_ANCHORS = ["2020-02", "2020-12", "2021-09", "2026-02"];

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
              {step.link ? (
                <p className="scrolly-cta-wrap">
                  <a className="story-cta" href={step.link.href}>{step.link.label}</a>
                </p>
              ) : null}
            </div>
          </div>
        ))}
        <div className="scrolly-tail" />
      </div>
    </section>
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
        // The traffic section colours corridors by observed speed, which lives
        // in one file per month. Fetching all 89 would be megabytes for a
        // section that scrubs across six years, so it takes the months the
        // passages stop on plus a step every half year; the map falls back to
        // the nearest loaded month in between.
        const snapshots = loaded.service?.snapshots || [];
        const wanted = snapshots.filter((snap, index) => (
          index % 6 === 0 || SPEED_ANCHORS.includes(snap.id)
        ));
        await Promise.all(wanted.map((snap) => ensureData(loaded, { serviceMonth: snap })));
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
        <h1>See how AC Transit ridership recovered from the pandemic</h1>
        <p className="story-byline">John Schultz</p>
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
          To see this data, visit the <a href="/">interactive app</a>.
        </p>

        <h2>Where do people go on AC Transit?</h2>
      </div>

      <ScrollySection
        data={data}
        places={places}
        steps={MAP_TWO}
        first="70vh"
        label="Map of inferred morning bus trips to and from UC Berkeley"
      />

      <div className="story-body">
        <h2>Traffic</h2>
      </div>

      <ScrollySection
        data={data}
        places={places}
        steps={MAP_THREE}
        first="70vh"
        label="Map of observed AC Transit bus speeds on Berkeley streets"
      />

      <div className="story-body">
        <p>
          How every figure here is made — the counter correction, the weekly blend that carries it, and
          where the result is known to be wrong — is set out on the <a href="/methodology">methodology
          page</a>.
        </p>
        <p className="story-cta-wrap">
          <a className="story-cta" href="/">See the data →</a>
        </p>
      </div>

    </article>
  );
}
