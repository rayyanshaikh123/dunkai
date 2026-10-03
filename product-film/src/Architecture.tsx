import {
  useTime,
  Stage,
  Panel,
  Heading,
  Label,
  ease,
  pop,
  Icon,
  Chip,
  blue,
  muted,
  Pill,
} from "./design";
const nodes = [
  {
    x: 190,
    y: 415,
    t: "Sensing",
    s: "Temperature · Humidity · Air quality",
    k: "sensor",
    c: "#392931",
  },
  {
    x: 765,
    y: 380,
    t: "Processing",
    s: "MC9S08DZ32ACLC",
    k: "chip",
    c: "#2c2940",
  },
  {
    x: 1320,
    y: 415,
    t: "Connectivity",
    s: "ESPC2-12-N4 / Wi-Fi",
    k: "wifi",
    c: "#243345",
  },
  {
    x: 765,
    y: 745,
    t: "Power",
    s: "USB → 3.3 V rail",
    k: "power",
    c: "#253730",
  },
];
export const Architecture = () => {
  const f = useTime();
  return (
    <Stage duration={135} motion="pull">
      <Heading eyebrow="01 / SYSTEM ARCHITECTURE">
        Your words. Beautifully connected.
      </Heading>
      <div style={{ position: "absolute", inset: 0, scale: 1 + f * 0.0001 }}>
        <svg width="1920" height="1080">
          {[
            "M540 540 C650 540 650 505 765 505",
            "M1115 505 C1215 505 1215 540 1320 540",
            "M940 745 V645",
          ].map((d, i) => (
            <g key={d}>
              <path d={d} fill="none" stroke="#2b2c33" strokeWidth="2" />
              <path
                d={d}
                fill="none"
                stroke={blue}
                strokeWidth="3"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - ease(f, 30 + i * 16, 70 + i * 16)}
              />
              <path
                d={d}
                fill="none"
                stroke="#8ab4f8"
                strokeWidth="7"
                strokeLinecap="round"
                pathLength="1"
                strokeDasharray=".015 .985"
                strokeDashoffset={-((f - i * 20) % 90) / 90}
                opacity={ease(f, 85, 110)}
              />
            </g>
          ))}
        </svg>
        {nodes.map((n, i) => {
          const p = pop(f, 10 + i * 15),
            center = i === 1;
          return (
            <Panel
              key={n.t}
              style={{
                position: "absolute",
                left: n.x,
                top: n.y,
                width: 350,
                height: center ? 260 : i === 3 ? 220 : 235,
                padding: 30,
                opacity: p,
                translate: `0 ${(1 - p) * 65 + Math.sin(f / 45 + i) * 4}px`,
                rotate: center
                  ? "0deg"
                  : i === 0
                    ? "-3deg"
                    : i === 2
                      ? "3deg"
                      : "0deg",
                background: `linear-gradient(140deg,#1a1b20e0,${n.c}a0)`,
              }}
            >
              {center ? (
                <div style={{ position: "absolute", right: 33, top: 35 }}>
                  <Chip label="U1" size={82} />
                </div>
              ) : (
                <Icon kind={n.k} size={48} />
              )}
              <div
                style={{
                  fontSize: 31,
                  fontWeight: 650,
                  marginTop: center ? 120 : 18,
                }}
              >
                {n.t}
              </div>
              <div
                style={{
                  fontSize: 19,
                  lineHeight: 1.5,
                  color: muted,
                  marginTop: 12,
                  width: 280,
                }}
              >
                {n.s}
              </div>
            </Panel>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 145,
          bottom: 100,
          opacity: ease(f, 95, 115),
        }}
      >
        <Pill style={{ fontSize: 18 }}>
          ✓ I²C paths mapped <span style={{ color: "#6b7380" }}>•</span> Power
          domain resolved
        </Pill>
      </div>
      <div style={{ position: "absolute", right: 175, top: 150 }}>
        <Label>INTELLIGENCE IN EVERY CONNECTION</Label>
      </div>
    </Stage>
  );
};
