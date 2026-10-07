# Browser computation implementation

Updated 7 October 2026. Browser runtime implemented for the supported design and firmware targets below. Earlier production builds and local Chromium/Firefox tests passed. The current changes add adaptive requirements interviewing, catalogue pricing and component correction. Deployed auth/payment, general project quality and physical USB checks remain acceptance work.

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
2. The requirements agent uses an adaptive completion policy in a browser worker: extract confirmed facts, ask only a missing architecture-critical question, and complete detailed briefs immediately. Each question offers project-specific choices. There is no fixed question-count limit: clarification continues until the required architecture facts are clear. Interview messages, selected option labels, question/answer records and confirmed requirements persist in the private chat. “All of the above” resolves against the original choices, and null/empty model fields cannot erase confirmed answers. If the model repeats an answered question, the worker chooses a missing requirement locally without an extra provider request. IndexedDB records each model turn before inference for replay, including answers saved before the previous four-question cap was removed. A saved design can be resumed for seven days on that device.
3. One logical Groq JSON request prepares requirements, architecture, exact part candidates and nets.

4. The browser validates the architecture and resolves manufacturer/package identity, actual symbol pins and footprint pads through the public catalogue. An LCSC code incorrectly placed in the manufacturer field is resolved to its verified identity. Passive offers must match their numerical value and package; contradictory supplied identities are blocked. Prices and stock come from catalogue listings, with source URLs and lookup timestamps, never from model estimates. Quotes are cached for at most 24 hours; Refresh components explicitly revalidates them. Geometry is cached for 30 days. Catalogue executable source is never imported.
5. The compiler maps explicit pins or schema 2.0 interface roles against the actual pins, checks connectivity/reference consistency and emits numeric allowlisted TSX. Missing parts or ambiguous pins become visible review findings.
6. Applicable resolved MCUs use one additional bounded model request for firmware source. Non-MCU projects make no firmware request.
7. The PCB worker places/routes validated components. It terminates before a separate worker produces SVGs. Reported engine errors or incomplete outputs prevent saving a successful board.
8. The Node API transactionally saves private artifacts and verifies ownership/current source IR. Browser previews always remain `verified: false`.
9. Code edits autosave; Code Assistant uses one bounded Groq request and local worker validation. Compilation and hardware upload require separate user actions.
10. Project ZIP contains project JSON, PCB IR, BOM CSV, firmware and saved board SVG/Circuit JSON. ZIP assembly runs locally. No fabricated Gerber approval is issued.

The BOM shows pricing coverage and a known-price subtotal when some quotes are missing. Unit prices exclude MOQ effects, shipping, assembly and tax; the INR toggle is explicitly an indicative conversion. CSV and project ZIP include price, stock and source metadata. Edit component accepts a verified manufacturer number/package/LCSC ID and runs lookup plus pin validation in a dedicated worker without an LLM call. A changed pin/component handoff retires the old private board and firmware mapping; unresolved findings disable board generation. Price-only refresh preserves an unchanged board.

This restores the agent sequence and key workflow behaviors. It does not silently replace every Python capability: the browser's supported footprint shapes, physical pin catalogue and firmware targets below still define the limits. A generic description such as USB-C-TYPE-A-RECEPTACLE and an external HC-SR04 module without a verified footprint cannot be manufactured as selected; supply verified identities or explicitly design a carrier connector in the requirements interview.

The gateway caps each response at 4,096 completion tokens. GPT-OSS models use low reasoning effort and omit reasoning text from the response, following [Groq's reasoning API](https://console.groq.com/docs/reasoning). Supported models use server-owned strict design/firmware/revision JSON schemas ([Groq structured outputs](https://console.groq.com/docs/structured-outputs)); other configured models retain JSON mode plus worker validation. Optional `null` part fields are treated as absent, while required fields and actual pin/geometry checks remain strict. Truncated replies are settled as provider usage and reported as an output-limit error rather than replayed as a complete design.

The gateway adds the exact schema as a system instruction, including required nullable fields and allowed component classes. An HTTP 400 with Groq's `json_validate_failed` code permits one recovery attempt in JSON-object mode; both attempts share a 60-second timeout and one quota/credit reservation. A recovered answer is validated by the browser worker and cached under the original request UUID. No retries are made for authentication, rate limits, model configuration or network failures. A second JSON rejection returns a safe 422 response and releases the reservation; rejected project text is never returned or logged. Provider-side costs for failed generations can still occur, and Groq may omit their token usage; the operator absorbs recovery costs within the existing two-credit tariff.

The worker validates the populated net representation and normalizes recognized interface/role spellings before pin resolution. For example, a null-interface net with `I2C CLOCK` members becomes interface `I2C` with role `CLOCK`; standalone `GPIO`/`PWM` roles also identify their interfaces. Empty inactive arrays are stripped. Ambiguous interfaces, conflicting representations and nets with fewer than two endpoints remain errors, and all physical pins still resolve against catalogue data. This normalization works with saved model responses, so resuming the interrupted run requires no new design inference. The reported six-net saved response passes normalization; 16 unit checks, six Chromium agent cases and TypeScript validation pass after this change.

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

Adaptive interview turns consume the same model allowance. With a detailed brief, requirements + design + optional firmware usually means 2–3 model turns (4–6 credits after free turns). Four questions followed by completed requirements, design and firmware can reach seven turns/14 credits. Catalogue prices, component refresh and PCB computation use no LLM credits.

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

Local macOS Chromium: the earlier 11 regression cases cover agent workers, recorded live response normalization, actual 32-pin ATmega/schema 2.0, refresh reconstruction without another inference, passive/NE555 routing, cancellation during blocked evaluator startup followed by a fresh run, multi-file Wire/SPI Uno compilation, private passive/MCU workspace persistence/reload and project ZIP contents. The six agent cases, including a new 422 rejection/resume check, pass after the gateway recovery change. Firefox: the seven earlier runtime/compiler lab cases passed; the expanded matrix is in CI. Eleven unit fixtures reject injection, mismatched parts/pads, invalid pin reuse and unsafe MicroPython writes. Backend replica-set suites previously passed 11 legacy credit checks; all 14 browser checks pass with Stripe enabled and disabled, including replay, monthly quota, encrypted BYOK, ownership, stale handoffs, deletion, truncated output and bounded JSON recovery/accounting. A separate live Groq design-and-routing test previously passed. A live NE555 design reproduced `json_validate_failed` before this fix and returned HTTP 200 with schema-valid JSON after adding the exact system instruction; this checks model output formatting, not electrical correctness.

CI schedules Chromium, Firefox and WebKit on Windows, macOS and Linux. Those remote results are not claimed as already observed. Local WebKit installation was interrupted by disk capacity. The live Groq smoke covered a small routing demonstration, not arbitrary engineering projects. Deployed auth/Atlas/Stripe, physical USB devices and electrical/fabrication validation still require acceptance. Fabrication downloads remain blocked for free and paid users. The browser workflow does not provide independent ERC, datasheet compliance, signal integrity or manufacturing approval.

7 October checks: all 24 local unit checks pass. The six Chromium agent cases pass, and both workspace cases pass through a persisted adaptive question/reload, priced BOM, local routing, component correction without inference, firmware editing and ZIP price/source export. The 15 browser backend checks passed in free mode; the two cases covering stale board ownership and transactional component/firmware retirement were rerun successfully after the final transaction change. A subsequent full billing-mode run was interrupted by development disk exhaustion. Disposable Mongo tests support `DUNKAI_TEST_LOW_DISK=true` to lower their index-build reserve only; deployed Mongo settings are unaffected. Live Groq produced a valid project-specific interview question, and live catalogue calls verified ATmega/C14877, 10k resistor and 0.1µF capacitor identities and prices. The latest production build has not been rerun on this constrained disk.

Deployment steps: [LAUNCH_RUNBOOK.md](LAUNCH_RUNBOOK.md). Legacy Python deployment reference: [CLOUD_ENGINE_RUNBOOK.md](CLOUD_ENGINE_RUNBOOK.md) and `render.cloud.yaml`.
