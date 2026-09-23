# Python SDK Design Specification

**Date:** 2026-08-24  
**Status:** Approved  
**Package Name:** `paydeck`  
**Target Location:** `sdks/python/`  
**Dependencies:** Zero third-party runtime dependencies (uses Python standard library `urllib.request`, `json`, `hmac`, `hashlib`, `ssl`). Optional `requests` support if installed.  

---

## 1. Objectives

1. **Idiomatic Python SDK**: Provide a clean, typed Python SDK for backend applications (Django, FastAPI, Flask, script utilities) interacting with PayDeck.
2. **Zero Hard Dependencies**: Rely entirely on Python standard library (`urllib.request`, `json`, `hmac`, `hashlib`) so it can be installed in any Python 3.8+ environment without dependency conflicts.
3. **Resilience & Auto-Retries**: Exponential backoff retry logic on network glitches, 429 rate limits, and 5xx server responses.
4. **Complete Feature Parity**: Match 100% of TypeScript `PayDeckClient` features including order creation, verification, refunds, customers, subscriptions, admin controls, and static HMAC webhook signature verification.

---

## 2. API Contract & Methods

```python
from paydeck import PayDeckClient, PayDeckError

client = PayDeckClient(
    base_url="http://localhost:8787",
    api_key="pd_live_...",
    admin_token="admin_secret",  # Optional
    retries=3,
    timeout=30.0,
)

# Consumer Methods
order = client.create_order(plan="pro", idempotency_key="ik_123")
verified = client.verify(razorpay_order_id="...", razorpay_payment_id="...", razorpay_signature="...")
payment = client.get_payment("pay_123")
payments = client.list_payments(limit=25, offset=0)
plans = client.list_plans()
refund = client.refund_payment("pay_123", amount_paise=500, reason="Customer request")

# Customer & Subscription Methods
customer = client.create_customer(email="user@example.com", name="Jane Doe", external_user_id="usr_100")
customers = client.list_customers(limit=25, offset=0)
subscription = client.create_subscription(customer_id=customer["id"], plan_id="plan_pro_month")
canceled = client.cancel_subscription(subscription["id"], immediately=True)

# Webhook Signature Verification (Static Helper)
is_valid = PayDeckClient.verify_webhook_signature(
    payload=raw_body_str_or_bytes,
    signature=headers.get("X-PayDeck-Signature"),
    secret="webhook_secret_123",
)
```
