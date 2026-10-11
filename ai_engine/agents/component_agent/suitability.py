"""Require catalogue evidence of a subsystem's function before ranking it.

Availability, price and embedding similarity cannot turn a touch controller
into a water-quality sensor, or a protection IC into a battery cell.
"""
import re

import roles
import utils


FUNCTIONS = (
    (r"\b(tds|total dissolved solids|conductivity)\b", r"\b(tds|total dissolved solids|conductivity|conductance)\b"),
    (r"\b(ph|acidity)\b", r"\b(ph|acidity|electrochemical|ion.sensitive)\b"),
    (r"\btur[b]?idity\b", r"\b(turbidity|turbidimeter)\b"),
    (r"\bflow\b", r"\b(flow sensor|flow meter|flowmeter|fluid flow|water flow|liquid flow|mass flow)\b"),
    (r"\b(temperature|thermal)\b", r"\b(temperature|thermal sensor|thermistor|thermocouple|rtd)\b"),
    (r"\b(humidity|moisture)\b", r"\b(humidity|moisture)\b"),
    (r"\bpressure\b", r"\b(pressure|barometric)\b"),
    (r"\b(ble|bluetooth)\b", r"\b(ble|bluetooth)\b"),
    # An air temperature/humidity sensor is not a soil probe.
    (r"\bsoil\b", r"\b(soil|moisture sensor|moisture probe)\b"),
    # Touch-screen controllers, inductance converters and touch keys have all
    # been offered for these on embedding similarity alone.
    (r"\b(gps|gnss)\b", r"\b(gps|gnss|glonass|beidou|galileo|satellite positioning)\b"),
    (r"\b(camera|image sensor)\b", r"\b(camera|image sensors?|cmos sensor)\b"),
    (r"\bproximity\b", r"\b(proximity|time.of.flight|tof|ultrasonic|distance|ranging)\b"),
    # Display hardware, not a video bridge (MS9122) or a bare driver IC.
    # Genuine LCSC module rows can carry "led driver" in their category, so
    # driver words are not a disqualifier here; the evidence is.
    (r"\bdisplay\b", r"\b(lcd screen|oled display|display modules?|display screen|dot matrix|segment displays?|led displays?|e.paper|e.ink|tft)\b"),
)


def mismatch(candidate, request):
    """Why `candidate` cannot fill `request`, or None.

    A block with a role (roles.py) is judged by the role: wrong subcategory or
    a disqualifying description fails; missing evidence is "unknown", which
    ranking keeps but ranks lower. Blocks without a role fall back to the
    function rules below.
    """
    role = request.get("role")
    if role is None and "role" not in request:
        role = roles.infer_role(request.get("subsystem"), request.get("category")).key
    if role:
        result, reason = roles.verdict(candidate, role)
        if result == roles.FAIL:
            return reason
        # Without a subcategory (a saved BOM row) the role cannot prove
        # anything; the function rules still catch the obvious wrong parts.
        if result == roles.UNKNOWN and not str(candidate.get("subcategory") or "").strip():
            return _legacy_mismatch(candidate, request)
        return None
    return _legacy_mismatch(candidate, request)


def _legacy_mismatch(candidate, request):
    label = str(request.get("subsystem") or "").lower()
    text = utils.get_searchable_text(candidate)
    # External interface electronics are an explicit architecture choice;
    # their job can be an ADC/AFE/header rather than the external probe itself.
    # A "user interface" display or keypad is the device itself, not that.
    if re.search(r"\b(interface|connector|conditioning|front.end|adc)\b", label.replace("user interface", "")):
        return None
    if re.search(r"\b(solar panel|photovoltaic panel)\b", label):
        if not re.search(r"\b(solar panel|photovoltaic panel|photovoltaic cell)\b", text) or re.search(r"\b(controller|switch|regulator|converter|charger|driver)\b", text):
            return "A solar panel requires photovoltaic hardware, not a power-control IC"
    if label.strip() in ("battery", "battery cell", "battery pack"):
        if not re.search(r"\b(battery cell|battery pack|lithium.ion battery|lithium.polymer battery|rechargeable battery|coin cell)\b", text) or re.search(r"\b(protection|management|monitor|controller|charger|charging|regulator|converter)\b", text):
            return "A battery requires a cell or pack, not a battery-management IC"
    if re.search(r"\b(lcd display|lcd screen)\b", label):
        if not re.search(r"\b(lcd display|lcd module|lcd screen|display module|liquid crystal display module)\b", text) or re.search(r"\b(driver|decoder|controller)\b", text):
            return "An LCD display requires display hardware, not only a display-driver IC"
    if re.search(r"\bled indicator\b", label):
        if not re.search(r"\b(led|light.emitting diode)\b", text) or re.search(r"\b(driver|controller|decoder)\b", text):
            return "An LED indicator requires an LED, not only an LED-driver IC"
    if re.search(r"\bmotor (driver|controller)\b", label):
        # LCSC files EMC2103 (a fan controller) under motor drivers as well as
        # MCUs; no genuine motor-driver row mentions a microcontroller or fan.
        if not re.search(r"\b(motor drivers?|h.bridge|stepper|motor controller)\b", text) or re.search(r"\b(microcontroller|fan)\b", text):
            return "A motor driver requires a motor-driver IC, not a fan controller or MCU"
    for required, evidence in FUNCTIONS:
        if re.search(required, label) and not re.search(evidence, text):
            return f"Catalogue data does not establish the required function: {request.get('subsystem')}"
    return None
