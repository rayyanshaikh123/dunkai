import {
  useTime,
  Stage,
  Heading,
  Chip,
  Label,
  ease,
  pop,
  blue,
  muted,
  Panel,
} from "./design";
import { parts } from "./Components";
import { BoardCinema } from "./BoardCinema";
export const Board = ({ f, small = false }: { f: number; small?: boolean }) => (
  <div
    style={{
      position: "absolute",
      left: 350,
      top: 335,
      width: 1220,
      height: 590,
      borderRadius: 48,
      background: "linear-gradient(130deg,#edf9f4ed,#dcece8db 48%,#c8dedbe8)",
      border: "3px solid #fffffff2",
      boxShadow:
        "inset 0 2px 12px #ffffff0d,0 18px 0 #bdcecb,0 22px 0 #edf7f2,0 55px 85px #4e71612b",
      transform: `perspective(1900px) rotateX(${small ? 14 : 40 - ease(f, 10, 190) * 26}deg) rotateZ(${-14 + ease(f, 10, 215) * 18}deg)`,
      scale: 0.88 + ease(f, 0, 190) * 0.12,
    }}
  >
    <div
      style={{
        position: "absolute",
        inset: 20,
        border: "1px solid #9db9b84a",
        borderRadius: 32,
      }}
    />
    <svg width="1220" height="590" style={{ position: "absolute", inset: 0 }}>
      {Array.from({ length: 24 }, (_, i) => {
        const end = i % 3,
          y = (end === 0 ? 70 : end === 1 ? 360 : 390) + Math.floor(i / 3) * 5,
          target = end === 0 ? 680 : end === 1 ? 780 : 220,
          d = `M ${end === 2 ? 210 : 355} ${175 + i * 4} H ${end === 2 ? 90 + i * 2 : 500 + i * 6} V ${y} H ${target}`;
        return (
          <g key={i}>
            <path d={d} fill="none" stroke="#a3c0b64a" strokeWidth="2" />
            <path
              d={d}
              fill="none"
              stroke={i % 5 === 0 ? "#8ab4f8" : "#ba956d"}
              strokeWidth="3"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - ease(f, 35 + i * 4, 90 + i * 4)}
            />
            <path
              d={d}
              fill="none"
              stroke="#fff"
              strokeWidth="5"
              pathLength="1"
              strokeDasharray=".025 .975"
              strokeDashoffset={-((f + i * 3) % 110) / 110}
              opacity={ease(f, 145, 175) * 0.8}
            />
          </g>
        );
      })}
      {[
        [38, 38],
        [1182, 38],
        [38, 552],
        [1182, 552],
      ].map(([x, y]) => (
        <circle
          key={x + "," + y}
          cx={x}
          cy={y}
          r="12"
          fill="#c9d7d2"
          stroke="#fff"
          strokeWidth="6"
        />
      ))}
    </svg>
    {parts.map((p, i) => (
      <div
        key={p.ref}
        style={{
          position: "absolute",
          left: p.x - 350,
          top: p.y - 335,
          translate: `0 ${-100 * (1 - pop(f, i * 15))}px`,
          opacity: pop(f, i * 15),
        }}
      >
        <Chip
          label={p.ref}
          size={i === 0 ? 145 : 100}
          tint={["#2a2b40", "#26374c", "#3e3232", "#283b33"][i]}
        />
        <div
          style={{
            fontFamily: "Mono",
            fontSize: 16,
            marginTop: 20,
            color: "#617975",
          }}
        >
          {p.ref} / {p.role}
        </div>
      </div>
    ))}
    <div style={{ position: "absolute", left: 65, bottom: 38 }}>
      <Label>DUNK AI / SYSTEM BOARD</Label>
    </div>
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 48,
        pointerEvents: "none",
        background: `linear-gradient(${100 + f * 0.12}deg,transparent 25%,#ffffff0d 45%,transparent 60%)`,
        opacity: 0.5,
      }}
    />
  </div>
);
export const PCB = () => {
  const f = useTime();
  return (
    <Stage duration={165} motion="pull">
      <Heading eyebrow="03 / CIRCUIT & PCB">
        Small board. Big possibilities.
      </Heading>
      <BoardCinema f={f} />
      <Panel
        style={{
          position: "absolute",
          right: 140,
          top: 147,
          padding: "20px 27px",
          opacity: ease(f, 110, 135),
          display: "flex",
          gap: 25,
          borderRadius: 100,
          fontSize: 17,
          color: muted,
        }}
      >
        <span>100 × 60 mm</span>
        <span>4 layers</span>
        <span>I²C / 3V3</span>
      </Panel>
      <div
        style={{
          position: "absolute",
          left: 150,
          bottom: 115,
          opacity: ease(f, 130, 150),
          color: blue,
          fontSize: 20,
        }}
      >
        Architecture becomes circuitry.
      </div>
    </Stage>
  );
};
