package paydeck_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pisigmac/PayDeck/sdks/go/paydeck"
)

func TestVerifyWebhookSignature(t *testing.T) {
	secret := "whsec_go_secret_123"
	payload := []byte(`{"event":"payment.paid","data":{"id":"pay_1"}}`)

	// Compute expected signature dynamically
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	sig := hex.EncodeToString(mac.Sum(nil))

	if !paydeck.VerifyWebhookSignature(payload, sig, secret) {
		t.Errorf("expected signature to be valid")
	}

	if paydeck.VerifyWebhookSignature(payload, "invalid_sig", secret) {
		t.Errorf("expected invalid signature to fail")
	}
}

func TestCreateOrder(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/orders" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer pd_live_test" {
			t.Errorf("missing or invalid authorization header")
		}
		if r.Header.Get("Idempotency-Key") != "ik_test_go" {
			t.Errorf("missing idempotency header")
		}

		res := paydeck.OrderResult{
			ID:       "pay_100",
			Status:   "created",
			OrderID:  "order_100",
			Amount:   500,
			Currency: "USD",
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(res)
	}))
	defer ts.Close()

	client := paydeck.NewClient(paydeck.ClientOptions{
		BaseURL: ts.URL,
		APIKey:  "pd_live_test",
	})

	order, err := client.CreateOrder(context.Background(), paydeck.CreateOrderInput{
		AmountPaise:    500,
		Currency:       "USD",
		IdempotencyKey: "ik_test_go",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if order.ID != "pay_100" || order.Currency != "USD" {
		t.Errorf("unexpected order output: %+v", order)
	}
}

func TestAPIErrorParsing(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{
			"error": {
				"type": "invalid_request",
				"code": "VALIDATION_FAILED",
				"message": "Invalid amount",
				"request_id": "req_go_123"
			}
		}`))
	}))
	defer ts.Close()

	client := paydeck.NewClient(paydeck.ClientOptions{
		BaseURL: ts.URL,
		APIKey:  "pd_live_test",
		Retries: 1,
	})

	_, err := client.CreateOrder(context.Background(), paydeck.CreateOrderInput{AmountPaise: -5})
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	apiErr, ok := err.(*paydeck.APIError)
	if !ok {
		t.Fatalf("expected *paydeck.APIError, got %T", err)
	}

	if apiErr.StatusCode != 400 || apiErr.Code != "VALIDATION_FAILED" || apiErr.RequestID != "req_go_123" {
		t.Errorf("unexpected api error content: %+v", apiErr)
	}
}
