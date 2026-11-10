import datetime
import fcntl
import json
import math
import re
import subprocess
import sys

from providers import supermicro

IPMITOOL = '/usr/local/bin/ipmitool'
PROVIDER = supermicro
COMMANDS = {'sensors': ('sensor', 'list'), **PROVIDER.COMMANDS}
INVENTORY_COMMANDS = {
    **{key: (IPMITOOL, '-I', 'open', *command) for key, command in PROVIDER.INVENTORY_COMMANDS.items()},
    'processor': ('/sbin/sysctl', '-n', 'hw.model'),
    'motherboard': ('/bin/kenv', 'smbios.planar.product'),
    'system': ('/bin/kenv', 'smbios.system.product'),
}


def reading(name, value=None, unit='', status='na'):
    return dict(name=name, value=value, unit=unit, status=status)

# Parse sensor values
def parse_sensors(output):
    rows = {}
    for line in output.splitlines():
        fields = [field.strip() for field in line.split('|')]
        if len(fields) < 4:
            continue
        name, raw, unit, status = fields[:4]
        if not name or len(name) > 128 or any(ord(character) < 32 for character in name):
            continue
        normalized = {'degrees c': '°C', 'rpm': 'RPM', 'volts': 'V', 'amps': 'A', 'watts': 'W', 'percent': '%'}
        display_unit = normalized.get(unit.lower(), unit[:32])
        inferred = False
        if unit.lower() in ('na', 'ns', 'n/a', ''):
            if re.match(r'^fan(?!.*(?:mode|pwm))', name, re.I):
                display_unit, inferred = 'RPM', True
            elif re.search(r'temp|thermal', name, re.I) or re.fullmatch(r'dimm[a-z0-9_-]*', name, re.I) or name.lower() in ('cpu', 'system', 'peripheral'):
                display_unit, inferred = '°C', True
        numeric = inferred or unit.lower() not in ('discrete', 'na', 'ns', 'n/a', '')
        value = None
        if re.fullmatch(r'-?\d+(?:\.\d+)?', raw) and numeric:
            number = float(raw)
            plausible = -50 <= number <= 150 if display_unit == '°C' else 0 <= number <= 100000 if display_unit == 'RPM' else True
            if math.isfinite(number) and plausible:
                value = number
        elif not numeric and raw.lower() not in ('na', 'ns', 'n/a', 'no reading', 'disabled', ''):
            value = raw[:80]
        item = reading(name, value, display_unit if numeric else '', status[:16] if value is not None else 'na')
        item['numeric'] = numeric
        item['unit_inferred'] = inferred
        item['category'] = 'Temperatures' if display_unit == '°C' else 'Fans' if display_unit == 'RPM' else 'Voltages' if display_unit == 'V' else 'Others'
        rows.setdefault(name, item)
    return list(rows.values())


def execute(key):
    try:
        result = subprocess.run([IPMITOOL, '-I', 'open', *COMMANDS[key]],
                                capture_output=True, text=True, timeout=4 if key == 'sensors' else 1,
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, check=False)
        return (result.stdout, None) if result.returncode == 0 else ('', key + ': command_unavailable')
    except subprocess.TimeoutExpired:
        return '', key + ': timed_out'
    except (OSError, UnicodeError):
        return '', key + ': ipmi_access_unavailable'


def execute_inventory(key):
    try:
        result = subprocess.run(INVENTORY_COMMANDS[key], capture_output=True, text=True,
                                timeout=3 if key == 'fru' else 1,
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, check=False)
        return (result.stdout, None) if result.returncode == 0 else ('', key + ': command_unavailable')
    except subprocess.TimeoutExpired:
        return '', key + ': timed_out'
    except (OSError, UnicodeError):
        return '', key + ': ipmi_access_unavailable'


def collect_inventory(runner=execute_inventory):
    results = {}
    errors = []
    for key in INVENTORY_COMMANDS:
        output, error = runner(key)
        results[key] = output
        if error:
            errors.append(error)
    inventory = PROVIDER.inventory(results)
    return dict(schema_version=1, timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                inventory=inventory, errors=errors, status='partial' if errors else 'ok')


def collect(runner=execute):
    errors = []
    results = {}

    for key in COMMANDS:
        output, error = runner(key)
        results[key] = output
        if error:
            errors.append(error)

    rows = parse_sensors(results['sensors'])
    if not rows:
        errors.append('no_sdr_sensor_available')

    rows.extend(PROVIDER.readings(results))

    if any(row['value'] is None for row in rows):
        errors.append('some_readings_are_absent_or_invalid_na')
        
    return dict(schema_version=2, timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                rows=rows, errors=errors, status='partial' if errors else 'ok')


def main():
    if sys.argv[1:] not in ([], ['inventory']):
        raise SystemExit('Only the fixed inventory action is accepted')
    inventory_action = sys.argv[1:] == ['inventory']
    try:
        lock_path = '/var/run/ipmimon-inventory.lock' if inventory_action else '/var/run/ipmimon-readonly.lock'
        with open(lock_path, 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX if inventory_action else fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = collect_inventory() if inventory_action else collect()
    except (OSError, BlockingIOError):
        result = dict(errors=['collector_busy_or_lock_unavailable'], status='error')
        result['inventory' if inventory_action else 'rows'] = {} if inventory_action else []
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
