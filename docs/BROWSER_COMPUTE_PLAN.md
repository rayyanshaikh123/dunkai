# Browser computation implementation

Updated 6 October 2026. Browser runtime implemented for the supported design and firmware targets below. Production builds and local Chromium/Firefox tests pass. Live provider, deployed auth/payment and physical USB checks remain deployment acceptance work.

## Architecture for every user

The deployment uses the existing frontend, Node API and MongoDB Atlas. Every account follows the same browser execution path. No Python engine, Redis worker, tunnel, installer, local model download or owner-operated computer is needed for this path.

```text
Website on the visitor's device
  ├── simple confirmation, progress, Cancel
  ├── orchestration worker: prompts, JSON schemas, catalogue, pin mapping
  ├── PCB evaluator worker: placement and routing
  ├── preview worker: structural checks and SVG
  ├── firmware worker: AVR Clang/LLD WebAssembly compiler
  ├── export worker: project ZIP
  └── authenticated requests → existing Node API
        ├── auth, projects, encrypted Groq BYOK
        ├── Groq inference relay → Groq's remote model
        ├── server-authoritative free quota/credit ledger
        ├── Stripe Checkout when enabled
        └── private chat/board storage → Atlas
```

Groq performs model inference remotely. The visitor supplies the CPU and memory for deterministic design work. Keys remain on the Node API; neither operator nor BYOK credentials enter a worker. Workers run separately from the UI thread ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)), but share the device's resources. No browser can guarantee a CPU percentage or uninterrupted execution after the tab closes.

## Implemented workflow

1. The signed-in project asks for a confirmation before computation or a model request.
2. IndexedDB saves account/project/chat-scoped input and request UUIDs before inference. A saved design can be resumed for seven days on that device.
3. One bounded Groq JSON request prepares requirements, architecture, exact part candidates and nets.

4. The browser validates the architecture and resolves manufacturer/package identity, actual symbol pins and footprint pads through the public catalogue. Catalogue executable source is never imported. Public geometry is cached for 30 days; price/stock are not invented or advertised as current.
5. The compiler maps explicit pins or schema 2.0 interface roles against the actual pins, checks connectivity/reference consistency and emits numeric allowlisted TSX. Missing parts or ambiguous pins become visible review findings.
6. Applicable resolved MCUs use one additional bounded model request for firmware source. Non-MCU projects make no firmware request.
7. The PCB worker places/routes validated components. It terminates before a separate worker produces SVGs. Reported engine errors or incomplete outputs prevent saving a successful board.
8. The Node API transactionally saves private artifacts and verifies ownership/current source IR. Browser previews always remain `verified: false`.
9. Code edits autosave; Code Assistant uses one bounded Groq request and local worker validation. Compilation and hardware upload require separate user actions.
10. Project ZIP contains project JSON, PCB IR, BOM CSV, firmware and saved board SVG/Circuit JSON. ZIP assembly runs locally. No fabricated Gerber approval is issued.

The gateway caps each response at 4,096 completion tokens. GPT-OSS models use low reasoning effort and omit reasoning text from the response, following [Groq's reasoning API](https://console.groq.com/docs/reasoning). Supported models use server-owned strict design/firmware/revision JSON schemas ([Groq structured outputs](https://console.groq.com/docs/structured-outputs)); other configured models retain JSON mode plus worker validation. Optional `null` part fields are treated as absent, while required fields and actual pin/geometry checks remain strict. Truncated replies are settled as provider usage and reported as an output-limit error rather than replayed as a complete design.

## Supported design bounds

| Item | Support |
| --- | --- |
| Components | 2–32 components; up to 512 connected pins and 256 nets |
| Local passives | Resistors/capacitors in 0402, 0603, 0805, 1206; generic parts remain unpriced and unverified |
| Vetted legacy IC | Exact NE555P DIP8 pin mapping |
| General ICs/connectors | Exact catalogue identity with matching symbol and rectangular/circular/pill SMT pads or round plated holes |
| Net schemas | Explicit pin connections and supported schema 2.0 interface/role members |
| Interfaces | Power, GPIO, ADC, PWM, I2C, SPI, UART, USB, CAN, OneWire, I2S, SDIO when actual labelled pins resolve |
| Board | Two layers; rectangular outline, 20–200 mm |
| Unsupported geometry | Polygon pads/plated slots, missing pins, ambiguous mappings fail with findings |

The [catalogue API](https://github.com/tscircuit/jlcsearch/blob/main/README.md) is an external availability dependency. An exact verified LCSC ID can bypass free-text search, but its manufacturer/package must still match. No match, an outage or incompatible geometry prevents that board from being completed; changing an MPN silently is prohibited. Catalogue resolution is structural evidence, not electrical validation.

## Firmware targets

| Target | Browser behavior |
| --- | --- |
| ATmega328P Uno/Nano, 16 MHz | Actual multi-file C/C++ compilation and linking; Arduino core, Wire/SPI; Intel HEX download; browser STK500 upload where Web Serial is available |
| ESP32/RP2040 with existing MicroPython | Generate/edit/download Python source; save `.py` files through raw REPL where Web Serial is available; does not execute code or install MicroPython |
| Other MCUs | Source review/export only; no claim of a compatible compiler/flasher |

The compiler downloads about 28 MB from the same site on first use. The toolchain is pinned and SHA-256 checked at build time. Sources, hashes, licenses and rebuild references are served under `/vendor/avr/`. Compiler/linker run in a worker and are terminated on cancellation or after 180 seconds. Firmware never executes inside the authenticated website.

Board routing is bounded to five minutes; agent work to five minutes; catalogue requests have 12-second attempt limits and at most two attempts. Files and output geometry have additional caps. These are workload bounds, not guarantees about device RAM. Hardware upload is an explicit action, and source/HEX download remains available without Web Serial.

## Recovery and credits

- Each model request has a unique UUID. The Node API claims it before reserving credits; concurrent duplicate requests cannot invoke Groq twice.
- Completed answers replay for 24 hours on the API. The durable ledger rejects reuse after replay expiry. Browser checkpoints also retain completed stage answers.
- Refresh/resume reuses completed answers and reconstructs artifacts. Message persistence has a chat-scoped idempotency key. Retry of an explicitly failed model stage uses a new request ID after a confirmed resume; it retains the other stage's answer.
- Cancel stops local workers. A provider request already accepted may still finish and be charged; its result remains replayable.
- A backend crash during provider processing can leave a pending record. Do not invent a result or retry it as free; reconcile the provider/ledger state before recovery. Browser storage is a working copy, and private Atlas artifacts plus downloaded archives are the durable project outputs.

## Freemium offer

Five **hosted model requests** per verified account per UTC month. Each hosted request after those costs two credits. No new 150-credit trial grant in browser mode. Existing balances are retained. Groq BYOK and local PCB/compilation/export work cost zero DunkAI credits; provider quotas and API rate limits still apply.

| Operation | Model requests | Credits after free allowance |
| --- | ---: | ---: |
| Non-MCU design | 1 | 2 |
| MCU design with firmware | 2 | 4 |
| Code revision | 1 | 2 |
| Rebuild PCB from saved IR | 0 | 0 |
| Local firmware compile / project export | 0 | 0 |
| Resume completed stage answers | 0 | 0 |

Free quota enforcement is active with `BROWSER_COMPUTE_ONLY=true` even when `BILLING_ENABLED=false`. That flag disables purchases, not the free allowance. Stripe INR packs remain 200/₹200, 500/₹500 and 1500/₹1500 when enabled. These are fixed operation tariffs; measured provider costs and actual merchant fees must establish profit rather than claiming a guaranteed margin.

## Test evidence and remaining acceptance

Local macOS Chromium: agent worker, cancellation, actual 32-pin ATmega/schema 2.0, refresh reconstruction without another inference, passive/NE555 routing, multi-file Wire/SPI Uno compilation, private workspace persistence/reload and project ZIP contents. Firefox: the seven runtime/compiler lab cases passed. Unit fixtures reject injection, mismatched parts/pads and invalid pin reuse. Mock serial tests check safe MicroPython writes, cancellation and device errors. Backend replica-set tests exercise replay, free quota without Stripe, encrypted BYOK, ownership, stale handoffs and deletion.

CI schedules Chromium, Firefox and WebKit on Windows, macOS and Linux. Those remote results are not claimed as already observed. Local WebKit installation was interrupted by disk capacity. Live Groq, deployed auth/Atlas/Stripe, physical USB devices and electrical/fabrication validation still require acceptance. Fabrication downloads remain blocked for free and paid users. The browser workflow does not provide independent ERC, datasheet compliance, signal integrity or manufacturing approval.

Deployment steps: [LAUNCH_RUNBOOK.md](LAUNCH_RUNBOOK.md). Legacy Python deployment reference: [CLOUD_ENGINE_RUNBOOK.md](CLOUD_ENGINE_RUNBOOK.md) and `render.cloud.yaml`.
