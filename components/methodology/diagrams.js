/* Figures for the methodology page. All server-rendered inline SVG: no client
import { T, t } from "../../lib/i18n";

   JS, no chart library, and every mark inherits the page's colour tokens so
   the diagrams follow the light/dark theme with the rest of the site.

   Two of them compute their own contents from the method being described --
   the capture grid counts its own dead cells, and the O-D matrix is produced
   by the same iterative proportional fit the text sets out -- so the figure
   cannot drift away from the prose. Everything is deterministic (an integer
   hash, not Math.random), which keeps the rendered HTML stable across builds.

   Palette convention, shared with the app: accent blue = observed, gold =
   imputed, muted grey = a de-emphasised reference. */

const BW = 118;
const BH = 46;

function Box({ x, y, title, sub, tone = "" }) {
  return (
    <g className={`mdg-box ${tone}`}>
      <rect x={x} y={y} width={BW} height={BH} rx={4} />
      <text x={x + BW / 2} y={y + (sub ? 20 : 28)} className="mdg-box-t" textAnchor="middle">
        {title}
      </text>
      {sub ? (
        <text x={x + BW / 2} y={y + 34} className="mdg-box-s" textAnchor="middle">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Figure({ label, caption, width, height, minWidth = 560, children }) {
  return (
    <figure className="mdg">
      <div className="mdg-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mdg-svg"
          style={{ minWidth }}
          role="img"
          aria-label={label}
        >
          {children}
        </svg>
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Arrow({ d, id, dashed }) {
  return <path d={d} className={`mdg-arrow${dashed ? " dashed" : ""}`} markerEnd={`url(#${id})`} />;
}

function Head({ id, faint }) {
  return (
    <marker
      id={id}
      markerWidth="9"
      markerHeight="9"
      refX="7.5"
      refY="3"
      orient="auto"
      markerUnits="strokeWidth"
    >
      <path d="M0,0 L7.5,3 L0,6 z" className={faint ? "mdg-head faint" : "mdg-head"} />
    </marker>
  );
}

/* ------------------------------------------------------------- pipeline */
/* The shape of the whole chain: two independent estimates of the same
   ridership, kept apart until the blend, which takes shape from both and
   level from the calibrated month. */

export function PipelineFlow() {
  return (
    <Figure
      width={722}
      height={232}
      label={t("diagrams.pipelineAria")}
      caption={t("diagrams.pipelineCaption")}
    >
      <defs>
        <Head id="mdg-h1" />
        <Head id="mdg-h1f" faint />
      </defs>

      <Box x={0} y={26} title={t("diagrams.stepRaw")} sub={t("diagrams.stepRawSub")} />
      <Box x={150} y={26} title={t("diagrams.stepCapture")} sub={t("diagrams.stepCaptureSub")} />
      <Box x={300} y={26} title={t("diagrams.stepCalibration")} sub={t("diagrams.stepCalibrationSub")} />
      <Box x={0} y={136} title={t("diagrams.stepPra")} sub={t("diagrams.stepPraSub")} tone="alt" />
      <Box x={150} y={136} title={t("diagrams.stepReconstruction")}
        sub={t("diagrams.stepReconstructionSub")} tone="alt" />
      <Box x={450} y={81} title={t("diagrams.stepBlend")} sub={t("diagrams.stepBlendSub")} tone="key" />
      <Box x={600} y={81} title={t("diagrams.stepBundle")} sub={t("diagrams.stepBundleSub")} />

      <Arrow id="mdg-h1" d="M118,49 H146" />
      <Arrow id="mdg-h1" d="M268,49 H296" />
      <Arrow id="mdg-h1" d="M418,49 C438,49 434,92 446,96" />
      <Arrow id="mdg-h1" d="M118,159 H146" />
      <Arrow id="mdg-h1" d="M268,159 C360,159 400,116 446,112" />
      <Arrow id="mdg-h1" d="M568,104 H596" />
      <Arrow id="mdg-h1f" dashed d="M118,150 C190,150 214,62 296,62" />

      <text x={59} y={16} className="mdg-lane" textAnchor="middle">
        {t("diagrams.laneMeasured")}
      </text>
      <text x={59} y={204} className="mdg-lane alt" textAnchor="middle">
        {t("diagrams.laneModelled")}
      </text>
    </Figure>
  );
}

/* --------------------------------------------------------- capture grid */
/* One route-direction-month as scheduled trip slots x service days. A dead
   counter runs a whole bus-day, so the misses come in streaks, not confetti;
   the grid is drawn that way because it is what the capture fraction is
   actually averaging over. */

function hash(i, j) {
  let x = (i * 73856093) ^ (j * 19349663);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x = x ^ (x >>> 16);
  return (x >>> 0) / 4294967296;
}

export function CaptureGrid() {
  const days = 21;
  const slots = 12;
  const cw = 13;
  const ch = 11;
  const x0 = 34;
  const y0 = 30;

  const cells = [];
  let good = 0;
  for (let s = 0; s < slots; s += 1) {
    for (let d = 0; d < days; d += 1) {
      // Row 4 is a bus whose counter died mid-month; day 13 is a garage-wide
      // outage. The rest is a flat 22% miss rate.
      const dead = (s === 4 && d >= 8) || d === 13 || hash(s, d) < 0.22;
      if (!dead) good += 1;
      cells.push(
        <rect
          key={`${s}-${d}`}
          x={x0 + d * cw}
          y={y0 + s * ch}
          width={cw - 2}
          height={ch - 2}
          rx={1.5}
          className={dead ? "mdg-cell dead" : "mdg-cell"}
        />
      );
    }
  }

  const total = days * slots;
  const c = good / total;
  const raw = 42;

  return (
    <Figure
      width={722}
      height={210}
      label={t("diagrams.captureAria")}
      caption={t("diagrams.captureCaption")}
    >
      <text x={x0} y={20} className="mdg-small">
        {t("diagrams.captureScope")}
      </text>
      {cells}
      <text x={x0} y={y0 + slots * ch + 14} className="mdg-tick">
        {t("diagrams.captureDays")}
      </text>
      <text
        x={-(y0 + (slots * ch) / 2)}
        y={22}
        className="mdg-tick"
        textAnchor="middle"
        transform="rotate(-90)"
      >
        {t("diagrams.captureSlots")}
      </text>

      <g transform="translate(360,0)">
        <line x1={-18} x2={-18} y1={22} y2={178} className="mdg-rule" />
        <text x={8} y={40} className="mdg-stat-l">
          {t("diagrams.captureReporting")}
        </text>
        <text x={8} y={62} className="mdg-stat">
          {good} <tspan className="mdg-stat-l">{t("diagrams.captureOf")}</tspan> {total}
        </text>
        <text x={8} y={94} className="mdg-stat-l">
          {t("diagrams.captureFraction")}
        </text>
        <text x={8} y={116} className="mdg-stat accent">
          ĉ = {c.toFixed(3)}
        </text>
        <text x={8} y={148} className="mdg-stat-l">
          {t("diagrams.captureStop", { n: raw })}
        </text>
        <text x={8} y={170} className="mdg-stat">
          {raw} ÷ {c.toFixed(3)} ={" "}
          <tspan className="accent">{Math.round(raw / c)}</tspan>
        </text>
      </g>
    </Figure>
  );
}

/* ---------------------------------------------------------- weekly blend */
/* Why the month-grain correction cannot be read at week grain, and what the
   blend does about it. Schematic, but pinned to the two weeks the build
   actually measured. */

const WEEKS = ["W14", "W15", "W16", "W17", "W18", "W19", "W20", "W21", "W22"];
const UPTIME = [0.38, 0.4, 0.36, 0.3, 0.396, 0.22, 0.053, 0.11, 0.19];
const BEFORE = [1.2, 1.35, 1.1, 0.95, 1.62, 0.62, 0.16, 0.34, 0.58];
const AFTER = [0.92, 0.95, 0.9, 0.86, 0.94, 0.85, 0.78, 0.84, 0.88];

function Panel({ x, title, values, split, uptime }) {
  const pw = 300;
  const ph = 132;
  const top = 44;
  const bw = 22;
  const gap = (pw - WEEKS.length * bw) / (WEEKS.length + 1);
  const hi = 1.75;
  const bx = (i) => x + gap + i * (bw + gap);
  const by = (v) => top + ph - (v / hi) * ph;

  return (
    <g>
      <text x={x} y={20} className="mdg-panel-t">
        {title}
      </text>
      {[0, 0.5, 1, 1.5].map((v) => (
        <g key={v}>
          <line x1={x} x2={x + pw} y1={by(v)} y2={by(v)} className="mdg-grid" />
          <text x={x - 6} y={by(v) + 3.5} className="mdg-tick" textAnchor="end">
            {v.toFixed(1)}
          </text>
        </g>
      ))}
      {values.map((v, i) => {
        const real = split ? v * UPTIME[i] : 0;
        return (
          <g key={WEEKS[i]}>
            {split ? (
              <>
                <rect x={bx(i)} y={by(v)} width={bw} height={by(0) - by(v)} className="mdg-bar imputed" />
                <rect
                  x={bx(i)}
                  y={by(real)}
                  width={bw}
                  height={by(0) - by(real)}
                  className="mdg-bar real"
                />
              </>
            ) : (
              <rect x={bx(i)} y={by(v)} width={bw} height={by(0) - by(v)} className="mdg-bar flat" />
            )}
            <text x={bx(i) + bw / 2} y={by(0) + 14} className="mdg-tick" textAnchor="middle">
              {WEEKS[i]}
            </text>
          </g>
        );
      })}
      {uptime ? (
        <>
          <path
            d={values
              .map((_, i) => `${i ? "L" : "M"}${bx(i) + bw / 2},${by(UPTIME[i] * hi * 0.92)}`)
              .join("")}
            className="mdg-uptime"
          />
          {values.map((_, i) => (
            <circle
              key={i}
              cx={bx(i) + bw / 2}
              cy={by(UPTIME[i] * hi * 0.92)}
              r={2.4}
              className="mdg-uptime-dot"
            />
          ))}
        </>
      ) : null}
      {uptime ? (
        <>
          <text x={x + pw + 4} y={by(UPTIME[8] * hi * 0.92) + 3.5} className="mdg-note">
            {t("diagrams.blendUptime")}
          </text>
          <text x={bx(4) + bw / 2} y={by(BEFORE[4]) - 8} className="mdg-note" textAnchor="middle">
            {t("diagrams.blendUpHigh")}
          </text>
          {/* W20's bar is too short to label above it without landing on the
              uptime line, so the label sits clear and points down to it. */}
          <line x1={bx(6) + bw / 2} x2={bx(6) + bw / 2} y1={by(0.72)} y2={by(0.26)} className="mdg-leader" />
          <text x={bx(6) + bw / 2} y={by(0.78)} className="mdg-note" textAnchor="middle">
            {t("diagrams.blendUpLow")}
          </text>
        </>
      ) : null}
    </g>
  );
}

export function BlendChart() {
  return (
    <Figure
      width={722}
      height={252}
      label={t("diagrams.blendAria")}
      caption={<T id="diagrams.blendCaption"
        c={[<span className="mdg-k real" />, <span className="mdg-k imputed" />]} />}
    >
      <Panel x={46} title={t("diagrams.blendPanelBefore")} values={BEFORE} uptime />
      <Panel x={398} title={t("diagrams.blendPanelAfter")} values={AFTER} split />
      <g>
        <path d="M46,222 v8 H346 v-8" className="mdg-brace" />
        <path d="M398,222 v8 H698 v-8" className="mdg-brace" />
        <text x={196} y={246} className="mdg-note" textAnchor="middle">
          {t("diagrams.blendMonthTotal")}
        </text>
        <text x={548} y={246} className="mdg-note" textAnchor="middle">
          {t("diagrams.blendMonthTotalSame")}
        </text>
      </g>
    </Figure>
  );
}

/* ------------------------------------------------------------------- O-D */
/* A route's boarding and alighting profile, and the upper-triangular flow
   matrix fitted to it. The matrix here is produced by the same fit the text
   describes, run on the profile drawn beside it. */

function ipfTri(b, a, iters = 200) {
  const n = b.length;
  const T = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i < j ? 1 : 0)));
  for (let k = 0; k < iters; k += 1) {
    for (let i = 0; i < n; i += 1) {
      const rs = T[i].reduce((s, v) => s + v, 0);
      if (rs > 0) for (let j = 0; j < n; j += 1) T[i][j] *= b[i] / rs;
    }
    for (let j = 0; j < n; j += 1) {
      let cs = 0;
      for (let i = 0; i < n; i += 1) cs += T[i][j];
      if (cs > 0) for (let i = 0; i < n; i += 1) T[i][j] *= a[j] / cs;
    }
  }
  return T;
}

export function OdDiagram() {
  const b = [12, 9, 6, 3, 0, 0, 0];
  const a = [0, 1, 2, 5, 9, 6, 7];
  const n = b.length;
  const T = ipfTri(b, a);
  const peak = Math.max(...T.flat());

  const sx = 40;
  const sy = 96;
  const pitch = 44;
  const scale = 3.4;

  const gx = 430;
  const gy = 44;
  const cell = 22;

  return (
    <Figure
      width={722}
      height={236}
      label={t("diagrams.odAria")}
      caption={t("diagrams.odCaption")}
    >
      <defs>
        <Head id="mdg-h4" />
      </defs>

      <text x={sx} y={22} className="mdg-panel-t">
        {t("diagrams.odCounters")}
      </text>
      <line x1={sx - 8} x2={sx + (n - 1) * pitch + 14} y1={sy} y2={sy} className="mdg-route" />
      {b.map((v, i) => {
        const x = sx + i * pitch;
        return (
          <g key={i}>
            {v > 0 ? (
              <rect x={x - 7} y={sy - v * scale} width={14} height={v * scale} className="mdg-bar real" />
            ) : null}
            {a[i] > 0 ? (
              <rect x={x - 7} y={sy} width={14} height={a[i] * scale} className="mdg-bar off" />
            ) : null}
            <circle cx={x} cy={sy} r={3.4} className="mdg-stop" />
            <text x={x} y={sy + 66} className="mdg-tick" textAnchor="middle">
              {String.fromCharCode(65 + i)}
            </text>
          </g>
        );
      })}
      <text x={sx - 14} y={sy - 44} className="mdg-tick">
        {t("diagrams.odOn")}
      </text>
      <text x={sx - 14} y={sy + 40} className="mdg-tick">
        {t("diagrams.odOff")}
      </text>
      <text x={sx} y={sy + 84} className="mdg-note">
        {t("diagrams.odStops")}
      </text>

      <Arrow id="mdg-h4" d="M352,110 H392" />
      <text x={372} y={100} className="mdg-note" textAnchor="middle">
        {t("diagrams.odFit")}
      </text>

      <text x={gx} y={22} className="mdg-panel-t">
        {t("diagrams.odInferred")}
      </text>
      {Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => {
          const v = T[i][j];
          return (
            <rect
              key={`${i}-${j}`}
              x={gx + j * cell}
              y={gy + i * cell}
              width={cell - 1.5}
              height={cell - 1.5}
              rx={1.5}
              className={j > i ? "mdg-flow" : "mdg-flow void"}
              style={j > i ? { opacity: 0.12 + 0.88 * (v / peak) } : undefined}
            />
          );
        })
      )}
      {Array.from({ length: n }, (_, i) => (
        <text key={`r${i}`} x={gx - 7} y={gy + i * cell + 14} className="mdg-tick" textAnchor="end">
          {String.fromCharCode(65 + i)}
        </text>
      ))}
      {Array.from({ length: n }, (_, j) => (
        <text key={`c${j}`} x={gx + j * cell + cell / 2 - 1} y={gy - 6} className="mdg-tick" textAnchor="middle">
          {String.fromCharCode(65 + j)}
        </text>
      ))}
      <text x={gx - 7} y={gy - 6} className="mdg-tick" textAnchor="end">
        {t("diagrams.odFrom")}
      </text>
      <text x={gx + n * cell + 8} y={gy - 6} className="mdg-tick">
        {t("diagrams.odTo")}
      </text>
      {b.map((v, i) => (
        <text key={`rs${i}`} x={gx + n * cell + 8} y={gy + i * cell + 14} className="mdg-tick num">
          {v || "·"}
        </text>
      ))}
      {a.map((v, j) => (
        <text
          key={`cs${j}`}
          x={gx + j * cell + cell / 2 - 1}
          y={gy + n * cell + 13}
          className="mdg-tick num"
          textAnchor="middle"
        >
          {v || "·"}
        </text>
      ))}
    </Figure>
  );
}

/* ------------------------------------------------------------- corridors */

export function CorridorDiagram() {
  const street = "M10,66 C70,66 95,44 160,44 C225,44 245,76 290,76";
  return (
    <Figure
      width={722}
      height={200}
      minWidth={520}
      label={t("diagrams.corridorAria")}
      caption={t("diagrams.corridorCaption")}
    >
      <defs>
        <Head id="mdg-h5" />
      </defs>
      <g transform="translate(20,0)">
        <text x={0} y={22} className="mdg-panel-t">
          {t("diagrams.corridorThree")}
        </text>
        <g className="mdg-shapes">
          <path d={street} transform="translate(0,-4.5)" />
          <path d={street} />
          <path d={street} transform="translate(0,4.5)" />
        </g>
        <text x={0} y={166} className="mdg-note">
          {t("diagrams.corridorThreeSub")}
        </text>
      </g>

      <Arrow id="mdg-h5" d="M336,60 H386" />
      <text x={361} y={50} className="mdg-note" textAnchor="middle">
        {t("diagrams.corridorHmm")}
      </text>

      <g transform="translate(400,0)">
        <text x={0} y={22} className="mdg-panel-t">
          {t("diagrams.corridorOne")}
        </text>
        {/* One line whose width is the riders on board, stepping only at a
            node -- where a route joins or leaves, or a stop group sits. */}
        <path d="M14,112 C46,107 66,71 83,55" className="mdg-corr w2" />
        <path d={street} className="mdg-corr w2" />
        <path d="M83,55 C112,50 128,44 160,44" className="mdg-corr w3" />
        <path d="M10,66 C40,66 58,59 83,55" className="mdg-corr w1" />
        <path d="M160,44 C190,38 205,23 236,17" className="mdg-corr w1" />
        {[
          [83, 55],
          [160, 44],
        ].map(([cx, cy]) => (
          <circle key={cx} cx={cx} cy={cy} r={4.4} className="mdg-node" />
        ))}
        <text x={0} y={132} className="mdg-note">
          {t("diagrams.corridorJoin")}
        </text>
        <text x={186} y={13} className="mdg-note">
          {t("diagrams.corridorLeave")}
        </text>
        <text x={0} y={166} className="mdg-note">
          {t("diagrams.corridorWidth")}
        </text>
      </g>
    </Figure>
  );
}
