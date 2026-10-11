"""Role inference and role verdicts (roles.py). No catalogue or network.

    python ai_engine/agents/component_agent/test_roles.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import roles

UART = [{"interface": "UART"}]
USB = [{"interface": "USB"}]

#: (label, category, connections, expected role). Every ambiguous label the
#: architecture LLM has produced or plausibly produces belongs here.
GOLDEN = [
    ("Microcontroller Unit", "Processing", [], "mcu"),
    ("Main Controller", "Processing", [], "mcu"),
    ("ESP32 Microcontroller", "Processing", [{"interface": "WiFi"}], "mcu_wireless"),
    ("MCU with BLE", "Processing", [], "mcu_wireless"),
    ("Fan Controller", "Output", [], None),
    ("Motor Driver", "Processing", [], "motor_driver"),
    ("Stepper Motor Controller", "Output", [], "motor_driver"),
    ("GPS Receiver", "Sensor", [], "gnss"),
    ("GPS Antenna", "Communication", [], "antenna"),
    ("GPS Module with Antenna", "Communication", [], "gnss"),
    ("GSM/GPS Module", "Communication", [], "cellular"),
    ("Wireless Communication Module (e.g., LTE/5G)", "Communication", [], "cellular"),
    ("SIM800L GSM Module", "Communication", [], "cellular"),
    ("2.4G Wireless Module", "Communication", [], None),
    ("Wireless Module", "Communication", [{"interface": "BLE"}], "ble"),
    ("Wi-Fi Module", "Communication", [], "wifi"),
    ("LoRa Transceiver", "Communication", [], "lora"),
    ("Camera Sensor", "Sensor", [], "camera"),
    ("Camera Flash LED", "Output", [], "led"),
    ("Status LED", "Output", [], "led"),
    ("LED Matrix Display", "Output", [], "matrix_display"),
    ("User Interface Display", "Output", [], "display"),
    ("OLED Display", "Output", [], "display"),
    ("Touch Screen Display", "Output", [], "display"),
    ("Touch Screen Controller", "Input", [], "touch_screen_ctrl"),
    ("Capacitive Touch Button", "Input", [], "touch_key"),
    ("Button Array", "Input", [], "button"),
    ("Proximity Sensor", "Sensor", [], "proximity"),
    ("Ultrasonic Distance Sensor", "Sensor", [], "proximity"),
    ("Soil Moisture Sensor", "Sensor", [], "soil_moisture"),
    ("SoilMoistureSensor", "Sensor", [], "soil_moisture"),
    ("Temperature and Humidity Sensor", "Sensor", [], "humidity"),
    ("Temperature Sensor", "Sensor", [], "temperature"),
    ("Barometric Pressure Sensor", "Sensor", [], "pressure"),
    ("Accelerometer", "Sensor", [], "imu"),
    ("Real-Time Clock", "Clock", [], "rtc"),
    ("Clock", "Clock", [], "crystal"),
    ("Local Storage (e.g., Flash)", "Storage", [], "flash_memory"),
    ("Local Storage", "Storage", [{"interface": "I2C"}], "eeprom"),
    ("Data Logger Storage", "Storage", [{"interface": "SDIO"}], "sd_card"),
    ("MicroSD Card Slot", "Storage", [], "sd_card"),
    ("USB Interface", "Communication", UART, "usb_uart_bridge"),
    ("USB Interface", "Communication", USB, "usb_connector"),
    ("USB to UART Bridge", "Communication", [], "usb_uart_bridge"),
    ("USB-C Connector", "Power", [], "usb_connector"),
    ("USB-C Battery Charger and 5V Boost Module", "Power", [], "battery_charger"),
    ("USB-C Power Delivery", "Power", [], "usb_pd_sink"),
    ("Power Management IC", "Power", [], "unspecified_power"),
    ("Analog Sensor Connector", "Input", [], "unspecified_connector"),
    ("Signal Conditioning/ADC", "Processing", [], "adc"),
    ("Signal Conditioning", "Processing", [], "unspecified_conditioning"),
    ("7-segment Display", "Output", [], "segment_display"),
    ("Charge Controller", "Power", [], "battery_charger"),
    ("3.3V Logic Regulator", "Power", [], "ldo"),
    ("Buck Converter", "Power", [], "buck"),
    ("5V Boost Converter", "Power", [], "boost"),
    ("Buzzer", "Output", [], "buzzer"),
    ("Relay Module", "Output", [], "relay"),
    ("RS485 Transceiver", "Communication", [], "rs485"),
    ("pH Sensor", "Sensor", [], None),
    ("Battery", "Power", [], None),
]


def candidate(part, subcategory, description, **attributes):
    return {"mfr_part": part, "subcategory": subcategory, "description": description,
            "extra_params": {"attributes": attributes}}


#: Catalogue text of parts a real design received for the wrong role.
WRONG = [
    ("gnss", candidate("AR1100-I/SS", "Touch Screen Controllers", "4、5or8wire resistive type uart touch screen controllers")),
    ("camera", candidate("LDC1314RGHR", "Specialized Sensors", "i2c inductance-to-digital converter")),
    ("motor_driver", candidate("EMC2103-2-AP-TR", "Microcontroller Units (MCUs/MPUs/SOCs)", "I2C QFN-16-EP(4x4) Brushed DC Motor Drivers")),
    ("mcu", candidate("EMC2103-2-AP-TR", "Microcontroller Units (MCUs/MPUs/SOCs)", "I2C QFN-16-EP(4x4) Brushed DC Motor Drivers")),
    ("soil_moisture", candidate("ENS210-LQFM", "Humidity Sensors/Temperature and Humidity Sensors", "temperature and humidity sensor")),
    ("proximity", candidate("SD3312A", "Touch Sensors", "sot-23-6 touch sensors")),
    ("display", candidate("MS9122", "Video Interface ICs", "i2c、spi、i2s qfn-48-ep(7x7) video interface ics")),
    ("usb_uart_bridge", candidate("FSUSB42MUX", "USB ICs", "2:1 analog switches, multiplexers")),
    ("battery_charger", candidate("DW01A", "Battery Management ICs", "protection ic support sot-23-6l")),
    ("adc", candidate("ADUC7023BCP6Z62IRL", "Microcontroller Units (MCUs/MPUs/SOCs)", "12bit built-in flash microcontroller")),
    ("adc", candidate("TXS0108EQPWRQ1", "Analog To Digital Converters (ADCs)", "Bidirectional Translators, Level Shifters")),
    ("usb_pd_sink", candidate("TYPE-C 6PLCH10.0 073", "USB Connectors", "Type-C receptacle")),
    ("display", candidate("YD2310AR-7.3", "LED Segment Displays", "No Description")),
]

GOOD = [
    ("gnss", candidate("ATGM336H-5N31", "GNSS Modules", "GPS/BDS GNSS module UART")),
    ("cellular", candidate("SIM800C", "2G/3G/4G/5G Modules", "gprs、gsm uart 2g/3g/4g/5g modules")),
    ("humidity", candidate("BME280", "Humidity Sensors/Temperature and Humidity Sensors", "temperature humidity pressure sensor ±3%rh")),
    ("usb_uart_bridge", candidate("CH340C", "USB Converters", "transceiver usb 2.0 sop-16 usb converters")),
    ("motor_driver", candidate("DRV8837DSGR", "Brushed DC Motor Drivers", "h-bridge brushed dc motor drivers")),
    ("display", candidate("HS96L03W2C03", "OLED displays modules", "128x64 i2c passive (pmoled) ssd1315 chip - oled display")),
    ("mcu", candidate("STM32F103C8T6", "Microcontroller Units (MCUs/MPUs/SOCs)", "ARM Cortex-M3 64KB FLASH LQFP-48",
                      **{"CPU Core": "ARM Cortex-M3", "Program Storage Size": "64KB", "GPIO Ports Number": "37"})),
    ("rtc", candidate("DS3231SN", "Real-Time Clocks(RTC)", "i2c real time clock")),
    ("battery_charger", candidate("TP4056", "Battery Management ICs", "charging ic lithium battery")),
    ("adc", candidate("ADS1115IDGSR", "Analog to Digital Converters (ADCs)", "16bit i2c analog to digital converter")),
    ("usb_pd_sink", candidate("HUSB237-AA001-DN06R", "USB PD", "Power Receiver Controller 5V 9V 12V")),
]


class RoleInferenceTests(unittest.TestCase):
    def test_golden_labels(self):
        for label, category, connections, expected in GOLDEN:
            with self.subTest(label=label, connections=connections):
                self.assertEqual(roles.infer_role(label, category, connections).key, expected)

    def test_two_functions_in_one_block_is_flagged(self):
        match = roles.infer_role("GSM/GPS Module", "Communication")
        self.assertEqual(match.secondary, ["gnss"])
        self.assertTrue(match.notes)

    def test_vague_blocks_say_what_was_assumed(self):
        self.assertTrue(roles.infer_role("USB Interface", "Communication", UART).notes)
        self.assertTrue(roles.infer_role("Local Storage", "Storage", []).notes)

    def test_every_external_role_with_a_profile_exists_in_external_devices(self):
        import external_devices
        for role in roles.ROLES:
            if role.module_profile:
                self.assertIn(role.module_profile, external_devices.PROFILES)
                self.assertIn(role.module_profile, external_devices.PATTERNS)


class RoleVerdictTests(unittest.TestCase):
    def test_historical_wrong_parts_fail(self):
        for role, part in WRONG:
            with self.subTest(role=role, part=part["mfr_part"]):
                self.assertEqual(roles.verdict(part, role)[0], roles.FAIL)

    def test_genuine_parts_pass(self):
        for role, part in GOOD:
            with self.subTest(role=role, part=part["mfr_part"]):
                self.assertEqual(roles.verdict(part, role), (roles.PASS, ""))

    def test_usb_switch_without_bridge_evidence_is_only_unknown_never_pass(self):
        switch = candidate("TP3USB31Q10", "USB Converters", "480mbps usb 2.0 utqfn-10l usb converters")
        self.assertEqual(roles.verdict(switch, "usb_uart_bridge")[0], roles.UNKNOWN)

    def test_spelling_variants_share_a_key(self):
        self.assertEqual(roles.key("Real-Time Clocks (RTC)"), roles.key("real-time clocks(rtc)"))
        self.assertEqual(roles.key("LED Segment Display"), roles.key("led segment displays"))

    def test_verify_reports_vanished_roles(self):
        findings = roles.verify({"tactile switches": 9858})
        self.assertTrue(any(f["role"] == "gnss" and f["kind"] == "role_vanished" for f in findings))
        self.assertFalse(any(f["role"] == "button" and f["kind"] == "role_vanished" for f in findings))


if __name__ == "__main__":
    unittest.main()
