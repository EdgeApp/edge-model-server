# edge-model-server

A pass-through to Venice's API for Edge apps. A caller uses Venice's API
unchanged under `/api/v1`, except that it signs each request with an Edge
API key instead of sending a Venice key; the server checks the signature and
calls Venice with its own key. Venice's end-to-end encryption passes through
untouched: the server sees only ciphertext for encrypted chats.

## Requests

Every request under `/api/v1` carries:

```
Authorization: HMAC <apiKey> <base64 HMAC-SHA256 signature>
X-Timestamp: <unix seconds>
```

The signature is over `${method}\n${pathAndQuery}\n${body}\n${timestamp}`,
where `pathAndQuery` is the request's path and query as sent (for example
`/api/v1/tee/attestation?model=m&nonce=n`) and `body` is the raw request
body as UTF-8, empty when there is none. It is edge-info-server's scheme,
except that the body is the raw bytes rather than re-serialized JSON. The
timestamp must be within `timestampWindowSec` of the server's clock. Any
failure answers `401 {"error":"Unauthorized"}`, whatever the reason.

The request then goes to `${veniceBaseUrl}${pathAndQuery}` with the same
method, body and headers, less the caller's `Authorization`, `X-Timestamp`
and hop-by-hop headers, and with `Authorization: Bearer <veniceApiKey>`.
Venice's answer streams back as it arrives, so server-sent events work. A
caller that disconnects cancels the request to Venice; Venice not answering
is a `502`.

`GET /` answers `{ "name": "edge-model-server", "version" }` without a
signature.

## Config

There is no database. `config.json` (gitignored; see `config.sample.json`),
or the file `EDGE_MODEL_SERVER_CONFIG` names, holds:

| Field | Default | |
| --- | --- | --- |
| `httpHost` | `127.0.0.1` | |
| `httpPort` | `8018` | |
| `veniceBaseUrl` | `https://api.venice.ai` | |
| `veniceApiKey` | required | the server's Venice key |
| `timestampWindowSec` | `300` | |
| `maxBodyBytes` | 25 MB | |
| `apiKeys` | required | name → `{ key, secret, enabled?, comment? }`; `secret` is hex, 1–32 bytes, as `edgeKey.json` holds it |

A key's name is a memo; the log names the key each request came from.

## Running

```bash
npm install
npm run build
npm start            # node lib/index.js
npm test             # vitest, 90% line coverage
```
