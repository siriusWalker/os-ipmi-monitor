PLUGIN_NAME=           ipmi-monitor
PLUGIN_VERSION=        1.0.0
PLUGIN_COMMENT=        Read-only IPMI dashboard monitoring
PLUGIN_DEPENDS=        ipmitool

.if !defined(PLUGIN_MAINTAINER) || !defined(PLUGIN_WWW) || !defined(PLUGIN_LICENSE)
.error "Set PLUGIN_MAINTAINER, PLUGIN_WWW and PLUGIN_LICENSE; see scripts/build_package.py"
.endif

.include "../../Mk/plugins.mk"
