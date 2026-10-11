"""Role-based selection against the REAL catalogue (needs the cached dataset).

    ai_engine/venv/bin/python ai_engine/agents/component_agent/eval_roles.py [--live]

1. Role inference on the golden labels in test_roles.py.
2. For every catalogue role: real retrieval + ranking for a plain request must
   pick a part inside the role's allowlist that passes its verdict.
3. Replay of a real architecture that previously produced a touch controller
   as GPS, a fan controller as motor driver, an 8 KB 8051 as the MCU, etc.

--live keeps the JLCPCB stock check on (network); by default it is skipped.
Exit code 1 on any failure.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import roles  # noqa: E402
from test_roles import GOLDEN  # noqa: E402

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  -- ' + detail if detail else ''}")
    failures += not ok


#: The architecture behind the BOM that motivated roles.py (labels verbatim).
REPLAY_NODES = [
    ("mcu", "Microcontroller Unit", "Processing"), ("reg", "3.3V Logic Regulator", "Power"),
    ("motor", "Motor Driver", "Processing"), ("gps", "GPS Receiver", "Sensor"),
    ("cam", "Camera Sensor", "Sensor"), ("soil", "Soil Moisture Sensor", "Sensor"),
    ("temp", "Temperature Sensor", "Sensor"), ("prox", "Proximity Sensor", "Sensor"),
    ("gsm", "Wireless Communication Module (e.g., LTE/5G)", "Communication"),
    ("flash", "Local Storage (e.g., Flash)", "Storage"), ("rtc", "Real-Time Clock", "Clock"),
    ("usb", "USB Interface", "Communication"), ("disp", "User Interface Display", "Output"),
    ("btn", "Button Array", "Input"),
]
REPLAY_EDGES = [
    ("reg", "mcu", "Power"), ("motor", "mcu", "PWM"), ("gps", "mcu", "UART"), ("cam", "mcu", "SPI"),
    ("soil", "mcu", "Analog"), ("temp", "mcu", "I2C"), ("prox", "mcu", "I2C"), ("gsm", "mcu", "UART"),
    ("flash", "mcu", "SPI"), ("rtc", "mcu", "I2C"), ("usb", "mcu", "USB"), ("disp", "mcu", "SPI"),
    ("btn", "mcu", "GPIO"),
]
#: Parts that must never be chosen again for these blocks.
HISTORICAL_WRONG = {"AR1100-I/SS", "LDC1314RGHR", "EMC2103-2-AP-TR", "ENS210-LQFM", "SD3312A", "MS9122",
                    "TP3USB31Q10", "STC15W408AS-35I-SOP16"}


def main(live: bool) -> int:
    print("== 1. role inference")
    for label, category, connections, expected in GOLDEN:
        got = roles.infer_role(label, category, connections).key
        if got != expected:
            check(f"infer {label!r}", False, f"got {got}, expected {expected}")
    check(f"{len(GOLDEN)} golden labels", not failures)

    import parser as arch_parser
    import ranking
    import retrieval
    from bom import BOMGenerator
    import external_devices

    retriever = retrieval.ComponentRetriever()
    ranker = ranking.ComponentRanker()
    stock_check = patch("catalogue.verdict", return_value=(None, None)) if not live else patch.object(sys, "argv", sys.argv)

    print("\n== 2. every catalogue role picks a part of that role")
    with stock_check:
        for role in roles.ROLES:
            if role.source != "catalogue" or role.key == "mcu_wireless":
                continue
            request = {"reference": "U1", "subsystem": role.name, "role": role.key, "interfaces": [], "connections": []}
            ranked = ranker.rank_all([retriever.retrieve(request)])[0]
            best = ranked["best_candidate"]
            if best is None:
                check(f"{role.key}", False, request.get("match_issue", "no candidate"))
                continue
            verdict, why = roles.verdict(best, role.key)
            check(f"{role.key:18} -> {best.get('mfr_part')} ({best.get('subcategory')})",
                  verdict != roles.FAIL and roles.key(best.get("subcategory")) in role.allowed, why)

        print("\n== 3. replay of the architecture that produced wrong parts")
        architecture = {"architecture_graph": {
            "nodes": [{"id": i, "data": {"label": l, "category": c}} for i, l, c in REPLAY_NODES],
            "edges": [{"source": s, "target": t, "data": {"interface": f}} for s, t, f in REPLAY_EDGES]}}
        architecture = external_devices.prepare_architecture(architecture, {"hardware_inputs": ["Soil Moisture Sensor"]})
        requests = arch_parser.ArchitectureParser().parse(architecture)
        catalogue_requests = [r for r in requests if not r.get("external_key")]
        rows = BOMGenerator().generate(ranker.rank_all(retriever.retrieve_all(catalogue_requests)))
        by_ref = {r["reference"]: r for r in rows}
        for request in requests:
            if request.get("external_key"):
                row = external_devices.profile_row(request)
            else:
                row = by_ref[request["reference"]]
            print(f"      {request['subsystem'][:40]:40} role={str(request.get('role')):16} -> "
                  f"{str(row.get('mfr_part')):24} {row['status']:18} {str(row.get('status_reason') or '')[:90]}")
            check(f"replay {request['subsystem']!r} avoids historical wrong parts", row.get("mfr_part") not in HISTORICAL_WRONG)
        soil = next(r for r in requests if r["subsystem"] == "Soil Moisture Sensor")
        check("soil moisture uses the documented module", soil.get("device_profile") == "soil_moisture")
        camera = next(r for r in rows if r["subsystem"] == "Camera Sensor")
        check("camera stops with a clear message", camera["status"] == "NO_MATCH" and "no orderable part" in camera["status_reason"])
        mcu = next(r for r in rows if r["subsystem"] == "Microcontroller Unit")
        check("MCU is not the undersized 8051", mcu.get("mfr_part") != "STC15W408AS-35I-SOP16")

    print(f"\n{failures} FAILED" if failures else "\nall checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main("--live" in sys.argv))
