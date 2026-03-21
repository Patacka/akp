import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { createHash } from 'node:crypto'

// Noble ed25519 needs sha512 configured
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m))

export interface Identity {
  did: string
  publicKeyHex: string
  privateKeyHex: string
}

export async function generateIdentity(): Promise<Identity> {
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = await ed.getPublicKeyAsync(privateKey)
  const publicKeyHex = ed.etc.bytesToHex(publicKey)
  const did = `did:key:z${publicKeyHex}`
  return {
    did,
    publicKeyHex,
    privateKeyHex: ed.etc.bytesToHex(privateKey),
  }
}

export async function signPayload(payload: unknown, privateKeyHex: string): Promise<string> {
  const privateKey = ed.etc.hexToBytes(privateKeyHex)
  const message = new TextEncoder().encode(JSON.stringify(payload))
  const signature = await ed.signAsync(message, privateKey)
  return ed.etc.bytesToHex(signature)
}

export async function verifySignature(
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    const publicKey = ed.etc.hexToBytes(publicKeyHex)
    const signature = ed.etc.hexToBytes(signatureHex)
    const message = new TextEncoder().encode(JSON.stringify(payload))
    return await ed.verifyAsync(signature, message, publicKey)
  } catch {
    return false
  }
}

/**
 * Sign raw bytes (pre-encoded canonical payload) with an Ed25519 private key.
 * Prefer this over signPayload when you control the serialization (e.g. governance).
 */
export async function signBytes(bytes: Uint8Array, privateKeyHex: string): Promise<string> {
  const privateKey = ed.etc.hexToBytes(privateKeyHex)
  const sig = await ed.signAsync(bytes, privateKey)
  return ed.etc.bytesToHex(sig)
}

/**
 * Verify an Ed25519 signature over raw bytes.
 * publicKeyHex is the 32-byte raw public key in hex (extracted from did:key).
 */
export async function verifyBytes(
  bytes: Uint8Array,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    const sig = ed.etc.hexToBytes(signatureHex)
    const pub = ed.etc.hexToBytes(publicKeyHex)
    return await ed.verifyAsync(sig, bytes, pub)
  } catch {
    return false
  }
}

/**
 * Produce the canonical bytes that a reviewer must sign when submitting a
 * commit-reveal commit. Deterministic: sorted-key JSON → UTF-8 bytes.
 *
 * Including commitHash in the payload proves the reviewer knew the hash at
 * commit time and prevents anyone from submitting commits on behalf of
 * arbitrary DIDs (griefing / window-padding attacks).
 */
export function canonicalCommitPayload(commit: {
  commitHash: string
  id: string
  kuId: string
  reviewerDid: string
}): Uint8Array {
  const canonical = JSON.stringify({
    commitHash: commit.commitHash,
    id: commit.id,
    kuId: commit.kuId,
    reviewerDid: commit.reviewerDid,
  })
  return new TextEncoder().encode(canonical)
}

/**
 * Compute a deterministic 32-bit seed bound to a specific reviewer DID and claim.
 * Used for seedable VerificationProcedures: seed = SHA-256(claimId + reviewerDid) → int32.
 * A Sybil cannot copy this result because changing the DID changes the seed and
 * therefore the simulation output.
 */
export function computeDidBoundSeed(claimId: string, reviewerDid: string): number {
  const hash = createHash('sha256').update(claimId + reviewerDid).digest()
  return hash.readInt32BE(0)
}

export function extractPublicKeyFromDid(did: string): string {
  // did:key:z<hex> format
  if (!did.startsWith('did:key:z')) {
    throw new Error(`Unsupported DID format: ${did}`)
  }
  return did.slice('did:key:z'.length)
}

/**
 * Canonical serialisation of a VerificationProcedure for signing.
 * Only covers the fields that define what will be executed — not authorDid/signature.
 */
export function canonicalProcedurePayload(procedure: {
  type: string
  runtime: string
  executable: string
  entrypoint?: string
  expectedResult?: unknown
  tolerancePct?: number
  timeoutSeconds?: number
  seedable?: boolean
}): string {
  return JSON.stringify({
    type: procedure.type,
    runtime: procedure.runtime,
    executable: procedure.executable,
    entrypoint: procedure.entrypoint ?? null,
    expectedResult: procedure.expectedResult ?? null,
    tolerancePct: procedure.tolerancePct ?? 15,
    timeoutSeconds: procedure.timeoutSeconds ?? 120,
    seedable: procedure.seedable ?? false,
  })
}

export async function signProcedure<T extends {
  type: string; runtime: string; executable: string
  entrypoint?: string; expectedResult?: unknown
  tolerancePct?: number; timeoutSeconds?: number; seedable?: boolean
}>(procedure: T, identity: Identity): Promise<T & { authorDid: string; signature: string }> {
  const privateKey = ed.etc.hexToBytes(identity.privateKeyHex)
  const message = new TextEncoder().encode(canonicalProcedurePayload(procedure))
  const signature = await ed.signAsync(message, privateKey)
  return {
    ...procedure,
    authorDid: identity.did,
    signature: ed.etc.bytesToHex(signature),
  }
}

export async function verifyProcedureSignature(procedure: {
  type: string; runtime: string; executable: string
  entrypoint?: string; expectedResult?: unknown
  tolerancePct?: number; timeoutSeconds?: number; seedable?: boolean
  authorDid?: string; signature?: string
}): Promise<boolean> {
  if (!procedure.authorDid || !procedure.signature) return false
  try {
    const publicKeyHex = extractPublicKeyFromDid(procedure.authorDid)
    const publicKey = ed.etc.hexToBytes(publicKeyHex)
    const sig = ed.etc.hexToBytes(procedure.signature)
    const message = new TextEncoder().encode(canonicalProcedurePayload(procedure))
    return await ed.verifyAsync(sig, message, publicKey)
  } catch {
    return false
  }
}
