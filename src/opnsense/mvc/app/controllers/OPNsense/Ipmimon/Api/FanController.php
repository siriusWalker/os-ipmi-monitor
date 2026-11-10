<?php
namespace OPNsense\Ipmimon\Api;

use OPNsense\Base\ApiControllerBase;
use OPNsense\Core\Backend;

class FanController extends ApiControllerBase
{
    public function setAction(): array
    {
        if (!$this->request->isPost()) {
            $this->response->setStatusCode(405, 'Method Not Allowed');
            return ['status' => 'error', 'error' => 'post_required'];
        }
        $mode = $this->request->getPost('mode', null, '');
        if (!is_string($mode) || !preg_match('/^[a-z][a-z0-9_]{0,31}$/D', $mode)) {
            $this->response->setStatusCode(400, 'Bad Request');
            return ['status' => 'error', 'error' => 'invalid_mode'];
        }
        try {
            $result = json_decode((new Backend())->configdRun('ipmimon fan_mode set ' . $mode), true);
            if (is_array($result) && isset($result['status']) && in_array($result['status'], ['ok', 'error'], true)) {
                return $result;
            }
        } catch (\Throwable $exception) {
        }
        return ['status' => 'error', 'error' => 'fan_control_unavailable'];
    }
}
