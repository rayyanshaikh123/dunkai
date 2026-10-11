"""Is the microcontroller big enough for the design around it?

The architecture only says which blocks talk to the MCU and over what. From
that we estimate a demand (GPIO pins, program flash, native USB, ADC) and check
it against what the catalogue states about each MCU candidate:

* fail     -- the catalogue states a value below the demand (an 8 KB, 14-I/O
              8051 for GSM + GPS + camera + display);
* unknown  -- the catalogue does not state it (about half of MCU rows); the
              part is kept, ranked below verified ones, and flagged;
* pass.

The estimates are deliberately coarse lower bounds, not a pin plan: the PCB
stage still assigns real pins. UART instance counts are not in the catalogue
at all, so two or more UART links are always reported as a note to check.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any, Dict, List, Optional, Tuple

PASS, UNKNOWN, FAIL = "pass", "unknown", "fail"

#: Pins per link, by architecture interface (architecture_agent.ALLOWED_INTERFACES).
#: Shared buses are counted once; see demand().
_PINS_PER_LINK = {"uart": 2, "gpio": 1, "pwm": 1, "onewire": 1, "analog": 1, "adc": 1, "usb": 2, "can": 2,
                  "i2s": 3, "sdio": 6, "audio": 1, "ethernet": 4, "wifi": 2, "ble": 2, "rf": 2, "pcie": 0}
#: Extra control lines a neighbour of this role needs beyond its bus.
_ROLE_PINS = {"display": 2, "cellular": 2, "gnss": 1, "camera": 2, "motor_driver": 1}
#: Program flash (KB) a firmware stack for this neighbour roughly adds.
_ROLE_FLASH_KB = {"cellular": 32, "gnss": 8, "display": 32, "camera": 64, "sd_card": 32, "wifi": 16, "ble": 16,
                  "ethernet": 32, "lora": 16}
BASE_FLASH_KB = 8
#: Headroom on the pin estimate. Reset, boot and crystal pins are dedicated on
#: most MCUs, so they are not added on top.
PIN_MARGIN = 1.15


def demand(connections: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Estimate what the MCU needs from its architecture connections.
    Each connection: {"interface", "role" (neighbour's), "subsystem"}."""
    links = Counter()
    spi_devices = 0
    flash = BASE_FLASH_KB
    pins = 0
    basis: List[str] = []
    needs_usb = needs_adc = False
    for c in connections or []:
        iface = str(c.get("interface") or "").strip().lower()
        role = c.get("role")
        if not iface or iface == "power":
            continue
        links[iface] += 1
        if iface == "spi":
            spi_devices += 1
        elif iface != "i2c":
            pins += _PINS_PER_LINK.get(iface, 1)
        pins += _ROLE_PINS.get(role, 0)
        flash += _ROLE_FLASH_KB.get(role, 0)
        if iface == "usb" and role not in ("usb_uart_bridge",):
            needs_usb = True
        if iface in ("analog", "adc"):
            needs_adc = True
    if links["i2c"]:
        pins += 2
    if spi_devices:
        pins += 3 + spi_devices
    if needs_usb:
        flash += 16
    gpio = math.ceil(pins * PIN_MARGIN)
    flash_kb = 8 * math.ceil(flash / 8)
    basis.append(", ".join(f"{n}x {i.upper()}" for i, n in sorted(links.items())) or "no data links")
    return {"gpio": gpio, "flash_kb": flash_kb, "needs_usb": needs_usb, "needs_adc": needs_adc,
            "uart_links": links["uart"], "basis": basis}


def _attributes(candidate: Dict[str, Any]) -> Dict[str, Any]:
    extra = candidate.get("extra_params")
    attributes = extra.get("attributes") if isinstance(extra, dict) else None
    return attributes if isinstance(attributes, dict) else {}


def _kb(text: str) -> Optional[float]:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(kb|kbyte|k|mb|mbyte|m)\b", text.lower())
    if not m:
        return None
    value = float(m.group(1))
    return value * 1024 if m.group(2).startswith("m") else value


def flash_kb(candidate: Dict[str, Any]) -> Optional[float]:
    stated = _attributes(candidate).get("Program Storage Size")
    if stated not in (None, "", "-"):
        return _kb(str(stated))
    m = re.search(r"(\d+(?:\.\d+)?\s*(?:kb|mb))\s*(?:\(?\w+\)?\s*)?flash", str(candidate.get("description") or "").lower())
    return _kb(m.group(1)) if m else None


def gpio_count(candidate: Dict[str, Any]) -> Optional[int]:
    stated = str(_attributes(candidate).get("GPIO Ports Number") or "").strip()
    return int(stated) if stated.isdigit() else None


def _flag(candidate: Dict[str, Any], name: str) -> Optional[bool]:
    stated = str(_attributes(candidate).get(name) or "").strip().lower()
    if not stated:
        return None
    return stated not in ("-", "no", "none", "0")


def check(candidate: Dict[str, Any], need: Optional[Dict[str, Any]]) -> Tuple[str, str, List[str]]:
    """(pass|unknown|fail, reason, notes) for an MCU candidate against demand()."""
    if not need:
        return PASS, "", []
    part = candidate.get("mfr_part") or "MCU"
    notes = []
    if need.get("uart_links", 0) >= 2:
        notes.append(f"Design needs {need['uart_links']} UART links; the catalogue does not list UART counts, so confirm {part} has enough.")
    gpio, flash = gpio_count(candidate), flash_kb(candidate)
    if gpio is not None and gpio < need["gpio"]:
        return FAIL, f"{part} has {gpio} GPIO; this design needs about {need['gpio']} ({need['basis'][0]})", notes
    if flash is not None and flash < need["flash_kb"]:
        return FAIL, f"{part} has {flash:g} KB flash; this design needs about {need['flash_kb']} KB", notes
    if need.get("needs_usb") and _flag(candidate, "Universal Serial Bus") is False:
        return FAIL, f"{part} has no native USB, which this design's USB connection needs", notes
    if need.get("needs_adc") and _flag(candidate, "ADC (Bit)") is False:
        return FAIL, f"{part} has no ADC, which this design's analog inputs need", notes
    missing = [n for n, v in (("GPIO count", gpio), ("flash size", flash)) if v is None]
    if missing:
        return UNKNOWN, f"{part}: catalogue does not state its {' or '.join(missing)}; capacity not verified", notes
    return PASS, "", notes
