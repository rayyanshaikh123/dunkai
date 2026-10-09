"""
CircuitMind Component Agent
Graph-Aware Architecture Parser

Responsibility:
- Parse Architecture Agent JSON
- Build structured subsystem requests
- Preserve engineering topology
- Do NOT perform retrieval or ranking
"""

import json
from typing import Dict, List, Any

import interface_taxonomy


class ArchitectureParser:

    def __init__(self):
        pass

    # ==========================================================
    # Public API
    # ==========================================================

    def parse(self, architecture: Any) -> List[Dict]:

        if isinstance(architecture, str):
            architecture = json.loads(architecture)

        graph = architecture.get("architecture_graph", {})

        nodes = graph.get("nodes", [])
        edges = graph.get("edges", [])

        node_lookup = self._build_node_lookup(nodes)

        adjacency = self._build_adjacency(edges)

        requests = []

        reference_counter = 1

        for node in nodes:

            request = self._build_request(
                node=node,
                adjacency=adjacency,
                node_lookup=node_lookup,
                reference=f"U{reference_counter}"
            )

            requests.append(request)

            reference_counter += 1

        return requests

    # ==========================================================
    # Build Node Lookup
    # ==========================================================

    def _build_node_lookup(self, nodes):

        return {
            node["id"]: node
            for node in nodes
        }

    # ==========================================================
    # Build Graph
    # ==========================================================

    def _build_adjacency(self, edges):

        adjacency = {}

        for edge in edges:

            source = edge["source"]
            target = edge["target"]

            interface = (
                edge.get("data", {}).get(
                    "interface",
                    edge.get("label", "")
                )
            )

            adjacency.setdefault(source, []).append({

                "node": target,

                "interface": interface

            })

            adjacency.setdefault(target, []).append({

                "node": source,

                "interface": interface

            })

        return adjacency

    # ==========================================================
    # Create One Request
    # ==========================================================

    def _build_request(
        self,
        node,
        adjacency,
        node_lookup,
        reference
    ):

        node_id = node["id"]

        data = node["data"]

        label = data["label"]

        category = data.get("category", "")

        node_type = self._infer_type(category)

        neighbours = adjacency.get(node_id, [])

        interfaces = set()

        power_interfaces = set()

        connections = []

        for neighbour in neighbours:

            interface = neighbour["interface"]

            neighbour_node = node_lookup.get(
                neighbour["node"]
            )

            if neighbour_node is None:
                continue

            if interface.lower() == "power":

                power_interfaces.add(interface)

            else:

                interfaces.add(interface)

            connections.append({

                "subsystem":
                    neighbour_node["data"]["label"],

                "category":
                    neighbour_node["data"].get(
                        "category",
                        ""
                    ),

                "interface":
                    interface

            })

        connections.sort(
            key=lambda x: (
                x["subsystem"],
                x["interface"]
            )
        )

        return {

            "reference": reference,

            "node_id": node_id,

            "type": node_type,

            "subsystem": label,

            "category": category,

            # External bodies remain system parts; selection uses documented
            # module profiles rather than unrelated chip-catalogue matches.
            **{key: data[key] for key in ("external_key", "device_profile", "requested_part", "external", "required") if key in data},

            # Kept as-is: retrieval._build_query embeds these as query TEXT,
            # which is a separate job from scoring. Dropping "WiFi" from the
            # query would lose a genuinely useful semantic signal for finding a
            # Wi-Fi module, even though it is not a scoreable board requirement.
            "interfaces": sorted(interfaces),

            "power_interfaces": sorted(power_interfaces),

            # Structured requirements for ranking. Power and the wireless three
            # are excluded here and ONLY here -- see interface_taxonomy.
            "interface_requirements": [
                interface_taxonomy.build_requirement(i)
                for i in sorted(interfaces | power_interfaces)
                if interface_taxonomy.is_scoreable(i)
            ],

            # Dropped requirements, recorded rather than silently vanished.
            "interfaces_not_applicable": sorted(
                i for i in interfaces | power_interfaces
                if not interface_taxonomy.is_scoreable(i)
            ),

            "connections": connections,

            # Filled later by retrieval.py
            "selected_component": None

        }

    # ==========================================================
    # Infer Component Type
    # ==========================================================

    def _infer_type(self, category):

        category = category.lower()

        mapping = {

            "processing": "processing",

            "communication": "communication",

            # "Sensor" is in the architecture agent's ALLOWED_CATEGORIES but was
            # missing here, so every sensor node fell through to "generic" and
            # was retrieved with a meaningless `Type: generic` token in its
            # embedded query. Only "input" mapped to "sensor", which reads like
            # this table was written against an earlier category set.
            "sensor": "sensor",

            "input": "sensor",

            "output": "output",

            "power": "power",

            "storage": "storage",

            "memory": "storage"

        }

        return mapping.get(
            category,
            "generic"
        )


# ==============================================================
# Standalone Testing
# ==============================================================

if __name__ == "__main__":

    parser = ArchitectureParser()

    # ----------------------------------------------------------
    # Paste ANY Architecture JSON here
    # ----------------------------------------------------------

    with open("examples/architecture.json", "r") as f:
        architecture = json.load(f)

    requests = parser.parse(architecture)

    print("=" * 100)

    for request in requests:

        print(json.dumps(request, indent=4))

    print("=" * 100)
