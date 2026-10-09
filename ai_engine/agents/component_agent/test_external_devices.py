"""Required-device preservation and real PCB handoff, without API calls."""
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from external_devices import PROFILES, prepare_architecture, coverage_issues
from parser import ArchitectureParser
from eda import DynamicPCBIRGenerator
# BOM tests exercise actual allocation/export without downloading a catalogue.
with patch.dict(sys.modules, {"config": SimpleNamespace(DEFAULT_QTY=1, SIMILARITY_THRESHOLD=0.7)}):
    from bom import BOMGenerator
from ai_engine.agents.supervisor import nodes

REQUIREMENTS = {"hardware_inputs": ["TDS Sensor", "pH Sensor"], "power_requirements": "['Battery', 'Solar Panel']"}
ARCHITECTURE = {"architecture_graph": {"nodes": [
    {"id": "mcu", "data": {"label": "MCU", "category": "Processing"}},
    {"id": "pmic", "data": {"label": "Power Management", "category": "Power"}},
], "edges": [{"source": "pmic", "target": "mcu", "data": {"interface": "Power"}}]},
    "architecture_model": {"processing_unit": "MCU"}}


class Retriever:
    def retrieve_all(self, requests):
        self.requests = requests
        return [{"request": r, "ranked_candidates": [{"mfr_part": "TEST_MCU", "manufacturer": "test fixture",
                  "package": "SOIC-8", "stock": 100, "unit_price": 1, "similarity_score": 1}]} for r in requests]


def component_output(requirements=None, architecture=None):
    retriever = Retriever()
    modules = {"config": SimpleNamespace(DEFAULT_QTY=1), "parser": ArchitectureParser(), "retriever": retriever,
               "ranker": SimpleNamespace(rank_all=lambda results: results), "bom_generator": BOMGenerator()}
    with patch.object(nodes, "_component_agent_modules", return_value=modules), patch.object(nodes, "_append_shortlist_log", return_value=0):
        result = nodes.component_node({"requirements": requirements or REQUIREMENTS, "architecture": architecture or ARCHITECTURE})
    if result.get("bom_csv_path"): Path(result["bom_csv_path"]).unlink(missing_ok=True)
    return result, retriever


class ExternalDeviceTests(unittest.TestCase):
    def test_omitted_model_subsystems_are_restored_and_defaults_are_idempotent(self):
        architecture = prepare_architecture(ARCHITECTURE, REQUIREMENTS)
        self.assertEqual(prepare_architecture(architecture, REQUIREMENTS), architecture)
        self.assertEqual({d["key"] for d in architecture["required_devices"]}, {"tds", "ph", "battery", "solar"})
        self.assertTrue({"mcu", "pmic"}.issubset({n["id"] for n in architecture["architecture_graph"]["nodes"]}))
        self.assertGreater(len(architecture["assumptions"]), 0)
        self.assertNotIn("required_devices", ARCHITECTURE)  # input not mutated

    def test_all_four_physical_devices_and_charging_hardware_remain_in_system_bom(self):
        output, retriever = component_output()
        self.assertNotIn("errors", output)
        rows = output["bom"]["rows"]
        by_key = {r["external_key"]: r for r in rows if r.get("external_key")}
        for key in ("tds", "ph", "battery", "solar"):
            self.assertEqual(by_key[key]["mfr_part"], PROFILES[key]["mfr_part"])
            self.assertTrue(by_key[key]["external"])
            self.assertTrue(by_key[key]["pcb_references"])
            self.assertNotEqual(by_key[key]["status"], "NO_MATCH")
        self.assertEqual(coverage_issues(output["architecture"], rows), [])
        self.assertEqual([r["subsystem"] for r in retriever.requests], ["MCU"])
        self.assertEqual(by_key["battery"]["via_reference"], by_key["solar_manager"]["reference"])
        self.assertFalse(output["bom"]["summary"]["cost_complete"])

    def test_pcb_contains_sensor_ports_and_separate_regulator_rails_not_device_bodies(self):
        state, _ = component_output()
        pcb = nodes.pcb_node(state)
        self.assertNotIn("errors", pcb)
        ir = pcb["pcb_ir"]
        self.assertEqual({r["external_key"] for r in ir["external_components"]}, {"tds", "ph", "battery", "solar", "solar_manager"})
        self.assertFalse({"SEN0244", "SEN0161-V2", "353", "FIT0601", "DFR0559"}.intersection(c["part_number"] for c in ir["components"]))
        ports = [c for c in ir["components"] if c.get("board_profile") == "student-sensor-3p"]
        self.assertEqual(len(ports), 2)
        analog = [n for n in ir["nets"] if n["interface"] == "Analog"]
        self.assertEqual(len(analog), 2)
        self.assertNotEqual(analog[0]["name"], analog[1]["name"])
        regulator = next(c for c in ir["components"] if c.get("board_profile") == "tlv75533-dbv")
        logic = next(n for n in ir["nets"] if n["name"] == "LOGIC_3V3")
        power_in = next(n for n in ir["nets"] if n["name"] == "REGULATED_5V_IN")
        self.assertEqual([m["pin_function"] for m in logic["members"] if m["ref_id"] == regulator["ref_id"]], ["OUT"])
        self.assertEqual([m["pin_function"] for m in power_in["members"] if m["ref_id"] == regulator["ref_id"]], ["IN", "EN"])
        self.assertTrue(nodes._validate_handoff(state, ir)["well_formed"])

    def test_missing_device_connector_or_charger_stops_the_handoff(self):
        output, _ = component_output()
        rows = output["bom"]["rows"]
        for predicate in (lambda r: r.get("external_key") == "battery",
                          lambda r: r.get("external_key") == "solar_manager",
                          lambda r: r.get("board_profile") == "student-sensor-3p"):
            modified = copy.deepcopy(output)
            modified["bom"]["rows"] = [r for r in rows if not predicate(r)]
            self.assertIn("errors", nodes.pcb_node(modified))

    def test_custom_power_or_specific_part_is_never_silently_replaced(self):
        requirements = {**REQUIREMENTS, "power_requirements": "12V lead-acid battery and 18V solar panel"}
        output, _ = component_output(requirements)
        pending = [r for r in output["bom"]["rows"] if r.get("external_key") in ("battery", "solar")]
        self.assertTrue(all(r["status"] == "SELECTION_REQUIRED" for r in pending))
        self.assertIn("errors", nodes.pcb_node(output))
        output, _ = component_output({**REQUIREMENTS, "external_device_choices": {"ph": "MY_CUSTOM_PH"}})
        self.assertEqual(next(r for r in output["bom"]["rows"] if r.get("external_key") == "ph")["mfr_part"], "MY_CUSTOM_PH")
        self.assertIn("errors", nodes.pcb_node(output))

    def test_handoff_preserves_bom_identity_and_rejects_unfilled_rows(self):
        generator = DynamicPCBIRGenerator()
        with patch.object(generator, "fetch_easyeda_metadata", side_effect=AssertionError("fuzzy identity lookup is forbidden")):
            self.assertEqual(generator.parse_bom_rows([{"reference": "U1", "mfr_part": "THE_SELECTED_PART", "package": "SOIC-8"}])[0]["part_number"], "THE_SELECTED_PART")
        with self.assertRaisesRegex(ValueError, "cannot be omitted"):
            generator.parse_bom_rows([{"reference": "U1", "mfr_part": None}])
        with tempfile.TemporaryDirectory() as directory:
            csv = Path(directory) / "bom.csv"
            csv.write_text("reference,mfr_part,package\nU1,,SOIC-8\n")
            with self.assertRaisesRegex(ValueError, "cannot be omitted"):
                generator.parse_bom_csv(str(csv))


if __name__ == "__main__": unittest.main()
