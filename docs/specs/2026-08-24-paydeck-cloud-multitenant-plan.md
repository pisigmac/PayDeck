# PayDeck Cloud Multi-Tenant SaaS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement PayDeck Cloud multi-tenant SaaS capabilities including tenant organization isolation, user sign-up/login, password hashing, usage metering, tier limits enforcement, tenant APIs, and Web Admin SPA login upgrade.

---

## File Structure

- **`migrations/0006_paydeck_cloud_multitenant.sql`**: Schema migration for `organizations`, `cloud_users`, `org_usage_meters`, and `products.org_id`.
- **`src/core/cloud-tenant.ts`**: Core tenant & auth engine (`hashPassword`, `verifyPassword`, `createTenantUser`, `authenticateUser`, `incrementOrgUsage`, `checkOrgTierLimit`).
- **`src/routes/cloud.ts`**: Cloud SaaS API routes (`/v1/cloud/signup`, `/v1/cloud/login`, `/v1/cloud/me`, `/v1/cloud/org/upgrade`).
- **`src/middleware/tier-limits.ts`**: Middleware enforcing tier limits on `/v1/orders`.
- **`public/admin/index.html`**: Web Admin SPA with tenant login / sign-up modal & usage meters.

---

### Task 1: Database Migration & Core Tenant Engine

**Files:**
- Create: `migrations/0006_paydeck_cloud_multitenant.sql`
- Create: `src/core/cloud-tenant.ts`
- Test: `tests/cloud-tenant.test.ts`

- [ ] **Step 1: Create migration and core tenant logic**
- [ ] **Step 2: Run test to verify**

---

### Task 2: Cloud SaaS API Routes & App Mounting

**Files:**
- Create: `src/routes/cloud.ts`
- Modify: `src/index.ts`
- Test: `tests/cloud-routes.test.ts`

- [ ] **Step 1: Create `src/routes/cloud.ts`**
- [ ] **Step 2: Mount `/v1/cloud` in `src/index.ts`**
- [ ] **Step 3: Run test to verify**

---

### Task 3: Usage Metering & Tier Limits Middleware

**Files:**
- Create: `src/middleware/tier-limits.ts`
- Modify: `src/routes/billing.ts`
- Test: `tests/tier-limits.test.ts`

- [ ] **Step 1: Increment usage meter on `/v1/orders` and check tier limit**
- [ ] **Step 2: Run test to verify**

---

### Task 4: SDK & Web Admin SPA Extensions

**Files:**
- Modify: `src/client.ts`
- Modify: `public/admin/index.html`
- Test: `tests/client-cloud.test.ts`

- [ ] **Step 1: Add `signup()`, `login()`, `getCloudMe()` to `PayDeckClient`**
- [ ] **Step 2: Add Login / Register modal and Usage Meters to Web Admin SPA**

---

### Task 5: Final System Verification

- [ ] **Step 1: Run `npm run build && npm run typecheck && npm test`**
- [ ] **Step 2: Run Python and Go SDK test suites**
