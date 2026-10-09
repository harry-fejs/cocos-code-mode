# Architecture Identity — CCP 3x

> Source of truth cho danh pháp kiến trúc. Mọi plan/spec/skill/doc mới phải dùng đúng ID trong bảng này. Use explicit architecture roles.

## 1) Hệ ID (12 thực thể)

| # | ID | Tên đầy đủ | Thực thể code / runtime | Định danh ví dụ | Ghi chú |
|---|----|------------|--------------------------|-----------------|---------|
| 1 | `cce` | Cocos Creator Editor | Host process `Creator.exe` 3.7/3.8 | `cce:3.7.3 pid=4820 project=G:/proj/my-game` | 1 process = 1 project mở |
| 2 | `ccpe` | CCP Extension | Artifact `ccp3x@2.1.0` = `dist/main.js` + `source/main.ts` + `UtcpServerManager` | `ccpe#bacd213 build:ccp3x.d.ts` | Đóng gói qua `npm run package` → `ccp3x.zip` |
| 3 | `ccpi` | CCP Instance / Endpoint | 1 `cce` + 1 `ccpe` đang chạy = `http://localhost:<port>/utcp` + `instanceId` | `ccpi:ccp3x_49650 iid=abc123 url=http://localhost:49650/utcp` | Thay `iid` mỗi `startPublishedServer()`; `port` có thể reuse |
| 4 | `ccpr` | CCP Registry | `~/.utcp_config.json` + lock `<config>.ccp-lock` + `CCP3X_OWNER_<port>` | `ccpr entry ccp3x_49650 owner=abc123` | Atomic read-modify-write + fsync + rename |
| 5 | `ccpt` | CCP Toolset | 321 tools trong `ccp3x.d.ts` + `docs/tool-catalog.md` | `ccpt:321 (273 stable / 2 exp / 3 pending / 23 disabled)` | Theo `docs/tool-catalog.md` header |
| 6 | `cm` | Code Mode | Paradigm — gọi tool bằng TS trong `call_tool_chain`, không phải MCP tool rời | `cm:js sandbox call_tool_chain` | Khái niệm, không phải process |
| 7 | `cmm` | Code Mode MCP | Adapter generic `@utcp/code-mode-mcp` chạy như MCP server | `cmm key=ccp pkg=@utcp/code-mode-mcp` | `mcpServers.ccp.args = ["@utcp/code-mode-mcp"]` |
| 8 | `utcp` | UTCP | Protocol HTTP `GET/POST /utcp` + `@utcpTool` schema | `utcp manual http://localhost:49650/utcp` | Khai báo bằng `@utcpTool` trong `source/utcp/tools/*` |
| 9 | `mcp` | MCP | Protocol stdio giữa Agent ↔ `cmm` | `mcpServers.ccp` (key do client đặt) | Không phải product, là transport |
| 10 | `exs` | Express Server | `express@4.21.2` bên trong `ccpe` | `exs:49650` | Chi tiết nội bộ của `ccpe`, chỉ dùng trong log |
| 11 | `bd` | Binding | Tuple `ccpi + projectPath + iid` sau `editorHandshake` | `bd:ccp3x_49650#abc123 project=G:/proj/my-game` | `projectMatches:true && probe.status:responsive` mới mutate |
| 12 | `prs` | Presence | `scripts/session-presence/*` + `editorSessionHeartbeat` | `prs:Active 5s session=uuid` | Advisory, không phải lock |

Quy ước:

- `CCP` is the product; `ccp` is the MCP server key. Architecture roles use `ccpe` (artifact), `ccpi:ccp3x_<port>` (runtime instance), `ccpt` (toolset), and `ccpr` (registry).
- `cce` là Creator Editor — không lẫn `exs` (Express bên trong `ccpe`).
- `cm` = paradigm; `cmm` = process adapter; neither identifies a Creator endpoint.
- Wire format giữ nguyên `ccp3x_<port>` — đọc là `ccpi id`. Bare `ccp3x`/`ccp2x` (latest alias) đã bỏ — xem Contract C1.
- Version khi cần: `ccpt@3.7.3:321`, `ccpe@2.0.0`.

## 2) Quan hệ

```text
[cce] --hosts--> [ccpe] --runs--> [exs:port] --serves utcp--> [ccpi:ccp3x_<port>]
  |                    | publish/remove              |
  +------------------->[ccpr] <---register_manual----[cmm] <--mcp--> [agent]
  |                    | handshake(bd.iid)           | call_tool_chain
  +--- Editor.Message.request <---> [ccpi] ----------+----> [ccpt:321]
  +--- presence bd/prs ----------------------------------> [cmm/heartbeat]
```

Đọc theo chiều gọi:

1. `cce` host `ccpe`; `ccpe` chạy `exs` và serve `utcp` manual.
2. `ccpe` publish `ccpi:ccp3x_<port>` vào `ccpr`.
3. Agent qua `mcp` gọi `cmm.register_manual(ccpi)` → `cmm` expose `ccpi.*` cho `cm` (`call_tool_chain`).
4. `ccpi` thực thi `ccpt` qua `Editor.Message.request`; write đi kèm `snapshot` (undo).
5. `prs` theo dõi `bd` (advisory).

## 3) Contract

### C1 — Registry Publication (`ccpe → ccpr`)

- Mỗi `ccpe` publish 1 entry duy nhất `ccp3x_<actual-port>` với `CCP3X_OWNER_<port>=iid` + `CCP3X_PROJECT_<port>=projectPath`.
- Serialize qua `<ccpr>.ccp-lock` (poll 25ms, fail sau 5s), write temp + fsync + atomic rename.
- Auto mode reuse `lastAutoPort`; occupied → fallback 1 lần sang OS-assigned port, chỉ lưu sau publish thành công. `fixedServerPort` occupied → fail không fallback.
- Probe cleanup chỉ trên `127.0.0.1`/`localhost`; IPv6 invalid và block publish. Chỉ xóa entry definitively refused và `owner` không đổi sau khi writer giữ lock và reread.
- Bare `ccp3x`/`ccp2x` latest alias không tồn tại; legacy entry migrate về `ccp3x_<port>` theo URL, không giữ alias.

Nguồn: `source/main.ts:35-62`, `source/utcp/config-manager.ts`, `docs/ccp-code-mode-usage.md:13-19`.

### C2 — Registration + Handshake (`cmm → ccpi → bd`)

- Agent phải `register_manual({name:'ccp3x_<port>', url:'http://localhost:<port>/utcp'})` → `list_tools` chứa namespace → `ccpi.editorHandshake({expectedProjectPath, timeoutMs:1000})`.
- Lưu `bd = {namespace, url, projectPath, iid}`. Yêu cầu `projectMatches:true && probe.status:responsive` trước mọi mutation; scene-dependent ops thêm `sceneReady:true`.
- `bd.iid` đổi → vứt mọi `reference {id,type}` cũ dù `port` không đổi. Re-handshake sau mỗi reconnect/restart/`ccpe` reload.
- Project mismatch / ambiguous selection / unreachable `bd.url` → dừng mutation, không fallback sang `ccpi` khác. Mỗi agent bind `bd` riêng, không ảnh hưởng agent khác.

Nguồn: `docs/ccp-code-mode-usage.md:52-95`.

### C3 — Mutation (`ccpi → cce`)

- Read tools = `GET`, write tools = `POST` + `Editor.Message.request('scene','snapshot')` để có undo.
- `probe.sceneReady:false` vẫn giữ HTTP nhưng cấm scene mutation (scene chưa sẵn sàng, không phải disconnect).
- Batch ưu tiên: `sceneBatchGet`, `assetBatchQuery`, `nodeBatchSet`.

Nguồn: `README.md:Architecture/Tool Execution`, `source/utcp/tools/*`.

### C4 — Presence (`prs`, advisory)

- `editorSessionHeartbeat` mỗi 5s qua `cmm` hoặc `scripts/session-presence/heartbeat.js` / `supervisor.js`.
- Trạng thái: `Active` ≤15s, `Stale` ≤60s, `Expired`; instance-scoped, clear khi `ccpe` restart. Tối đa 100 sessions.
- Là monitor khuyến cáo, không phải lock/mutex. Agent phải dừng write khi `prs` unsafe và re-handshake trước khi tiếp tục.

Nguồn: `docs/ccp-code-mode-usage.md:99-179`.

## 4) Quy tắc đặt tên trong plan/spec/code

- Trong plan/spec: dùng `ccpi:ccp3x_<port>.editorHandshake()` và `cmm.register(ccpi)` để xác định endpoint và adapter rõ ràng.
- Trong config: `mcpServers.ccp` là **MCP server key** (do client đặt) trỏ tới `cmm` package `@utcp/code-mode-mcp`; `ccpr` path qua `UTCP_CONFIG_FILE`.
- Trong doc/skill: khi nói code artifact dùng `ccpe`; khi nói runtime instance dùng `ccpi:ccp3x_<port>`; khi nói tập tool dùng `ccpt`.
- Không hardcode `port`; lấy từ `ccpr` hoặc panel Status. Không dùng bare `ccp3x`/`ccp2x` để chọn latest.
- Khi log: prefix `cce`/`ccpe`/`ccpi`/`ccpr`/`cmm`/`bd`/`prs` để greppable.

## 5) Ví dụ copy-ready

```typescript
// C2: cmm register ccpi, verify, handshake → bd
await register_manual({
  manual_call_template: {
    name: 'ccp3x_49650', // ccpi id (từ ccpr hoặc Status)
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
// require bd.projectMatches === true && bd.probe.status === 'responsive'
const tree = await ccp3x_49650.nodeGetTree({ maxDepth: 2, fields: ['name','active'] });
```

```json
// mcp (key) → cmm (adapter) → ccpr (registry)
{
  "mcpServers": {
    "ccp": {
      "command": "npx",
      "args": ["@utcp/code-mode-mcp"],
      "env": { "UTCP_CONFIG_FILE": "~/.utcp_config.json" }
    }
  }
}
```

## 6) Lịch sử đổi tên

- Trước 2026-09: `ccb`/`ccp3x` dùng cho cả extension + toolset + namespace + MCP key; `ccp3x` bare là latest alias; `code mode mcp` bị gọi là `ccb mcp`.
- Final CCP cutover: active identities use the 12 roles above with `ccpe`/`ccpi`/`ccpr`/`ccpt`; obsolete family names exist only as explicit migration inputs or historical records. Bare runtime aliases are removed; `cm`/`cmm` distinguish paradigm/adapter and `bd`/`prs` distinguish binding/presence.

## 7) Tham chiếu

- `docs/ccp-code-mode-usage.md` — connection model, bootstrap, watchdog, presence.
- `README.md` — architecture, tool catalog, install.
- `ccp3x.d.ts` / `docs/tool-catalog.md` — `ccpt` surface.
- `source/main.ts`, `source/utcp/utcp-server.ts`, `source/utcp/config-manager.ts` — `ccpe`/`ccpr` implementation.
- `.claude/skills/ccp3x/SKILL.md` — agent bootstrap skill (đã align với hệ này).
