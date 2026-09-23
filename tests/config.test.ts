import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/env'

describe('loadConfig', () => {
  it('loads default values when process.env and yaml are empty', () => {
    const cfg = loadConfig({}, {})
    expect(cfg.port).toBe(8787)
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.dbType).toBe('sqlite')
    expect(cfg.allowDevCharge).toBe(false)
    expect(cfg.rateLimitPerHour).toBe(200)
    expect(cfg.allowedOrigins).toBe('*')
  })

  it('merges values from YAML configuration', () => {
    const yamlMock = {
      server: { port: 9090, host: '127.0.0.1', allowed_origins: 'https://app.example.com' },
      database: { type: 'postgres', postgres: { url: 'postgres://localhost/test' } },
      admin: { token: 'yaml-admin-token' },
      policy: { allow_dev_charge: true, default_rate_limit_per_hour: 500 },
    }
    const cfg = loadConfig({}, yamlMock)
    expect(cfg.port).toBe(9090)
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.dbType).toBe('postgres')
    expect(cfg.dbUrl).toBe('postgres://localhost/test')
    expect(cfg.adminToken).toBe('yaml-admin-token')
    expect(cfg.allowDevCharge).toBe(true)
    expect(cfg.rateLimitPerHour).toBe(500)
    expect(cfg.allowedOrigins).toBe('https://app.example.com')
  })

  it('environment variables override YAML values', () => {
    const yamlMock = {
      server: { port: 9090, allowed_origins: 'https://app.example.com' },
      database: { type: 'sqlite' },
      admin: { token: 'yaml-admin-token' },
    }
    const envMock = {
      PORT: '9999',
      DB_TYPE: 'postgres',
      BILLING_ADMIN_TOKEN: 'env-admin-token',
      ALLOW_DEV_CHARGE: '1',
      ALLOWED_ORIGINS: 'https://override.example.com',
    }
    const cfg = loadConfig(envMock, yamlMock)
    expect(cfg.port).toBe(9999)
    expect(cfg.dbType).toBe('postgres')
    expect(cfg.adminToken).toBe('env-admin-token')
    expect(cfg.allowDevCharge).toBe(true)
    expect(cfg.allowedOrigins).toBe('https://override.example.com')
  })
})
