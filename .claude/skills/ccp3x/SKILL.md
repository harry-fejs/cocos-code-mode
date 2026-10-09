---
name: ccp3x
description: >
  Use when a task mentions Code Mode, ccp3x, ccp2x, Cocos, scene, prefab,
  inspector, assets, components, preview, or build and needs Cocos Editor
  control through UTCP.
---

# ccp3x

Use CCP through Code Mode MCP. Cache is tool metadata only; it never proves that the current MCP process registered a manual. Identity glossary: `docs/architecture-identity.md` (`cce`/`ccpe`/`ccpi`/`ccpr`/`ccpt`/`cm`/`cmm`/`bd`/`prs`). Use the explicit CCP architecture roles.

## Khi nao kich hoat

Auto khi prompt chua mot trong: `code mode`, `ccp3x`/`ccp3x_<port>`, `ccp2x`/`ccp2x_<port>`, `cocos`,
`set vi tri`, `node`, `scene`, `prefab`, `inspector`, `asset`, `component`,
`preview`, `build` — hoac agent dinh goi `call_tool_chain`.

## Bootstrap and cache

- **Source (`ccpr`):** `~/.utcp_config.json`. Mỗi `ccpe` đang chạy publish 1 `ccpi:ccp3x_<port>` (bare `ccp3x`/`ccp2x` latest đã bỏ — mỗi Editor là 1 port riêng). Creator 2.4 dùng song song `ccp2x_<port>`. Chi tiết: `docs/architecture-identity.md` C1.
- **Cache:** `scripts/ccp-bootstrap.js` fetches mỗi `ccpi` live `/utcp` manual vào `.claude/ccp-cache.json`. Chỉ là schema/discovery metadata; không thay thế `register_manual` của `cmm` trong MCP process hiện tại.

### Required session bootstrap (`cmm` → `ccpi` → `bd`, C2)

1. Đọc `ccpr` (`~/.utcp_config.json`) hoặc **CCP 3x → Status**; chọn đúng `ccpi:ccp3x_<port>` cho `cce` + project cần thao tác. Không dùng bare `ccp3x` latest.
2. `register_manual` với template **per-port** đầy đủ (`name:'ccp3x_<port>'`, `url:'http://localhost:<port>/utcp'`).
3. `list_tools` — confirm chứa namespace `ccp3x_<port>` đã chọn.
4. `ccp3x_<port>.editorHandshake({expectedProjectPath, timeoutMs:1000})` → lưu `bd = {namespace, url, projectPath, iid}`; yêu cầu `projectMatches:true && probe.status:responsive` trước mọi mutation. `iid` đổi → vứt mọi `reference` cũ.
5. Chỉ sau đó mới `call_tool_chain` qua `ccp3x_<port>.<tool>(args)` (`ccpt`).

Never infer registration from `CK_CODE_MODE`, `.claude/ccp-cache.json`, or a tool list from an earlier MCP session. Sau reconnect/restart/`ccpe` reload phải re-handshake; không fallback sang `ccpi` khác.

## Graph-assisted scene workflow

When graph lookup is available on the bound endpoint, use `ccpi:ccp3x_<port>.graphManage(query/resolve)` only to find candidates and resolve `<file>#<uuid>` to a bare engine UUID. T0 identity/T1 structure and provenance are advisory navigation evidence, never permission to mutate. The graph cache is project-scoped at `<project>/.cocos-graph/ccp/`.

Before any write, confirm the same bound `ccpi` and project and that `bd.iid` is still current; verify the intended scene with `sceneGetInfo`, then verify the exact candidate live with `nodeGetTree` or inspector. Pass only the bare engine UUID (never the composite `<file>#<uuid>`) to a narrow live mutation tool, make the requested bounded change, and read it back through that endpoint. These instructions describe the workflow when exposed; they do not claim registered graph tools or live release qualification.

### Retry and Creator-visible failures

On `manual not found` or `tool not found`:

1. Re-read `ccpr` (`~/.utcp_config.json`), vì `cce`/`ccpe` có thể restart sang port khác (C1: auto reuse / fallback).
2. Re-register `ccpi:ccp3x_<port>` hiện tại và confirm bằng `list_tools`.
3. Retry `call_tool_chain` 1 lần.

If a `ccp/call_tool_chain` result has `success:true` but its `logs` contain `[ERROR] Code execution failed` (or the chain otherwise fails client-side), treat the command as failed. When the bound `ccpi` is still reachable, make one best-effort follow-up chain that calls `editorNotify({ level:'error', title:'CCP command failed', message:<bounded summary>, openPanel:true })`; this writes the Creator log and opens Agent Inbox so the user sees the failure. Do not include secrets, transport URLs, or full raw payloads. If notification fails, report both failures to the user; never retry the original mutation blindly.

For a server/tool error already visible in Creator logs, call `editorGetLogs` for bounded evidence and avoid duplicate notification loops.

## Scene preview (chup layout scene)

`previewManage` op `scene_preview` chup anh scene hien tai. 2 gotcha tranh loi:

1. `imageSize` phai la **object** `{width,height}` (vd `{width:1280,height:720}`) — number se ep vuong.
2. `cameraPosition`/`targetPosition` dat tai **tam Canvas** (khong phai `(0,0)`). Lay tam:
   `inspectorGet` node `Canvas` → `position`. Design 1280x720 fitHeight → Canvas tai `(640,360)`,
   `orthographicSize` = `designHeight/2` (=360). Design resolution: `projectManage get` → `general.designResolution`.

## Manual names

- `ccp3x_<port>` (`ccpi` id) cho Creator 3.x; `ccp2x_<port>` cho Creator 2.4. Gọi `ccp3x_49650.nodeGetTree(...)` (per-`ccpi`), không còn `ccp3x` bare latest. Namespace phải khớp `url` port (C1/C2). Chi tiết: `docs/architecture-identity.md`.

Tu dong theo `ccpr`; khong hardcode port.

## Khong lam

- Khong tach moi `ccpt` tool thanh MCP tool rieng — giu JS batch (`call_tool_chain`, `cm`) vi tiet kiem token.
- Khong sua `source/utcp/*` hay fork `@utcp/code-mode-mcp` (`cmm`).
