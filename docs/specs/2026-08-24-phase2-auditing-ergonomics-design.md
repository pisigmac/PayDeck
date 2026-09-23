# Phase 2: Auditing & API Ergonomics Design Document

**Date:** 2026-08-24  
**Status:** Approved  
**Scope:** Immutable Audit Logging, List Pagination, Admin Audit Endpoints, OpenAPI Schemas, and Admin SDK Methods.

---

## 1. Objectives

1. **Immutable Audit Trail**: Log all product, key, and plan management operations into an `audit_logs` table.
2. **Payment List Pagination**: Support `limit` (max 100) and `offset` pagination on payment listing endpoints.
3. **Admin Audit API**: Provide `GET /v1/admin/audit-logs` endpoint with pagination and action filtering.
4. **Complete OpenAPI Definition**: Enrich `/v1/openapi.json` with full request and response JSON schemas.
5. **Full Admin SDK Support**: Extend `PayDeckClient` in `src/client.ts` with methods for product, key, plan, and audit log management.

---

## 2. Component Design & Specifications

### A. Audit Logging Schema (`migrations/0002_audit_logs.sql`)
```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  actor TEXT NOT NULL, -- admin | system | key_id
  action TEXT NOT NULL, -- product.created | product.updated | key.minted | key.revoked | plan.created | plan.updated
  target_id TEXT NOT NULL,
  details TEXT, -- JSON string
  created_at TEXT NOT NULL
);

CREATE INDEX audit_logs_product_idx ON audit_logs(product_id, created_at);
CREATE INDEX audit_logs_action_idx ON audit_logs(action, created_at);
```

### B. Audit Logger (`src/core/audit.ts`)
```ts
export async function logAudit(
  db: DatabaseAdapter,
  opts: {
    productId?: string | null
    actor: string
    action: string
    targetId: string
    details?: Record<string, unknown>
  },
): Promise<void>
```

### C. Payment & Audit List Pagination
Payment list responses (`GET /v1/payments` & `GET /v1/admin/products/:slug/payments`) and audit logs (`GET /v1/admin/audit-logs`) return pagination metadata:
```json
{
  "payments": [ ... ],
  "pagination": {
    "limit": 25,
    "offset": 0,
    "total": 142
  }
}
```

### D. Extended SDK Methods (`src/client.ts`)
Add to `PayDeckClient`:
- `createProduct(input)`
- `listProducts()`
- `updateProduct(slug, input)`
- `mintKey(slug, input)`
- `revokeKey(slug, keyId)`
- `createPlan(slug, input)`
- `updatePlan(slug, planSlug, input)`
- `listAuditLogs(opts)`
