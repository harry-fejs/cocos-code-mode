# CCP with Code Mode MCP

CCP is the Cocos Creator 3.x extension. It serves a UTCP manual from the running editor; Code Mode MCP registers that manual and exposes its tools to an AI agent through TypeScript. Identity glossary: `docs/architecture-identity.md` — `cce` (Creator Editor), `ccpe` (Extension artifact), `ccpi:ccp3x_<port>` (Instance/Endpoint), `ccpr` (Registry), `ccpt` (Toolset 321), `cm` (paradigm), `cmm` (adapter `@utcp/code-mode-mcp`), `bd` (Binding), `prs` (Presence). Use explicit architecture roles.

## Connection model

```text
[cce] --hosts--> [ccpe] --runs exs:port--> [ccpi:ccp3x_<port> http://localhost:<port>/utcp]
  |                    | publish/remove         |
  +------------------->[ccpr ~/.utcp_config.json] <--register_manual-- [cmm @utcp/code-mode-mcp] <--mcp stdio--> [agent cm]
  |                    | handshake(bd.iid)      | call_tool_chain
  +--- Editor.Message.request <---> [ccpi] -----+----> [ccpt:321 tools]
```

`ccpe` maintains `ccpr` (`~/.utcp_config.json`) automatically. Each `ccpe` publishes one stable `ccpi:ccp3x_<actual-port>` entry; there is no `ccp3x` bare latest pointer (C1 in `architecture-identity.md`). Legacy `ccp3x` discovery entries migrate to the port in their URL, not to whichever editor answers first. Do not register two templates for the same endpoint. A template name must match its URL port; ambiguous endpoints sharing a namespace are not selected.

The internal API extension and the protected relay serialize shared config publication through the same `<config>.ccp-lock` directory. Internal API cleanup never prunes or overwrites authenticated relay templates or their credential loaders. Protected connections keep project/session/Gateway identity in the config-scoped `.ccp/project-connections.json`; internal API endpoints retain `CCP3X_PROJECT_<port>` and `CCP3X_OWNER_<port>` metadata. These are different artifact contracts, not interchangeable local/protected modes.

`scripts/ccp-bootstrap.js` honors `UTCP_CONFIG_FILE`, bounds discovery responses, and checks a fresh handshake against registered project and instance metadata when present. `CK_CODE_MODE=discovery-only` and the schema cache never authorize mutation or prove registration in the current MCP process.

## 1. Configure MCP (`mcp` → `cmm` → `ccpr`)

Add `cmm` (`@utcp/code-mode-mcp`) to the AI client. `ccp` is the **MCP server key** (client-facing name for the `cmm` adapter); `@utcp/code-mode-mcp` remains the adapter package. `UTCP_CONFIG_FILE` points to `ccpr`.

```json
{
  "mcpServers": {
    "ccp": {
      "command": "npx",
      "args": ["@utcp/code-mode-mcp"],
      "env": {
        "UTCP_CONFIG_FILE": "~/.utcp_config.json"
      }
    }
  }
}
```

Restart the AI client after changing its MCP configuration. Open the Cocos project and confirm **CCP 3x → Status** reports the `ccpi:ccp3x_<port>` URL (`ccpr` entry) before registering. See `docs/architecture-identity.md` for `cce`/`ccpe`/`ccpi`/`ccpr`/`cmm`/`bd` naming.

## 2. Register the Cocos manual (`cmm` → `ccpi` → `bd`, C2)

At the beginning of an agent session, select the intended `ccpi:ccp3x_<port>` from **Status** or `ccpr` (`~/.utcp_config.json`), `register_manual` that exact per-port template, then `editorHandshake` to establish `bd`. Do not use bare `ccp3x` latest — each `cce` is a distinct `ccpi:ccp3x_<port>`. Do not hard-code a stale port.

```typescript
await register_manual({
  manual_call_template: {
    name: 'ccp3x_49650', // ccpi id — replace with the selected ccpi:ccp3x_<port>
    call_template_type: 'http',
    url: 'http://localhost:49650/utcp', // ccpi.url
    http_method: 'GET',
    content_type: 'application/json',
  },
});

const tools = await list_tools(); // must contain ccp3x_49650
const bd = await ccp3x_49650.editorHandshake({
  expectedProjectPath: 'G:/projects/my-game',
  timeoutMs: 1000,
});
// require bd.projectMatches === true && bd.probe.status === 'responsive' before mutations (C2)
```

`list_tools()` must include the selected `ccpi` namespace before continuing. After restarting `cce`, `ccpe` reload, or reconnect, re-register that `ccpi` and re-handshake — `bd.iid` changes invalidate old `reference` handles even when `port` is unchanged. Never fallback to another `ccpi` when the bound one is unavailable (C2).

## 3. Discover before acting (`cm` over `ccpt`)

Use the `cmm` management tools in this order (`cm` paradigm over `ccpt`):

1. `search_tools` with the task in natural language.
2. `tool_info` for the selected `ccpt` tool's TypeScript interface and constraints.
3. `call_tool_chain` to compose calls through `ccp3x_<port>.<tool>(args)` (e.g. `ccp3x_49650.nodeGetTree`).

Example (replace `ccp3x_49650` with the bound `ccpi`):

```typescript
const tree = await ccp3x_49650.nodeGetTree({ maxDepth: 2, fields: ['name', 'active'] });
return {
  root: tree.name,
  childCount: tree.children?.length ?? 0,
};
```

Keep returned `reference` handles for the next mutation (valid only for current `bd.iid`). Prefer `sceneBatchGet`, `assetBatchQuery`, and `nodeBatchSet` for independent operations. Use `executeJavascript` only when no dedicated `ccpt` tool represents the required editor action.

### Versioned engine discovery and bounded authoring

`editorQuery({category:'component_schema',className:'cc.Widget',maxEntries:20,maxBytes:32768})` reads shipped metadata without creating a component. `inspectorGetDefinition({target:'class',className:'cc.Camera'})` provides the same version-bound class discovery. Default catalog version is3.7.3; `targetVersion:'3.8.8'` is comparison metadata only, never permission to invoke newer APIs on3.7.3.

Browse installed metadata with `editorQuery({category:'engine_api',operation:'list_domains'})` or `operation:'list_classes'`. Optional `domain` and `filter` narrow the inventory; pagination uses the same selectors and operation. Navigation never dispatches editor IPC. `coverage.scope` identifies the shipped pilot; `coverage.fullCatalogLoaded:false` explicitly means this is not the external full-engine catalog. Domain record counts aggregate all installed shards, not qualified callable methods. Do not interpret a missing class from the pilot as missing from the engine.

Full metadata can remain external. Build an immutable lookup with `node scripts/cocos-api/index-catalog.js --catalog-root <catalog-directory> --output <fresh-lookup-directory>`, then create operator-owned `<project>/.ccp/engine-api-catalogs.json` with schemaVersion1 and catalogs entries containing version, absolute catalogRoot/lookupRoot, lookupSha256 and catalogHash from generated manifest. The request cannot provide arbitrary filesystem roots. No config/version entry means labeled pilot fallback; configured missing/tampered data fails closed, never silent fallback.

External queries accept `namespace:'engine-runtime'|'engine-authoring'|'editor-ipc'|'bridge'`. Lookup rows filter without loading record shards; selected record pages read only indexed shards and verify SHA-256 against immutable configuration/index. Parsed shard cache is capped at8 shards/32MiB raw-byte budget; shard hash is rechecked even on cache hits. `coverage.fullCatalogLoaded:true` means full selected version inventory is accessible, not qualified/callable.3.8 comparison still cannot map onto a3.7 instance.

Use `editorQuery({category:'engine_api',operation:'records',recordId})` for one exact catalog identity obtained from discovery. Version/namespace/domain/class/filter still intersect with the ID; absence returns `TARGET_NOT_FOUND`, not a broader fallback. Record ID is cursor-bound and is not accepted for navigation summaries. Exact lookup remains declaration-only and grants no dispatch permission.

`operation:'list_namespaces'` summarizes namespaces present in the selected catalog/filter scope with `recordCount`. External catalogs use lookup metadata without hydrating record shards; pilot fallback scans its bounded installed shards. Navigation summaries retain normal page/byte/cursor bounds and never authorize runtime calls.

`operation:'list_members'` groups record metadata by namespace/class/member and reports `recordCount` (overloads/record views are not separate callable features). Optional `className` narrows the member scope. Select original record IDs through `records` to inspect signatures; summary IDs are navigation identities, not executable targets.

`operation:'get_signature'` requires an exact `recordId`, hydrates only that record from an external catalog, and returns its declared signatures with `permitted:false`. It is a read-only type/discovery result; unresolved/overloaded/native semantics remain explicit and no callable route is inferred.

`operation:'get_related_types'` requires one exact `recordId`. It returns reference/unresolved metadata as standard discovery `records`, each with `relation` and `metadata`, using the same `maxEntries`, `maxBytes` and selector-bound `nextCursor`. Empty metadata is an empty result, not missing-record evidence. It does not recursively resolve DTOs, execute code or infer native permissions; malformed metadata fails closed.

`operation:'lookup_editor_message'` requires an exact editor-ipc catalog `recordId`. It returns declared message metadata through the bounded discovery envelope, never sends the described IPC, and refuses live references or a conflicting namespace. Pilot-only catalogs may not contain editor records; missing metadata is not proof that a native IPC is unavailable.

`kind`, `module`, `visibility`, `context` and `evidenceState` are exact declared-metadata filters applied before external shard hydration and bound into cursors. Visibility preserves public/protected/private/internal labels; context matches an extracted execution tag and evidenceState matches source evidenceStatus, not live qualification. Domain navigation, message lookup and comparison reject these selectors. Missing lookup metadata returns `CATALOG_INDEX_UPGRADE_REQUIRED`: regenerate and explicitly update its configured hash, never scan-all fallback. Unknown/null values are not matches; private/internal discovery never authorizes invocation.

`member` is an exact case-sensitive member-name filter, intersected with class/namespace/domain and bound into cursors. Unlike `filter` substring search it does not match similarly named members. Existing indexes already include member metadata; the selector never grants unique-target or callable permission, and overloads remain distinct source records.

`operation:'explain_bridge_route'` requires one exact bridge catalog recordId without live/filter selectors. Newly extracted bridge records retain `composedRoutes`, source/evidence, operation conditions and unresolved branches. The result returns that bounded static evidence with permitted:false; it never invokes the described IPC/engine method and does not claim current-runtime coverage. Older records lacking composedRoutes require regeneration and explicit catalog/lookup hash adoption; no automatic artifact/config change occurs.

Discovery accepts `timeoutMs` (integer1–30000, default5000), shared across recursive exact lookup/comparison work. Cooperative checks during metadata/shard traversal and before successful return throw `CATALOG_QUERY_TIMEOUT`; they do not interrupt synchronous disk reads/JSON parsing or cancel in-flight Inspector IPC. A timed-out query returns no complete result, and does not imply native availability or mutation safety.

`maxPages` (integer1–1000, default256) bounds shard-read operations per discovery call, shared across nested exact lookups and both comparison versions. Each external readRecord attempt counts even on a cache hit or repeated shard; installed-pilot shard parsing counts once per read. Index/config/provenance reads and lookup-metadata scans are not pages. Exhaustion throws `CATALOG_PAGE_LIMIT` rather than claiming a complete partial result; narrow the query/page size or increase the explicit budget.

Offline selection preparation: `node scripts/cocos-api/eligibility-ledger.js --catalog-root <catalog> --output <new-ledger.json>` accounts for every hash-verified indexed record with version/semantic identity, source/shard provenance and conservative disposition. It exclusively creates output, leaves owner workflow/adapter/fixture/decision fields null, and keeps selectionComplete/qualificationComplete false. This is triage input, not a reviewed integration selection or permission/coverage score; use the full approved catalog for full inventory rather than the shipped pilot.

Ledger `routeEvidence` retains all matching static candidates for bridge tool records, including legitimate multi-operation routes. It does not populate `chosenRoute` or `ownerDecision`; those require workflow selection. A native route target belongs to its own namespace, not the bridge tool namespace. Non-bridge records with the same member name never inherit bridge route evidence.

Offline ledger declarationGroupId groups only exact version/namespace/source file hash/span/semantic hash plus member/kind/static/visibility/context identity. All raw rows and dispositions remain intact; missing provenance stays ungrouped. This detects shared declaration views, not inherited behavioral equivalence, manual duplicate workflow selection or distinct-feature counts. declarationGrouping statistics are provenance counts only, never coverage/qualification.

The runtime external catalog loader reads config/index/lookup/shards through bounded file descriptors: size is checked before allocation, growth/truncation and descriptor/path metadata changes refuse with CATALOG_CHANGED, and configured hashes are verified on captured bytes. This bounds each input buffer, not decoded heap, synchronous read latency or all concurrent process memory; it does not claim race-proof filesystem snapshots.

get_related_types preserves declarationEvidence signature/return/parameter references and unresolved metadata under separate declaration.* relation labels, alongside source signature relations. These are dependency metadata, not resolved callable schemas; declaration/source disagreement, unknowns and existing response/page/deadline bounds remain in force.
Dependency relation metadata includes zero-based signatureIndex and parameterIndex where applicable. Identical dependencies in distinct overloads/parameters remain distinct; deduplication is local to the same relation and location. Indices refer to the selected record's source or declaration signature array, not inferred cross-version overload matching.
Offline type metadata generation emits unresolved kind=cycle when expansion re-enters an active type path; shared acyclic references and alias identity are not cycles. The256-node expansion budget remains separate. Existing adopted catalogs retain their original bytes/hashes until explicitly regenerated and adopted; source-generator improvements do not rewrite installed evidence.
Offline array/tuple metadata expands element types, not built-in collection prototype methods. Primitive arrays therefore do not acquire push/concat/locale dependencies; named element types and unknown element diagnostics remain. This is collection dependency traversal, not runtime DTO validation or automatic permission.
Offline callable/constructable type dependencies retain their parameter/result references but emit semantic-adapter-required diagnostics. A resolved callback or constructor declaration is not a JSON DTO; no callback execution or native object construction is inferred.

Use `editorQuery({category:'engine_api',operation:'compare_version',targetVersion:'3.7.3',recordId,compareVersion:'3.8.8',compareRecordId})` to compare two exact records sharing a semanticKey. Results compare signature/metadata/resolution hashes and retain catalog identities; missing records do not imply removals. Comparison grants no execution permission.

`runtimeScenarioRun` accepts `totalTimeoutMs` (100–60000, default30000). All steps share that wall-clock deadline; expiry stops subsequent steps and retains failedStep/prior outcomes. An in-flight native request may still complete: timeout does not cancel, replay or restore an action. Inspect the bound session before another mutation.

Follow `nextCursor` only when more records are needed; preserve the same version/class/filter. Cursors are catalog-bound. `qualified:false`, `runtimeVerified:false`, and `live.mutationAuthorized:false` are intentional: declaration presence and live class availability do not prove mutation/history/persistence. Supplying a component `reference` refreshes Inspector path evidence on every request instead of retaining stale script mappings.

`listComponentMethods({reference:nodeReference})` returns attached component UUIDs, not class names as handles. `methods` is discovery; only `permittedMethods` is accepted by the existing finite `callComponentMethod` policy. Do not invoke lifecycle callbacks merely to prove discovery works.

Selected authoring contracts:
- `uiLayoutApply({operation:'reflow',reference,maxNodes:32,maxDepth:4,maxBytes:32768})` runs finite native Layout/Widget work in the edit scene. Full scope is checked before writes. Read `success`, `complete`, `changedNodeIds`, preservation and history; `sceneSaved:false` and `undoRedoVerified:false` remain separate from successful geometry readback. It is not a Game View responsive-render test.
- `prefabApplyOverrides({operation:'removed_component_apply',reference,fileID,expectedSourceSha256})` and `prefabRevertOverrides({operation:'removed_component_revert',reference,fileID})` use an authoritative removed-component prefab identity. Do not pass a deleted component UUID as fileID or reinterpret arbitrary `paths` as selective restore. Refresh instance/source inspection before mutation.
- Animation mask/variant settings use existing `assetImportSettingsGet/Set`. Mask `joints` changes selected existing `{path,enabled}` entries; variant `clipOverrides` changes selected existing `{original,replacement}` entries. Neither is arbitrary collection replacement.
- Explicit native cached lifecycle uses `assetOperate` operations `stage_import_setting` (path/value), `apply_import_settings`, `restore_import_settings`. Staging does not persist source; apply/restore requires the adapter's bounded retained state. A no-op settings readback is not persistence proof. Inspect source/import output evidence separately.
- `materialEdit` reports normalized requested-value equality and unaffected-pass checks. `persistence` retains unknown/unverified dimensions until reimport/reopen witnesses exist.
- `animationGraphInspect` exposes native serialized layers/state machines/states/variables/conditions. `animationGraphValidate.valid` stays false because playable semantic/runtime verification is absent. `animationGraphEdit` refuses synthetic `nodes/transitions` mutations instead of saving JSON that Creator may not interpret.

Never replay a mutation after timeout or an unknown outcome without independent inspection. Historical passing units, registered schemas and source catalogs are not installed workflow qualification.


### Surface Code Mode failures in Creator

`ccp/call_tool_chain` is an MCP adapter call. The MCP envelope may report `success:true` even when the code sandbox reports `[ERROR] Code execution failed` in `logs`; that means the requested Cocos operation failed.

When the bound `ccpi` remains reachable, issue one best-effort follow-up chain:

```typescript
return await ccp3x_49650.editorNotify({
  level: 'error',
  title: 'CCP command failed',
  message: 'Instantiate MineEffect prefab failed: <bounded reason>',
  openPanel: true,
});
```

This writes an error entry to Creator and explicitly opens **Agent Inbox**, where the notification is retained. Keep the message bounded and redact secrets, transport URLs and raw payloads. Do not repeat a timed-out or failed mutation automatically. If `editorNotify` also fails, report both failures in chat; if the original failure was already a Cocos tool/server error, prefer bounded `editorGetLogs` evidence and avoid notification loops.

## Copy-ready agent instruction
```text
CCP controls Cocos Creator 3.x through tools for scenes, nodes, components, inspector properties, assets, prefabs, animation, editor/project/build/preview, diagnostics, files, runtime input, and screenshots. Identity: cce=Creator Editor, ccpe=Extension, ccpi:ccp3x_<port>=Instance/Endpoint, ccpr=Registry ~/.utcp_config.json, ccpt=Toolset, cm=Code Mode paradigm, cmm=@utcp/code-mode-mcp adapter, bd=Binding {ccpi+project+iid}, prs=Presence. Use explicit CCP architecture roles. At session start select the intended ccpi:ccp3x_<port> from Status/ccpr, register_manual that exact ccpi, confirm the namespace with list_tools, then ccpi.editorHandshake({expectedProjectPath}) → bd; require bd.projectMatches:true && probe.status:responsive before mutations. Discover first (search_tools → tool_info → ccpi.<tool> via call_tool_chain). When available, use the bound ccpi:ccp3x_<port>.graphManage(query/resolve) for bounded graph lookup, then verify candidate provenance, intended scene, and exact target live through that same ccpi and project: check current bd.iid, call sceneGetInfo, and inspect with nodeGetTree or inspector. Graph T0 identity/T1 structure is advisory, never mutation permission. Resolve <file>#<uuid> to a bare engine UUID; never pass the composite handle as a live mutation target. Make only a narrow change with the appropriate live tool, then read it back through the same endpoint. Graph cache is project-scoped at <project>/.cocos-graph/ccp/. These workflow instructions do not claim a registered capability or verified live release qualification.
```

## Common workflows

### Inspect and modify a scene

1. `nodeGetTree` to locate a node and retain its `reference` (valid only for current `bd.iid`).
2. `nodeComponentsGet` or `inspectorGetDefinition` to discover the component/property shape.
3. `inspectorGet` for the specific field.
4. `inspectorSet` or `nodeBatchSet` for the mutation (C3: snapshot for undo).
5. Read the changed field again when the task needs confirmation.

Use `findNodes({rootReference:{id},name:'Play',nameMatch:'exact',componentType:'cc.Button',pathContains:'HUD',maxResults:50})` for AND-combined read-only searches. Names/path substrings are case-insensitive; component class matching is exact with optional cc. prefix. Subtree scope includes its root, while returned paths retain the open scene/prefab root. Omit other filters to list the selected subtree. Results report full match total and truncation; traversal over10000 nodes refuses rather than returning a misleading partial total. Search results are candidates, not bulk edit/delete authorization; re-read exact UUIDs before mutation.

`nodeComponentsGet({reference:{id},componentTypes:['cc.Label','cc.Button'],offset:0,limit:50})` selects class names with OR semantics and optional cc. prefix. Use componentType or componentTypes, never both. The full serialized inventory is validated before paging, including malformed/duplicate identities outside the returned page. total is the filtered count; nextOffset=null ends that observation. Omitted limit preserves the existing full-inventory response. Pages are fresh observations, not snapshot-pinned: scene edits can shift offsets; re-read exact component UUIDs before edits/removal. Multi-class queries with no matches return an empty list; the existing single-class missing-target error remains.
Pass the returned `revision` as `expectedRevision` on later component pages. The token binds the node UUID, entire ordered component UUID/type inventory and normalized class selector; changes refuse COMPONENT_INVENTORY_CHANGED before returning page data. Offset/limit are not part of the token. It is not a property-state hash, instance binding or atomic snapshot; continue to bind the Creator instance and re-read before mutation.
`nodeComponentsBatchGet({references,componentTypes:['cc.Button'],limitPerNode:50})` inspects1..32 exact nodes sequentially with per-item results/errors. Each successful item retains its own total/nextOffset/revision; continue only the needed inventory through nodeComponentsGet. Shared selectors are validated before any query; malformed/absent nodes do not hide successful siblings. This is not a cross-node snapshot or bulk mutation permission.
Batch inventorySummary aggregates complete prefilter inventories only for successful nodes, with observedNodes/failedNodes and total/enabled/disabled/unknownEnabled. Failed nodes are unknown coverage, not empty inventories; truncated component pages still contribute their validated complete per-node summary. Duplicate input UUIDs refuse before IPC to prevent double counting. Sequential totals are not an atomic cross-node snapshot.
Batch `inventorySummary.classDistribution` maps each exact observed class to `{instances,nodes}` across successful full inventories before filtering/paging. Multiple same-class components on one node increase instances but nodes only once. Failed/conflicting nodes are excluded, never inferred to lack the class; no-match detail filters still retain complete summaries. Counts are sequential observations, not singleton validity, scene-wide coverage or removal permission.
Batch inventorySummary additionally reports `matchedNodes`, `unmatchedNodes` and `matchedComponents` for successful filtered inventories, using complete filtered totals before page limits. matchedNodes+unmatchedNodes=observedNodes; failedNodes never implies a no-match. requireSingle cardinality failures remain excluded from successful coverage. Prefilter total/classDistribution remain independent from these filtered counts; summaryOnly preserves both views.
`nodeComponentsBatchGet({references,summaryOnly:true})` omits successful reference pages and paging fields, retaining inventorySummary, filtered total, revision and explicit detailsOmitted:true. All validation, revision/cardinality checks and per-node errors remain. Aggregate truncated=false describes the complete requested summary projection, not full node success (check failed/coverage); omission is intentional, not pagination. It reduces returned details only, not native dump reads or full-inventory validation/allocation. Fetch needed details via nodeComponentsGet with matching selectors/revision.
`nodeComponentsBatchGet({references,componentTypes:['cc.Button'],requireSingle:true})` applies single-match cardinality independently per node, before limitPerNode. Missing/ambiguous nodes produce COMPONENT_MATCH_NOT_FOUND/COMPONENT_MATCH_AMBIGUOUS item errors without discarding later successes. Aggregate coverage includes only successful inventories; cardinality failures are failedNodes, not empty node inventories. No bindings or mutations are performed.
Batch refresh accepts `expectedRevisions:[{reference:{id:nodeId},revision:previousRevision}]` (max32). Entries bind by node UUID, not array position; duplicate/foreign/malformed entries refuse before IPC. Omitted nodes are explicitly unguarded. Changed inventories or query selectors return per-item COMPONENT_INVENTORY_CHANGED while unchanged siblings continue; conflict nodes are excluded from aggregate coverage. Use revisions from the same class/exclusion/enabled selectors. This is sequential observation, not a transaction, instance binding or mutation lock.
`nodeComponentsGet({reference:{id},enabled:false})` filters serialized component enabled flags and returns optional `enabled` on each reference. `nodeComponentsBatchGet` accepts the same selector. Enabled state participates in revision identity; changed flags refuse continuation with COMPONENT_INVENTORY_CHANGED. Missing enabled metadata refuses with COMPONENT_STATE_UNAVAILABLE when filtering; this never claims runtime activation.
Both component inventory tools accept `excludeComponentTypes` (1..32 exact class names, optional cc. prefix normalization). Exclusions AND-combine with UUID/class/enabled selectors before pagination; summary still covers the complete inventory. Normalized sorted exclusions participate in revision identity. Conflicting class filters yield no matches (or existing single-class/cardinality errors); exclusion never removes components.
`nodeComponentsGet({reference:{id:nodeId},componentReference:{id:componentId}})` selects an exact attached component UUID, preserving its original index and full-node summary. A foreign/removed UUID refuses COMPONENT_NOT_ATTACHED; expectedRevision mismatch takes precedence. Class/enabled filters still combine with AND (state mismatch can return empty); existing single-class missing-match errors remain. The component UUID selector participates in revision identity. This is membership observation only, not an atomic edit/remove authorization.
Use `requireSingle:true` when a consumer needs exactly one component after UUID/class/enabled filtering. Cardinality is checked before limit/paging: zero refuses COMPONENT_MATCH_NOT_FOUND and multiple refuses COMPONENT_MATCH_AMBIGUOUS with matchCount. Nonzero offset is invalid in this mode. Revision and foreign-UUID errors retain precedence; the option is not part of revision identity because it does not change the filtered set. Default behavior remains unchanged; no arbitrary first-match selection or mutation occurs.
Every successful inventory includes `inventorySummary:{total,enabled,disabled,unknownEnabled}` over the complete validated node inventory before class/state filters and paging. Top-level total remains the filtered count. Unknown flags are not disabled; summaries describe serialized flags, not runtime activation. Batch items inherit this summary independently; no cross-node atomic aggregate is inferred.
`inventorySummary.classCounts` counts complete prefilter component instances by exact observed class string. Repeated instances remain separate UUIDs; class counts are not class validity, singleton enforcement or permission to remove duplicates. Unlike query matching, summary keys do not strip cc. prefixes, so distinct observed identities are never silently merged. Batch results retain each node's independent summary.
Component references include zero-based `componentIndex` from the complete observed __comps__ array. Filtering/paging/batch do not renumber positions. This is serialized inventory order, not lifecycle execution priority or mutation identity; use the component UUID and fresh read-back before edits. Reordering changes the existing revision guard.
`findNodes({componentTypes:['cc.Sprite','cc.UITransform'],componentMatch:'all'})` adds component-set predicates: `all` requires every class, `any` at least one, `none` none. Class matching is exact after optional `cc.` normalization. `none` includes nodes with zero components; malformed component identities refuse because absence cannot be proven safely. `componentType` and `componentTypes` are mutually exclusive.
`findNodes({componentType:'cc.Button',excludeComponentTypes:['cc.UITransform']})` finds nodes with the required class but none of the excluded classes. Exclusion supports1..32 exact class names, normalizes optional cc. prefixes and AND-combines with all existing filters (including componentMatch any/all/none). Exclusion alone is valid; contradictory presence/absence returns no matches. Unknown attached class identities refuse rather than proving absence. This identifies composition candidates only, not broken-node certainty or permission to repair them.
`findNodes({name:'Play',nameMatch:'exact',requireSingle:true,maxResults:1})` requires exactly one match across the complete bounded scope: zero refuses NODE_MATCH_NOT_FOUND; multiple refuses NODE_MATCH_AMBIGUOUS with matchCount, even beyond maxResults. Missing roots/exclusions and malformed metadata retain precedence. This is observation-time selection safety, not a locked mutation target or future uniqueness guarantee; default search behavior is unchanged.

`findNodes` also accepts `minDepth`/`maxDepth` (0–99), relative to `rootReference` when supplied, otherwise the open hierarchy root. Returned rows include `depth`; use `maxDepth:0` for the selected root or `minDepth:1,maxDepth:1` for direct children. Depth predicates combine with component/name/path selectors and do not reduce traversal safety caps.
Use `excludeReferences:[{id:uiUuid},{id:debugUuid}]` to prune exact subtrees from a search. Exclusion applies to each UUID and all descendants; absent excluded UUIDs fail with `TARGET_NOT_FOUND` instead of silently returning a broader result. Exclusions are read-only query scope, not delete instructions; re-read candidates and authorization remain required before node operations.
`findNodes({active:false})` searches local disabled flags; `active:true` searches local enabled flags. Both combine with the existing subtree/name/component/depth selectors. Boolean and wrapped value dumps are accepted; unknown local metadata on an otherwise eligible node refuses NODE_STATE_UNAVAILABLE. This does not prove visibility, effective ancestor activation or runtime enabled state.
`findNodes({active:true,hierarchyActive:false})` finds locally enabled nodes blocked by an observed disabled ancestor. Each hit returns nullable hierarchyActive: tri-state AND of local flags from the open traversal root (false dominates unknown; true requires every flag true). rootReference resets depth, not ancestor activity. Missing evidence returns null; an explicit hierarchyActive filter refuses NODE_STATE_UNAVAILABLE for otherwise eligible unknowns. Prefab traversal wrappers outside the selected open root are excluded. This is serialized hierarchy reasoning, not live engine activeInHierarchy, rendering or input visibility.
`nodeGetPath` returns `pathUnique` and `matchingNodeCount` for slash-joined paths in the selected hierarchy scope. Duplicate sibling names (or names containing path separators) can collide; use UUID references rather than assuming path lookup selects one target. The complete input hierarchy is validated for duplicate UUIDs/cycles and bounded to10000 scheduled nodes before reporting uniqueness. Relative scope and includeRoot formatting apply to collision counts; results are observations, not future path stability guarantees.
`nodeGetPath({reference:{id},requireUnique:true})` refuses NODE_PATH_AMBIGUOUS when multiple nodes share the formatted path; error details retain path/count/target UUID. Omitted/false keeps collision reporting. This is an observation-time uniqueness guard, not a guarantee against later tree edits or a replacement for UUID-bound mutation.
`nodeGetPath` also returns `ancestors` as exact node references ordered from the selected scope root to the target's parent, excluding the target. relativeTo limits the chain; includeRoot changes path text only, not ancestor membership. A target equal to the scope root returns an empty chain. References describe observed topology and still require current instance binding/fresh checks before mutation.
`nodeGetPaths({references,relativeTo,includeRoot:false,requireUnique:true})` resolves1..32 exact UUIDs from one captured query-node-tree response and shared validated path/parent indexes. Input selectors validate before IPC; missing targets, ambiguity and expected-path drift retain per-target errors. Missing/invalid common hierarchy or relative root fails the batch. This avoids mixing separate hierarchy reads but is not an atomic editor transaction, instance binding or mutation lock; prefab-root identification may perform additional metadata IPC. No node mutation or automatic code binding occurs.
Batch path lookup accepts `expectedPaths:[{reference:{id:targetId},path:previousPath}]` (max32), bound by target UUID rather than input position. Duplicate/foreign/malformed guards refuse before IPC; unlisted targets are unguarded. Path drift remains a per-target NODE_PATH_CHANGED error, preserving other successes. Use identical relativeTo/includeRoot formatting. This detects text drift only, not same-name ancestry changes, and is not a cross-node transaction or mutation lock.
Batch path lookup also accepts `expectedAncestors:[{reference:{id:targetId},ancestors:previous.ancestors}]` (max32 target entries, each chain max9999). Ordered UUID comparisons run against the shared captured hierarchy; same-name reparent refuses per-item NODE_ANCESTRY_CHANGED even when expectedPaths still matches. Duplicate/foreign/invalid chains refuse before IPC; omitted targets are unguarded and empty chains require the target to be the selected scope root. Use the same relativeTo scope; guards are observations, not mutation locks or instance-restart protection.
`nodeGetPath({reference:{id},expectedPath:previous.path})` compares the freshly computed formatted path for that exact UUID and refuses NODE_PATH_CHANGED on mismatch. Reuse the same relativeTo/includeRoot options; empty string is valid for a relative scope root. This detects changed path text only, not same-name ancestor replacement, sibling reordering or edits after the read. Pair with requireUnique when needed; no automatic mutation/rollback or stale-path retargeting occurs.
Pass `expectedAncestors:previous.ancestors` to guard the ordered ancestor UUID chain. A same-name reparent can keep expectedPath unchanged but now refuses NODE_ANCESTRY_CHANGED. Compare under the same relativeTo scope; includeRoot only formats path text. Empty expectedAncestors requires the target to be the scope root. This read-only check does not guard sibling order, property values, instance restart or edits after observation and is not an atomic mutation precondition.
`findNodes({minComponents:0,maxComponents:0})` finds empty nodes; `minComponents:2` finds component-heavy nodes. Count filters combine with exact component sets/name/depth/activity and count serialized component entries, not runtime enabled components. Bounds are0..10000; reversed or non-integer ranges refuse before querying the scene.
Search hits also return `parentReference` from the observed open hierarchy (null only at its traversal root), serialized `componentCount`, and nullable local `active`. Selecting a subtree resets depth but retains its observed parent UUID. Unknown active metadata is null unless an explicit active predicate requires it. These fields are navigation evidence, not mutation preconditions or runtime visibility proof.
Each hit additionally includes immediate `childCount` and observed `siblingIndex` (null at the open traversal root). A subtree query resets depth but preserves the subtree root's real sibling index under its observed parent. Search indices are navigation evidence; index0 filtering retains its existing root convention, while the returned null explicitly denotes no observed parent order.
Use `findNodes({parentReference:{id:containerUuid},maxChildren:0})` for direct leaf children, or minChildren for containers. Child counts include immediate children only, not descendants; bounds0..10000 are inclusive and combine with other selectors. A missing parent UUID refuses TARGET_NOT_FOUND, while an existing parent with no matching children returns an empty result. Read-only relationship queries never reparent or delete nodes.
Sibling filters use observed child-array order: `siblingIndex:0` finds first children, while min/max range selects an order interval. Root traversal node uses index0; child indices are zero-based under their real parent. Exact index cannot combine with a range. Order is read-only evidence; move/copy must re-read the current sibling list before mutation.
`sceneHierarchyAnalyze({rootReference:{id},limit:1000})` summarizes the observed subtree: visited node count, root-relative max depth, local active/inactive/unknown flags, component-class occurrence counts and repeated names. Counts are partial when truncated; repeated names across different branches are informational, not path errors. Unknown component identity does not prove a missing script; use sceneScriptHealthScan for registration health. Node scheduling/subtree lookup and component traversal each cap at10000; raw Creator query allocation is not capped. Analysis never edits nodes or invokes gameplay.

### Assets and prefabs

- Discover with `assetQuery`, `assetGetTree`, or `assetGetAtPath`.
- Resolve paths before creating/importing assets.
- Use `readPrefabJson` and `editPrefabJson` only for file-level prefab work; use node/inspector tools for live-scene edits.

### Diagnose runtime or scripts

- Start with `runScriptDiagnostics` and `getScriptDiagnosticContext`.
- Use runtime, screenshot, preview, or input-simulation tools for the requested surface.
- Confirm editor build provenance through `/build-info` when a result looks stale.
- `animationPlaybackWaitForState` polls one exact attached Game View clip using `sessionId`, `nodeReference`, `componentId`, `clipName` and `clipUuid`. Supply at least one `playing`, `paused` or `minTime` condition. It observes regular Animation/SkeletalAnimation only; it never starts playback or registers event listeners. Target drift, unavailable requested time metrics and caller deadline expiry throw explicitly. A timed-out read may still settle; no playback mutation is dispatched and no runtime qualification is implied.
- `audioPlaybackWaitForState` waits for `playing`, `loaded`, exact `playbackState` (`init`, `playing`, `paused`, `stopped`, `interrupted`) and/or `minTime` through observation only. Conditions combine with AND. It pins observed target identity, refuses changed/malformed observations and throws `AUDIO_STATE_TIMEOUT` at the caller deadline. Neither `playing:false` nor `playbackState:'stopped'` proves a natural-ended event; one-shot completion is not inferred.
- `runtimeScenarioRun` composes 1–16 Game View `pause`/`resume`/`step` controls, read-only `observe` checkpoints and paused/frame-count `wait`/`assert` steps. All steps are preflighted; controls/observe refuse condition fields. Each step timeout also bounds observation/assertion completion, within the shared total deadline. First failure stops and retains failedStep/completed outcomes; failed assertions throw RUNTIME_SCENARIO_ASSERTION_FAILED. In-flight requests may settle after timeout; no action replay/restore, image/event assertion or gameplay callback execution.
- Scenarios sharing a session refuse overlap with `RUNTIME_SCENARIO_BUSY`, including after a caller timeout while its dispatched step is still pending. Ownership releases when that request settles, not when its caller stops waiting. This is scenario exclusion only: direct primitive calls and distinct session handles are not a global Game View transaction lock. A never-settling request retains ownership; no forced replay/reset is inferred.
- `audioObserve`/`audioAssert` require exact `nodeReference:{id}` and reuse `audioPlaybackObserve` against the scenario session. Non-audio steps reject nodeReference; all audio steps reject frame/paused predicates. Targets are copied during whole-input preflight. Observation alone does not imply natural completion.
- `audioAssert` requires at least one boolean playing/loaded predicate (AND semantics). It reads once, records observation/passed, and stops on mismatch with RUNTIME_SCENARIO_ASSERTION_FAILED. Only audioAssert/audioWait accept these predicates. Neither playing=false nor loaded=true proves natural completion or audible output.
- `audioControl` requires nodeReference plus audioOperation=play/pause/stop/seek; only seek accepts finite nonnegative time, and explicit control timeoutMs is at most5000. `audioWait` requires nodeReference and at least one playing/loaded condition; it reuses read-only audio polling under the remaining step deadline. All audio steps reject frame predicates. Native target/activation checks remain in the existing adapters. Timeouts never replay controls; polling completion does not prove natural-ended playback.
- `runtimeScenarioRun` accepts an optional fresh runId (1–64 ASCII alphanumeric/hyphen/underscore; generate a new UUID per invocation). Omitted IDs are generated and returned on success or step failure. To cancel while awaiting the run, supply your own ID initially. `runtimeScenarioCancel({sessionId,runId})` refuses mismatching active runs with RUNTIME_SCENARIO_IDENTITY_MISMATCH; inactive cancellation is a no-op. It prevents later steps and audio dispatch awaiting module load, not native work already sent. Pending ownership remains until settlement. Reusing run IDs defeats stale-request isolation and is prohibited by the caller contract.

### Inspect a blocking native Creator popup

1. Bind the exact Creator project and instance with `editorHandshake({expectedProjectPath})`. Before and after every scene operation that can open a dialog, call `editorPopupInspect({includeNative:true,maxItems:32})`; `editorState` may be used for its bounded popup summary. There is no background watcher, so the agent must perform these bounded checks at operation boundaries.
2. Treat `complete:true` as required coverage evidence. If `complete:false` or `unavailable[]` is non-empty, detection is inconclusive; do not treat `detected:false` as proof that no popup exists.
3. If `detected:true` and `blocking:true`, stop scene mutations. Read each **visible, owner-verified** native dialog's `title`, bounded `content.text`, `content.truncated`, and enabled `actions[]`. On Windows, `#32770` message text comes from UI Automation `ControlType.Text`; `content.text:null` means unavailable, not a blank message. Never infer Save/Don't save/Confirm from a title or button order.
4. With stacked dialogs, do not assume `windows[0]` is the foreground decision. Use the owner-group evidence: `zOrder.activePopup:true`, `zOrder.rank:0`, and non-unknown confidence identify the currently actionable top dialog. `focused`/desktop foreground may remain `null`/false; this proves stack order, not keyboard focus.
5. When the caller explicitly chooses one current button, call `editorPopupAction({operation:'activate',popupId,popupTitle,actionId,actionLabel,confirm:true,authorization:'user-explicit'})` with the exact inspected identities. The tool independently re-reads owner, HWND, title, enabled button, body and top order before bounded native dispatch; changed/truncated content, missing ownership or stale identity fails closed. No Agent Inbox approval wait or coordinate click.
6. Re-inspect and confirm the **same** popup ID is gone. Another popup may remain or appear; handle it as a new decision. `activated:true,closed:true` proves closure of the selected dialog, not successful completion of a blocked `sceneManage(open)` call.

Verified on Creator 3.7.3 with a disposable unsaved node: switching scenes raised `Warning` with `Scene data has been modified.\nDo you want to save data to the file.?`. Exact **Cancel** closed the warning; the original scene stayed active and dirty. The disposable node was removed without saving, but the scene remained `dirty:true`. Selecting **Don't save** instead discards the current scene's unsaved changes and must be an explicit owner decision. Current witness used a dirty artifact; clean-artifact release qualification remains open.

## Skills integration

A project skill that operates Cocos should treat registration as a session bootstrap, not an assumption:

1. Select the intended `ccpi:ccp3x_<port>` from `ccpr`/Status, `register_manual` that `ccpi`, confirm via `list_tools`, then `ccpi.editorHandshake` → `bd` (C2).
2. Discover the dedicated `ccpt` tool with `search_tools` before generating a `call_tool_chain` (`cm`).
3. Preserve `reference` only while `bd.iid` unchanged and a later step needs to mutate the matching object.
4. Re-register + re-handshake after `cce` restart, `ccpe` reload, port change, or `tool-not-found` (never fallback to another `ccpi`).

Keep the skill focused on workflow rules. The live `ccpt` manual remains the source of truth for tool names, TypeScript interfaces, and capabilities. Glossary: `docs/architecture-identity.md`.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `ccpi:ccp3x_<port>` tools missing | Select the intended `ccpi` in `ccpr`/Status, `register_manual` that `ccpi`, verify with `list_tools`, then `ccpi.editorHandshake` → `bd` (C2). |
| Connection fails | Confirm `cce` is open and `ccpi.url` / `ccpr` port matches Status; `bd.probe.status` distinguishes responsive vs timeout vs error. |
| Duplicate tools | Remove duplicate templates pointing to the same URL; retain exactly one `ccpi:ccp3x_<port>` per endpoint with `name` matching URL port (C1). No bare `ccp3x` latest. |
| Source build does not change editor behavior | A junction removes copy/import work only. Restart `cce` to clear cached `ccpe` modules. |
| Manual points to an old editor | Re-select the intended `ccpi:ccp3x_<port>` explicitly, then re-register + re-handshake; discard old `reference` when `bd.iid` changes (C2). |
