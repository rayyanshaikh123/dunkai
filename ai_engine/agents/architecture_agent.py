"""LLM-backed Architecture Agent for dunkai.

The upstream requirement agent stops at ``HardwareRequirements``. This
module turns that JSON into a vendor-neutral architecture model and a
React Flow-compatible graph by calling a Groq-hosted model twice:

  Stage 1 - subsystem inference ("Senior Embedded Systems Architect")
      Sends the requirements to the model with the system prompt that
      instructs it to infer only purchasable electronic subsystems
      (never physical objects, consumables, materials, actions, or raw
      outputs) and to return
      ``{"subsystems": [{"label", "category", "reason", "confidence"}]}``.

  Stage 2 - graph construction ("Embedded Hardware Architecture Engineer")
      Sends the validated subsystem list from stage 1 to the model with
      the system prompt that instructs it to build nodes/edges without
      inventing or removing subsystems, and to return
      ``{"nodes": [...], "edges": [...]}``.

There is deliberately no keyword table, substring matcher, or label ->
category/interface lookup in this file. All domain reasoning (which
subsystems a requirement implies, which interface a peripheral uses,
which subsystems must be wired together) is left entirely to the model.
This module's own code only:
  * sends the two prompts verbatim as system prompts,
  * calls Groq through langchain_groq's ChatGroq client,
  * parses the returned JSON,
  * validates the returned categories/interfaces against the allowed
    enums the prompts themselves define (schema validation, not
    inference), and
  * assembles the final ``ArchitectureResult`` structurally from
    whatever the model returned (grouping by the category field the
    model itself assigned).
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_groq import ChatGroq
try:
    from .usage_meter import USAGE_CALLBACK
except ImportError:
    from usage_meter import USAGE_CALLBACK

try:
    from .credentials import groq_api_key
    from .groq_limits import GroqQuotaExhausted, invoke_with_limits
except ImportError:  # imported as a top-level module by the supervisor
    from credentials import groq_api_key
    from groq_limits import GroqQuotaExhausted, invoke_with_limits

# llama-3.3-70b-versatile, as requested. Note: Groq has this on a deprecation
# path (announced June 17, 2026) in favor of openai/gpt-oss-120b /
# qwen/qwen3.6-27b -- override via GROQ_MODEL if/when it's retired.
DEFAULT_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")

ALLOWED_CATEGORIES = {
    "Processing", "Power", "Communication", "Input", "Output", "Sensor",
    "Storage", "Security", "Memory", "Clock", "Expansion", "Network",
}
ALLOWED_INTERFACES = {
    "GPIO", "UART", "SPI", "I2C", "USB", "CAN", "Ethernet", "PCIe",
    "SDIO", "Power", "BLE", "WiFi", "RF", "Audio", "Analog", "ADC", "PWM", "I2S",
    # Single-wire sensors (DS18B20 and kin) talk 1-Wire. Without it in the
    # vocabulary the model filed them under UART, and the board stage found no
    # TX/RX pins on the part (dunkai-designer D-015).
    "OneWire",
}

# Spellings of an interface the model uses that are not the canonical form.
_INTERFACE_SYNONYMS = {"1-wire": "OneWire", "1wire": "OneWire", "one-wire": "OneWire", "one wire": "OneWire"}

# The model names subsystems in its own words, and a screen is the standard
# example: it reports "Display" where this taxonomy files it under "Output".
# Those near-misses used to abort the whole pipeline, so map the common ones
# onto the canonical category instead. This is spelling, not domain reasoning
# -- a category with no entry here still raises, so a genuinely new concept
# surfaces rather than being silently folded into the wrong bucket.
_CATEGORY_SYNONYMS = {
    "display": "Output",
    "screen": "Output",
    "lcd": "Output",
    "oled": "Output",
    "led": "Output",
    "indicator": "Output",
    "actuator": "Output",
    "ui": "Output",
    "user interface": "Output",
    "audio": "Output",
    "sensing": "Sensor",
    "sensors": "Sensor",
    "power management": "Power",
    "battery": "Power",
    "compute": "Processing",
    "processor": "Processing",
    "mcu": "Processing",
    "microcontroller": "Processing",
    "comms": "Communication",
    "connectivity": "Communication",
    "wireless": "Communication",
    "memory/storage": "Storage",
}


def _canon_category(category: Any) -> str:
    """Fold a model-supplied category onto the canonical spelling."""
    text = str(category or "").strip()
    synonym = _CATEGORY_SYNONYMS.get(text.lower())
    if synonym:
        return synonym
    # Title-case recovers casing drift ("power" -> "Power"). Every allowed
    # category is a single word, so this cannot mangle a legitimate value.
    return text.title()


def _canon_interface(interface: Any) -> str:
    """Fold a model-supplied interface onto the canonical spelling.

    Matched case-insensitively against ALLOWED_INTERFACES rather than
    title-cased, because the canonical forms are not title-case ("WiFi",
    "GPIO", "I2C") and ``"wifi".title()`` would not round-trip.
    """
    text = str(interface or "").strip()
    if text.lower() in _INTERFACE_SYNONYMS:
        return _INTERFACE_SYNONYMS[text.lower()]
    for allowed in ALLOWED_INTERFACES:
        if text.lower() == allowed.lower():
            return allowed
    return text

SUBSYSTEM_INFERENCE_PROMPT = """\
# ROLE
You are a Senior Embedded Systems Architect with expertise in consumer electronics, industrial automation, IoT, robotics, medical devices, automotive electronics, and embedded hardware system design.
Your task is NOT to design a PCB.
Your task is to infer the electronic building blocks required to implement the user's requirements.
You are creating a technology-neutral hardware architecture.
You DO NOT select manufacturers, IC part numbers, PCB footprints, vendors, or passive components.
Your job is to identify the electronic subsystems that must exist.
--------------------------------------------------
# INPUT
You will receive HardwareRequirements JSON.
--------------------------------------------------
# GOAL
Infer all required electronic subsystems.
The output should represent ONLY purchasable electronic building blocks.
--------------------------------------------------
# IMPORTANT RULES
Only include electronic subsystems.
Examples
\u2714 MCU
\u2714 Wireless MCU
\u2714 Camera Sensor
\u2714 IMU Sensor
\u2714 Display
\u2714 Bluetooth Module
\u2714 USB Interface
\u2714 Battery
\u2714 Power Management
\u2714 Flash Storage
\u2714 Motor Driver
\u2714 GNSS Receiver
\u2714 Temperature Sensor
\u2714 Pressure Sensor
\u2714 Capacitive Touch Controller
--------------------------------------------------
Never output
Physical objects
Examples
\u274c Printed Object
\u274c Water
\u274c Purified Water
\u274c Filament
\u274c Air
\u274c Food
\u274c User
\u274c Vehicle
Consumables
\u274c Ink
\u274c Paper
\u274c Battery Pack (unless battery is required)
\u274c Filament Roll
Materials
\u274c Plastic
\u274c Steel
\u274c Glass
Actions
\u274c Heating
\u274c Cooling
\u274c Motion
\u274c Printing
Outputs
\u274c Audio
\u274c Water
\u274c Printed Objects
Instead infer the subsystem responsible.
Example
Printed Object
\u2193
Stepper Motor Driver
Extruder Heater
Cooling Fan
--------------------------------------------------
Infer missing hardware.
If Bluetooth is required
\u2193
Bluetooth Module
If Camera is required
\u2193
Camera Sensor
If Motion Tracking
\u2193
IMU Sensor
If Position Tracking
\u2193
GNSS Receiver
If Audio Input
\u2193
MEMS Microphone
If Audio Output
\u2193
Speaker Driver
If Display
\u2193
Display
If USB
\u2193
USB Interface
If Motor Control
\u2193
Motor Driver
If Battery Powered
\u2193
Battery
Power Management
--------------------------------------------------
Never infer
Manufacturer
Part Number
Voltage
PCB Layout
Firmware
--------------------------------------------------
Return JSON only, with no preamble, no markdown fences, and no commentary.
{
    "subsystems":[
        {
            "label":"",
            "category":"",
            "reason":"",
            "confidence":0.95
        }
    ]
}
--------------------------------------------------
# CATEGORY (STRICT)
The "category" field MUST be copied verbatim from this list. It is a closed set.
Processing, Power, Communication, Input, Output, Sensor, Storage, Security, Memory, Clock, Expansion, Network.

Do NOT invent a category, not even an obviously sensible one. Map the subsystem
onto the closest value above instead:
- A display, screen, LCD, OLED, LED, indicator, buzzer, speaker or any actuator
  that presents information to the user is "Output" -- NOT "Display".
- A button, keypad, touch panel, switch or dial is "Input".
- A measuring element (temperature, IMU, light, current sense) is "Sensor".
- A regulator, PMIC, charger, battery or supply rail is "Power".
- An MCU, SoC, CPU or FPGA is "Processing".
- A radio, modem, BLE/WiFi module or transceiver is "Communication".
If nothing fits well, choose the nearest value and explain the compromise in
"reason". Any category outside the list above is rejected and the whole design
run fails.
"""

GRAPH_CONSTRUCTION_PROMPT = """\
# ROLE
You are an Embedded Hardware Architecture Engineer.
Your input is a validated list of electronic subsystems.
Your job is to construct a logical hardware architecture graph.
DO NOT invent new subsystems.
DO NOT remove existing subsystems.
Only create relationships.
--------------------------------------------------
INPUT
{
    "subsystems":[]
}
--------------------------------------------------
GOAL
Generate
1 Nodes
2 Connections
3 Interfaces
--------------------------------------------------
Allowed Categories
Copy these verbatim. The set is closed -- do not invent a category. A display,
screen, LCD, OLED, LED or buzzer is "Output", never "Display". Anything outside
this list is rejected and the run fails.
Processing
Power
Communication
Input
Sensor
Output
Storage
Memory
Clock
Security
Expansion
Network
--------------------------------------------------
Allowed Interfaces
GPIO
UART
SPI
I2C
USB
CAN
Ethernet
PCIe
SDIO
Power
BLE
WiFi
RF
Audio
Analog
ADC
PWM
I2S
OneWire
--------------------------------------------------
Interface choice
Use the interface the PART actually has, not a convenient bus:
a 1-Wire temperature sensor (DS18B20 type) uses OneWire, not UART;
a bare 7-segment or LED display is driven by GPIO (or through a driver IC
on SPI/I2C), not SPI directly.
--------------------------------------------------
Rules
Every processing unit must connect to
Power Management
Every Battery must connect to
Power Management
Every peripheral must connect to
Processing Unit
Power must be supplied from
Power Management
Communication modules
\u2193
BLE
WiFi
USB
UART
CAN
Sensors
\u2193
Usually I2C
Displays
\u2193
SPI unless specified
Microphones
\u2193
Audio
Buttons
\u2193
GPIO
LEDs
\u2193
GPIO
--------------------------------------------------
Never
Choose ICs
Choose vendors
Choose packages
Choose footprints
Choose PCB details
--------------------------------------------------
Return JSON only, with no preamble, no markdown fences, and no commentary, in the shape:
{
    "nodes":[
        {"id": "", "label": "", "category": ""}
    ],
    "edges":[
        {"source": "", "target": "", "interface": ""}
    ]
}
"""


def _slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"```$", "", text)
    return text.strip()


def _json_generation_failed(exc: Exception) -> bool:
    """Groq rejected the reply as invalid JSON (json_object mode)."""
    return "json_validate_failed" in str(exc)


def _call_groq(system_prompt: str, user_content: str, *, model: str | None = None,
               max_tokens: int = 8000) -> str:
    """Call Groq via langchain_groq and return the reply text.

    Uses the request's own Groq key when the user brought one (BYOK), else
    ``GROQ_API_KEY``. Raises ``RuntimeError`` on transport or API errors.

    Output budget
    -------------
    The gpt-oss models reason before they answer, and ``max_tokens`` covers the
    reasoning AND the JSON. When the reasoning uses the whole budget, no JSON is
    written, and Groq rejects the empty reply as ``json_validate_failed`` with
    ``failed_generation: ''`` — which is how a larger design used to kill the
    graph stage at the old 4000 cap. Reasoning length varies run to run (1.2k to
    1.6k tokens for the same 12-subsystem graph, measured), so the cap is 8000,
    and a rejected reply is retried once at low reasoning effort, which keeps the
    reasoning short enough for the answer to fit. The cap is a ceiling, not a
    charge: Groq counts tokens actually used against the per-minute limit.
    """
    try:
        api_key = groq_api_key()
    except EnvironmentError as exc:
        raise RuntimeError(str(exc)) from exc

    messages = [SystemMessage(content=system_prompt), HumanMessage(content=user_content)]

    def call(name: str, effort: str | None = None):
        extra = {}
        # Only gpt-oss takes low/medium/high; other models (qwen) use different values.
        if effort and name.startswith("openai/gpt-oss"):
            extra["reasoning_effort"] = effort
        llm = ChatGroq(
            model=name,
            groq_api_key=api_key,
            temperature=0,
            max_tokens=max_tokens,
            max_retries=2,
            model_kwargs={"response_format": {"type": "json_object"}},
            callbacks=[USAGE_CALLBACK],
            **extra,
        )
        return llm.invoke(messages)

    # Rate limits are handled in groq_limits (wait on a per-minute limit, fall
    # back to another model on a spent daily one); anything else is an API error.
    requested = model or DEFAULT_MODEL
    try:
        response, _ = invoke_with_limits(call, requested, agent="Architecture Agent")
    except GroqQuotaExhausted:
        raise
    except Exception as exc:
        if not _json_generation_failed(exc):
            raise RuntimeError(f"Groq API error: {exc}") from exc
        print("[Architecture Agent] Model returned no valid JSON; retrying once with low reasoning effort.")
        try:
            response, _ = invoke_with_limits(
                lambda name: call(name, effort="low"), requested, agent="Architecture Agent"
            )
        except GroqQuotaExhausted:
            raise
        except Exception as retry_exc:
            if _json_generation_failed(retry_exc):
                raise RuntimeError(
                    "the model did not produce valid architecture JSON, twice (it most likely spent its "
                    "output budget reasoning). Try again, or choose a different model in the chat's model picker."
                ) from retry_exc
            raise RuntimeError(f"Groq API error: {retry_exc}") from retry_exc

    content = response.content
    if not content:
        raise RuntimeError(f"No message content returned by the model: {response}")
    return content



def _validate_subsystems(subsystems: list[dict[str, Any]]) -> list[dict[str, Any]]:
    validated = []
    for subsystem in subsystems:
        raw = subsystem.get("category")
        category = _canon_category(raw)
        if category not in ALLOWED_CATEGORIES:
            raise ValueError(f"Model returned an unsupported subsystem category: {raw!r}")
        # Write the canonical value back: everything downstream buckets on an
        # exact string match (user_interface_modules == "Output", etc.).
        subsystem["category"] = category
        validated.append(subsystem)
    return validated


def _validate_graph(graph: dict[str, Any]) -> dict[str, Any]:
    for node in graph.get("nodes", []):
        raw = node.get("category")
        category = _canon_category(raw)
        if category not in ALLOWED_CATEGORIES:
            raise ValueError(f"Model returned an unsupported node category: {raw!r}")
        node["category"] = category
    for edge in graph.get("edges", []):
        raw = edge.get("interface")
        interface = _canon_interface(raw)
        if interface not in ALLOWED_INTERFACES:
            raise ValueError(f"Model returned an unsupported edge interface: {raw!r}")
        edge["interface"] = interface
    return graph


def infer_subsystems(
    requirements: dict[str, Any],
    *,
    model: str | None = None,
    revision_instruction: str | None = None,
    existing_subsystems: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Stage 1: ask the model to infer the required electronic subsystems.

    ``revision_instruction``/``existing_subsystems`` are set when this is a
    targeted "revise the architecture" chat turn on a design that already has
    one, rather than the initial build -- the instruction and prior subsystem
    list are prepended as plain-language context ahead of the requirements
    JSON so the model edits/extends what exists instead of guessing fresh.
    """
    if not isinstance(requirements, dict):
        raise TypeError("requirements must be a JSON object")

    user_content = json.dumps(requirements)
    if revision_instruction:
        context = (
            f'The user already has a design and asked for this specific revision: '
            f'"{revision_instruction}"\n'
        )
        if existing_subsystems:
            context += f"Existing subsystems (keep what's still valid, adjust per the revision): {json.dumps(existing_subsystems)}\n"
        user_content = context + "\nRequirements:\n" + user_content

    reply = _call_groq(
        SUBSYSTEM_INFERENCE_PROMPT,
        user_content,
        model=model,
    )
    parsed = json.loads(_strip_code_fence(reply))
    return _validate_subsystems(parsed.get("subsystems", []))


def build_graph(subsystems: list[dict[str, Any]], *, model: str | None = None) -> dict[str, Any]:
    """Stage 2: ask the model to wire the validated subsystems into a graph."""
    reply = _call_groq(
        GRAPH_CONSTRUCTION_PROMPT,
        json.dumps({"subsystems": subsystems}),
        model=model,
    )
    parsed = json.loads(_strip_code_fence(reply))
    graph = _validate_graph({"nodes": parsed.get("nodes", []), "edges": parsed.get("edges", [])})

    # Re-shape into the React Flow node/edge format. This is pure structural
    # re-formatting of what the model already decided -- it does not choose
    # any label, category, or interface itself.
    nodes = [
        {
            "id": node.get("id") or _slug(node.get("label", "")),
            "type": "architecture",
            "data": {
                "label": node.get("label", ""),
                "category": node.get("category", ""),
            },
        }
        for node in graph["nodes"]
    ]
    edges = [
        {
            "id": f"{edge['source']}-{edge['interface'].lower()}-{edge['target']}",
            "source": edge["source"],
            "target": edge["target"],
            "type": "smoothstep",
            "label": edge["interface"],
            "data": {"interface": edge["interface"]},
            "markerEnd": {"type": "arrowclosed"},
        }
        for edge in graph["edges"]
    ]
    return {"nodes": nodes, "edges": edges}


def build_architecture(
    requirements: dict[str, Any],
    *,
    model: str | None = None,
    revision_instruction: str | None = None,
    existing_architecture: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compose stage 1 and stage 2 into the full ``ArchitectureResult``.

    All subsystem/interface decisions come from the model. This function
    only aggregates the model's own output by the fields the model itself
    returned (e.g. grouping subsystem labels by the category the model
    assigned) -- it performs no independent domain inference.

    ``revision_instruction``/``existing_architecture`` make this a targeted
    edit of an already-built architecture (see ``infer_subsystems``) instead
    of a from-scratch build; both are optional and unused on a first build.
    """
    subsystems = infer_subsystems(
        requirements,
        model=model,
        revision_instruction=revision_instruction,
        existing_subsystems=(existing_architecture or {}).get("subsystems"),
    )
    graph = build_graph(subsystems, model=model)

    processing_labels = [s["label"] for s in subsystems if s["category"] == "Processing"]
    processing_label = processing_labels[0] if processing_labels else None

    assumptions = [
        f'{s["label"]} is a model-inferred subsystem ({s.get("reason", "no reason given")}); '
        f'confidence {s.get("confidence")}.'
        for s in subsystems
        if s.get("confidence") is not None and s["confidence"] < 0.9
    ]

    warnings: list[str] = []
    if not subsystems:
        warnings.append("The model returned no subsystems for these requirements.")
    if processing_label is None:
        warnings.append("The model did not return a Processing subsystem.")
    warnings.extend(_check_power_wiring(graph))

    _bucketed_categories = {
        "Communication", "Network", "Input", "Sensor", "Output", "Power", "Storage",
    }
    other_modules = [
        s["label"] for s in subsystems if s["category"] not in _bucketed_categories | {"Processing"}
    ]

    return {
        "architecture_model": {
            "processing_unit": processing_label,
            "communication_modules": [s["label"] for s in subsystems if s["category"] in {"Communication", "Network"}],
            "sensing_modules": [s["label"] for s in subsystems if s["category"] in {"Input", "Sensor"}],
            "user_interface_modules": [s["label"] for s in subsystems if s["category"] == "Output"],
            "power_subsystem": [s["label"] for s in subsystems if s["category"] == "Power"],
            "storage_modules": [s["label"] for s in subsystems if s["category"] == "Storage"],
            # Memory / Clock / Security / Expansion (and any other allowed
            # category not already bucketed above) land here so nothing the
            # model returns silently disappears from the summary.
            "other_modules": other_modules,
            "interfaces": sorted({edge["data"]["interface"] for edge in graph["edges"]}),
        },
        "architecture_graph": graph,
        "subsystems": subsystems,
        "assumptions": assumptions,
        "warnings": warnings,
    }


def _check_power_wiring(graph: dict[str, Any]) -> list[str]:
    """Flag any non-Power node that never received a Power edge.

    Purely structural: it looks only at the categories and edge interfaces
    the model itself returned, and does not decide *how* anything should be
    wired -- it just checks whether the model's own stated rule ("Power must
    be supplied from Power Management") was actually followed.
    """
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    category_by_id = {n["id"]: n["data"].get("category") for n in nodes}
    label_by_id = {n["id"]: n["data"].get("label", n["id"]) for n in nodes}

    power_ids = {node_id for node_id, category in category_by_id.items() if category == "Power"}
    peripheral_ids = {node_id for node_id in category_by_id if node_id not in power_ids}

    powered_ids: set[str] = set()
    for edge in edges:
        if edge.get("data", {}).get("interface") != "Power":
            continue
        source, target = edge.get("source"), edge.get("target")
        if source in power_ids and target in peripheral_ids:
            powered_ids.add(target)
        elif target in power_ids and source in peripheral_ids:
            powered_ids.add(source)

    unpowered = sorted(label_by_id[node_id] for node_id in peripheral_ids - powered_ids)
    if not unpowered:
        return []
    return [
        f"{len(unpowered)} subsystem(s) have no Power edge from a Power-category node "
        f"(the graph's own 'power must be supplied from Power Management' rule is unmet): "
        f"{', '.join(unpowered)}."
    ]


def build_architecture_json(requirements: dict[str, Any], *, indent: int = 2, model: str | None = None) -> str:
    return json.dumps(build_architecture(requirements, model=model), indent=indent)


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    print(build_architecture_json(payload))
