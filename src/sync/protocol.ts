import * as Automerge from '@automerge/automerge'
import type { KUStore } from '../core/store.js'

type AKUDoc = { ku: Record<string, unknown> }

export interface SyncSession {
  peerId: string
  syncStates: Map<string, Automerge.SyncState>  // kuId -> syncState
  // In-flight docs for KUs not yet persisted to the store (during multi-round sync)
  pendingDocs: Map<string, Automerge.Doc<AKUDoc>>
}

export function createSyncSession(peerId: string): SyncSession {
  return { peerId, syncStates: new Map(), pendingDocs: new Map() }
}

export function getSyncState(session: SyncSession, kuId: string): Automerge.SyncState {
  return session.syncStates.get(kuId) ?? Automerge.initSyncState()
}

export function setSyncState(session: SyncSession, kuId: string, state: Automerge.SyncState): void {
  session.syncStates.set(kuId, state)
}

// Generate all pending sync messages for a peer
export function generateAllSyncMessages(
  store: KUStore,
  session: SyncSession
): Array<{ kuId: string; message: Uint8Array }> {
  const messages: Array<{ kuId: string; message: Uint8Array }> = []
  // Include both local IDs and any IDs the peer has told us about (may not be local yet)
  const kuIds = new Set([...store.allIds(), ...session.syncStates.keys()])
  for (const kuId of kuIds) {
    const state = getSyncState(session, kuId)
    // Try the store first
    const [newState, message] = store.generateSyncMessages(kuId, state)
    if (newState !== state || message !== null) {
      setSyncState(session, kuId, newState)
      if (message) {
        messages.push({ kuId, message })
      }
      continue
    }
    // If the store returned the same state + null (doc not found), use pending doc
    const pendingDoc = session.pendingDocs.get(kuId)
    if (pendingDoc) {
      const [newState2, message2] = Automerge.generateSyncMessage(pendingDoc, state)
      setSyncState(session, kuId, newState2)
      if (message2) {
        messages.push({ kuId, message: message2 })
      }
    }
  }
  return messages
}

// Apply a batch of sync messages received from peer
export function applyBatchSyncMessages(
  store: KUStore,
  session: SyncSession,
  batch: Array<{ kuId: string; message: Uint8Array }>
): number {
  let changedCount = 0
  for (const { kuId, message } of batch) {
    const state = getSyncState(session, kuId)

    // Check if store has the doc
    const storeHasDoc = store.allIds().includes(kuId)

    if (storeHasDoc) {
      // Normal path: let the store handle it
      const [newState, changed] = store.receiveSyncMessage(kuId, state, message)
      setSyncState(session, kuId, newState)
      if (changed) changedCount++
      // Remove from pending if it was there
      session.pendingDocs.delete(kuId)
    } else {
      // Store doesn't have the doc yet - use a pending doc
      let doc = session.pendingDocs.get(kuId) ?? Automerge.init<AKUDoc>()
      const [newDoc, newSyncState] = Automerge.receiveSyncMessage(doc, state, message)
      setSyncState(session, kuId, newSyncState)
      if (newDoc !== doc) {
        changedCount++
        doc = newDoc
        // Check if the doc now has actual data
        const ku = (newDoc.ku as unknown) as { id?: string } | undefined
        if (ku && ku.id) {
          // The doc has data - let the store take over by applying the full binary
          const binary = Automerge.save(newDoc)
          store.mergeFrom(kuId, binary)
          session.pendingDocs.delete(kuId)
        } else {
          // Still waiting for data - keep in pending
          session.pendingDocs.set(kuId, doc)
        }
      } else {
        session.pendingDocs.set(kuId, doc)
      }
    }
  }
  return changedCount
}

// Check if two stores are already in sync (same doc IDs and same Automerge heads)
function storesAreInSync(storeA: KUStore, storeB: KUStore): boolean {
  const idsA = storeA.allIds().sort()
  const idsB = storeB.allIds().sort()
  if (idsA.length !== idsB.length) return false
  for (let i = 0; i < idsA.length; i++) {
    if (idsA[i] !== idsB[i]) return false
    const binA = storeA.getAutomergeBinary(idsA[i])
    const binB = storeB.getAutomergeBinary(idsB[i])
    if (!binA || !binB) return false
    const headsA = Automerge.getHeads(Automerge.load<AKUDoc>(binA))
    const headsB = Automerge.getHeads(Automerge.load<AKUDoc>(binB))
    if (headsA.length !== headsB.length) return false
    if (headsA.sort().join(',') !== headsB.sort().join(',')) return false
  }
  return true
}

// Full sync round-trip between two stores (for testing / in-process sync)
export async function syncStores(
  storeA: KUStore,
  storeB: KUStore,
  maxRounds = 10
): Promise<{ rounds: number; exchanged: number }> {
  // Fast path: if both stores are already in sync, skip protocol exchange
  if (storesAreInSync(storeA, storeB)) {
    return { rounds: 0, exchanged: 0 }
  }

  const sessionA = createSyncSession('node-b')  // A's session for talking to B
  const sessionB = createSyncSession('node-a')  // B's session for talking to A

  let totalExchanged = 0
  let rounds = 0

  for (let round = 0; round < maxRounds; round++) {
    rounds++
    let anyMessage = false

    // A -> B
    const aMessages = generateAllSyncMessages(storeA, sessionA)
    if (aMessages.length > 0) {
      anyMessage = true
      const changed = applyBatchSyncMessages(storeB, sessionB, aMessages)
      totalExchanged += aMessages.length
    }

    // B -> A
    const bMessages = generateAllSyncMessages(storeB, sessionB)
    if (bMessages.length > 0) {
      anyMessage = true
      const changed = applyBatchSyncMessages(storeA, sessionA, bMessages)
      totalExchanged += bMessages.length
    }

    if (!anyMessage) break
  }

  return { rounds, exchanged: totalExchanged }
}
