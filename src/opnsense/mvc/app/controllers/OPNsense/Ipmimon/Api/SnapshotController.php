<?php
namespace OPNsense\Ipmimon\Api;

use OPNsense\Base\ApiControllerBase;
use OPNsense\Core\Backend;

class SnapshotController extends ApiControllerBase
{
    private function runAction(string $action, string $resultKey): array
    {
        try {
            $data = json_decode((new Backend())->configdRun('ipmimon ' . $action), true);
            if (is_array($data) && isset($data[$resultKey], $data['errors'], $data['status'])) {
                return $data;
            }
        } catch (\Throwable $exception) {
        }
        $empty = $resultKey === 'rows' ? [] : ['fru' => [], 'bmc' => [], 'processor' => ['model' => null],
                'motherboard' => ['product' => null], 'system' => ['name' => null], 'profile' => null];
        return [$resultKey => $empty,
                'errors' => ['ipmi_collector_unavailable'], 'status' => 'error'];
    }

    public function getAction()
    {
        return $this->runAction('snapshot', 'rows');
    }

    public function inventoryAction()
    {
        return $this->runAction('inventory', 'inventory');
    }
}
