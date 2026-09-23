package paydeck

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type ClientOptions struct {
	BaseURL    string
	APIKey     string
	AdminToken string
	HTTPClient *http.Client
	Retries    int
	Timeout    time.Duration
}

type Client struct {
	baseURL    string
	apiKey     string
	adminToken string
	httpClient *http.Client
	retries    int
	timeout    time.Duration
}

func NewClient(opts ClientOptions) *Client {
	baseURL := strings.TrimRight(opts.BaseURL, "/")
	httpClient := opts.HTTPClient
	if httpClient == nil {
		timeout := opts.Timeout
		if timeout == 0 {
			timeout = 30 * time.Second
		}
		httpClient = &http.Client{Timeout: timeout}
	}
	retries := opts.Retries
	if retries <= 0 {
		retries = 3
	}

	return &Client{
		baseURL:    baseURL,
		apiKey:     opts.APIKey,
		adminToken: opts.AdminToken,
		httpClient: httpClient,
		retries:    retries,
		timeout:    opts.Timeout,
	}
}

func (c *Client) request(ctx context.Context, method, path string, query url.Values, body interface{}, idempotencyKey string, res interface{}) error {
	reqURL := fmt.Sprintf("%s%s", c.baseURL, path)
	if len(query) > 0 {
		reqURL = fmt.Sprintf("%s?%s", reqURL, query.Encode())
	}

	var bodyBytes []byte
	var err error
	if body != nil {
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to marshal request body: %w", err)
		}
	}

	attempt := 0
	for {
		attempt++
		var bodyReader io.Reader
		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}

		req, err := http.NewRequestWithContext(ctx, method, reqURL, bodyReader)
		if err != nil {
			return fmt.Errorf("failed to create request: %w", err)
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "PayDeck-Go-SDK/1.0.0")
		if c.apiKey != "" {
			req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.apiKey))
		}
		if c.adminToken != "" {
			req.Header.Set("X-Admin-Token", c.adminToken)
		}
		if idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", idempotencyKey)
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			if attempt <= c.retries {
				time.Sleep(time.Duration(100*math.Pow(2, float64(attempt-1))) * time.Millisecond)
				continue
			}
			return fmt.Errorf("network request failed: %w", err)
		}

		respBytes, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("failed to read response body: %w", err)
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if res != nil && len(respBytes) > 0 {
				if err := json.Unmarshal(respBytes, res); err != nil {
					return fmt.Errorf("failed to unmarshal response payload: %w", err)
				}
			}
			return nil
		}

		// Handle retryable status codes (429, 500, 502, 503, 504)
		if (resp.StatusCode == 429 || resp.StatusCode >= 500) && attempt <= c.retries {
			time.Sleep(time.Duration(100*math.Pow(2, float64(attempt-1))) * time.Millisecond)
			continue
		}

		// Parse error envelope
		apiErr := &APIError{StatusCode: resp.StatusCode, Code: "API_ERROR", Message: resp.Status}
		var errEnvelope struct {
			Error interface{} `json:"error"`
		}
		if err := json.Unmarshal(respBytes, &errEnvelope); err == nil {
			if errMap, ok := errEnvelope.Error.(map[string]interface{}); ok {
				if code, ok := errMap["code"].(string); ok {
					apiErr.Code = code
				} else if errType, ok := errMap["type"].(string); ok {
					apiErr.Code = errType
				}
				if msg, ok := errMap["message"].(string); ok {
					apiErr.Message = msg
				}
				if reqID, ok := errMap["request_id"].(string); ok {
					apiErr.RequestID = reqID
				}
			} else if errStr, ok := errEnvelope.Error.(string); ok {
				apiErr.Message = errStr
			}
		}

		return apiErr
	}
}

// CreateOrder creates a payment order.
func (c *Client) CreateOrder(ctx context.Context, input CreateOrderInput) (*OrderResult, error) {
	var result OrderResult
	err := c.request(ctx, "POST", "/v1/orders", nil, input, input.IdempotencyKey, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// VerifyPayment verifies payment signature.
func (c *Client) VerifyPayment(ctx context.Context, input VerifyInput) (*VerifyResult, error) {
	var result VerifyResult
	err := c.request(ctx, "POST", "/v1/verify", nil, input, "", &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// GetPayment gets payment details.
func (c *Client) GetPayment(ctx context.Context, id string) (*Payment, error) {
	var payment Payment
	err := c.request(ctx, "GET", fmt.Sprintf("/v1/payments/%s", url.PathEscape(id)), nil, nil, "", &payment)
	if err != nil {
		return nil, err
	}
	return &payment, nil
}

// ListPayments lists payments with pagination.
func (c *Client) ListPayments(ctx context.Context, limit, offset int) (*ListPaymentsResult, error) {
	q := url.Values{}
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))

	var result ListPaymentsResult
	err := c.request(ctx, "GET", "/v1/payments", q, nil, "", &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// RefundPayment issues a full or partial refund.
func (c *Client) RefundPayment(ctx context.Context, id string, input RefundInput) (*RefundResult, error) {
	var result RefundResult
	err := c.request(ctx, "POST", fmt.Sprintf("/v1/payments/%s/refund", url.PathEscape(id)), nil, input, "", &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// CreateCustomer creates or upserts a customer.
func (c *Client) CreateCustomer(ctx context.Context, input CreateCustomerInput) (*Customer, error) {
	var customer Customer
	err := c.request(ctx, "POST", "/v1/customers", nil, input, "", &customer)
	if err != nil {
		return nil, err
	}
	return &customer, nil
}

// ListCustomers lists product customers.
func (c *Client) ListCustomers(ctx context.Context, limit, offset int) (*ListCustomersResult, error) {
	q := url.Values{}
	q.Set("limit", strconv.Itoa(limit))
	q.Set("offset", strconv.Itoa(offset))

	var result ListCustomersResult
	err := c.request(ctx, "GET", "/v1/customers", q, nil, "", &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// CreateSubscription creates a subscription.
func (c *Client) CreateSubscription(ctx context.Context, input CreateSubscriptionInput) (*Subscription, error) {
	var sub Subscription
	err := c.request(ctx, "POST", "/v1/subscriptions", nil, input, "", &sub)
	if err != nil {
		return nil, err
	}
	return &sub, nil
}

// CancelSubscription cancels a subscription.
func (c *Client) CancelSubscription(ctx context.Context, id string, immediately bool) (*Subscription, error) {
	payload := map[string]bool{"immediately": immediately}
	var sub Subscription
	err := c.request(ctx, "POST", fmt.Sprintf("/v1/subscriptions/%s/cancel", url.PathEscape(id)), nil, payload, "", &sub)
	if err != nil {
		return nil, err
	}
	return &sub, nil
}

// VerifyWebhookSignature statically verifies downstream HMAC-SHA256 PayDeck webhook signatures.
func VerifyWebhookSignature(payload []byte, signature, secret string) bool {
	if len(signature) == 0 || len(secret) == 0 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expectedSig := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(strings.ToLower(expectedSig)), []byte(strings.ToLower(strings.TrimSpace(signature))))
}
