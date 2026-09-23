import { loadYamlConfig, type YamlConfig } from './yaml'

export type PayDeckConfig = {
  port: number
  host: string
  dbType: 'sqlite' | 'd1' | 'postgres'
  dbPath: string
  dbUrl: string
  adminToken: string
  razorpayKeyId: string
  razorpayKeySecret: string
  razorpayWebhookSecret: string
  stripeSecretKey?: string
  stripeWebhookSecret?: string
  allowDevCharge: boolean
  rateLimitPerHour: number
  allowedOrigins: string
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  yamlFile?: string | YamlConfig,
): PayDeckConfig {
  const yamlData: YamlConfig =
    typeof yamlFile === 'object'
      ? yamlFile
      : loadYamlConfig(typeof yamlFile === 'string' ? yamlFile : undefined)

  const port = Number(env.PORT || yamlData.server?.port || '8787')
  const host = env.HOST || yamlData.server?.host || '0.0.0.0'
  const dbType = (
    env.DB_TYPE ||
    yamlData.database?.type ||
    'sqlite'
  ).toLowerCase() as 'sqlite' | 'd1' | 'postgres'

  const dbPath =
    env.DATABASE_PATH || yamlData.database?.sqlite?.path || './data/paydeck.db'
  const dbUrl = env.DATABASE_URL || yamlData.database?.postgres?.url || ''
  const adminToken = env.BILLING_ADMIN_TOKEN || yamlData.admin?.token || ''
  const razorpayKeyId = env.RAZORPAY_KEY_ID || yamlData.razorpay?.key_id || ''
  const razorpayKeySecret =
    env.RAZORPAY_KEY_SECRET || yamlData.razorpay?.key_secret || ''
  const razorpayWebhookSecret =
    env.RAZORPAY_WEBHOOK_SECRET || yamlData.razorpay?.webhook_secret || ''
  const stripeSecretKey =
    env.STRIPE_SECRET_KEY || yamlData.stripe?.secret_key || ''
  const stripeWebhookSecret =
    env.STRIPE_WEBHOOK_SECRET || yamlData.stripe?.webhook_secret || ''

  const allowDevCharge =
    env.ALLOW_DEV_CHARGE != null
      ? env.ALLOW_DEV_CHARGE === '1' || env.ALLOW_DEV_CHARGE === 'true'
      : yamlData.policy?.allow_dev_charge ?? false

  const rateLimitPerHour = Number(
    env.RATE_LIMIT_PER_HOUR ||
      yamlData.policy?.default_rate_limit_per_hour ||
      '200',
  )

  const allowedOrigins =
    env.ALLOWED_ORIGINS || yamlData.server?.allowed_origins || '*'

  return {
    port,
    host,
    dbType,
    dbPath,
    dbUrl,
    adminToken,
    razorpayKeyId,
    razorpayKeySecret,
    razorpayWebhookSecret,
    stripeSecretKey,
    stripeWebhookSecret,
    allowDevCharge,
    rateLimitPerHour,
    allowedOrigins,
  }
}
