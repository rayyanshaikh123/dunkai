"""Require catalogue evidence of a subsystem's function before ranking it.

Availability, price and embedding similarity cannot turn a touch controller
into a water-quality sensor, or a protection IC into a battery cell.
"""
import re
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
)


def mismatch(candidate, request):
    label = str(request.get("subsystem") or "").lower()
    text = utils.get_searchable_text(candidate)
    # External interface electronics are an explicit architecture choice;
    # their job can be an ADC/AFE/header rather than the external probe itself.
    if re.search(r"\b(interface|connector|conditioning|front.end|adc)\b", label):
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
    for required, evidence in FUNCTIONS:
        if re.search(required, label) and not re.search(evidence, text):
            return f"Catalogue data does not establish the required function: {request.get('subsystem')}"
    return None
