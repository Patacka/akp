# AKP Prototype v0.1 — Known Limitations

This document records structural gaps, measurement weaknesses, and open research questions identified during Milestone 4 evaluation. Each limitation includes its current evidence and a suggested remedy.

---

## 1. LLM Independence Is Claim-Difficulty-Dependent, Not Structural

**What we tested:** Cross-architecture independence analysis using real LLMs: Llama-3.1-8B (local, Jan), arcee/Trinity-131B (OpenRouter), run against two batteries — an easy set of unambiguous facts and a hard set of common misconceptions and edge-case quantitative claims.

**Results:**

| Battery | Llama-8B accuracy | Trinity-131B accuracy | Pairwise κ |
|---|---|---|---|
| Easy (unambiguous facts, n=10) | 90% | 100% | **0.800** |
| Hard (misconceptions + edge cases, n=15) | 53% | 93% | **0.250** |

**Why it matters:** The AKP paper claims multi-agent corroboration provides independent verification. The data shows:

1. **On easy claims** (water boils at 100°C, atomic numbers): all capable models converge. κ≈0.8. There is no meaningful independence — agents echo each other. Corroboration adds no epistemic value beyond a single agent.

2. **On hard claims** (misconceptions, nuanced quantitative): models diverge (κ≈0.25), but divergence is driven by *accuracy differences*, not independent reasoning. Llama-8B absorbed misconceptions from training data (confirmed that glass flows, diamonds come from coal, Napoleon was short, Einstein failed maths, humans evolved from chimps). Trinity-131B correctly disputed all five. Disagreement here signals one model is *wrong*, not that agents are independently reasoning.

3. **The independence claim requires all agents to be equally calibrated.** In practice, larger/better-RLHF models systematically outperform smaller ones on misconception detection. A pool of one good model and two poor models will produce low κ, but the majority vote will be wrong.

**Evidence:** `test/pipeline/stage3-independence.test.ts` — `stage3-independence` test suite with `JAN_RUNNING=1` and `OPENROUTER_API_KEY`.

**Remedy:** Define a minimum per-agent accuracy threshold (≥80% on a calibration battery) before admitting an agent to the pool. Measure κ only on the hard battery — easy-claim κ is uninformative. Require architecturally diverse models from different training lineages with similar calibration scores, not just any N models.

---

## 2. Confidence Calibration Baseline Is 75.5% Average Accuracy

**What we tested:** `src/bench/confidence-sweep.ts` sweeps 80 weight combinations; best single-run accuracy is ~85%, average is 75.5%.

**Why it matters:** The default weights (`w_claims=0.35, w_reviews=0.35, w_sources=0.20, w_coherence=0.10`) were chosen heuristically. `w_sources` was identified as a dominant factor in sweep results but can be high even for fabricated sources (HTTP 200 ≠ content validity).

**Evidence:** `BENCHMARK-REPORT.md` §5; `src/bench/confidence-sweep.ts`.

**Remedy:** Use `src/core/confidence-calibrator.ts` (Nelder-Mead) with a labeled dataset of ≥200 KUs to optimize weights. Target ≥85% accuracy. Weight `w_sources` only after source-content validation (Stage 1 extended).

---

## 3. Stage 1 Source Verification Is Shallow (HTTP HEAD Only)

**What we tested:** `runStage1` issues HTTP HEAD requests to DOI, PubMed, RFC, and generic URLs. A 200 response counts as "accessible."

**Why it matters:** HTTP 200 only confirms the URL resolves; it does not verify that the cited source actually supports the claim. A malicious actor can cite any live URL.

**Evidence:** `src/pipeline/stage1.ts`; `test/pipeline/stage1.test.ts`.

**Remedy:** Extend Stage 1 to perform GET + content extraction for DOI/PubMed, then pass claim text + extracted abstract to a lightweight LLM to check semantic relevance (binary: supports / does not support).

---

## 4. Contradiction Detection Window Is Limited to 2 Hops

**What we tested:** `graph.checkContradictions(claim, kuId, maxHops=2)` performs BFS up to 2 hops.

**Why it matters:** The labeled fixture (`test/fixtures/contradictions.ts`) shows that hop-3 recall with no intermediate nodes is ~0%, and hop-4 recall is ~0%. These are documented known limitations, but they represent real false-negative risk in large graphs.

**Evidence:** `test/core/contradiction-fnr.test.ts` — "documents hop-3/4 as outside 2-hop detection window."

**Remedy:** Increase `maxHops` to 3 or 4 for high-stakes domains (medicine, law). Cache intermediate BFS results to keep P95 < 5ms at 10k nodes. Add property-graph indexing by `(subject, predicate)` to enable O(1) contradiction lookup regardless of hop distance.

---

## 5. WebSocket Sync Lacks Authentication

**What we tested:** `SyncPeer` opens a plain WebSocket server. Any client that knows the port can connect and push sync messages.

**Why it matters:** An adversary on the same network can inject arbitrary Automerge sync messages. Automerge's merge semantics are content-addressed (CRDTs), so injected documents could pollute the knowledge store.

**Evidence:** `src/sync/peer.ts`; `test/sync/websocket.test.ts`.

**Remedy:** Add mutual TLS or a pre-shared token challenge on WebSocket upgrade. Validate that incoming Automerge documents pass Ed25519 DID signature verification before applying sync.

---

## 6. Sybil Resistance Relies on Anti-Monopolization Cap, Not Identity Verification

**What we tested:** The 40% reviewer-weight cap (`MAX_SINGLE_REVIEWER_WEIGHT`) limits any single DID's influence. `test/security/sybil.test.ts` and `test/security/coordinated-attack.test.ts` confirm collusion is capped.

**Why it matters:** Creating 1000 unique DIDs is free. An attacker with 1000 DIDs each at weight 0.3 will collectively occupy ~100% of the cap budget after renormalization, effectively monopolizing the score without any single DID exceeding the threshold.

**Evidence:** `src/bench/sybil-sim.ts` — `simulateSybilAttack` shows cap effectiveness against small Sybil pools; large pools not tested.

**Remedy:** Integrate a web-of-trust or proof-of-work DID onboarding requirement. Alternatively, use temporal diversity requirements (reviewer DIDs must have existed for ≥N days and have ≥M prior reviews before their weight is counted).

---

## 7. 100k Graph Build Causes Significant Memory Pressure

**What we tested:** `src/bench/graph-scale.ts` `benchmarkGraphScale100k()` builds a 100k-node `RelationGraph` (in-memory adjacency map).

**Why it matters:** At 100k nodes with 1–3 edges each, the adjacency map holds ~200k–300k entries. In Node.js, each `Map` entry is ~80–100 bytes overhead, meaning the graph alone uses ~24–30 MB. Combined with Automerge documents in `KUStore`, total heap pressure could exceed 512 MB for a production node.

**Evidence:** `GraphScaleResult.memoryMB` field in benchmark output.

**Remedy:** Replace the in-memory `RelationGraph` with a persistent graph index (SQLite virtual table or a dedicated graph DB like DGraph-lite). Keep only the 2-hop neighborhood in memory per query.

---

## 8. Seed Import Uses Simplified Wikidata/PubMed Fixtures (Not Live API)

**What we tested:** `scripts/import-seed.ts` imports from `data/seed/wikidata-sample.json` (50 entities) and `data/seed/pubmed-sample.json` (20 articles) — hand-curated static fixtures.

**Why it matters:** Real Wikidata/PubMed entities have richer provenance chains, multi-language labels, and citation networks. The static fixture underestimates the import pipeline's real-world robustness.

**Evidence:** `data/seed/wikidata-sample.json`.

**Remedy:** Replace with live Wikidata SPARQL queries (`wikidata.org/sparql`) and PubMed E-utilities API calls at import time, falling back to the static fixture if offline.

---

## 9. Automerge CRDT Merge Cost Grows With Document History

**What we tested:** `src/bench/merge-cost.ts` measures merge at 10 concurrent writers → 0.62ms/op.

**Why it matters:** Automerge stores the full operation history. Documents with thousands of edits accumulate a large internal log, causing merge cost to grow over time.

**Evidence:** `BENCHMARK-REPORT.md` §3 — merge cost measured only at initial document size, not after 1000 edits.

**Remedy:** Implement Automerge document compaction (snapshot + trim) after each maturity transition. Add a regression test measuring merge cost after 5000 edits.

---

## Summary Table

| # | Limitation | Severity | Effort to Fix |
|---|---|---|---|
| 1 | LLM independence is claim-difficulty-dependent, not structural | High | High |
| 2 | Confidence calibration accuracy 75.5% | Medium | Low |
| 3 | Stage 1 shallow HTTP-only verification | High | High |
| 4 | 2-hop contradiction window | Medium | Medium |
| 5 | WebSocket sync unauthenticated | High | Medium |
| 6 | Sybil resistance breaks at large pools | High | High |
| 7 | 100k graph memory pressure | Medium | High |
| 8 | Seed import uses static fixtures | Low | Low |
| 9 | Automerge history growth | Medium | Medium |
