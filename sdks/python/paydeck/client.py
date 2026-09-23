import hmac
import hashlib
import json
import time
import urllib.request
import urllib.error
import urllib.parse
from typing import Any, Dict, List, Optional, Union

from paydeck.exceptions import PayDeckAPIError, PayDeckError


class PayDeckClient:
    """Official Python SDK client for PayDeck billing microservice."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        admin_token: Optional[str] = None,
        timeout: float = 30.0,
        retries: int = 3,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.admin_token = admin_token
        self.timeout = timeout
        self.retries = retries

    def _headers(self, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "PayDeck-Python-SDK/1.0.0",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.admin_token:
            headers["X-Admin-Token"] = self.admin_token
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            if query:
                url = f"{url}?{query}"

        body_bytes = None
        if data is not None:
            body_bytes = json.dumps(data).encode("utf-8")

        headers = self._headers(idempotency_key=idempotency_key)
        attempt = 0

        while True:
            attempt += 1
            req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method.upper())

            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp_data = resp.read().decode("utf-8")
                    return json.loads(resp_data) if resp_data else {}

            except urllib.error.HTTPError as e:
                resp_data = e.read().decode("utf-8") if e.fp else ""
                parsed_error = {}
                try:
                    parsed_error = json.loads(resp_data) if resp_data else {}
                except Exception:
                    pass

                # Extract standard error envelope fields
                err_obj = parsed_error.get("error", {})
                if isinstance(err_obj, str):
                    error_msg = err_obj
                    error_code = "API_ERROR"
                    details = []
                    request_id = parsed_error.get("request_id")
                elif isinstance(err_obj, dict):
                    error_msg = err_obj.get("message") or err_obj.get("type") or "API Error"
                    error_code = err_obj.get("code") or err_obj.get("type") or "API_ERROR"
                    details = err_obj.get("details", [])
                    request_id = err_obj.get("request_id") or parsed_error.get("request_id")
                else:
                    error_msg = e.reason or str(e)
                    error_code = f"HTTP_{e.code}"
                    details = []
                    request_id = None

                # Retry on 429 rate limit or 5xx server error
                if e.code in (429, 500, 502, 503, 504) and attempt <= self.retries:
                    delay = 0.1 * (2 ** (attempt - 1))
                    time.sleep(delay)
                    continue

                raise PayDeckAPIError(
                    message=error_msg,
                    status_code=e.code,
                    error_code=error_code,
                    details=details,
                    request_id=request_id,
                ) from e

            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt <= self.retries:
                    delay = 0.1 * (2 ** (attempt - 1))
                    time.sleep(delay)
                    continue
                raise PayDeckError(f"Network error communicating with PayDeck: {e}") from e

    # --- Consumer Billing Methods ---

    def create_order(
        self,
        plan: Optional[str] = None,
        amount_paise: Optional[int] = None,
        currency: str = "INR",
        receipt: Optional[str] = None,
        notes: Optional[Dict[str, str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        description: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        customer_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"currency": currency}
        if plan:
            payload["plan"] = plan
        if amount_paise is not None:
            payload["amount_paise"] = amount_paise
        if receipt:
            payload["receipt"] = receipt
        if notes:
            payload["notes"] = notes
        if metadata:
            payload["metadata"] = metadata
        if description:
            payload["description"] = description
        if customer_id:
            payload["customer_id"] = customer_id

        return self._request("POST", "/v1/orders", data=payload, idempotency_key=idempotency_key)

    def verify(
        self,
        razorpay_order_id: str,
        razorpay_payment_id: str,
        razorpay_signature: str,
    ) -> Dict[str, Any]:
        payload = {
            "razorpay_order_id": razorpay_order_id,
            "razorpay_payment_id": razorpay_payment_id,
            "razorpay_signature": razorpay_signature,
        }
        return self._request("POST", "/v1/verify", data=payload)

    def get_payment(self, payment_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/payments/{urllib.parse.quote(payment_id)}")

    def list_payments(self, limit: int = 25, offset: int = 0) -> Dict[str, Any]:
        return self._request("GET", "/v1/payments", params={"limit": limit, "offset": offset})

    def list_plans(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/plans")

    def refund_payment(
        self,
        payment_id: str,
        amount_paise: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if amount_paise is not None:
            payload["amount_paise"] = amount_paise
        if reason:
            payload["reason"] = reason
        return self._request("POST", f"/v1/payments/{urllib.parse.quote(payment_id)}/refund", data=payload)

    # --- Customer Domain Methods ---

    def create_customer(
        self,
        email: Optional[str] = None,
        name: Optional[str] = None,
        external_user_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        if email:
            payload["email"] = email
        if name:
            payload["name"] = name
        if external_user_id:
            payload["external_user_id"] = external_user_id
        if metadata:
            payload["metadata"] = metadata
        return self._request("POST", "/v1/customers", data=payload)

    def list_customers(self, limit: int = 25, offset: int = 0) -> Dict[str, Any]:
        return self._request("GET", "/v1/customers", params={"limit": limit, "offset": offset})

    def list_customer_payments(self, customer_id: str, limit: int = 25, offset: int = 0) -> Dict[str, Any]:
        return self._request("GET", f"/v1/customers/{urllib.parse.quote(customer_id)}/payments", params={"limit": limit, "offset": offset})

    # --- Subscription Methods ---

    def create_subscription(
        self,
        customer_id: str,
        plan_id: str,
        period_days: int = 30,
    ) -> Dict[str, Any]:
        payload = {
            "customer_id": customer_id,
            "plan_id": plan_id,
            "period_days": period_days,
        }
        return self._request("POST", "/v1/subscriptions", data=payload)

    def list_subscriptions(self, limit: int = 25, offset: int = 0, customer_id: Optional[str] = None) -> Dict[str, Any]:
        params = {"limit": limit, "offset": offset}
        if customer_id:
            params["customer_id"] = customer_id
        return self._request("GET", "/v1/subscriptions", params=params)

    def cancel_subscription(self, subscription_id: str, immediately: bool = True) -> Dict[str, Any]:
        return self._request("POST", f"/v1/subscriptions/{urllib.parse.quote(subscription_id)}/cancel", data={"immediately": immediately})

    # --- Admin Methods ---

    def create_product(self, slug: str, name: str, rate_limit_per_hour: int = 200) -> Dict[str, Any]:
        payload = {"slug": slug, "name": name, "rate_limit_per_hour": rate_limit_per_hour}
        return self._request("POST", "/v1/admin/products", data=payload)

    def list_products(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/admin/products")

    def mint_key(self, slug: str, name: Optional[str] = None, environment: str = "live") -> Dict[str, Any]:
        payload: Dict[str, Any] = {"environment": environment}
        if name:
            payload["name"] = name
        return self._request("POST", f"/v1/admin/products/{urllib.parse.quote(slug)}/keys", data=payload)

    def revoke_key(self, slug: str, key_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/v1/admin/products/{urllib.parse.quote(slug)}/keys/{urllib.parse.quote(key_id)}/revoke")

    def create_plan(
        self,
        slug: str,
        plan_slug: str,
        name: str,
        amount_paise: int,
        currency: str = "INR",
        interval: str = "month",
    ) -> Dict[str, Any]:
        payload = {
            "slug": plan_slug,
            "name": name,
            "amount_paise": amount_paise,
            "currency": currency,
            "interval": interval,
        }
        return self._request("POST", f"/v1/admin/products/{urllib.parse.quote(slug)}/plans", data=payload)

    def list_audit_logs(
        self,
        limit: int = 25,
        offset: int = 0,
        product_id: Optional[str] = None,
        action: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit, "offset": offset}
        if product_id:
            params["product_id"] = product_id
        if action:
            params["action"] = action
        return self._request("GET", "/v1/admin/audit-logs", params=params)

    def list_webhooks(
        self,
        limit: int = 25,
        offset: int = 0,
        status: Optional[str] = None,
        product_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status
        if product_id:
            params["product_id"] = product_id
        return self._request("GET", "/v1/admin/webhooks", params=params)

    def redeliver_webhook(self, delivery_id: str) -> Dict[str, Any]:
        return self._request("POST", f"/v1/admin/webhooks/{urllib.parse.quote(delivery_id)}/redeliver")

    # --- Static Helpers ---

    @staticmethod
    def verify_webhook_signature(
        payload: Union[str, bytes],
        signature: str,
        secret: str,
    ) -> bool:
        """Statically verify downstream HMAC-SHA256 PayDeck webhook signatures."""
        if not signature or not secret:
            return False

        if isinstance(payload, str):
            payload_bytes = payload.encode("utf-8")
        else:
            payload_bytes = payload

        expected_sig = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected_sig.lower(), signature.strip().lower())
