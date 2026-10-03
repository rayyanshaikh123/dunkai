import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio } from "@remotion/media";
import { Opening } from "./Opening";
import { Prompt } from "./Prompt";
import { Architecture } from "./Architecture";
import { Components } from "./Components";
import { PCB } from "./PCB";
import { Firmware } from "./Firmware";
import { Finale } from "./Finale";
import "./style.css";
import { Backdrop } from "./design";
export const Film = () => {
  const f = useCurrentFrame() / 2;
  return (
    <AbsoluteFill
      style={{
        background: "#0f1014",
        color: "#e8eaed",
        fontFamily: "Figtree",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          transform: "scale(2)",
          transformOrigin: "top left",
          background: "#0f1014",
        }}
      >
        <Backdrop />
        <Sequence name="Opening" durationInFrames={300} premountFor={60}>
          <Opening />
        </Sequence>
        <Sequence
          name="Prompt"
          from={270}
          durationInFrames={330}
          premountFor={60}
        >
          <Prompt />
        </Sequence>
        <Sequence
          name="Architecture"
          from={570}
          durationInFrames={270}
          premountFor={60}
        >
          <Architecture />
        </Sequence>
        <Sequence
          name="Components"
          from={810}
          durationInFrames={360}
          premountFor={60}
        >
          <Components />
        </Sequence>
        <Sequence
          name="PCB"
          from={1140}
          durationInFrames={330}
          premountFor={60}
        >
          <PCB />
        </Sequence>
        <Sequence
          name="Firmware"
          from={1440}
          durationInFrames={300}
          premountFor={60}
        >
          <Firmware />
        </Sequence>
        <Sequence
          name="Finale"
          from={1710}
          durationInFrames={300}
          premountFor={60}
        >
          <Finale />
        </Sequence>
        <div
          style={{
            position: "absolute",
            bottom: 55,
            left: 140,
            right: 140,
            height: 1,
            background: "#ffffff10",
          }}
        >
          <div
            style={{
              height: 1,
              width: `${(f / 1005) * 100}%`,
              background: "#8ab4f850",
            }}
          />
        </div>
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: "white",
            mixBlendMode: "screen",
            opacity:
              Math.max(
                ...[135, 285, 405, 570, 720, 855].map((t) =>
                  Math.max(0, 1 - Math.abs(f - t) / 5),
                ),
              ) * 0.6,
          }}
        />
      </div>
      <Audio src={staticFile("score.wav")} premountFor={60} />
      <Audio src={staticFile("sound-design.wav")} premountFor={60} />
    </AbsoluteFill>
  );
};
