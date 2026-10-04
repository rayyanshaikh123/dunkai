"""Offline tests for the synchronous supervisor's targeted revision routing."""

from __future__ import annotations

import unittest
import json
from unittest.mock import patch

from ai_engine.agents.supervisor import server


class CallRoutingTests(unittest.TestCase):
    def test_architecture_revision_runs_only_architecture_stage(self):
        request = server.SupervisorRequest(
            action="run_workflow",
            project={"requirements": {"objective": "Monitor temperature"}, "architecture": {"nodes": []}},
            messages=[{"role": "user", "content": "Make the architecture more detailed"}],
        )
        with patch.object(server, "safety_node", return_value={"safety": {"verdict": "allow"}}) as safety, patch.object(
            server, "_run_single_node", return_value={"architecture": {"nodes": []}}
        ) as single, patch.object(
            server, "run_workflow"
        ) as full:
            result = server._supervisor_dispatch(request)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(single.call_args.args[0], "generate_architecture")
        safety.assert_called_once()
        full.assert_not_called()

    def test_blocked_revision_never_reaches_design_stage(self):
        request = server.SupervisorRequest(
            action="run_workflow",
            project={"requirements": {"objective": "Monitor temperature"}},
            messages=[{"role": "user", "content": "Change the architecture"}],
        )
        blocked = {"safety": {"verdict": "reject"}, "workflow_status": "blocked"}
        with patch.object(server, "safety_node", return_value=blocked), patch.object(
            server, "_run_single_node"
        ) as single:
            sync = server._supervisor_dispatch(request)
            events = list(server._stream_events(request))

        self.assertEqual(sync["data"]["workflow_status"], "blocked")
        self.assertEqual(json.loads(events[-1].split("data: ", 1)[1])["data"]["workflow_status"], "blocked")
        single.assert_not_called()

    def test_streamed_revision_checks_safety_then_runs_one_stage(self):
        request = server.SupervisorRequest(
            action="run_workflow",
            project={"requirements": {"objective": "Monitor temperature"}},
            messages=[{"role": "user", "content": "Change the architecture"}],
        )
        with patch.object(server, "safety_node", return_value={"safety": {"verdict": "allow"}}) as safety, patch.object(
            server, "_run_single_node", return_value={"architecture": {"nodes": []}}
        ) as single, patch.object(server, "stream_workflow") as full:
            events = list(server._stream_events(request))

        self.assertEqual(len(events), 3)
        self.assertEqual(json.loads(events[1].split("data: ", 1)[1])["node"], "architecture")
        safety.assert_called_once()
        self.assertEqual(single.call_args.args[0], "generate_architecture")
        full.assert_not_called()

    def test_ambiguous_request_keeps_full_workflow(self):
        request = server.SupervisorRequest(
            action="run_workflow",
            project={"requirements": {"objective": "Monitor temperature"}},
            messages=[{"role": "user", "content": "Could you improve this design?"}],
        )
        with patch.object(server, "_run_single_node") as single, patch.object(
            server, "run_workflow", return_value={"requirements": {"objective": "Monitor temperature"}}
        ) as full:
            result = server._supervisor_dispatch(request)

        self.assertEqual(result["status"], "completed")
        single.assert_not_called()
        full.assert_called_once()


if __name__ == "__main__":
    unittest.main()
