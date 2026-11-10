"""Supermicro BMC readings for the tested installation.

Only fixed, read-only OEM commands belong in this provider.
"""

import re
from pathlib import Path
from xml.etree import ElementTree


COMMANDS = {
    'mode': ('raw', '0x30', '0x45', '0x00'),
    'zone0': ('raw', '0x30', '0x70', '0x66', '0x00', '0x00'),
    'zone1': ('raw', '0x30', '0x70', '0x66', '0x00', '0x01'),
}
INVENTORY_COMMANDS = {
    'fru': ('fru', 'print'),
    'bmc': ('mc', 'info'),
}

FRU_FIELDS = {
    'Chassis Type': ('chassis', 'type'),
    'Chassis Part Number': ('chassis', 'part_number'),
    'Chassis Serial': ('chassis', 'serial'),
    'Board Mfg': ('board', 'manufacturer'),
    'Board Product': ('board', 'product'),
    'Board Serial': ('board', 'serial'),
    'Board Part Number': ('board', 'part_number'),
    'Product Manufacturer': ('product', 'manufacturer'),
    'Product Name': ('product', 'name'),
    'Product Part Number': ('product', 'part_number'),
    'Product Version': ('product', 'version'),
    'Product Serial': ('product', 'serial'),
    'Product Asset Tag': ('product', 'asset_tag'),
}
BMC_FIELDS = {
    'Device ID': 'device_id',
    'Firmware Revision': 'firmware_revision',
    'IPMI Version': 'ipmi_version',
    'Manufacturer ID': 'manufacturer_id',
    'Manufacturer Name': 'manufacturer_name',
    'Product ID': 'product_id',
    'Product Name': 'product_name',
}

PROFILES_PATH = Path(__file__).with_name('supermicro_boards.xml')
MATCH_SOURCES = {
    'fru.board.product', 'fru.product.name', 'fru.board.manufacturer',
    'bmc.manufacturer_name', 'bmc.product_name', 'smbios.planar.product',
}
CATEGORIES = {'Temperatures', 'Fans', 'Control', 'Voltages', 'Others'}


def inventory_text(value):
    cleaned = ''.join(character for character in value.strip() if ord(character) >= 32)
    return cleaned[:128] if cleaned and cleaned.lower() not in ('na', 'n/a', 'unknown', 'not specified') else None


def append_extra(extras, key, value):
    label = inventory_text(key)
    if label and len(extras) < 64:
        extras.append({'label': label[:64], 'value': inventory_text(value) or ''})


def parse_fru(output):
    devices = []
    current = None
    for line in output.splitlines():
        key, separator, raw = line.partition(':')
        key = key.strip()
        value = inventory_text(raw)
        if key == 'FRU Device Description':
            current = {'device': value, 'chassis': {}, 'board': {}, 'product': {}, 'extra': []}
            devices.append(current)
        elif current is not None and key in FRU_FIELDS and value is not None:
            section, field = FRU_FIELDS[key]
            current[section][field] = value
        elif current is not None and separator and key not in FRU_FIELDS:
            append_extra(current['extra'], key, raw)
        elif current is not None and not separator and current['extra']:
            continuation = inventory_text(line)
            if continuation:
                previous = current['extra'][-1]
                previous['value'] = (previous['value'] + '; ' + continuation).strip('; ')[:128]
    for device in devices:
        device['extra'] = [item for item in device['extra'] if item['value']]
    return devices[:32]


def parse_bmc(output):
    info = {'extra': []}
    for line in output.splitlines():
        key, separator, raw = line.partition(':')
        if separator and key.strip() in BMC_FIELDS:
            value = inventory_text(raw)
            if value is not None:
                info[BMC_FIELDS[key.strip()]] = value
        elif separator:
            append_extra(info['extra'], key, raw)
        elif info['extra']:
            continuation = inventory_text(line)
            if continuation:
                previous = info['extra'][-1]
                previous['value'] = (previous['value'] + '; ' + continuation).strip('; ')[:128]
    info['extra'] = [item for item in info['extra'] if item['value']]
    return info


def pattern_matches(value, pattern):
    if not value or not pattern:
        return False
    value, pattern = value.casefold(), pattern.casefold()
    return value.startswith(pattern[:-1]) if pattern.endswith('*') else value == pattern


def valid_pattern(pattern):
    return bool(pattern) and len(pattern) <= 128 and pattern.count('*') <= 1 and (
        '*' not in pattern or pattern.endswith('*')) and all(ord(character) >= 32 for character in pattern)


def board_profile(devices, bmc, path=PROFILES_PATH, motherboard=None):
    try:
        root = ElementTree.parse(path).getroot()
    except (OSError, ElementTree.ParseError):
        return None
    if root.tag != 'board-profiles':
        return None
    values = {'bmc.' + key: [value] for key, value in bmc.items()}
    if motherboard:
        values['smbios.planar.product'] = [motherboard]
    for device in devices:
        for section in ('board', 'product'):
            for key, value in device[section].items():
                values.setdefault('fru.' + section + '.' + key, []).append(value)
    for board in root.findall('board'):
        matches = board.findall('match')
        if not matches or not board.get('id') or len(board.get('id')) > 80:
            continue
        if not any(match.get('source') in MATCH_SOURCES and
                   valid_pattern(match.get('pattern')) and
                   any(pattern_matches(value, match.get('pattern'))
                       for value in values.get(match.get('source'), []))
                   for match in matches):
            continue
        sensor_patterns = [sensor.get('pattern') for sensor in board.findall('./sensors/sensor')
                           if valid_pattern(sensor.get('pattern'))]
        groups = []
        group_ids = set()
        for group in board.findall('./groups/group'):
            members = [member.get('pattern') for member in group.findall('member')
                       if valid_pattern(member.get('pattern'))]
            if (re.fullmatch(r'group_[a-zA-Z0-9_-]{1,64}', group.get('id') or '') and
                    group.get('id') not in group_ids and
                    group.get('name') and len(group.get('name')) <= 80 and
                    group.get('category') in CATEGORIES and group.get('unit') and
                    len(group.get('unit')) <= 32 and group.get('method') in ('mean', 'median', 'max') and members):
                groups.append({'id': group.get('id'), 'name': group.get('name'),
                               'category': group.get('category'), 'unit': group.get('unit'),
                               'method': group.get('method'), 'members': members[:256]})
                group_ids.add(group.get('id'))
        return {'id': board.get('id'), 'sensor_patterns': sensor_patterns[:256], 'groups': groups[:32]}
    return None


def inventory(results):
    devices = parse_fru(results['fru'])
    bmc = parse_bmc(results['bmc'])
    motherboard = inventory_text(results.get('motherboard', ''))
    return {
        'fru': devices,
        'bmc': bmc,
        'processor': {'model': inventory_text(results['processor'])},
        'motherboard': {'product': motherboard},
        'system': {'name': inventory_text(results.get('system', ''))},
        'profile': board_profile(devices, bmc, motherboard=motherboard),
    }


def parse_byte(output, maximum=255):
    if not re.fullmatch(r'\s*[0-9a-fA-F]{2}\s*', output):
        return None
    value = int(output.strip(), 16)
    return value if value <= maximum else None


def readings(results):
    mode = parse_byte(results['mode'])
    # On this installation, mode 0x03 is treated as PUE2; the mapping is not universal.
    label = {0: 'Standard', 1: 'FullSpeed', 2: 'Optimal', 3: 'PUE2', 4: 'HeavyIO'}.get(mode, 'Unknown')
    mode_text = None if mode is None else '0x%02X (%s)' % (mode, label)
    rows = [{
        'name': 'Fan Mode', 'value': mode_text, 'unit': '',
        'status': 'na' if mode is None else 'ok',
        'category': 'Control', 'numeric': False,
    }]

    for zone in (0, 1):
        value = parse_byte(results['zone' + str(zone)], 100)
        rows.append({
            'name': 'PWM zone ' + str(zone), 'value': value, 'unit': '%',
            'status': 'ok' if value is not None else 'na',
            'category': 'Control', 'numeric': True,
        })
    return rows
