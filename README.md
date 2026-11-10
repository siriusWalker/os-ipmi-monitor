# os-ipmi-monitor

**A configurable IPMI dashboard widget for OPNsense, with optional fan-mode control.**

os-ipmi-monitor displays hardware readings and system information directly on the OPNsense dashboard. It discovers the sensors exposed by the local BMC through `ipmitool`, including temperatures, fan speeds, voltages, and other SDR readings. On supported Supermicro systems it also reads the current fan mode and PWM values. Monitoring is read-only. On the tested system, an authorized user can explicitly change the BMC fan mode. The widget does not set PWM values, reload firewall rules, or alter network configuration.

> **Project status:** IPMI reads and fan-mode writes have both been tested successfully through the dashboard on the test firewall, using a direct installation without a package. Native package building, installation, upgrade, removal, and repository distribution still need validation before a packaged release. There is no downloadable `.pkg` or official OPNsense repository entry yet.

## Screenshots

| List | Compact | Tiles |
| --- | --- | --- |
| ![IPMI Monitor list view](docs/images/os-ipmi-monitor-list.png) | ![IPMI Monitor compact view](docs/images/os-ipmi-monitor-compact.png) | ![IPMI Monitor tiles view](docs/images/os-ipmi-monitor-tiles.png) |

Configuration:

![IPMI Monitor options for display, hardware fields, sensors, groups, and labels](docs/images/os-ipmi-monitor-config.png)

The screenshots show the test firewall. Available sensors and values depend on the motherboard, BMC, connected fans, and installed hardware.

## Features

- Automatic discovery of the local BMC's SDR readings; a board profile never hides newly discovered sensors.
- Configurable list, compact, and tile presentations, with optional category separation and sensor status display.
- Configurable reading refresh interval: 2, 5, 10, 20, 30, 60, or 120 seconds.
- Sensor selection and customizable display labels: for example, show `CPU Temp` as `CPU` without changing the sensor name reported by the BMC.
- Calculated groups: combine compatible sensor readings into one displayed value using their mean, median, or maximum. For example, a fan group can summarize several fan speeds, while a memory group can summarize DIMM temperatures. Users can edit groups; selected Supermicro board profiles provide initial suggestions.
- Optional hardware identity fields from FRU, BMC, SMBIOS, and the FreeBSD processor model. These fields are not selected for display by default.
- Read-only Supermicro OEM readings for fan mode and two PWM zones. Support for other vendors' OEM readings is not implemented.
- An explicit fan-mode selector: click **Fan Mode**, choose a mode, and confirm. The available modes come from the board's XML profile; changing them requires a separate privilege. Read and write operations have been tested successfully on the test firewall.
- XML-based localization selected from the OPNsense dashboard language. English and French are the two languages currently supported.
- Access to readings through an authenticated OPNsense API and the `Diagnostics: IPMI read-only` privilege; fan-mode changes require `Diagnostics: IPMI fan control`.

The widget refreshes readings every 10 seconds by default. The interval can be changed in the widget options to 2, 5, 20, 30, 60, or 120 seconds. Short intervals may be limited by the time the BMC takes to respond; the widget does not start a second reading while one is in progress. The snapshot API contains sensor readings only. FRU, BMC, and system identity use a separate inventory API, loaded once when the widget starts and cached for one hour by configd. Missing or invalid readings are reported as unavailable; the widget can show or hide them.

## How it works

```text
OPNsense dashboard widget (Ipmimon.js)
    -> authenticated read APIs / separate fan-control API
    -> configd actions (snapshot / inventory / fan_mode.set)
    -> Python collector / fan-control command
    -> local ipmitool -I open / FreeBSD system information
    -> BMC and motherboard sensors
```

The **front end** is an OPNsense dashboard widget in `src/opnsense/www/js/widgets/Ipmimon.js`. It renders readings, hardware fields, groups, and the options dialog. Widget preferences, including selected sensors and labels, are handled by the dashboard. Localization currently uses XML catalogs in `src/opnsense/www/js/widgets/Locales/`: the widget selects `Ipmimon_fr_FR.xml` for a French dashboard and `Ipmimon_en_US.xml` otherwise. `Metadata/Ipmimon.xml` declares the widget metadata and English source strings. Only English and French catalogs are supplied today; integration with OPNsense's standard translation workflow remains future work.

The **back end** has authenticated PHP APIs, configd actions, and `src/opnsense/scripts/ipmimon/collector.py`. The snapshot action runs `ipmitool -I open sensor list` and returns structured readings. The separate inventory action reads `ipmitool -I open fru print`, `ipmitool -I open mc info`, and local FreeBSD system identifiers. The Supermicro provider contains the fixed OEM reads for fan mode and PWM readings, plus the FRU/BMC parsers. A separate command handles explicit fan-mode changes. Widget settings cannot supply shell commands or arbitrary IPMI arguments.

Board-specific initial sensor and group suggestions live in `src/opnsense/scripts/ipmimon/providers/supermicro_boards.xml`. Profiles cover selected A2SDi, X10SDV, X11SDV, and X12SDV models. A profile is chosen from FRU or SMBIOS identity when available. Suggestions are applied only when a widget has no saved choices, and only sensors actually reported by the BMC appear in a suggested group. Each profile also declares its supported fan-mode choices. Fan-zone membership is configured only where supported by board documentation or the test installation. Other boards and BMC firmware revisions need hardware verification.

The read API routes are `/api/ipmimon/snapshot/get` and `/api/ipmimon/snapshot/inventory`. Inventory may contain serial numbers and asset tags; grant the read-only privilege only to accounts that should see that information. The widget does not show those fields by default. The separate POST route `/api/ipmimon/fan/set` requires the fan-control privilege.

## Experimental fan-mode control

The test firewall's BMC offers Standard, Full Speed, Optimal, PUE2, and HeavyIO. The other board profiles contain conservative lists based on Supermicro documentation: the common modes Standard, Full Speed, and Optimal where documented, with HeavyIO limited to the listed dual-zone X10 models. X11SDV-TP8F lists only Standard and Full Speed because its manual describes Quiet without publishing an IPMI mode code. Their displayed labels come directly from the `name` attributes in `supermicro_boards.xml`; changing a label does not change its mode ID or IPMI code. Click the **Fan Mode** reading to open a selector, then confirm the change. The server checks the board identity and the XML mode list, applies one fixed OEM command, and reads the mode back. It does not change PWM duty cycles. Other profiles require a controlled test on their own BMC before relying on the write path.

Mode documentation: [Supermicro X10 mode availability](https://www.supermicro.com/en/support/faqs/faq.php?faq=16758), [Supermicro IPMICFG mode numbers 0–2](https://www.supermicro.com/en/support/faqs/faq.php?faq=35599), [X11SDV-TP8F manual](https://www.supermicro.com/manuals/motherboard/d/MNL-2007.pdf), and [X12 BMC guide](https://www.supermicro.com/manuals/other/BMC_Users_Guide_X12_H12.pdf). Supermicro notes that available fan modes vary by system. Mapping these documented mode numbers to the raw OEM command on the other boards is an inference, including HeavyIO code `04`; the sources do not confirm that command for each model.

## Test platform

The firewall used for integration testing runs OPNsense on a Supermicro A2SDi-TP8F motherboard. IPMI sensor and inventory reads, plus fan-mode writes through the dashboard, have succeeded on this gateway. The source was installed directly for testing; package installation has not yet been validated.

Tests on other platforms, including motherboards from other manufacturers, are welcome. When reporting results, please include the system and motherboard models, BMC firmware version, relevant hardware configuration (especially connected fans and cooling zones), and which readings and fan-mode changes worked or failed. If you adapted `supermicro_boards.xml` for a Supermicro system or added support for another manufacturer, please share the changes and the observations that support them. Remove serial numbers, asset tags, addresses, and credentials from reports before sharing them.

## Requirements

- An OPNsense version with the dashboard widget and MVC API paths used by this project.
- A local IPMI/BMC interface accessible to `ipmitool -I open` and the OPNsense `ipmitool` package.
- Python 3, PHP, and configd as supplied by the target OPNsense installation.

The plugin does not load the IPMI kernel driver. If `/dev/ipmi0` is absent, configure the `ipmi_load=YES` tunable in **System → Settings → Tunables** and check the device after a planned restart. A missing IPMI device does not prevent the UI from loading, but live readings will be unavailable.

## Installation and first use

**Current development installation:** Sources have been copied to a test gateway for direct testing. The deployment helper and connection details used for that gateway are deliberately kept under the Git-ignored `work/` directory and are not part of this repository's installation procedure.

**Future local package installation:** Once a package has been built and validated on a matching OPNsense release and architecture, install `ipmitool` from the configured OPNsense repository and, as root on the target system, run:

```sh
sh scripts/install.sh /path/to/os-ipmi-monitor-1.0.0.pkg
```

The installer checks the package name and then uses `pkg add` without forcing a replacement. If the target still has the earlier manually copied files, follow the migration steps in `scripts/legacy.py` before package installation; the package pre-install check refuses to overwrite unowned files. Keep a full OPNsense configuration backup and record the backup directory created by the migration tool.

After installation, reconnect to the web interface, grant **Diagnostics: IPMI read-only** to the intended users, and add **IPMI Monitor** to the dashboard. Grant **Diagnostics: IPMI fan control** separately to users who may change the fan mode. Check the options dialog to select sensors, hardware fields, groups, display style, and labels. The command `configctl ipmimon snapshot` provides a direct read-only check from the OPNsense shell; `configctl ipmimon inventory` checks the separate inventory path.

For package removal, use the OPNsense package interface or `pkg delete os-ipmi-monitor`. The package removal hook restarts configd; it does not remove saved dashboard preferences or IPMI driver tunables. Package lifecycle behavior still needs end-to-end testing.

## Building the package

Packaging is prepared around the official [OPNsense plugins framework](https://github.com/opnsense/plugins/blob/master/Mk/plugins.mk). Build on an isolated FreeBSD/OPNsense system matching the intended release and architecture, with an official `opnsense/plugins` checkout, the required build tools, and `ipmitool` already installed. Do not build on a production firewall.

From this repository's root, as root on the build system:

```sh
python3 -B scripts/build_package.py \
  --plugins-tree /usr/plugins \
  --maintainer 'MAINTAINER_EMAIL' \
  --website 'https://PROJECT_URL' \
  --license LICENSE_ID
```

Replace the metadata placeholders with real values. A license identifier and the corresponding license text must be chosen before distribution; this repository does not choose one implicitly. The build script runs Python tests and PHP syntax checking, stages the plugin under the official plugins tree, and invokes `make package`. It refuses to overwrite an existing staged plugin directory. The expected output is under `dist/packages/`, which is ignored by Git. `VERSION` and `PLUGIN_VERSION` in `Makefile` must be updated together for a new release.

A built package alone does not make the plugin available in OPNsense's package manager. Repository publication requires a signed `pkg` catalog, HTTPS hosting, and explicit repository configuration on clients. See [Publishing and signed repository preparation](docs/PUBLISHING.md). This publication flow has not yet been exercised for a release.

## Development checks

```sh
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_dynamic.mjs
php -l src/opnsense/mvc/app/controllers/OPNsense/Ipmimon/Api/SnapshotController.php
```

The latest source staging on the test gateway completed 32 Python tests and the PHP syntax check. Staging checks the source without installing it; read and write integration tests were performed separately through the active dashboard and BMC. Package build and lifecycle tests remain open.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/opnsense/www/js/widgets/` | Dashboard widget, metadata, and English/French catalogs |
| `src/opnsense/mvc/` | Authenticated API and access privilege |
| `src/opnsense/service/conf/actions.d/` | configd actions and cache durations |
| `src/opnsense/scripts/ipmimon/` | Collector, Supermicro provider, and board profiles |
| `scripts/` | Package build, local install/removal, legacy migration, and repository preparation |
| `tests/` | Collector, widget, and packaging checks |
| `docs/PUBLISHING.md` | Detailed signed-repository workflow |

The OPNsense package name is `os-ipmi-monitor`; the internal widget and API namespace is `Ipmimon`.
