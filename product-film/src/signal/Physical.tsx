import { useLayoutEffect, useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { C, Field, Tag, k, land, ramp, useF } from "./motion";
const positions = [
  [-1.1, 0.2, 0.92, 0.92],
  [1.45, 0.9, 1.04, 0.7],
  [1.7, -1, 0.58, 0.58],
  [-2, -0.9, 0.55, 0.55],
];
function Environment() {
  const { gl, scene } = useThree();
  useLayoutEffect(() => {
    const room = new RoomEnvironment(),
      p = new THREE.PMREMGenerator(gl),
      map = p.fromScene(room, 0.03);
    scene.environment = map.texture;
    scene.environmentIntensity = 0.65;
    return () => {
      scene.environment = null;
      map.dispose();
      room.dispose();
      p.dispose();
    };
  }, [gl, scene]);
  return null;
}
function Engraving() {
  const texture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 1536;
    c.height = 1024;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#b7c4d1";
    ctx.font = "22px monospace";
    ctx.fillText("DUNK AI  /  ENGINEERING IN MOTION", 160, 945);
    [
      "U1  MC9S08DZ32ACLC",
      "U2  ESPC2-12-N4",
      "U7  MCP9808",
      "U9  HDC2010",
    ].forEach((s, i) =>
      ctx.fillText(
        s,
        768 + positions[i][0] * 256 - 110,
        512 - positions[i][1] * 284 + 155,
      ),
    );
    ctx.strokeStyle = "#718190";
    ctx.lineWidth = 2;
    positions.forEach(([x, y, w, h]) =>
      ctx.strokeRect(
        768 + x * 256 - w * 144,
        512 - y * 284 - h * 164,
        w * 288,
        h * 328,
      ),
    );
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  useLayoutEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[0, 0, 0.116]}>
      <planeGeometry args={[6, 3.6]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}
function Trace({ i, f }: { i: number; f: number }) {
  const destination = positions[1 + (i % 3)],
    offset = Math.floor(i / 3) * 0.038,
    pts = [
      [-0.62, 0.5 - i * 0.035],
      [-0.2 + offset, 0.5 - i * 0.035],
      [-0.2 + offset, destination[1] + offset - 0.15],
      [destination[0], destination[1] + offset - 0.15],
    ],
    draw = land(f, 75 + i * 1.7, 118 + i * 1.7);
  return (
    <group>
      {pts.slice(0, -1).map(([x, y], j) => {
        const [nx, ny] = pts[j + 1],
          length = Math.hypot(nx - x, ny - y),
          progress = Math.min(1, Math.max(0, draw * 3 - j));
        return (
          <mesh
            key={j}
            position={[
              x + ((nx - x) * progress) / 2,
              y + ((ny - y) * progress) / 2,
              0.121,
            ]}
            rotation={[0, 0, Math.atan2(ny - y, nx - x)]}
          >
            <boxGeometry
              args={[Math.max(0.001, length * progress), 0.009, 0.006]}
            />
            <meshStandardMaterial
              color={i % 4 ? "#c6a677" : C.blue}
              metalness={0.85}
              roughness={0.27}
              emissive={i % 4 ? "#000000" : C.blue}
              emissiveIntensity={0.15}
            />
          </mesh>
        );
      })}
    </group>
  );
}
export const Physical = () => {
  const f = useF(),
    assemble = land(f, 0, 85),
    dive = ramp(f, 288, 360);
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-2.85, -1.8);
    s.lineTo(2.85, -1.8);
    s.quadraticCurveTo(3, -1.8, 3, -1.65);
    s.lineTo(3, 1.65);
    s.quadraticCurveTo(3, 1.8, 2.85, 1.8);
    s.lineTo(-2.85, 1.8);
    s.quadraticCurveTo(-3, 1.8, -3, 1.65);
    s.lineTo(-3, -1.65);
    s.quadraticCurveTo(-3, -1.8, -2.85, -1.8);
    return s;
  }, []);
  return (
    <Field>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 52%,#232d3b 0%,#0f1014 65%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 70,
          fontSize: 86,
          fontWeight: 650,
          letterSpacing: -6,
          translate: `0 ${k(f, [0, 35, 140, 175], [60, 0, 0, -220])}px`,
          opacity: land(f, 0, 25),
        }}
      >
        Data. <span style={{ color: C.blue }}>Made physical.</span>
      </div>
      <ThreeCanvas
        width={1920}
        height={1080}
        dpr={2}
        camera={{ position: [0, 0, 8], fov: 40, near: 0.1, far: 100 }}
        gl={{ alpha: true, antialias: true }}
      >
        <Environment />
        <ambientLight intensity={0.35} />
        <directionalLight position={[2, 5, 7]} intensity={2.2} />
        <directionalLight
          position={[-5, -2, 4]}
          intensity={1.1}
          color="#8ab4f8"
        />
        <group
          position={[
            k(f, [0, 80, 145, 195, 255, 360], [0.3, 0.8, 0.8, 0.4, 0.2, 8]),
            k(f, [0, 80, 220, 360], [-0.2, -0.55, -0.3, -1.5]),
            0,
          ]}
          rotation={[
            k(f, [0, 80, 150, 185, 245, 360], [1.15, 0.5, 0.4, 0.12, 0.38, 0]),
            k(
              f,
              [0, 80, 150, 185, 245, 360],
              [-0.3, -0.2, -0.1, 0.18, 0.35, 0],
            ),
            k(f, [0, 100, 240, 360], [-0.3, -0.12, 0.12, 0]),
          ]}
          scale={k(
            f,
            [0, 70, 150, 178, 230, 280, 360],
            [0.85, 1, 1.02, 1.3, 1.04, 1.05, 7.4],
          )}
        >
          {[0, 1, 2, 3].map((i) => (
            <mesh
              key={i}
              position={[0, 0, -i * 0.055 - (1 - assemble) * i * 0.5]}
            >
              <extrudeGeometry
                args={[
                  shape,
                  {
                    depth: 0.07,
                    bevelEnabled: true,
                    bevelSize: 0.025,
                    bevelThickness: 0.015,
                    bevelSegments: 3,
                    steps: 1,
                  },
                ]}
              />
              <meshPhysicalMaterial
                color={i === 0 ? "#172a31" : i % 2 ? "#ad8b5e" : "#263a41"}
                metalness={i % 2 ? 0.65 : 0.15}
                roughness={0.25}
                clearcoat={1}
              />
            </mesh>
          ))}
          <Engraving />
          {Array.from({ length: 30 }, (_, i) => (
            <Trace key={i} i={i} f={f} />
          ))}
          {positions.map(([x, y, w, h], i) => {
            const drop = land(f, 26 + i * 12, 65 + i * 12);
            return (
              <group
                key={i}
                position={[x, y, 0.18 + (1 - drop) * 2]}
                rotation={[0, (1 - drop) * 0.7, 0]}
                scale={Math.max(0.001, drop)}
              >
                <mesh>
                  <boxGeometry args={[w, h, 0.17]} />
                  <meshPhysicalMaterial
                    color="#22262e"
                    roughness={0.21}
                    metalness={0.3}
                    clearcoat={1}
                  />
                </mesh>
                <mesh position={[0, 0, 0.09]}>
                  <boxGeometry args={[w * 0.85, h * 0.85, 0.02]} />
                  <meshStandardMaterial
                    color="#323941"
                    metalness={0.15}
                    roughness={0.3}
                  />
                </mesh>
                {[0, 1, 2, 3].map((side) => (
                  <group key={side} rotation={[0, 0, (side * Math.PI) / 2]}>
                    {Array.from({ length: 10 }, (_, n) => (
                      <mesh
                        key={n}
                        position={[
                          -w * 0.4 + n * w * 0.088,
                          h / 2 + 0.07,
                          -0.015,
                        ]}
                      >
                        <boxGeometry args={[0.028, 0.14, 0.035]} />
                        <meshStandardMaterial
                          color="#dce5ee"
                          metalness={0.9}
                          roughness={0.2}
                        />
                      </mesh>
                    ))}
                  </group>
                ))}
              </group>
            );
          })}
          {Array.from({ length: 30 }, (_, i) => (
            <mesh
              key={i}
              position={[
                -0.5 + (i % 6) * 0.2,
                0.9 + Math.floor(i / 6) * 0.12,
                0.14,
              ]}
            >
              <boxGeometry args={[0.09, 0.045, 0.05]} />
              <meshStandardMaterial
                color={i % 2 ? "#bca682" : "#a7b4c6"}
                metalness={0.6}
                roughness={0.25}
              />
            </mesh>
          ))}
          {[-2.72, 2.72].flatMap((x) =>
            [-1.52, 1.52].map((y) => (
              <mesh key={`${x},${y}`} position={[x, y, 0.12]}>
                <torusGeometry args={[0.075, 0.023, 8, 24]} />
                <meshStandardMaterial
                  color="#dadfe6"
                  metalness={0.95}
                  roughness={0.16}
                />
              </mesh>
            )),
          )}
        </group>
      </ThreeCanvas>
      <Tag style={{ top: "auto", bottom: 78, opacity: 1 - dive }}>
        03 / PCB DESIGN{" "}
        <span style={{ color: C.blue }}>— 4 LAYERS / 100 × 60 MM</span>
      </Tag>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: C.bg,
          opacity: ramp(f, 349, 360),
        }}
      />
    </Field>
  );
};
