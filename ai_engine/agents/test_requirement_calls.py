"""Offline checks for the requirements interview call budget."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import requirement_agent as agent  # noqa: E402


DETAILED_BRIEF = (
    "Build an outdoor temperature monitor with a sensor input and LED output. "
    "It runs from a rechargeable battery, sends readings over WiFi every minute, "
    "and must fit in a small weatherproof enclosure for a garden installation."
)


class FakeChain:
    def __init__(self, reply):
        self.reply = reply
        self.calls = []

    def invoke(self, payload):
        self.calls.append(payload)
        return self.reply


class RequirementCallTests(unittest.TestCase):
    def test_detailed_brief_can_complete_on_first_call(self):
        chain = FakeChain({
            "status": "complete",
            "requirements": {
                "objective": "Monitor outdoor temperature",
                "hardware_inputs": ["temperature sensor"],
                "hardware_outputs": ["LED"],
                "power_requirements": "rechargeable battery",
                "connectivity": ["WiFi"],
            },
        })
        with patch.object(agent, "_get_interview_chain", return_value=chain), patch.object(
            agent, "invoke_with_limits", side_effect=lambda call, model, **_: (call(model), model)
        ):
            result = agent.run_interview(DETAILED_BRIEF)

        self.assertEqual(result.status, "complete")
        self.assertEqual(len(chain.calls), 1)
        self.assertIn("asked 0 questions", chain.calls[0]["input"])
        self.assertEqual(agent._interview_budget(DETAILED_BRIEF), 2)

    def test_sparse_brief_still_allows_clarification(self):
        chain = FakeChain({
            "status": "question",
            "question": "How will it be powered?",
            "options": ["USB-C", "Battery", "Solar"],
        })
        with patch.object(agent, "_get_interview_chain", return_value=chain), patch.object(
            agent, "invoke_with_limits", side_effect=lambda call, model, **_: (call(model), model)
        ), patch.object(agent, "_get_option_chain") as option_chain:
            result = agent.run_interview("Build a sensor")

        self.assertEqual(result.status, "question")
        self.assertEqual(len(chain.calls), 1)
        option_chain.assert_not_called()
        self.assertEqual(agent._interview_budget("Build a sensor"), 4)

    def test_budget_uses_initial_brief_across_answers(self):
        history = [
            {"role": "user", "content": "Build a sensor"},
            {"role": "assistant", "content": "What power source?"},
            {"role": "user", "content": DETAILED_BRIEF},
        ]
        self.assertEqual(agent._interview_budget("Battery and WiFi", history), 4)
        self.assertEqual(agent._asked_question_count(history), 1)

    def test_budget_is_soft_if_model_still_needs_a_question(self):
        chain = FakeChain({
            "status": "question",
            "question": "Which input voltage is available?",
            "options": ["3.3 V", "5 V", "12 V"],
        })
        history = [{"role": "user", "content": DETAILED_BRIEF}]
        for answer in ("What is the enclosure size?", "Which sensor model?"):
            history.append({"role": "assistant", "content": answer})
            history.append({"role": "user", "content": "Not sure yet"})
        with patch.object(agent, "_get_interview_chain", return_value=chain), patch.object(
            agent, "invoke_with_limits", side_effect=lambda call, model, **_: (call(model), model)
        ):
            result = agent.run_interview("Not sure yet", history)

        self.assertEqual(result.status, "question")
        self.assertIn("return status complete", chain.calls[0]["input"])


if __name__ == "__main__":
    unittest.main()
