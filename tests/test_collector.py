import subprocess
import unittest
import pathlib
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src/opnsense/scripts/ipmimon'))
import collector


class CollectorTests(unittest.TestCase):
    def test_dynamic_discovery(self):
        rows = collector.parse_sensors('FAN3 | na | RPM | ns\n+12V | 12.100 | Volts | ok\nPower | 18 | Watts | ok\nIntrusion | 0x0 | discrete | ok')
        self.assertEqual([row['name'] for row in rows], ['FAN3', '+12V', 'Power', 'Intrusion'])
        self.assertIsNone(rows[0]['value'])
        self.assertEqual(rows[1]['unit'], 'V')
        self.assertEqual(rows[1]['category'], 'Voltages')
        self.assertEqual(rows[2]['value'], 18)
        self.assertFalse(rows[3]['numeric'])
        self.assertEqual(collector.parse_sensors(''), [])

    def test_infer_missing_units(self):
        rows = collector.parse_sensors('FAN3 | na | na | ns\nDIMM1 | ns | ns | ns\nCPU Temp | na | na | ns\nFAN Presence | 0x0 | discrete | ok')
        self.assertEqual([row['category'] for row in rows], ['Fans','Temperatures','Temperatures','Others'])
        self.assertEqual([row['unit'] for row in rows[:3]], ['RPM','°C','°C'])
        self.assertTrue(all(row['value'] is None for row in rows[:3]))
        self.assertTrue(all(row['unit_inferred'] for row in rows[:3]))

    def test_sensors(self):
        rows = collector.parse_sensors('Package Thermal | 42.000 | degrees C | ok\nRotor A | 0 | RPM | lcr\nModule 7 Temp | na | degrees C | ns\nEnclosure Thermal | 256 | degrees C | ok')
        values = {row['name']: row for row in rows}
        self.assertEqual(values['Package Thermal']['value'], 42)
        self.assertEqual(values['Rotor A']['value'], 0)
        self.assertEqual(values['Rotor A']['status'], 'lcr')
        self.assertIsNone(values['Module 7 Temp']['value'])
        self.assertIsNone(values['Enclosure Thermal']['value'])

    def test_enumerates_unfamiliar_sensors(self):
        sensor_output = '\n'.join([
            'Package Thermal | 42 | degrees C | ok',
            'Rotor A | 1200 | RPM | ok',
            'VRM Auxiliary | 1.125 | Volts | ok',
            'Board presence | 0x0 | discrete | ok',
            'Spare probe | na | degrees C | ns',
            'Rotor A | 9999 | RPM | ok',
        ])
        outputs = {'sensors': sensor_output, 'mode': '', 'zone0': '', 'zone1': ''}
        rows = collector.collect(lambda key: (outputs[key], None))['rows']
        self.assertEqual(len(rows), 8)
        self.assertEqual([row['name'] for row in rows[:5]],
                         ['Package Thermal', 'Rotor A', 'VRM Auxiliary', 'Board presence', 'Spare probe'])
        self.assertEqual([row['value'] for row in rows[:5]], [42, 1200, 1.125, '0x0', None])
        self.assertEqual([row['category'] for row in rows[:5]],
                         ['Temperatures', 'Fans', 'Voltages', 'Others', 'Temperatures'])
        self.assertEqual(rows[4]['status'], 'na')

    def test_bytes(self):
        self.assertEqual(collector.PROVIDER.parse_byte(' 03\n'), 3)
        self.assertEqual(collector.PROVIDER.parse_byte('64', 100), 100)
        for value in ('', 'ff', '00 01', '<script>', '100'):
            self.assertIsNone(collector.PROVIDER.parse_byte(value, 100))

    def test_partial(self):
        data = collector.collect(lambda key: ('03' if key == 'mode' else '', None))
        self.assertEqual(data['status'], 'partial')
        self.assertIn('0x03', data['rows'][-3]['value'])
        self.assertEqual(data['rows'][-3]['name'], 'Fan Mode')
        self.assertEqual([row['category'] for row in data['rows'][-3:]], ['Control'] * 3)
        self.assertEqual(data['rows'][-3]['status'], 'ok')
        self.assertIn('some_readings_are_absent_or_invalid_na', data['errors'])
        self.assertIsNone(data['rows'][-1]['value'])

    def test_supermicro_readings(self):
        outputs = {
            'sensors': 'CPU Temp | 42 | degrees C | ok',
            'mode': '03', 'zone0': '32', 'zone1': '64',
        }
        data = collector.collect(lambda key: (outputs[key], None))
        self.assertEqual(data['status'], 'ok')
        self.assertEqual([row['name'] for row in data['rows']],
                         ['CPU Temp', 'Fan Mode', 'PWM zone 0', 'PWM zone 1'])
        self.assertEqual([row['value'] for row in data['rows'][2:]], [50, 100])
        self.assertEqual([row['category'] for row in data['rows'][1:]], ['Control'] * 3)
        self.assertFalse(data['rows'][1]['numeric'])
        self.assertTrue(all(row['numeric'] for row in data['rows'][2:]))

    def test_fixed_commands_and_timeout(self):
        expected = [('sensor', 'list'), ('raw', '0x30', '0x45', '0x00'),
                    ('raw', '0x30', '0x70', '0x66', '0x00', '0x00'),
                    ('raw', '0x30', '0x70', '0x66', '0x00', '0x01')]
        self.assertEqual(list(collector.COMMANDS.values()), expected)
        self.assertEqual(list(collector.PROVIDER.COMMANDS), ['mode', 'zone0', 'zone1'])
        with patch('collector.subprocess.run', side_effect=subprocess.TimeoutExpired('ipmitool', 1)) as mocked:
            output, error = collector.execute('mode')
            self.assertEqual(output, '')
            self.assertIsNotNone(error)
            self.assertEqual(mocked.call_args.args[0][:3], [collector.IPMITOOL, '-I', 'open'])
            self.assertNotIn('shell', mocked.call_args.kwargs)

    def test_missing_binary(self):
        with patch('collector.subprocess.run', side_effect=FileNotFoundError):
            self.assertIsNotNone(collector.execute('sensors')[1])

    def test_inventory_is_separate_from_sensor_snapshot(self):
        self.assertEqual(set(collector.INVENTORY_COMMANDS), {'fru', 'bmc', 'processor', 'motherboard', 'system'})
        self.assertEqual(collector.PROVIDER.INVENTORY_COMMANDS,
                         {'fru': ('fru', 'print'), 'bmc': ('mc', 'info')})
        self.assertEqual(collector.INVENTORY_COMMANDS['fru'][-2:], ('fru', 'print'))
        self.assertEqual(collector.INVENTORY_COMMANDS['bmc'][-2:], ('mc', 'info'))
        self.assertEqual(collector.INVENTORY_COMMANDS['processor'], ('/sbin/sysctl', '-n', 'hw.model'))
        self.assertEqual(collector.INVENTORY_COMMANDS['motherboard'], ('/bin/kenv', 'smbios.planar.product'))
        self.assertEqual(collector.INVENTORY_COMMANDS['system'], ('/bin/kenv', 'smbios.system.product'))
        self.assertTrue(set(collector.COMMANDS).isdisjoint(collector.INVENTORY_COMMANDS))

        calls = []
        outputs = {
            'fru': ('FRU Device Description : Builtin FRU Device (ID 0)\n'
                    ' Board Mfg : Supermicro\n Board Product : A2SDi-TP8F\n'
                    ' Board Serial : ABC123\n Product Name : Test system\n'
                    'FRU Device Description : Power supply (ID 1)\n'
                    ' Product Serial : PSU456\n'),
            'bmc': 'Firmware Revision : 04.07\nIPMI Version : 2.0\n',
            'processor': 'Intel(R) Atom(TM) CPU C3758 @ 2.20GHz\n',
            'motherboard': 'A2SDi-TP8F\n',
            'system': 'Super Server\n',
        }

        def runner(key):
            calls.append(key)
            return outputs[key], None

        data = collector.collect_inventory(runner)
        self.assertEqual(calls, ['fru', 'bmc', 'processor', 'motherboard', 'system'])
        self.assertEqual(data['status'], 'ok')
        self.assertEqual(data['inventory']['fru'][0]['board']['product'], 'A2SDi-TP8F')
        self.assertEqual(data['inventory']['fru'][0]['board']['serial'], 'ABC123')
        self.assertEqual(data['inventory']['fru'][1]['product']['serial'], 'PSU456')
        self.assertEqual(data['inventory']['bmc']['firmware_revision'], '04.07')
        self.assertIn('C3758', data['inventory']['processor']['model'])
        self.assertEqual(data['inventory']['motherboard']['product'], 'A2SDi-TP8F')
        self.assertEqual(data['inventory']['system']['name'], 'Super Server')
        self.assertEqual(data['inventory']['profile']['id'], 'supermicro-a2sdi-tp8f')
        self.assertIn('DIMM*', data['inventory']['profile']['sensor_patterns'])

    def test_smbios_model_selects_profile_when_fru_is_incomplete(self):
        data = collector.collect_inventory(lambda key: ({
            'fru': 'FRU Device Description : Builtin FRU Device (ID 0)\n Board Mfg : Supermicro\n',
            'bmc': 'Product Name : A2SDi\n',
            'processor': 'Intel Atom\n',
            'motherboard': 'A2SDi-TP8F\n',
            'system': 'Super Server\n',
        }[key], None))
        self.assertEqual(data['inventory']['profile']['id'], 'supermicro-a2sdi-tp8f')

    def test_additional_supermicro_profiles_are_exact_and_conservative(self):
        models = {
            'A2SDi-4C-HLN4F': 'supermicro-a2sdi-4c-hln4f',
            'A2SDi-8C+-HLN4F': 'supermicro-a2sdi-8cplus-hln4f',
            'X10SDV-8C-TLN4F': 'supermicro-x10sdv-8c-tln4f',
            'X10SDV-7TP4F': 'supermicro-x10sdv-7tp4f',
            'X10SDV-16C-TLN4F': 'supermicro-x10sdv-16c-tln4f',
            'X11SDV-4C-TP8F': 'supermicro-x11sdv-4c-tp8f',
            'X11SDV-8C-TP8F': 'supermicro-x11sdv-8c-tp8f',
            'X12SDV-4C-SPT8F': 'supermicro-x12sdv-4c-spt8f',
            'X12SDV-8C-SPT4F': 'supermicro-x12sdv-8c-spt4f',
        }
        for model, expected in models.items():
            with self.subTest(model=model):
                profile = collector.PROVIDER.board_profile([], {}, motherboard=model)
                self.assertEqual(profile['id'], expected)
                self.assertIn('CPU Temp', profile['sensor_patterns'])
                self.assertIn('FAN1', profile['sensor_patterns'])
                self.assertNotIn('FAN*', profile['sensor_patterns'])
                self.assertNotIn('Fan Mode', profile['sensor_patterns'])
                self.assertNotIn('PWM zone *', profile['sensor_patterns'])
                fru = collector.PROVIDER.parse_fru(
                    'FRU Device Description : Builtin FRU Device (ID 0)\n'
                    ' Board Product : MBD-' + model + '\n')
                self.assertEqual(collector.PROVIDER.board_profile(fru, {})['id'], expected)
        self.assertIsNone(collector.PROVIDER.board_profile([], {}, motherboard='X10SDV-12C-TLN4F'))
        self.assertIsNone(collector.PROVIDER.board_profile([], {}, motherboard='A2SDi-8C-HLN4F'))
        self.assertIsNone(collector.PROVIDER.board_profile([], {}, motherboard='X11SDV-12C-TP8F'))
        self.assertIsNone(collector.PROVIDER.board_profile([], {}, motherboard='X12SDV-10C-SPT8F'))

    def test_documented_supermicro_fan_zones(self):
        expected = {
            'X10SDV-8C-TLN4F': (['FAN1', 'FAN2', 'FAN3'], ['FANA']),
            'X10SDV-16C-TLN4F': (['FAN1', 'FAN2', 'FAN3'], ['FANA']),
            'X11SDV-4C-TP8F': (['FAN1', 'FAN2', 'FAN3', 'FAN4'], ['FANA', 'FANB']),
            'X11SDV-8C-TP8F': (['FAN1', 'FAN2', 'FAN3', 'FAN4'], ['FANA', 'FANB']),
        }
        for model, (zone0, zone1) in expected.items():
            with self.subTest(model=model):
                profile = collector.PROVIDER.board_profile([], {}, motherboard=model)
                groups = {group['id']: group for group in profile['groups']}
                self.assertEqual(groups['group_fan0']['name'], 'GRP_FAN0')
                self.assertEqual(groups['group_fan0']['members'], zone0)
                self.assertEqual(groups['group_fan1']['name'], 'GRP_FAN1')
                self.assertEqual(groups['group_fan1']['members'], zone1)
        for model in ('A2SDi-4C-HLN4F', 'A2SDi-8C+-HLN4F',
                      'X10SDV-7TP4F', 'X12SDV-4C-SPT8F', 'X12SDV-8C-SPT4F'):
            with self.subTest(model=model):
                profile = collector.PROVIDER.board_profile([], {}, motherboard=model)
                self.assertFalse(any(group['id'].startswith('group_fan')
                                     for group in profile['groups']))

    def test_inventory_keeps_additional_fru_fields_separate(self):
        devices = collector.PROVIDER.parse_fru('FRU Device Description : Baseboard (ID 0)\n'
                                               ' Board Serial : XYZ\n Secret Field : do not include\n')
        self.assertEqual(devices[0]['board'], {'serial': 'XYZ'})
        self.assertEqual(devices[0]['extra'], [{'label': 'Secret Field', 'value': 'do not include'}])
        self.assertIsNone(collector.PROVIDER.board_profile(devices, {}))

    def test_inventory_lists_additional_ipmitool_fields(self):
        devices = collector.PROVIDER.parse_fru('FRU Device Description : Baseboard (ID 0)\n'
                                               ' Board Mfg Date : Mon Nov 9 2026\n'
                                               ' Board Extra : Revision A\n')
        self.assertEqual(devices[0]['extra'], [
            {'label': 'Board Mfg Date', 'value': 'Mon Nov 9 2026'},
            {'label': 'Board Extra', 'value': 'Revision A'}])
        bmc = collector.PROVIDER.parse_bmc('Device ID : 32\nDevice Revision : 1\n'
                                            'Additional Device Support :\n Sensor Device\n SDR Repository Device\n')
        self.assertEqual(bmc['device_id'], '32')
        self.assertEqual(bmc['extra'], [
            {'label': 'Device Revision', 'value': '1'},
            {'label': 'Additional Device Support', 'value': 'Sensor Device; SDR Repository Device'}])

    def test_board_profiles_can_be_added_without_code_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            profile_file = pathlib.Path(folder) / 'boards.xml'
            profile_file.write_text('''<board-profiles>
                <board id="new-board">
                    <match source="bmc.product_name" pattern="Controller X" />
                    <sensors><sensor pattern="CPU*" /></sensors>
                    <groups><group id="group_cpu" name="CPU" category="Temperatures" unit="°C" method="mean">
                        <member pattern="CPU*" />
                    </group></groups>
                </board>
            </board-profiles>''', encoding='utf-8')
            devices = collector.PROVIDER.parse_fru('FRU Device Description : Other (ID 0)\n')
            profile = collector.PROVIDER.board_profile(devices, {'product_name': 'Controller X'}, profile_file)
            self.assertEqual(profile['id'], 'new-board')
            self.assertEqual(profile['sensor_patterns'], ['CPU*'])
            self.assertEqual(profile['groups'][0]['members'], ['CPU*'])
            profile_file.write_text('''<board-profiles><board id="new-board">
                <match source="bmc.product_name" pattern="Controller X" />
                <sensors><sensor pattern="CPU*" /></sensors>
                <groups><group id="invalid" name="Bad" category="Unknown" unit="°C" method="mean">
                    <member pattern="CPU*" />
                </group></groups>
            </board></board-profiles>''', encoding='utf-8')
            profile = collector.PROVIDER.board_profile(devices, {'product_name': 'Controller X'}, profile_file)
            self.assertEqual(profile['groups'], [])


if __name__ == '__main__':
    unittest.main()
