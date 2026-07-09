import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { FaceState } from "../types";

interface Props {
  state: FaceState;
  amplitude?: number; // 0..1 RMS from the TTS analyser — drives the jaw
}

const MODEL_URL = "/avatar/facecap.glb";

/**
 * Real-time 3D talking head. Loads a face-captured mesh (ARKit blendshapes)
 * and drives its morph targets every frame:
 *  - jawOpen / mouthFunnel  ← `amplitude` when speaking (lip-sync)
 *  - eyeBlink_L/R           ← autonomous blink timer
 *  - brows / smile          ← resolved from `state`
 * Runs entirely in the browser (no GPU server), so it's free and always-on.
 */
function Head({ state, amplitude }: { state: FaceState; amplitude: number }) {
  const gl = useThree((s) => s.gl);
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const dictRef = useRef<Record<string, number>>({});
  const [ready, setReady] = useState(false);

  // Blink state machine
  const blink = useRef({ value: 0, next: 1.5, closing: false });

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
        // Find the mesh that carries the ARKit blendshapes.
        let head: THREE.Mesh | null = null;
        root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) {
            head = m;
          }
        });
        if (head) {
          dictRef.current = head.morphTargetDictionary!;
          head.morphTargetInfluences!.fill(0); // neutral resting face
          meshRef.current = head;
          // Warm the skin a touch so the muted capture reads healthier.
          const mat = (head as THREE.Mesh).material as THREE.MeshStandardMaterial;
          mat.color = new THREE.Color("#ffd9be");
          mat.roughness = 0.72;
          mat.needsUpdate = true;
        }

        // Center + scale the head to a consistent frame, facing the camera.
        const box = new THREE.Box3().setFromObject(root);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scale = 2.05 / Math.max(size.x, size.y, size.z);
        root.position.sub(center);
        const holder = new THREE.Group();
        holder.add(root);
        holder.scale.setScalar(scale);
        holder.position.set(0, -0.05, 0); // centered; small vertical nudge
        groupRef.current?.add(holder);
        setReady(true);
      },
      undefined,
      (err) => console.error("[Avatar3D] load failed", err),
    );
    return () => {
      alive = false;
    };
  }, [gl]);

  useFrame((_, dtRaw) => {
    const mesh = meshRef.current;
    const grp = groupRef.current;
    const dt = Math.min(dtRaw, 0.05);
    if (grp) {
      // Gentle idle sway + look-up when thinking, tilt when listening.
      const tTilt = state === "listening" ? 0.09 : state === "thinking" ? -0.05 : 0;
      const tY = state === "thinking" ? 0.12 : 0;
      grp.rotation.z += (tTilt - grp.rotation.z) * 0.08;
      grp.rotation.y += ((Math.sin(performance.now() / 2600) * 0.05 + tY) - grp.rotation.y) * 0.06;
      grp.rotation.x += ((state === "thinking" ? -0.08 : Math.sin(performance.now() / 3400) * 0.02) - grp.rotation.x) * 0.06;
    }
    if (!mesh || !mesh.morphTargetInfluences) return;
    const infl = mesh.morphTargetInfluences;
    const d = dictRef.current;
    const set = (name: string, v: number, lerp = 0.35) => {
      const i = d[name];
      if (i !== undefined) infl[i] += (v - infl[i]) * lerp;
    };

    // Blink
    const b = blink.current;
    b.next -= dt;
    if (b.next <= 0 && !b.closing) b.closing = true;
    if (b.closing) {
      b.value += dt * 18;
      if (b.value >= 1) { b.value = 1; b.closing = false; }
    } else if (b.value > 0 && b.next <= 0) {
      b.value -= dt * 14;
      if (b.value <= 0) { b.value = 0; b.next = 1.4 + Math.random() * 3.2; }
    }
    set("eyeBlink_L", b.value, 0.6);
    set("eyeBlink_R", b.value, 0.6);

    // Lip-sync
    const talk = state === "speaking" ? Math.min(1, amplitude * 1.15) : 0;
    set("jawOpen", talk * 0.6, 0.5);
    set("mouthFunnel", talk * 0.28, 0.5);
    set("mouthClose", 0);

    // Expression by state
    const friendly = state === "idle" || state === "listening" || state === "speaking";
    set("mouthSmile_L", friendly ? 0.22 : 0);
    set("mouthSmile_R", friendly ? 0.22 : 0);
    set("browInnerUp", state === "listening" ? 0.35 : state === "speaking" ? 0.12 : 0);
    set("browDown_L", state === "thinking" ? 0.3 : 0);
    set("browDown_R", state === "thinking" ? 0.3 : 0);
    set("cheekSquint_L", friendly ? 0.15 : 0);
    set("cheekSquint_R", friendly ? 0.15 : 0);
  });

  return (
    <group ref={groupRef} visible={ready} />
  );
}

export default function Avatar3D({ state, amplitude = 0 }: Props) {
  return (
    <div className="relative w-full h-full min-h-[150px] select-none">
      <Canvas
        camera={{ position: [0, 0, 3.4], fov: 20 }}
        gl={{ antialias: true, alpha: true, toneMappingExposure: 1.0 }}
        dpr={[1, 2]}
      >
        {/* Natural studio lighting — no external HDR (offline-safe) */}
        <hemisphereLight args={["#fff3e2", "#3a322c", 0.5]} />
        <ambientLight intensity={0.2} />
        <directionalLight position={[2.5, 2.5, 3]} intensity={1.35} color="#fff1de" />
        <directionalLight position={[-3, 0.5, 1.5]} intensity={0.3} color="#e8ddd2" />
        <directionalLight position={[-1, 1.5, -3]} intensity={0.6} color="#ffcf99" />
        <Head state={state} amplitude={amplitude} />
      </Canvas>
    </div>
  );
}
