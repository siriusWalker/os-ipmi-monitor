import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

from build_package import validate_metadata


def client_config(url):
    validate_metadata('check@example.invalid', url, 'BSD2CLAUSE')
    return {'ipmi-monitor': {
        'url': url.rstrip('/'), 'enabled': True, 'signature_type': 'pubkey',
        'pubkey': '/usr/local/etc/pkg/keys/ipmi-monitor.pub',
        'mirror_type': 'none', 'priority': 0,
    }}


def main():
    parser = argparse.ArgumentParser(description='Create a signed repository locally; does not upload or configure any firewall.')
    parser.add_argument('--packages', type=pathlib.Path, default=pathlib.Path('dist/packages'))
    parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('dist/repository'))
    parser.add_argument('--client-output', type=pathlib.Path, default=pathlib.Path('dist/client'))
    parser.add_argument('--private-key', type=pathlib.Path, required=True)
    parser.add_argument('--public-key', type=pathlib.Path, required=True)
    parser.add_argument('--url', required=True)
    args = parser.parse_args()
    config = client_config(args.url)
    private = args.private_key.resolve(strict=True)
    public = args.public_key.resolve(strict=True)
    output = args.output.resolve()
    client = args.client_output.resolve()
    packages_dir = args.packages.resolve(strict=True)
    if output.exists() or client.exists():
        raise ValueError('Output directories already exist; use new empty release directories.')
    if output == client or output.is_relative_to(client) or client.is_relative_to(output):
        raise ValueError('Repository and client directories must be separate.')
    if private.is_relative_to(output) or private.is_relative_to(client) or private.is_relative_to(packages_dir):
        raise ValueError('Private signing key must stay outside all publishable directories.')
    if private.stat().st_mode & 0o077:
        raise ValueError('Private key permissions must be 0600 or stricter.')
    expected_public = subprocess.check_output(['openssl', 'pkey', '-in', str(private), '-pubout'])
    actual_public = subprocess.check_output(['openssl', 'pkey', '-pubin', '-in', str(public), '-pubout'])
    if expected_public != actual_public:
        raise ValueError('Public and private keys do not match.')
    packages = sorted(packages_dir.glob('*.pkg'))
    if not packages:
        raise ValueError('No built .pkg packages found.')
    for package in packages:
        name = subprocess.check_output(['pkg', 'query', '-F', str(package), '%n'], text=True).strip()
        if name != 'os-ipmi-monitor':
            raise ValueError('Refusing to publish a package other than os-ipmi-monitor.')
    output.mkdir(parents=True)
    for package in packages:
        shutil.copy2(package, output / package.name)
    subprocess.run(['pkg', 'repo', str(output), str(private)], check=True)
    shutil.copy2(public, output / 'ipmi-monitor.pub')
    client.mkdir(parents=True)
    (client / 'ipmi-monitor.conf').write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    shutil.copy2(public, client / 'ipmi-monitor.pub')
    fingerprint = hashlib.sha256(public.read_bytes()).hexdigest()
    (client / 'PUBLIC-KEY-SHA256.txt').write_text(fingerprint + '  ipmi-monitor.pub\n', encoding='ascii')
    print('Repository to upload:', output)
    print('Client configuration:', client)
    print('Verify public key SHA256 out of band:', fingerprint)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
