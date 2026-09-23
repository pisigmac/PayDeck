package paydeck

import "fmt"

// APIError represents an error response returned by the PayDeck API.
type APIError struct {
	StatusCode int                    `json:"status_code"`
	Code       string                 `json:"code"`
	Message    string                 `json:"message"`
	RequestID  string                 `json:"request_id,omitempty"`
	Details    []FieldErrorDetail     `json:"details,omitempty"`
}

type FieldErrorDetail struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	if e.RequestID != "" {
		return fmt.Sprintf("paydeck api error (status %d, code %s, req %s): %s", e.StatusCode, e.Code, e.RequestID, e.Message)
	}
	return fmt.Sprintf("paydeck api error (status %d, code %s): %s", e.StatusCode, e.Code, e.Message)
}
