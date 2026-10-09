"""System devices are BOM parts even when their bodies are not on the PCB.

Documented student-project defaults, not embedding matches to unrelated ICs.
The external probe and its conditioner are bought together. Their board-side
headers are separate BOM lines, with an explicitly defined custom harness.
Battery and panel connect to a real external charger; only its regulated output
enters the PCB. Raw solar, battery and logic rails must never be merged.
"""
from __future__ import annotations

import copy
import json
import re


PROFILES = {
    "tds": {
        "label": "TDS Sensor", "category": "Sensor", "manufacturer": "DFRobot",
        "mfr_part": "SEN0244", "description": "Analog TDS probe kit including signal conditioner",
        "source_url": "https://wiki.dfrobot.com/sen0244",
        "supply_v": [3.3, 5.5], "signal_v": [0, 2.3], "interface": "Analog",
        "includes": ["TDS probe", "signal conditioner", "sensor cable"],
        "assembly": "Use the conditioner, not the bare probe: '-' to GND, '+' to VCC, 'A' to analog input. Calibrate against a TDS standard; provide temperature compensation.",
    },
    "ph": {
        "label": "pH Sensor", "category": "Sensor", "manufacturer": "DFRobot",
        "mfr_part": "SEN0161-V2", "description": "Analog pH probe kit including BNC signal conditioner",
        "source_url": "https://wiki.dfrobot.com/sen0161-v2",
        "supply_v": [3.3, 5.5], "signal_v": [0, 3.0], "interface": "Analog",
        "includes": ["pH probe", "BNC signal conditioner", "sensor cable"],
        "assembly": "Plug the probe into the conditioner BNC. '-' to GND, '+' to VCC, 'A' to analog input. Two-point calibration is required. This lab probe is for project demonstrations, not continuous industrial monitoring.",
    },
    "battery": {
        "label": "Battery", "category": "Power", "manufacturer": "Adafruit",
        "mfr_part": "353", "description": "Protected 1S lithium-ion battery pack, 3.7V 6600mAh (three cells in parallel)",
        "source_url": "https://www.adafruit.com/product/353",
        "nominal_v": 3.7, "full_charge_v": 4.2, "max_charge_a": 1.0,
        "includes": ["physical battery pack", "pack protection circuit"],
        "assembly": "Connect battery + and - to the solar manager BAT IN + and -. Check polarity from terminal markings; JST cable polarity can differ between brands. This is a 1S pack, not three cells in series.",
    },
    "solar": {
        "label": "Solar Panel", "category": "Power", "manufacturer": "DFRobot",
        "mfr_part": "FIT0601", "description": "Physical monocrystalline solar panel with regulated 5V USB output",
        "source_url": "https://www.dfrobot.com/product-1774.html",
        "regulated_output_v": 5.0, "max_output_a": 1.0,
        "includes": ["physical photovoltaic panel", "5V USB output regulator"],
        "assembly": "Connect the panel's REGULATED 5V USB output to the solar manager USB charging input. Do not connect the raw panel (7.2V open circuit) to the PCB or substitute it for the regulated USB output.",
    },
    "solar_manager": {
        "label": "Solar Battery Charger Module", "category": "Power", "manufacturer": "DFRobot",
        "mfr_part": "DFR0559", "description": "External solar/lithium battery charger and regulated 5V power module",
        "source_url": "https://wiki.dfrobot.com/dfr0559",
        "regulated_output_v": 5.0, "max_output_a": 1.0, "max_charge_a": 0.9,
        "includes": ["CC/CV lithium charger", "battery protection", "5V regulator"],
        "assembly": "Battery connects to BAT IN. FIT0601 regulated USB output connects to USB IN. Connect the enabled regulated 5V OUT and GND to the PCB power header. Follow the module start-up/enable instructions. The battery and panel remain required purchases.",
    },
    "logic_regulator": {
        "label": "3.3V Logic Regulator", "category": "Power", "manufacturer": "Texas Instruments",
        "mfr_part": "TLV75533PDBVR", "description": "5V-input to 3.3V-output logic LDO, SOT-23-5",
        "source_url": "https://www.ti.com/lit/ds/symlink/tlv755p.pdf",
        "package": "SOT-23-5", "board_profile": "tlv75533-dbv",
        "max_output_a": 0.5,
        "assembly": "IN and EN on regulated 5V, OUT on 3.3V, GND on ground, NC open. Fit input/output capacitors of at least 1uF at the regulator. Review dissipation and load current; motor/pump power must be budgeted separately.",
    },
}

PATTERNS = {
    "tds": r"\b(tds|total dissolved solids)\b",
    "ph": r"\b(ph|acidity)\b",
    "battery": r"\b(battery|batteries|lipo|li.polymer|li.ion)\b",
    "solar": r"\b(solar|photovoltaic)\b",
}
INTERFACE_ONLY = re.compile(r"\b(interface|connector|conditioning|controller|charger|charging|protection|management|adc|regulator|driver)\b", re.I)


def device_key(label):
    text = str(label or "")
    if INTERFACE_ONLY.search(text):
        return None
    return next((key for key, pattern in PATTERNS.items() if re.search(pattern, text, re.I)), None)


def required_keys(requirements):
    # Only explicit input/power requirements: an objective mentioning a battery
    # monitor must not itself turn into a requirement for a rechargeable pack.
    inputs = json.dumps(requirements.get("hardware_inputs") or [], ensure_ascii=False)
    power = json.dumps(requirements.get("power_requirements") or [], ensure_ascii=False)
    return [key for key, pattern in PATTERNS.items()
            if re.search(pattern, inputs if key in ("tds", "ph") else power, re.I)]


def prepare_architecture(architecture, requirements):
    """Preserve explicit devices even when inference returned only an interface.

    Repeated calls are idempotent. All existing nodes survive. Defaults are
    recorded as assumptions and can be replaced through external_device_choices.
    The external charging assembly is a system graph, not copper on this PCB.
    """
    result = copy.deepcopy(architecture)
    graph = result.setdefault("architecture_graph", {})
    nodes = graph.setdefault("nodes", [])
    edges = graph.setdefault("edges", [])
    required = required_keys(requirements)
    if not required:
        return result
    choices = requirements.get("external_device_choices") or {}
    if not isinstance(choices, dict): choices = {}
    # Default power kit is suitable for a small 3.3V student controller, not an
    # arbitrary specified 12V/lead-acid/series battery project.
    power_text = json.dumps(requirements.get("power_requirements") or "")
    custom_power = bool(re.search(r"\b(\d+(?:\.\d+)?\s*v(?:olt)?s?|\d+\s*s\b|lead.acid|lifepo4|nimh|mah|mppt)\b", power_text, re.I))
    default_power = "battery" in required and "solar" in required and not custom_power
    assumptions = result.setdefault("assumptions", [])
    existing_ids = {node["id"] for node in nodes}

    def ensure(key):
        found = next((n for n in nodes if (n.get("data") or {}).get("external_key") == key
                      or device_key((n.get("data") or {}).get("label")) == key), None)
        if found is None and key == "logic_regulator":
            found = next((n for n in nodes if (n.get("data") or {}).get("category") == "Power"
                          and re.fullmatch(r"power management(?: ic)?|pmic|voltage regulator|3\.3v(?: logic)? regulator", str((n.get("data") or {}).get("label", "")), re.I)), None)
        if found is None:
            identifier = f"required-{key}"
            while identifier in existing_ids: identifier += "-device"
            found = {"id": identifier, "type": "architecture", "data": {
                "label": PROFILES[key]["label"], "category": PROFILES[key]["category"],
            }}
            nodes.append(found)
            existing_ids.add(identifier)
        data = found["data"]
        data["external_key"] = key
        data["external"] = key != "logic_regulator"
        selected = choices.get(key)
        supported = selected is None or selected == PROFILES[key]["mfr_part"]
        if key in ("battery", "solar") and not default_power and selected is None:
            supported = False
        data["device_profile"] = key if supported else None
        data["requested_part"] = selected
        data["required"] = True
        note = f"Student-project default for {PROFILES[key]['label']}: {PROFILES[key]['manufacturer']} {PROFILES[key]['mfr_part']} ({PROFILES[key]['source_url']})."
        if supported and note not in assumptions: assumptions.append(note)
        return found

    devices = {key: ensure(key) for key in required}
    processor = next((n for n in nodes if (n.get("data") or {}).get("category") == "Processing"), None)

    def link(source, target, interface):
        if source is None or target is None: return
        if any(e.get("source") == source["id"] and e.get("target") == target["id"] and (e.get("data") or {}).get("interface") == interface for e in edges): return
        edges.append({"id": f"{source['id']}-{interface}-{target['id']}", "source": source["id"],
                      "target": target["id"], "type": "smoothstep", "label": interface, "data": {"interface": interface}})

    for key in ("tds", "ph"):
        sensor = devices.get(key)
        if sensor is None or not sensor["data"].get("device_profile"): continue
        # These selected kits have conditioned analog output, not I2C. Remove
        # incompatible signal edges, then retain/add a distinct analog input.
        edges[:] = [e for e in edges if sensor["id"] not in (e.get("source"), e.get("target"))
                    or (e.get("data") or {}).get("interface") == "Power"]
        link(sensor, processor, "Analog")

    if default_power:
        manager = ensure("solar_manager")
        regulator = ensure("logic_regulator")
        devices.update(solar_manager=manager, logic_regulator=regulator)
        external_power_ids = {devices[key]["id"] for key in ("battery", "solar", "solar_manager")}
        # Battery/panel go through the selected external charger. They cannot
        # be connected in parallel to a common controller supply.
        edges[:] = [e for e in edges if not external_power_ids.intersection((e.get("source"), e.get("target")))]
        link(devices["battery"], manager, "Power")
        link(devices["solar"], manager, "Power")
        link(manager, regulator, "Power")
        for key in ("tds", "ph"):
            if key in devices: link(regulator, devices[key], "Power")
        link(regulator, processor, "Power")
        note = "Assume 3.3V logic and a regulated 5V external power assembly. Verify every selected peripheral's voltage/current and pump power budget before fabrication."
        if note not in assumptions: assumptions.append(note)
    result["required_devices"] = [{"key": key, "node_id": devices[key]["id"], "label": PROFILES[key]["label"]} for key in required]
    # Keep the existing summary useful when preservation restored a missing node.
    model = result.get("architecture_model")
    if isinstance(model, dict):
        for key, node in devices.items():
            bucket = "sensing_modules" if key in ("tds", "ph") else "power_subsystem"
            labels = model.setdefault(bucket, [])
            if node["data"]["label"] not in labels: labels.append(node["data"]["label"])
    edges.sort(key=lambda e: (str(e.get("source")), str(e.get("target")), str((e.get("data") or {}).get("interface"))))
    return result


def profile_row(request, quantity=1):
    """An external-device BOM row is not an orderable JLCPCB chip candidate."""
    key = request["external_key"]
    profile = PROFILES.get(request.get("device_profile"))
    row = {
        "reference": request["reference"], "node_id": request["node_id"],
        "subsystem": request["subsystem"], "category": request["category"],
        "build_quantity": quantity, "unit_price_usd": None, "extended_price_usd": None,
        "stock": None, "moq": None, "lcsc": None, "score": None, "shared_with": "",
        "external": key != "logic_regulator", "required": True, "external_key": key,
    }
    if profile is None:
        row.update(mfr_part=request.get("requested_part"), package="External device", status="SELECTION_REQUIRED",
                   status_reason="Required device retained. The requested part/power specification needs a documented device profile and interface; it has not been replaced by a default.")
        return row
    row.update({name: copy.deepcopy(profile.get(name)) for name in ("manufacturer", "mfr_part", "description", "source_url", "board_profile")})
    row.update(package=profile.get("package", "External module / device"),
               status="DOCUMENTED_DEFAULT", status_reason="Documented student-project default. Price and availability need a supplier quote.",
               datasheet_url=profile["source_url"], device_profile=key,
               assembly=profile["assembly"], includes=profile.get("includes", []),
               electrical={name: copy.deepcopy(value) for name, value in profile.items() if name.endswith(("_v", "_a"))})
    return row


def connector_row(device, reference, profile):
    sensor = profile == "student-sensor-3p"
    return {
        "reference": reference, "subsystem": f"{device['subsystem']} PCB interface", "category": "Expansion",
        "mfr_part": "1x3 2.54mm through-hole header" if sensor else "1x2 2.54mm through-hole header",
        "package": "HDR-3-P2.54" if sensor else "HDR-2-P2.54", "board_profile": profile,
        "build_quantity": device.get("build_quantity", 1), "unit_price_usd": None, "extended_price_usd": None,
        "stock": None, "status": "DOCUMENTED_DEFAULT", "external": False,
        "status_reason": "Generic PCB header with a custom harness, not a direct Gravity/JST mating connector. Verify cable pin order.",
        "device_reference": device["reference"], "required": True,
    }


def add_interfaces(rows):
    rows = copy.deepcopy(rows)
    used = {r["reference"] for r in rows}
    counter = 1
    for device in list(rows):
        if device.get("device_profile") not in ("tds", "ph", "solar_manager"): continue
        while f"J{counter}" in used: counter += 1
        reference = f"J{counter}"
        used.add(reference)
        device["pcb_references"] = [reference]
        rows.append(connector_row(device, reference, "student-sensor-3p" if device["device_profile"] in ("tds", "ph") else "student-power-2p"))
    manager = next((r for r in rows if r.get("device_profile") == "solar_manager"), None)
    for device in rows:
        if device.get("device_profile") in ("battery", "solar") and manager:
            device["via_reference"] = manager["reference"]
            device["pcb_references"] = manager["pcb_references"]
    return rows


def coverage_issues(architecture, rows):
    """Each protected requirement must have a real device AND a board path."""
    issues = []
    for required in architecture.get("required_devices", []):
        row = next((r for r in rows if r.get("node_id") == required["node_id"] and r.get("external_key") == required["key"]), None)
        if row is None:
            issues.append(f"{required['label']}: required device missing from the system BOM")
        elif row.get("status") == "SELECTION_REQUIRED" or not row.get("device_profile"):
            issues.append(f"{required['label']}: device specifications/profile need selection; the device remains required")
        elif not row.get("pcb_references"):
            issues.append(f"{required['label']}: required PCB interface or power path missing")
        elif any(not any(r["reference"] == ref and not r.get("external") for r in rows) for ref in row["pcb_references"]):
            issues.append(f"{required['label']}: PCB connector is missing from the board BOM")
        elif row.get("via_reference") and not any(r["reference"] == row["via_reference"] and r.get("device_profile") == "solar_manager" for r in rows):
            issues.append(f"{required['label']}: charger in the required power path is missing")
    return issues


def board_graph(architecture, rows):
    """Graph for copper only; required external assemblies remain in the IR."""
    result = copy.deepcopy(architecture)
    graph = result["architecture_graph"]
    device_by_node = {r.get("node_id"): r for r in rows if r.get("external")}
    nodes = []
    excluded = set()
    for node in graph["nodes"]:
        device = device_by_node.get(node["id"])
        if device and device.get("device_profile") not in ("tds", "ph"):
            excluded.add(node["id"])
            continue
        nodes.append(node)
    graph["nodes"] = nodes
    graph["edges"] = [e for e in graph["edges"] if not excluded.intersection((e.get("source"), e.get("target")))]
    refs = {r.get("node_id"): r["reference"] for r in rows if r.get("node_id")}
    # Historical ordinary BOMs used graph order before node_id was persisted.
    for index, node in enumerate(architecture["architecture_graph"]["nodes"]):
        if node["id"] not in refs and index < len(rows) and not rows[index].get("external"):
            refs[node["id"]] = rows[index]["reference"]
    for node_id, row in device_by_node.items():
        if row.get("device_profile") in ("tds", "ph"):
            refs[node_id] = row["pcb_references"][0]
    return result, refs


def separate_power_nets(nets, rows):
    """Explicit LDO pins prevent all Power edges shorting IN and OUT together."""
    regulator = next((r for r in rows if r.get("device_profile") == "logic_regulator"), None)
    manager = next((r for r in rows if r.get("device_profile") == "solar_manager"), None)
    if not regulator or not manager: return nets
    input_ref = manager["pcb_references"][0]
    reg_ref = regulator["reference"]
    board_refs = {r["reference"] for r in rows if not r.get("external")}
    nets = copy.deepcopy(nets)
    ground = next((n for n in nets if n["net_class"] == "ground"), None)
    if ground:
        ground["members"] = [m for m in ground["members"] if m["ref_id"] in board_refs]
        if not any(m["ref_id"] == input_ref for m in ground["members"]):
            ground["members"].append({"ref_id": input_ref, "role": "GROUND"})
    for net in nets:
        if net["net_class"] != "power": continue
        net["name"] = "LOGIC_3V3"
        net["voltage_v"] = 3.3
        net["members"] = [m for m in net["members"] if m["ref_id"] != reg_ref]
        net["members"].append({"ref_id": reg_ref, "role": "SUPPLY", "pin_function": "OUT"})
    nets.append({"name": "REGULATED_5V_IN", "interface": "Power", "net_class": "power", "voltage_v": 5.0,
                 "members": [{"ref_id": input_ref, "role": "SUPPLY"},
                             {"ref_id": reg_ref, "role": "SUPPLY", "pin_function": "IN"},
                             {"ref_id": reg_ref, "role": "SUPPLY", "pin_function": "EN"}]})
    return nets
