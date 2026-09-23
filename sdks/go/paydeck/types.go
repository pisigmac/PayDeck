package paydeck

type Pagination struct {
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
	Total  int `json:"total"`
}

type CreateOrderInput struct {
	Plan           string                 `json:"plan,omitempty"`
	AmountPaise    int                    `json:"amount_paise,omitempty"`
	Currency       string                 `json:"currency,omitempty"`
	Receipt        string                 `json:"receipt,omitempty"`
	Notes          map[string]string      `json:"notes,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
	Description    string                 `json:"description,omitempty"`
	CustomerID     string                 `json:"customer_id,omitempty"`
	IdempotencyKey string                 `json:"-"`
}

type OrderResult struct {
	ID          string   `json:"id"`
	Status      string   `json:"status"`
	OrderID     string   `json:"order_id"`
	KeyID       string   `json:"key_id"`
	Amount      int      `json:"amount"`
	Currency    string   `json:"currency"`
	Plan        string   `json:"plan,omitempty"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Mode        string   `json:"mode,omitempty"`
	Payment     *Payment `json:"payment,omitempty"`
}

type VerifyInput struct {
	RazorpayOrderID   string `json:"razorpay_order_id"`
	RazorpayPaymentID string `json:"razorpay_payment_id"`
	RazorpaySignature string `json:"razorpay_signature"`
}

type VerifyResult struct {
	OK      bool     `json:"ok"`
	Payment *Payment `json:"payment"`
	Mode    string   `json:"mode,omitempty"`
}

type Payment struct {
	ID                string                 `json:"id"`
	Status            string                 `json:"status"`
	CustomerID        *string                `json:"customer_id,omitempty"`
	Plan              *string                `json:"plan,omitempty"`
	PlanID            *string                `json:"plan_id,omitempty"`
	AmountPaise       int                    `json:"amount_paise"`
	Currency          string                 `json:"currency"`
	RazorpayOrderID   *string                `json:"razorpay_order_id,omitempty"`
	RazorpayPaymentID *string                `json:"razorpay_payment_id,omitempty"`
	Receipt           *string                `json:"receipt,omitempty"`
	Notes             map[string]string      `json:"notes,omitempty"`
	Metadata          map[string]interface{} `json:"metadata,omitempty"`
	IdempotencyKey    *string                `json:"idempotency_key,omitempty"`
	ConfirmedAt       *string                `json:"confirmed_at,omitempty"`
	CreatedAt         string                 `json:"created_at"`
}

type ListPaymentsResult struct {
	Payments   []Payment   `json:"payments"`
	Pagination *Pagination `json:"pagination,omitempty"`
}

type RefundInput struct {
	AmountPaise int    `json:"amount_paise,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

type RefundResult struct {
	OK            bool   `json:"ok"`
	RefundID      string `json:"refund_id"`
	PaymentID     string `json:"payment_id"`
	AmountRefund  int    `json:"amount_refunded_paise"`
	PaymentStatus string `json:"payment_status"`
}

type Customer struct {
	ID             string                 `json:"id"`
	ProductID      string                 `json:"product_id"`
	Email          *string                `json:"email,omitempty"`
	Name           *string                `json:"name,omitempty"`
	ExternalUserID *string                `json:"external_user_id,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt      string                 `json:"created_at"`
}

type CreateCustomerInput struct {
	Email          string                 `json:"email,omitempty"`
	Name           string                 `json:"name,omitempty"`
	ExternalUserID string                 `json:"external_user_id,omitempty"`
	Metadata       map[string]interface{} `json:"metadata,omitempty"`
}

type ListCustomersResult struct {
	Customers  []Customer  `json:"customers"`
	Pagination *Pagination `json:"pagination,omitempty"`
}

type Subscription struct {
	ID                 string `json:"id"`
	ProductID          string `json:"product_id"`
	CustomerID         string `json:"customer_id"`
	PlanID             string `json:"plan_id"`
	Status             string `json:"status"`
	CurrentPeriodStart string `json:"current_period_start"`
	CurrentPeriodEnd   string `json:"current_period_end"`
	CancelAtPeriodEnd  bool   `json:"cancel_at_period_end"`
	CreatedAt          string `json:"created_at"`
}

type CreateSubscriptionInput struct {
	CustomerID string `json:"customer_id"`
	PlanID     string `json:"plan_id"`
	PeriodDays int    `json:"period_days,omitempty"`
}

type ListSubscriptionsResult struct {
	Subscriptions []Subscription `json:"subscriptions"`
	Pagination    *Pagination   `json:"pagination,omitempty"`
}
