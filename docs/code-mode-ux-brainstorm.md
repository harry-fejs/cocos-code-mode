# Code Mode UX — tu tool trung gian sang tool thuong

> **Ngay:** 2026-08-19 · **Trang thai:** done — Huong 1 da trien khai (2026-08-19)
> **Pain point (a):** Muon dung code mode phai noi rat nhieu — `register_manual` toi server Cocos, roi moi lan can tool gi lai `search_tools`/`tools_info` de check trong "code mode box" co gi. Muon rut gon de agent tu hieu va goi thang nhu tool thuong.
> **Huong chon:** (A) cache — register xong thi nho, chat trong session bao "dung code mode / set vi tri / ..." neu tool da co trong cache thi goi thang `cc3x7.*` thay vi register/tim lai. (Khong phai (B) tach moi tool thanh MCP tool rieng.)
> **Trien khai:** `.claude/skills/cc-code-mode/SKILL.md` + `scripts/code-mode-bootstrap.js` (SessionStart hook) + `.claude/settings.json` + `prompt_example.md` Phase 1 cache-first. Cache luu full `toolDefs[]` tu `GET /utcp` (1 fetch = full detail). Da sync sang `cc-2x`.

## 1. Hien trang (as-is)

```
User prompt: "set vi tri node X"
  -> Agent: register_manual({ name:"cc3x7", url:"http://localhost:<port>/utcp" })
  -> Agent: search_tools("set position") / list_tools / tools_info
  -> Agent: call_tool_chain("cc3x7.inspectorSet({ ... })")
```

- Extension (`source/main.ts` + `source/utcp/config-manager.ts`) tu ghi `cc3x7 -> http://localhost:<port>/utcp` vao `~/.utcp_config.json` moi lan start.
- `@utcp/code-mode-mcp` doc file nay, expose 3 MCP tool: `register_manual`, `search_tools`/`list_tools`/`tools_info`, `call_tool_chain` (JS sandbox).
- Moi session moi, agent phai discover lai tu dau — ton 2-3 round-trip + token cho mo tả tool.

## 2. Mong muon (to-be)

```
User prompt: "dung code mode set vi tri node X"
  -> Agent: (cache hit) call_tool_chain("cc3x7.inspectorSet({ ... })")  // goi thang, khong discover
```

- Chi can 1 lan register + discover dau session (hoac dau project), cac lan sau goi thang `cc3x7.<tool>`.
- Neu port doi (extension restart) hoac tool list doi (extension update) -> tu refresh 1 lan roi retry.

## 3. Ba huong — trade-off

| Huong | Lam gi | Sua dau | Pros | Cons |
|-------|--------|---------|------|------|
| **1. Skill + auto-register hook (recommend)** | Skill `cc-code-mode` + hook `SessionStart` doc `~/.utcp_config.json` -> `register_manual` + `list_tools` 1 lan, cache vao session/file | `.claude/skills/cc-code-mode/SKILL.md` + `.claude/settings.json` hook + `scripts/code-mode-bootstrap.js` | 0 sua extension, 1 skill + 1 hook la xong. Tiet kiem 60-80% token (bo 2-3 round-trip moi task). De revert. | Cache co the stale neu extension update tool list — can retry logic. |
| 2. Extension tu publish manifest | Extension ghi `.claude/cc-code-mode-manifest.json` chua full tool list + port khi start | `source/main.ts`, `source/utcp/utcp-server.ts` | Khong can HTTP round-trip de discover | Phai sua extension, them file I/O, handle multi-project (moi project 1 manifest) |
| 3. Code-Mode MCP stateful | Fork `@utcp/code-mode-mcp` cho no persist `manual_call_templates` | Ngoai repo (npm package cua UTCP team) | Triet de nhat — khong bao gio phai register | Dung toi dep ngoai, kho maintain khi upstream update |

**Khuyen nghi:** Trien khai **Huong 1** truoc. Khi tool list thay doi thuong xuyen hoac can share cache giua nhieu project thi nang cap len Huong 2 — khong phai lam lai.

## 4. Design ngan cho Huong 1

### 4.1 Files cham

- `.claude/skills/cc-code-mode/SKILL.md` (moi) — instruction cho agent: khi nao auto-register, khi nao dung cache, khi nao refresh.
- `scripts/ccp-bootstrap.js` (mới, ~40 dòng) — đọc `~/.utcp_config.json` → cache tool metadata vào `.claude/ccp-cache.json` (optional, persist qua session).
- `.claude/skills/ccp3x/SKILL.md` — workflow bootstrap và binding chính thức.

### 4.2 Cache invalidation

- Neu `call_tool_chain` bao `manual not found` hoac `tool not found` -> tu re-register + refresh cache 1 lan roi retry.
- Port doi (extension restart) tu fix vi moi lan hook doc lai `~/.utcp_config.json`.

### 4.3 Testing

- Mo session moi, prompt "dung code mode set vi tri node X" -> verify agent goi thang `call_tool_chain` khong qua `register_manual`/`search_tools` (check tool call log).

## 5. Pham vi & lien quan

- **Khong phai:** tach moi Cocos tool thanh MCP tool rieng (huong B) — Code Mode giu JS batch vi tiet kiem token hon nhieu.
- **Ap dung cho ca 2 nhanh:** `cc-3x7` (`cc3x7`) va `cc-2x` (`cc2x4`) — cung co che, khac ten manual.
- **Khong can spec file lon:** day la bounded change (sua flow hien co, khong tao subsystem moi). Skill + hook la du.

## 6. Next step — done 2026-08-19

Huong 1 da xong: skill + hook + cache `toolDefs` (full detail) + prompt cache-first. Session resume da log `[code-mode-bootstrap] cached cc3x7, cc2x4 (91 tools)`. Them tool moi thi diff `toolDefs` la thay ngay — khong can `tools_info` tung tool.

---
*Nguon: brainstorm session 2026-08-19 — phan loai: bounded, recommend Huong 1 (skill + hook).*


> 2026-08-21 renamed: `cc-remoter-*` → `cocos-pilot-*` (ccp3x/ccp2x). Clean break — `cc3x7`/`cc2x4` compat removed (`6645ba7`).
