import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

export const C = {
  bg: "#0f1014",
  white: "#e8eaed",
  blue: "#8ab4f8",
  gray: "#9aa0a6",
  line: "#2b2c33",
};
export const useF = () => useCurrentFrame();
export const linear = (f: number, a: number, b: number) =>
  Math.max(0, Math.min(1, (f - a) / (b - a)));
export const ramp = (f: number, a: number, b: number) =>
  Easing.bezier(0.76, 0, 0.24, 1)(linear(f, a, b));
export const land = (f: number, a: number, b: number) =>
  Easing.bezier(0.16, 1, 0.3, 1)(linear(f, a, b));
export const k = (f: number, frames: number[], values: number[]) =>
  interpolate(f, frames, values, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.65, 0, 0.25, 1),
  });
export const mono: React.CSSProperties = {
  fontFamily: "Mono",
  fontSize: 20,
  letterSpacing: 1,
};
export const glass: React.CSSProperties = {
  background: "linear-gradient(125deg,#343840b8,#17191ee8 60%)",
  border: "1px solid #ffffff28",
  boxShadow: "inset 0 1px 0 #ffffff30,0 40px 90px #0009",
  backdropFilter: "blur(20px)",
  borderRadius: 28,
};
export const Field: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      color: C.white,
      fontFamily: "Figtree",
      overflow: "hidden",
      ...style,
    }}
  >
    {children}
  </div>
);
export const Tag: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      ...mono,
      position: "absolute",
      left: 100,
      top: 80,
      color: C.gray,
      ...style,
    }}
  >
    {children}
  </div>
);
export const Chip: React.FC<{
  size?: number;
  label?: string;
  style?: React.CSSProperties;
}> = ({ size = 240, label = "U1", style }) => (
  <div
    style={{
      position: "relative",
      width: size,
      height: size,
      flexShrink: 0,
      ...style,
    }}
  >
    {[0, 1, 2, 3].map((side) => (
      <div
        key={side}
        style={{ position: "absolute", inset: 0, rotate: `${side * 90}deg` }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: 16 + (i * (size - 36)) / 10,
              top: -size * 0.08,
              width: size * 0.033,
              height: size * 0.16,
              background: "linear-gradient(90deg,#6b7482,#e0e6ed 45%,#717986)",
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
        borderRadius: size * 0.06,
        background: "linear-gradient(135deg,#383c44,#14161b 55%,#252a32)",
        border: "2px solid #596271",
        boxShadow: "inset 0 2px 3px #ffffff40,0 25px 45px #0009",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <span style={{ ...mono, fontSize: size * 0.12, color: C.blue }}>
        {label}
      </span>
      <div
        style={{
          width: size * 0.28,
          height: 2,
          background: "#647086",
          marginTop: 16,
        }}
      />
      <span
        style={{
          ...mono,
          fontSize: size * 0.055,
          marginTop: 12,
          color: C.gray,
        }}
      >
        DUNK AI
      </span>
    </div>
  </div>
);
