import { useEffect, useMemo, useRef, type CSSProperties, type Ref } from "react";
import { MASCOT_RIG } from "../lib/mascotRig";
import type { Emotion, FaceState } from "../types";

/**
 * The HAICI mascot: a 2D rigged character animated from the same
 * `(state, amplitude, emotion)` triple that drives `Avatar3D`, so either can
 * occupy the assistant panel without the app knowing the difference.
 *
 * How it is put together
 * ----------------------
 * The vendor pack is flattened by `tools/build_mascot_assets.py` into three
 * static composites on a 2000x3200 master canvas (body, head, antenna) plus a
 * library of face overlays on their own 1024x1024 canvas. Every layer here is
 * an `<img>` stretched across the master box and stacked in the pack's paint
 * order, so a layer's position is baked into its own artwork and nothing needs
 * per-part placement — the one exception is the face overlays, which get the
 * single registration offset from `MASCOT_RIG.faceOverlay`.
 *
 * Everything that moves does so through direct style writes inside one
 * `requestAnimationFrame` loop, never through React state: at 60fps a
 * re-render per frame would be wasteful, and the props are read through a ref
 * so the loop is mounted exactly once.
 *
 * Colours are deliberately the character's own, not the tenant theme. The
 * mascot is supplied artwork like a logo — retinting it would break the brand
 * it belongs to rather than follow the one the app is wearing.
 */

export type MascotView = "head" | "full";

interface Props {
  state: FaceState;
  /** 0..1 speech envelope; picks the viseme while `state` is "speaking". */
  amplitude?: number;
  /** Sentiment of the latest answer, layered over the state's resting face. */
  emotion?: Emotion;
  /** "head" crops to the face for a large, legible expression; "full" shows
   *  the whole character. */
  view?: MascotView;
  /**
   * The root carries `aspect-ratio`, so constrain exactly one axis and let the
   * other follow: `h-full` for the tall "full" crop, `w-full` for the wide
   * "head" crop. Pinning both would stretch the artwork.
   */
  className?: string;
}

const BASE = "/mascot";
const { master, faceOverlay, pivots } = MASCOT_RIG;

/**
 * Named crops of the master canvas, in master units. The head crop keeps a
 * wide margin either side: the head swings on the neck bone, which sits below
 * the crop, so a few degrees of sway travels a long way horizontally and a
 * tight frame clips the shell corners.
 */
const CROPS: Record<MascotView, { x: number; y: number; w: number; h: number }> = {
  head: { x: 100, y: 0, w: 1800, h: 1500 },
  full: { x: 240, y: 10, w: 1520, h: 3140 },
};

interface Look {
  eyes: string;
  brows: string;
  mouth: string;
  /** Optional glyph beside the eye — the pack's "expression marks". */
  mark?: string;
}

/** Resting face per conversation state. */
const STATE_LOOK: Record<FaceState, Look> = {
  idle: { eyes: "neutral", brows: "neutral", mouth: "smile" },
  listening: { eyes: "wide", brows: "raised", mouth: "closed" },
  thinking: { eyes: "thinking", brows: "lowered", mouth: "thinking", mark: "loading" },
  speaking: { eyes: "happy", brows: "neutral", mouth: "smile" },
};

/** Sentiment overrides, layered over the state's resting face. */
const EMOTION_LOOK: Partial<Record<Emotion, Look>> = {
  happy: { eyes: "happy", brows: "raised", mouth: "grin", mark: "heart" },
  sad: { eyes: "sad", brows: "worried", mouth: "sad" },
  surprised: { eyes: "surprised", brows: "raised", mouth: "round", mark: "exclaim" },
};

/**
 * The face for a given state, with the sentiment override applied only while
 * idle or speaking. Listening and thinking are states the user needs to read
 * at a glance, so they keep their own face rather than being coloured by the
 * previous answer's tone.
 */
function resolveLook(state: FaceState, emotion: Emotion): Look {
  const moody = state === "idle" || state === "speaking";
  return (moody ? EMOTION_LOOK[emotion] : undefined) ?? STATE_LOOK[state];
}

/**
 * Viseme ladder, quietest band first: `[upper bound of the band, shapes]`.
 * Each band holds two drawings so a sustained vowel alternates instead of
 * freezing on one frame — the cheap trick that makes switched-drawing lip-sync
 * read as speech rather than a stuck mouth.
 */
const VISEME_BANDS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [0.06, ["v_closed", "v_mbp"]],
  [0.14, ["v_rest", "v_i"]],
  [0.26, ["v_e", "v_l"]],
  [0.4, ["v_i", "v_fv"]],
  [0.56, ["v_a", "v_wq"]],
  [0.74, ["v_o", "v_u"]],
  [Infinity, ["v_open", "v_a"]],
];

/** Minimum time one viseme stays on screen. Below ~70ms it reads as a flicker. */
const VISEME_HOLD_MS = 75;

/** Blink timeline in ms: half-shut, fully shut, half-open again. */
const BLINK_STEPS: ReadonlyArray<readonly [number, string]> = [
  [45, "blink_half"],
  [110, "blink_shut"],
  [155, "blink_half"],
];

/** Eyes that are already shut or narrowed; blinking through them looks broken. */
const NO_BLINK = new Set(["closed", "blink_half", "blink_shut", "sleepy", "happy"]);

type SlotName = "eyes" | "brows" | "mouth" | "mark";
const SLOTS: SlotName[] = ["eyes", "brows", "mouth", "mark"];

/** Folder each slot's artwork lives in, relative to `BASE`. */
const SLOT_DIR: Record<SlotName, string> = {
  eyes: "eyes",
  brows: "brows",
  mouth: "mouth",
  mark: "marks",
};

const url = (slot: SlotName, name: string) => `${BASE}/${SLOT_DIR[slot]}/${name}.svg`;

/**
 * Two stacked images that dissolve into one another when the source changes.
 * A hard `src` swap would strobe on every viseme; holding the outgoing drawing
 * for one CSS transition instead gives the switch a little weight.
 */
class Dissolve {
  private front = 0;

  constructor(
    private readonly imgs: readonly [HTMLImageElement, HTMLImageElement],
    /** What the server-rendered markup is already showing in slot 0. */
    private shown = "",
  ) {}

  set(next: string) {
    if (next === this.shown) return;
    this.shown = next;
    if (!next) {
      for (const img of this.imgs) img.style.opacity = "0";
      return;
    }
    const incoming = this.imgs[this.front ^ 1];
    incoming.src = next;
    incoming.style.opacity = "1";
    this.imgs[this.front].style.opacity = "0";
    this.front ^= 1;
  }
}

/** Everything the pack can show, warmed so the first swap is not a blank frame. */
function preloadAll() {
  const names: Array<[SlotName, string]> = [];
  for (const look of [...Object.values(STATE_LOOK), ...Object.values(EMOTION_LOOK)]) {
    names.push(["eyes", look.eyes], ["brows", look.brows], ["mouth", look.mouth]);
    if (look.mark) names.push(["mark", look.mark]);
  }
  for (const [, shapes] of VISEME_BANDS) for (const s of shapes) names.push(["mouth", s]);
  for (const [, eyes] of BLINK_STEPS) names.push(["eyes", eyes]);
  for (const [slot, name] of names) new Image().src = url(slot, name);
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export default function Mascot2D({
  state,
  amplitude = 0,
  emotion = "neutral",
  view = "full",
  className = "",
}: Props) {
  const headRef = useRef<HTMLDivElement>(null);
  const antennaRef = useRef<HTMLDivElement>(null);
  const eyesWrapRef = useRef<HTMLDivElement>(null);
  /** slot -> its two <img>s, filled by the callback refs below. */
  const slotImgs = useRef<Partial<Record<SlotName, HTMLImageElement[]>>>({});

  // The loop reads props from here, so it can mount once and never restart.
  const live = useRef({ state, amplitude, emotion });
  live.current = { state, amplitude, emotion };

  const bind = (slot: SlotName, index: number) => (el: HTMLImageElement | null) => {
    if (!el) return;
    (slotImgs.current[slot] ??= [])[index] = el;
  };

  /**
   * The face the markup ships with. Without it the screen is blank until the
   * first animation frame lands, which reads as a mascot booting up every time
   * the panel mounts. Captured once — after that the loop owns the artwork.
   */
  const firstPaint = useRef<Partial<Record<SlotName, string>>>({});
  if (!firstPaint.current.eyes) {
    const look = resolveLook(state, emotion);
    firstPaint.current = {
      eyes: url("eyes", look.eyes),
      brows: url("brows", look.brows),
      mouth: url("mouth", look.mouth),
      mark: look.mark ? url("mark", look.mark) : "",
    };
  }

  const crop = CROPS[view];

  /** Geometry derived from the rig, all as percentages of the crop window. */
  const geometry = useMemo(() => {
    const pct = (n: number, of: number) => `${(n / of) * 100}%`;
    return {
      aspect: `${crop.w} / ${crop.h}`,
      stage: {
        width: pct(master.width, crop.w),
        height: pct(master.height, crop.h),
        left: pct(-crop.x, crop.w),
        top: pct(-crop.y, crop.h),
      },
      face: {
        left: pct(faceOverlay.x, master.width),
        top: pct(faceOverlay.y, master.height),
        width: pct(faceOverlay.size, master.width),
        height: pct(faceOverlay.size, master.height),
      },
      neckPivot: `${pct(pivots.neck.x, master.width)} ${pct(pivots.neck.y, master.height)}`,
      antennaPivot: `${pct(pivots.antenna.x, master.width)} ${pct(pivots.antenna.y, master.height)}`,
    };
  }, [crop]);

  useEffect(preloadAll, []);

  useEffect(() => {
    const head = headRef.current;
    const antenna = antennaRef.current;
    const eyesWrap = eyesWrapRef.current;
    if (!head || !antenna || !eyesWrap) return;

    const dissolves = {} as Record<SlotName, Dissolve>;
    for (const slot of SLOTS) {
      const pair = slotImgs.current[slot];
      if (!pair?.[0] || !pair[1]) return;
      dissolves[slot] = new Dissolve([pair[0], pair[1]], firstPaint.current[slot]);
    }

    // Respect the OS setting: keep the expressions and lip-sync, drop the
    // continuous drift and bounce that make a kiosk screen restless.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const pointer = { x: 0, y: 0 };
    const onPointerMove = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onPointerMove);

    const start = performance.now();
    const blink = { next: start + 1500, until: 0 };
    const viseme = { name: "", until: 0, alt: 0 };
    let raf = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const t = (now - start) / 1000;
      const { state, amplitude, emotion } = live.current;
      const talking = state === "speaking";
      const amp = talking ? clamp01(amplitude) : 0;

      const look = resolveLook(state, emotion);

      // --- Blink --------------------------------------------------------
      let eyes = look.eyes;
      if (now >= blink.next && !blink.until) blink.until = now + 155;
      if (blink.until) {
        const elapsed = 155 - (blink.until - now);
        const step = BLINK_STEPS.find(([end]) => elapsed < end);
        if (step && !NO_BLINK.has(eyes)) eyes = step[1];
        if (!step) {
          blink.until = 0;
          blink.next = now + 2200 + Math.random() * 3800;
        }
      }

      // --- Mouth --------------------------------------------------------
      let mouth = look.mouth;
      if (talking) {
        if (now >= viseme.until) {
          const band = VISEME_BANDS.find(([ceiling]) => amp < ceiling)!;
          const shapes = band[1];
          const picked = shapes[viseme.alt % shapes.length];
          // Only pay the hold (and the dissolve) when the drawing changes.
          if (picked !== viseme.name) {
            viseme.name = picked;
            viseme.until = now + VISEME_HOLD_MS;
          }
          viseme.alt++;
        }
        mouth = viseme.name || "v_rest";
      } else {
        viseme.name = "";
        viseme.until = 0;
      }

      dissolves.eyes.set(url("eyes", eyes));
      dissolves.brows.set(url("brows", look.brows));
      dissolves.mouth.set(url("mouth", mouth));
      dissolves.mark.set(look.mark ? url("mark", look.mark) : "");

      // --- Pose ---------------------------------------------------------
      const drift = calm ? 0 : 1;
      // Degrees. Thinking cocks the head aside; listening leans in.
      const tilt = state === "thinking" ? -7 : state === "listening" ? 4 : 0;
      const sway = drift * Math.sin(t * 0.9) * 1.6 + pointer.x * 3.2;
      // Percent of the master canvas height.
      const bob = drift * Math.sin(t * 1.3) * 0.35 - pointer.y * 0.3 - amp * 0.5;
      head.style.transform = `translateY(${bob.toFixed(3)}%) rotate(${(sway + tilt).toFixed(3)}deg)`;

      const perk = state === "listening" ? 7 : state === "thinking" ? -10 : 0;
      const wag =
        drift * Math.sin(t * 2.2) * 3 + amp * 9 * Math.sin(t * 17);
      antenna.style.transform = `rotate(${(wag + perk).toFixed(3)}deg)`;

      // The antenna ball is the mascot's status light: it breathes while idle
      // and flares with the voice.
      const glow = 0.4 + drift * 0.2 * Math.sin(t * 2) + amp * 0.6;
      antenna.style.filter = `drop-shadow(0 0 ${(2 + glow * 7).toFixed(1)}px rgba(40, 207, 239, ${(
        0.2 + glow * 0.45
      ).toFixed(2)}))`;

      // Eyes track the pointer within the face screen.
      eyesWrap.style.transform = `translate(${(pointer.x * 0.9).toFixed(3)}%, ${(
        -pointer.y * 0.7
      ).toFixed(3)}%)`;
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  const layer: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    userSelect: "none",
  };
  // `transition: all` is banned project-wide — a transitioning shorthand stops
  // re-resolving the custom properties behind a theme swap. Name the property.
  const fading: CSSProperties = { ...layer, opacity: 0, transition: "opacity 90ms linear" };

  const slot = (name: SlotName, ref?: Ref<HTMLDivElement>) => {
    const first = firstPaint.current[name];
    return (
      <div key={name} ref={ref} style={{ position: "absolute", ...geometry.face }}>
        <img
          alt=""
          aria-hidden
          draggable={false}
          src={first || undefined}
          style={{ ...fading, opacity: first ? 1 : 0 }}
          ref={bind(name, 0)}
        />
        <img alt="" aria-hidden draggable={false} style={fading} ref={bind(name, 1)} />
      </div>
    );
  };

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ aspectRatio: geometry.aspect }}
      role="img"
      aria-label="Assistant mascot"
    >
      <div style={{ position: "absolute", ...geometry.stage }}>
        {view === "full" && (
          <img src={`${BASE}/body.svg`} alt="" aria-hidden draggable={false} style={layer} />
        )}

        {/* Head group: rotates about the rig's neck bone, carrying the face
            overlays and the antenna with it. */}
        <div
          ref={headRef}
          style={{ position: "absolute", inset: 0, transformOrigin: geometry.neckPivot }}
        >
          <img src={`${BASE}/head.svg`} alt="" aria-hidden draggable={false} style={layer} />

          {slot("eyes", eyesWrapRef)}
          {slot("brows")}
          {slot("mouth")}

          <div
            ref={antennaRef}
            style={{ position: "absolute", inset: 0, transformOrigin: geometry.antennaPivot }}
          >
            <img src={`${BASE}/antenna.svg`} alt="" aria-hidden draggable={false} style={layer} />
          </div>

          {slot("mark")}
        </div>
      </div>
    </div>
  );
}
