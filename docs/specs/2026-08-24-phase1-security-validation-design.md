# Phase 1: Security & Input Validation Design Document

**Date:** 2026-08-24  
**Status:** Approved  
**Scope:** Phase 1 P0 Security, Input Validation (Zod), Standard Error Envelopes, CORS Allowlisting, Rate-Limit Headers, and Fail-Closed Webhooks.

---

## 1. Objectives

1. **Structured Input Validation (Zod)**: Replace ad-hoc manual JSON parsing with strict Zod schemas for all request bodies in orders, verify, product, key, and plan management.
2. **Unified Error Envelope**: Guarantee every error response returns a consistent JSON envelope with stable error codes and a unique `request_id`.
3. **CORS & Security Headers**: Allow configurable allowed origins and add essential security headers (`X-Content-Type-Options`, `X-Frame-Options`, `HSTS`).
4. **Rate Limit Headers**: Return standard rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`) on all product API requests.
5. **Fail-Closed Webhook Verification**: Fail closed with 401/400 if webhook signature is invalid or header is missing when `RAZORPAY_WEBHOOK_SECRET` is set.

---

## 2. Component Design & Specifications

### A. Request ID & Standard Error Envelope
Every incoming request receives a unique `request_id` (`req_<hex>`).

**Standard Error JSON Schema:**
```json
{
  "error": "invalid_request",
  "code": "VALIDATION_FAILED",
  "message": "Invalid request body parameters",
  "request_id": "req_a1b2c3d4e5f67890",
  "details": [
    { "field": "amount_paise", "message": "Expected integer >= 100" }
  ]
}
```

### B. Zod Request Schemas (`src/core/validation.ts`)
- **`CreateOrderSchema`**:
  - `plan`: optional string
  - `amount_paise`: optional integer >= 100
  - `currency`: optional string ('INR')
  - `receipt`: optional string <= 40 chars
  - `notes`: optional Record<string, string>
  - `metadata`: optional Record<string, unknown>
  - `description`: optional string
- **`VerifyRequestSchema`**:
  - `razorpay_order_id`: string (non-empty)
  - `razorpay_payment_id`: string (non-empty)
  - `razorpay_signature`: string (non-empty)
- **`CreateProductSchema`**:
  - `slug`: string (regex `/^[a-z0-9][a-z0-9_-]{1,63}$/`)
  - `name`: string (non-empty)
  - `rate_limit_per_hour`: optional integer 1 to 100,000 (default 200)
- **`CreatePlanSchema`**:
  - `slug`: string (regex `/^[a-z0-9][a-z0-9_-]{0,63}$/`)
  - `name`: string (non-empty)
  - `amount_paise`: integer >= 100
  - `currency`: optional string ('INR')
  - `interval`: string ('month' | 'year' | 'one_time')
- **`CreateKeySchema`**:
  - `name`: optional string
  - `environment`: optional string ('live' | 'test')

### C. Configurable CORS & Security Headers Middleware (`src/middleware/security.ts`)
- `config.allowedOrigins` (default: `*`, configurable via `ALLOWED_ORIGINS` env or `paydeck.yaml`).
- Security Headers added to all responses:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`

### D. Rate Limit Headers (`src/policy.ts`)
When product key middleware passes, add rate limit headers to `c.header(...)`:
- `X-RateLimit-Limit: <limit>`
- `X-RateLimit-Remaining: <remaining>`
- On 429: `Retry-After: <seconds_until_next_utc_hour>`

### E. Webhook Fail-Closed Behavior (`src/routes/webhooks.ts`)
When `config.razorpayWebhookSecret` is present:
- If `X-Razorpay-Signature` header is missing: return `401 Unauthorized` with `MISSING_WEBHOOK_SIGNATURE`.
- If signature check fails: return `400 Bad Request` with `INVALID_WEBHOOK_SIGNATURE`.
