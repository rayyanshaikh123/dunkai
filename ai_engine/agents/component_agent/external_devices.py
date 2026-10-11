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
    "conductivity": {
        "label": "Conductivity Sensor", "category": "Sensor", "manufacturer": "DFRobot",
        "mfr_part": "SEN0451", "description": "Gravity industrial analog EC probe kit with signal conditioner and integrated PT1000 temperature probe",
        "source_url": "https://wiki.dfrobot.com/sen0451/",
        "supply_v": [3.3, 5.0], "signal_v": [0, 3.0], "interface": "Analog",
        "rail_v": 3.3, "pcb_connector": "student-sensor-3p",
        "includes": ["K=1 EC probe", "analog signal conversion board", "integrated PT1000 temperature probe", "PT1000 signal conversion board", "sensor cable"],
        "assembly": "Use the signal conditioner, not the bare probe. Custom PCB harness: pin 1 GND, pin 2 3.3V, pin 3 A (analog EC output, 0–3V). The conditioner accepts 3.3–5V, so this output is within a 3.3V ADC's range. Clean and calibrate the probe with a 1413µS/cm standard before measurements. The kit's PT1000 temperature lead needs its separate conversion board; use a water-rated temperature input for compensation, and do not substitute an ambient-only sensor.",
    },
    "battery": {
        "label": "Battery", "category": "Power", "manufacturer": "Adafruit",
        "mfr_part": "353", "description": "Protected 1S lithium-ion battery pack, 3.7V 6600mAh (three cells in parallel)",
        "source_url": "https://www.adafruit.com/product/353",
        "nominal_v": 3.7, "full_charge_v": 4.2, "max_charge_a": 1.0,
        "includes": ["physical battery pack", "pack protection circuit"],
        "assembly": "Connect the protected 1S pack to the selected charger's battery input. Check polarity from terminal markings; JST cable polarity can differ between brands. This is a 1S pack, not three cells in series.",
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
    "usb_manager": {
        "label": "USB-C Battery Charger and 5V Boost Module", "category": "Power", "manufacturer": "Adafruit",
        "mfr_part": "6106", "description": "bq25185 USB-C 1S lithium charger with power-path management and TPS61023 5V boost",
        "source_url": "https://learn.adafruit.com/adafruit-bq25185-usb-dc-solar-charger-with-5v-boost-board/pinouts",
        "regulated_output_v": 5.0, "max_output_a": 1.0, "max_charge_a": 1.0,
        "includes": ["physical USB-C socket", "1S CC/CV lithium charger", "power-path controller", "5V boost converter"],
        "assembly": "Connect the protected Adafruit 353 pack to BATT with verified JST polarity. Supply 5V at USB-C; this is power input, not MCU USB data. Default charging is 1A and termination is 4.2V. Wire the regulated output terminal '+' to PCB 5V and '-' to GND. Keep pump/LED loads off during startup (the boost can stall above 200mA at startup); delay enabling loads and keep the total under 1A. Charging has a six-hour safety timeout. The battery remains a separate required purchase.",
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

POWER_MANAGERS = ("solar_manager", "usb_manager")

import student_water
PROFILES.update(student_water.PROFILES)

PATTERNS = {
    "tds": r"\b(tds|total dissolved solids)\b",
    "ph": r"\b(ph|acidity)\b",
    "conductivity": r"\b(conductivity|electrical conductivity|ec sensor|ec probe|ec meter)\b",
    "battery": r"\b(battery|batteries|lipo|li.polymer|li.ion)\b",
    "solar": r"\b(solar|photovoltaic)\b",
}
INTERFACE_ONLY = re.compile(r"\b(interface|connector|conditioning|controller|charger|charging|protection|management|adc|regulator|driver)\b", re.I)


def device_text(value):
    # Match both "TDS Sensor" and model labels such as "TDSSensor" or
    # "pHSensor" without splitting the chemical name pH into separate words.
    return re.sub(r"(?<=[A-Za-z])(?=[A-Z][a-z])", " ", str(value or ""))


def device_key(label):
    text = device_text(label)
    if INTERFACE_ONLY.search(text):
        return None
    return next((key for key, pattern in PATTERNS.items() if re.search(pattern, text, re.I)), None)


def required_keys(requirements, architecture=None, user_brief=""):
    # Pull protected hardware from both the structured brief and the generated
    # architecture. The architecture is the only place some interviews record
    # a solar panel or battery, so reading requirements alone can drop a device
    # that is visibly present in the design graph.
    inputs = device_text(json.dumps(requirements.get("hardware_inputs") or [], ensure_ascii=False))
    power = device_text(json.dumps(requirements.get("power_requirements") or [], ensure_ascii=False))
    user_text = device_text(user_brief)
    graph = (architecture or {}).get("architecture_graph") or {}
    graph_keys = {
        key for node in graph.get("nodes", []) if isinstance(node, dict)
        if (key := device_key((node.get("data") or {}).get("label")))
    }
    found = [key for key, pattern in PATTERNS.items()
             if re.search(pattern, inputs if key in ("tds", "ph", "conductivity") else power, re.I)
             or key in graph_keys
             or re.search(pattern, user_text, re.I)]
    # The documented student solar charger is a battery charger and has no
    # battery-less operating mode. Keep its battery as a separate required BOM
    # item when a solar-powered system is requested.
    if "solar" in found and "battery" not in found:
        found.append("battery")
    return found


def _requires_custom_power_profile(requirements):
    """Return true only for power specs incompatible with the documented kit.

    A 3.7V single-cell battery, 4.2V charge limit, 5V regulated panel output,
    or the selected panel's 7.2V open-circuit rating is compatible. Treating
    every voltage or cell-count mention as custom left ordinary projects at
    SELECTION_REQUIRED.
    """
    value = requirements.get("power_requirements") or ""
    text = device_text(json.dumps(value, ensure_ascii=False)).lower()
    if re.search(r"\b(lead[\s-]?acid|lifepo4|lithium[\s-]?iron[\s-]?phosphate|nimh|nicd|nicad|alkaline)\b", text):
        return True
    if re.search(r"\b(?:[2-9]\s*s|[2-9]\s*series|series\s+(?:of\s+)?[2-9])\b", text):
        return True

    battery_terms = [m.start() for m in re.finditer(r"\b(battery|batteries|cell|pack)\b", text)]
    solar_terms = [m.start() for m in re.finditer(r"\b(solar|panel|photovoltaic)\b", text)]
    for match in re.finditer(r"\b(\d+(?:\.\d+)?)\s*v(?:olts?)?\b", text):
        voltage = float(match.group(1))
        position = match.start()
        nearest_battery = min((abs(position - p) for p in battery_terms), default=float("inf"))
        nearest_solar = min((abs(position - p) for p in solar_terms), default=float("inf"))
        if nearest_battery < nearest_solar:
            if voltage not in {3.6, 3.7, 4.2}:
                return True
        elif nearest_solar < nearest_battery:
            if voltage not in {5.0, 7.2}:
                return True
        elif voltage not in {3.3, 3.6, 3.7, 4.2, 5.0, 5.5}:
            return True
    return False


def prepare_architecture(architecture, requirements, user_brief=""):
    """Preserve explicit devices even when inference returned only an interface.

    Repeated calls are idempotent. All existing nodes survive. Defaults are
    recorded as assumptions and can be replaced through external_device_choices.
    The external charging assembly is a system graph, not copper on this PCB.
    """
    custom_power = _requires_custom_power_profile(requirements)
    initial_required = required_keys(requirements, architecture, user_brief)
    result = student_water.prepare(
        architecture,
        requirements,
        PROFILES,
        allow_power_defaults="battery" in initial_required and not custom_power,
        user_brief=user_brief,
    )
    graph = result.setdefault("architecture_graph", {})
    nodes = graph.setdefault("nodes", [])
    edges = graph.setdefault("edges", [])
    required = required_keys(requirements, result, user_brief)
    if not required:
        return result
    choices = requirements.get("external_device_choices") or {}
    if not isinstance(choices, dict): choices = {}
    # Default power kit is suitable for a small 3.3V student controller, not an
    # arbitrary specified 12V/lead-acid/series battery project.
    # A battery does not require a solar panel. Battery + USB-C uses a real
    # USB-C charger/boost assembly, while solar projects keep their solar kit.
    default_power = "battery" in required and not custom_power
    manager_key = "solar_manager" if "solar" in required else "usb_manager"
    assumptions = result.setdefault("assumptions", [])
    existing_ids = {node["id"] for node in nodes}
    requirement_text = json.dumps(requirements, ensure_ascii=False).casefold()

    def ensure(key):
        found = next((n for n in nodes if (n.get("data") or {}).get("external_key") == key
                      or device_key((n.get("data") or {}).get("label")) == key), None)
        if found is None and key == "logic_regulator":
            found = next((n for n in nodes if (n.get("data") or {}).get("category") == "Power"
                          and re.fullmatch(r"power management(?: ic)?|pmic|voltage regulator|3\.3v(?: logic)? regulator", device_text((n.get("data") or {}).get("label", "")), re.I)), None)
            if found is None:
                # If the architecture agent supplied only a catalogue chip
                # guess such as TP4586, reuse that power node for the
                # documented regulator. The generated chip label is not a
                # user part selection; preserve recognizable battery/panel
                # nodes and leave explicitly chosen parts to the requirements.
                found = next((n for n in nodes if (n.get("data") or {}).get("category") == "Power"
                              and device_key((n.get("data") or {}).get("label")) not in ("battery", "solar")
                              and not INTERFACE_ONLY.search(device_text((n.get("data") or {}).get("label", "")))
                              and not (n.get("data") or {}).get("external_key")
                              and str((n.get("data") or {}).get("label", "")).casefold() not in requirement_text), None)
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
        data["label"] = PROFILES[key]["label"]
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

    for key in ("tds", "ph", "conductivity"):
        sensor = devices.get(key)
        if sensor is None or not sensor["data"].get("device_profile"): continue
        # These selected kits have conditioned analog output, not I2C. Remove
        # incompatible signal edges, then retain/add a distinct analog input.
        edges[:] = [e for e in edges if sensor["id"] not in (e.get("source"), e.get("target"))
                    or (e.get("data") or {}).get("interface") == "Power"]
        link(sensor, processor, "Analog")

    if not default_power and processor is not None:
        # The carrier header has three real pins (GND, VCC, analog output).
        # Generic architectures often draw the sensor's analog edge but omit
        # its supply edge. Reuse the power source already connected to the
        # controller; never fabricate a new rail or connect straight to a
        # battery/panel. The selected conditioner profiles document compatible
        # input ranges, which are repeated in their BOM assembly notes.
        power_neighbors = set()
        for edge in edges:
            if str((edge.get("data") or {}).get("interface", edge.get("label", ""))).casefold() != "power":
                continue
            source, target = edge.get("source"), edge.get("target")
            if source == processor["id"] and target:
                power_neighbors.add(target)
            elif target == processor["id"] and source:
                power_neighbors.add(source)
        power_source = next((node for node in nodes if node["id"] in sorted(power_neighbors)
                             and device_key((node.get("data") or {}).get("label")) not in ("battery", "solar")
                             and (node.get("data") or {}).get("device_profile") not in ("battery", "solar")), None)
        if power_source is not None:
            added_sensor_supply = False
            for key in ("tds", "ph", "conductivity"):
                sensor = devices.get(key)
                if sensor is None or not sensor["data"].get("device_profile"):
                    continue
                has_supply = any(
                    sensor["id"] in (edge.get("source"), edge.get("target"))
                    and str((edge.get("data") or {}).get("interface", edge.get("label", ""))).casefold() == "power"
                    for edge in edges
                )
                if not has_supply:
                    link(power_source, sensor, "Power")
                    added_sensor_supply = True
            if added_sensor_supply:
                note = ("Conditioned TDS/pH/conductivity modules use the controller's existing power rail. "
                        "Verify that rail is within each module's documented supply range before fabrication.")
                if note not in assumptions: assumptions.append(note)

    if default_power:
        manager = ensure(manager_key)
        regulator = ensure("logic_regulator")
        devices.update({manager_key: manager, "logic_regulator": regulator})
        external_power_ids = {devices[key]["id"] for key in ("battery", "solar", manager_key) if key in devices}
        # Battery/panel go through the selected external charger. They cannot
        # be connected in parallel to a common controller supply.
        edges[:] = [e for e in edges if not external_power_ids.intersection((e.get("source"), e.get("target")))]
        link(devices["battery"], manager, "Power")
        if "solar" in devices: link(devices["solar"], manager, "Power")
        link(manager, regulator, "Power")
        for key in ("tds", "ph", "conductivity"):
            if key in devices: link(regulator, devices[key], "Power")
        link(regulator, processor, "Power")
        note = "Assume 3.3V logic and a regulated 5V external power assembly. Verify every selected peripheral's voltage/current and pump power budget before fabrication."
        if note not in assumptions: assumptions.append(note)
    result["required_devices"] = [{"key": key, "node_id": devices[key]["id"], "label": PROFILES[key]["label"]} for key in required] + result.get("student_required_devices", [])
    # Keep the existing summary useful when preservation restored a missing node.
    model = result.get("architecture_model")
    if isinstance(model, dict):
        for key, node in devices.items():
            bucket = "sensing_modules" if key in ("tds", "ph", "conductivity") else "power_subsystem"
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
        "external": (profile or {}).get("external", key != "logic_regulator"), "required": True, "external_key": key,
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
        key = device.get("device_profile")
        connector = PROFILES.get(key, {}).get("pcb_connector")
        if not connector and key not in ("tds", "ph", *POWER_MANAGERS): continue
        while f"J{counter}" in used: counter += 1
        reference = f"J{counter}"
        used.add(reference)
        device["pcb_references"] = [reference]
        profile = connector or ("student-sensor-3p" if key in ("tds", "ph") else "student-power-2p")
        row = connector_row(device, reference, profile)
        if profile == "student-i2c-4p": row.update(mfr_part="1x4 2.54mm through-hole header", package="HDR-4-P2.54")
        if profile == "student-digital-3p": row.update(mfr_part="1x3 2.54mm through-hole header", package="HDR-3-P2.54")
        rows.append(row)
        if PROFILES.get(key, {}).get("divider"):
            for leg in ("top", "bottom"):
                number = 1
                while f"R{number}" in used: number += 1
                rref = f"R{number}"; used.add(rref)
                rows.append({"reference": rref, "mfr_part": "10k 1% 0603 resistor", "package": "0603", "board_profile": "student-divider-10k",
                             "subsystem": f"{device['subsystem']} voltage divider ({leg})", "category": "Expansion", "build_quantity": device.get("build_quantity", 1),
                             "divider_for": key, "divider_leg": leg, "unit_price_usd": None, "extended_price_usd": None, "stock": None,
                             "required": True, "external": False, "status": "DOCUMENTED_DEFAULT", "status_reason": "1:1 voltage divider; quote the physical resistors with the PCB parts."})
    manager = next((r for r in rows if r.get("device_profile") in POWER_MANAGERS), None)
    for device in rows:
        if device.get("device_profile") in ("battery", "solar") and manager:
            device["via_reference"] = manager["reference"]
            device["pcb_references"] = manager["pcb_references"]
        via = PROFILES.get(device.get("device_profile"), {}).get("via_profile")
        if via:
            driver = next((r for r in rows if r.get("device_profile") == via), None)
            if driver:
                device["via_reference"] = driver["reference"]
                device["pcb_references"] = driver["pcb_references"]
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
        elif row.get("via_reference"):
            allowed = POWER_MANAGERS if row.get("device_profile") in ("battery", "solar") else (PROFILES.get(row.get("device_profile"), {}).get("via_profile"),)
            if not any(r["reference"] == row["via_reference"] and r.get("device_profile") in allowed and r.get("pcb_references") == row.get("pcb_references") for r in rows):
                issues.append(f"{required['label']}: charger/driver in the required connection path is missing")
    return issues


def board_graph(architecture, rows):
    """Graph for copper only; required external assemblies remain in the IR."""
    result = copy.deepcopy(architecture)
    graph = result["architecture_graph"]
    device_by_node = {r.get("node_id"): r for r in rows if r.get("external")}
    nodes = []
    excluded = set()
    for node in graph["nodes"]:
        if (node.get("data") or {}).get("integrated_in"):
            excluded.add(node["id"])
            continue
        device = device_by_node.get(node["id"])
        if device and device.get("device_profile") not in ("tds", "ph") and not PROFILES.get(device.get("device_profile"), {}).get("pcb_connector"):
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
        if row.get("device_profile") in ("tds", "ph") or PROFILES.get(row.get("device_profile"), {}).get("pcb_connector"):
            refs[node_id] = row["pcb_references"][0]
    return result, refs


def separate_power_nets(nets, rows):
    """Explicit LDO pins prevent all Power edges shorting IN and OUT together."""
    regulator = next((r for r in rows if r.get("device_profile") == "logic_regulator"), None)
    manager = next((r for r in rows if r.get("device_profile") in POWER_MANAGERS), None)
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
