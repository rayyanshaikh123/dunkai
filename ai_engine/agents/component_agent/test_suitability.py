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

    def test_genuine_temperature_sensor_beats_the_wrong_role_and_external_interface_is_explicit(self):
        with patch("catalogue.verdict", return_value=(None, None)):
            ranked = ranking.ComponentRanker().rank_all([{
                "request": {"reference": "U1", "subsystem": "Temperature Sensor"},
                "candidates": [part("TTP223-TD", "Capacitive touch sensor"), part("MCP9808T-E/MC", "Temperature sensor", 0.6)],
            }])
        self.assertEqual(BOMGenerator().generate(ranked)[0]["mfr_part"], "MCP9808T-E/MC")
        self.assertIsNone(suitability.mismatch(part("ADC", "Analog to digital converter"), {"subsystem": "External pH probe ADC interface"}))


if __name__ == "__main__": unittest.main()
