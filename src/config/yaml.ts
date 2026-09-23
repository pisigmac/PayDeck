import fs from 'node:fs'
import path from 'node:path'
import { load as parseYaml } from 'js-yaml'

export type YamlConfig = {
  server?: {
    port?: number
    host?: string
    allowed_origins?: string
  }
  database?: {
    type?: string
    sqlite?: {
      path?: string
    }
    postgres?: {
      url?: string
    }
  }
  razorpay?: {
    key_id?: string
    key_secret?: string
    webhook_secret?: string
  }
  stripe?: {
    secret_key?: string
    webhook_secret?: string
  }
  admin?: {
    token?: string
  }
  policy?: {
    default_rate_limit_per_hour?: number
    allow_dev_charge?: boolean
  }
}

export function loadYamlConfig(customPath?: string): YamlConfig {
  const possiblePaths = customPath
    ? [customPath]
    : [
        path.resolve(process.cwd(), 'paydeck.yaml'),
        path.resolve(process.cwd(), 'config.yaml'),
      ]

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8')
        const doc = parseYaml(content) as YamlConfig
        if (doc && typeof doc === 'object') {
          return doc
        }
      } catch (err) {
        console.warn(`[PayDeck Config] Failed to parse YAML file at ${filePath}:`, err)
      }
    }
  }

  return {}
}
