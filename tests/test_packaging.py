import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_package
import legacy
import publish_repository


class PackagingTests(unittest.TestCase):
    def test_source_inventory(self):
        inventory = {str(path.relative_to(ROOT / 'src')) for path in (ROOT / 'src').rglob('*') if path.is_file()}
        provider_files = {
            'opnsense/scripts/ipmimon/providers/__init__.py',
            'opnsense/scripts/ipmimon/providers/supermicro.py',
            'opnsense/scripts/ipmimon/providers/supermicro_boards.xml',
            'opnsense/www/js/widgets/Locales/Ipmimon_en_US.xml',
            'opnsense/www/js/widgets/Locales/Ipmimon_fr_FR.xml',
        }
        self.assertEqual(inventory, set(legacy.PATHS) | provider_files)
        self.assertTrue(provider_files.isdisjoint(legacy.PATHS))
        pre_install = (ROOT / '+PRE_INSTALL').read_text()
        self.assertTrue(all(path in pre_install for path in inventory))
        self.assertIn('PLUGIN_VERSION=        ' + (ROOT / 'VERSION').read_text().strip(), (ROOT / 'Makefile').read_text())

    def test_inventory_endpoint_uses_existing_acl(self):
        route = 'api/ipmimon/snapshot/inventory'
        acl = (ROOT / 'src/opnsense/mvc/app/models/OPNsense/Ipmimon/ACL/ACL.xml').read_text()
        metadata = (ROOT / 'src/opnsense/www/js/widgets/Metadata/Ipmimon.xml').read_text()
        actions = (ROOT / 'src/opnsense/service/conf/actions.d/actions_ipmimon.conf').read_text()
        self.assertIn('<pattern>' + route + '</pattern>', acl)
        self.assertIn('<endpoint>/' + route + '</endpoint>', metadata)
        self.assertIn('[inventory]\ncommand:/usr/local/bin/python3 /usr/local/opnsense/scripts/ipmimon/collector.py inventory\nparameters:', actions)

    def test_native_staging_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            tree = pathlib.Path(folder)
            (tree / 'Mk').mkdir()
            (tree / 'Mk/plugins.mk').write_text('')
            (tree / 'Templates').mkdir()
            staged = build_package.stage_plugin(tree)
            self.assertEqual((staged / 'src/opnsense/www/js/widgets/Ipmimon.js').read_bytes(), (ROOT / 'src/opnsense/www/js/widgets/Ipmimon.js').read_bytes())
            self.assertEqual((staged / 'src/opnsense/scripts/ipmimon/providers/supermicro.py').read_bytes(),
                             (ROOT / 'src/opnsense/scripts/ipmimon/providers/supermicro.py').read_bytes())
            with self.assertRaises(ValueError):
                build_package.stage_plugin(tree)

    def test_legacy_backup_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            prefix = root / 'prefix'
            original = prefix / legacy.PATHS[0]
            original.parent.mkdir(parents=True)
            original.write_bytes(b'old standalone content')
            with patch('legacy.subprocess.run', return_value=subprocess.CompletedProcess([], 1)):
                backup = legacy.detach(prefix, root / 'backups')
            self.assertFalse(original.exists())
            legacy.restore(prefix, backup)
            self.assertEqual(original.read_bytes(), b'old standalone content')
            with self.assertRaises(ValueError):
                legacy.restore(prefix, backup)

    def test_managed_files_not_detached(self):
        with tempfile.TemporaryDirectory() as folder:
            prefix = pathlib.Path(folder)
            original = prefix / legacy.PATHS[0]
            original.parent.mkdir(parents=True)
            original.write_bytes(b'managed')
            with patch('legacy.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout='os-ipmi-monitor-1.0.0')):
                with self.assertRaises(ValueError):
                    legacy.inspect_files(prefix)
            self.assertTrue(original.exists())

    def test_pkg_database_error_not_detached(self):
        with tempfile.TemporaryDirectory() as folder:
            prefix = pathlib.Path(folder)
            original = prefix / legacy.PATHS[0]
            original.parent.mkdir(parents=True)
            original.write_bytes(b'keep')
            with patch('legacy.subprocess.run', return_value=subprocess.CompletedProcess([], 1, stdout='', stderr='database locked')):
                with self.assertRaises(ValueError):
                    legacy.inspect_files(prefix)
            self.assertTrue(original.exists())

    def test_tampered_backup_not_restored(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            prefix = root / 'prefix'
            original = prefix / legacy.PATHS[0]
            original.parent.mkdir(parents=True)
            original.write_bytes(b'original')
            with patch('legacy.subprocess.run', return_value=subprocess.CompletedProcess([], 1)):
                backup = legacy.detach(prefix, root / 'backups')
            (backup / legacy.PATHS[0]).write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                legacy.restore(prefix, backup)
            self.assertFalse(original.exists())

    def test_signatures_required(self):
        repo = publish_repository.client_config('https://packages.example.invalid/opnsense/26.7/amd64')['ipmi-monitor']
        self.assertEqual(repo['signature_type'], 'pubkey')
        self.assertTrue(repo['enabled'])
        for website in ('http://example.invalid', 'https://example.invalid/$(command)', 'https://example.invalid/`command`'):
            with self.assertRaises(ValueError):
                publish_repository.client_config(website)


if __name__ == '__main__':
    unittest.main()
