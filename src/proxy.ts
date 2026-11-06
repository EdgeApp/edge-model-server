import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

import type { Request, Response } from 'express'

import type { ServerConfig } from './config.js'

/** Connection-level headers, which belong to one hop and are never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])
/** The caller's own headers that must not reach Venice. */
const NOT_FORWARDED = new Set([...HOP_BY_HOP, 'authorization', 'x-timestamp', 'host', 'content-length'])
/** Response headers that no longer describe the body once fetch has decoded it. */
const NOT_RETURNED = new Set([...HOP_BY_HOP, 'content-encoding', 'content-length'])

export type Fetch = typeof fetch

/** The caller's headers, less its own authentication and the hop-by-hop ones, with the server's Venice key. */
export function upstreamHeaders(req: Request, veniceApiKey: string): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null || NOT_FORWARDED.has(name.toLowerCase())) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  headers.set('authorization', `Bearer ${veniceApiKey}`)
  return headers
}

/**
 * Sends an authenticated request on to Venice and streams the answer back:
 * same method, path, query, body and headers, with the server's Venice key.
 * A caller that goes away cancels the request to Venice.
 */
export function proxyToVenice(config: ServerConfig, fetchImpl: Fetch = fetch) {
  return async (req: Request, res: Response): Promise<void> => {
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? new Uint8Array(req.body) : undefined
    let upstream: globalThis.Response
    try {
      upstream = await fetchImpl(`${config.veniceBaseUrl}${req.originalUrl}`, {
        method: req.method,
        headers: upstreamHeaders(req, config.veniceApiKey),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: abort.signal
      })
    } catch (error: unknown) {
      if (abort.signal.aborted) return
      console.error(`venice unreachable: ${error instanceof Error ? error.message : String(error)}`)
      res.status(502).json({ error: 'Venice did not answer' })
      return
    }

    res.status(upstream.status)
    upstream.headers.forEach((value, name) => {
      if (!NOT_RETURNED.has(name.toLowerCase())) res.setHeader(name, value)
    })
    if (upstream.body == null) {
      res.end()
      return
    }
    // Sent as each piece arrives, so server-sent events stream through.
    res.flushHeaders()
    try {
      await pipeline(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>), res)
    } catch {
      // The caller left, or Venice broke off mid-answer; the response ends either way.
      if (!res.destroyed) res.destroy()
    }
  }
}
