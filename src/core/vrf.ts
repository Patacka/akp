import { sha512 } from '@noble/hashes/sha512'
import * as ed from '@noble/ed25519'

// Simplified VRF using Ed25519 signing as a deterministic PRF
// In production this would use a proper VRF like draft-irtf-cfrg-vrf

export interface VrfOutput {
  hash: string
  proof: string
}

export async function vrfProve(
  privateKeyHex: string,
  input: string
): Promise<VrfOutput> {
  const privateKey = ed.etc.hexToBytes(privateKeyHex)
  const message = new TextEncoder().encode(input)
  const proof = await ed.signAsync(message, privateKey)

  // VRF hash = hash of the proof
  const proofBytes = proof
  const hashBytes = sha512(proofBytes)

  return {
    hash: ed.etc.bytesToHex(hashBytes),
    proof: ed.etc.bytesToHex(proof),
  }
}

export async function vrfVerify(
  publicKeyHex: string,
  input: string,
  output: VrfOutput
): Promise<boolean> {
  try {
    const publicKey = ed.etc.hexToBytes(publicKeyHex)
    const proof = ed.etc.hexToBytes(output.proof)
    const message = new TextEncoder().encode(input)
    return await ed.verifyAsync(proof, message, publicKey)
  } catch {
    return false
  }
}

// Select N agents from a pool deterministically using VRF
export function selectAgents<T extends { did: string; publicKeyHex: string }>(
  pool: T[],
  seed: string,
  count: number
): T[] {
  if (count >= pool.length) return [...pool]

  // Assign each agent a score based on hash(seed + did)
  const scored = pool.map(agent => {
    const hash = sha512(new TextEncoder().encode(seed + agent.did))
    // Use first 8 bytes as a uint64-ish score
    let score = 0
    for (let i = 0; i < 8; i++) {
      score = score * 256 + hash[i]
    }
    return { agent, score }
  })

  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, count).map(s => s.agent)
}
