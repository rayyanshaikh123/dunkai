import React from "react";
import {
  AbsoluteFill,
  AnimatedImage,
  Easing,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
} from "remotion";
export const ink = "#e8eaed",
  muted = "#9aa0a6",
  copper = "#8ab4f8",
  blue = "#8ab4f8";
export const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
export const ease = (f: number, a: number, b: number) =>
  interpolate(f, [a, b], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  });
export const pop = (f: number, delay = 0) =>
  spring({
    frame: Math.max(0, f - delay),
    fps: 30,
    config: { damping: 24, stiffness: 100 },
  });
export const useTime = () => useCurrentFrame() / 2;
export const Panel: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      background: "linear-gradient(130deg,#1a1b20bc,#202127a8)",
      border: "1px solid #ffffff14",
      borderRadius: 36,
      boxShadow:
        "inset 0 2px 1px #ffffff0d,0 30px 70px #00000050,0 4px 12px #00000030",
      backdropFilter: "blur(32px)",
      ...style,
    }}
  >
    {children}
  </div>
);
export const Label: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      fontFamily: "Figtree",
      fontWeight: 700,
      fontSize: 17,
      letterSpacing: 2.6,
      color: muted,
    }}
  >
    {children}
  </div>
);
export const Serif: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <span
    style={{
      fontFamily: "Figtree",
      fontStyle: "normal",
      fontWeight: 650,
      letterSpacing: -3,
      color: blue,
      ...style,
    }}
  >
    {children}
  </span>
);
export const Heading: React.FC<{
  eyebrow: string;
  children: React.ReactNode;
}> = ({ eyebrow, children }) => {
  const f = useTime();
  return (
    <div
      style={{
        position: "absolute",
        left: 140,
        top: 130,
        opacity: ease(f, 5, 25),
        translate: `0 ${(1 - ease(f, 5, 35)) * 25}px`,
      }}
    >
      <Label>{eyebrow}</Label>
      <div
        style={{
          fontSize: 80,
          fontWeight: 650,
          lineHeight: 1.08,
          letterSpacing: -4,
          marginTop: 22,
        }}
      >
        {children}
      </div>
    </div>
  );
};
export const Stage: React.FC<{
  children: React.ReactNode;
  duration: number;
  motion?: "still" | "push" | "slide" | "rise" | "pull";
}> = ({ children, duration, motion = "still" }) => {
  const f = useTime();
  const enter = ease(f, 0, 20);
  const exit = ease(f, duration - 23, duration - 2);
  const zoom =
    motion === "push"
      ? 1 + ease(f, duration - 62, duration - 7) * 0.32
      : motion === "pull"
        ? 1.2 - enter * 0.2 + exit * 0.06
        : motion === "rise"
          ? 1.09 - enter * 0.09
          : 1;
  return (
    <AbsoluteFill
      style={{
        color: ink,
        fontFamily: "Figtree",
        transformOrigin: motion === "push" ? "1470px 690px" : "960px 540px",
        scale: zoom,
        translate:
          motion === "slide"
            ? `${(1 - enter) * 480 - exit * 500}px 0`
            : motion === "rise"
              ? `0 ${(1 - enter) * 160 - exit * 90}px`
              : "0 0",
        filter: `blur(${(1 - enter) * (motion === "still" ? 0 : 5) + exit * (motion === "still" ? 0 : 3)}px)`,
        opacity: interpolate(
          f,
          [0, 8, duration - 9, duration],
          [0, 1, 1, 0],
          clamp,
        ),
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
export const Kevin = ({ size = 100 }: { size?: number }) => (
  <AnimatedImage
    src={staticFile("kevin.webp")}
    width={size}
    height={size}
    style={{
      objectFit: "contain",
      imageRendering: "pixelated",
      filter: "drop-shadow(0 12px 12px #8ab4f830)",
    }}
  />
);
export const Pill: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 12,
      padding: "13px 23px",
      borderRadius: 100,
      background: "#202127b8",
      border: "1px solid #ffffff12",
      boxShadow: "0 8px 24px #00000030",
      fontSize: 21,
      fontWeight: 600,
      ...style,
    }}
  >
    {children}
  </div>
);
export const Cursor = ({
  x,
  y,
  click = false,
}: {
  x: number;
  y: number;
  click?: boolean;
}) => (
  <svg
    width="45"
    height="55"
    style={{
      position: "absolute",
      left: x,
      top: y,
      filter: "drop-shadow(0 4px 6px #59516a38)",
      scale: click ? 0.86 : 1,
    }}
    viewBox="0 0 32 40"
  >
    <path
      d="M3 2 L3 31 L11 23 L18 38 L24 35 L17 21 L29 20 Z"
      fill={ink}
      stroke="white"
      strokeWidth="2"
    />
  </svg>
);
export const Icon = ({
  kind,
  size = 52,
  color = blue,
}: {
  kind: string;
  size?: number;
  color?: string;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    fill="none"
    stroke={color}
    strokeWidth="2.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {kind === "sensor" ? (
      <>
        <path d="M25 12a7 7 0 0 1 14 0v25a12 12 0 1 1-14 0Z" />
        <path d="M32 19v25" />
        <circle cx="32" cy="47" r="4" fill={color} />
        <path d="M45 20h6m-6 8h4" />
      </>
    ) : kind === "wifi" ? (
      <>
        <path d="M7 24a38 38 0 0 1 50 0M15 33a25 25 0 0 1 34 0M23 42a13 13 0 0 1 18 0" />
        <circle cx="32" cy="51" r="3" fill={color} />
      </>
    ) : kind === "power" ? (
      <>
        <rect x="7" y="18" width="46" height="28" rx="7" />
        <path d="M57 27v10M33 22l-9 13h10l-4 8" />
      </>
    ) : (
      <>
        <rect x="17" y="17" width="30" height="30" rx="6" />
        <rect x="25" y="25" width="14" height="14" rx="3" />
        {[23, 32, 41].map((p) => (
          <path key={p} d={`M${p} 8v9M${p} 47v9M8 ${p}h9M47 ${p}h9`} />
        ))}
      </>
    )}
  </svg>
);
export const Chip = ({
  label,
  size = 110,
  tint = "#282d3a",
}: {
  label: string;
  size?: number;
  tint?: string;
}) => (
  <div
    style={{
      position: "relative",
      width: size,
      height: size,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {[0, 1, 2, 3].map((side) => (
      <div
        key={side}
        style={{ position: "absolute", inset: 0, rotate: `${side * 90}deg` }}
      >
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 12 + (i * (size - 24)) / 8,
              top: -7,
              width: 5,
              height: 14,
              background: "linear-gradient(#b4afbb,#ece9f0)",
              borderRadius: 2,
            }}
          />
        ))}
      </div>
    ))}
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 16,
        background: `linear-gradient(135deg,#363a46,${tint})`,
        border: "1px solid #ffffff20",
        boxShadow: "inset 0 1px 3px #ffffff0d,7px 12px 15px #00000077",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 8,
        color: ink,
        fontFamily: "Mono",
        fontSize: size * 0.15,
      }}
    >
      <Icon kind="chip" size={size * 0.42} />
      {label}
    </div>
  </div>
);
export const Backdrop = () => {
  const f = useTime();
  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background: "linear-gradient(130deg,#0f1014,#131418 55%,#0f1014)",
      }}
    >
      {[
        { x: 1150, y: 290, s: 780, c: "#403465" },
        { x: 100, y: 650, s: 720, c: "#223858" },
        { x: 1400, y: 800, s: 650, c: "#263750" },
      ].map((o, i) => (
        <div
          key={o.c}
          style={{
            position: "absolute",
            left: o.x - 200 + Math.sin(f / 150 + i) * 100,
            top: o.y - 300 + Math.cos(f / 160 + i) * 65,
            width: o.s,
            height: o.s,
            borderRadius: "50%",
            background: `radial-gradient(circle,${o.c}55,transparent 68%)`,
            filter: "blur(50px)",
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          left: 1270,
          top: 100,
          width: 500,
          height: 500,
          borderRadius: "50%",
          border: "1px solid #ffffff0d",
          boxShadow: "inset 10px 10px 50px #ffffff06",
          rotate: `${f * 0.03}deg`,
          scale: 1 + Math.sin(f / 100) * 0.025,
        }}
      />
    </AbsoluteFill>
  );
};
