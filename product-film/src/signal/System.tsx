import {
  C,
  Chip,
  Field,
  Tag,
  glass,
  k,
  land,
  mono,
  ramp,
  useF,
} from "./motion";
import ir from "../pcb-ir.json";

const nodes = [
  { name: "SENSE", id: "U7 / U9", x: 390, y: 360 },
  { name: "CONNECT", id: "U2 / WI-FI", x: 1440, y: 320 },
  { name: "POWER", id: "USB / 3V3", x: 1370, y: 800 },
  { name: "PROCESS", id: "U1 / MCU", x: 460, y: 780 },
];
export const System = () => {
  const f = useF(),
    out = ramp(f, 203, 240),
    zoom = k(f, [0, 35, 155, 191, 240], [2.8, 1, 0.95, 0.92, 7]);
  return (
    <Field>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: C.blue,
          clipPath: `circle(${(1 - land(f, 0, 32)) * 140}% at 50% 50%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          scale: zoom,
          transformOrigin: "960px 540px",
          rotate: `${k(f, [0, 38, 184, 240], [-18, 0, 0, 35])}deg`,
          filter: `blur(${out * 4}px)`,
        }}
      >
        <svg width="1920" height="1080" style={{ position: "absolute" }}>
          {nodes.map((n, i) => (
            <g key={n.name}>
              <path
                d={`M960 540 C${n.x} 540 960 ${n.y} ${n.x} ${n.y}`}
                fill="none"
                stroke={C.line}
                strokeWidth="2"
              />
              <path
                d={`M960 540 C${n.x} 540 960 ${n.y} ${n.x} ${n.y}`}
                fill="none"
                stroke={C.blue}
                strokeWidth="3"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={1 - land(f, 24 + i * 12, 75 + i * 12)}
              />
            </g>
          ))}
        </svg>
        {nodes.map((n, i) => (
          <div
            key={n.name}
            style={{
              ...glass,
              position: "absolute",
              left: n.x - 150,
              top: n.y - 60,
              width: 300,
              height: 120,
              padding: "22px 30px",
              scale: land(f, 28 + i * 9, 65 + i * 9),
              transform: `perspective(1200px) rotateY(${Math.sin(f / 60 + i) * 7}deg)`,
            }}
          >
            <div style={{ fontSize: 35, fontWeight: 600 }}>{n.name}</div>
            <div style={{ ...mono, fontSize: 17, color: C.gray, marginTop: 8 }}>
              {n.id}
            </div>
          </div>
        ))}
        <div
          style={{
            position: "absolute",
            left: 840,
            top: 420,
            rotate: `${k(f, [0, 40], [-45, 0])}deg`,
          }}
        >
          <Chip label="U1" />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 100,
          fontSize: 112,
          fontWeight: 650,
          letterSpacing: -6,
          translate: `${-out * 1500}px 0`,
          clipPath: `inset(0 ${100 * (1 - land(f, 24, 58))}% 0 0)`,
        }}
      >
        Connected by design.
      </div>
      <Tag style={{ top: "auto", bottom: 90, opacity: 1 - out }}>
        01 / SYSTEM ARCHITECTURE
      </Tag>
    </Field>
  );
};

const parts = [
  ir.components[0],
  ir.components[1],
  ir.components[6],
  ir.components[8],
];
export const Matter = () => {
  const f = useF(),
    rows = ramp(f, 117, 166),
    exit = ramp(f, 231, 270);
  return (
    <Field>
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 80,
          fontSize: 110,
          fontWeight: 650,
          letterSpacing: -6,
          translate: `0 ${-exit * 220}px`,
        }}
      >
        {f < 150 ? "Every part." : "In its place."}
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `perspective(1500px) rotateX(${exit * 68}deg) rotateZ(${-exit * 18}deg)`,
          scale: 1 - exit * 0.32,
          translate: `0 ${exit * 70}px`,
        }}
      >
        {parts.map((p, i) => {
          const x = 170 + i * 420,
            y = 365,
            left = x + (290 - x) * rows,
            top = y + (300 + i * 137 - y) * rows;
          return (
            <div
              key={p.ref_id}
              style={{
                ...glass,
                position: "absolute",
                left,
                top: top + (140 + i * 60 - top) * exit,
                width: 350 + 990 * rows,
                height: 420 - 305 * rows + 685 * exit,
                background:
                  exit > 0.2
                    ? i % 2
                      ? "#ad8b5e"
                      : "#172a31"
                    : glass.background,
                padding: 28,
                transform: `perspective(1400px) rotateY(${(1 - rows) * k(f, [0, 50, 90], [i % 2 ? 70 : -70, 0, -5])}deg)`,
                scale: k(f, [0, 35, 70], [i === 0 ? 5 : 0.2, 1.04, 1]),
                opacity: i === 0 ? 1 : land(f, i * 8, 25 + i * 8),
                translate: `${(1 - land(f, 0, 48)) * (i === 0 ? 560 : 0)}px 0`,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 75 - 48 * rows,
                  opacity: 1 - exit,
                  top: 60 - 36 * rows,
                  scale: 1 - rows * 0.66,
                  transformOrigin: "top left",
                }}
              >
                <Chip size={190} label={p.ref_id} />
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 28 + 98 * rows,
                  opacity: 1 - exit,
                  top: 300 - 267 * rows,
                  fontSize: 27,
                  fontWeight: 600,
                  letterSpacing: -0.7,
                }}
              >
                {p.part_number}
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 28 + 760 * rows,
                  opacity: 1 - exit,
                  top: 346 - 300 * rows,
                  ...mono,
                  fontSize: 17,
                  color: C.gray,
                }}
              >
                {p.package}
              </div>
              <div
                style={{
                  position: "absolute",
                  right: 32,
                  top: 44,
                  ...mono,
                  color: C.blue,
                  opacity: rows * (1 - exit),
                }}
              >
                × 1
              </div>
            </div>
          );
        })}
      </div>
      <Tag style={{ top: "auto", bottom: 80, opacity: 1 - exit }}>
        02 / COMPONENTS → BILL OF MATERIALS
      </Tag>
    </Field>
  );
};
