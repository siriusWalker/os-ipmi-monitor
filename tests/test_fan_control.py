import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/opnsense/scripts/ipmimon'))
import fan_control


class FanControlTests(unittest.TestCase):
    def test_changes_only_the_requested_mode_and_verifies_readback(self):
        calls = []
        readings = iter(['03\n', '01\n'])

        def runner(command):
            calls.append(command)
            if command == fan_control.BOARD_COMMAND:
                return 'A2SDi-TP8F\n'
            if command == fan_control.READ_COMMAND:
                return next(readings)
            return ''

        result = fan_control.change_mode('full', runner)
        self.assertEqual(result, {'status': 'ok', 'mode': '0x01', 'changed': True})
        self.assertEqual(calls, [fan_control.BOARD_COMMAND, fan_control.READ_COMMAND,
                                 (fan_control.IPMITOOL, '-I', 'open', 'raw', '0x30', '0x45', '0x01', '0x01'),
                                 fan_control.READ_COMMAND])

    def test_refuses_unsupported_board_before_any_ipmi_command(self):
        calls = []

        def runner(command):
            calls.append(command)
            return 'X13UNKNOWN\n'

        self.assertEqual(fan_control.change_mode('full', runner)['error'], 'unsupported_board')
        self.assertEqual(calls, [fan_control.BOARD_COMMAND])

    def test_board_specific_mode_allowlist(self):
        cases = [
            ('X10SDV-7TP4F', 'heavyio', '0x04'),
            ('X11SDV-4C-TP8F', 'full', '0x01'),
            ('X12SDV-8C-SPT4F', 'optimal', '0x02'),
        ]
        for board, selected, code in cases:
            with self.subTest(board=board):
                calls = []
                readings = iter(['00\n', code[2:] + '\n'])

                def runner(command):
                    calls.append(command)
                    if command == fan_control.BOARD_COMMAND:
                        return board + '\n'
                    if command == fan_control.READ_COMMAND:
                        return next(readings)
                    return ''

                self.assertEqual(fan_control.change_mode(selected, runner)['mode'], code)
                self.assertEqual(calls[2][-1], code.lower())

        calls = []

        def x11_runner(command):
            calls.append(command)
            return 'X11SDV-4C-TP8F\n'

        self.assertEqual(fan_control.change_mode('optimal', x11_runner)['error'], 'invalid_mode')
        self.assertEqual(calls, [fan_control.BOARD_COMMAND])

    def test_refuses_invalid_mode_and_unknown_current_mode(self):
        self.assertEqual(fan_control.change_mode('manual;evil', lambda command: self.fail('must not run'))['error'],
                         'invalid_mode')
        calls = []

        def runner(command):
            calls.append(command)
            return 'A2SDi-TP8F\n' if command == fan_control.BOARD_COMMAND else '05\n'

        self.assertEqual(fan_control.change_mode('pue2', runner)['error'], 'unsupported_current_mode')
        self.assertEqual(calls, [fan_control.BOARD_COMMAND, fan_control.READ_COMMAND])
        calls.clear()
        self.assertEqual(fan_control.change_mode('manual', runner)['error'], 'invalid_mode')
        self.assertEqual(calls, [fan_control.BOARD_COMMAND])

    def test_reports_readback_mismatch(self):
        readings = iter(['03\n'] * 4)
        calls = []

        def runner(command):
            calls.append(command)
            return 'A2SDi-TP8F\n' if command == fan_control.BOARD_COMMAND else next(readings) if command == fan_control.READ_COMMAND else ''

        with patch('fan_control.time.sleep'):
            self.assertEqual(fan_control.change_mode('heavyio', runner)['error'], 'mode_readback_mismatch')
        self.assertEqual(calls[2][-1], '0x04')


if __name__ == '__main__':
    unittest.main()
