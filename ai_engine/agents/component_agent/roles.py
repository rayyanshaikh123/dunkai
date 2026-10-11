"""Design roles: what a part has to BE for each block of an architecture.

Retrieval used to search by embedding similarity inside the architecture's
coarse category (Processing, Sensor, ...). That put a touch-screen controller
in as a GPS receiver, an inductance converter as a camera, a fan controller as
a motor driver and a USB-HDMI bridge as a display: each was "close enough" in
embedding space and nothing checked what the part actually is.

Each block is now given a role from this closed table, inferred
deterministically from its label (and, where the label is vague, its edges).
A role names the exact catalogue subcategories that can fill it, plus:

* ``reject``   -- text that disqualifies a part filed in an allowed
                  subcategory anyway. LCSC files EMC2103 (a fan controller)
                  under MCUs, a USB 2.0 switch under USB ICs, and so on.
* ``evidence`` -- text that should be present; when absent the part is
                  "unknown": kept, ranked below verified parts, and flagged.

Roles whose hardware is not sold as an orderable chip (a soil probe, a camera
module) are ``source="external"`` and are fulfilled by a documented module
profile in external_devices.py, never by a catalogue lookalike.

Pure Python on purpose -- no pandas/config import -- so supervisor/board.py can
use it to re-check saved BOMs cheaply.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

PASS, UNKNOWN, FAIL = "pass", "unknown", "fail"

#: A role whose allowlist has fewer in-stock rows than this is reported by
#: verify(): selection will often end in NO_MATCH for it.
THIN_ROLE_ROWS = 3


def key(label: Any) -> str:
    """Subcategory comparison key. Merges the catalogue's spelling variants:
    "real-time clocks (rtc)" / "real-time clocks(rtc)", "led segment display"
    / "led segment displays" (trailing s), "rs-485 / rs-422 ics" / "rs-485/rs-422 ics"."""
    text = re.sub(r"[^a-z0-9]", "", str(label or "").lower())
    return text[:-1] if text.endswith("s") else text


@dataclass(frozen=True)
class Role:
    key: str
    name: str
    patterns: Tuple[str, ...]
    subcategories: Tuple[str, ...] = ()
    evidence: Optional[str] = None
    reject: Optional[str] = None
    source: str = "catalogue"
    module_profile: Optional[str] = None
    note: Optional[str] = None
    #: A label matching this is NOT this role even if a pattern matched.
    unless: Optional[str] = None

    @property
    def allowed(self) -> frozenset:
        return frozenset(key(s) for s in self.subcategories)


_MCU_SUBCATS = (
    "microcontroller units (mcus/mpus/socs)", "microcontrollers (mcu/mpu/soc)", "nxp mcu", "ti mcu",
    "artery mcu", "other processors and microcontrollers (mcus)", "microprocessor & microcontroller",
)
_WIRELESS_MODULES = ("wifi modules", "bluetooth modules")
_DISPLAYS = (
    "lcd displays modules", "oled displays modules", "oled display", "lcd screen", "liquid crystal display screen",
    "organic light emitting diode display screen",
)

# Ordered: the first role whose pattern matches the label wins. Specific roles
# come before generic ones -- "Soil Moisture" before humidity, "Temperature and
# Humidity" before temperature, "GPS Antenna" before GNSS, every "X controller"
# before the MCU, "Camera Flash LED" (LED) before camera and flash memory.
ROLES: Tuple[Role, ...] = (
    Role("antenna", "Antenna", (r"\bantennas?\b",), ("antennas", "antenna"), unless=r"\b(module|receiver|transceiver)\b"),
    Role("led", "LED", (r"\bleds?\b", r"\blight emitting diode\b", r"\b(indicator|status) light\b"),
         ("light emitting diodes (led)", "led indication - discrete"), reject=r"\b(driver|controller|decoder)\b",
         unless=r"\b(display|matrix|segment|driver|strip)\b"),
    Role("soil_moisture", "Soil Moisture Sensor", (r"\bsoil\b", r"\bmoisture\b"), source="external", module_profile="soil_moisture"),
    Role("camera", "Camera Module", (r"\b(camera|image sensor|imager|imaging)\b",), source="external"),
    Role("touch_screen_ctrl", "Touch Screen Controller", (r"\btouch ?(screen|panel)\b",), ("touch screen controllers",),
         unless=r"\b(display|lcd|oled|tft)\b"),
    Role("touch_key", "Touch Key Sensor", (r"\btouch (key|button|pad|sensor|switch)\b", r"\bcapacitive touch\b"), ("touch sensors",)),
    Role("motor_driver", "Motor Driver",
         (r"\b(motor|stepper|servo)s?\b.*\b(driver|controller|control|drive)\b", r"\bh.?bridge\b", r"\bstepper driver\b"),
         ("motor driver ics", "brushed dc motor drivers", "stepper motor driver", "brushless dc (bldc) motor driver", "motor drivers"),
         # Fan controllers and relay drivers share these subcategories and their
         # text never says "fan": EMC2302 reads "smbus ... brushed dc motor
         # drivers". Known families are rejected by part number; the rest must
         # show actual drive capability to pass.
         evidence=r"\b(h.bridge|half.bridge|full.bridge|stepper|drive motor type|\d+(\.\d+)?\s?a)\b",
         reject=r"\b(fan|microcontrollers?|relay|coil driver|solenoid|smbus|emc2[13]\d\d|tc64\d|tc66[45]|max66[5-9]\d|amc6821|bl8023|gm8023)"),
    Role("battery_charger", "Battery Charger",
         (r"\b(charger|charging|charge (controller|management|ic))\b",),
         ("battery management ics", "battery management", "pmic - battery management"),
         evidence=r"(charg|充电)", reject=r"\b(protection ic|monitoring ic|fuel gauge|balanc\w*)\b"),
    Role("usb_pd_sink", "USB Power Delivery Receiver",
         (r"\busb(?:.?c)?\b.*\b(power delivery|pd (?:sink|receiver|controller))\b",),
         ("usb pd",), evidence=r"\b(power receiver controller|power receiver|pd sink|sink controller)\b",
         reject=r"\b(power supply controller|source controller|usb connector|receptacle|socket)\b"),
    Role("unspecified_power", "Power Management Circuit",
         (r"\b(power management(?: ic)?|pmic)\b",), source="selection"),
    Role("usb_hub", "USB Hub", (r"\busb hub\b",), ("usb hub controllers",)),
    Role("usb_uart_bridge", "USB-to-UART Bridge",
         (r"\busb\b.*\b(uart|serial|ttl|bridge|converter|programmer)\b", r"\b(uart|serial)\b.*\busb\b", r"\b(ch340|cp210\d|ft232)"),
         ("usb ics", "usb converters", "usb conversion modules"),
         # Bridges are listed as "usb converters ... transceiver"; the TP3USB31
         # switch shares that subcategory but has neither word nor family name.
         evidence=r"\b(uart|serial|rs232|ttl|transceiver|ch34\d|cp210\d|ft23\d|pl2303)", reject=r"\b(switch(es)?|mux|multiplexers?|hubs?|pd|power delivery|sd card|esd)\b"),
    Role("usb_connector", "USB Connector",
         (r"\busb\b.*\b(connector|port|socket|receptacle|jack)\b", r"\busb.?c\b", r"\btype.?c\b"), ("usb connectors",)),
    Role("cellular", "Cellular Module",
         (r"\b(lte|gsm|gprs|nb.?iot|cat.?m1?|cellular|modem)\b", r"(?<![\d.])[2345]g\b", r"\bsim ?\d{3,4}"),
         ("2g/3g/4g/5g modules",), evidence=r"\b(lte|gsm|gprs|nb.?iot|cat|umts|wcdma|[2345]g)\b",
         note="Needs a SIM card holder, an LTE/GSM antenna and a supply rated for ~2A transmit peaks."),
    Role("gnss", "GNSS Receiver", (r"\b(gps|gnss|glonass|beidou|galileo|satellite positioning)\b",),
         ("gnss modules", "satellite positioning modules"),
         note="Needs a GNSS antenna (active patch antenna or the module's specified passive antenna)."),
    Role("lora", "LoRa Module", (r"\blora(wan)?\b",), ("lora modules",)),
    Role("zigbee", "Zigbee Module", (r"\bzigbee\b",), ("zigbee modules",)),
    Role("rs485", "RS-485 Transceiver", (r"\brs.?(485|422)\b",),
         ("rs-485/rs-422 ics", "rs-485 / rs-422 ics", "rs-485 & rs-422", "isolated rs-485/422 transceivers")),
    Role("can", "CAN Transceiver", (r"\bcan.?(bus|transceiver|controller|interface)\b",),
         ("can transceivers", "can ics", "isolated can transceivers")),
    Role("ethernet", "Ethernet Controller", (r"\bethernet\b",), ("ethernet ics", "ethernet controllers", "ethernet transceivers", "ethernet modules")),
    # Explicit MCU words win over the radio roles below: "Microcontroller with
    # WiFi" is the MCU, and the MCU role admits Wi-Fi/BLE modules when asked.
    Role("mcu", "Microcontroller",
         (r"\b(mcu|microcontroller|micro.?controller|main controller|central controller|processor|processing unit|soc)\b",
          r"\b(esp32|esp8266|stm32|atmega|attiny|rp2040|nrf52|pic\d+|arduino|raspberry pi pico)\b"),
         _MCU_SUBCATS,
         evidence=r"\b(cpu core|program storage size|flash|cortex|risc.?v|8051|51 ?(family|series)|avr|pic\d|arm|xtensa)\b",
         reject=r"\b(motor drivers?|brushed dc|fan (control|speed)|mosfets?|power monitor|supervisors?)\b"),
    # Never matched by pattern: infer_role picks it for an MCU block that also
    # needs Wi-Fi/BLE, so an ESP32-class module can fill it.
    Role("mcu_wireless", "Wireless Microcontroller", (), _MCU_SUBCATS + _WIRELESS_MODULES,
         evidence=r"\b(cpu core|program storage size|flash|cortex|risc.?v|xtensa|esp32|esp8266|nrf5|wi.?fi|bluetooth|ble)\b",
         reject=r"\b(motor drivers?|brushed dc|fan (control|speed)|mosfets?|power monitor|supervisors?)\b"),
    Role("adc", "Analog-to-Digital Converter",
         (r"\b(adc|analog.to.digital(?: converter)?|signal conditioning/adc)\b",),
         ("analog to digital converters (adcs)", "analog to digital converters (adc)",
          "adc/dac - specialized", "adcs/dacs - special purpose"),
         evidence=r"\b(adc|analog.to.digital|a/d converter|delta.sigma|successive approximation)\b",
         reject=r"\b(microcontrollers?|mcu|processor|translators?|level shifters?)\b"),
    Role("unspecified_connector", "Analog Sensor Connector",
         (r"\banalog sensor (?:connector|interface|header)\b",), source="selection"),
    Role("unspecified_conditioning", "Signal Conditioning Circuit",
         (r"\bsignal conditioning\b",), source="selection"),
    Role("segment_display", "Segment Display",
         (r"\b(7.?segment|seven.?segment|segment display)\b",),
         ("led segment display", "led segment displays")),
    Role("matrix_display", "LED Matrix Display",
         (r"\b(led matrix|dot matrix)\b",), ("led displays - dot matrix",)),
    Role("wifi", "Wi-Fi Module", (r"\b(wi.?fi|wlan|802\.11)\b",), _WIRELESS_MODULES, evidence=r"\b(wi.?fi|wlan|802\.11)"),
    Role("ble", "Bluetooth Module", (r"\b(ble|bluetooth)\b",), _WIRELESS_MODULES, evidence=r"\b(ble|bluetooth)\b"),
    Role("display", "Display",
         (r"\b(display|lcd|oled|tft|e.?paper|e.?ink|screen|7.?segment|seven.?segment|dot.?matrix)\b",), _DISPLAYS,
         reject=r"\b(video|bridge|hdmi|driver ics?)\b",
         note="Catalogue display modules are often bare glass with an FPC tail; the PCB needs the matching FPC connector."),
    Role("proximity", "Proximity / Distance Sensor",
         (r"\b(proximity|presence|distance|ranging|tof|time.of.flight|ultrasonic|obstacle)\b",),
         ("proximity sensors", "ultrasonic receivers, transmitters", "ambient light sensors"),
         evidence=r"\b(proximity|distance|ranging|tof|time.of.flight|ultrasonic|infrared|capacitive)\b"),
    Role("humidity", "Humidity Sensor", (r"\b(humidity|hygrometer|rh)\b",),
         ("humidity sensors/temperature and humidity sensors", "temperature and humidity sensor", "pressure sensors"),
         evidence=r"(humidity|%rh|\brh\b)"),
    Role("pressure", "Pressure Sensor", (r"\b(pressure|barometer|barometric|altimeter)\b",), ("pressure sensors",)),
    Role("gas", "Gas Sensor", (r"\b(gas|co2|carbon (di|mon)oxide|voc|air quality|smoke|methane|alcohol)\b",), ("gas sensors",)),
    Role("light", "Light Sensor", (r"\b(ambient light|light sensor|lux|illuminance|photo.?sensor|light intensity)\b",), ("ambient light sensors",)),
    Role("imu", "Motion Sensor (IMU)", (r"\b(imu|accelerometer|gyro|gyroscope|inertial|motion sensor|tilt|orientation)\b",),
         ("motion sensors - accelerometers", "accelerometers", "attitude sensor/gyroscope", "attitude sensors")),
    Role("magnetic", "Magnetic Sensor", (r"\b(hall|magnetometer|magnetic|compass)\b",),
         ("hall sensor", "magnetic sensors", "linear hall sensors", "hall switches", "3d magnetic sensors", "magnetic angle sensors")),
    Role("temperature", "Temperature Sensor", (r"\b(temperature|thermal sensor|thermometer|thermistor|ntc)\b",),
         ("temperature sensors", "humidity sensors/temperature and humidity sensors", "temperature and humidity sensor", "ntc thermistors"),
         evidence=r"\b(temperature|thermistor|ntc)"),
    Role("rtc", "Real-Time Clock", (r"\b(rtc|real.?time clock)\b",), ("real-time clocks (rtc)", "real-time clocks(rtc)", "real-time clocks")),
    Role("crystal", "Crystal / Oscillator", (r"\b(crystal|oscillator|resonator|xtal)\b",),
         ("crystals", "crystal oscillators", "oscillators", "smd crystal resonators")),
    Role("eeprom", "EEPROM", (r"\beeprom\b",), ("eeprom",)),
    Role("sd_card", "SD Card Slot", (r"\b(micro.?sd|sd card|sd slot|tf card)\b",), ("sd card connectors", "sd card / memory card connector")),
    Role("flash_memory", "Flash Memory", (r"\b(flash|nor|nand)\b",), ("nor flash", "nand flash", "flash")),
    Role("boost", "Boost Converter", (r"\b(boost|step.?up)\b",), ("dc-dc converters",), evidence=r"\b(boost|step.?up)\b"),
    Role("buck", "Buck Converter", (r"\b(buck|step.?down|switching regulator|dc.?dc)\b",), ("dc-dc converters",),
         evidence=r"\b(buck|step.?down)\b"),
    Role("ldo", "Linear Regulator", (r"\b(ldo|linear regulator|low.?dropout|regulator)\b",),
         ("linear voltage regulators (ldo)", "voltage regulators - linear, low drop out (ldo) regulators", "dropout regulators(ldo)",
          "low dropout regulators(ldo)", "linear voltage regulators")),
    Role("button", "Push Button",
         (r"\b(button|push.?button|tactile|keypad|key switch|push switch)\b",),
         ("tactile switches", "push switches", "pushbutton switches", "pushbutton switch", "tact switch",
          "tact switchs,keypad switches", "push switches - horizontal type")),
    Role("buzzer", "Buzzer", (r"\b(buzzer|beeper|piezo)\b",), ("buzzers", "buzzer")),
    Role("speaker", "Speaker", (r"\b(speaker|loudspeaker)\b",), ("speakers",)),
    Role("relay", "Relay", (r"\brelays?\b",),
         ("power relays", "signal relays", "solid state relays (mos output)", "solid state relay (mos output)", "reed relays",
          "solid state relays - mos output (photomos)", "magnetic latching relays", "automotive relays"),
         reject=r"\b(socket|accessor)"),
    Role("secure_element", "Secure Element",
         (r"\b(secure element|crypto|encryption|authentication ic|security chip)\b",), ("security verification / encryption ics",)),
)
BY_KEY: Dict[str, Role] = {r.key: r for r in ROLES}

#: Functions that should not share one block silently.
_COMPOUND = ("cellular", "gnss", "wifi", "ble", "lora", "zigbee", "camera", "display")

#: Only consulted when no label pattern matches.
_CATEGORY_FALLBACK = {"processing": "mcu", "clock": "crystal", "security": "secure_element"}


@dataclass
class RoleMatch:
    key: Optional[str]
    via: str = "none"                       # label | edge | category | none
    secondary: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    @property
    def role(self) -> Optional[Role]:
        return BY_KEY.get(self.key) if self.key else None


def normalize(label: Any) -> str:
    # Split camelCase model labels ("SoilMoistureSensor") but not brand
    # spellings ("LoRa", "WiFi"): a split needs two lowercase letters before it.
    text = re.sub(r"(?<=[a-z]{2})(?=[A-Z][a-z])", " ", str(label or "")).lower()
    # "User Interface Display" is a display, not interface electronics.
    text = text.replace("user interface", " ")
    return re.sub(r"[_\s]+", " ", text).strip()


def _matches(role: Role, text: str) -> bool:
    if role.unless and re.search(role.unless, text):
        return False
    return any(re.search(p, text) for p in role.patterns)


def _edge_interfaces(connections: Optional[Iterable[dict]]) -> set:
    return {str(c.get("interface") or "").lower() for c in connections or [] if isinstance(c, dict)}


def infer_role(label: Any, category: Any = "", connections: Optional[Iterable[dict]] = None) -> RoleMatch:
    """The role a block must be filled by, or RoleMatch(None) when unknown."""
    text = normalize(label)
    edges = _edge_interfaces(connections)
    hits = [r.key for r in ROLES if _matches(r, text)]
    if hits:
        first = hits[0]
        if first == "mcu" and ({"wifi", "ble"} & set(hits) or {"wifi", "ble"} & edges):
            return RoleMatch("mcu_wireless", "label")
        match = RoleMatch(first, "label")
        # Two different radios/functions named in one block ("GSM/GPS Module").
        if first in _COMPOUND:
            match.secondary = [h for h in hits[1:] if h in _COMPOUND and {first, h} != {"wifi", "ble"}]
            if match.secondary:
                match.notes.append(f"The block name covers more than one function; only {BY_KEY[first].name} was selected "
                                   f"(also named: {', '.join(BY_KEY[h].name for h in match.secondary)}).")
        return match

    # Vague labels: let the block's edges decide.
    if re.search(r"\busb\b", text):
        return RoleMatch("usb_uart_bridge" if "uart" in edges else "usb_connector", "edge",
                         notes=["USB block type assumed from its connections."])
    if re.search(r"\b(wireless|radio|rf module|connectivity)\b", text):
        for iface, role in (("wifi", "wifi"), ("ble", "ble")):
            if iface in edges:
                return RoleMatch(role, "edge", notes=[f"Wireless block assumed to be {BY_KEY[role].name} from its connections."])
        return RoleMatch(None, "none", notes=["Wireless block does not name its radio (Wi-Fi, BLE, LoRa, cellular)."])
    cat = str(category or "").strip().lower()
    if re.search(r"\b(storage|memory|data ?logg)", text) or cat in ("storage", "memory"):
        if "sdio" in edges:
            role = "sd_card"
        elif "spi" in edges:
            role = "flash_memory"
        elif "i2c" in edges:
            role = "eeprom"
        else:
            role = "flash_memory"
        return RoleMatch(role, "edge", notes=[f"Storage type assumed to be {BY_KEY[role].name} from its connections."])
    if cat in _CATEGORY_FALLBACK:
        return RoleMatch(_CATEGORY_FALLBACK[cat], "category")
    return RoleMatch(None, "none")


def candidate_text(candidate: Dict[str, Any]) -> str:
    """Description, subcategory, part number and attributes -- deliberately
    NOT the top-level category column, which is too coarse to disqualify."""
    parts = [str(candidate.get(f) or "") for f in ("description", "title", "subcategory", "mfr_part")]
    extra = candidate.get("extra_params")
    attributes = extra.get("attributes") if isinstance(extra, dict) else None
    if isinstance(attributes, dict):
        parts += [f"{k} {v}" for k, v in attributes.items() if v not in (None, "", "-")]
    return " ".join(parts).lower()


def verdict(candidate: Dict[str, Any], role_key: Optional[str]) -> Tuple[str, str]:
    """(pass|unknown|fail, reason) for `candidate` filling `role_key`."""
    role = BY_KEY.get(role_key or "")
    if role is None:
        return UNKNOWN, "role not recognised"
    part = candidate.get("mfr_part") or "part"
    if role.source != "catalogue":
        return FAIL, f"{role.name} needs an explicit selection; a catalogue lookalike ({part}) cannot stand in for it"
    text = candidate_text(candidate)
    subcategory = str(candidate.get("subcategory") or "").strip()
    if subcategory and subcategory.lower() not in ("nan", "none", "unknown"):
        if key(subcategory) not in role.allowed:
            return FAIL, f"{part} is in '{subcategory}', not a {role.name}"
    elif not any(s.lower() in text for s in role.subcategories):
        # Saved BOM rows may carry only a description; without a subcategory
        # there is no positive proof either way.
        return UNKNOWN, f"{part}: catalogue subcategory unknown, function not verified as {role.name}"
    if role.reject and re.search(role.reject, text):
        return FAIL, f"{part} matches '{re.search(role.reject, text).group(0)}', which is not a {role.name}"
    # The allowlisted subcategory is an admission hint, not independent proof:
    # this catalogue has a level shifter misfiled under ADCs. Evidence must
    # come from the device description/attributes itself.
    proof = " ".join(str(candidate.get(f) or "") for f in ("description", "title", "mfr_part"))
    extra = candidate.get("extra_params")
    attrs = extra.get("attributes") if isinstance(extra, dict) else None
    if isinstance(attrs, dict):
        proof += " " + " ".join(f"{k} {v}" for k, v in attrs.items() if v not in (None, "", "-"))
    if role.evidence and not re.search(role.evidence, proof.lower()):
        return UNKNOWN, f"{part}: catalogue data does not confirm it is a {role.name}"
    return PASS, ""


def verify(index_counts: Dict[str, int]) -> List[dict]:
    """Check every role allowlist against the current catalogue labels.
    Same contract as curated_taxonomy.verify: findings, never an exception."""
    counts: Dict[str, int] = {}
    for label, n in index_counts.items():
        counts[key(label)] = counts.get(key(label), 0) + int(n)
    findings: List[dict] = []
    for role in ROLES:
        if role.source != "catalogue":
            continue
        missing = [s for s in role.subcategories if key(s) not in counts]
        rows = sum(counts.get(k, 0) for k in role.allowed)
        if rows == 0:
            findings.append({"severity": "error", "role": role.key, "kind": "role_vanished",
                             "message": f"role '{role.key}': none of its subcategories exist in the catalogue any more; it will always be NO_MATCH."})
        elif rows < THIN_ROLE_ROWS:
            findings.append({"severity": "warning", "role": role.key, "kind": "role_thin",
                             "message": f"role '{role.key}': only {rows} catalogue rows; expect NO_MATCH often."})
        if missing and rows:
            findings.append({"severity": "warning", "role": role.key, "kind": "labels_missing",
                             "message": f"role '{role.key}': {len(missing)} subcategories no longer exist ({', '.join(missing[:4])})."})
    return findings


def missing_profile_reason(role: Role) -> str:
    return (f"{role.name}: no orderable part exists in the component catalogue and no documented module profile is defined. "
            "Specify the module to use, or add a profile (external_devices.PROFILES with a PATTERNS entry and a PCB header).")


def selection_reason(role: Role) -> str:
    """Explain the missing specification instead of offering a plausible chip."""
    if role.key == "unspecified_power":
        return ("Power Management IC does not specify a function. State the input/output voltages, "
                "load current, and whether this is a regulator, charger, or protection circuit.")
    if role.key == "unspecified_connector":
        return ("Analog Sensor Connector needs pin count, pitch, mating connector, and signal/rail pinout. "
                "If the external sensor profiles already provide headers, remove this duplicate block.")
    return ("Signal Conditioning needs its actual function (for example ADC, amplifier, or filter), "
            "channel count, input range, and output interface before choosing a part.")


def adc_capability(candidate: Dict[str, Any], request: Dict[str, Any]) -> Tuple[str, str]:
    """Verify channel count and controller bus for an ADC, when specified."""
    extra = candidate.get("extra_params")
    attrs = extra.get("attributes") if isinstance(extra, dict) else None
    attrs = {str(k).casefold(): str(v) for k, v in attrs.items()} if isinstance(attrs, dict) else {}
    part = candidate.get("mfr_part") or "ADC"
    requested_buses = {str(i).casefold() for i in request.get("interfaces", [])} & {"i2c", "spi"}
    stated_bus = attrs.get("interface", "").casefold()
    if requested_buses and stated_bus and not any(bus in stated_bus for bus in requested_buses):
        return FAIL, f"{part} uses {stated_bus}, but the architecture connects the ADC over {', '.join(sorted(requested_buses)).upper()}"
    required = int(request.get("adc_channels") or 0)
    if required:
        stated = attrs.get("number of channels", "")
        match = re.search(r"(\d+)", stated)
        if not match:
            match = re.search(r"\b(\d+)\s*(?:channel|ch)\b", str(candidate.get("description") or ""), re.I)
        if not match:
            return UNKNOWN, f"{part}: catalogue does not state ADC channel count; this design needs {required}"
        count = int(match.group(1))
        if count < required:
            return FAIL, f"{part} has {count} ADC channel(s); this design needs {required}"
    if requested_buses and not stated_bus and not any(bus in str(candidate.get("description") or "").casefold() for bus in requested_buses):
        return UNKNOWN, f"{part}: catalogue does not confirm the ADC bus is {', '.join(sorted(requested_buses)).upper()}"
    return PASS, ""
