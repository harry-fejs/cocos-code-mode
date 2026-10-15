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

`kind`, `module`, `visibility`, `context` and `evidenceState` are exact declared-metadata filters applied before external shard hydration and bound into cursors. Visibility is public/protected/private; context matches an extracted execution tag and evidenceState matches the source catalog's evidenceStatus, not live qualification. Navigation domains, message lookup and comparison reject these selectors. Old lookup metadata returns `CATALOG_INDEX_UPGRADE_REQUIRED`: regenerate and explicitly update its configured hash, never scan-all fallback. Unknown/null values are not inferred as matches; private metadata never authorizes invocation.

`member` is an exact case-sensitive member-name filter, intersected with class/namespace/domain and bound into cursors. Unlike `filter` substring search it does not match similarly named members. Existing indexes already include member metadata; the selector never grants unique-target or callable permission, and overloads remain distinct source records.

`operation:'explain_bridge_route'` requires one exact bridge catalog recordId without live/filter selectors. Newly extracted bridge records retain `composedRoutes`, source/evidence, operation conditions and unresolved branches. The result returns that bounded static evidence with permitted:false; it never invokes the described IPC/engine method and does not claim current-runtime coverage. Older records lacking composedRoutes require regeneration and explicit catalog/lookup hash adoption; no automatic artifact/config change occurs.

Discovery accepts `timeoutMs` (integer1–30000, default5000), shared across recursive exact lookup/comparison work. Cooperative checks during metadata/shard traversal and before successful return throw `CATALOG_QUERY_TIMEOUT`; they do not interrupt synchronous disk reads/JSON parsing or cancel in-flight Inspector IPC. A timed-out query returns no complete result, and does not imply native availability or mutation safety.

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
- `runtimeScenarioRun` composes 1–16 Game View `pause`/`resume`/`step` controls and paused/frame-count `wait`/`assert` steps. All steps are preflighted; controls refuse condition fields. First failure stops subsequent execution and retains `failedStep`/completed `outcomes`; failed assertions throw `RUNTIME_SCENARIO_ASSERTION_FAILED`. Control failures are not automatically replayed or restored. This route does not implement image/event assertions or gameplay callback execution.

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
