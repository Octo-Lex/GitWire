# Security

GitWire's security model: authentication, rate limiting, and data protection.

## API Key Authentication

All API endpoints require a Bearer token:

```
Authorization: Bearer YOUR_API_KEY
```

- Set via `API_KEY` or `API_KEYS` environment variable
- Multiple keys supported (comma-separated)
- If no key is set, a random key is generated on startup and logged once
- The `/health` and `/webhooks/github` endpoints are exempt

## Rate Limiting

API requests are rate-limited using Redis:

| Setting | Value |
|---------|-------|
| Window | 60 seconds |
| Max requests | 100 per IP per window |
| Storage | Redis |
| Key | Client IP address |

Rate-limited responses return HTTP 429 with a `Retry-After` header.

## Webhook Verification

All incoming GitHub webhooks are verified:

1. Read `X-Hub-Signature-256` header
2. Compute HMAC-SHA256 of the raw request body using `GITHUB_WEBHOOK_SECRET`
3. Compare signatures in constant time
4. Reject mismatched signatures with HTTP 401

## GitHub App Token Scope

The GitHub App has limited, specific permissions. It cannot:
- Access code in repos where it's not installed
- Perform actions beyond its granted permissions
- Access user email or private data

Tokens are short-lived (1 hour) and automatically refreshed.

## Data Storage

| Data | Protection |
|------|-----------|
| API keys | Environment variables, not stored in DB |
| GitHub tokens | Short-lived, auto-refreshed, never persisted |
| Webhook secret | Environment variable |
| PEM private key | File on disk, mounted read-only in Docker |
| Database | PostgreSQL with password auth, not exposed externally |
| Redis | No password (internal Docker network only) |

## Network Security

```
Internet → Cloudflare → Tunnel → GitWire (no inbound ports)
```

- GitWire makes **outbound** connections to Cloudflare
- No ports need to be opened on the host
- Cloudflare provides DDoS protection and TLS termination
- Database and Redis are only accessible within the Docker network

## Recommendations

- ✅ Use a strong, random `API_KEY`
- ✅ Use a strong, random `GITHUB_WEBHOOK_SECRET`
- ✅ Mount the PEM key as a read-only Docker volume
- ✅ Keep `GITHUB_PRIVATE_KEY` out of environment variables (use `GITHUB_PRIVATE_KEY_PATH`)
- ✅ Restrict Redis to internal network only
- ✅ Regularly rotate your API keys

→ [Configuration Reference](/configuration/queues)
