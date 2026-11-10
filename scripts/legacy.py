import argparse
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

PATHS = (
    'opnsense/scripts/ipmimon/collector.py',
    'opnsense/service/conf/actions.d/actions_ipmimon.conf',
    'opnsense/mvc/app/controllers/OPNsense/Ipmimon/Api/SnapshotController.php',
    'opnsense/mvc/app/models/OPNsense/Ipmimon/ACL/ACL.xml',
    'opnsense/www/js/widgets/Ipmimon.js',
    'opnsense/www/js/widgets/Metadata/Ipmimon.xml',
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect_files(prefix):
    files = []
    for relative in PATHS:
        path = prefix / relative
        if path.is_symlink() or (path.exists() and path.resolve() != path):
            raise ValueError('Refusing symlink: ' + str(path))
        if not path.exists():
            continue
        if not path.is_file():
            raise ValueError('Expected a regular file: ' + str(path))
        owner = subprocess.run(['pkg', 'which', '-q', str(path)], capture_output=True, text=True)
        if owner.returncode == 0:
            raise ValueError('Managed by pkg; do not detach: ' + str(path))
        if owner.returncode != 1 or owner.stderr or owner.stdout:
            raise ValueError('Could not establish pkg ownership: ' + str(path))
        files.append((relative, path))
    return files


def detach(prefix, backup_root):
    files = inspect_files(prefix)
    if not files:
        raise ValueError('No standalone files to detach.')
    backup = backup_root / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True, mode=0o700)
    manifest = {}
    for relative, source in files:
        destination = backup / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        manifest[relative] = digest(source)
        if digest(destination) != manifest[relative]:
            raise ValueError('Backup verification failed; originals retained.')
    (backup / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    for relative, source in files:
        if digest(source) != manifest[relative]:
            raise ValueError('Source changed after backup; stop and inspect: ' + str(source))
    print('Verified backup:', backup, flush=True)
    for relative, source in files:
        source.unlink()
    return backup


def restore(prefix, backup):
    manifest = json.loads((backup / 'manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or not manifest or any(name not in PATHS for name in manifest):
        raise ValueError('Unexpected backup manifest.')
    for relative, expected in manifest.items():
        source = backup / relative
        target = prefix / relative
        if target.exists() or target.is_symlink() or source.is_symlink() or source.resolve() != source or digest(source) != expected:
            raise ValueError('Restore refused (collision, symlink or checksum): ' + relative)
        if target.parent.resolve() != target.parent:
            raise ValueError('Restore parent symlink refused.')
    for relative in manifest:
        target = prefix / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            output.write((backup / relative).read_bytes())
        target.chmod(0o644)


def main():
    parser = argparse.ArgumentParser(description='Safely detach or restore the six manually installed IPMI Monitor files.')
    parser.add_argument('action', choices=('check', 'detach', 'restore'))
    parser.add_argument('--backup', type=pathlib.Path)
    args = parser.parse_args()
    if not sys.platform.startswith('freebsd') or not pathlib.Path('/usr/local/sbin/opnsense-version').exists():
        raise ValueError('OPNsense required.')
    prefix = pathlib.Path('/usr/local')
    if args.action == 'check':
        for relative, path in inspect_files(prefix):
            print(digest(path), path)
        return
    if os.geteuid() != 0:
        raise ValueError('Root is required for detach/restore.')
    if args.action == 'detach':
        os.umask(0o077)
        detach(prefix, pathlib.Path('/var/backups/ipmi-monitor'))
    elif args.backup is None:
        raise ValueError('Restore requires --backup /var/backups/ipmi-monitor/<backup>.')
    else:
        backup = args.backup.resolve(strict=True)
        if not backup.is_relative_to(pathlib.Path('/var/backups/ipmi-monitor')):
            raise ValueError('Unexpected backup directory.')
        restore(prefix, backup)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
