"""Architecture vocabulary validation and the repair retry. No network.

    ai_engine/venv/bin/python ai_engine/agents/test_architecture_validation.py
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import architecture_agent as aa

SUBSYSTEMS = [{"label": "Microcontroller", "category": "Processing"}, {"label": "Real-Time Clock", "category": "Clock"}]


def graph_reply(interface):
    return json.dumps({
        "nodes": [{"id": "mcu", "label": "Microcontroller", "category": "Processing"},
                  {"id": "rtc", "label": "Real-Time Clock", "category": "Clock"}],
        "edges": [{"source": "rtc", "target": "mcu", "interface": interface}],
    })


def scripted(*replies):
    calls = []

    def call(prompt, content, *, model=None, **_):
        calls.append(content)
        return replies[len(calls) - 1]

    return call, calls


class ArchitectureValidationTests(unittest.TestCase):
    def test_spelling_variant_is_mapped_without_another_call(self):
        call, calls = scripted(graph_reply("SMBus"))
        with patch.object(aa, "_call_groq", call):
            graph = aa.build_graph(SUBSYSTEMS)
        self.assertEqual(graph["edges"][0]["data"]["interface"], "I2C")
        self.assertEqual(len(calls), 1)

    def test_unsupported_interface_is_repaired_by_the_model_not_fatal(self):
        # The run that failed: an RTC link labelled "Clock".
        call, calls = scripted(graph_reply("Clock"), graph_reply("I2C"))
        with patch.object(aa, "_call_groq", call):
            graph = aa.build_graph(SUBSYSTEMS)
        self.assertEqual(graph["edges"][0]["data"]["interface"], "I2C")
        self.assertEqual(len(calls), 2)
        self.assertIn("'Clock'", calls[1])
        self.assertIn("I2C", calls[1])

    def test_a_second_bad_reply_still_fails_loudly(self):
        call, _ = scripted(graph_reply("Clock"), graph_reply("Clock"))
        with patch.object(aa, "_call_groq", call), self.assertRaises(ValueError):
            aa.build_graph(SUBSYSTEMS)

    def test_subsystem_stage_is_repaired_too(self):
        bad = json.dumps({"subsystems": [{"label": "Widget", "category": "Gizmo"}]})
        good = json.dumps({"subsystems": [{"label": "Widget", "category": "Output"}]})
        call, calls = scripted(bad, good)
        with patch.object(aa, "_call_groq", call):
            subsystems = aa.infer_subsystems({"project": "x"})
        self.assertEqual(subsystems[0]["category"], "Output")
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
