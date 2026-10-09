import pandas as pd
import json
import urllib.request
import urllib.parse
from typing import List, Dict, Any

class DynamicPCBIRGenerator:
    """
    Dynamic PCB IR Generator:
    Converts any BOM CSV + Net Interconnect logic into a validated PCB IR JSON.
    """
    
    def __init__(self, easyeda_api_url: str = "https://easyeda.com/api/products"):
        self.api_url = easyeda_api_url

    def fetch_easyeda_metadata(self, query: str) -> Dict[str, Any]:
        """Queries EasyEDA live for part details."""
        url = f"{self.api_url}/search?keyword={urllib.parse.quote(query)}"
        headers = {'User-Agent': 'Mozilla/5.0'}
        
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                results = data.get('result', {}).get('lists', [])
                if results:
                    best_match = results[0]
                    return {
                        "mfr_part": best_match.get("number", query),
                        "package": best_match.get("package", "").strip()
                    }
        except Exception:
            pass
            
        return {"mfr_part": query, "package": ""}

    def parse_bom_csv(self, csv_file_path: str) -> List[Dict[str, Any]]:
        """Parses standard BOM CSVs and falls back to CSV values if API returns empty."""
        df = pd.read_csv(csv_file_path)
        
        # Standardize column headers
        df.columns = [c.lower().strip().replace(' ', '_') for c in df.columns]
        
        ref_col = next((c for c in ['reference', 'designator', 'ref', 'ref_id'] if c in df.columns), df.columns[0])
        part_col = next((c for c in ['mfr_part', 'mpn', 'part_number', 'lcsc'] if c in df.columns), df.columns[1])
        pkg_col = next((c for c in ['package', 'footprint'] if c in df.columns), None)
        cat_col = next((c for c in ['category', 'subsystem', 'type', 'part_class'] if c in df.columns), None)
        qty_col = next((c for c in ['build_quantity', 'quantity', 'qty'] if c in df.columns), None)
        # Distinct from `part_col` above, which may fall back to an lcsc column
        # as a NAME when no MPN column exists. This is the catalogue NUMBER,
        # forwarded so the downstream PCB module can resolve by a known-good
        # identifier rather than re-deriving it from the MPN string.
        lcsc_col = next((c for c in ['lcsc', 'lcsc_part', 'jlcpcb_part'] if c in df.columns), None)

        rows = []
        for _, row in df.iterrows():
            ref = str(row[ref_col]).strip()
            mpn = str(row[part_col]).strip()
            
            if not ref or ref == 'nan' or not mpn or mpn == 'nan':
                raise ValueError(f"Required BOM row {ref} has no part number; it cannot be omitted from the handoff")

            csv_package = str(row[pkg_col]).strip() if pkg_col and str(row[pkg_col]) != 'nan' else "CUSTOM"
            
            lcsc = None
            if lcsc_col:
                raw_lcsc = str(row[lcsc_col]).strip()
                if raw_lcsc and raw_lcsc.lower() != 'nan':
                    lcsc = raw_lcsc

            component = {"reference": ref, "category": str(row[cat_col]).lower().strip() if cat_col and str(row[cat_col]) != 'nan' else "ic",
                         "mfr_part": mpn, "package": csv_package,
                         "build_quantity": int(row[qty_col]) if qty_col and str(row[qty_col]).isdigit() else 1}
            # OPTIONAL and additive: emitted only when actually known, so a BOM
            # without the column produces exactly the record shape as before and
            # downstream consumers that do not read it are unaffected.
            if lcsc:
                component["lcsc"] = lcsc

            rows.append(component)
        return self.parse_bom_rows(rows)

    def parse_bom_rows(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Selected BOM identity is authoritative; fuzzy web hits cannot replace it.

        Physical resolution belongs to the designer. External device bodies are
        carried separately by the supervisor along with their PCB port paths.
        """
        components = []
        for row in rows:
            ref = row.get("reference") or row.get("ref_id")
            part = row.get("mfr_part") or row.get("part_number")
            if not ref or not part or row.get("status") in ("NO_MATCH", "SELECTION_REQUIRED"):
                raise ValueError(f"Required BOM row {ref} has no suitable part; it cannot be omitted")
            if row.get("external"):
                raise ValueError(f"{ref} is an external system device; pass its PCB interface, not a fictitious device footprint")
            component = {"ref_id": ref, "part_class": str(row.get("category") or "ic").lower(),
                         "part_number": part, "package": row.get("package") or "CUSTOM", "quantity": 1}
            for key in ("lcsc", "board_profile", "required", "device_reference"):
                if row.get(key) is not None: component[key] = row[key]
            components.append(component)
        return components

    def validate_nets(self, components: List[Dict[str, Any]], nets: List[Dict[str, Any]]) -> List[str]:
        """Checks for orphan ref_ids in nets that do not exist in components.

        Handles both net shapes: schema 1.0's ``connections: ["U1.SDA"]`` and
        schema 2.0's ``members: [{"ref_id": "U1", "role": "DATA"}]``.
        """
        declared_refs = {c["ref_id"] for c in components}
        warnings = []

        for net in nets:
            # schema 2.0
            for member in net.get("members", []):
                ref_id = member.get("ref_id")
                if ref_id not in declared_refs:
                    warnings.append(
                        f"⚠️ Warning: Member '{ref_id}' in net '{net['name']}' references unknown RefID '{ref_id}'"
                    )
            # schema 1.0
            for conn in net.get("connections", []):
                ref_id = conn.split(".")[0]
                if ref_id not in declared_refs:
                    warnings.append(f"⚠️ Warning: Connection '{conn}' in net '{net['name']}' references unknown RefID '{ref_id}'")
        return warnings

    def build_pcb_ir(
        self,
        design_name: str,
        bom_csv_path: str,
        net_connections: List[Dict[str, Any]],
        layer_count: int = 4,
        width_mm: float = 100.0,
        height_mm: float = 60.0,
        schema_version: str = "2.0",
        bom_rows: List[Dict[str, Any]] | None = None,
    ) -> Dict[str, Any]:

        components = self.parse_bom_rows(bom_rows) if bom_rows is not None else self.parse_bom_csv(bom_csv_path)

        # Check validation warnings
        warnings = self.validate_nets(components, net_connections)
        if warnings:
            raise ValueError("; ".join(warnings))

        return {
            "schema_version": schema_version,
            "design_name": design_name,
            "components": components,
            "nets": net_connections,
            "constraints": {
                "layer_count": layer_count,
                "board_outline": {
                    "shape": "rectangle",
                    "width_mm": width_mm,
                    "height_mm": height_mm
                }
            }
        }


# ==========================================
# EXECUTION
# ==========================================
if __name__ == "__main__":
    generator = DynamicPCBIRGenerator()
    
    # Interconnect net definitions
    dynamic_nets = [
        {
            "name": "POWER_RAIL_3V3",
            "connections": ["U1.VDD", "U2.VCC", "U7.VDD", "U8.VDD", "U9.VDD", "U10.3V3", "U12.VCC"],
            "net_class": "power"
        },
        {
            "name": "GND",
            "connections": ["U1.GND", "U2.GND", "U3.GND", "U4.GND", "U5.GND", "U6.GND", "U7.GND", "U8.GND", "U9.GND", "U10.GND", "U11.GND", "U12.GND"],
            "net_class": "ground"
        },
        {
            "name": "I2C_SCL",
            "connections": ["U1.SCL", "U7.SCL", "U8.SCL", "U9.SCL", "U11.SCL"],
            "net_class": "signal"
        },
        {
            "name": "I2C_SDA",
            "connections": ["U1.SDA", "U7.SDA", "U8.SDA", "U9.SDA", "U11.SDA"],
            "net_class": "signal"
        }
    ]

    pcb_ir_output = generator.build_pcb_ir(
        design_name="circuitmind_system_board",
        bom_csv_path="circuitmind_bom.csv",
        net_connections=dynamic_nets,
        layer_count=4,
        width_mm=100.0,
        height_mm=60.0
    )

    # Save fixed output
    with open("fixed_pcb_ir.json", "w", encoding="utf-8") as f:
        json.dump(pcb_ir_output, f, indent=2)

    print("\n✅ Successfully generated valid PCB IR JSON!")
