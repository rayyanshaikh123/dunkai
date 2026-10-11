import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import suitability
import ranking
from bom import BOMGenerator


def part(name, description, similarity=0.9):
    return {"mfr_part": name, "description": description, "similarity_score": similarity, "stock": 50000, "price_qty_1": 0.1}


class SuitabilityTests(unittest.TestCase):
    def test_wrong_functions_cannot_win_on_stock_or_embedding_scores(self):
        cases = [
            ("TDS Sensor", "TTP223-TD", "Capacitive touch sensor"),
            ("pH Sensor", "MCP9808T-E/MC", "Temperature sensor"),
            ("Flow Sensor", "LDC1314RGHR", "Inductance to digital converter"),
            ("Battery", "HY2111-GB", "Battery protection controller"),
            ("Solar Panel", "CAP200DG-TL", "Solar panel power switch controller"),
            ("LCD Display", "CD4543BM", "LCD display driver"),
            ("LED Indicator", "MBI5124GP-B", "LED driver"),
        ]
        results = ranking.ComponentRanker().rank_all([
            {"request": {"reference": f"U{i}", "subsystem": label}, "candidates": [part(name, text)]}
            for i, (label, name, text) in enumerate(cases, 1)
        ])
        rows = BOMGenerator().generate(results)
        self.assertTrue(all(row["status"] == "NO_MATCH" and row["mfr_part"] is None for row in rows))
        self.assertTrue(all("required function" in row["status_reason"] for row in rows))

    def test_wrong_parts_from_a_real_bom_are_rejected(self):
        # Catalogue text of parts a design actually received for these roles.
        cases = [
            ("GPS Receiver", "AR1100-I/SS", "4、5or8wire resistive type uart ssop-20-208mil touch screen controllers touch sensors"),
            ("Camera Sensor", "LDC1314RGHR", "i2c inductance-to-digital converter specialized sensors"),
            ("Motor Driver", "EMC2103-2-AP-TR", "i2c qfn-16-ep(4x4) brushed dc motor drivers microcontroller units (mcus/mpus/socs)"),
            ("Soil Moisture Sensor", "ENS210-LQFM", "0%rh~100%rh temperature and humidity sensor humidity sensors/temperature and humidity sensors"),
            ("Proximity Sensor", "SD3312A", "sot-23-6 touch sensors"),
            ("User Interface Display", "MS9122", "i2c、spi、i2s qfn-48-ep(7x7) video interface ics interface"),
            # Nothing in the catalogue is a usable camera; it is an external module.
            ("Camera Sensor", "MLX90640ESF-BAB-000-TU", "32hx24v to-39-4 image sensors sensors"),
        ]
        for label, name, text in cases:
            with self.subTest(label=label):
                self.assertIsNotNone(suitability.mismatch(part(name, text), {"subsystem": label}))

    def test_genuine_parts_for_the_new_roles_still_pass(self):
        cases = [
            ("GPS Receiver", "TESEO-LIV3R", "smd-18p gnss modules iot/communication modules"),
            ("Motor Driver", "DRV8833PWPR", "dual h-bridge brushed dc motor drivers motor driver ics"),
            ("Proximity Sensor", "FDC2214QRGHRQ1", "capacitive sensor ic proximity sensors sensors"),
            ("User Interface Display", "HS96L03W2C03", "128x64 i2c passive (pmoled) ssd1315 chip white - oled display oled displays modules nixie tube driver/led driver"),
            ("Display", "HS280S010B", "2.8 320x240 spi st7789v - lcd screen lcd displays modules"),
        ]
        for label, name, text in cases:
            with self.subTest(label=label):
                self.assertIsNone(suitability.mismatch(part(name, text), {"subsystem": label}))

    def test_retrieval_looks_past_a_wrong_category_for_proven_parts(self):
        import retrieval
        retriever = retrieval.ComponentRetriever.__new__(retrieval.ComponentRetriever)
        retriever._last_resolution = None
        mcu = part("EMC2103-2-AP-TR", "brushed dc motor drivers microcontroller units (mcus/mpus/socs)")
        driver = part("DRV8870DDAR", "brushed dc motor drivers motor driver ics")
        request = {"subsystem": "Motor Driver", "category": "Processing"}
        # In the first search results, outside the category filter.
        self.assertEqual(retriever._function_override([mcu, driver], [mcu], request), [driver])
        # Only reachable by searching on the subsystem without the category's taxonomy hint.
        retriever._embed_query = lambda query: query
        retriever._search_index = lambda embedding: ([0.9], [0])
        retriever._get_candidates = lambda indices, distances: [driver]
        self.assertEqual(retriever._function_override([mcu], [mcu], request), [driver])
        # A category that already holds a proven part is left alone.
        self.assertEqual(retriever._function_override([mcu, driver], [driver, mcu], request), [driver, mcu])

    def test_genuine_temperature_sensor_beats_the_wrong_role_and_external_interface_is_explicit(self):
        with patch("catalogue.verdict", return_value=(None, None)):
            ranked = ranking.ComponentRanker().rank_all([{
                "request": {"reference": "U1", "subsystem": "Temperature Sensor"},
                "candidates": [part("TTP223-TD", "Capacitive touch sensor"), part("MCP9808T-E/MC", "Temperature sensor", 0.6)],
            }])
        self.assertEqual(BOMGenerator().generate(ranked)[0]["mfr_part"], "MCP9808T-E/MC")
        self.assertIsNone(suitability.mismatch(part("ADC", "Analog to digital converter"), {"subsystem": "External pH probe ADC interface"}))


class RoleSelectionTests(unittest.TestCase):
    """Ranking and BOM behaviour once a block has a role (roles.py)."""

    @staticmethod
    def bom(*results):
        with patch("catalogue.verdict", return_value=(None, None)):
            return BOMGenerator().generate(ranking.ComponentRanker().rank_all(list(results)))

    @staticmethod
    def typed(name, subcategory, description, similarity=0.9, **attributes):
        return {**part(name, description, similarity), "subcategory": subcategory, "extra_params": {"attributes": attributes}}

    def test_verified_part_beats_a_better_scored_unverified_one(self):
        switch = self.typed("TP3USB31Q10", "USB Converters", "480mbps usb 2.0 usb converters", similarity=0.99)
        bridge = self.typed("CH340C", "USB Converters", "transceiver usb 2.0 sop-16 usb converters", similarity=0.4)
        row = self.bom({"request": {"reference": "U1", "subsystem": "USB Interface", "role": "usb_uart_bridge"},
                        "candidates": [switch, bridge]})[0]
        self.assertEqual(row["mfr_part"], "CH340C")
        # Role-verified: a low raw similarity no longer makes it LOW_CONFIDENCE.
        self.assertEqual(row["status"], "OK")
        self.assertEqual(row["candidate_subcategory"], "USB Converters")

    def test_unverified_pick_is_flagged_with_the_specific_reason(self):
        switch = self.typed("TP3USB31Q10", "USB Converters", "480mbps usb 2.0 usb converters")
        row = self.bom({"request": {"reference": "U1", "subsystem": "USB Interface", "role": "usb_uart_bridge"},
                        "candidates": [switch]})[0]
        self.assertEqual(row["status"], "LOW_CONFIDENCE")
        self.assertIn("does not confirm", row["status_reason"])

    def test_unrecognised_block_type_is_flagged(self):
        row = self.bom({"request": {"reference": "U1", "subsystem": "Smart Widget", "role": None},
                        "candidates": [part("ANY", "something")]})[0]
        self.assertEqual(row["status"], "LOW_CONFIDENCE")
        self.assertIn("recognised part type", row["status_reason"])

    def test_role_notes_reach_the_bom(self):
        gnss = self.typed("ATGM336H-5N31", "GNSS Modules", "GPS/BDS GNSS module")
        row = self.bom({"request": {"reference": "U1", "subsystem": "GPS Receiver", "role": "gnss"}, "candidates": [gnss]})[0]
        self.assertEqual(row["status"], "OK")
        self.assertIn("antenna", row["selection_notes"])

    def test_undersized_mcu_is_rejected_with_its_numbers(self):
        import capacity
        demand = capacity.demand([{"interface": "UART", "role": "cellular"}, {"interface": "UART", "role": "gnss"},
                                  {"interface": "SPI", "role": "display"}, {"interface": "SPI", "role": "camera"}])
        stc = self.typed("STC15W408AS-35I-SOP16", "Microcontroller Units (MCUs/MPUs/SOCs)", "51 family 8kb flash sop-16",
                         **{"Program Storage Size": "8KB", "GPIO Ports Number": "14", "CPU Core": "51Series"})
        row = self.bom({"request": {"reference": "U1", "subsystem": "Microcontroller Unit", "role": "mcu", "capacity_demand": demand},
                        "candidates": [stc]})[0]
        self.assertEqual(row["status"], "NO_MATCH")
        self.assertIn("GPIO", row["status_reason"])

    def test_bom_uses_the_rankers_choice(self):
        first, second = part("FIRST", "a"), part("SECOND", "b")
        rows = BOMGenerator().generate([{"request": {"reference": "U1", "subsystem": "X", "role": None},
                                         "ranked_candidates": [first, second], "best_candidate": second}])
        self.assertEqual(rows[0]["mfr_part"], "SECOND")

    def test_external_role_is_never_filled_from_the_catalogue(self):
        import retrieval
        retriever = retrieval.ComponentRetriever.__new__(retrieval.ComponentRetriever)
        request = {"subsystem": "Camera Module", "role": "camera"}
        result = retriever.retrieve(request)
        self.assertEqual(result["candidates"], [])
        self.assertIn("no orderable part", request["match_issue"])


if __name__ == "__main__": unittest.main()
