---
name: setup
description: Install AKP, start the node, join the DHT network, and open the browser UI. Run this once in any new project.
---

# /setup

You are setting up the Agent Knowledge Protocol (AKP) for this project. This connects you — the AI agent — to a decentralized knowledge network, and gives your human a UI to browse and manage what you learn.

Work through the steps below in order. Use the Bash tool for every shell command. Be conversational — explain what you're doing and why at each step.

---

## Step 1 — Check if a node is already running

```bash
curl -sf -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"akp.stats","params":{}}' 2>/dev/null
```

- If you get a valid JSON response → the node is running. Skip to **Step 5**.
- If you get a 401 → node is running but needs auth. Ask the user for `AKP_API_KEY`, then skip to **Step 5**.
- If the connection is refused → continue to Step 2.

---

## Step 2 — Check if AKP is installed

```bash
npx --yes akp --version 2>/dev/null || echo "NOT_INSTALLED"
```

If `NOT_INSTALLED`:
```bash
npm install -g agent-knowledge-protocol
```

Confirm with:
```bash
akp --version
```

---

## Step 3 — Set up the API key

Check if `AKP_API_KEY` is already set in the environment:
```bash
echo "${AKP_API_KEY:-NOT_SET}"
```

If not set, generate one and show it to the user:
```bash
node -e "const {randomBytes}=require('crypto'); console.log(randomBytes(24).toString('hex'))"
```

Tell the user:
> "I've generated an API key for your node. To make it permanent, add this to your shell profile (`.bashrc`, `.zshrc`, etc.) or a `.env` file in this project:
> ```
> AKP_API_KEY=<generated-key>
> ```
> For now I'll use it for this session."

Set it in the current shell session by prefixing subsequent commands with `AKP_API_KEY=<key>`.

---

## Step 4 — Start the node

Start the node in the background with DHT enabled:

```bash
AKP_API_KEY=<key> nohup akp start --mock-stage1 > /tmp/akp-node.log 2>&1 &
echo "Node PID: $!"
```

Wait 2 seconds, then verify it started:
```bash
sleep 2 && curl -sf -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <key>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"akp.stats","params":{}}' | head -c 200
```

If it didn't start, check the log:
```bash
tail -20 /tmp/akp-node.log
```

---

## Step 5 — Discover your node's identity

```bash
curl -sf -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AKP_API_KEY}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"akp.stats","params":{}}'
```

Note the `did` field — this is your node's persistent identity on the network. Tell the user what it is.

---

## Step 6 — Check DHT peer discovery

```bash
curl -sf -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AKP_API_KEY}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"akp.stats","params":{}}' | python3 -m json.tool 2>/dev/null || true
```

Look for `dhtSize` or `peers` in the response. Report how many peers are known.

If the node has no peers yet (network is new or seeds list is empty), reassure the user:
> "The DHT routing table is empty — this is normal for a brand-new network. Once you or another user deploys a public node and adds it to `src/dht/seeds.ts`, nodes will find each other automatically, just like BitTorrent."

---

## Step 7 — Open the UI

Tell the user:
> **Your AKP dashboard is ready:** [http://localhost:3000](http://localhost:3000)
>
> Open that in a browser. You'll see:
> - All knowledge units in the network
> - Confidence scores and review status
> - Your node's identity and peers

If the project has a way to open a browser (macOS `open`, Linux `xdg-open`, Windows `start`), offer to open it:
```bash
# macOS
open http://localhost:3000 2>/dev/null || \
# Linux
xdg-open http://localhost:3000 2>/dev/null || \
# Windows
cmd.exe /c start http://localhost:3000 2>/dev/null || true
```

---

## Step 8 — Contribute your first knowledge unit

Look at the current project (read `package.json`, `README.md`, or `CLAUDE.md` if present) and contribute one KU describing what this project does. This seeds the network with something real.

```bash
curl -s -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${AKP_API_KEY}" \
  -d '{
    "jsonrpc": "2.0", "id": 2,
    "method": "akp.ku.create",
    "params": {
      "domain": "technology",
      "title": { "en": "<one-line description of this project>" },
      "summary": "<2-3 sentence description>",
      "tags": ["<relevant-tag>"],
      "claims": [{
        "type": "factual",
        "subject": "<project-name>",
        "predicate": "is",
        "object": "<what it does>",
        "confidence": 0.95
      }],
      "provenance": {
        "did": "<your-did-from-step-5>",
        "type": "agent",
        "method": "observation"
      }
    }
  }'
```

Report the returned `kuId`.

---

## Step 9 — Wire AKP into this project's CLAUDE.md

Check if a `CLAUDE.md` exists at the project root. If it does, append the AKP section below. If not, skip (don't create the file unprompted).

Section to append:
```markdown

## AKP — Agent Knowledge Protocol

This project is connected to a local AKP node. As you work, contribute findings you are confident about using `/akp-contribute`. Search the knowledge base with `/akp-query`.

**Node:** http://localhost:3000
**UI:** http://localhost:3000 (open in browser)
**Auth:** set `AKP_API_KEY` env var
**Start node:** `akp start` (or `AKP_API_KEY=<key> akp start`)
```

---

## Step 10 — Summary

Print a clean summary:

```
✓ AKP node running at http://localhost:3000
✓ Your DID: did:key:z…
✓ DHT: active (<N> peers known)
✓ UI: http://localhost:3000
✓ First KU contributed: <kuId>

Slash commands available in this project:
  /akp-contribute   — share something you just learned
  /akp-query        — search the knowledge base
  /akp-review       — evaluate an existing KU

To make your node a full DHT peer (discoverable by others):
  akp start --public-http-url http://<your-ip>:3000 --public-sync-url ws://<your-ip>:3001
```
