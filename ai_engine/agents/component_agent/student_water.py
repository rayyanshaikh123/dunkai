"""Documented component choices for an unspecified student water project.

This runs inside the original Component Agent. It does not certify a purifier,
invent supplier prices, or replace explicitly requested hardware. The PCB is a
controller/carrier: probes, tubing, pump and complete modules remain purchases.
"""
from __future__ import annotations
import copy
import json
import re


PROFILES = {
    "water_controller": {
        "label": "MCU + BLE", "category": "Processing", "manufacturer": "Raspberry Pi",
        "mfr_part": "SC0918", "description": "Raspberry Pi Pico W RP2040 controller module with integrated Bluetooth LE",
        "source_url": "https://datasheets.raspberrypi.com/picow/pico-w-datasheet.pdf",
        "package": "MODULE-PICO-40", "board_profile": "pico-w-40", "external": False,
        "includes": ["Pico W module", "two 20-pin 2.54mm male headers to solder to the module"],
        "assembly": "Mount the Pico W on the carrier's two 20-pin rows, 17.78mm apart. Regulated 5V feeds VSYS (pin 39); VBUS and 3V3 output are not tied to the carrier rails. Do not simultaneously attach USB power without source isolation. BLE is inside this module, not a separate RF IC. Firmware: I2C0 GP4/GP5, OneWire GP6, flow GP7, pump PWM GP8, buzzer PWM GP9, LED GP10, UV PWM GP11. Keep pump and UV off during startup and do not run both at full power together on the 1A supply.",
    },
    "water_adc": {
        "label": "Four-channel Water Sensor ADC", "category": "Input", "manufacturer": "Texas Instruments",
        "mfr_part": "ADS1115IDGSR", "description": "Four-channel 16-bit I2C ADC for conditioned water-sensor signals",
        "source_url": "https://www.ti.com/lit/ds/symlink/ads1115.pdf",
        "package": "VSSOP-10", "board_profile": "ads1115-dgs", "external": False,
        "assembly": "3.3V supply, ADDR grounded (I2C address 0x48), ALERT/RDY unused. AIN0=pH, AIN1=TDS, AIN2=pressure/2, AIN3=turbidity/2. Set the appropriate PGA range (for example +/-4.096V); a PGA range never permits inputs above the actual supply. Calibrate sensors including divider/loading tolerances. Fit a local 100nF supply capacitor.",
    },
    "water_flow": {
        "label": "Flow Sensor", "category": "Sensor", "manufacturer": "DFRobot", "mfr_part": "SEN0216",
        "description": "Physical YF-S401 liquid flow meter, 0.3–6 L/min, pulse output",
        "source_url": "https://wiki.dfrobot.com/sen0216/", "supply_v": [5, 12], "signal_v": [0, 5],
        "pcb_connector": "student-digital-3p", "interface": "GPIO", "rail_v": 5.0, "divider": True,
        "includes": ["physical inline liquid flow sensor", "cable"],
        "assembly": "Red=5V, black=GND, green=pulse output. The carrier divides the 5V pulse through 10k/10k resistors before GP7; do not connect it directly to 3.3V GPIO. Count rising edges: nominally 5880 pulses/litre. Check flow range and calibrate with the actual plumbing; this is a liquid meter, not an air-flow IC.",
    },
    "water_pressure": {
        "label": "Pressure Sensor", "category": "Sensor", "manufacturer": "DFRobot", "mfr_part": "SEN0257",
        "description": "Physical water pressure transducer with conditioned analog output",
        "source_url": "https://wiki.dfrobot.com/sen0257/", "supply_v": [5, 5], "signal_v": [0.5, 4.5],
        "pcb_connector": "student-sensor-3p", "interface": "Analog", "rail_v": 5.0, "divider": True,
        "includes": ["physical water pressure sensor", "Gravity cable"],
        "assembly": "Supply 5V and ground; connect analog signal to the pressure header. The carrier's 10k/10k divider reduces 0.5–4.5V to 0.25–2.25V at ADS1115 AIN2. Firmware must multiply measured voltage by two before applying the sensor calibration. Verify threaded fitting/seals and operating pressure.",
    },
    "water_turbidity": {
        "label": "Turbidity Sensor", "category": "Sensor", "manufacturer": "DFRobot", "mfr_part": "SEN0189",
        "description": "Physical optical turbidity probe with analog conditioner",
        "source_url": "https://wiki.dfrobot.com/sen0189", "supply_v": [5, 5], "signal_v": [0, 4.5],
        "pcb_connector": "student-sensor-3p", "interface": "Analog", "rail_v": 5.0, "divider": True,
        "includes": ["physical optical probe", "conditioner board", "probe cable"],
        "assembly": "Set conditioner to analog mode. Connect GND, 5V and analog output to the stated custom harness. The carrier divides output by two before ADS1115 AIN3. Restore the original voltage in firmware and calibrate against standards. Keep the conditioner dry; follow the probe immersion limits.",
    },
    "water_temperature": {
        "label": "Temperature Sensor", "category": "Sensor", "manufacturer": "Adafruit", "mfr_part": "381",
        "description": "Physical waterproofed DS18B20 temperature probe for demonstration water measurements",
        "source_url": "https://www.adafruit.com/product/381", "supply_v": [3, 5],
        "pcb_connector": "student-digital-3p", "interface": "OneWire", "rail_v": 3.3,
        "includes": ["physical wired DS18B20 probe"],
        "assembly": "Use powered three-wire mode: red=3.3V, black/blue=GND, yellow/white=DATA. The carrier adds a 4.7k DATA pull-up to 3.3V. Check wire colours on the supplied probe. Not rated for salt water, high pressure or guaranteed continuous immersion.",
    },
    "water_pump_driver": {
        "label": "Pump Driver", "category": "Output", "manufacturer": "Adafruit", "mfr_part": "3297",
        "description": "Complete DRV8833 DC motor driver breakout for the separate water pump",
        "source_url": "https://learn.adafruit.com/adafruit-drv8833-dc-stepper-motor-driver-breakout-board/pinouts",
        "pcb_connector": "student-digital-3p", "interface": "PWM", "rail_v": 5.0,
        "includes": ["DRV8833 breakout", "motor current-sense resistors"],
        "assembly": "Custom harness: GND, regulated 5V to Vmotor, PWM to AIN1. Tie AIN2 and unused BIN1/BIN2 to GND; tie SLP high (5V is a supported logic level). Connect the separate FIT0910 pump only across Motor A outputs, never GPIO. Default current limit is 1A; check startup/stall current and the entire 1A source budget. Start with pump and UV off and enable one load at a time.",
    },
    "water_pump": {
        "label": "Pump", "category": "Output", "manufacturer": "DFRobot", "mfr_part": "FIT0910",
        "description": "Physical 3–6V DC water pump including 1m pipe",
        "source_url": "https://www.dfrobot.com/product-2647.html", "supply_v": [3, 6], "max_output_a": 0.37,
        "via_profile": "water_pump_driver", "includes": ["physical DC water pump", "1m pipe"],
        "assembly": "Connect the pump across the DRV8833 Motor A output terminals. Rated working current is 150–370mA; stall/startup must be measured. This low-head pump is for recirculating student demonstrations, not an RO membrane/high-pressure pump. A driver chip does not replace this physical pump.",
    },
    "water_uv": {
        "label": "UV LED + Driver", "category": "Output", "manufacturer": "MikroElektronika", "mfr_part": "MIKROE-4177",
        "description": "UVC Light Click: two physical 275nm UV-C LEDs and complete TPS61169 current driver",
        "source_url": "https://www.mikroe.com/uvc-light-click", "supply_v": [5, 5],
        "pcb_connector": "student-digital-3p", "interface": "PWM", "rail_v": 5.0,
        "includes": ["two physical UV-C emitters", "complete constant-current boost circuit"],
        "assembly": "Select 5V on PWR SEL; leave its separate battery connector empty. Wire 5V to mikroBUS pin 10, GND to pin 8/9, PWM to DIM pin 16 using the custom harness. Default firmware duty is zero. Operate only in an opaque, interlocked enclosure with no eye/skin exposure. This module's documented use is surface disinfection; a water reactor, contact time and measured UV dose need separate validation. No drinking-water safety claim is made. Do not run UV and pump at full power simultaneously on the 1A supply.",
    },
    "water_display": {
        "label": "Display", "category": "Output", "manufacturer": "Adafruit", "mfr_part": "326",
        "description": "Complete 128x64 SSD1306 OLED display, current STEMMA QT I2C version",
        "source_url": "https://www.adafruit.com/product/326", "supply_v": [3, 5],
        "pcb_connector": "student-i2c-4p", "interface": "I2C", "rail_v": 3.3,
        "includes": ["physical OLED screen", "SSD1306 controller board"],
        "assembly": "Use the current STEMMA QT four-wire I2C version, not an older SPI revision. Connect GND, 3.3V, SCL and SDA in the stated carrier-header order with an adapter cable. Use address 0x3C (verify actual revision). A bare seven-segment display cannot be wired as an SPI peripheral.",
    },
    "water_buzzer_driver": {
        "label": "Buzzer Driver", "category": "Output", "manufacturer": "Adafruit", "mfr_part": "5791",
        "description": "Complete PAM8904 STEMMA piezo driver board for the separate audible piezo",
        "source_url": "https://learn.adafruit.com/adafruit-stemma-piezo-driver-amp/pinouts",
        "pcb_connector": "student-digital-3p", "interface": "PWM", "rail_v": 3.3,
        "includes": ["piezo driver board"],
        "assembly": "Connect GND, 3.3V VIN and PWM SIG with the custom harness. Connect the separately listed piezo across VO+ and VO-, not to GND. Set gain x1 initially and produce an audible square wave (for example 2kHz). This driver does not include the physical piezo.",
    },
    "water_buzzer": {
        "label": "Buzzer", "category": "Output", "manufacturer": "Adafruit", "mfr_part": "1739",
        "description": "Physical enclosed piezo sounder with wires",
        "source_url": "https://www.adafruit.com/product/1739", "via_profile": "water_buzzer_driver",
        "includes": ["physical piezo element with wires"],
        "assembly": "Connect both piezo wires to the PAM8904 board VO+ and VO- terminals. Neither differential output is ground. The audio-amplifier IC alone is not a buzzer.",
    },
    "water_led": {
        "label": "LED Indicator", "category": "Output", "manufacturer": "DFRobot", "mfr_part": "DFR0021-W",
        "description": "Physical white LED module with drive/current-limiting circuitry",
        "source_url": "https://wiki.dfrobot.com/dfr0021-w/", "supply_v": [3.3, 5],
        "pcb_connector": "student-digital-3p", "interface": "GPIO", "rail_v": 3.3,
        "includes": ["physical LED", "LED module circuitry"],
        "assembly": "Map the carrier GND/3.3V/SIG harness to module GND/VCC/D by label (module pin order differs). A GPIO high enables the physical LED. Do not substitute an LED-driver IC for the LED itself.",
    },
}


def prepare(architecture, requirements, profiles, allow_power_defaults=True, user_brief=""):
    """Select documented intermediate-project parts when the user left them open."""
    result = copy.deepcopy(architecture)
    initial_graph = result.get("architecture_graph") or {}
    initial_labels = " ".join(
        str((node.get("data") or {}).get("label", ""))
        for node in initial_graph.get("nodes", []) if isinstance(node, dict)
    )
    text = json.dumps(requirements, ensure_ascii=False) + "\n" + user_brief + "\n" + initial_labels
    if not re.search(r"\bwater\b", text, re.I): return result
    if not re.search(r"\b(tds|ph|turbidity)\b", text, re.I): return result
    if requirements.get("component_selection_mode") == "catalogue" or requirements.get("external_device_choices"): return result
    if not allow_power_defaults: return result
    graph = result.setdefault("architecture_graph", {})
    nodes, edges = graph.setdefault("nodes", []), graph.setdefault("edges", [])
    processor = next((n for n in nodes if (n.get("data") or {}).get("category") == "Processing"), None)
    if not processor: return result
    # Architecture Agent part suggestions are not user selections. Preserve a
    # named processor only when the user included that exact part in the brief.
    processor_label = str(processor["data"].get("label", "")).strip()
    requirement_text = json.dumps(requirements, ensure_ascii=False).casefold()
    if requirements.get("processing_unit") or requirements.get("microcontroller"): return result
    if processor_label and processor_label.casefold() in requirement_text: return result
    profiles.update(PROFILES)
    result["component_recipe"] = "student-water-v1"
    assumptions = result.setdefault("assumptions", [])
    note = "Unspecified student water-project hardware uses documented modules and an RP2040 Pico W carrier. Physical devices are retained; module interfaces and 5V/3.3V rails are explicit. Prices require supplier quotes. This is not a certified drinking-water treatment design."
    if note not in assumptions: assumptions.append(note)
    ids = {n["id"] for n in nodes}

    def select(node, key):
        node["data"].update(external_key=key, device_profile=key, required=True,
                            external=profiles[key].get("external", True), label=profiles[key]["label"])
        return node

    def ensure(key, pattern):
        node = next((n for n in nodes if (n.get("data") or {}).get("device_profile") == key or re.search(pattern, re.sub(r"(?<=[A-Za-z])(?=[A-Z][a-z])", " ", str((n.get("data") or {}).get("label", ""))), re.I)), None)
        if not node:
            ident = f"student-{key}"
            while ident in ids: ident += "-device"
            node = {"id": ident, "data": {"category": profiles[key]["category"]}}
            nodes.append(node); ids.add(ident)
        return select(node, key)

    select(processor, "water_controller")
    for node in nodes:
        if re.search(r"\b(ble|bluetooth)\b", re.sub(r"(?<=[A-Za-z])(?=[A-Z][a-z])", " ", str(node["data"].get("label", ""))), re.I) and node is not processor:
            node["data"].update(integrated_in=processor["id"], label="BLE (integrated in Pico W)")
    graph_hardware = " ".join(
        str((node.get("data") or {}).get("label", ""))
        for node in nodes if isinstance(node, dict)
    )
    inputs = " ".join((json.dumps(requirements.get("hardware_inputs") or ""), graph_hardware, user_brief))
    outputs = " ".join((json.dumps(requirements.get("hardware_outputs") or ""), graph_hardware, user_brief))
    selected = {"water_controller": processor}
    for key, pattern in [("water_flow", r"flow"), ("water_pressure", r"pressure"), ("water_turbidity", r"turbidity"), ("water_temperature", r"temperature")]:
        if re.search(pattern, inputs, re.I): selected[key] = ensure(key, pattern)
    if re.search(r"display|screen", outputs, re.I): selected["water_display"] = ensure("water_display", r"display|screen")
    if re.search(r"buzzer", outputs, re.I):
        selected["water_buzzer"] = ensure("water_buzzer", r"^buzzer$")
        selected["water_buzzer_driver"] = ensure("water_buzzer_driver", r"buzzer driver")
    if re.search(r"\b(led|indicator)\b", outputs, re.I): selected["water_led"] = ensure("water_led", r"led|indicator")
    if re.search(r"uv", outputs, re.I): selected["water_uv"] = ensure("water_uv", r"uv.*led|uvc")
    if re.search(r"pump", outputs, re.I):
        selected["water_pump_driver"] = ensure("water_pump_driver", r"pump driver")
        selected["water_pump"] = ensure("water_pump", r"^pump$")
    selected["water_adc"] = ensure("water_adc", r"four.channel water sensor adc")
    selected_ids = {n["id"] for n in selected.values()}
    # Remove incompatible inferred links, e.g. turbidity on I2C or a bare
    # seven-segment screen on SPI. The documented interfaces replace them.
    edges[:] = [e for e in edges if not selected_ids.intersection((e.get("source"), e.get("target")))
                or (e.get("data") or {}).get("interface") == "Power"]
    for key, node in selected.items():
        interface = profiles[key].get("interface")
        if interface:
            target = selected["water_adc"] if interface == "Analog" else processor
            edges.append({"id": f"student-{node['id']}-{interface}", "source": node["id"], "target": target["id"], "data": {"interface": interface}})
    edges.append({"id": "student-adc-i2c", "source": selected["water_adc"]["id"], "target": processor["id"], "data": {"interface": "I2C"}})
    result["student_required_devices"] = [{"key": k, "node_id": n["id"], "label": profiles[k]["label"]} for k, n in selected.items() if profiles[k].get("external", True)]
    model = result.setdefault("architecture_model", {})
    model["processing_unit"] = "Raspberry Pi Pico W (RP2040 + BLE)"
    return result


def complete_nets(nets, rows, architecture):
    """Verified pin functions and input dividers for this module carrier only."""
    if architecture.get("component_recipe") != "student-water-v1": return nets
    nets = copy.deepcopy(nets)
    by_key = {r.get("device_profile"): r for r in rows if r.get("device_profile")}
    controller, adc = by_key["water_controller"]["reference"], by_key["water_adc"]["reference"]
    def port(key): return by_key[key]["pcb_references"][0]
    ground = next(n for n in nets if n["net_class"] == "ground")
    logic = next(n for n in nets if n["name"] == "LOGIC_3V3")
    power = next(n for n in nets if n["name"] == "REGULATED_5V_IN")
    profiles = {r["reference"]: PROFILES.get(r.get("device_profile"), {}) for r in rows}
    # Rebuild memberships from the actual modules' voltage requirements rather
    # than connecting every Power edge to one rail. Pico VSYS is 5V; IO is 3.3V.
    logic["members"] = [m for m in logic["members"] if m["ref_id"] != controller and not profiles.get(m["ref_id"], {}).get("divider_resistor")]
    power["members"].append({"ref_id": controller, "role": "SUPPLY", "pin_function": "VSYS"})
    if not any(m["ref_id"] == adc for m in logic["members"]): logic["members"].append({"ref_id": adc, "role": "SUPPLY", "pin_function": "VDD"})
    for key, row in by_key.items():
        if not row.get("external") or not row.get("pcb_references") or key not in PROFILES: continue
        if PROFILES[key].get("via_profile"): continue
        ref = port(key)
        logic["members"] = [m for m in logic["members"] if m["ref_id"] != ref]
        rail = power if PROFILES[key].get("rail_v") == 5 else logic
        rail["members"].append({"ref_id": ref, "role": "SUPPLY"})
    ground["members"].append({"ref_id": adc, "role": "GROUND", "pin_function": "ADDR"})
    analog_channels = {"ph": "AIN0", "tds": "AIN1", "water_pressure": "AIN2", "water_turbidity": "AIN3"}
    gpio_functions = {"water_temperature": "GP6", "water_flow": "GP7", "water_pump_driver": "GP8", "water_buzzer_driver": "GP9", "water_led": "GP10", "water_uv": "GP11"}
    port_keys = {port(k): k for k, r in by_key.items() if r.get("pcb_references") and not PROFILES.get(k, {}).get("via_profile")}
    for net in nets:
        if net["net_class"] != "signal": continue
        if net["interface"] == "I2C":
            net["voltage_v"] = 3.3
            for m in net["members"]:
                if m["ref_id"] == controller: m["pin_function"] = "GP5" if m["role"] == "CLOCK" else "GP4"
                elif m["ref_id"] == adc: m["pin_function"] = "SCL" if m["role"] == "CLOCK" else "SDA"
            continue
        sensor = next((port_keys[m["ref_id"]] for m in net["members"] if m["ref_id"] in port_keys), None)
        if sensor in analog_channels:
            # prepare_architecture initially links ph/TDS to the MCU; the ADC
            # replaces that destination. It never treats a GPIO as an ADC.
            for m in net["members"]:
                if m["ref_id"] in (controller, adc): m.update(ref_id=adc, pin_function=analog_channels[sensor])
        elif sensor in gpio_functions:
            net["voltage_v"] = 3.3
            for m in net["members"]:
                if m["ref_id"] == controller: m["pin_function"] = gpio_functions[sensor]
    # Each high-voltage input gets its own physical 1:1 divider. Both 10k
    # resistors are on the PCB, with named terminals verified by its profile.
    for key in ("water_pressure", "water_turbidity", "water_flow"):
        if key not in by_key: continue
        ref = port(key)
        signal = next(n for n in nets if n["net_class"] == "signal" and any(m["ref_id"] == ref for m in n["members"]))
        top = next(r for r in rows if r.get("divider_for") == key and r["divider_leg"] == "top")["reference"]
        bottom = next(r for r in rows if r.get("divider_for") == key and r["divider_leg"] == "bottom")["reference"]
        ground["members"] = [m for m in ground["members"] if m["ref_id"] not in (top, bottom)]
        ground["members"].append({"ref_id": bottom, "role": "GROUND", "pin_function": "B"})
        signal["members"] = [m for m in signal["members"] if m["ref_id"] != ref]
        signal["members"].extend([{"ref_id": top, "role": "GPIO", "pin_function": "B"}, {"ref_id": bottom, "role": "GPIO", "pin_function": "A"}])
        # Resistor junction is a wire, not an ADC or firmware capability.
        for m in signal["members"]:
            if m["ref_id"] in (top, bottom): m["role"] = signal["members"][0]["role"]
        nets.append({"name": f"{key.upper()}_RAW", "interface": signal["interface"], "net_class": "signal", "members": [
            {"ref_id": ref, "role": signal["members"][0]["role"]}, {"ref_id": top, "role": signal["members"][0]["role"], "pin_function": "A"}]})
    return nets
