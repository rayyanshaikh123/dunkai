import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Audio } from "@remotion/media";
import { Genesis, Idea } from "./Genesis";
import { System, Matter } from "./System";
import { Physical } from "./Physical";
import { Logic, Resolve } from "./Resolve";
import { C } from "./motion";
import "../style.css";
export const SignalFilm = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div
        style={{
          position: "absolute",
          width: 1920,
          height: 1080,
          scale: 2,
          transformOrigin: "top left",
          background: C.bg,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at ${35 + Math.sin(f / 190) * 15}% 65%,#8ab4f810,transparent 60%)`,
          }}
        />
        <Sequence
          name="Friction into a prompt"
          durationInFrames={190}
          premountFor={60}
        >
          <Genesis />
        </Sequence>
        <Sequence
          name="Dive through Generate"
          from={190}
          durationInFrames={240}
          premountFor={60}
        >
          <Idea />
        </Sequence>
        <Sequence
          name="The idea becomes a system"
          from={430}
          durationInFrames={240}
          premountFor={60}
        >
          <System />
        </Sequence>
        <Sequence
          name="Parts become the BOM"
          from={670}
          durationInFrames={270}
          premountFor={60}
        >
          <Matter />
        </Sequence>
        <Sequence
          name="The BOM becomes matter"
          from={940}
          durationInFrames={360}
          premountFor={60}
        >
          <Physical />
        </Sequence>
        <Sequence
          name="Inside the processor"
          from={1300}
          durationInFrames={270}
          premountFor={60}
        >
          <Logic />
        </Sequence>
        <Sequence
          name="One engineering project"
          from={1570}
          durationInFrames={350}
          premountFor={60}
        >
          <Resolve />
        </Sequence>
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: "#e8eaed",
            opacity:
              Math.max(
                0,
                ...[430, 670, 940, 1300, 1570].map((t) =>
                  Math.max(0, 1 - Math.abs(f - t) / 4),
                ),
              ) * 0.3,
          }}
        />
      </div>
      <Audio src={staticFile("signal/score.wav")} premountFor={60} />
      <Audio src={staticFile("signal/foley.wav")} premountFor={60} />
    </AbsoluteFill>
  );
};
