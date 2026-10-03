import {
  useTime,
  Stage,
  Heading,
  Panel,
  Label,
  Chip,
  ease,
  blue,
  muted,
  Pill,
  Icon,
} from "./design";
const lines = [
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
  "  display.update(reading);",
  "  network.publish(reading);",
  "  delay(1000);",
  "}",
];
export const Firmware = () => {
  const f = useTime(),
    count = Math.floor(ease(f, 10, 90) * lines.length);
  return (
    <Stage duration={150} motion="rise">
      <Heading eyebrow="04 / EMBEDDED FIRMWARE">Made to come alive.</Heading>
      <Panel
        style={{
          position: "absolute",
          left: 180,
          top: 325,
          width: 980,
          height: 615,
          padding: 35,
          background: "linear-gradient(135deg,#1a1b20dc,#202127c9)",
          transform: `perspective(2000px) rotateY(${-3 + ease(f, 0, 150) * 3}deg)`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          {["#e6b5bd", "#ead2a8", "#b7d4c2"].map((c) => (
            <div
              key={c}
              style={{
                width: 12,
                height: 12,
                background: c,
                borderRadius: "50%",
              }}
            />
          ))}
          <span style={{ marginLeft: 22, fontSize: 17, color: muted }}>
            main.cpp
          </span>
          <span style={{ marginLeft: "auto", fontSize: 16, color: blue }}>
            C++ / firmware
          </span>
        </div>
        <div
          style={{
            marginTop: 30,
            fontFamily: "Mono",
            fontSize: 24,
            lineHeight: 1.34,
          }}
        >
          {lines.slice(0, count).map((l, i) => (
            <div
              key={i}
              style={{
                color: l.includes("network")
                  ? "#81c995"
                  : l.includes("sensor")
                    ? blue
                    : "#dadce0",
                background: i === 12 && f > 90 ? "#8ab4f81a" : "transparent",
                borderRadius: 8,
                whiteSpace: "pre",
              }}
            >
              <span
                style={{ color: "#6f7684", display: "inline-block", width: 60 }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              {l}
            </div>
          ))}
        </div>
      </Panel>
      <Panel
        style={{
          position: "absolute",
          left: 1320,
          top: 438,
          width: 340,
          height: 340,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(130deg,#1a1b20bb,#29273bbb)",
          rotate: "4deg",
          translate: `0 ${Math.sin(f / 40) * 6}px`,
        }}
      >
        <Chip label="U1" size={160} />
      </Panel>
      <svg
        width="1920"
        height="1080"
        style={{ position: "absolute", inset: 0 }}
      >
        <path
          d="M1160 680 C1250 680 1250 605 1320 605"
          fill="none"
          stroke={blue}
          strokeWidth="3"
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={1 - ease(f, 95, 120)}
        />
        <path
          d="M1160 680 C1250 680 1250 605 1320 605"
          fill="none"
          stroke="#8ab4f8"
          strokeWidth="8"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray=".025 .975"
          strokeDashoffset={-ease(f, 100, 130)}
          opacity={f > 100 && f < 130 ? 1 : 0}
        />
      </svg>
      <div style={{ position: "absolute", left: 1350, top: 823 }}>
        <Pill style={{ fontSize: 19, color: blue }}>
          <Icon kind="wifi" size={25} />
          {f > 110 ? "Signal received" : "Ready for connection"}
        </Pill>
      </div>
      <div style={{ position: "absolute", left: 1355, top: 902 }}>
        <Label>SAMPLE / DISPLAY / PUBLISH</Label>
      </div>
    </Stage>
  );
};
