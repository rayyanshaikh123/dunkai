"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The landing page's scroll-driven board.
 *
 * `progress` is a ref in [0, 1] that the section updates on scroll. It is read
 * in useFrame, never put in state, so scrolling re-renders nothing in React.
 * Everything below is a pure function of a smoothed copy of it, which is why
 * scrolling backwards un-builds the board exactly.
 *
 * Rendered on demand: a frame is drawn when the scroll position moves, while
 * the board is still easing toward it, and at 30 fps for the idle drift of the
 * finished board. Nothing is drawn while the reader is just reading.
 *
 * Six equal bands, one per agent:
 *   0 requirements  the board outline draws itself
 *   1 architecture  subsystem blocks float above it, joined by buses
 *   2 components    blocks condense into parts and settle onto the board
 *   3 pcb           copper traces route between them
 *   4 validation    a scan plane sweeps across; parts pass green
 *   5 package       the finished board turns to face the viewer
 */

const STAGES = 6;
const BOARD = { w: 6.4, d: 4.2, t: 0.14 };
/** Radius of a sphere holding the board and the blocks floating above it. */
const FIT_RADIUS = 4.2;

/** 0 before stage `i` starts, 1 after it ends, linear in between. */
const band = (p: number, i: number) => THREE.MathUtils.clamp(p * STAGES - i, 0, 1);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

type Part = {
  id: string;
  label: string;
  color: string;
  pos: [number, number]; // x, z on the board
  size: [number, number, number];
  kind: "qfn" | "module" | "passive" | "connector" | "antenna" | "crystal";
};

const PARTS: Part[] = [
  { id: "mcu", label: "MCU", color: "#4f8cff", pos: [0, 0], size: [1.1, 0.16, 1.1], kind: "qfn" },
  { id: "radio", label: "Radio", color: "#a477f2", pos: [2.1, -1.1], size: [1.2, 0.18, 0.8], kind: "module" },
  { id: "ant", label: "Antenna", color: "#a477f2", pos: [2.75, -1.75], size: [0.5, 0.06, 0.18], kind: "antenna" },
  { id: "pwr", label: "Power", color: "#e7708b", pos: [-2.2, -1.05], size: [0.8, 0.2, 0.6], kind: "qfn" },
  { id: "usb", label: "USB-C", color: "#e7708b", pos: [-2.75, 1.25], size: [0.7, 0.32, 0.9], kind: "connector" },
  { id: "sens", label: "Sensor", color: "#36b37e", pos: [2.1, 1.15], size: [0.6, 0.12, 0.6], kind: "qfn" },
  { id: "xtal", label: "Crystal", color: "#f6b44b", pos: [-0.95, 0.95], size: [0.45, 0.14, 0.22], kind: "crystal" },
  { id: "c1", label: "C", color: "#c9a27a", pos: [-1.0, -0.7], size: [0.22, 0.12, 0.12], kind: "passive" },
  { id: "c2", label: "C", color: "#c9a27a", pos: [0.95, 0.85], size: [0.22, 0.12, 0.12], kind: "passive" },
  { id: "c3", label: "C", color: "#c9a27a", pos: [-1.55, -1.45], size: [0.22, 0.12, 0.12], kind: "passive" },
  { id: "r1", label: "R", color: "#2b2b2b", pos: [1.0, -0.75], size: [0.22, 0.1, 0.12], kind: "passive" },
];

const BUSES: Array<[string, string]> = [
  ["mcu", "radio"],
  ["mcu", "sens"],
  ["pwr", "mcu"],
  ["usb", "pwr"],
  ["xtal", "mcu"],
];

/** Manhattan routes, as polylines on the board plane. Drawn in order. */
const TRACES: Array<Array<[number, number]>> = [
  [[0.55, -0.2], [1.2, -0.2], [1.2, -1.1], [1.5, -1.1]],
  [[0.55, 0.2], [1.4, 0.2], [1.4, 1.15], [1.8, 1.15]],
  [[-1.8, -1.05], [-1.2, -1.05], [-1.2, -0.3], [-0.55, -0.3]],
  [[-2.4, 1.25], [-2.4, 0.2], [-2.2, 0.2], [-2.2, -0.75]],
  [[-0.72, 0.95], [-0.3, 0.95], [-0.3, 0.55]],
  [[0.2, 0.55], [0.2, 0.85], [0.84, 0.85]],
  [[2.7, -1.1], [2.75, -1.1], [2.75, -1.62]],
  [[-0.2, -0.55], [-0.2, -0.7], [-0.89, -0.7]],
  [[0.3, -0.55], [0.3, -0.75], [0.89, -0.75]],
  [[-1.55, -1.34], [-1.55, -1.05]],
  [[2.4, 1.15], [2.9, 1.15], [2.9, -0.6], [2.4, -0.6], [2.4, -0.7]],
];

type Segment = { a: THREE.Vector2; b: THREE.Vector2; start: number; end: number };

/** Flatten the routes into segments, each owning a slice of the routing band. */
function buildSegments(): Segment[] {
  const raw: Array<{ a: THREE.Vector2; b: THREE.Vector2; len: number }> = [];
  for (const route of TRACES) {
    for (let i = 0; i < route.length - 1; i++) {
      const a = new THREE.Vector2(...route[i]);
      const b = new THREE.Vector2(...route[i + 1]);
      raw.push({ a, b, len: a.distanceTo(b) });
    }
  }
  const total = raw.reduce((sum, s) => sum + s.len, 0);
  let acc = 0;
  return raw.map((s) => {
    const start = acc / total;
    acc += s.len;
    return { a: s.a, b: s.b, start, end: acc / total };
  });
}

function useThemeColors() {
  // Read once per mount; the section remounts the canvas on theme change.
  return useMemo(() => {
    const dark = typeof document !== "undefined" && !document.documentElement.classList.contains("light");
    return {
      dark,
      mask: dark ? "#14324f" : "#1f4f7a",
      outline: dark ? "#8ab4f8" : "#3b6cf6",
      copper: "#e9b65c",
      chip: "#1d1f24",
      pin: "#c8ccd4",
      pass: "#36b37e",
      scan: dark ? "#8ab4f8" : "#3b6cf6",
    };
  }, []);
}

function Board({ progress, reducedMotion }: { progress: MutableRefObject<number>; reducedMotion: boolean }) {
  const colors = useThemeColors();
  const smooth = useRef(0);
  const root = useRef<THREE.Group>(null);
  const substrate = useRef<THREE.Mesh>(null);
  const outline = useRef<THREE.Line>(null);
  const blocks = useRef<Array<THREE.Mesh | null>>([]);
  const parts = useRef<Array<THREE.Group | null>>([]);
  const partBodies = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const buses = useRef<Array<THREE.Mesh | null>>([]);
  const traces = useRef<Array<THREE.Mesh | null>>([]);
  const scan = useRef<THREE.Mesh>(null);
  const holes = useRef<Array<THREE.MeshStandardMaterial | null>>([]);
  const { camera, size } = useThree();

  const segments = useMemo(buildSegments, []);
  const partIndex = useMemo(() => Object.fromEntries(PARTS.map((p, i) => [p.id, i])), []);

  const outlineGeometry = useMemo(() => {
    const hw = BOARD.w / 2;
    const hd = BOARD.d / 2;
    const r = 0.25;
    const shape = new THREE.Shape();
    shape.moveTo(-hw + r, -hd);
    shape.lineTo(hw - r, -hd);
    shape.quadraticCurveTo(hw, -hd, hw, -hd + r);
    shape.lineTo(hw, hd - r);
    shape.quadraticCurveTo(hw, hd, hw - r, hd);
    shape.lineTo(-hw + r, hd);
    shape.quadraticCurveTo(-hw, hd, -hw, hd - r);
    shape.lineTo(-hw, -hd + r);
    shape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
    const pts = shape.getSpacedPoints(240).map((p) => new THREE.Vector3(p.x, BOARD.t / 2 + 0.01, p.y));
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  const outlineLine = useMemo(
    () => new THREE.Line(outlineGeometry, new THREE.LineBasicMaterial({ color: colors.outline, transparent: true })),
    [outlineGeometry, colors.outline]
  );

  const camFrom = useMemo(() => new THREE.Vector3(), []);
  const camTo = useMemo(() => new THREE.Vector3(), []);
  const lookAt = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  // One viewing DIRECTION per stage, eased between. Distance is not part of
  // the pose: it is solved per frame so the whole board fits the canvas.
  const poses = useMemo(
    () =>
      [
        [0, 9, 4],
        [-4.2, 5.4, 6.2],
        [-2.2, 4.6, 6.4],
        [0.6, 6.8, 3.6],
        [3.8, 4.4, 5.6],
        [5.6, 3.4, 6.8],
      ].map(([x, y, z]) => new THREE.Vector3(x, y, z).normalize()),
    []
  );

  const { invalidate } = useThree();
  const lastMotion = useRef(0);
  useEffect(() => {
    let lastInput = performance.now();
    const kick = () => {
      lastInput = performance.now();
      invalidate();
    };
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", kick);
    // The finished board drifts gently at 30 fps, pausing 4 s after the last scroll.
    const idle = reducedMotion
      ? 0
      : window.setInterval(
          () => smooth.current * STAGES > STAGES - 1 && performance.now() - lastInput < 4000 && invalidate(),
          33
        );
    invalidate();
    return () => {
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", kick);
      window.clearInterval(idle);
    };
  }, [invalidate, reducedMotion]);

  useFrame((state, delta) => {
    // Critically damped follow of the scroll position: smooth, never overshoots.
    smooth.current = THREE.MathUtils.damp(smooth.current, progress.current, 6, delta);
    // Keep drawing while easing, and briefly after, so damped colour fades settle.
    const now = performance.now();
    if (Math.abs(progress.current - smooth.current) > 1e-4) lastMotion.current = now;
    if (now - lastMotion.current < 700) state.invalidate();
    const p = smooth.current;
    const s = Array.from({ length: STAGES }, (_, i) => band(p, i));

    // Camera direction: between the pose of the current stage and the next.
    const x = p * (STAGES - 1);
    const i0 = Math.min(Math.floor(x), STAGES - 2);
    camFrom.copy(poses[i0]);
    camTo.copy(poses[i0 + 1]);
    camera.position.lerpVectors(camFrom, camTo, ease(THREE.MathUtils.clamp(x - i0, 0, 1))).normalize();

    // Distance: far enough that a sphere around the board and the floating
    // blocks fits the narrower of the two fields of view, plus a margin. The
    // board can then never spill past the canvas edge, at any aspect ratio.
    if (camera instanceof THREE.PerspectiveCamera) {
      const aspect = size.width / Math.max(size.height, 1);
      const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
      const halfH = Math.atan(Math.tan(halfV) * aspect);
      camera.position.multiplyScalar((FIT_RADIUS / Math.sin(Math.min(halfV, halfH))) * 1.06);
    }
    camera.lookAt(lookAt);

    if (root.current) {
      // Idle drift in the last stage only, and never with reduced motion.
      const idle = reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 0.4) * 0.12 * s[5];
      root.current.rotation.y = idle + s[5] * 0.35;
      root.current.position.y = ease(s[5]) * 0.25;
    }

    // 0 · outline draws itself, substrate fills in during components.
    // Ease-out, so the line is visibly moving from the first pixel of scroll.
    outlineLine.geometry.setDrawRange(0, Math.floor(241 * (1 - Math.pow(1 - s[0], 2))));
    holes.current.forEach((m) => m && (m.opacity = ease(s[0])));
    (outlineLine.material as THREE.LineBasicMaterial).opacity = 1 - 0.6 * s[3];
    if (substrate.current) {
      const m = substrate.current.material as THREE.MeshStandardMaterial;
      // The fill trails the outline, so stage 0 is a line drawing, not a grey slab.
      m.opacity = 0.05 * ease(THREE.MathUtils.clamp(s[0] * 2 - 1, 0, 1)) + 0.95 * ease(s[2]);
    }

    // 1 · architecture blocks rise, 2 · they shrink away as parts arrive.
    PARTS.forEach((part, i) => {
      const block = blocks.current[i];
      if (block) {
        const appear = ease(THREE.MathUtils.clamp(s[1] * 1.4 - (i % 6) * 0.08, 0, 1));
        const vanish = ease(s[2]);
        const k = appear * (1 - vanish);
        block.visible = k > 0.001;
        block.scale.setScalar(Math.max(k, 0.001));
        block.position.y = 1.4 + Math.sin(state.clock.elapsedTime * 1.2 + i) * 0.05 * (reducedMotion ? 0 : 1);
      }
      const group = parts.current[i];
      if (group) {
        const settle = ease(THREE.MathUtils.clamp(s[2] * 1.5 - (i % 5) * 0.1, 0, 1));
        group.visible = settle > 0.001;
        group.scale.setScalar(Math.max(settle, 0.001));
        // Exploded lift in the final stage, so the package reads as parts.
        group.position.y = BOARD.t / 2 + (1 - settle) * 1.4 + ease(s[5]) * 0.18 * (part.kind === "passive" ? 0.4 : 1);
      }
      const body = partBodies.current[i];
      if (body) {
        // 4 · the scan plane passes over a part -> it flashes green, then settles.
        const scanX = THREE.MathUtils.lerp(-BOARD.w / 2 - 0.4, BOARD.w / 2 + 0.4, s[4]);
        const passed = s[4] > 0 && scanX > part.pos[0];
        const target = passed && s[5] < 0.5 ? 0.55 : 0;
        body.emissiveIntensity = THREE.MathUtils.damp(body.emissiveIntensity, target, 5, delta);
      }
    });

    BUSES.forEach((_, i) => {
      const bus = buses.current[i];
      if (!bus) return;
      const k = ease(THREE.MathUtils.clamp(s[1] * 1.6 - 0.5 - i * 0.08, 0, 1)) * (1 - ease(s[2]));
      bus.visible = k > 0.001;
      bus.scale.set(1, 1, Math.max(k, 0.001));
    });

    // 3 · copper routes, one segment after another.
    segments.forEach((seg, i) => {
      const mesh = traces.current[i];
      if (!mesh) return;
      const t = THREE.MathUtils.clamp((s[3] - seg.start) / Math.max(seg.end - seg.start, 1e-3), 0, 1);
      mesh.visible = t > 0;
      const len = seg.a.distanceTo(seg.b) * t;
      const dir = seg.b.clone().sub(seg.a).normalize();
      mesh.scale.x = Math.max(len, 0.0001);
      mesh.position.set(seg.a.x + (dir.x * len) / 2, BOARD.t / 2 + 0.006, seg.a.y + (dir.y * len) / 2);
    });

    // 4 · scan plane.
    if (scan.current) {
      scan.current.visible = s[4] > 0 && s[4] < 1;
      scan.current.position.x = THREE.MathUtils.lerp(-BOARD.w / 2 - 0.4, BOARD.w / 2 + 0.4, s[4]);
    }
  });

  return (
    <group ref={root}>
      <mesh ref={substrate}>
        <boxGeometry args={[BOARD.w, BOARD.t, BOARD.d]} />
        <meshStandardMaterial color={colors.mask} roughness={0.55} metalness={0.1} transparent opacity={0} />
      </mesh>
      <primitive object={outlineLine} ref={outline} />

      {/* Mounting holes */}
      {[
        [-BOARD.w / 2 + 0.35, -BOARD.d / 2 + 0.35],
        [BOARD.w / 2 - 0.35, -BOARD.d / 2 + 0.35],
        [-BOARD.w / 2 + 0.35, BOARD.d / 2 - 0.35],
        [BOARD.w / 2 - 0.35, BOARD.d / 2 - 0.35],
      ].map(([x, z], i) => (
        <mesh key={`${x}${z}`} position={[x, BOARD.t / 2 + 0.002, z]} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[0.1, 0.17, 24]} />
          <meshStandardMaterial ref={(m) => { holes.current[i] = m; }} color={colors.copper} metalness={0.8} roughness={0.3} transparent opacity={0} />
        </mesh>
      ))}

      {/* Architecture blocks */}
      {PARTS.filter((p) => p.kind !== "passive").map((part) => {
        const i = partIndex[part.id];
        return (
          <mesh key={`block-${part.id}`} ref={(m) => { blocks.current[i] = m; }} position={[part.pos[0], 1.4, part.pos[1]]}>
            <boxGeometry args={[Math.max(part.size[0], 0.6), 0.35, Math.max(part.size[2], 0.5)]} />
            <meshStandardMaterial color={part.color} transparent opacity={0.85} roughness={0.25} emissive={part.color} emissiveIntensity={0.35} />
          </mesh>
        );
      })}

      {/* Buses between blocks */}
      {BUSES.map(([from, to], i) => {
        const a = PARTS[partIndex[from]].pos;
        const b = PARTS[partIndex[to]].pos;
        const va = new THREE.Vector3(a[0], 1.4, a[1]);
        const vb = new THREE.Vector3(b[0], 1.4, b[1]);
        const mid = va.clone().add(vb).multiplyScalar(0.5);
        const len = va.distanceTo(vb);
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), vb.clone().sub(va).normalize());
        return (
          <mesh key={`bus-${from}-${to}`} ref={(m) => { buses.current[i] = m; }} position={mid} quaternion={quat}>
            <boxGeometry args={[0.035, 0.035, len]} />
            <meshBasicMaterial color={colors.outline} transparent opacity={0.8} />
          </mesh>
        );
      })}

      {/* Parts */}
      {PARTS.map((part, i) => (
        <group key={part.id} ref={(g) => { parts.current[i] = g; }} position={[part.pos[0], BOARD.t / 2, part.pos[1]]}>
          <PartBody part={part} colors={colors} bodyRef={(m) => { partBodies.current[i] = m; }} />
        </group>
      ))}

      {/* Copper */}
      {segments.map((seg, i) => {
        const angle = -Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x);
        return (
          <mesh key={i} ref={(m) => { traces.current[i] = m; }} rotation-y={angle} visible={false}>
            <boxGeometry args={[1, 0.012, 0.07]} />
            <meshStandardMaterial color={colors.copper} metalness={0.85} roughness={0.28} emissive={colors.copper} emissiveIntensity={0.15} />
          </mesh>
        );
      })}

      {/* Validation scan */}
      <mesh ref={scan} visible={false} position={[0, 0.45, 0]}>
        <boxGeometry args={[0.03, 0.9, BOARD.d + 0.5]} />
        <meshBasicMaterial color={colors.scan} transparent opacity={0.55} />
      </mesh>
    </group>
  );
}

function PartBody({
  part,
  colors,
  bodyRef,
}: {
  part: Part;
  colors: ReturnType<typeof useThemeColors>;
  bodyRef: (m: THREE.MeshStandardMaterial | null) => void;
}) {
  const [w, h, d] = part.size;
  const bodyColor =
    part.kind === "passive" ? part.color : part.kind === "connector" ? "#9aa3ad" : part.kind === "antenna" ? "#c9a24a" : colors.chip;

  // QFN-style pins along each edge of chips and modules.
  const pins: Array<[number, number, number, number]> = [];
  if (part.kind === "qfn" || part.kind === "module") {
    const per = Math.max(3, Math.round(w / 0.16));
    for (let k = 0; k < per; k++) {
      const t = -w / 2 + ((k + 0.5) * w) / per;
      pins.push([t, d / 2 + 0.04, 0.05, 0.08], [t, -d / 2 - 0.04, 0.05, 0.08]);
      pins.push([w / 2 + 0.04, t * (d / w), 0.08, 0.05], [-w / 2 - 0.04, t * (d / w), 0.08, 0.05]);
    }
  }

  // One mesh for all of a part's pins instead of one per pin: ~100 fewer draw
  // calls across the board, for an identical picture.
  const pinGeometry = useMemo(() => {
    if (!pins.length) return null;
    return mergeGeometries(
      pins.map(([x, z, pw, pd]) => new THREE.BoxGeometry(pw, 0.02, pd).translate(x, 0.01, z))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part.id]);
  useEffect(() => () => pinGeometry?.dispose(), [pinGeometry]);

  return (
    <group>
      <mesh position-y={h / 2}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial
          ref={bodyRef}
          color={bodyColor}
          roughness={part.kind === "connector" ? 0.3 : 0.6}
          metalness={part.kind === "connector" || part.kind === "antenna" ? 0.7 : 0.05}
          emissive={colors.pass}
          emissiveIntensity={0}
        />
      </mesh>
      {part.kind === "qfn" && (
        // Pin-1 dot and a coloured die mark, so each chip reads as its subsystem.
        <mesh position={[-w / 2 + 0.14, h + 0.002, -d / 2 + 0.14]} rotation-x={-Math.PI / 2}>
          <circleGeometry args={[0.05, 16]} />
          <meshBasicMaterial color={part.color} />
        </mesh>
      )}
      {part.kind === "module" && (
        <mesh position-y={h + 0.002} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[w * 0.7, d * 0.6]} />
          <meshStandardMaterial color="#c9ced6" metalness={0.9} roughness={0.25} />
        </mesh>
      )}
      {part.kind === "passive" &&
        [-1, 1].map((side) => (
          <mesh key={side} position={[(side * w) / 2.6, h / 2, 0]}>
            <boxGeometry args={[w / 4, h * 1.05, d * 1.05]} />
            <meshStandardMaterial color={colors.pin} metalness={0.9} roughness={0.3} />
          </mesh>
        ))}
      {pinGeometry && (
        <mesh geometry={pinGeometry}>
          <meshStandardMaterial color={colors.pin} metalness={0.9} roughness={0.3} />
        </mesh>
      )}
    </group>
  );
}

export default function PcbScene({
  progress,
  active,
  reducedMotion,
}: {
  progress: MutableRefObject<number>;
  /** False while the section is off screen: rendering stops entirely. */
  active: boolean;
  reducedMotion: boolean;
}) {
  return (
    <Canvas
      frameloop={active ? "demand" : "never"}
      dpr={typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 1.5)}
      style={{ pointerEvents: "none" }}
      camera={{ position: [0, 7.8, 0.01], fov: 38, near: 0.1, far: 100 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          3D preview needs WebGL.
        </div>
      }
    >
      <hemisphereLight args={["#ffffff", "#334", 0.9]} />
      <directionalLight position={[4, 8, 5]} intensity={1.6} />
      <directionalLight position={[-6, 4, -4]} intensity={0.5} color="#a6b8ff" />
      <Board progress={progress} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
