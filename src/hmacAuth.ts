import { createHmac, timingSafeEqual } from 'node:crypto'

import type { NextFunction, Request, Response } from 'express'

import type { ApiKeyEntry, ServerConfig } from './config.js'

/**
 * The text a caller signs, as edge-info-server's `buildSignedRequestText`:
 * method, the path and query as received, the body, and the timestamp. The
 * body here is the raw request body as UTF-8 rather than the info server's
 * re-serialized JSON, because a pass-through must forward the bytes it got.
 */
export function buildSignedRequestText(method: string, url: string, body: string, timestamp: string): string {
  return `${method}\n${url}\n${body}\n${timestamp}`
}

export function hmacSha256(text: string, secret: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(text, 'utf8').digest()
}

/** What a request authenticated as, for the log. */
export interface Caller {
  name: string
  key: string
}

/** Locals the middleware sets on an authenticated request. */
export interface AuthLocals {
  caller: Caller
}

const AUTHORIZATION = /^HMAC ([^\s]+) ([A-Za-z0-9+/]+={0,2})$/

/** Every refusal looks the same, so a caller learns nothing about why. */
function refuse(res: Response): void {
  res.status(401).json({ error: 'Unauthorized' })
}

function findKey(config: ServerConfig, presented: string): { name: string; entry: ApiKeyEntry } | undefined {
  for (const [name, entry] of Object.entries(config.apiKeys)) {
    if (entry.key === presented) return { name, entry }
  }
}

/**
 * Express middleware: the request must carry `Authorization: HMAC <key> <sig>`
 * and `X-Timestamp`, within the window, signed by an enabled key over the raw
 * body (which `express.raw` has already read into `req.body`).
 */
export function requireHmac(config: ServerConfig, now: () => number = Date.now) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const match = AUTHORIZATION.exec(req.get('authorization') ?? '')
    const timestamp = req.get('x-timestamp') ?? ''
    if (match == null || !/^\d{1,12}$/.test(timestamp)) return refuse(res)
    const skew = Math.abs(now() / 1000 - Number(timestamp))
    if (skew > config.timestampWindowSec) return refuse(res)
    const found = findKey(config, match[1] as string)
    if (found == null || !found.entry.enabled) return refuse(res)

    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    const expected = hmacSha256(buildSignedRequestText(req.method, req.originalUrl, body, timestamp), found.entry.secret)
    const presented = Buffer.from(match[2] as string, 'base64')
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return refuse(res)

    res.locals.caller = { name: found.name, key: found.entry.key } satisfies Caller
    next()
  }
}
