# Generic Multi-Runtime PayDeck Design Document

**Date:** 2026-08-24  
**Status:** Approved  
**Target Runtimes:** Node.js, Bun, Docker, Cloudflare Workers, AWS / VPS / Self-hosted  
**Database Targets:** SQLite (file & in-memory), Cloudflare D1, PostgreSQL  

---

## 1. Overview & Objectives

PayDeck is a shared Razorpay billing microservice that centralizes gateway credentials, product API keys, order creation, payment signature verification, rate limiting, and webhook processing.

The goal of this redesign is to make PayDeck completely platform- and vendor-agnostic. It runs seamlessly on standard Node.js, Bun, Docker containers, or Cloudflare Workers without changing any core domain logic or API contracts.

### Key Requirements
1. **Platform Independence:** Decouple core domain logic from Cloudflare Workers/D1 specific APIs.
2. **Pluggable Database Adapters:** Define a unified `DatabaseAdapter` supporting SQLite (local file / in-memory), Cloudflare D1, and PostgreSQL.
3. **Flexible Configuration:** Support configuration via `.env` files and/or `paydeck.yaml` / `config.yaml` files, with environment variable overrides.
4. **Web Standards Core:** Built on Hono using Web Standard `Request`, `Response`, and `Web Crypto` APIs.
5. **Multiple Entrypoints:** Provide clean, minimal entrypoints for Node.js (`@hono/node-server`), Bun (`bun serve`), Docker, and Cloudflare Workers.

---

## 2. System Architecture & Directory Structure

```
paydeck/
├── src/
│   ├── core/                  # Pure, runtime-agnostic domain logic
│   │   ├── auth.ts            # API key parsing & validation
│   │   ├── policy.ts          # Rate limit evaluation & interval validation
│   │   ├── razorpay.ts        # Signature verification & gateway HTTP calls
│   │   └── types.ts           # Core domain types & interfaces
│   │
│   ├── db/                    # Database Abstraction Layer
│   │   ├── adapter.ts         # DatabaseAdapter interface definition
│   │   ├── d1.ts              # Cloudflare D1 adapter implementation
│   │   ├── sqlite.ts          # SQLite adapter (better-sqlite3 / bun:sqlite)
│   │   └── postgres.ts        # PostgreSQL adapter (pg / porsager)
│   │
│   ├── config/                # Environment & Config Manager
│   │   ├── env.ts             # Merges process.env, paydeck.yaml, and c.env
│   │   └── yaml.ts            # YAML configuration loader
│   │
│   ├── routes/                # Hono routes (Web Standard Request/Response)
│   │   ├── admin.ts           # Product, key, and plan management
│   │   ├── billing.ts         # Orders, verification, payment lookups
│   │   └── webhooks.ts        # Razorpay webhook handling
│   │
│   ├── entrypoints/           # Target-specific server bootstrap files
│   │   ├── node.ts            # Node.js entrypoint (@hono/node-server)
│   │   ├── bun.ts             # Bun entrypoint (bun serve)
│   │   └── cloudflare.ts      # Cloudflare Workers fetch entrypoint
│   │
│   └── client.ts              # Typed client SDK (PayDeckClient)
│
├── migrations/                # ANSI SQL schema migrations
│   └── 0001_init.sql
│
├── paydeck.example.yaml       # Example YAML configuration
├── .env.example               # Example environment variables file
├── Dockerfile                 # Standalone Docker deployment image
├── docker-compose.yml         # Local Docker setup (App + SQLite/Postgres)
├── wrangler.toml              # Cloudflare Workers config (optional target)
└── package.json               # Generic package configuration
```

---

## 3. Database Abstraction Layer (`src/db/`)

The database layer provides a unified interface across storage engines:

```ts
export interface DatabaseAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  first<T>(sql: string, params?: unknown[]): Promise<T | null>
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>
  close?(): Promise<void>
}
```

### Adapters
1. **`SQLiteAdapter`**: Uses `better-sqlite3` (Node.js) or `bun:sqlite` (Bun) for local file (`./data/paydeck.db`) or in-memory (`:memory:`) execution.
2. **`D1Adapter`**: Wraps Cloudflare D1 `D1Database` binding (`c.env.DB`).
3. **`PostgresAdapter`**: Wraps PostgreSQL client for production setups requiring multi-instance stateless scaling.

### Cross-Database SQL Guidelines
* **Timestamps**: Application code generates ISO 8601 string representations (`new Date().toISOString()`) instead of dialect-specific SQL functions.
* **Booleans**: Stored as integers (`1` / `0`) for universal compatibility across SQLite and PostgreSQL.
* **Upserts**: Uses ANSI SQL `INSERT INTO ... ON CONFLICT (...) DO UPDATE ...`.

---

## 4. Configuration Layer (`src/config/`)

PayDeck resolves settings using a 3-level hierarchy:
1. **Environment Variables / `.env` file** *(Highest priority)*
2. **`paydeck.yaml` / `config.yaml` file** *(Second priority)*
3. **Default Fallbacks** *(Base fallback)*

### Example `paydeck.yaml`
```yaml
server:
  port: 8787
  host: "0.0.0.0"

database:
  type: "sqlite"               # options: sqlite | d1 | postgres
  sqlite:
    path: "./data/paydeck.db"
  postgres:
    url: "postgres://user:pass@localhost:5432/paydeck"

razorpay:
  key_id: ""
  key_secret: ""
  webhook_secret: ""

admin:
  token: "change-me-admin-token"

policy:
  default_rate_limit_per_hour: 200
  allow_dev_charge: false
```

---

## 5. Entrypoints & Server Bootstrapping

- **`src/entrypoints/node.ts`**: Starts Hono via `@hono/node-server` listening on `PORT` (default 8787), initializing `SQLiteAdapter` or `PostgresAdapter`.
- **`src/entrypoints/bun.ts`**: Native Bun server exported via `export default { port, fetch: app.fetch }`.
- **`src/entrypoints/cloudflare.ts`**: Worker fetch handler passing `c.env.DB` to `D1Adapter`.

---

## 6. Testing Strategy

1. **In-Memory SQLite Integration Tests**: Vitest suite runs all route integration tests against an in-memory SQLite database (`:memory:`), providing fast, zero-dependency test execution.
2. **Adapter Conformance Test Suite**: A shared test suite verifying that `D1Adapter`, `SQLiteAdapter`, and `PostgresAdapter` produce identical query results for all CRUD operations.
