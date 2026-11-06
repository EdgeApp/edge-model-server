import { readFileSync } from 'node:fs'

import express, { type Express } from 'express'

import type { ServerConfig } from './config.js'
import { requireHmac, type Caller } from './hmacAuth.js'
import { proxyToVenice, type Fetch } from './proxy.js'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export interface ServerOptions {
  fetch?: Fetch
  now?: () => number
  log?: (line: string) => void
}

/**
 * The app: `GET /` names the server; everything under `/api/v1` is Venice's
 * API, signed by an Edge API key on the way in and authorised with the
 * server's Venice key on the way out.
 */
export function makeServer(config: ServerConfig, options: ServerOptions = {}): Express {
  const log = options.log ?? (line => console.log(line))
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')

  app.get('/', (_req, res) => {
    res.json({ name: 'edge-model-server', version })
  })

  // Every body is read raw: it is what the caller signed and what Venice receives.
  app.use('/api/v1', express.raw({ type: () => true, limit: config.maxBodyBytes }))
  app.use('/api/v1', requireHmac(config, options.now))
  app.use('/api/v1', (req, res, next) => {
    const started = Date.now()
    res.on('finish', () => {
      const caller = res.locals.caller as Caller
      log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms ${caller.name}`)
    })
    next()
  })
  app.all('/api/v1/{*path}', proxyToVenice(config, options.fetch))

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
  return app
}
