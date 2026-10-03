import { useLayoutEffect, useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { interpolate } from "remotion";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { clamp, ease, pop } from "./design";

const layout = [
  {
    id: "U1",
    x: -1.05,
    y: 0.15,
    w: 0.9,
    h: 0.9,
    title: "PROCESSING",
    color: "#3b384a",
  },
  {
    id: "U2",
    x: 1.5,
    y: 0.95,
    w: 1.05,
    h: 0.72,
    title: "WI-FI",
    color: "#304050",
  },
  {
    id: "U7",
    x: 1.6,
    y: -1,
    w: 0.6,
    h: 0.62,
    title: "TEMPERATURE",
    color: "#443c36",
  },
  {
    id: "U9",
    x: -2,
    y: -1,
    w: 0.55,
    h: 0.58,
    title: "HUMIDITY",
    color: "#334438",
  },
];
function Environment() {
  const { gl, scene } = useThree();
  useLayoutEffect(() => {
    const room = new RoomEnvironment(),
      generator = new THREE.PMREMGenerator(gl),
      env = generator.fromScene(room, 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.5;
    return () => {
      scene.environment = null;
      env.dispose();
      generator.dispose();
      room.dispose();
    };
  }, [gl, scene]);
  return null;
}
function rounded(w: number, h: number, r: number) {
  const s = new THREE.Shape(),
    x = -w / 2,
    y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function Silkscreen({
  text,
  x,
  y,
  width = 1,
}: {
  text: string;
  x: number;
  y: number;
  width?: number;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "28px monospace";
    ctx.fillStyle = "#bdc6cf";
    ctx.textAlign = "center";
    ctx.fillText(text, 256, 58);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [text]);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[x, y, 0.125]}>
      <planeGeometry args={[width, 0.18]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}
function Package({
  part,
  index,
  f,
}: {
  part: (typeof layout)[number];
  index: number;
  f: number;
}) {
  const p = pop(f, 8 + index * 11);
  return (
    <group
      position={[part.x, part.y, 0.12 + (1 - p) * 1.2]}
      scale={Math.max(0.001, p)}
    >
      <mesh castShadow>
        <boxGeometry args={[part.w, part.h, 0.16]} />
        <meshPhysicalMaterial
          color={part.color}
          roughness={0.23}
          metalness={0.16}
          clearcoat={1}
        />
      </mesh>
      <mesh position={[0, 0, 0.085]}>
        <boxGeometry args={[part.w * 0.88, part.h * 0.88, 0.018]} />
        <meshPhysicalMaterial
          color={part.color}
          roughness={0.2}
          clearcoat={1}
        />
      </mesh>
      {[0, 1, 2, 3].map((side) => (
        <group key={side} rotation={[0, 0, (side * Math.PI) / 2]}>
          {Array.from({ length: 8 }, (_, j) => (
            <mesh
              key={j}
              position={[
                -part.w * 0.35 + j * part.w * 0.1,
                part.h / 2 + 0.045,
                -0.015,
              ]}
              castShadow
            >
              <boxGeometry args={[0.033, 0.12, 0.045]} />
              <meshStandardMaterial
                color="#dad6df"
                metalness={0.8}
                roughness={0.18}
              />
            </mesh>
          ))}
        </group>
      ))}
      <Silkscreen text={part.id} x={0} y={0} width={part.w * 0.8} />
    </group>
  );
}
function Route({ i, f }: { i: number; f: number }) {
  const end = i % 3,
    p = layout[end === 0 ? 1 : end === 1 ? 2 : 3],
    offset = Math.floor(i / 3) * 0.035;
  const a = new THREE.Vector3(end === 2 ? -1.5 : -0.6, 0.4 - i * 0.028, 0.15),
    b = new THREE.Vector3(end === 2 ? -2.5 : -0.05 + i * 0.035, a.y, 0.15),
    c = new THREE.Vector3(b.x, p.y - 0.15 + offset, 0.15),
    d = new THREE.Vector3(p.x + (end === 2 ? -0.2 : -p.w / 2), c.y, 0.15),
    points = [a, b, c, d];
  const progress = ease(f, 22 + i * 2.4, 52 + i * 2.4),
    total = a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(d);
  let covered = 0;
  return (
    <group>
      {points.slice(0, -1).map((v, j) => {
        const next = points[j + 1],
          length = v.distanceTo(next),
          visible = Math.min(length, Math.max(0, progress * total - covered));
        covered += length;
        const center = v.clone().lerp(next, visible / (length * 2));
        return (
          <mesh
            key={j}
            position={center}
            rotation={[0, 0, Math.atan2(next.y - v.y, next.x - v.x)]}
          >
            <boxGeometry args={[Math.max(0.001, visible), 0.012, 0.008]} />
            <meshStandardMaterial
              color={i % 5 === 0 ? "#8ab4f8" : "#c5a06b"}
              metalness={0.65}
              roughness={0.3}
            />
          </mesh>
        );
      })}
    </group>
  );
}
export const BoardCinema = ({ f }: { f: number }) => {
  const shape = useMemo(() => rounded(6, 3.6, 0.22), []);
  const options = useMemo(
    () => ({
      depth: 0.09,
      bevelEnabled: true,
      bevelSegments: 4,
      steps: 1,
      bevelSize: 0.035,
      bevelThickness: 0.025,
    }),
    [],
  );
  const zoom = interpolate(
    f,
    [0, 65, 92, 110, 145, 210],
    [0.95, 1.03, 1.06, 1.35, 1.04, 1.09],
    clamp,
  );
  const rx = interpolate(
      f,
      [0, 45, 92, 110, 145, 210],
      [1.04, 0.4, 0.3, 0.12, 0.37, 0.25],
      clamp,
    ),
    ry = interpolate(
      f,
      [0, 45, 92, 110, 145, 210],
      [-0.7, -0.2, 0.05, -0.12, 0.2, 0.42],
      clamp,
    );
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 280,
        width: 1920,
        height: 740,
      }}
    >
      <ThreeCanvas
        width={1920}
        height={740}
        dpr={2}
        shadows
        camera={{ position: [0, 0, 6.8], fov: 36, near: 0.1, far: 60 }}
        gl={{ alpha: true, antialias: true }}
      >
        <Environment />
        <ambientLight intensity={0.3} />
        <directionalLight
          position={[3, 4, 8]}
          intensity={1.4}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight
          position={[-4, 0, 5]}
          intensity={0.6}
          color="#e4d9ff"
        />
        <directionalLight
          position={[0, -4, 3]}
          intensity={0.7}
          color="#d3ece4"
        />
        <group
          position={[
            interpolate(f, [92, 110, 145], [0, 0.65, 0], clamp),
            -0.05,
            0,
          ]}
          scale={zoom}
          rotation={[rx, ry, -0.07]}
        >
          <mesh castShadow receiveShadow>
            <extrudeGeometry args={[shape, options]} />
            <meshPhysicalMaterial
              color="#1b2b32"
              metalness={0.07}
              roughness={0.27}
              clearcoat={1}
              clearcoatRoughness={0.12}
            />
          </mesh>
          <mesh position={[0, 0, -0.04]}>
            <extrudeGeometry args={[shape, { ...options, depth: 0.018 }]} />
            <meshStandardMaterial
              color="#243c42"
              metalness={0.3}
              roughness={0.3}
            />
          </mesh>
          {Array.from({ length: 24 }, (_, i) => (
            <Route key={i} i={i} f={f} />
          ))}
          {layout.map((part, i) => (
            <group key={part.id}>
              <Package part={part} index={i} f={f} />
              <Silkscreen
                text={part.id + " / " + part.title}
                x={part.x}
                y={part.y - part.h / 2 - 0.22}
                width={1.15}
              />
            </group>
          ))}
          {[-2.73, 2.73].flatMap((x) =>
            [-1.53, 1.53].map((y) => (
              <group key={x + "," + y} position={[x, y, 0.1]}>
                <mesh>
                  <torusGeometry args={[0.082, 0.028, 10, 24]} />
                  <meshStandardMaterial
                    color="#cacdd5"
                    roughness={0.18}
                    metalness={0.8}
                  />
                </mesh>
                <mesh position={[0, 0, -0.012]}>
                  <circleGeometry args={[0.055, 24]} />
                  <meshBasicMaterial color="#0f1014" />
                </mesh>
              </group>
            )),
          )}
          <Silkscreen
            text="DUNK AI / SYSTEM BOARD"
            x={-0.8}
            y={-1.48}
            width={2.3}
          />
          {Array.from({ length: 12 }, (_, i) => (
            <mesh
              key={i}
              position={[
                -0.65 + (i % 4) * 0.23,
                0.9 + Math.floor(i / 4) * 0.2,
                0.14,
              ]}
            >
              <boxGeometry args={[0.1, 0.045, 0.06]} />
              <meshStandardMaterial
                color={i % 2 ? "#ddd4e7" : "#b69a7b"}
                metalness={0.4}
                roughness={0.35}
              />
            </mesh>
          ))}
        </group>
      </ThreeCanvas>
    </div>
  );
};
