import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { Emotion, FaceState } from "../types";

interface Props {
  state: FaceState;
  amplitude?: number; // 0..1 RMS from the TTS analyser — drives the jaw
  emotion?: Emotion; // expression derived from the response
  /** GLB to load. Supplied from the tenant config so each client can ship
   *  their own character; falls back to the bundled head. */
  modelUrl?: string;
  /** Fires when the GLB fails to load (bad URL, 404, malformed file) so the
   *  caller can fall back to another avatar renderer. Avatar3D itself also
   *  renders an in-panel message so a missing callback never leaves a blank,
   *  unexplained canvas. */
  onLoadError?: (err: Error) => void;
}

// Any GLB carrying ARKit/Oculus blendshapes works (a Ready Player Me URL, or
// a file dropped in /public/avatar/). The tenant config is the normal source;
// VITE_AVATAR_URL remains as a build-time override for local development, and
// the bundled face-cap head is the last resort.
const FALLBACK_MODEL_URL =
  (import.meta.env.VITE_AVATAR_URL as string) || "/avatar/facecap.glb";

// Logical blendshape -> candidate names across rig conventions
// (facecap uses eyeBlink_L; Ready Player Me uses eyeBlinkLeft).
const MORPH: Record<string, string[]> = {
  jawOpen: ["jawOpen", "Jaw_Open", "jaw_open"],
  mouthFunnel: ["mouthFunnel", "Mouth_Funnel", "mouth_funnel"],
  mouthClose: ["mouthClose", "Mouth_Close", "mouth_close"],
  mouthPucker: ["mouthPucker", "Mouth_Pucker", "mouth_pucker"],
  mouthStretchL: ["mouthStretch_L", "mouthStretchLeft", "Mouth_Stretch_L"],
  mouthStretchR: ["mouthStretch_R", "mouthStretchRight", "Mouth_Stretch_R"],
  mouthLowerDownL: ["mouthLowerDown_L", "mouthLowerDownLeft", "Mouth_Lower_Down_L"],
  mouthLowerDownR: ["mouthLowerDown_R", "mouthLowerDownRight", "Mouth_Lower_Down_R"],
  mouthUpperUpL: ["mouthUpperUp_L", "mouthUpperUpLeft", "Mouth_Upper_Up_L"],
  mouthUpperUpR: ["mouthUpperUp_R", "mouthUpperUpRight", "Mouth_Upper_Up_R"],
  mouthOpen: ["mouthOpen", "Mouth_Open", "mouth_open"],
  tongueOut: ["tongueOut", "Tongue_Out", "tongue_out"],
  smileL: ["mouthSmile_L", "mouthSmileLeft", "Mouth_Smile_L"],
  smileR: ["mouthSmile_R", "mouthSmileRight", "Mouth_Smile_R"],
  frownL: ["mouthFrown_L", "mouthFrownLeft", "Mouth_Frown_L"],
  frownR: ["mouthFrown_R", "mouthFrownRight", "Mouth_Frown_R"],
  blinkL: ["eyeBlink_L", "eyeBlinkLeft", "Eye_Blink_L"],
  blinkR: ["eyeBlink_R", "eyeBlinkRight", "Eye_Blink_R"],
  browInner: ["browInnerUp", "Brow_Inner_Up"],
  browDownL: ["browDown_L", "browDownLeft", "Brow_Down_L"],
  browDownR: ["browDown_R", "browDownRight", "Brow_Down_R"],
  browOuterL: ["browOuterUp_L", "browOuterUpLeft", "Brow_Outer_Up_L"],
  browOuterR: ["browOuterUp_R", "browOuterUpRight", "Brow_Outer_Up_R"],
  cheekL: ["cheekSquint_L", "cheekSquintLeft", "Cheek_Squint_L"],
  cheekR: ["cheekSquint_R", "cheekSquintRight", "Cheek_Squint_R"],
  eyeUpL: ["eyeLookUp_L", "eyeLookUpLeft"],
  eyeUpR: ["eyeLookUp_R", "eyeLookUpRight"],
  eyeDownL: ["eyeLookDown_L", "eyeLookDownLeft"],
  eyeDownR: ["eyeLookDown_R", "eyeLookDownRight"],
  eyeInL: ["eyeLookIn_L", "eyeLookInLeft"],
  eyeInR: ["eyeLookIn_R", "eyeLookInRight"],
  eyeOutL: ["eyeLookOut_L", "eyeLookOutLeft"],
  eyeOutR: ["eyeLookOut_R", "eyeLookOutRight"],
  jawL: ["jawLeft", "Jaw_Left"],
  jawR: ["jawRight", "Jaw_Right"],
  jawFwd: ["jawForward", "Jaw_Forward", "jaw_forward"],
  wideL: ["eyeWide_L", "eyeWideLeft"],
  wideR: ["eyeWide_R", "eyeWideRight"],
  squintL: ["eyeSquint_L", "eyeSquintLeft"],
  squintR: ["eyeSquint_R", "eyeSquintRight"],
  noseSneerL: ["noseSneer_L", "noseSneerLeft"],
  noseSneerR: ["noseSneer_R", "noseSneerRight"],
  cheekPuff: ["cheekPuff", "Cheek_Puff"],
};

/** Pointer position in normalized device coords (-1..1), shared across frames. */
function usePointer() {
  const ptr = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      ptr.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      ptr.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);
  return ptr;
}

/** One morph-target entry: which mesh it lives on + its influence index. */
interface MorphEntry {
  mesh: THREE.Mesh;
  index: number;
}

/** Three.js does not free GPU memory on garbage collection — geometries,
 *  materials and textures each hold a buffer that must be released explicitly,
 *  or the discarded model's VRAM stays resident for the life of the WebGL
 *  context. Safe to call on a group that is about to be replaced OR that is
 *  still attached; the caller is responsible for not disposing anything still
 *  shared with a model that stays on screen (this component never shares
 *  geometries/materials across loads, since each GLTFLoader.load gets its own
 *  freshly parsed scene graph). */
function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
  });
}

function disposeMaterial(mat: THREE.Material) {
  for (const value of Object.values(mat)) {
    if (value && typeof value === "object" && "isTexture" in value) {
      (value as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}

function Head({
  state,
  amplitude,
  emotion,
  modelUrl,
  onError,
}: Required<Pick<Props, "state" | "amplitude" | "emotion">> & {
  modelUrl: string;
  onError: (err: Error) => void;
}) {
  const gl = useThree((s) => s.gl);
  const groupRef = useRef<THREE.Group>(null);
  /** Maps logical name → array of {mesh, index} so we drive ALL meshes. */
  const morphMapRef = useRef<Record<string, MorphEntry[]>>({});
  /** The currently-attached model holder, so a re-load (tenant swaps their
   *  avatar) or unmount can remove and dispose the OLD one instead of
   *  stacking a second head in the same group. */
  const holderRef = useRef<THREE.Group | null>(null);
  const [ready, setReady] = useState(false);
  const ptr = usePointer();

  // Blink: clean phase machine so eyes actually re-open.
  const blink = useRef({ value: 0, timer: 2, phase: "open" as "open" | "closing" | "opening" });

  // `onError` is recreated by the parent on every render (amplitude updates
  // every frame while speaking), so it cannot sit in the load effect's
  // dependency array below without reloading the GLB dozens of times a
  // second. Stash it in a ref and read the ref inside the effect instead —
  // the effect still only re-runs when gl/modelUrl actually change.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl);
    const loader = new GLTFLoader();
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);

    let alive = true;
    loader.load(
      modelUrl,
      (gltf) => {
        if (!alive) return;
        const root = gltf.scene;

        // Collect ALL meshes that carry morph targets.
        const morphMeshes: THREE.Mesh[] = [];
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) {
            morphMeshes.push(m);
          }
        });

        console.log(`[Avatar3D] Found ${morphMeshes.length} meshes with morph targets`);

        // Build a unified map: logical key → [{mesh, index}, ...]
        const map: Record<string, MorphEntry[]> = {};
        for (const mesh of morphMeshes) {
          const dict = mesh.morphTargetDictionary!;
          console.log(`[Avatar3D] Mesh "${mesh.name}": ${Object.keys(dict).length} blendshapes:`, Object.keys(dict).sort());
          mesh.morphTargetInfluences!.fill(0);

          for (const logicalKey in MORPH) {
            for (const candidate of MORPH[logicalKey]) {
              if (dict[candidate] !== undefined) {
                if (!map[logicalKey]) map[logicalKey] = [];
                map[logicalKey].push({ mesh, index: dict[candidate] });
                break; // first match per mesh per logical key
              }
            }
          }
        }

        morphMapRef.current = map;
        console.log("[Avatar3D] Resolved morph keys:", Object.keys(map).sort());

        const box = new THREE.Box3().setFromObject(root);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        console.log("[Avatar3D] Model size:", size, "center:", center);
        const scale = 1.5 / Math.max(size.x, size.y, size.z);
        root.position.sub(center);
        const holder = new THREE.Group();
        holder.add(root);
        holder.scale.setScalar(scale);
        // Shift slightly up so face is centered in viewport
        holder.position.set(0, 0.05, 0);

        // Swap out any previously-attached model instead of stacking a second
        // one in the same group. Without this, a tenant re-saving their GLB
        // URL in the Branding tab (which re-renders <Avatar3D> in place rather
        // than remounting it) superimposes two heads and leaks the old one's
        // geometries/materials/textures for the life of the WebGL context.
        if (holderRef.current) {
          groupRef.current?.remove(holderRef.current);
          disposeObject(holderRef.current);
        }
        holderRef.current = holder;
        groupRef.current?.add(holder);
        setReady(true);
      },
      undefined,
      (err) => {
        console.error("[Avatar3D] load failed", err);
        // A failed load must be visible to the caller, otherwise the tenant
        // gets a blank panel with no indication anything is wrong and no way
        // to fall back to another renderer.
        if (alive) onErrorRef.current(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => {
      alive = false;
      if (holderRef.current) {
        groupRef.current?.remove(holderRef.current);
        disposeObject(holderRef.current);
        holderRef.current = null;
      }
      morphMapRef.current = {};
      setReady(false);
    };
    // Re-loads when the tenant swaps their avatar model. `onError` is
    // deliberately excluded — see onErrorRef above.
  }, [gl, modelUrl]);

  useFrame((_, dtRaw) => {
    const grp = groupRef.current;
    const dt = Math.min(dtRaw, 0.05);
    const map = morphMapRef.current;

    // Head follows the mouse (with idle sway); look up when thinking.
    if (grp) {
      const targetY = ptr.current.x * 0.5 + (state === "thinking" ? 0.1 : 0) + Math.sin(performance.now() / 2800) * 0.03;
      const targetX = -ptr.current.y * 0.32 + (state === "thinking" ? -0.1 : 0) + Math.sin(performance.now() / 3600) * 0.015;
      const targetZ = state === "listening" ? 0.08 : 0;
      grp.rotation.y += (targetY - grp.rotation.y) * 0.07;
      grp.rotation.x += (targetX - grp.rotation.x) * 0.07;
      grp.rotation.z += (targetZ - grp.rotation.z) * 0.06;
    }

    // Helper: set a logical morph value across ALL meshes that have it.
    // Exponential smoothing normalised to a 60fps baseline, so expressions
    // converge at the same wall-clock rate on a 120Hz tablet and a throttled
    // tab. `lerp` is the fraction of the gap closed per frame AT 60fps; `k` is
    // the equivalent fraction for however long this frame's `dt` actually was.
    // The blink phase machine above already uses dt this way — without this,
    // blink timing and expression timing would drift apart across displays.
    const set = (key: string, v: number, lerp = 0.35) => {
      const entries = map[key];
      if (!entries) return;
      const k = 1 - Math.pow(1 - lerp, dt * 60);
      for (const { mesh, index } of entries) {
        const infl = mesh.morphTargetInfluences!;
        infl[index] += (v - infl[index]) * k;
      }
    };

    // --- Blink ---
    const b = blink.current;
    if (b.phase === "open") {
      b.timer -= dt;
      if (b.timer <= 0) b.phase = "closing";
    } else if (b.phase === "closing") {
      b.value += dt * 22;
      if (b.value >= 1) { b.value = 1; b.phase = "opening"; }
    } else {
      b.value -= dt * 12;
      if (b.value <= 0) { b.value = 0; b.phase = "open"; b.timer = 2 + Math.random() * 3.5; }
    }
    set("blinkL", b.value, 0.6);
    set("blinkR", b.value, 0.6);

    // --- Eyes follow the mouse ---
    const ex = ptr.current.x, ey = ptr.current.y;
    set("eyeInL", Math.max(0, ex) * 0.6);
    set("eyeOutL", Math.max(0, -ex) * 0.6);
    set("eyeInR", Math.max(0, -ex) * 0.6);
    set("eyeOutR", Math.max(0, ex) * 0.6);
    set("eyeUpL", Math.max(0, ey) * 0.5);
    set("eyeUpR", Math.max(0, ey) * 0.5);
    set("eyeDownL", Math.max(0, -ey) * 0.5);
    set("eyeDownR", Math.max(0, -ey) * 0.5);

    // --- Lip-sync ---
    const talk = state === "speaking" ? Math.min(1, amplitude * 1.4) : 0;
    set("jawOpen", talk * 0.7, 0.45);
    set("mouthFunnel", talk * 0.35, 0.45);
    set("mouthOpen", talk * 0.5, 0.45);
    set("mouthClose", talk > 0.05 ? 0 : 0.1, 0.3); // relax mouthClose when talking
    set("mouthStretchL", talk * 0.15, 0.4);
    set("mouthStretchR", talk * 0.15, 0.4);
    set("mouthLowerDownL", talk * 0.4, 0.45);
    set("mouthLowerDownR", talk * 0.4, 0.45);
    set("mouthUpperUpL", talk * 0.15, 0.4);
    set("mouthUpperUpR", talk * 0.15, 0.4);
    set("mouthPucker", talk * 0.1, 0.3);
    set("jawFwd", talk * 0.08, 0.3);
    set("tongueOut", talk > 0.7 ? (talk - 0.7) * 0.3 : 0, 0.35);
    set("cheekPuff", talk * 0.05, 0.3);
    set("noseSneerL", talk * 0.08, 0.3);
    set("noseSneerR", talk * 0.08, 0.3);

    // --- Emotion ---
    const happy = emotion === "happy" ? 1 : 0;
    const sad = emotion === "sad" ? 1 : 0;
    const surprised = emotion === "surprised" ? 1 : 0;
    const baseSmile = state === "idle" || state === "listening" || state === "speaking" ? 0.22 : 0;
    const smile = Math.max(baseSmile, happy * 0.6);
    set("smileL", smile);
    set("smileR", smile);
    set("cheekL", smile * 0.7);
    set("cheekR", smile * 0.7);
    set("frownL", sad * 0.5);
    set("frownR", sad * 0.5);
    set("browInner", Math.max(sad * 0.5, surprised * 0.7, state === "listening" ? 0.3 : 0, state === "speaking" ? 0.15 : 0));
    set("browDownL", state === "thinking" ? 0.32 : 0);
    set("browDownR", state === "thinking" ? 0.32 : 0);
    set("browOuterL", Math.max(surprised * 0.5, state === "speaking" ? talk * 0.1 : 0));
    set("browOuterR", Math.max(surprised * 0.5, state === "speaking" ? talk * 0.1 : 0));
    set("wideL", surprised * 0.5);
    set("wideR", surprised * 0.5);
    set("squintL", smile * 0.3);
    set("squintR", smile * 0.3);
  });

  return <group ref={groupRef} visible={ready} />;
}

export default function Avatar3D({
  state,
  amplitude = 0,
  emotion = "neutral",
  modelUrl,
  onLoadError,
}: Props) {
  const url = modelUrl || FALLBACK_MODEL_URL;
  const [loadError, setLoadError] = useState<Error | null>(null);

  // A model that failed once may load fine after the tenant fixes the URL —
  // clear the error whenever they hand us a new one so this component can
  // recover without needing a full remount.
  useEffect(() => {
    setLoadError(null);
  }, [url]);

  const handleError = (err: Error) => {
    setLoadError(err);
    onLoadError?.(err);
  };

  if (loadError) {
    // Degrade to a themed message instead of the permanently blank,
    // unexplained panel a silent load failure used to leave behind. The
    // caller (via onLoadError) is the better place to fall back to the
    // mascot/image/none renderer entirely; this is the floor for callers
    // that don't wire that up.
    return (
      <div className="relative w-full h-full min-h-[150px] flex items-center justify-center rounded-2xl border border-neutral-200 bg-surface p-4 text-center text-sm text-neutral-500 select-none">
        Avatar could not be loaded.
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[150px] select-none">
      <Canvas
        camera={{ position: [0, 0.08, 3.6], fov: 28 }}
        gl={{ antialias: true, alpha: true, toneMappingExposure: 1.05 }}
        dpr={[1, 2]}
      >
        <hemisphereLight args={["#fff3e2", "#3a322c", 0.5]} />
        <ambientLight intensity={0.2} />
        <directionalLight position={[2.5, 2.5, 3]} intensity={1.35} color="#fff1de" />
        <directionalLight position={[-3, 0.5, 1.5]} intensity={0.3} color="#e8ddd2" />
        <directionalLight position={[-1, 1.5, -3]} intensity={0.6} color="#ffcf99" />
        <Head state={state} amplitude={amplitude} emotion={emotion} modelUrl={url} onError={handleError} />
      </Canvas>
    </div>
  );
}
