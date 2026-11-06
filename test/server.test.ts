import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { asServerConfig, loadConfig, type ServerConfig } from '../src/config.js'
import { buildSignedRequestText, hmacSha256 } from '../src/hmacAuth.js'
import { makeServer } from '../src/server.js'

const SECRET_HEX = '00112233445566778899aabbccddeeff'
const SECRET = Buffer.from(SECRET_HEX, 'hex')
const NOW = 1_800_000_000_000

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

let venice: Server
let veniceUrl: string
const seen: Seen[] = []

/** A stand-in for Venice: records each request and answers by path. */
beforeAll(async () => {
  venice = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (req.url?.startsWith('/api/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-venice-request-id': 'r1' })
        res.write('data: {"n":1}\n\n')
        setTimeout(() => {
          res.write('data: {"n":2}\n\n')
          res.end('data: [DONE]\n\n')
        }, 50)
        return
      }
      if (req.url?.startsWith('/api/v1/missing')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"no such thing"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>(resolve => venice.listen(0, '127.0.0.1', resolve))
  veniceUrl = `http://127.0.0.1:${(venice.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise(resolve => venice.close(resolve))
})

function config(overrides: Record<string, unknown> = {}): ServerConfig {
  return asServerConfig({
    veniceBaseUrl: veniceUrl,
    veniceApiKey: 'VENICE-SERVER-KEY',
    apiKeys: {
      eddy: { key: 'eddyKey', secret: SECRET_HEX },
      old: { key: 'oldKey', secret: SECRET_HEX, enabled: false }
    },
    ...overrides
  })
}

/** Starts the app on a free port; resolves with its origin and a stop function. */
async function start(cfg: ServerConfig = config(), now: () => number = () => NOW, fetchImpl?: typeof fetch) {
  const lines: string[] = []
  const server = makeServer(cfg, { now, log: line => lines.push(line), fetch: fetchImpl }).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, lines, stop: async () => await new Promise(resolve => server.close(resolve)) }
}

function sign(method: string, pathAndQuery: string, body: string, key = 'eddyKey', secret: Uint8Array = SECRET, timestamp = String(NOW / 1000)) {
  const signature = hmacSha256(buildSignedRequestText(method, pathAndQuery, body, timestamp), secret).toString('base64')
  return { authorization: `HMAC ${key} ${signature}`, 'x-timestamp': timestamp }
}

describe('config', () => {
  it('fills defaults and refuses a bad secret or a repeated key', () => {
    const cfg = asServerConfig({ veniceApiKey: 'v', apiKeys: { a: { key: 'k', secret: '0xABCD' } } })
    expect([cfg.httpHost, cfg.httpPort, cfg.veniceBaseUrl, cfg.timestampWindowSec, cfg.apiKeys.a?.enabled]).toEqual(['127.0.0.1', 8018, 'https://api.venice.ai', 300, true])
    expect(Buffer.from(cfg.apiKeys.a?.secret ?? []).toString('hex')).toBe('abcd')
    expect(() => asServerConfig({ veniceApiKey: 'v', apiKeys: { a: { key: 'k', secret: 'abc' } } })).toThrow('even-length hex')
    expect(() => asServerConfig({ veniceApiKey: 'v', apiKeys: { a: { key: 'k', secret: '00'.repeat(33) } } })).toThrow('at most 32 bytes')
    expect(() => asServerConfig({ veniceApiKey: 'v', apiKeys: { a: { key: 'k', secret: '00' }, b: { key: 'k', secret: '01' } } })).toThrow('listed twice')
  })

  it('reads a file and refuses an empty Venice key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ems-'))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ veniceApiKey: 'v', apiKeys: {} }))
    expect(loadConfig(file).veniceApiKey).toBe('v')
    writeFileSync(file, JSON.stringify({ veniceApiKey: '', apiKeys: {} }))
    expect(() => loadConfig(file)).toThrow('veniceApiKey is empty')
  })
})

describe('the server', () => {
  it('names itself without a signature', async () => {
    const app = await start()
    const res = await fetch(`${app.origin}/`)
    expect(await res.json()).toEqual({ name: 'edge-model-server', version: expect.any(String) })
    expect((await fetch(`${app.origin}/nowhere`)).status).toBe(404)
    await app.stop()
  })

  it('passes a signed request through with the server key, and streams the answer', async () => {
    const app = await start()
    seen.length = 0
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'héllo' }], stream: true })
    const res = await fetch(`${app.origin}/api/v1/chat/completions?x=1`, {
      method: 'POST',
      headers: { ...sign('POST', '/api/v1/chat/completions?x=1', body), 'content-type': 'application/json', 'x-venice-tee-client-pub-key': 'abc' },
      body
    })
    expect([res.status, res.headers.get('content-type'), res.headers.get('x-venice-request-id')]).toEqual([200, 'text/event-stream', 'r1'])
    const pieces: string[] = []
    const reader = res.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pieces.push(new TextDecoder().decode(value))
    }
    expect(pieces.join('')).toBe('data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n')
    expect(pieces.length).toBeGreaterThan(1)
    const upstream = seen.at(-1)!
    expect([upstream.method, upstream.url, upstream.body]).toEqual(['POST', '/api/v1/chat/completions?x=1', body])
    expect(upstream.headers.authorization).toBe('Bearer VENICE-SERVER-KEY')
    expect(upstream.headers['x-timestamp']).toBeUndefined()
    expect(upstream.headers['x-venice-tee-client-pub-key']).toBe('abc')
    expect(app.lines.at(-1)).toMatch(/^POST \/api\/v1\/chat\/completions 200 \d+ms eddy$/)
    await app.stop()
  })

  it('passes a GET with its query, and a Venice error, through', async () => {
    const app = await start()
    const path = '/api/v1/tee/attestation?model=m&nonce=n1'
    const ok = await fetch(`${app.origin}${path}`, { headers: sign('GET', path, '') })
    expect([ok.status, await ok.json(), seen.at(-1)?.url]).toEqual([200, { ok: true }, path])
    const missing = await fetch(`${app.origin}/api/v1/missing`, { headers: sign('GET', '/api/v1/missing', '') })
    expect([missing.status, await missing.json()]).toEqual([404, { error: 'no such thing' }])
    await app.stop()
  })

  it('refuses every unsigned, mis-signed, stale or unknown request the same way', async () => {
    const app = await start()
    const path = '/api/v1/models'
    const cases: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer something' },
      { ...sign('GET', path, ''), 'x-timestamp': 'soon' },
      sign('GET', path, '', 'eddyKey', SECRET, String(NOW / 1000 - 301)),
      sign('GET', path, '', 'eddyKey', Buffer.from('ff', 'hex')),
      sign('GET', path, '', 'nobody'),
      sign('GET', path, '', 'oldKey'),
      sign('GET', '/api/v1/other', ''),
      { authorization: 'HMAC eddyKey AAAA', 'x-timestamp': String(NOW / 1000) }
    ]
    for (const headers of cases) {
      const res = await fetch(`${app.origin}${path}`, { headers })
      expect([res.status, await res.json()]).toEqual([401, { error: 'Unauthorized' }])
    }
    // A body changed after signing.
    const tampered = await fetch(`${app.origin}${path}`, { method: 'POST', headers: sign('POST', path, '{"a":1}'), body: '{"a":2}' })
    expect(tampered.status).toBe(401)
    await app.stop()
  })

  it('answers 502 when Venice cannot be reached', async () => {
    const app = await start(config({ veniceBaseUrl: 'http://127.0.0.1:1' }))
    const res = await fetch(`${app.origin}/api/v1/models`, { headers: sign('GET', '/api/v1/models', '') })
    expect([res.status, await res.json()]).toEqual([502, { error: 'Venice did not answer' }])
    await app.stop()
  })

  it('ends an answer with no body, and survives Venice breaking off', async () => {
    const empty: typeof fetch = async () => new Response(null, { status: 204 })
    const app = await start(config(), () => NOW, empty)
    const res = await fetch(`${app.origin}/api/v1/models`, { headers: sign('GET', '/api/v1/models', '') })
    expect(res.status).toBe(204)
    await app.stop()

    const broken: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: 1\n\n'))
            controller.error(new Error('cut'))
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    const app2 = await start(config(), () => NOW, broken)
    const cut = await fetch(`${app2.origin}/api/v1/chat/completions`, { method: 'POST', headers: sign('POST', '/api/v1/chat/completions', 'x'), body: 'x' })
    await expect(cut.text()).rejects.toThrow()
    await app2.stop()
  })
})
