import { AnimatedImage, staticFile } from "remotion";
import { C, Field, Tag, glass, k, land, mono, ramp, useF } from "./motion";
const code = [
  "#include <Wire.h>",
  "#include <WiFi.h>",
  "",
  "void setup() {",
  "  Wire.begin();",
  "  sensors.begin();",
  "  network.connect();",
  "}",
  "",
  "void loop() {",
  "  auto reading = sensors.sample();",
  "  network.publish(reading);",
  "  delay(1000);",
  "}",
];
export const Logic = () => {
  const f = useF(),
    fold = ramp(f, 177, 247);
  return (
    <Field>
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 80,
          fontSize: 112,
          fontWeight: 650,
          letterSpacing: -6,
          clipPath: `inset(0 ${100 * (1 - land(f, 4, 35))}% 0 0)`,
          translate: `${-fold * 1600}px 0`,
        }}
      >
        Give it <span style={{ color: C.blue }}>logic.</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 370,
          top: 300,
          width: 1400,
          height: 680,
          transformOrigin: "center",
          transform: `perspective(1800px) rotateY(${k(f, [0, 45, 170, 250], [-28, -8, -8, 75])}deg) rotateZ(${-fold * 15}deg)`,
          scale: k(f, [0, 50, 160, 270], [1.5, 1, 1, 0.08]),
          translate: `${fold * 250}px ${-fold * 180}px`,
          filter: `blur(${Math.sin(fold * Math.PI) * 2}px)`,
        }}
      >
        <div style={{ ...mono, color: C.gray, fontSize: 22, marginBottom: 35 }}>
          main.cpp <span style={{ color: C.blue }}> / FIRMWARE</span>
        </div>
        {code.map((line, i) => {
          const p = land(f, 16 + i * 6, 30 + i * 6);
          return (
            <div
              key={i}
              style={{
                fontFamily: "Mono",
                fontSize: 29,
                lineHeight: 1.4,
                whiteSpace: "pre",
                color: line.includes("network")
                  ? "#81c995"
                  : line.includes("sensor")
                    ? C.blue
                    : C.white,
                translate: `${(1 - p) * 150 + i * fold * 45}px 0`,
                clipPath: `inset(0 ${100 * (1 - p)}% 0 0)`,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 60,
                  color: "#626b78",
                  fontSize: 18,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              {line}
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: k(f, [0, 48], [680, 140]),
          top: k(f, [0, 48], [480, 530]),
          scale: k(f, [0, 48], [9, 1]) * (1 - fold),
          fontSize: 180,
          fontWeight: 400,
          color: C.blue,
          letterSpacing: -20,
        }}
      >
        {"{ }"}
      </div>
      <svg
        width="1920"
        height="1080"
        style={{ position: "absolute", opacity: land(f, 156, 179) }}
      >
        <path
          d="M160 900 H960 Q1060 900 1060 800 V540 H1920"
          stroke={C.blue}
          fill="none"
          strokeWidth={k(f, [160, 220, 270], [2, 5, 2500])}
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - land(f, 156, 258)}
        />
      </svg>
      <Tag style={{ top: "auto", bottom: 65, opacity: 1 - fold }}>
        04 / CODE MEETS HARDWARE
      </Tag>
    </Field>
  );
};
export const Resolve = () => {
  const f = useF(),
    gather = ramp(f, 64, 131),
    reveal = land(f, 125, 178);
  return (
    <Field>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: C.blue,
          clipPath: `inset(0 0 ${land(f, 0, 25) * 100}% 0)`,
        }}
      />
      {["ARCHITECTURE", "COMPONENTS", "BOM", "PCB", "FIRMWARE"].map((s, i) => {
        const angle = (i * Math.PI * 2) / 5 - 0.5,
          x = 960 + Math.cos(angle) * 590,
          y = 490 + Math.sin(angle) * 310;
        return (
          <div
            key={s}
            style={{
              ...glass,
              position: "absolute",
              left: x + (960 - x) * gather - 180,
              top: y + (360 - y) * gather - 50,
              width: 360,
              height: 100,
              display: "grid",
              placeItems: "center",
              ...mono,
              fontSize: 23,
              rotate: `${(1 - gather) * Math.sin(angle) * 10}deg`,
              scale: (1 - gather * 0.94) * land(f, i * 4, 20 + i * 4),
              opacity: 1 - land(f, 111, 132),
            }}
          >
            {s}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 810,
          top: 260,
          width: 300,
          height: 200,
          display: "grid",
          placeItems: "center",
          scale: k(
            f,
            [0, 65, 128, 148, 260, 360],
            [0.4, 0.55, 1.13, 1, 1, 1.04],
          ),
        }}
      >
        <AnimatedImage
          src={staticFile("kevin.webp")}
          style={{
            width: 150,
            height: 150,
            filter: "drop-shadow(0 15px 25px #0009)",
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          top: 460,
          left: 100,
          right: 100,
          textAlign: "center",
          fontSize: 134,
          fontWeight: 650,
          letterSpacing: -8,
          clipPath: `inset(${(1 - reveal) * 100}% 0 0)`,
          translate: `0 ${(1 - reveal) * 75}px`,
        }}
      >
        Dunk AI.
      </div>
      <div
        style={{
          position: "absolute",
          top: 650,
          left: 100,
          right: 100,
          textAlign: "center",
          fontSize: 67,
          fontWeight: 500,
          letterSpacing: -3,
          opacity: land(f, 158, 185),
          translate: `0 ${(1 - land(f, 158, 192)) * 40}px`,
        }}
      >
        Describe a device. <span style={{ color: C.blue }}>Get a board.</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 795,
          top: 804,
          width: 330,
          height: 76,
          ...glass,
          borderRadius: 50,
          background: C.blue,
          color: C.bg,
          display: "grid",
          placeItems: "center",
          fontSize: 28,
          fontWeight: 650,
          scale: k(f, [203, 228, 242], [0, 1.07, 1]),
        }}
      >
        Start building ↗
      </div>
      <div
        style={{
          position: "absolute",
          left: 100,
          bottom: 70,
          ...mono,
          fontSize: 18,
          color: C.gray,
          opacity: reveal,
        }}
      >
        ONE IDEA. CONNECTED ENGINEERING.
      </div>
    </Field>
  );
};
