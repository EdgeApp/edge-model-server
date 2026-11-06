import { loadConfig } from './config.js'
import { makeServer } from './server.js'

const config = loadConfig()
const server = makeServer(config).listen(config.httpPort, config.httpHost, () => {
  console.log(`edge-model-server on http://${config.httpHost}:${config.httpPort}, ${Object.keys(config.apiKeys).length} Edge API keys, Venice at ${config.veniceBaseUrl}`)
})
// Streamed chat answers can run for minutes.
server.requestTimeout = 0
server.headersTimeout = 60_000

const stop = (): void => {
  server.close(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
