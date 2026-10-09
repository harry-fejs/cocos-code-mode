---
name: ccp3x
description: >
  Use when a task mentions Code Mode, ccp3x, ccp2x, Cocos, scene, prefab,
  inspector, assets, components, preview, or build and needs Cocos Editor
  control through UTCP.
---

# CCP 3x

Use CCP through Code Mode MCP. This directory retains a historical filename only. Cache is discovery metadata; it proves neither MCP registration nor Creator IPC readiness.

## Khi nao kich hoat

Auto khi prompt chua mot trong: `code mode`, `ccp3x_<port>`, `ccp2x_<port>`, `cocos`,
`set vi tri`, `node`, `scene`, `prefab`, `inspector`, `asset`, `component`,
`preview`, `build` — hoac agent dinh goi `call_tool_chain`.

## Bootstrap and cache

- **Source:** selected `UTCP_CONFIG_FILE` or `~/.utcp_config.json`, with the project-scoped `.ccp/project-connections.json` registry. Each running editor uses an exact `ccp3x_<port>` namespace; Creator 2.4 uses `ccp2x_<port>`. Never select a bare/latest alias.
- **Cache:** the historically named `scripts/ccp-bootstrap.js` writes `.claude/ccp-cache.json`. It authenticates the selected project's `/connection` identity and caches credential-free discovery only; no MCP registration, editor handshake, mutation permission or readiness claim.

### Required session bootstrap

1. Select the intended canonical Cocos project first, then its exact active per-port binding in the selected config and project registry. No first/latest editor fallback.
2. Authenticate `GET /connection` with the private bound credential file; verify project, port, relay session and Gateway assignment. Do not copy credentials into prompts/cache/logs. `GET /utcp` and `GET /build-info` alone are tokenless loopback discovery exceptions.
3. Call `register_manual` with the complete selected template and preserve its credential loader context. Confirm its exact namespace with `list_tools`.
4. If the live manual advertises `editorHandshake`, call it with `expectedProjectPath`; require `projectMatches:true` and `probe.status:'responsive'` before mutations.
5. If no handshake is advertised, IPC readiness is unverified. Authenticated `/connection` is identity only, not an equivalent handshake; discovery grants no mutation permission. Protected explicit workflows require their own acceptance/request contract.
6. Discover dedicated tools and use `<selected-manual>.<tool>(args)` in `call_tool_chain`; no arbitrary JavaScript fallback.

Never infer registration/readiness from environment hints, `.claude/ccp-cache.json`, or an earlier MCP session. Retain references only for the verified current relay session.

### Retry

On `manual not found` or `tool not found`:

1. Re-read the selected UTCP config and same project's registry binding; revalidate authenticated `/connection` because port/session may have changed.
2. Re-register and confirm the namespace with `list_tools`; re-handshake when advertised and discard stale references.
3. Retry only read-only discovery once. Never automatically replay a failed mutation or switch to another editor.

If it still fails, report the error. Use bounded `editorGetLogs` only when the already-bound authenticated endpoint remains usable; do not retry in a loop.

## Scene preview (chup layout scene)

`previewManage` op `scene_preview` chup anh scene hien tai. 2 gotcha tranh loi:

1. `imageSize` phai la **object** `{width,height}` (vd `{width:1280,height:720}`) — number se ep vuong.
2. `cameraPosition`/`targetPosition` dat tai **tam Canvas** (khong phai `(0,0)`). Lay tam:
   `inspectorGet` node `Canvas` → `position`. Design 1280x720 fitHeight → Canvas tai `(640,360)`,
   `orthographicSize` = `designHeight/2` (=360). Design resolution: `projectManage get` → `general.designResolution`.

## Manual names

- Use only exact `ccp3x_<port>` (Creator 3.x) or `ccp2x_<port>` (Creator 2.4) namespaces, for example `ccp3x_49650.nodeGetTree(...)` after that project's binding verification. Bare/latest aliases are not active names.
- Derive the current port from the intended project's selected registry; never hard-code a stale port.

## Khong lam

- Khong tach moi Cocos tool thanh MCP tool rieng — giu JS batch (`call_tool_chain`) vi tiet kiem token.
- Khong sua `source/utcp/*` hay fork `@utcp/code-mode-mcp`.
