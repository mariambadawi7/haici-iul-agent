import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { FaceState } from "../types";

export type Emotion = "neutral" | "happy" | "sad" | "surprised";

interface Props {
  state: FaceState;
  amplitude?: number; // 0..1 RMS from the TTS analyser — drives the jaw
  emotion?: Emotion; // expression derived from the response
}

// Swap the avatar without code changes: set VITE_AVATAR_URL to any GLB that
// carries ARKit/Oculus blendshapes (e.g. a Ready Player Me avatar URL, or a
// file dropped in /public/avatar/). Falls back to the bundled face-cap head.
const MODEL_URL =
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

function Head({ state, amplitude, emotion }: Required<Props>) {
  const gl = useThree((s) => s.gl);
  const groupRef = useRef<THREE.Group>(null);
  /** Maps logical name → array of {mesh, index} so we drive ALL meshes. */
  const morphMapRef = useRef<Record<string, MorphEntry[]>>({});
  const [ready, setReady] = useState(false);
  const ptr = usePointer();

  // Blink: clean phase machine so eyes actually re-open.
  const blink = useRef({ value: 0, timer: 2, phase: "open" as "open" | "closing" | "opening" });

  useEffect(() => {
    const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl);
    const loader = new GLTFLoader();
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);

    let alive = true;
    loader.load(
      MODEL_URL,
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
        groupRef.current?.add(holder);
        setReady(true);
      },
      undefined,
      (err) => console.error("[Avatar3D] load failed", err),
    );
    return () => { alive = false; };
  }, [gl]);

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
    const set = (key: string, v: number, lerp = 0.35) => {
      const entries = map[key];
      if (!entries) return;
      for (const { mesh, index } of entries) {
        const infl = mesh.morphTargetInfluences!;
        infl[index] += (v - infl[index]) * lerp;
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

export default function Avatar3D({ state, amplitude = 0, emotion = "neutral" }: Props) {
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
        <Head state={state} amplitude={amplitude} emotion={emotion} />
      </Canvas>
    </div>
  );
}
