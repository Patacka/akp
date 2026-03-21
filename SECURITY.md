# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues by emailing the maintainers directly (address in the paper) or opening a [GitHub private security advisory](../../security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested fix if you have one

You will receive an acknowledgement within 48 hours and a resolution timeline within 7 days.

## Known attack surface

AKP exposes:

| Surface | Notes |
|---|---|
| `POST /rpc` (JSON-RPC) | Protected by `AKP_API_KEY` when set. Leave unset only in dev. |
| `GET /metrics` | Prometheus text — no auth by design. Do not expose publicly if metrics are sensitive. |
| WebSocket `:3001` | Peer sync — no auth. Run behind a firewall or VPN in production. |
| SQLite file | Stored at `AKP_DB` path. Protect with OS-level file permissions. |

## Remediated vulnerabilities (v0.1)

Eight vulnerability classes were identified and remediated prior to v0.1 release, documented in the [research paper](paper/akp-paper.pdf):

1. Commit-reveal preimage disclosure
2. DID spoofing without proof-of-key
3. Sybil amplification via weight stacking
4. Governance parameter injection
5. Stage 1 SSRF via user-supplied URLs
6. Replay attacks on reveal phase
7. WebSocket connection flooding (rate-limited per IP)
8. Unauthenticated RPC access (API key gate added)
