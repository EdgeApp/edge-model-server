import { readFileSync } from 'node:fs'

import { asBoolean, asNumber, asObject, asOptional, asString, type Cleaner } from 'cleaners'

/** An Edge API key's HMAC secret: hex, 1 to 32 bytes, as edgeKey.json holds it. */
export const asHexSecret: Cleaner<Uint8Array> = raw => {
  const text = asString(raw).replace(/^0x/i, '').trim()
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(text)) throw new TypeError('Expected an even-length hex secret')
  const bytes = Uint8Array.from(Buffer.from(text, 'hex'))
  if (bytes.length > 32) throw new TypeError('Expected a secret of at most 32 bytes')
  return bytes
}

/** One Edge API key a caller may sign with. */
export const asApiKeyEntry = asObject({
  /** The public id the caller presents in `Authorization: HMAC <key> …`. */
  key: asString,
  secret: asHexSecret,
  enabled: asOptional(asBoolean, true),
  comment: asOptional(asString)
})
export type ApiKeyEntry = ReturnType<typeof asApiKeyEntry>

/** `apiKeys`: name → key, where the name is a memo for the operator. */
const asApiKeys: Cleaner<Record<string, ApiKeyEntry>> = raw => {
  const entries = asObject(asApiKeyEntry)(raw)
  const seen = new Set<string>()
  for (const [name, entry] of Object.entries(entries)) {
    if (seen.has(entry.key)) throw new TypeError(`apiKeys.${name}: the key ${entry.key} is listed twice`)
    seen.add(entry.key)
  }
  return entries
}

export const asServerConfig = asObject({
  httpHost: asOptional(asString, '127.0.0.1'),
  httpPort: asOptional(asNumber, 8018),
  /** Venice's origin; the request path (`/api/v1/…`) is appended to it. */
  veniceBaseUrl: asOptional(asString, 'https://api.venice.ai'),
  /** The server's own Venice key, sent as `Authorization: Bearer`. */
  veniceApiKey: asString,
  /** How far a request's `X-Timestamp` may be from the server's clock. */
  timestampWindowSec: asOptional(asNumber, 300),
  maxBodyBytes: asOptional(asNumber, 25 * 1024 * 1024),
  apiKeys: asApiKeys
})
export type ServerConfig = ReturnType<typeof asServerConfig>

/** Reads and cleans the config file: `EDGE_MODEL_SERVER_CONFIG`, else `./config.json`. */
export function loadConfig(path: string = process.env.EDGE_MODEL_SERVER_CONFIG ?? 'config.json'): ServerConfig {
  const config = asServerConfig(JSON.parse(readFileSync(path, 'utf8')))
  if (config.veniceApiKey === '') throw new TypeError('veniceApiKey is empty')
  return config
}
