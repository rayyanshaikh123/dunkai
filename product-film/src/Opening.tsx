import {
  useTime,
  Stage,
  ease,
  Label,
  Serif,
  Kevin,
  Panel,
  Icon,
  blue,
} from "./design";
const tools = [
  {
    title: "Architecture",
    detail: "Connect the system",
    x: 1110,
    y: 210,
    icon: "wifi",
    angle: -7,
  },
  {
    title: "Components",
    detail: "Choose every part",
    x: 1370,
    y: 400,
    icon: "chip",
    angle: 6,
  },
  {
    title: "PCB layout",
    detail: "Route every signal",
    x: 1040,
    y: 620,
    icon: "power",
    angle: -4,
  },
  {
    title: "Firmware",
    detail: "Bring it to life",
    x: 1380,
    y: 800,
    icon: "sensor",
    angle: 5,
  },
];
export const Opening = () => {
  const f = useTime(),
    resolve = ease(f, 83, 115);
  return (
    <Stage duration={150}>
      <div
        style={{
          position: "absolute",
          left: 145,
          top: 270,
          opacity: ease(f, 5, 22) * (1 - resolve),
          translate: `${-resolve * 100}px 0`,
        }}
      >
        <Label>HARDWARE STARTS WITH AN IDEA.</Label>
        <div
          style={{
            fontSize: 112,
            fontWeight: 700,
            letterSpacing: -6,
            lineHeight: 1.05,
            marginTop: 30,
          }}
        >
          One idea.
          <br />
          <Serif>Too many tools.</Serif>
        </div>
        <div
          style={{
            fontSize: 29,
            color: "#9aa0a6",
            marginTop: 40,
            lineHeight: 1.5,
          }}
        >
          Specs. Parts. Boards. Code.
          <br />
          And all the handoffs in between.
        </div>
      </div>
      <svg
        width="1920"
        height="1080"
        style={{
          position: "absolute",
          opacity: (1 - resolve) * ease(f, 24, 55),
        }}
      >
        <path
          d="M 1280 340 L 1480 455 M 1430 530 L 1230 700 M 1300 750 L 1470 850"
          fill="none"
          stroke="#8ab4f850"
          strokeWidth="2"
          strokeDasharray="7 13"
        />
      </svg>
      {tools.map((tool, i) => {
        const enter = ease(f, 10 + i * 9, 30 + i * 9);
        return (
          <Panel
            key={tool.title}
            style={{
              position: "absolute",
              left: tool.x + (960 - tool.x - 165) * resolve,
              top: tool.y + (420 - tool.y) * resolve,
              width: 340,
              padding: 25,
              opacity: enter * (1 - resolve),
              scale: 1 - resolve * 0.6,
              rotate: `${tool.angle * (1 - resolve)}deg`,
              translate: `0 ${(1 - enter) * 70}px`,
            }}
          >
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <Icon kind={tool.icon} size={35} />
              <span style={{ fontSize: 28, fontWeight: 650 }}>
                {tool.title}
              </span>
            </div>
            <div style={{ color: "#9aa0a6", fontSize: 19, marginTop: 17 }}>
              {tool.detail}
            </div>
          </Panel>
        );
      })}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          opacity: resolve,
          scale: 0.85 + resolve * 0.15,
        }}
      >
        <Panel
          style={{
            width: 180,
            height: 180,
            display: "grid",
            placeItems: "center",
            borderRadius: 45,
            boxShadow: "0 0 140px #8ab4f825,inset 0 1px 1px #ffffff20",
          }}
        >
          <Kevin size={126} />
        </Panel>
        <div
          style={{
            fontSize: 110,
            fontWeight: 700,
            letterSpacing: -6,
            marginTop: 32,
          }}
        >
          Meet <span style={{ color: blue }}>Dunk AI.</span>
        </div>
        <div style={{ fontSize: 29, color: "#9aa0a6", marginTop: 20 }}>
          One prompt. A connected engineering workflow.
        </div>
      </div>
    </Stage>
  );
};
