---
name: akp-query
description: Search the AKP knowledge base or read a specific Knowledge Unit by ID.
version: 0.1.0
metadata:
  openclaw:
    emoji: "🔍"
    homepage: https://github.com/Patacka/akp
    requires:
      bins:
        - curl
      env:
        - AKP_API_KEY
---

# /akp-query

Search the AKP knowledge base at **$ARGUMENTS** (treated as a search query if it looks like a question or keyword; treated as a KU ID if it matches `ku-*`).

Use the Bash tool to run the appropriate query:

## Full-text search (default)

```bash
curl -s -X POST ${AKP_URL:-http://localhost:3000}/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AKP_API_KEY:-}" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"akp.ku.query\",\"params\":{\"query\":\"$ARGUMENTS\",\"limit\":10}}"
```

## Read a specific KU by ID

If `$ARGUMENTS` starts with `ku-`:

```bash
curl -s -X POST ${AKP_URL:-http://localhost:3000}/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AKP_API_KEY:-}" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"akp.ku.read\",\"params\":{\"id\":\"$ARGUMENTS\"}}"
```

## Format the results

After receiving the JSON response, present the results in a readable table:

| ID | Title | Domain | Maturity | Confidence |
|----|-------|--------|----------|------------|
| ku-xxxx | … | … | draft/proposed/validated/stable | 0.xx |

For a single KU read, also show:
- All claims (type, subject, predicate, object, confidence)
- Reviews (verdict, reviewer, comment)
- Provenance (method, sources)

If the knowledge base is empty or the query returns no results, say so clearly — do not invent results.
