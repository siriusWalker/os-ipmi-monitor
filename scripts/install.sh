#!/bin/sh
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: sh scripts/install.sh /path/os-ipmi-monitor-VERSION.pkg' >&2; exit 1; }
[ "$(uname -s)" = FreeBSD ] && [ "$(id -u)" = 0 ] || { echo 'Run as root on OPNsense' >&2; exit 1; }
[ -f "$1" ] || { echo 'Package file not found' >&2; exit 1; }
name=$(/usr/local/sbin/pkg query -F "$1" '%n')
[ "$name" = os-ipmi-monitor ] || { echo 'Unexpected package name' >&2; exit 1; }
/usr/local/sbin/pkg info -e ipmitool >/dev/null || { echo 'Install ipmitool from the configured OPNsense repository first' >&2; exit 1; }
/usr/local/sbin/pkg add "$1"
