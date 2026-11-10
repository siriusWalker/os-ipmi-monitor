"""Explicit Supermicro fan-mode changes restricted by board profile."""

import fcntl
import json
import re
import subprocess
import sys
import time

from providers import supermicro


IPMITOOL = '/usr/local/bin/ipmitool'
BOARD_COMMAND = ('/bin/kenv', 'smbios.planar.product')
READ_COMMAND = (IPMITOOL, '-I', 'open', *supermicro.COMMANDS['mode'])
def execute(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=4,
                            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, check=False)
    if result.returncode != 0:
        raise RuntimeError('command_failed')
    return result.stdout


def change_mode(mode, runner=execute):
    if not isinstance(mode, str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', mode):
        return {'status': 'error', 'error': 'invalid_mode'}
    try:
        board = runner(BOARD_COMMAND).strip()
        profile = supermicro.board_profile([], {}, motherboard=board)
        if not profile or not profile['fan_modes']:
            return {'status': 'error', 'error': 'unsupported_board'}
        modes = {item['id']: int(item['code'], 16) for item in profile['fan_modes']}
        if mode not in modes:
            return {'status': 'error', 'error': 'invalid_mode'}
        previous = supermicro.parse_byte(runner(READ_COMMAND))
        if previous not in modes.values():
            return {'status': 'error', 'error': 'unsupported_current_mode'}
        target = modes[mode]
        if previous != target:
            runner((IPMITOOL, '-I', 'open', 'raw', '0x30', '0x45', '0x01', '0x%02x' % target))
        observed = None
        for attempt in range(3):
            if attempt:
                time.sleep(0.5)
            observed = supermicro.parse_byte(runner(READ_COMMAND))
            if observed == target:
                break
        if observed != target:
            return {'status': 'error', 'error': 'mode_readback_mismatch'}
        return {'status': 'ok', 'mode': '0x%02X' % observed, 'changed': previous != target}
    except (OSError, RuntimeError, subprocess.TimeoutExpired, UnicodeError):
        return {'status': 'error', 'error': 'ipmi_access_unavailable'}


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', sys.argv[1]):
        raise SystemExit('Expected one fan-mode identifier')
    try:
        with open('/var/run/ipmimon-readonly.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = change_mode(sys.argv[1])
    except OSError:
        result = {'status': 'error', 'error': 'lock_unavailable'}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
