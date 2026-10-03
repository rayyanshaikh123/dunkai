import {
  useTime,
  Stage,
  Panel,
  Label,
  Chip,
  ease,
  pop,
  blue,
  muted,
  Icon,
} from "./design";
export const parts = [
  {
    ref: "U1",
    role: "PROCESSING",
    part: "MC9S08DZ32ACLC",
    pkg: "LQFP-32",
    x: 560,
    y: 470,
  },
  {
    ref: "U2",
    role: "WI-FI",
    part: "ESPC2-12-N4",
    pkg: "SMD module",
    x: 1030,
    y: 380,
  },
  {
    ref: "U7",
    role: "TEMPERATURE",
    part: "MCP9808T-E/MC",
    pkg: "DFN-8-EP",
    x: 1130,
    y: 670,
  },
  {
    ref: "U9",
    role: "HUMIDITY",
    part: "HDC2010YPAR",
    pkg: "DSBGA-6",
    x: 470,
    y: 690,
  },
];

const tints = ["#2d2942", "#24364b", "#392d2d", "#293b34"];
const icons = ["chip", "wifi", "sensor", "sensor"];
export const Components = () => {
  const f = useTime(),
    rows = ease(f, 80, 125),
    titleChange = ease(f, 85, 107);
  return (
    <Stage duration={180} motion="slide">
      <div style={{ position: "absolute", left: 140, top: 130 }}>
        <Label>02 / COMPONENTS → BILL OF MATERIALS</Label>
        <div
          style={{
            position: "relative",
            width: 1500,
            height: 110,
            marginTop: 22,
            fontSize: 85,
            fontWeight: 650,
            letterSpacing: -4,
          }}
        >
          <div
            style={{
              position: "absolute",
              opacity: 1 - titleChange,
              translate: `0 ${-titleChange * 20}px`,
            }}
          >
            Consider every little detail.
          </div>
          <div
            style={{
              position: "absolute",
              opacity: titleChange,
              translate: `0 ${(1 - titleChange) * 20}px`,
            }}
          >
            Everything falls into place.
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 230,
          top: 353,
          opacity: rows,
          display: "flex",
          gap: 35,
          color: muted,
          fontSize: 17,
          fontWeight: 600,
        }}
      >
        <span style={{ width: 95 }}>REF</span>
        <span style={{ width: 320 }}>PART NUMBER</span>
        <span style={{ width: 280 }}>FUNCTION</span>
        <span style={{ width: 240 }}>PACKAGE</span>
        <span>QTY</span>
      </div>
      {parts.map((p, i) => {
        const enter = pop(f, i * 18),
          x = (1 - rows) * (160 + i * 405) + rows * 205,
          y = (1 - rows) * (355 + (i % 2) * 22) + rows * (395 + i * 111);
        return (
          <Panel
            key={p.ref}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: 355 + rows * 1155,
              height: 415 - rows * 320,
              opacity: enter,
              translate: `0 ${(1 - enter) * 90 + Math.sin(f / 50 + i) * 3 * (1 - rows)}px`,
              rotate: (1 - rows) * [-3, 2, -2, 3][i] + "deg",
              background: `linear-gradient(145deg,#1a1b20d9,${tints[i]}${rows > 0.5 ? "50" : "b0"})`,
              borderRadius: 32 - rows * 10,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 27,
                top: 28 + rows * 6,
                fontSize: 18,
                color: blue,
                fontFamily: "Mono",
              }}
            >
              {p.ref}
            </div>
            <div
              style={{
                position: "absolute",
                right: 27,
                top: 26,
                opacity: 1 - rows,
              }}
            >
              <Icon kind={icons[i]} size={27} />
            </div>
            <div
              style={{
                position: "absolute",
                left: 115,
                top: 103,
                opacity: 1 - rows,
                scale: 1 - rows * 0.8,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: -30,
                  top: 105,
                  width: 185,
                  height: 35,
                  background: "#00000050",
                  filter: "blur(14px)",
                  borderRadius: "50%",
                }}
              />
              <Chip label={p.ref} size={120} tint={tints[i]} />
            </div>
            <div
              style={{
                position: "absolute",
                left: 27 + rows * 128,
                top: 279 - rows * 244,
                fontSize: 24,
                fontWeight: 650,
                whiteSpace: "nowrap",
              }}
            >
              {p.part}
            </div>
            <div
              style={{
                position: "absolute",
                left: 27 + rows * 482,
                top: 328 - rows * 291,
                fontSize: 17,
                fontWeight: 700,
                letterSpacing: 1.4,
                color: muted,
              }}
            >
              {p.role}
            </div>
            <div
              style={{
                position: "absolute",
                left: 825,
                top: 36,
                fontFamily: "Mono",
                fontSize: 20,
                color: muted,
                opacity: rows,
              }}
            >
              {p.pkg}
            </div>
            <div
              style={{
                position: "absolute",
                left: 1100,
                top: 32,
                fontSize: 25,
                opacity: rows,
                fontWeight: 650,
              }}
            >
              1
            </div>
          </Panel>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 210,
          bottom: 112,
          fontSize: 20,
          color: muted,
          opacity: ease(f, 135, 155),
        }}
      >
        Real part numbers. One beautifully organized BOM.
      </div>
    </Stage>
  );
};
