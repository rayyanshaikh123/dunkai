"""Focused, network-free checks for the requirement interview contract."""

from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agents"))

from requirement_agent import (  # noqa: E402
    HardwareRequirements,
    InterviewResponse,
    MAX_INTERVIEW_TURNS,
    _interview_budget,
)


class InterviewContractTests(unittest.TestCase):
    def test_question_normalizes_provider_option_wrapper(self) -> None:
        response = InterviewResponse.model_validate(
            {
                "status": "question",
                "question": "How should the board connect?",
                "options": '{"options": ["Wi-Fi", "Bluetooth LE", "USB only"]}',
            }
        )
        self.assertEqual(response.options, ["Wi-Fi", "Bluetooth LE", "USB only"])

    def test_question_requires_multiple_choices(self) -> None:
        with self.assertRaises(ValueError):
            InterviewResponse.model_validate(
                {
                    "status": "question",
                    "question": "What power source will it use?",
                    "options": ["Battery"],
                }
            )

    def test_complete_response_has_requirements(self) -> None:
        response = InterviewResponse.model_validate(
            {
                "status": "complete",
                "requirements": HardwareRequirements(project_name="Blink board"),
            }
        )
        self.assertEqual(response.requirements.project_name, "Blink board")

    def test_budget_is_adaptive_and_never_exceeds_ten(self) -> None:
        simple = _interview_budget("Build a blinking LED")
        complex_project = _interview_budget(
            "Build a battery-powered medical wearable with BLE, temperature and motion sensors, "
            "a display, a small enclosure, safety certification, and real-time alerts."
        )
        self.assertGreaterEqual(simple, 1)
        self.assertGreaterEqual(complex_project, simple)
        self.assertLessEqual(complex_project, MAX_INTERVIEW_TURNS)
        self.assertLessEqual(MAX_INTERVIEW_TURNS, 10)


if __name__ == "__main__":
    unittest.main()
