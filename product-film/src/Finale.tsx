import {
  useTime,
  Stage,
  Panel,
  Label,
  ease,
  Kevin,
  Serif,
  blue,
} from "./design";
import { Board } from "./PCB";
export const Finale = () => {
  const f = useTime(),
    collapse = ease(f, 35, 75);
  return (
    <Stage duration={150} motion="pull">
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 1 - collapse,
          scale: 1 - collapse * 0.4,
        }}
      >
        <div style={{ position: "absolute", left: 140, top: 125 }}>
          <Label>YOUR IDEA. NOW AN ENGINEERING PACKAGE.</Label>
        </div>
        <Board f={230} small />
        {["Architecture", "Components", "BOM", "PCB", "Firmware"].map(
          (t, i) => (
            <Panel
              key={t}
              style={{
                position: "absolute",
                left: 170 + i * 320,
                top: 915 - ease(f, i * 8, 30 + i * 8) * 30,
                width: 290,
                height: 80,
                padding: 22,
                fontSize: 22,
                fontWeight: 600,
                textAlign: "center",
                opacity: ease(f, i * 8, 30 + i * 8),
                borderRadius: 24,
              }}
            >
              {t} <span style={{ color: blue, fontSize: 17 }}>↗</span>
            </Panel>
          ),
        )}
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: collapse,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          translate: `0 ${(1 - collapse) * 50}px`,
        }}
      >
        <div
          style={{
            position: "relative",
            width: 190,
            height: 190,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 48,
            background: "linear-gradient(135deg,#1a1b20d9,#26272eab)",
            border: "1px solid #ffffff20",
            boxShadow: "inset 0 1px 1px #ffffff15,0 25px 50px #00000070",
            rotate: `${-7 + Math.sin(f / 40) * 3}deg`,
          }}
        >
          <Kevin size={132} />
        </div>
        <div
          style={{
            fontSize: 114,
            fontWeight: 700,
            letterSpacing: -7,
            marginTop: 36,
          }}
        >
          Dunk AI
        </div>
        <div
          style={{
            fontSize: 68,
            fontWeight: 600,
            letterSpacing: -4,
            marginTop: 22,
          }}
        >
          One prompt. <Serif>Your hardware project.</Serif>
        </div>
        <div
          style={{
            marginTop: 35,
            display: "flex",
            gap: 28,
            alignItems: "center",
            fontSize: 19,
            color: "#9aa0a6",
          }}
        >
          <span>Architecture. Components. PCB. Firmware. Together.</span>
        </div>
        <div
          style={{
            marginTop: 36,
            background: "#8ab4f8",
            color: "#0f1014",
            padding: "20px 38px",
            borderRadius: 50,
            fontSize: 25,
            fontWeight: 700,
            opacity: ease(f, 90, 105),
            translate: `0 ${(1 - ease(f, 90, 110)) * 20}px`,
          }}
        >
          Start building &#8599;
        </div>
      </div>
    </Stage>
  );
};
