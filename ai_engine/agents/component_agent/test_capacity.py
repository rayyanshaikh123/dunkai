"""MCU capacity demand and checks (capacity.py). No catalogue or network.

    python ai_engine/agents/component_agent/test_capacity.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import capacity


def mcu(part, flash=None, gpio=None, usb=None, description=""):
    attributes = {k: v for k, v in (("Program Storage Size", flash), ("GPIO Ports Number", gpio),
                                    ("Universal Serial Bus", usb)) if v is not None}
    return {"mfr_part": part, "description": description, "extra_params": {"attributes": attributes}}


#: The design that received an 8051: GSM, GPS, camera, display, RTC, sensor,
#: button, motor, flash and a USB connector around one MCU.
BIG = capacity.demand([
    {"interface": "UART", "role": "cellular"}, {"interface": "UART", "role": "gnss"},
    {"interface": "SPI", "role": "camera"}, {"interface": "SPI", "role": "display"},
    {"interface": "I2C", "role": "rtc"}, {"interface": "I2C", "role": "temperature"},
    {"interface": "GPIO", "role": "button"}, {"interface": "PWM", "role": "motor_driver"},
    {"interface": "SPI", "role": "flash_memory"}, {"interface": "USB", "role": "usb_connector"},
    {"interface": "Power", "role": "ldo"},
])
SMALL = capacity.demand([{"interface": "I2C", "role": "temperature"}, {"interface": "GPIO", "role": "led"}])


class CapacityTests(unittest.TestCase):
    def test_demand_counts_links_not_interface_types(self):
        self.assertEqual(BIG["uart_links"], 2)
        self.assertTrue(BIG["needs_usb"])
        self.assertGreaterEqual(BIG["gpio"], 25)
        self.assertGreaterEqual(BIG["flash_kb"], 128)
        self.assertLessEqual(SMALL["gpio"], 6)

    def test_undersized_8051_fails_with_the_reason(self):
        verdict, reason, notes = capacity.check(mcu("STC15W408AS-35I-SOP16", "8KB", "14"), BIG)
        self.assertEqual(verdict, capacity.FAIL)
        self.assertIn("14 GPIO", reason)
        self.assertTrue(notes, "two UART links must be called out")

    def test_flash_from_description_when_attribute_missing(self):
        part = mcu("X", gpio="48", description="Cortex-M4 512KB FLASH LQFP-64")
        self.assertEqual(capacity.flash_kb(part), 512)
        self.assertEqual(capacity.check(part, BIG)[0], capacity.PASS)

    def test_missing_data_is_unknown_not_pass(self):
        self.assertEqual(capacity.check(mcu("ESP32-WROOM-32E"), BIG)[0], capacity.UNKNOWN)

    def test_usb_needed_but_absent_fails(self):
        self.assertEqual(capacity.check(mcu("X", "512KB", "48", usb="-"), BIG)[0], capacity.FAIL)

    def test_small_design_accepts_small_mcu(self):
        self.assertEqual(capacity.check(mcu("ATTINY", "8KB", "6"), SMALL)[0], capacity.PASS)

    def test_megabyte_flash(self):
        self.assertEqual(capacity.flash_kb(mcu("X", "1MB")), 1024)


if __name__ == "__main__":
    unittest.main()
