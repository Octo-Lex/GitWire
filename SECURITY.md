# Security Policy

## Supported Versions

GitWire is a self-hosted project. Security fixes are applied to the latest `master` branch and included in the next release.

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| `master` branch | Yes |
| Older releases | No |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email **security@erlab.uk** with:
   - A description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
3. You will receive an acknowledgment within 48 hours.
4. A fix will be prioritized and a security advisory published once a patch is available.

## Security Measures

GitWire implements the following security practices:

- **Secret scanning**: Full-history gitleaks scans in CI
- **DCO enforcement**: All commits must be signed off
- **Strict dependencies**: `npm ci` with no fallback to `npm install`
- **No query-string API keys**: Authentication via `Authorization` header or `gitwire-session` cookie only
- **Mandatory DB password**: Container fails fast if `DB_PASSWORD` is not set
- **Cookie Secure flag**: Conditional on `NODE_ENV=production`
- **Branch protection**: Required status checks on `master`
- **Cloudflare Tunnel**: Outbound-only tunnel, no inbound ports exposed

## Contributor Guidelines

- Never commit secrets, API keys, passwords, or `.env` files
- Use `.env.example` for documenting required environment variables
- Report any accidental secret exposure immediately
