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
            "interview_selection_mode": result.selection_mode,
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
        "interview_selection_mode": None,
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

def _interface_pin_name(interface: str, index: int = 0) -> str:
    mapping = {
        "I2C": ("SCL", "SDA"),
        "SPI": ("SCK", "MOSI", "MISO", "CS"),
        "UART": ("TX", "RX"),
        "USB": ("D+", "D-"),
        "Power": ("VDD", "VCC", "3V3"),
        "GPIO": (f"GPIO{index + 1}",),
        "BLE": ("ANT", "TX", "RX"),
        "WiFi": ("ANT", "TX", "RX"),
        "CAN": ("CANH", "CANL"),
        "Ethernet": ("TX+", "TX-", "RX+", "RX-"),
    }
    names = mapping.get(interface, (interface.upper(),))
    return names[min(index, len(names) - 1)]


def _build_nets_from_architecture(
    architecture: dict[str, Any],
    references: list[str],
) -> list[dict[str, Any]]:
    graph = architecture.get("architecture_graph") or {}
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []

    ref_by_node_id: dict[str, str] = {}
    for index, node in enumerate(nodes):
        node_id = node.get("id")
        if not node_id:
            continue
        ref_by_node_id[node_id] = references[index] if index < len(references) else f"U{index + 1}"

    nets: list[dict[str, Any]] = []
    if references:
        nets.append(
            {
                "name": "GND",
                "connections": [f"{ref}.GND" for ref in references],
                "net_class": "ground",
            }
        )
        nets.append(
            {
                "name": "POWER_RAIL_3V3",
                "connections": [f"{ref}.VDD" for ref in references],
                "net_class": "power",
            }
        )

    for edge_index, edge in enumerate(edges):
        interface = edge.get("data", {}).get("interface") or "signal"
        source = ref_by_node_id.get(edge.get("source"))
        target = ref_by_node_id.get(edge.get("target"))
        if not source or not target:
            continue

        pin_a = _interface_pin_name(interface, 0)
        pin_b = _interface_pin_name(interface, 1 if interface in {"I2C", "UART", "SPI"} else 0)
        net_name = f"{interface}_{edge_index + 1}".upper()
        nets.append(
            {
                "name": net_name,
                "connections": [f"{source}.{pin_a}", f"{target}.{pin_b}"],
                "net_class": "power" if interface == "Power" else "signal",
            }
        )

    return nets


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
    net_connections = _build_nets_from_architecture(architecture, references)

    try:
        generator = _eda_generator()
        pcb_ir = generator.build_pcb_ir(
            design_name=_project_name(state),
            bom_csv_path=csv_path,
            net_connections=net_connections,
        )
    except Exception as exc:
        return _error(f"PCB Agent failed: {exc}")

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
def validation_node(state: CircuitState) -> dict[str, Any]:
    """Validate BOM, EDA, PCB connectivity, and engineering readiness."""
    eda_items = (state.get("eda_data") or {}).get("items") or []
    pcb_ir = state.get("pcb_ir") or {}
    bom = state.get("bom") or {}
    bom_rows = bom.get("rows") or []
    bom_summary = bom.get("summary") or {}

    issues: list[dict[str, str]] = []

    # -------------------------------------------------------------------
    # 1) Per-component checks (runs multiple checks per BOM row)
    # -------------------------------------------------------------------
    for row in bom_rows:
        ref = str(row.get("reference") or "?")
        mfr_part = row.get("mfr_part")
        status = row.get("status", "OK")
        score = row.get("score")
        unit_price = row.get("unit_price_usd") or row.get("unit_cost") or row.get("price")
        package = row.get("package")
        stock = row.get("stock", 0)
        build_qty = row.get("build_quantity", 1)

        # CHECK: Component selected (BOM completeness)
        if mfr_part and status != "NO_MATCH":
            issues.append({
                "severity": "passed",
                "code": "COMPONENT_SELECTED",
                "category": "Electrical",
                "message": f"{ref}: Component {mfr_part} selected successfully.",
            })
        else:
            issues.append({
                "severity": "error",
                "code": "NO_COMPONENT",
                "category": "Electrical",
                "message": f"{ref}: No component selected — source manually.",
            })

        # CHECK: Package / Footprint resolved
        if package and package not in ("", "None", "CUSTOM"):
            issues.append({
                "severity": "passed",
                "code": "PACKAGE_RESOLVED",
                "category": "Manufacturing",
                "message": f"{ref}: Package {package} resolved for PCB layout.",
            })
        else:
            issues.append({
                "severity": "warning",
                "code": "MISSING_PACKAGE",
                "category": "Manufacturing",
                "message": f"{ref}: No package/footprint resolved — verify before PCB layout.",
            })

        # CHECK: Pricing available
        if unit_price is not None:
            try:
                price_val = float(str(unit_price).replace("$", "").replace(",", ""))
                if price_val > 0:
                    issues.append({
                        "severity": "passed",
                        "code": "PRICING_AVAILABLE",
                        "category": "Compliance",
                        "message": f"{ref}: Unit cost ${price_val:.2f} available for BOM costing.",
                    })
                else:
                    issues.append({
                        "severity": "warning",
                        "code": "ZERO_PRICE",
                        "category": "Compliance",
                        "message": f"{ref}: Unit cost is $0.00 — verify distributor pricing.",
                    })
            except (ValueError, TypeError):
                issues.append({
                    "severity": "warning",
                    "code": "INVALID_PRICE",
                    "category": "Compliance",
                    "message": f"{ref}: Price format unrecognised — verify manually.",
                })

        # CHECK: Stock availability
        try:
            stock_val = int(float(stock or 0))
            if stock_val >= int(build_qty or 1):
                issues.append({
                    "severity": "passed",
                    "code": "STOCK_SUFFICIENT",
                    "category": "Manufacturing",
                    "message": f"{ref}: {stock_val} units in stock (need {build_qty}).",
                })
            elif stock_val > 0:
                issues.append({
                    "severity": "warning",
                    "code": "LOW_STOCK",
                    "category": "Manufacturing",
                    "message": f"{ref}: Only {stock_val} in stock vs. {build_qty} needed.",
                })
        except (ValueError, TypeError):
            pass

        # CHECK: Match quality / confidence
        if score is not None:
            try:
                score_val = float(score)
                if score_val >= 0.7:
                    issues.append({
                        "severity": "passed",
                        "code": "HIGH_CONFIDENCE",
                        "category": "Electrical",
                        "message": f"{ref}: Component match confidence {score_val:.0%} — strong match.",
                    })
                elif score_val >= 0.4:
                    issues.append({
                        "severity": "warning",
                        "code": "MEDIUM_CONFIDENCE",
                        "category": "Electrical",
                        "message": f"{ref}: Component match confidence {score_val:.0%} — review datasheet.",
                    })
                else:
                    issues.append({
                        "severity": "warning",
                        "code": "LOW_CONFIDENCE",
                        "category": "Electrical",
                        "message": f"{ref}: Component match confidence {score_val:.0%} — manual verification required.",
                    })
            except (ValueError, TypeError):
                pass

        # CHECK: BOM status flags from component agent
        if status == "BELOW_MOQ":
            issues.append({
                "severity": "warning",
                "code": "BELOW_MOQ",
                "category": "Manufacturing",
                "message": f"{ref}: Build quantity below minimum order quantity.",
            })
        elif status == "INSUFFICIENT_STOCK":
            issues.append({
                "severity": "warning",
                "code": "INSUFFICIENT_STOCK",
                "category": "Manufacturing",
                "message": f"{ref}: Insufficient stock for requested build quantity.",
            })
        elif status == "LOW_CONFIDENCE":
            issues.append({
                "severity": "warning",
                "code": "LOW_CONFIDENCE_STATUS",
                "category": "Electrical",
                "message": f"{ref}: Component flagged as low-confidence match by retrieval engine.",
            })

    # -------------------------------------------------------------------
    # 2) EDA symbol/pinout info (downgraded to info, not warning)
    # -------------------------------------------------------------------
    for item in eda_items:
        ref = str(item.get("reference") or "?")
        if item.get("symbol"):
            issues.append({
                "severity": "passed",
                "code": "SYMBOL_AVAILABLE",
                "category": "Electrical",
                "message": f"{ref}: EDA schematic symbol available.",
            })
        else:
            issues.append({
                "severity": "info",
                "code": "MISSING_SYMBOL",
                "category": "Electrical",
                "message": f"{ref}: No KiCad/EasyEDA symbol in dataset — use generic or create manually.",
            })

        if item.get("pins_json"):
            issues.append({
                "severity": "passed",
                "code": "PINOUT_AVAILABLE",
                "category": "Compliance",
                "message": f"{ref}: Pinout data available for net validation.",
            })
        else:
            issues.append({
                "severity": "info",
                "code": "MISSING_PINS",
                "category": "Compliance",
                "message": f"{ref}: Pinout data unavailable — refer to component datasheet.",
            })

    # -------------------------------------------------------------------
    # 3) Unfilled BOM references
    # -------------------------------------------------------------------
    for ref in bom_summary.get("unfilled_references") or []:
        issues.append({
            "severity": "error",
            "code": "UNFILLED_BOM",
            "category": "Electrical",
            "message": f"{ref}: No component selected in BOM — source manually.",
        })

    # -------------------------------------------------------------------
    # 4) PCB net connectivity checks
    # -------------------------------------------------------------------
    components = pcb_ir.get("components") or []
    nets = pcb_ir.get("nets") or []
    declared_refs = {c.get("ref_id") for c in components}

    if components:
        issues.append({
            "severity": "passed",
            "code": "PCB_COMPONENTS",
            "category": "Manufacturing",
            "message": f"PCB IR contains {len(components)} component(s) placed on board.",
        })
    if nets:
        issues.append({
            "severity": "passed",
            "code": "PCB_NETS",
            "category": "Electrical",
            "message": f"PCB IR contains {len(nets)} net(s) for routing.",
        })

    orphan_found = False
    for net in nets:
        for conn in net.get("connections") or []:
            ref_id = str(conn).split(".")[0]
            if ref_id and ref_id not in declared_refs:
                orphan_found = True
                issues.append({
                    "severity": "error",
                    "code": "ORPHAN_NET_CONNECTION",
                    "category": "Electrical",
                    "message": f"Net '{net.get('name')}' references unknown ref '{ref_id}'.",
                })
    if not orphan_found and nets:
        issues.append({
            "severity": "passed",
            "code": "NET_CONNECTIVITY_OK",
            "category": "Electrical",
            "message": "All net connections reference valid component ref IDs.",
        })

    # -------------------------------------------------------------------
    # 5) Power rail check
    # -------------------------------------------------------------------
    power_nets = [n for n in nets if n.get("net_class") == "power"]
    ground_nets = [n for n in nets if n.get("net_class") == "ground"]
    if power_nets:
        issues.append({
            "severity": "passed",
            "code": "POWER_RAIL_DEFINED",
            "category": "Power",
            "message": f"{len(power_nets)} power rail net(s) defined.",
        })
    if ground_nets:
        issues.append({
            "severity": "passed",
            "code": "GROUND_NET_DEFINED",
            "category": "Power",
            "message": f"{len(ground_nets)} ground net(s) defined.",
        })
    if not power_nets and not ground_nets and nets:
        issues.append({
            "severity": "warning",
            "code": "NO_POWER_GROUND",
            "category": "Power",
            "message": "No explicit power or ground nets found — verify power distribution.",
        })

    # -------------------------------------------------------------------
    # Compute final summary
    # -------------------------------------------------------------------
    passed_count = sum(1 for i in issues if i["severity"] == "passed")
    warning_count = sum(1 for i in issues if i["severity"] == "warning")
    error_count = sum(1 for i in issues if i["severity"] == "error")
    info_count = sum(1 for i in issues if i["severity"] == "info")
    total = max(len(issues), 1)
    has_errors = error_count > 0

    validation = {
        "passed": not has_errors,
        "issue_count": len(issues),
        "issues": issues,
        "passed_count": passed_count,
        "warnings": warning_count,
        "failures": error_count,
        "info_count": info_count,
        "checks_run": [
            "component_selection",
            "package_resolution",
            "pricing_availability",
            "stock_availability",
            "match_confidence",
            "bom_status_flags",
            "eda_symbol_availability",
            "pinout_availability",
            "bom_completeness",
            "pcb_component_placement",
            "net_connectivity",
            "power_rail_validation",
        ],
        "timestamp": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }

    status = "passed" if not has_errors else "failed"
    return {
        "current_node": "validation",
        "validation": validation,
        "workflow_status": "completed" if not has_errors else "completed_with_warnings",
        **_append_message(
            f"Validation {status}: {passed_count} passed, {warning_count} warnings, "
            f"{error_count} errors, {info_count} info across {len(issues)} check(s)."
        ),
    }


# ---------------------------------------------------------------------------
# Documentation Agent (rule-based reports from pipeline state)
# ---------------------------------------------------------------------------

def documentation_node(state: CircuitState) -> dict[str, Any]:
    """Generate BOM report, design summary, and engineering documentation."""
    requirements = _requirements_from_state(state) or {}
    architecture = _architecture_from_state(state) or {}
    bom = state.get("bom") or {}
    validation = state.get("validation") or {}
    pcb_ir = state.get("pcb_ir") or {}

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
            f"**Validation:** {'passed' if validation.get('passed') else 'needs review'}",
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
