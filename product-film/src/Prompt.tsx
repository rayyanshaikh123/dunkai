import {
  useTime,
  Stage,
  Panel,
  Label,
  Cursor,
  ease,
  clamp,
  Serif,
  Kevin,
  Pill,
  blue,
} from "./design";
import { interpolate } from "remotion";
export const prompt =
  "Build an indoor environment monitor. Sense temperature, humidity and air quality. Report over Wi-Fi. Power it with USB.";
export const Prompt = () => {
  const f = useTime(),
    text = prompt.slice(
      0,
      Math.floor(interpolate(f, [22, 108], [0, prompt.length], clamp)),
    ),
    submit = ease(f, 125, 142);
  return (
    <Stage duration={165} motion="push">
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 125,
          textAlign: "center",
          opacity: ease(f, 0, 25),
        }}
      >
        <Label>IT STARTS WITH A SENTENCE</Label>
        <div
          style={{
            fontSize: 88,
            fontWeight: 650,
            letterSpacing: -5,
            marginTop: 20,
          }}
        >
          Tell us your <Serif>idea.</Serif>
        </div>
      </div>
      <Panel
        style={{
          position: "absolute",
          left: 335,
          top: 350,
          width: 1250,
          height: 405,
          padding: 50,
          scale: 1 + submit * 0.025,
          transform: `perspective(1800px) rotateX(${3 * (1 - submit)}deg)`,
          boxShadow: "inset 0 2px 1px white,0 45px 85px #00000066",
          borderColor: submit > 0.1 ? "#8ab4f870" : "white",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            marginBottom: 30,
          }}
        >
          <Kevin size={46} />
          <span style={{ fontSize: 21, fontWeight: 700 }}>Dunk AI</span>
          <span style={{ fontSize: 18, color: "#9aa0a6" }}>
            Your hardware copilot
          </span>
        </div>
        <div
          style={{
            fontSize: 34,
            lineHeight: 1.55,
            minHeight: 135,
            fontWeight: 500,
            color: "#dadce0",
          }}
        >
          {text}
          <span
            style={{
              color: blue,
              opacity: Math.floor(f / 12) % 2 === 0 ? 1 : 0,
            }}
          >
            |
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 50,
            right: 50,
            bottom: 35,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 18, color: "#9aa0a6" }}>
            {submit > 0.5
              ? "Turning your words into a system…"
              : "Describe it. We’ll connect the dots."}
          </span>
          <div
            style={{
              background: "#e8eaed",
              color: "#131417",
              borderRadius: 100,
              padding: "17px 30px",
              fontSize: 22,
              fontWeight: 600,
              boxShadow: "0 8px 18px #00000055",
            }}
          >
            Generate ↗
          </div>
        </div>
      </Panel>
      <Cursor
        x={interpolate(f, [0, 20, 118, 125], [1550, 445, 1430, 1445], clamp)}
        y={interpolate(f, [0, 20, 118, 125], [850, 490, 720, 699], clamp)}
        click={f > 125 && f < 132}
      />
      <div
        style={{
          position: "absolute",
          left: 395,
          top: 820,
          display: "flex",
          gap: 18,
        }}
      >
        {["Sensors", "Wi-Fi", "USB power"].map((t, i) => (
          <div
            key={t}
            style={{
              opacity: ease(f, 65 + i * 20, 85 + i * 20),
              translate: `0 ${(1 - ease(f, 65 + i * 20, 85 + i * 20)) * 20}px`,
            }}
          >
            <Pill style={{ fontSize: 19, color: blue }}>✦ {t}</Pill>
          </div>
        ))}
      </div>
    </Stage>
  );
};
