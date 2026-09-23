# Go SDK & Test Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create official Go SDK (`sdks/go/paydeck`), unit tests (`go test`), and expand Vitest test suites with comprehensive edge-case testing.

---

## File Structure

- **`sdks/go/paydeck/go.mod`**: Go module specification.
- **`sdks/go/paydeck/types.go`**: Go structs for requests, responses, payments, customers, subscriptions, audit logs.
- **`sdks/go/paydeck/errors.go`**: Go custom error types (`APIError`).
- **`sdks/go/paydeck/client.go`**: Core `Client` implementation using `net/http` and `crypto/hmac`.
- **`sdks/go/paydeck/client_test.go`**: Go unit tests using `net/http/httptest`.
- **`tests/edge-cases.test.ts`**: Expanded Vitest test suite for boundary conditions and malformed input.

---

### Task 1: Go Module & Core Client Implementation

**Files:**
- Create: `sdks/go/paydeck/go.mod`
- Create: `sdks/go/paydeck/types.go`
- Create: `sdks/go/paydeck/errors.go`
- Create: `sdks/go/paydeck/client.go`

### Task 2: Go Unit Test Suite

**Files:**
- Create: `sdks/go/paydeck/client_test.go`
- Run: `go test ./...` in `sdks/go/paydeck`

### Task 3: Vitest Edge-Case & Robustness Expansion

**Files:**
- Create: `tests/edge-cases.test.ts`
- Run: `npm test`
