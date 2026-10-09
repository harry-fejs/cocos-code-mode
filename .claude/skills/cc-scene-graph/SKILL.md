---
name: cc-scene-graph
description: Use for Cocos scene/project structural search, composite node resolution, bounded hierarchy navigation, asset references, or session continuation. Uses the offline T0/T1 graph and requires a live read before every mutation.
---

# cc-scene-graph

Offline structural navigation for saved Cocos assets. The graph answers **where/what**; CCP remains authoritative for unsaved state, runtime state, and every write.

## Authority model

- T0 identity: engine UUID plus source file. Indexed as composite `handle = <file>#<uuid>`.
- T1 structure: saved hierarchy, component attachment, script identity, asset references. Indexed.
- T2 mutable values: transforms, active state, component values. Never indexed.
- T3 runtime/editor state: selection, viewport, undo, runtime instances. Never indexed.

Node UUIDs and prefab `fileId` values are file-local. Never pass a composite handle directly to Cocos. Resolve its `uuid`, then confirm the exact live scene/target through CCP.

## Cache layout

All generated data lives below one ignored root:

```text
<project>/.cocos-graph/<namespace>/
  _manifest.json
  <bundle>/graph-<semantic-hash>.json
```

`--isolate` or `CC_GRAPH_ISOLATE=1` selects a branch/worktree namespace. `CC_GRAPH_SLUG` overrides its slug. `--out` wins over `CC_GRAPH_OUT`, which wins over isolation defaults. Builds use a bounded namespace lock and atomic generation publication.

## Commands

```bash
# Build all bundles or exactly one bundle
node tools/cocos-graph/bin/cocos-graph.mjs build --project <project> [--bundle <bundle>] [--isolate]

# Overlay one expanded live scene; JSON must include sourceFile, tree, dirty
node tools/cocos-graph/bin/cocos-graph.mjs build --project <project> --bundle <bundle> --live-json <snapshot.json> --isolate

# Search; filters compose with AND
node tools/cocos-graph/bin/cocos-graph.mjs query --project <project> --bundle <bundle> [--by-component <type>] [--by-script <uuid>] [--component-id <id>] [--path-glob <path>] [--text <q>] [--explain] [--limit 50] [--cursor 0] --isolate

# Resolve identity; ambiguous bare UUID exits 3 and returns candidates
node tools/cocos-graph/bin/cocos-graph.mjs resolve --project <project> --bundle <bundle> --handle <file#uuid> --isolate
node tools/cocos-graph/bin/cocos-graph.mjs resolve --project <project> --bundle <bundle> --uuid <engine-id> --isolate

# Bounded hierarchy navigation
node tools/cocos-graph/bin/cocos-graph.mjs navigate --project <project> --bundle <bundle> --handle <file#uuid> --relation ancestors|children|descendants [--depth 1] [--limit 50] --isolate

# Asset references from component properties
node tools/cocos-graph/bin/cocos-graph.mjs refs --project <project> --bundle <bundle> --asset-uuid <uuid> --isolate

# Integrity/schema validation
node tools/cocos-graph/bin/cocos-graph.mjs validate --project <project> --bundle <bundle> --isolate
```

Parser schema is v4. v3 or older manifests fail with an explicit rebuild action.

## Required mutation workflow

1. Search offline and keep `handle`, `uuid`, `file`, `source`, and `bundle`.
2. Reject/adapt when `stale.advisory=true`, `dirty` is `true` or `unknown`, `prefabOpaque=true`, or resolution is ambiguous.
3. Call `ccp3x_49650.sceneGetInfo()` and verify the intended scene is open.
4. Resolve/read the exact engine UUID live with `nodeGetTree` or `inspectorGet`.
5. Perform the write through the narrow CCP tool.
6. Read the changed target live and verify the observable result.
7. Only then record session continuity:

```bash
node tools/cocos-graph/bin/cocos-graph.mjs session-record \
  --project <project> --bundle <bundle> --scene-uuid <scene-uuid> \
  --working-path <path> --task <description> --verified
```

`session-record` rejects calls without `--verified`; it writes `.claude/ccp-session.json` atomically with `age_ms:0`.


### Tool Selection Matrix (Avoiding "Node tree not found")

| Target Source | Tool to Read Structure | Tool to Inspect Properties | Live nodeGetTree Allowed? |
|---|---|---|---|
| Open Scene (`sceneGetInfo` matches) | `nodeGetTree` | `inspectorGet` | **YES** |
| Unopened `.scene` file | `cocos-graph navigate` or open via `sceneOpen` | `sceneOpen` then `inspectorGet` | **NO** (Must call `sceneOpen` first) |
| `.prefab` file on disk | `readPrefabJson` or `cocos-graph navigate` | `inspectorGet` with asset UUID | **NO** (Prefab is not active scene; `nodeGetTree` will throw 404 `TARGET_NOT_FOUND`) |
| Composite handle (`file#uuid`) | Strip to bare `uuid` only after verifying `file` is open | `inspectorGet` with bare `uuid` | **NO** (Must strip `file#` prefix) |
## Live snapshot contract

```json
{
  "sourceFile": "assets/<bundle>/<scene>.scene",
  "dirty": true,
  "tree": { "reference": {}, "children": [] }
}
```

The source file must resolve uniquely inside the selected bundle. Live records replace only that scene; unrelated disk scene/prefab records remain. Missing or ambiguous provenance fails before publication.

## Output and failure semantics

- Query results are deterministically ordered and cursor-paginated.
- Every handle includes `handle`, engine `uuid`, `file`, `source`, and `bundle`.
- `resolve --uuid` never guesses: one candidate resolves, duplicates return `ambiguous` plus candidates.
- `dirty:"unknown"` is advisory, never equivalent to clean.
- `prefabOpaque:true` means disk parsing omitted expanded prefab internals.
- Exit 0 + `total:0` means a valid empty result.
- Exit 2 means missing/stale/invalid data or bad arguments.
- Exit 3 means ambiguous bare identity.

## Do not

- Never cache or write T2 values from the graph.
- Never treat bare node UUID as global identity.
- Never use serialized positional `__id__` as identity.
- Never mutate from offline evidence without the live-read and post-write witness.
- Never dump an entire scene when a bounded query or navigation command answers the question.
- Never add SQLite, embeddings, or offline prefab expansion without measured need and correctness fixtures.
