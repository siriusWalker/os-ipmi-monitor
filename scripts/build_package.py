import argparse
import os
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def validate_metadata(maintainer, website, license_name):
    if not re.fullmatch(r'[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', maintainer):
        raise ValueError('A real maintainer email is required.')
    if not re.fullmatch(r'https://[A-Za-z0-9./_~:%?=&+-]+', website):
        raise ValueError('An HTTPS project URL without shell/make expressions is required.')
    if not re.fullmatch(r'[A-Za-z0-9.+_-]+', license_name):
        raise ValueError('Choose a valid package license identifier first.')


def stage_plugin(plugins_tree):
    tree = pathlib.Path(plugins_tree).resolve(strict=True)
    if not (tree / 'Mk/plugins.mk').is_file() or not (tree / 'Templates').is_dir():
        raise ValueError('Expected an official OPNsense plugins checkout.')
    target = tree / 'sysutils/ipmi-monitor'
    if target.exists() or target.is_symlink():
        raise ValueError('Plugin destination already exists; keep or move it manually before rebuilding.')
    target.mkdir(parents=True)
    shutil.copytree(ROOT / 'src', target / 'src')
    for name in ('Makefile', 'pkg-descr', '+PRE_INSTALL', '+POST_INSTALL.post', '+POST_DEINSTALL.post'):
        shutil.copy2(ROOT / name, target / name)
    for path in target.rglob('*'):
        if path.is_file():
            path.chmod(0o644)
        elif path.is_dir():
            path.chmod(0o755)
    return target


def main():
    parser = argparse.ArgumentParser(description='Build using the official OPNsense plugin framework, on a matching test system.')
    parser.add_argument('--plugins-tree', required=True)
    parser.add_argument('--maintainer', required=True)
    parser.add_argument('--website', required=True)
    parser.add_argument('--license', required=True, dest='license_name')
    args = parser.parse_args()
    validate_metadata(args.maintainer, args.website, args.license_name)
    if sys.platform != 'freebsd' and not sys.platform.startswith('freebsd'):
        raise ValueError('Build on FreeBSD/OPNsense matching the target release and architecture.')
    if not pathlib.Path('/usr/local/sbin/opnsense-version').is_file():
        raise ValueError('A matching OPNsense test/build system is required.')
    if os.geteuid() != 0:
        raise ValueError('Build as root on the isolated build system for correct package file ownership.')
    subprocess.run(['pkg', 'info', '-e', 'ipmitool'], check=True)
    subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(ROOT / 'tests'), '-p', 'test_*.py'], check=True)
    subprocess.run(['/usr/local/bin/php', '-l', str(ROOT / 'src/opnsense/mvc/app/controllers/OPNsense/Ipmimon/Api/SnapshotController.php')], check=True)
    target = stage_plugin(args.plugins_tree)
    output = ROOT / 'dist/packages'
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run(['make', '-C', str(target), 'package',
                    'PLUGIN_MAINTAINER=' + args.maintainer, 'PLUGIN_WWW=' + args.website,
                    'PLUGIN_LICENSE=' + args.license_name, 'PKGDIR=' + str(output)], check=True)
    print('Packages:', output)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
