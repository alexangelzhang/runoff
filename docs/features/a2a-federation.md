# A2A Federation — Auth & HA (P3)

> **Experimental — not production multi-tenant HA.**  
> For peer directory sync, leases, and CRDT merge in **self-hosted** experiments only.  
> Main path: [getting-started-30min.md](guides/getting-started-30min.md) · Advanced index: [advanced/README.md](advanced/README.md)

## Auth

When `orchestration.a2a.bearerTokens` is set, **GET and POST** `/a2a/federation/directory` require:

```http
Authorization: Bearer <token>
```

Outbound peer sync uses `orchestration.a2a.clientToken` (or the same token via env).

## HA options

| Config | Purpose |
|--------|---------|
| `federationSyncUrls` | Peer base URLs to pull directory |
| `federationSyncRetries` | Per-peer fetch retries (default **2**) |
| `federationBackupPath` | Copy `agents.json` after successful merge |
| `federationConflictStrategy` | `local-wins` / `newest-wins` / `remote-wins` / `vector-wins` / **`crdt-merge`** (P7) |
| `federationNodeId` | Node id for vector-clock stamps on persist (env `RUNOFF_FEDERATION_NODE_ID`) |
| `federationQuorumMin` | Min peers that must advertise an `agentId` before merge (P5; default **1**) |

### Vector-clock merge (P4)

With `federationConflictStrategy: "vector-wins"`, conflicting agent cards are resolved by partial-order vector comparison (`federation-vector.ts`). Each local persist bumps `metadata.federationVector[nodeId]` when `federationNodeId` is set.

### Quorum merge (P5)

When `federationQuorumMin` > 1, peer sync collects all directories first, then only merges agent cards seen on at least N peers (`federation-quorum.ts`). Example majority with three peers: `"federationQuorumMin": 2`.

### Leader election (P6)

With `federationLeaderElection: true` and `federationNodeId` set:

- All nodes **pull** peer directories (same as before).
- Only the **leader** (lexicographically smallest reachable node id) **POSTs** the merged directory back to peers.

Requires reachable peers for stable leadership; see `federation-leader.ts`.

### Leader lease (P7)

With `federationLeaderLease: true`, leadership is held via `leader-lease.json` under the federation directory (default TTL **30s**, `federationLeaseMs`). Holder renews on each sync; expired leases can be taken by another node.

### CRDT merge (P7/P8)

`federationConflictStrategy: "crdt-merge"` uses `mergeAgentCardCrdt` — vector max + LWW fields + skill/auth union + metadata LWW per `agentId` (`federation-crdt.ts`).

Tombstones (`metadata.federationTombstone`) propagate through the federation file; `filterActiveAgentCards` hides them when registering into the local agent registry. Create tombstones with `createAgentCardTombstone(agentId, nodeId)`.

### Lease heartbeat (P8)

When `federationLeaderLease` is enabled, `federationLeaseHeartbeat` (default **true**) runs a background renew loop on the HTTP transport (`federationLeaseHeartbeatMs` optional). Disable with `"federationLeaseHeartbeat": false`.

### Lease witness & split-brain (P9)

- **GET** `/a2a/federation/lease` — returns `{ version: 1, lease }` for remote witness
- `federationLeaseWitnessUrls` — peer base URLs checked after each sync (`federation-lease-witness.ts`)
- When multiple valid holders are seen, `detectFederationSplitBrain` sets `splitBrain.detected` and logs a warning unless `federationSplitBrainAlert: false`

### Tombstone delete & GC (P9)

```typescript
import { deleteFederatedAgentCard, compactFederationTombstones } from "./experimental/a2a/federation-delete.js";

deleteFederatedAgentCard("my-agent", { nodeId: "node-a", enabled: true });
compactFederationTombstones({ enabled: true, retentionMs: 604800000 }); // default 7d
```

`federationTombstoneRetentionMs` on A2A config runs GC after peer sync (`0` disables).

### Lease arbitration & auto-downgrade (P10)

On split-brain, `arbitrateFederationLease` picks the canonical holder (highest `term`, lexicographic tie-break). When `federationLeaseAutoDowngrade` is enabled (default **true** with witnesses), a non-winner calls `releaseFederationLease` and skips leader push.

Config: `federationLeaseArbitration`, `federationLeaseAutoDowngrade`.

### Skill-level tombstones (P10)

Partial deletes use `metadata.federationSkillTombstones` (skill id → deletedAt). Registry hydration exposes only `getActiveSkills(card)`.

```typescript
import { deleteFederatedAgentSkill } from "./experimental/a2a/federation-delete.js";

deleteFederatedAgentSkill("my-agent", "skill-id", { nodeId: "node-a", enabled: true });
```

Skill tombstone GC runs inside `compactFederationTombstones` (`gcSkillTombstonesOnAgents`). Configure `federationSkillTombstoneRetentionMs` or inherit `federationTombstoneRetentionMs`.

### Lease write quorum witnesses (P11)

On lease acquire/renew, `recordLeaseWriteWitness` appends to `lease-quorum-witnesses.json`. **GET** `/a2a/federation/lease/witnesses` exposes the log.

When `federationLeaseQuorumMin` > 1, `confirmLeaseWriteQuorum` requires enough peer GET `/lease` agreement (+ local vote) before holding leadership; otherwise the local lease is released.

### Witness POST receipt (P12)

- **POST** `/a2a/federation/lease/witness` — body `{ entry: { witnessNodeId, holderNodeId, term, at? } }` returns `{ ok, receiptId, ... }`
- After local lease write, `broadcastLeaseWitnessToPeers` pushes attestations to `federationLeaseWitnessUrls` (disable with `federationLeaseWitnessBroadcast: false`)

### Skill quorum merge (P12)

`federationSkillQuorumMin` > 1 keeps only skills listed on at least N peer directories (`federation-skill-quorum.ts`). Applied after peer merge in `syncFederationFromPeers`.

### Lease audit chain (P13)

Hash-linked append-only log in `lease-audit-chain.json`. Events: `witness`, `acquire`, `renew`, `release`, `quorum_ok`, `quorum_fail`, `downgrade`. Written by lease acquire/renew/release, witness log, quorum confirm, and auto-downgrade.

- **GET** `/a2a/federation/lease/audit` — returns chain; verify with `verifyLeaseAuditChain`

### Cross-agent skill dependency graph (P13)

Store deps on card metadata key `federationSkillDeps`: `{ [skillId]: ["otherAgent:otherSkill", ...] }`. CRDT merge unions refs per skill (`federation-skill-deps.ts`). Use `buildSkillDependencyGraph` / `detectSkillDependencyCycle` for validation.

### Skill dependency cycle guard (P14) + prune (P15)

When `federationSkillDepsPruneSync` is true (default), cyclic deps are pruned edge-by-edge (`pruneSkillDependencyCycles`) before persist. Strategy: `federationSkillDepsPruneStrategy` — `last-edge` (default), `oldest-dep`, `min-edge`. If prune is disabled and `federationSkillDepsBlockSync` is true, sync/merge is blocked as in P14.

### Lease audit seal + export (P14)

- Optional HMAC seal on chain head: set `federationLeaseAuditSecret` (+ `federationLeaseAuditNodeId`); auto-seal after each append via `configureLeaseAuditSigning`
- `verifyLeaseAuditSeal(chain, secret)` — `seal` field on `lease-audit-chain.json`
- **GET** `/a2a/federation/lease/audit/export?format=ndjson|json` — download attachment
- **GET** `/a2a/federation/lease/audit/export?format=bundle` — detached manifest + events + `manifestSignature` (P16)

### Lease audit key rotation (P15)

- `lease-audit-keyring.json` tracks `activeKeyId` + retired kids (secrets stay in config only)
- Seals include `keyId`; `verifyLeaseAuditSeal(chain, { kid: secret, ... })`
- **GET** `/a2a/federation/lease/audit/keyring`
- **POST** `/a2a/federation/lease/audit/rotate` — body `{ keyId, secret }`
- Config: `federationLeaseAuditKeyRing`, `federationLeaseAuditKeyId`

### Offline bundle verify (P17)

```bash
npm run verify-lease-audit-bundle -- path/to/lease-audit-bundle.json --secret "$FEDERATION_LEASE_AUDIT_SECRET"
```

### Skill dep prune log + receipt (P17)

On prune during sync/merge, entries append to `skill-deps-prune-log.json`. `syncFederationFromPeers` returns `skillDepsPruneReceipt` with `receiptId` when pruning occurred.

### Federation log APIs (P18)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/a2a/federation/skill-deps/prune-log` | Skill dep prune log (`?limit=N`, `?agentId=`, `?receiptId=`, `?format=ndjson`) |
| GET | `/a2a/federation/lease/audit/log` | Lease audit chain tail (`?limit=N`, `?type=` comma OR, `?exclude=` comma NOT, `?format=ndjson`) |
| POST | `/a2a/federation/skill-deps/prune-strategy/rollback` | Enable LWW rollback mode (`{ enable }`) or apply audit rollback (`{ agentId }`) |
| GET | `/a2a/federation/lease/audit` | Full audit chain (unchanged) |

### Per-agent prune strategy (P18)

Set on federated agent card metadata:

```json
"federationSkillDepsPruneStrategy": "oldest-dep"
```

Values: `last-edge`, `oldest-dep`, `min-edge`. When exactly one agent on a cycle has an override, that strategy is used for the prune pick; otherwise the global `federationSkillDepsPruneStrategy` applies.

CRDT merge (P19): when two replicas set different strategies on the same agent card, `mergeSkillDepPruneStrategyCrdt` keeps the most conservative (`min-edge` &gt; `oldest-dep` &gt; `last-edge`).

P20 vector tie-break: when ranks tie, federation vector clock (`vectorDominates`) picks the winning replica's strategy; otherwise LWW on `federationUpdatedAt`.

P21 prune strategy audit: when CRDT merge reconciles conflicting `federationSkillDepsPruneStrategy` values on the same agent, an append-only `skill_prune_strategy` event is written to the lease audit chain (`detail` JSON: `priorA`, `priorB`, `merged`, `rollbackTarget`).

P22 rollback: set `configureSkillDepPruneStrategyRollback(true)` (or POST rollback with `{ enable: true }`) so merges use LWW undo (`rollbackSkillDepPruneStrategyCrdt`) instead of conservative merge. POST `{ agentId }` applies `rollbackTarget` from the latest audit event to the federated agent card.

P23 audit filter: `?type=acquire,skill_prune_strategy` matches events whose `type` is any listed value. Successful agent rollback clears rollback mode automatically.

P24 audit exclude: `?exclude=acquire` drops listed types (combinable with `?type=`). Failed agent rollback (`applied.ok: false`, e.g. `reason: "no rollback audit"`) leaves rollback mode unchanged.

P25 audit filters: overlapping `?type=` and `?exclude=` values return HTTP 400. POST `/prune-strategy/rollback` always includes `rollbackMode` reflecting the process flag after the request.

P26 audit empty: filtered GET with zero matches sets `filteredEmpty: true` and `emptyHint` (`no events match filter` or `audit chain empty`). Rollback POST includes `priorMode` (before the request) and `rollbackMode` (after).

P27 prune-log empty: `?agentId=` / `?receiptId=` with no matches sets `filteredEmpty` + `emptyHint`. Rollback POST omits `applied` when only `{ enable }` is sent; include `applied` only with `{ agentId }`.

P28 prune-log receipt: unknown `?receiptId=` sets `emptyHintCode: receipt_not_found` and `receiptNotFound: true`. Rollback POST always includes `priorMode` even when `applied.ok` is false.

P29 audit empty: filtered GET adds `emptyHintCode` (`no_events_match_filter` or `audit_chain_empty`). Rollback POST sets top-level `ok: false` when `applied.ok` is false (still includes `priorMode` / `rollbackMode`).

P30 audit NDJSON: zero-match filter returns a single `_meta` JSON line with `filteredEmpty` / `emptyHintCode`. Rollback failures include `applied.reasonCode` (`no_rollback_audit`, `agent_not_found`, etc.).

P31 prune-log NDJSON: same `_meta` line pattern when filtered empty. Successful agent rollback sets `applied.reasonCode: "applied"`.

P32 empty NDJSON schema: prune-log and lease audit share `federation-log-empty-v1` (`schema`, `totalCount`, `filteredEmpty`, `emptyHint`, `emptyHintCode`). JSON bodies still use `totalEntries` / `totalEvents` respectively.

P33 rollback audit: each agent rollback appends `skill_prune_strategy_rollback` with `detail.reasonCode` (and `strategy` when `ok: true`). Lease audit type list includes this event; conflict audits remain `skill_prune_strategy`.

### POST `/a2a/federation/skill-deps/prune-strategy/rollback` — `applied.reasonCode`

| `reasonCode` | `applied.ok` | When |
|--------------|--------------|------|
| `applied` | `true` | Agent card strategy restored from last `skill_prune_strategy` audit |
| `no_rollback_audit` | `false` | No audit entry for `agentId` |
| `no_rollback_target` | `false` | Audit exists but `rollbackTarget` / `priorA` missing |
| `store_path_required` | `false` | `agentId` rollback without federation store path |
| `agent_not_found` | `false` | `agentId` not in `agents.json` |

Top-level `ok` is `false` when `applied` is present and `applied.ok` is `false`. Body always includes `priorMode` and `rollbackMode`; `applied` is omitted unless `{ "agentId": "..." }` is sent.

## Health probe

```typescript
import { probeFederationPeers } from "./experimental/a2a/federation-ha.js";

const status = await probeFederationPeers(["http://node-b:9400"], process.env.FED_TOKEN);
```

## Limits (MVP)

- File-backed directory per node; vector-clock is **CRDT-lite** (not full operational CRDT)
- Best-effort peer push/pull; no quorum election

See `federation-sync.ts`, `federation-quorum.ts`, `federation-leader.ts`, `federation-lease.ts`, `federation-crdt.ts`, `federation-vector.ts`, `http-transport.ts`, `federated-registry-store.ts`.
