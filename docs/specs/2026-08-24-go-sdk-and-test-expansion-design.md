# Go SDK & Test Expansion Design Specification

**Date:** 2026-08-24  
**Status:** Approved  
**Go Package Location:** `sdks/go/paydeck`  
**Module Name:** `github.com/pisigmac/PayDeck/sdks/go/paydeck`  

---

## 1. Objectives

1. **Official Go SDK (`paydeck`)**: Provide an idiomatic, zero-external-dependency Go SDK (using standard `net/http`, `crypto/hmac`, `crypto/sha256`, `encoding/json`) with context support (`context.Context`), auto-retries, and HMAC webhook signature verification.
2. **Comprehensive Go Unit Tests**: Write unit tests (`sdks/go/paydeck/client_test.go`) covering order creation, verification, customer management, subscriptions, refunds, error parsing, and webhook signature verification using Go's `net/http/httptest` package.
3. **TypeScript Robustness Test Expansion**: Expand Vitest test suites (`tests/edge-cases.test.ts`) covering edge cases, malformed headers, max payload limits, SQL injection safety, rate limit resets, and boundary validations.

---

## 2. Go SDK Structure & API Contract

```go
package main

import (
    "context"
    "fmt"
    "github.com/pisigmac/PayDeck/sdks/go/paydeck"
)

func main() {
    client := paydeck.NewClient(paydeck.ClientOptions{
        BaseURL: "http://localhost:8787",
        APIKey:  "pd_live_123...",
        Retries: 3,
    })

    // Create Order
    order, err := client.CreateOrder(context.Background(), paydeck.CreateOrderInput{
        Plan:           "pro",
        IdempotencyKey: "ik_go_123",
    })
    if err != nil {
        log.Fatalf("CreateOrder error: %v", err)
    }

    // Verify Payment
    verified, err := client.VerifyPayment(context.Background(), paydeck.VerifyInput{
        RazorpayOrderID:   order.OrderID,
        RazorpayPaymentID: "pay_123",
        RazorpaySignature: "sig_hash",
    })

    // Verify Webhook Signature
    isValid := paydeck.VerifyWebhookSignature(bodyBytes, signatureHeader, "webhook_secret")
}
```
