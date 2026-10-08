import unittest
from unittest.mock import patch

from readiness import inspect_runtime


class ReadinessTests(unittest.TestCase):
    @patch("readiness.shutil.which", side_effect=lambda name: "/usr/bin/" + name)
    def test_namespace_denial_never_reports_pcb_support(self, _which):
        with patch("readiness._run", side_effect=[(0, "v22.12.0", ""), (1, "", "Creating new namespace failed: Operation not permitted")]):
            result = inspect_runtime()
        self.assertTrue(result["node_22_or_newer"])
        self.assertFalse(result["pcb_sandbox_preflight_passed"])
        self.assertFalse(result["prerequisites_passed"])
        self.assertIn("Operation not permitted", result["sandbox_detail"])

    @patch("readiness.shutil.which", side_effect=lambda name: "/usr/bin/" + name)
    def test_old_node_remains_an_unmet_prerequisite(self, _which):
        with patch("readiness._run", side_effect=[(0, "v18.20.0", ""), (0, "", "")]):
            result = inspect_runtime()
        self.assertTrue(result["pcb_sandbox_preflight_passed"])
        self.assertFalse(result["prerequisites_passed"])

    @patch("readiness.shutil.which", side_effect=lambda name: "/usr/bin/" + name)
    def test_preflight_success_is_distinct_from_a_complete_engine_test(self, _which):
        with patch("readiness._run", side_effect=[(0, "v22.12.0", ""), (0, "", "")]):
            result = inspect_runtime()
        self.assertTrue(result["prerequisites_passed"])
        self.assertFalse(result["complete_engine_tested"])


if __name__ == "__main__":
    unittest.main()
