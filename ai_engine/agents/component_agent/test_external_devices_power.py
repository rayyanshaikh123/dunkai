"""Power-path regression tests that need no LLM or catalogue dependencies."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from external_devices import add_interfaces, prepare_architecture, profile_row


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

    def test_documented_water_device_rows_carry_sourced_prices(self):
        request = {
            "reference": "U1", "node_id": "tds", "subsystem": "TDS Sensor",
            "category": "Sensor", "external_key": "tds", "device_profile": "tds",
        }
        row = profile_row(request, quantity=2)
        self.assertEqual(row["unit_price_usd"], 11.8)
        self.assertEqual(row["extended_price_usd"], 23.6)
        self.assertEqual(row["price_source_name"], "DFRobot")
        self.assertTrue(row["price_source_url"].startswith("https://"))
        self.assertEqual(row["price_checked_at"], "2026-10-11")

    def test_led_module_uses_manufacturer_price_snapshot(self):
        row = profile_row({
            "reference": "U1", "node_id": "led", "subsystem": "LED Indicator",
            "category": "Output", "external_key": "water_led", "device_profile": "water_led",
        })
        self.assertEqual(row["unit_price_usd"], 1.20)
        self.assertEqual(row["price_source_name"], "DFRobot")
        self.assertEqual(row["price_source_url"], "https://www.dfrobot.com/product-133.html")

    def test_flow_sensor_uses_manufacturer_price_snapshot(self):
        row = profile_row({
            "reference": "U1", "node_id": "flow", "subsystem": "Flow Sensor",
            "category": "Sensor", "external_key": "water_flow", "device_profile": "water_flow",
        })
        self.assertEqual(row["unit_price_usd"], 8.90)
        self.assertEqual(row["price_source_name"], "DFRobot")
        self.assertEqual(row["price_source_url"], "https://www.dfrobot.com/product-1531.html")

    def test_interface_rows_include_exact_priced_headers_and_divider_resistors(self):
        sensor = profile_row({
            "reference": "U1", "node_id": "turbidity", "subsystem": "Turbidity Sensor",
            "category": "Sensor", "external_key": "water_turbidity", "device_profile": "water_turbidity",
        })
        rows = add_interfaces([sensor])
        header = next(row for row in rows if row["reference"].startswith("J"))
        resistors = [row for row in rows if row["reference"].startswith("R")]
        self.assertEqual((header["lcsc"], header["unit_price_usd"], header["moq"]), ("C2937625", 0.019, 50))
        self.assertEqual(header["mfr_part"], "1x3 2.54mm through-hole header")
        self.assertEqual(header["package"], "HDR-3-P2.54")
        self.assertEqual(header["supplier_mfr_part"], "PZ254V-11-03P")
        self.assertEqual(len(resistors), 2)
        self.assertTrue(all(row["mfr_part"] == "10k 1% 0603 resistor" and row["supplier_mfr_part"] == "RC0603FR-0710KL" and row["package"] == "0603" and row["board_profile"] == "student-divider-10k" for row in resistors))
        self.assertTrue(all(row["lcsc"] == "C98220" and row["unit_price_usd"] == 0.0034 and row["moq"] == 100 for row in resistors))


if __name__ == "__main__":
    unittest.main()
