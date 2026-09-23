import hmac
import hashlib
import json
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from paydeck import PayDeckClient, PayDeckAPIError, PayDeckError


class TestPayDeckPythonSDK(unittest.TestCase):
    def setUp(self):
        self.client = PayDeckClient(
            base_url="http://localhost:8787",
            api_key="pd_live_testkey123",
            admin_token="admin_secret",
            retries=1,
            timeout=5.0,
        )

    def test_verify_webhook_signature(self):
        secret = "whsec_test_secret_123"
        payload = json.dumps({"event": "payment.paid", "id": "pay_1"})
        expected_sig = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()

        self.assertTrue(PayDeckClient.verify_webhook_signature(payload, expected_sig, secret))
        self.assertFalse(PayDeckClient.verify_webhook_signature(payload, "invalid_sig", secret))
        self.assertFalse(PayDeckClient.verify_webhook_signature(payload, expected_sig, "wrong_secret"))

    @patch("urllib.request.urlopen")
    def test_create_order(self, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "id": "pay_100",
            "status": "created",
            "order_id": "order_rzp_100",
            "amount": 500,
            "currency": "INR",
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        res = self.client.create_order(plan="pro", idempotency_key="ik_test_1")
        self.assertEqual(res["id"], "pay_100")
        self.assertEqual(res["order_id"], "order_rzp_100")

    @patch("urllib.request.urlopen")
    def test_api_error_handling(self, mock_urlopen):
        error_body = json.dumps({
            "error": {
                "type": "invalid_request",
                "code": "VALIDATION_FAILED",
                "message": "Minimum 100 paise required",
                "request_id": "req_abc123",
            }
        }).encode("utf-8")

        err = urllib.error.HTTPError(
            url="http://localhost:8787/v1/orders",
            code=400,
            msg="Bad Request",
            hdrs={},
            fp=MagicMock(read=MagicMock(return_value=error_body)),
        )
        mock_urlopen.side_effect = err

        with self.assertRaises(PayDeckAPIError) as ctx:
            self.client.create_order(amount_paise=50)

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.error_code, "VALIDATION_FAILED")
        self.assertEqual(ctx.exception.request_id, "req_abc123")


if __name__ == "__main__":
    unittest.main()
