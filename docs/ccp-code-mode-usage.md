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
