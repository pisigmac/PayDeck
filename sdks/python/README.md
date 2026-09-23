# PayDeck Python SDK

Official Python SDK for the [PayDeck](https://github.com/pisigmac/PayDeck) generic billing microservice. Zero third-party runtime dependencies (uses standard library `urllib`, `json`, `hmac`, `hashlib`).

## Installation

```bash
pip install paydeck
```

## Quickstart

```python
from paydeck import PayDeckClient, PayDeckAPIError

# Initialize client with product API key
client = PayDeckClient(
    base_url="http://localhost:8787",
    api_key="pd_live_1234567890abcdef...",
    retries=3,
)

# 1. Create an order for a plan or custom amount
order = client.create_order(
    plan="pro",
    idempotency_key="unique_checkout_session_456"
)
print(f"Order Created: {order['order_id']}, PayDeck ID: {order['id']}")

# 2. Verify payment HMAC signature after gateway checkout
verified = client.verify(
    razorpay_order_id=order['order_id'],
    razorpay_payment_id="pay_999888777",
    razorpay_signature="signature_hash..."
)
print(f"Payment Status: {verified['payment']['status']}")

# 3. Create a Customer & Subscription
customer = client.create_customer(email="dev@example.com", name="Jane Developer", external_user_id="usr_42")
subscription = client.create_subscription(customer_id=customer["id"], plan_id="plan_pro_month")

# 4. Verify Downstream Webhook Signatures (Static Method)
is_valid = PayDeckClient.verify_webhook_signature(
    payload=raw_body_bytes_or_str,
    signature=request_headers.get("X-PayDeck-Signature"),
    secret="your_product_webhook_secret"
)
```

## Admin Management

```python
admin_client = PayDeckClient(
    base_url="http://localhost:8787",
    admin_token="admin_secret_token",
)

# Create Product
product = admin_client.create_product(slug="formrelay", name="FormRelay SaaS")

# Mint Product API Key
key = admin_client.mint_key(slug="formrelay", name="Production Worker Key", environment="live")
print(f"New Key: {key['key']}")
```
