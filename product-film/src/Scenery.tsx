import { AbsoluteFill, Img, staticFile } from "remotion";
import { Stage, useTime, ease, Panel, Icon, blue } from "./design";
import { Board } from "./PCB";
export const Scenery = () => {
  const f = useTime(),
    change = ease(f, 40, 50);
  return (
    <Stage duration={90} motion="pull">
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <Img
          src={staticFile("scenery-home.png")}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            scale: 1.04 + f * 0.0005,
            translate: `${-f * 0.22}px 0`,
          }}
        />
        <AbsoluteFill
          style={{ clipPath: `inset(0 ${100 - change * 100}% 0 0)` }}
        >
          <Img
            src={staticFile("scenery-greenhouse.png")}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              scale: 1.1 - f * 0.00035,
            }}
          />
        </AbsoluteFill>
        <AbsoluteFill
          style={{
            background:
              "linear-gradient(90deg,#0f1014f5,#0f1014a0 48%,#0f101420)",
          }}
        />
        <div style={{ position: "absolute", left: 145, top: 300, width: 820 }}>
          <div
            style={{
              fontSize: 19,
              fontWeight: 700,
              letterSpacing: 2,
              color: "#9aa0a6",
            }}
          >
            IMAGINED FOR REAL LIFE
          </div>
          <div
            style={{
              fontSize: 116,
              fontWeight: 700,
              letterSpacing: -7,
              lineHeight: 1.06,
              marginTop: 28,
            }}
          >
            Sense your
            <br />
            <span style={{ color: blue }}>surroundings.</span>
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 36 }}>
            {["sensor", "wifi", "power"].map((k) => (
              <Panel
                key={k}
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 25,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon kind={k} size={35} />
              </Panel>
            ))}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 1050,
            top: 415,
            width: 700,
            height: 380,
            transform: "scale(.46)",
            transformOrigin: "top left",
          }}
        >
          <Board f={200 + f} />
        </div>
        <div
          style={{
            position: "absolute",
            right: 140,
            bottom: 115,
            fontSize: 16,
            color: "#9aa0a6",
            background: "#1a1b20dd",
            borderRadius: 100,
            padding: "12px 22px",
          }}
        >
          Environmental monitor / concept scenery
        </div>
      </AbsoluteFill>
    </Stage>
  );
};
