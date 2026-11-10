#!/bin/sh
set -eu
[ "$#" -eq 0 ] || { echo 'Usage: sh scripts/uninstall.sh' >&2; exit 1; }
[ "$(uname -s)" = FreeBSD ] && [ "$(id -u)" = 0 ] || { echo 'Run as root on OPNsense' >&2; exit 1; }
/usr/local/sbin/pkg delete os-ipmi-monitor
