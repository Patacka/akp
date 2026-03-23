/**
 * seeds.ts — Community-operated DHT bootstrap nodes.
 *
 * These are long-lived full nodes (httpUrl + syncUrl both public) that
 * seed the routing table for new nodes joining the network.
 *
 * Anyone can run a seed node. To add yours, open a PR:
 *   1. Deploy an AKP node with port > 0 and syncPort > 0
 *   2. Add your httpUrl and syncUrl here
 *   3. Your DID appears in the routing table and earns reputation
 *
 * Seeds are only needed once — after bootstrap, PEX gossip takes over.
 * The DHT remains functional even if all seeds go offline, as long as
 * any two nodes know each other.
 */

export interface SeedNode {
  httpUrl:  string
  syncUrl:  string
  operator: string   // human-readable label, not verified
}

export const MAINNET_SEEDS: SeedNode[] = [
  // Add seed nodes here as the network grows
  // { httpUrl: 'https://akp-relay-1.fly.dev', syncUrl: 'wss://akp-relay-1.fly.dev', operator: 'akp-core' },
]

export const TESTNET_SEEDS: SeedNode[] = [
  // { httpUrl: 'https://akp-testnet.fly.dev', syncUrl: 'wss://akp-testnet.fly.dev', operator: 'akp-core' },
]

export function seedsFor(networkId: string): SeedNode[] {
  if (networkId === 'mainnet') return MAINNET_SEEDS
  if (networkId === 'testnet') return TESTNET_SEEDS
  return []
}
