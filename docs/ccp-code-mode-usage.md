# CCP with Code Mode MCP

CCP is the Cocos Creator 3.x extension. It serves a UTCP manual from the running editor; Code Mode MCP registers that manual and exposes its tools to an AI agent through TypeScript. Active manual names use `ccp3x_<port>`.

## Connection model

```text
Cocos Creator → http://localhost:<port>/utcp → project-bound UTCP call template
              → Code Mode MCP → register_manual → ccp3x_<port>.* tools
```

The extension maintains the selected UTCP config (`UTCP_CONFIG_FILE` for helper scripts; otherwise `~/.utcp_config.json`) and its project-scoped `.ccp/project-connections.json` registry. Select the intended canonical Cocos project first, then its exact active `ccp3x_<port>` binding. Bare/latest aliases are not active registrations. Never infer the project from the first entry, newest port, or a discovery cache.

## 1. Configure the MCP bridge

Add Code Mode MCP to the AI client. `ccp` is the client-facing server key; `@utcp/code-mode-mcp` remains the adapter package.

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

Restart the AI client after changing its MCP configuration. Open the intended Cocos project and confirm the extension's running UTCP endpoint matches that project's registry entry before registering tools.

## 2. Register and verify the project binding

At the beginning of an agent session, select the exact project/port/session/Gateway assignment. `scripts/project-connection.js` accepts `CCP_PROJECT_PATH` (or an explicit registered loopback endpoint), validates the project-scoped registry, and uses the bound private credential file to authenticate `GET /connection`. Keep the full configured template and credential loader context when registering; do not copy credentials into prompts, logs, or the discovery cache.

```typescript
// Read the complete selected template from the configured UTCP registry.
// Example namespace only: replace 49650 with the verified project's port.
await register_manual({ manual_call_template: selectedTemplate });
const tools = await list_tools(); // require tools under ccp3x_49650

// Only when editorHandshake is advertised by this live manual:
const binding = await ccp3x_49650.editorHandshake({
  expectedProjectPath: 'G:/projects/my-game',
  timeoutMs: 1000,
});
// Require binding.projectMatches === true and binding.probe.status === 'responsive'.
```

Authenticated `/connection` establishes endpoint identity, not responsive Creator IPC. The protected host may not advertise `editorHandshake`; in that case IPC readiness remains unverified. Do not substitute discovery or `/connection` for a handshake or infer mutation permission. Protected explicit workflows still require their own acceptance/request contract. Before mutations on a handshake-capable endpoint, require a successful project-matching responsive handshake.

Tokenless `GET /utcp` and `GET /build-info` are explicit local loopback discovery exceptions only; all other routes, including `/connection`, remain credential-bound. Discovery, cached tool counts and MCP registration never prove readiness. After restart, reload, port/session change or reconnect, reselect the same project, re-register and re-handshake when supported; discard old references and never fall back to a different editor.

## 3. Discover before acting

Use the Code Mode MCP management tools in this order:

1. `search_tools` with the task in natural language.
2. `tool_info` for the selected tool's TypeScript interface and constraints.
3. `call_tool_chain` to compose calls through `ccp3x_<port>.<tool>(args)`.

Example:

```typescript
const tree = await ccp3x_49650.nodeGetTree({ maxDepth: 2, fields: ['name', 'active'] });
return {
  root: tree.name,
  childCount: tree.children?.length ?? 0,
};
```

Keep returned references only for the verified current session. Prefer `sceneBatchGet`, `assetBatchQuery`, and `nodeBatchSet` for independent operations. Discover dedicated tools; arbitrary JavaScript execution is not a fallback.

## Copy-ready agent instruction

```text
CCP controls Cocos Creator through project-bound ccp3x_<port> tools. At session start select the intended canonical project from the configured registry, authenticate /connection with its bound credentials, register its complete template and confirm its namespace with list_tools. If editorHandshake is advertised, require a project-matching responsive handshake before mutations; otherwise IPC readiness is unverified and discovery grants no mutation permission. Protected workflows require their own acceptance/request contract. Discover dedicated tools, inspect state before mutations, retain only current-session references and batch independent operations. Never select a bare/latest alias, fall back to another editor or use arbitrary JavaScript execution.
```

## Common workflows

### Inspect and modify a scene

1. `nodeGetTree` to locate a node and retain its reference.
2. `nodeComponentsGet` or `inspectorGetDefinition` to discover the component/property shape.
3. `inspectorGet` for the specific field.
4. `inspectorSet` or `nodeBatchSet` for the mutation.
5. Read the changed field again when the task needs confirmation.

### Assets and prefabs

- Discover with `assetQuery`, `assetGetTree`, or `assetGetAtPath`.
- Resolve paths before creating/importing assets.
- Use `readPrefabJson` and `editPrefabJson` only for file-level prefab work; use node/inspector tools for live-scene edits.

### Diagnose runtime or scripts

- Start with `runScriptDiagnostics` and `getScriptDiagnosticContext`.
- Use runtime, screenshot, preview, or input-simulation tools for the requested surface.
- Confirm editor build provenance through `/build-info` when a result looks stale.

## Skills integration

A project skill that operates Cocos should treat registration as a session bootstrap, not an assumption:

1. Select the intended project and exact `ccp3x_<port>` binding; authenticate `/connection`, register the full template and confirm it through `list_tools`.
2. Handshake before mutations when advertised; no handshake means IPC readiness remains unverified, not implicitly ready.
3. Discover the dedicated tool with `search_tools` and retain references only for the verified current session.
4. Re-register and re-handshake after restart, reload, port/session change or tool-not-found; do not replay failed mutations automatically.

Keep the skill focused on workflow rules. The live manual remains the source of truth for tool names, TypeScript interfaces, and capabilities.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `ccp3x_<port>` tools missing | Register the verified project's complete manual and confirm it with `list_tools`. |
| Connection fails | Confirm the intended Cocos project, active registry assignment and private project/port/session credential file. |
| Duplicate tools | Remove duplicate registrations only after ownership verification; retain the exact project-bound per-port template. |
| Source build does not change editor behavior | Installed/editor modules may be cached; follow the approved reload/restart workflow rather than assuming a junction refreshed runtime code. |
| Manual points to an old editor | Reselect the same project, revalidate `/connection`, re-register and re-handshake when supported; never fall back to another editor. |
