"""Power-path regression tests that need no LLM or catalogue dependencies."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from external_devices import add_interfaces, prepare_architecture


class ExternalDevicePowerPathTests(unittest.TestCase):
    def test_tds_keeps_vcc_and_analog_on_generic_no_battery_design(self):
        requirements = {"hardware_inputs": ["TDS Sensor"], "power_requirements": "USB 5V supply"}
        architecture = {
            "architecture_graph": {
                "nodes": [
                    {"id": "mcu", "data": {"label": "MCU", "category": "Processing"}},
                    {"id": "pmic", "data": {"label": "Power Management", "category": "Power"}},
                ],
                "edges": [{"source": "pmic", "target": "mcu", "data": {"interface": "Power"}}],
            },
            "architecture_model": {"processing_unit": "MCU"},
        }

        prepared = prepare_architecture(architecture, requirements)
        tds_id = next(device["node_id"] for device in prepared["required_devices"] if device["key"] == "tds")
        edges = prepared["architecture_graph"]["edges"]
        self.assertTrue(any(
            tds_id in (edge.get("source"), edge.get("target"))
            and (edge.get("data") or {}).get("interface") == "Power"
            for edge in edges
        ), "TDS VCC must join the controller's existing power rail")
        self.assertTrue(any(
            tds_id in (edge.get("source"), edge.get("target"))
            and (edge.get("data") or {}).get("interface") == "Analog"
            for edge in edges
        ), "TDS analog output must remain connected to the processor")
        self.assertEqual(prepare_architecture(prepared, requirements), prepared)

        rows = add_interfaces([{
            "reference": "X1", "node_id": tds_id, "subsystem": "TDS Sensor",
            "category": "Sensor", "external_key": "tds", "device_profile": "tds",
        }])
        self.assertEqual(rows[0]["pcb_references"], ["J1"])
        self.assertEqual(rows[1]["board_profile"], "student-sensor-3p")


if __name__ == "__main__":
    unittest.main()
