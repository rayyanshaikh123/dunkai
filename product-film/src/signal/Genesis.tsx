import { AnimatedImage, staticFile } from "remotion";
import { C, Field, Tag, glass, k, land, mono, ramp, useF } from "./motion";

export const Genesis = () => {
  const f = useF(),
    collapse = ramp(f, 135, 184);
  const words = ["SPEC", "PARTS", "PCB", "CODE"];
  return (
    <Field>
      <Tag>HARDWARE. RECONSIDERED.</Tag>
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 260,
          fontSize: 190,
          fontWeight: 650,
          letterSpacing: -12,
          lineHeight: 0.95,
          translate: `${k(f, [0, 22, 65, 88], [-180, 0, 0, -1700])}px 0`,
          filter: `blur(${k(f, [0, 22, 65, 88], [12, 0, 0, 16])}px)`,
        }}
      >
        Great idea.
        <br />
        <span style={{ color: C.blue }}>Now what?</span>
      </div>
      {words.map((w, i) => {
        const entrance = land(f, 70 + i * 7, 102 + i * 7),
          x = [280, 1150, 430, 1290][i],
          y = [290, 230, 730, 700][i];
        return (
          <div
            key={w}
            style={{
              ...glass,
              position: "absolute",
              left: x + (960 - x - 300) * collapse,
              top: y + (540 - y - 60) * collapse,
              width: 600,
              height: 120,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 38px",
              fontSize: 56,
              fontWeight: 600,
              letterSpacing: -2,
              rotate: `${[-12, 8, 5, -7][i] * (1 - collapse)}deg`,
              scale: entrance,
              opacity: 1 - collapse * 0.96,
              transform: `perspective(1800px) rotateY(${(1 - collapse) * [18, -14, -8, 12][i]}deg)`,
            }}
          >
            {w}
            <span style={{ ...mono, color: C.gray }}>0{i + 1}</span>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 490,
          fontSize: 82,
          fontWeight: 650,
          letterSpacing: -4,
          translate: `0 ${k(f, [95, 115, 137, 163], [150, 0, 0, -200])}px`,
          opacity: k(f, [94, 112, 137, 163], [0, 1, 1, 0]),
        }}
      >
        Too many handoffs.
      </div>
      <div
        style={{
          position: "absolute",
          left: 960 - k(f, [145, 190], [2, 670]),
          top: 540 - k(f, [145, 190], [90, 210]),
          width: k(f, [145, 190], [4, 1340]),
          height: k(f, [145, 190], [180, 420]),
          borderRadius: k(f, [145, 190], [2, 40]),
          background: C.bg,
          border: `2px solid ${C.blue}`,
          boxShadow: "0 0 60px #8ab4f820",
          opacity: land(f, 149, 161),
        }}
      />
    </Field>
  );
};

export const Idea = () => {
  const f = useF(),
    click = 180,
    dive = ramp(f, 195, 238),
    typed = "Design a USB-powered temperature and humidity monitor with Wi-Fi.",
    count = Math.floor(typed.length * Math.min(1, Math.max(0, (f - 25) / 118)));
  return (
    <Field>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "1480px 650px",
          scale: 1 + dive * 8,
          translate: `${-dive * 90}px ${dive * 100}px`,
          filter: `blur(${Math.sin(dive * Math.PI) * 3}px)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 290,
            top: 330,
            width: 1340,
            height: 420,
            ...glass,
            border: `2px solid ${C.blue}`,
            borderRadius: 40,
            scale: k(f, [0, 16, 178, 185, 197], [1, 0.99, 1, 0.975, 1.025]),
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 50,
              top: 35,
              display: "flex",
              alignItems: "center",
              gap: 20,
            }}
          >
            <AnimatedImage
              src={staticFile("kevin.webp")}
              style={{ width: 52, height: 52 }}
            />
            <span style={{ fontSize: 26, fontWeight: 600 }}>Dunk AI</span>
          </div>
          <div
            style={{
              position: "absolute",
              left: 50,
              top: 136,
              right: 60,
              fontSize: 46,
              fontWeight: 450,
              letterSpacing: -1.4,
              lineHeight: 1.35,
            }}
          >
            {typed.slice(0, count)}
            <span style={{ color: C.blue }}>|</span>
          </div>
          <div
            style={{
              position: "absolute",
              left: 50,
              bottom: 45,
              ...mono,
              color: C.gray,
            }}
          >
            Describe a device.
          </div>
          <div
            style={{
              position: "absolute",
              right: 38,
              bottom: 32,
              width: 200,
              height: 72,
              borderRadius: 40,
              background: C.blue,
              color: C.bg,
              display: "grid",
              placeItems: "center",
              fontSize: 26,
              fontWeight: 700,
              scale: k(f, [click - 3, click, click + 12], [1, 0.85, 1]),
            }}
          >
            Generate ↗
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 290,
            top: 180,
            fontSize: 78,
            fontWeight: 600,
            letterSpacing: -4,
            clipPath: `inset(0 ${100 * (1 - land(f, 8, 38))}% 0 0)`,
          }}
        >
          Start with <span style={{ color: C.blue }}>one sentence.</span>
        </div>
        <svg
          width="42"
          height="50"
          viewBox="0 0 42 50"
          style={{
            position: "absolute",
            left: k(f, [135, 178], [1640, 1500]),
            top: k(f, [135, 178], [900, 684]),
            opacity: land(f, 135, 147),
          }}
        >
          <path
            d="M3 2 L33 30 L20 31 L14 46 Z"
            fill="white"
            stroke="#0f1014"
            strokeWidth="3"
          />
        </svg>
      </div>
      <div
        style={{
          position: "absolute",
          left: 1480 - 1900 * dive,
          top: 650 - 1900 * dive,
          width: 3800 * dive,
          height: 3800 * dive,
          borderRadius: "50%",
          background: C.blue,
          scale: dive,
          opacity: dive > 0 ? 1 : 0,
        }}
      />
    </Field>
  );
};
