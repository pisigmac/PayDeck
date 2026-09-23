class PayDeckError(Exception):
    """Base exception for all PayDeck SDK errors."""
    pass


class PayDeckAPIError(PayDeckError):
    """Raised when the PayDeck API returns an error response."""

    def __init__(self, message: str, status_code: int, error_code: str = None, details: list = None, request_id: str = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_code = error_code or "API_ERROR"
        self.details = details or []
        self.request_id = request_id

    def __repr__(self):
        return f"PayDeckAPIError(status_code={self.status_code}, code={self.error_code!r}, message={self.message!r}, request_id={self.request_id!r})"
