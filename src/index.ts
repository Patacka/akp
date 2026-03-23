/**
 * AKP — Agent Knowledge Protocol
 *
 * Each agent is a node. Import AKPNode and start.
 *
 * @example
 * import { AKPNode } from 'akp'
 *
 * const node = await AKPNode.start({
 *   bootstrap: ['wss://relay.akp.community'],
 * })
 *
 * // Discover skills contributed by peers
 * const skills = node.skills()
 *
 * // Contribute knowledge back
 * const kuId = node.contribute({
 *   domain: 'skill',
 *   title: 'Web search via Brave',
 *   claims: [{ subject: 'brave-search', predicate: 'serverUrl', object: 'https://...' }],
 * })
 *
 * node.close()
 */

export { AKPNode } from './node.js'
export type { AKPNodeOptions, ContributeParams, QueryParams } from './node.js'

// Core types — re-exported for agents that want to work with KUs directly
export type { KnowledgeUnit, Claim, ProvenanceRecord, Source } from './core/ku.js'
export { createKU, createProvenance, createClaim } from './core/ku.js'
export { KUStore } from './core/store.js'
export { RelationGraph } from './core/graph.js'
export { generateIdentity } from './core/identity.js'
export type { Identity } from './core/identity.js'
