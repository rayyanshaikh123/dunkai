"""LangGraph node wrappers around existing dunkai agents.

Each node reads from ``CircuitState``, calls the underlying agent logic
without modifying it, and returns a partial state update.
"""

from __future__ import annotations

import json
import logging
import sys
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage

try:
    from .state import CircuitState
except ImportError:
    from state import CircuitState

logger = logging.getLogger(__name__)

AGENTS_ROOT = Path(__file__).resolve().parent.parent
COMPONENT_AGENT_DIR = AGENTS_ROOT / "component_agent"

if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))


# ---------------------------------------------------------------------------
# Lazy imports for heavy / optional dependencies
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _component_agent_modules() -> dict[str, Any]:
    """Import component-agent modules from their package directory."""
    path = str(COMPONENT_AGENT_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)

    import config as component_config
    from bom import BOMGenerator
    from parser import ArchitectureParser
    from ranking import ComponentRanker
    from retrieval import ComponentRetriever

    return {
        "config": component_config,
        "parser": ArchitectureParser(),
        "retriever": ComponentRetriever(),
        "ranker": ComponentRanker(),
        "bom_generator": BOMGenerator(),
    }


@lru_cache(maxsize=1)
def _eda_generator():
    path = str(COMPONENT_AGENT_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)
    from eda import DynamicPCBIRGenerator

    return DynamicPCBIRGenerator()


@lru_cache(maxsize=1)
def _eda_dataset():
    mods = _component_agent_modules()
    return mods["config"].DATASET_DF


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _append_message(content: str) -> dict[str, Any]:
    return {"messages": [AIMessage(content=content)]}


def _error(message: str) -> dict[str, Any]:
    logger.error(message)
    return {"errors": [message], "workflow_status": "failed"}


def _requirements_from_state(state: CircuitState) -> dict[str, Any] | None:
    requirements = state.get("requirements")
    if isinstance(requirements, dict) and requirements:
        return requirements
    return None


def _architecture_from_state(state: CircuitState) -> dict[str, Any] | None:
    architecture = state.get("architecture")
    if isinstance(architecture, dict) and architecture:
        return architecture
    return None


def _bom_rows_from_state(state: CircuitState) -> list[dict[str, Any]]:
    bom = state.get("bom") or {}
    rows = bom.get("rows") or []
    return [row for row in rows if isinstance(row, dict)]


def _project_name(state: CircuitState) -> str:
    requirements = _requirements_from_state(state) or {}
    name = requirements.get("project_name")
    if isinstance(name, str) and name.strip():
        return name.strip()
    if state.get("design_name"):
        return str(state["design_name"])
    return "dunkai_design"


# ---------------------------------------------------------------------------
# Supervisor
# ---------------------------------------------------------------------------

def supervisor_node(state: CircuitState) -> dict[str, Any]:
    """Entry node: records workflow start and passes control downstream."""
    project = _project_name(state)
    return {
        "current_node": "supervisor",
        "design_name": state.get("design_name") or project,
        "workflow_status": "running",
        **_append_message(f"Supervisor started workflow for '{project}'."),
    }


# ---------------------------------------------------------------------------
# Requirements Agent (existing requirement_agent.py)
# ---------------------------------------------------------------------------

def requirements_node(state: CircuitState) -> dict[str, Any]:
    """Parse user requirements via the existing Requirement Agent."""
    existing = _requirements_from_state(state)
    if existing:
        return {
            "current_node": "requirements",
            "interview_status": "complete",
            **_append_message("Requirements already present — skipping interview."),
        }

    user_input = (state.get("user_input") or "").strip()
    if not user_input:
        return _error("Requirements node needs user_input or pre-filled requirements.")

    from requirement_agent import run_interview

    try:
        result = run_interview(user_input, state.get("interview_history"))
    except Exception as exc:
        return _error(f"Requirement Agent failed: {exc}")

    if result.status == "question":
        question = result.question or "Please provide one more project detail."
        return {
            "current_node": "requirements",
            "interview_status": "question",
            "interview_question": question,
            "interview_options": result.options,
            "workflow_status": "awaiting_input",
            **_append_message(question),
        }

    if result.requirements is None:
        return _error("Requirement Agent returned complete status without requirements.")

    requirements = result.requirements.model_dump(mode="json", exclude_none=True)
    return {
        "current_node": "requirements",
        "requirements": requirements,
        "interview_status": "complete",
        "interview_question": None,
        "interview_options": None,
        **_append_message(
            f"Requirements captured for project '{requirements.get('project_name', 'unnamed')}'."
        ),
    }


# ---------------------------------------------------------------------------
# Architecture Agent (existing architecture_agent.py)
# ---------------------------------------------------------------------------

def architecture_node(state: CircuitState) -> dict[str, Any]:
    """Generate subsystem graph via the existing Architecture Agent."""
    requirements = _requirements_from_state(state)
    if not requirements:
        return _error("Architecture node requires structured requirements.")

    from architecture_agent import build_architecture

    try:
        architecture = build_architecture(requirements)
    except Exception as exc:
        return _error(f"Architecture Agent failed: {exc}")

    node_count = len(architecture.get("architecture_graph", {}).get("nodes", []))
    return {
        "current_node": "architecture",
        "architecture": architecture,
        **_append_message(f"Architecture graph generated with {node_count} subsystem node(s)."),
    }


# ---------------------------------------------------------------------------
# Component Agent (existing component_agent pipeline)
# ---------------------------------------------------------------------------

def component_node(state: CircuitState) -> dict[str, Any]:
    """Retrieve components and produce BOM via the existing Component Agent."""
    architecture = _architecture_from_state(state)
    if not architecture:
        return _error("Component node requires architecture output.")

    try:
        mods = _component_agent_modules()
        parser = mods["parser"]
        retriever = mods["retriever"]
        ranker = mods["ranker"]
        bom_generator = mods["bom_generator"]
        build_quantity = max(1, int(state.get("build_quantity") or mods["config"].DEFAULT_QTY))

        requests = parser.parse(architecture)
        if not requests:
            return _error("Component Agent parsed zero subsystem requests from architecture.")

        for request in requests:
            request["build_quantity"] = build_quantity

        retrieval_results = retriever.retrieve_all(requests)
        ranked_results = ranker.rank_all(retrieval_results)
        rows = bom_generator.generate(ranked_results)
        summary = bom_generator.summary(rows)

        tmp_dir = Path(tempfile.gettempdir())
        csv_path = tmp_dir / "circuitmind_bom.csv"
        bom_generator.to_csv(rows, str(csv_path))

        bom = {
            "rows": rows,
            "summary": summary,
            "ranked_results": ranked_results,
            "build_quantity": build_quantity,
        }
    except Exception as exc:
        return _error(f"Component Agent failed: {exc}")

    return {
        "current_node": "component",
        "bom": bom,
        "bom_csv_path": str(csv_path),
        **_append_message(
            f"BOM generated with {summary.get('total_line_items', len(rows))} line item(s)."
        ),
    }


# ---------------------------------------------------------------------------
# EDA Enrichment (join BOM + dataset on mfr_part)
# ---------------------------------------------------------------------------

def _parse_json_field(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return value
    return value


def _lookup_eda_record(dataset, mfr_part: str) -> dict[str, Any] | None:
    if not mfr_part:
        return None
    part = str(mfr_part).strip()
    if not part:
        return None

    if "mfr_part" not in dataset.columns:
        return None

    matches = dataset[dataset["mfr_part"].astype(str).str.strip().str.lower() == part.lower()]
    if matches.empty:
        return None
    return matches.iloc[0].to_dict()


def eda_enrichment_node(state: CircuitState) -> dict[str, Any]:
    """Join BOM rows with the EDA dataset using ``mfr_part``."""
    rows = _bom_rows_from_state(state)
    if not rows:
        return _error("EDA enrichment requires BOM rows.")

    try:
        dataset = _eda_dataset()
    except Exception as exc:
        return _error(f"EDA dataset unavailable: {exc}")

    enriched_items: list[dict[str, Any]] = []
    missing_parts: list[str] = []

    for row in rows:
        mfr_part = row.get("mfr_part")
        record = _lookup_eda_record(dataset, str(mfr_part or ""))

        item = {
            "reference": row.get("reference"),
            "subsystem": row.get("subsystem"),
            "category": row.get("category"),
            "manufacturer": row.get("manufacturer"),
            "mfr_part": mfr_part,
            "package": row.get("package"),
            "status": row.get("status"),
        }

        if record is None:
            missing_parts.append(str(row.get("reference") or mfr_part or "?"))
            item.update({"symbol": None, "footprint": row.get("package"), "pins_json": None})
            enriched_items.append(item)
            continue

        extra = _parse_json_field(record.get("extra_params")) or {}
        attributes = extra.get("attributes") if isinstance(extra, dict) else {}

        symbol = record.get("symbol")
        if symbol is None and isinstance(attributes, dict):
            symbol = attributes.get("symbol")

        footprint = record.get("footprint") or record.get("package") or row.get("package")
        if footprint is None and isinstance(attributes, dict):
            footprint = attributes.get("footprint") or attributes.get("package")

        pins_json = (
            record.get("pins_json")
            or record.get("pinout")
            or (extra.get("pins_json") if isinstance(extra, dict) else None)
            or (attributes.get("pins_json") if isinstance(attributes, dict) else None)
        )
        pins_json = _parse_json_field(pins_json)

        item.update(
            {
                "symbol": symbol,
                "footprint": footprint,
                "pins_json": pins_json,
                "description": record.get("description") or row.get("description"),
                "datasheet_url": record.get("datasheet_url") or row.get("datasheet_url"),
            }
        )
        enriched_items.append(item)

    eda_data = {
        "items": enriched_items,
        "missing_dataset_matches": missing_parts,
        "enriched_count": sum(1 for item in enriched_items if item.get("symbol") or item.get("pins_json")),
    }

    return {
        "current_node": "eda_enrichment",
        "eda_data": eda_data,
        **_append_message(
            f"EDA enrichment joined {len(enriched_items)} BOM row(s); "
            f"{len(missing_parts)} without dataset match."
        ),
    }


# ---------------------------------------------------------------------------
# PCB Agent (rule-based PCB IR using existing eda.py generator)
# ---------------------------------------------------------------------------

# ── Schema v2: interface + role, never an asserted pin name ─────────────────
#
# `_interface_pin_name` and the old `_build_nets_from_architecture` were REMOVED
# here, not disabled. They derived every pin name from a fixed interface->name
# table (I2C always -> SCL/SDA) without ever consulting the selected component,
# which fabricated pin names for every design this system has ever produced. The
# backing dataset carries no pinout data at all (0 of 490,894 rows), so there was
# nothing for them to have consulted. See pcb-agent DECISIONS.md D-076.
#
# Under schema 2.0 dunkai does not claim physical pin facts. It emits the
# INTENT -- which interface, and what role each component plays on it -- and the
# downstream PCB module resolves that to real pads against the real part.
#
# A net is ONE WIRE. Every member states its role on that wire. This is what
# structurally removes the four long-standing upstream bugs: a net can no longer
# tie a clock to a data pin (incompatible roles are rejected), an I2C bus is one
# net per signal carrying every participant (so it cannot split into half-nets),
# and rails are declared once instead of per-edge (so no redundant POWER_N).

SCHEMA_VERSION_V2 = "2.0"

# Roles legal for each interface. Anything not listed is rejected upstream by
# the handoff validator rather than being silently mapped to something.
INTERFACE_ROLES: dict[str, tuple[str, ...]] = {
    "I2C": ("CLOCK", "DATA"),
    "SPI": ("CLOCK", "MOSI", "MISO", "CHIP_SELECT"),
    "UART": ("TX", "RX"),
    "USB": ("DP", "DM", "VBUS"),
    "CAN": ("CAN_H", "CAN_L"),
    "Ethernet": ("TXP", "TXN", "RXP", "RXN"),
    "SDIO": ("CLOCK", "CMD", "DATA"),
    "PCIe": ("TXP", "TXN", "RXP", "RXN", "CLOCK"),
    "I2S": ("BIT_CLOCK", "WORD_CLOCK", "DATA"),
    "Power": ("SUPPLY", "GROUND"),
    "GPIO": ("GPIO",),
    "PWM": ("PWM",),
    "ADC": ("ANALOG_IN",),
    "Analog": ("ANALOG_IN",),
    "Audio": ("AUDIO",),
    # Wireless links are not board nets -- see _WIRELESS below.
    "BLE": (),
    "WiFi": (),
    "RF": (),
}

# Interfaces that describe a link through the air, not copper between two parts.
# v1 mapped these to an "ANT" pin on BOTH endpoints, inventing a connection that
# does not physically exist. They are recorded as logical links instead.
_WIRELESS = frozenset({"BLE", "WiFi", "RF"})

# Buses where every participant shares the same wire per signal. Edges sharing a
# component are merged into ONE bus, which is what prevents split half-nets.
_SHARED_BUS = {
    "I2C": ("CLOCK", "DATA"),
    "SPI": ("CLOCK", "MOSI", "MISO"),
    "I2S": ("BIT_CLOCK", "WORD_CLOCK", "DATA"),
}

# Point-to-point links where the two ends take COMPLEMENTARY roles.
_COMPLEMENTARY = {
    "UART": (("TX", "RX"), ("RX", "TX")),
    "CAN": (("CAN_H", "CAN_H"), ("CAN_L", "CAN_L")),
    "USB": (("DP", "DP"), ("DM", "DM")),
}


def _merge_buses(edges: list[tuple[str, str]]) -> list[set[str]]:
    """Group edges sharing a component into connected components (one bus each)."""
    buses: list[set[str]] = []
    for a, b in edges:
        touching = [g for g in buses if a in g or b in g]
        merged = {a, b}
        for g in touching:
            merged |= g
            buses.remove(g)
        buses.append(merged)
    return buses


def _build_nets_from_architecture(
    architecture: dict[str, Any],
    references: list[str],
    categories: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build schema-2.0 nets from the architecture graph.

    Returns ``(nets, wireless_links)``. Every net is a single wire carrying one
    signal; every member declares its role on that wire. No pin name is ever
    produced here -- that is the PCB module's job, against the real part.
    """
    graph = architecture.get("architecture_graph") or {}
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    categories = categories or {}

    ref_by_node_id: dict[str, str] = {}
    category_by_ref: dict[str, str] = {}
    for index, node in enumerate(nodes):
        node_id = node.get("id")
        if not node_id:
            continue
        ref = references[index] if index < len(references) else f"U{index + 1}"
        ref_by_node_id[node_id] = ref
        category_by_ref[ref] = (node.get("data") or {}).get("category") or ""

    def member(ref: str, role: str) -> dict[str, str]:
        return {"ref_id": ref, "role": role}

    by_interface: dict[str, list[tuple[str, str]]] = {}
    wireless: list[dict[str, Any]] = []
    for edge in edges:
        interface = (edge.get("data") or {}).get("interface") or "GPIO"
        source = ref_by_node_id.get(edge.get("source"))
        target = ref_by_node_id.get(edge.get("target"))
        if not source or not target:
            continue
        if interface in _WIRELESS:
            wireless.append(
                {"interface": interface, "endpoints": [source, target],
                 "note": "wireless link, not a board net"}
            )
            continue
        by_interface.setdefault(interface, []).append((source, target))

    nets: list[dict[str, Any]] = []
    counter = 0

    def add(name: str, interface: str, net_class: str, members: list[dict[str, str]]) -> None:
        nonlocal counter
        counter += 1
        nets.append({
            "name": name,
            "interface": interface,
            "net_class": net_class,
            "members": members,
        })

    # --- Power: rails, declared once, membership taken from real Power edges ---
    power_edges = by_interface.pop("Power", [])
    supplied = sorted({r for pair in power_edges for r in pair})
    if supplied:
        add("POWER_RAIL", "Power", "power", [member(r, "SUPPLY") for r in supplied])
    if references:
        # Ground is genuinely common to every part on a shared-ground board. It is
        # stated explicitly here rather than assumed silently; a part that has no
        # ground pad is caught downstream as a capability mismatch against its
        # real pin set, not papered over here.
        add("GND", "Power", "ground", [member(r, "GROUND") for r in references])

    # --- Shared buses: one net per signal, ALL participants on each ------------
    for interface, signals in _SHARED_BUS.items():
        pairs = by_interface.pop(interface, [])
        if not pairs:
            continue
        for bus_index, bus in enumerate(_merge_buses(pairs), start=1):
            ordered = sorted(bus)
            for role in signals:
                if role == "MISO" and interface == "SPI" and len(ordered) < 2:
                    continue
                add(f"{interface.upper()}_{bus_index}_{role}", interface, "signal",
                    [member(r, role) for r in ordered])
            if interface == "SPI":
                # CS is per-peripheral: the controller is the shared node.
                degree = {r: sum(1 for p in pairs if r in p) for r in ordered}
                controller = max(
                    ordered,
                    key=lambda r: (degree[r], category_by_ref.get(r, "") == "Processing"),
                )
                for peripheral in [r for r in ordered if r != controller]:
                    add(f"{interface.upper()}_{bus_index}_CS_{peripheral}", interface, "signal",
                        [member(controller, "CHIP_SELECT"), member(peripheral, "CHIP_SELECT")])

    # --- Point-to-point links with complementary roles ------------------------
    for interface, role_pairs in _COMPLEMENTARY.items():
        for source, target in by_interface.pop(interface, []):
            for source_role, target_role in role_pairs:
                add(f"{interface.upper()}_{counter + 1}_{source_role}", interface, "signal",
                    [member(source, source_role), member(target, target_role)])

    # --- Everything else: one net per edge, same role both ends ---------------
    for interface, pairs in sorted(by_interface.items()):
        roles = INTERFACE_ROLES.get(interface) or ("GPIO",)
        role = roles[0]
        for source, target in pairs:
            add(f"{interface.upper()}_{counter + 1}_{role}", interface, "signal",
                [member(source, role), member(target, role)])

    return nets, wireless


def pcb_node(state: CircuitState) -> dict[str, Any]:
    """Generate PCB IR from BOM + architecture connectivity."""
    rows = _bom_rows_from_state(state)
    csv_path = state.get("bom_csv_path")
    architecture = _architecture_from_state(state) or {}

    if not rows:
        return _error("PCB node requires BOM rows.")
    if not csv_path:
        return _error("PCB node requires bom_csv_path from the Component Agent.")

    references = [str(row.get("reference")) for row in rows if row.get("reference")]
    nets, wireless_links = _build_nets_from_architecture(architecture, references)

    try:
        generator = _eda_generator()
        pcb_ir = generator.build_pcb_ir(
            design_name=_project_name(state),
            bom_csv_path=csv_path,
            net_connections=nets,
            schema_version=SCHEMA_VERSION_V2,
        )
    except Exception as exc:
        return _error(f"PCB Agent failed: {exc}")

    if wireless_links:
        # Recorded rather than emitted as copper: v1 gave both endpoints an "ANT"
        # pin, inventing a trace for a link that travels through the air.
        pcb_ir["wireless_links"] = wireless_links

    return {
        "current_node": "pcb",
        "pcb_ir": pcb_ir,
        **_append_message(
            f"PCB IR generated with {len(pcb_ir.get('components', []))} component(s) "
            f"and {len(pcb_ir.get('nets', []))} net(s)."
        ),
    }


# ---------------------------------------------------------------------------
# Validation Agent (rule-based checks)
# ---------------------------------------------------------------------------

# Role pairs that may legitimately share one wire despite differing. Everything
# else on a net must carry the SAME role; a clock never shares with a data line.
_COMPATIBLE_ROLE_PAIRS = frozenset({
    frozenset({"TX", "RX"}),
})


def _validate_handoff(state: CircuitState, pcb_ir: dict[str, Any]) -> dict[str, Any]:
    """Schema 2.0 validation: is this a well-formed HANDOFF?

    This deliberately does NOT answer "can this be built?". Under schema 2.0
    dunkai asserts no physical facts -- no symbols, no footprints, no pin
    mappings -- so it has no basis for a buildability claim and does not make
    one. Symbol/footprint/pin resolution and the verdict that depends on them
    belong to the downstream PCB module, which owns `compilable` and is the sole
    authority on it.

    MISSING_SYMBOL and MISSING_PINS are therefore NOT checked here. They remain
    live for schema 1.0 input, where dunkai did claim those facts.

    What is checked: every net names a known interface, every member declares a
    role legal for it, the roles on a net can physically share a wire, every
    referenced component exists, the BOM is filled, and every component carries
    the package string the PCB module needs to resolve a footprint.
    """
    bom_summary = (state.get("bom") or {}).get("summary") or {}
    components = pcb_ir.get("components") or []
    nets = pcb_ir.get("nets") or []
    declared_refs = {c.get("ref_id") for c in components}

    issues: list[dict[str, str]] = []

    # `package` IS dunkai's to assert -- it is catalogue metadata from its own
    # BOM, not a resolved physical artefact -- and the PCB module needs it as the
    # input to footprint resolution. This replaces v1's MISSING_FOOTPRINT, which
    # checked a field that silently fell back to `package` anyway.
    for component in components:
        ref = str(component.get("ref_id") or "?")
        package = component.get("package")
        if not package or str(package).strip() in {"", "-", "nan", "None"}:
            issues.append({
                "severity": "error",
                "code": "MISSING_PACKAGE",
                "message": f"{ref}: no package string; the PCB module cannot resolve a footprint.",
            })

    for ref in bom_summary.get("unfilled_references") or []:
        issues.append({
            "severity": "error",
            "code": "UNFILLED_BOM",
            "message": f"{ref}: no component selected in BOM.",
        })

    for net in nets:
        name = net.get("name")
        interface = net.get("interface")
        members = net.get("members") or []

        if interface not in INTERFACE_ROLES:
            issues.append({
                "severity": "error",
                "code": "UNKNOWN_INTERFACE",
                "message": f"Net '{name}': unknown interface '{interface}'.",
            })
            continue

        legal_roles = INTERFACE_ROLES[interface]
        if not members:
            issues.append({
                "severity": "error",
                "code": "EMPTY_NET",
                "message": f"Net '{name}': no members.",
            })
            continue

        for member in members:
            ref_id = member.get("ref_id")
            role = member.get("role")
            if ref_id not in declared_refs:
                issues.append({
                    "severity": "error",
                    "code": "ORPHAN_NET_MEMBER",
                    "message": f"Net '{name}' references unknown ref '{ref_id}'.",
                })
            if role not in legal_roles:
                issues.append({
                    "severity": "error",
                    "code": "INVALID_ROLE",
                    "message": (
                        f"Net '{name}': role '{role}' is not valid for interface "
                        f"'{interface}' (expected one of {', '.join(legal_roles) or 'none'})."
                    ),
                })

        roles = {m.get("role") for m in members}
        if len(roles) > 1 and frozenset(roles) not in _COMPATIBLE_ROLE_PAIRS:
            issues.append({
                "severity": "error",
                "code": "INCOMPATIBLE_ROLES",
                "message": (
                    f"Net '{name}' mixes roles {sorted(r for r in roles if r)} on one wire. "
                    "A single net carries one signal; only complementary pairs may differ."
                ),
            })

    well_formed = not any(issue["severity"] == "error" for issue in issues)
    return {
        "well_formed": well_formed,
        "schema_version": pcb_ir.get("schema_version"),
        "issue_count": len(issues),
        "issues": issues,
        "scope": (
            "Well-formedness of the handoff document only. This is NOT a "
            "buildability claim: symbol, footprint and pin resolution are the "
            "downstream PCB module's responsibility, and `compilable` is its "
            "field to set."
        ),
        "checks_run": [
            "interface_known",
            "role_valid_for_interface",
            "role_compatibility_on_net",
            "component_references_resolve",
            "bom_completeness",
            "package_present",
        ],
    }


def validation_node(state: CircuitState) -> dict[str, Any]:
    """Validate the design, branching on the upstream schema version.

    Schema 2.0 -> `handoff_validation.well_formed` (is this a valid handoff?)
    Schema 1.0 -> `validation.passed`            (legacy buildability-ish claim)
    """
    pcb_ir = state.get("pcb_ir") or {}
    if str(pcb_ir.get("schema_version") or "").startswith("2."):
        handoff = _validate_handoff(state, pcb_ir)
        ok = handoff["well_formed"]
        status = "well-formed" if ok else "malformed"
        return {
            "current_node": "validation",
            "handoff_validation": handoff,
            "workflow_status": "completed" if ok else "completed_with_warnings",
            **_append_message(
                f"Handoff {status} with {handoff['issue_count']} issue(s). "
                "Buildability is determined downstream by the PCB module."
            ),
        }

    return _validate_v1(state, pcb_ir)


def _validate_v1(state: CircuitState, pcb_ir: dict[str, Any]) -> dict[str, Any]:
    """Schema 1.0 validation -- unchanged legacy behaviour.

    Kept intact for v1-shaped input, where dunkai DID assert symbol/footprint/
    pin facts and so is answerable for them. New designs use schema 2.0 and the
    handoff validator above.
    """
    eda_items = (state.get("eda_data") or {}).get("items") or []
    bom_summary = (state.get("bom") or {}).get("summary") or {}

    issues: list[dict[str, str]] = []

    # MISSING_SYMBOL / MISSING_FOOTPRINT / MISSING_PINS are ERRORS, not warnings.
    #
    # `passed` below is computed as "no issue has severity == error", so while
    # these three were warnings a design could report validation.passed = True
    # with no symbol, no footprint and no pinout for a SINGLE component -- let
    # alone all of them. That is not a hypothetical: the first real end-to-end
    # capture (2026-08-20, 11 components) reported passed = True carrying 11x
    # MISSING_SYMBOL and 11x MISSING_PINS, i.e. every component in the design.
    # The downstream PCB module independently rated the same design
    # compilable = false with 22 errors.
    #
    # These three share one shape: each fires on essentially every component on
    # every run, because the backing dataset has no pinout data at all (0 of
    # 490,894 rows carry pins_json/pinout/symbol). Flipping only one of them
    # would leave passed = True reachable through the other two, so all three
    # move together.
    #
    # A design missing symbols, footprints or pin mappings cannot be
    # manufactured. Reporting it as passed is self-certification, not
    # validation.
    for item in eda_items:
        ref = str(item.get("reference") or "?")
        if not item.get("symbol"):
            issues.append(
                {
                    "severity": "error",
                    "code": "MISSING_SYMBOL",
                    "message": f"{ref}: no KiCad/EasyEDA symbol found in EDA dataset.",
                }
            )
        if not item.get("footprint"):
            issues.append(
                {
                    "severity": "error",
                    "code": "MISSING_FOOTPRINT",
                    "message": f"{ref}: no PCB footprint resolved.",
                }
            )
        if not item.get("pins_json"):
            issues.append(
                {
                    "severity": "error",
                    "code": "MISSING_PINS",
                    "message": f"{ref}: pinout (pins_json) unavailable.",
                }
            )

    for ref in bom_summary.get("unfilled_references") or []:
        issues.append(
            {
                "severity": "error",
                "code": "UNFILLED_BOM",
                "message": f"{ref}: no component selected in BOM.",
            }
        )

    components = pcb_ir.get("components") or []
    nets = pcb_ir.get("nets") or []
    declared_refs = {c.get("ref_id") for c in components}

    for net in nets:
        for conn in net.get("connections") or []:
            ref_id = str(conn).split(".")[0]
            if ref_id and ref_id not in declared_refs:
                issues.append(
                    {
                        "severity": "error",
                        "code": "ORPHAN_NET_CONNECTION",
                        "message": f"Net '{net.get('name')}' references unknown ref '{ref_id}'.",
                    }
                )

    passed = not any(issue["severity"] == "error" for issue in issues)
    validation = {
        "passed": passed,
        "schema_version": pcb_ir.get("schema_version") or "1.0",
        "issue_count": len(issues),
        "issues": issues,
        "checks_run": [
            "symbol_availability",
            "footprint_availability",
            "pinout_availability",
            "bom_completeness",
            "net_connectivity",
        ],
    }

    status = "passed" if passed else "failed"
    return {
        "current_node": "validation",
        "validation": validation,
        "workflow_status": "completed" if passed else "completed_with_warnings",
        **_append_message(f"Validation {status} with {len(issues)} issue(s)."),
    }


# ---------------------------------------------------------------------------
# Documentation Agent (rule-based reports from pipeline state)
# ---------------------------------------------------------------------------

def documentation_node(state: CircuitState) -> dict[str, Any]:
    """Generate BOM report, design summary, and engineering documentation."""
    requirements = _requirements_from_state(state) or {}
    architecture = _architecture_from_state(state) or {}
    bom = state.get("bom") or {}
    pcb_ir = state.get("pcb_ir") or {}
    # v2 reports handoff well-formedness; v1 reports its legacy `passed`. Only
    # one of the two keys is ever populated, by validation_node's branch.
    handoff = state.get("handoff_validation") or {}
    validation = handoff or state.get("validation") or {}
    is_handoff = bool(handoff)

    summary = bom.get("summary") or {}
    rows = bom.get("rows") or []
    arch_model = architecture.get("architecture_model") or {}
    graph = architecture.get("architecture_graph") or {}

    bom_lines = ["| Reference | Part | Package | Status |", "|---|---|---|---|"]
    for row in rows:
        bom_lines.append(
            f"| {row.get('reference', '?')} | {row.get('manufacturer', '?')} "
            f"{row.get('mfr_part', '?')} | {row.get('package', '?')} | {row.get('status', '?')} |"
        )

    design_summary = "\n".join(
        [
            f"# Design Summary: {_project_name(state)}",
            "",
            f"**Objective:** {requirements.get('objective') or 'Not specified'}",
            f"**Category:** {requirements.get('category') or 'Not specified'}",
            f"**Processing unit:** {arch_model.get('processing_unit') or 'TBD'}",
            f"**Interfaces:** {', '.join(arch_model.get('interfaces') or []) or 'none'}",
            f"**Subsystems:** {len(graph.get('nodes') or [])}",
            f"**BOM line items:** {summary.get('total_line_items', len(rows))}",
            f"**Estimated cost (USD):** ${float(summary.get('total_cost_usd') or 0):.2f}",
            (
                # Deliberately different wording per schema: a well-formed handoff
                # is NOT a claim that the board can be built, and the summary must
                # not let a reader mistake one for the other.
                f"**Handoff:** {'well-formed' if validation.get('well_formed') else 'needs review'}"
                " (buildability is determined downstream by the PCB module)"
                if is_handoff
                else f"**Validation:** {'passed' if validation.get('passed') else 'needs review'}"
            ),
        ]
    )

    engineering_docs = "\n".join(
        [
            f"# Engineering Documentation: {_project_name(state)}",
            "",
            "## Architecture assumptions",
            "\n".join(f"- {item}" for item in architecture.get("assumptions") or []) or "- none",
            "",
            "## Architecture warnings",
            "\n".join(f"- {item}" for item in architecture.get("warnings") or []) or "- none",
            "",
            "## PCB IR",
            f"- Components: {len(pcb_ir.get('components') or [])}",
            f"- Nets: {len(pcb_ir.get('nets') or [])}",
            f"- Layers: {(pcb_ir.get('constraints') or {}).get('layer_count', 'TBD')}",
            "",
            "## Validation issues",
            "\n".join(
                f"- [{issue.get('severity')}] {issue.get('message')}"
                for issue in validation.get("issues") or []
            )
            or "- none",
        ]
    )

    documentation = {
        "bom_report": "\n".join(bom_lines),
        "design_summary": design_summary,
        "engineering_docs": engineering_docs,
    }

    return {
        "current_node": "documentation",
        "documentation": documentation,
        "workflow_status": state.get("workflow_status") or "completed",
        **_append_message("Documentation package generated."),
    }
