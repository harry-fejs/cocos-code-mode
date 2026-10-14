# Changelog

## Unreleased — Creator 3.7 follow-through

- Add authoritative build preflight, redacted registered-toolchain inspection and guarded terminal native task options updates. Native task updates explicitly do not persist history or dispatch builds.
- Add bounded project-code tween create/inspect/static validation with explicit new-source ownership and runtime-unavailable separation; no native tween asset or automatic target binding.
- Reconcile duplicate workflow overrides, exact source routes and current hashes while preserving approved historical denominator identities separately from reproducible semantic hashes. Current coverage is not fresh live qualification.
- Add implementation-only official localization table inspection/key coverage across explicit locales and read-only Game View particle state wait. Declarations and discovery guidance included; later full regression/live qualification is pending by owner instruction.
- Add implementation-only exact skeletal clip observe/state wait and task-linked expected-output SHA-256 manifest inspection. Read-only paths, bounded deadlines/bytes and explicit producer-freshness limits; live qualification remains pending.
- Add implementation-only official-table text diagnostics for simple-brace placeholder mismatch and explicitly supplied Unicode repertoire; no font/layout/fallback/runtime validity inference.

## 2.2.0 — 2026-09-05 — Cocos Graph v4 + Typed Recovery Errors + 3x Baseline Consolidation

Hợp nhất toàn bộ các nhánh `feat/ccp3x-consolidated`, `feat/ccp3x-fail-loud-smoke`, và `feat/ccp3x-scene-graph-index` vào `cc-3x7` (commit `53589bb`). 159 unit tests pass, 31 graph tests pass.

- **Cocos Graph v4 (`tools/cocos-graph`):**
  - CLI điều hướng cấu trúc scene/project offline với các lệnh `build`, `query`, `resolve`, `navigate`, `refs`, `session-record`, `validate`.
  - Schema v4: composite handle `<file>#<engine-id>`, lưu giữ file provenance và component `fileId`.
  - Hỗ trợ atomic generation swap với `fsync`, file lock đa tiến trình (`owner.json` + PID + stale-timeout 30s), và scoped build `--bundle`.
  - Incremental rebuild dựa trên content-hash (sha256); bảo tồn manifest và thế hệ graph hợp lệ khi build gặp lỗi.
  - Live overlay cho scene đang mở (`treeToGraph`): giải quyết độ lệch 62% node giữa disk và live do prefab expansion; disk shards giữ cờ `prefabOpaque: true`.
  - Đo đạc P5 thực tế trên `cc30-new-all-in-one`: giảm 100% bridge calls cho tìm kiếm cấu trúc, giảm 87.28% kích thước payload response, hit rate 100%, query p50 = 92.4ms.
- **Fail-Loud Audit & Durable Smoke Suite:**
  - Hoàn tất quét toàn bộ 45 tools theo 4 mẫu silent-failure: bịt triệt để các khối `catch {}` rỗng, false-success trên các write path (`set-property`, `restore-prefab`, `move-array-element`, `add-task`, `animation-operation`, `validateScene`).
  - Kiểm tra magic bytes ảnh JPEG (`/9j/`), từ chối input lỗi ở `simulateKeyCombo`.
  - Khởi tạo smoke suite 2 tầng trong `scripts/smoke-utcp.js` và CI guard `tests/unit/fail-loud-contract.test.js` kèm kiểm tra lệch build (`/build-info` vs `git rev-parse HEAD`).
- **Typed Tool Recovery Errors:**
  - Chuẩn hóa contract `ToolError` (HTTP 400/404/422) với cấu trúc `{ error, code, details, recovery }`.
  - `nodeGetTree`: Trả `TARGET_NOT_FOUND` (HTTP 404) kèm `currentSceneUuid` và hướng dẫn recovery khi node không thuộc scene đang mở; từ chối composite handle bằng `COMPOSITE_HANDLE_NOT_SUPPORTED` (HTTP 400).
  - `readPrefabJson`: Trả `ASSET_TYPE_MISMATCH` (HTTP 422) khi nhận file `.scene`.
  - `inspectorGet`: Trả `TARGET_NOT_FOUND` (HTTP 404) khi không tìm thấy target hoặc target không hỗ trợ; bổ sung `SceneImporter` để trích xuất metadata `.scene`.
- **Cocos 3.8 Config Support & Lane C Intake:**
  - Tự động probe IPC `project/set-config` cho Creator 3.8; fallback trả typed `UNSUPPORTED_EDITOR_API` (HTTP 422) trên 3.7.3 mà không tự ý ghi file bừa bãi.
  - Port bổ sung 3 tool Lane C với strict schema và kiểm thử IPC: `materialQuery`, `assetDbQuery`, và `editorQuery:has_script`.
- **Strict UTCP Schemas & Packaging:**
  - Làm sạch UTCP manual: loại bỏ toàn bộ annotations nội bộ thừa, kích hoạt `slimOutputsSchema` thu gọn output schema.
  - Sửa script đóng gói `npm run package` hỗ trợ đa nền tảng bằng `archiver` v8 streaming, tạo gói cài đặt zip hoàn chỉnh `cocos-pilot-3x-v210-*.zip` (33MB).
  - Bổ sung Ma trận điều phối Tool (Tool Selection Matrix) vào `SKILL.md` và `docs/agent-tool-failure-modes.md` hướng dẫn agent phân định giữa scene đang mở, file scene trên disk, và prefab đóng.

## 2.1.1 — 2026-08-23 — clean break + asset meta parity

- **Clean break:** bỏ hết compat `cc3x7`/`cc2x4` khỏi bootstrap/skill/smoke; `~/.utcp_config.json` chỉ nhận `cocos-pilot-3x`/`ccp3x` + `cocos-pilot-2x`/`ccp2x`. Xoá shim `scripts/code-mode-bootstrap.js`.
- **Parity gap #1 đóng:** `assetOperate` +`save_meta` (`save-asset-meta`) và `assetDbQuery` +`meta` (`query-asset-meta`) — cặp read-modify-write, ngang `assetSaveMeta` của 2x. Vẫn **46 tools** (chỉ thêm op).
- **Dọn tên sót:** `source/scene.ts` log tag, error message của `smoke-utcp.js`/`bench-utcp-tools.js`, README title/zip name → `cocos-pilot-3x`.

## 2.1.0 — 2026-09-21 — Cocos Pilot hard cut + game-complete enrich (BREAKING)

- **Hard cut `cc-bridge` → `cocos-pilot`, `ccb3x/ccb2x` → `ccp3x/ccp2x`**: package `cc-bridge-3x` → `cocos-pilot-3x` (menu `Cocos Pilot 3x`, i18n key `cocos-pilot-3x.*`, d.ts `cocos-pilot-3x.d.ts` / namespace `cocos_pilot_3x` + alias `ccp3x`), MCP server key `cc-bridge` → `cocos-pilot` (`mcpServers.cocos-pilot`), manual namespace `ccb3x_<port>` → `ccp3x_<port>`, skill `.claude/skills/cocos-pilot`, cache `.claude/cocos-pilot-cache.json`, bootstrap `scripts/cocos-pilot-bootstrap.js`, response `callId` prefix `ccb_` → `ccp_`, docs `cocos-pilot-code-mode-usage.md`. No `ccb*` alias retained — legacy `ccb*`/`cc-bridge*` entries are purged on `~/.utcp_config.json` read.
- **Confusion fixed**: MCP server key (`cocos-pilot`) and Cocos manual namespace (`ccp3x_<port>`) are now intentionally distinct — key is the Code Mode adapter transport, namespace is the Pilot instance. Config stays `~/.utcp_config.json` (`UTCP_CONFIG_FILE` unchanged) but template names are `ccp3x*`.
- **Identity glossary**: `docs/architecture-identity.md` with 12 locked IDs (`cce`/`ccbe`/`ccbi:ccp3x_<port>`/`ccbr`/`ccbt`/`cm`/`cmm`/`bd`/`prs`/`exs`) and contracts C1-C4 — `ccb` family prefix removed.
- **Enrich 46:** `assetResolvePath` -> accepts `reference` OR `assetPath`, returns `exists`/`isDirectory`/`type`/`importer` alongside `filesystemPath`/`url`/`uuid` (verified `query-path`/`query-url`/`query-asset-info`/`query-uuid`).
- **New +1:** `assetReadContent` (text read by uuid or db:// path, 512KB cap + binary guard, `maxBytes` override) -> 45 -> **46** (additive).
- **Enrich:** `editorSelect` +`hover`/`update` (`hover(type,uuid?)` null=hover-out, `update(type,uuid[])`) port verified from 2x `Editor.Selection` surface (`update`/`hover` exist on 3.7.3 `editor.d.ts`).
- **Enrich:** `materialQuery` +`physics_material` (`query-physics-material`, facade + registry), `assetDbQuery` +`db_info` (`query-db-info dbName`).

## 2.0.0 — 2026-08-19 — Cocos Pilot 3x (formerly Code Mode for Cocos Creator)

**Breaking:** consolidate 68 legacy+A1 tools -> **45** via 10 consolidated dispatchers. 26 legacy names removed from `/utcp`; consolidated surface is now the only one. Legacy method bodies kept (not registered) for `consolidated-tools.ts` delegation (`new LegacyTool().method()`).
- **A1 shims (68)** — `bacb693`: added 7 consolidated tools alongside 61 legacy (`deprecated` tag), both names coexisted.
- **2.0.0 (68->51)** — `d1975d9`: strip 17 legacy `@utcpTool` (`inspectorGet/Set*`, `inspectorGet*Definition`, `nodeComponentAdd/Remove`, `sceneOpen`+`editorOperate`, `build*` 5).
- **2.0.x (51->45)** — `df6a1c2`: add 3 consolidated (`previewManage` 4->1, `programManage` 3->1, `projectManage` 2->1), strip 9 legacy (`previewGetUrl`/`previewOpenInBrowser`/`assetGetPreview`/`editorGetScenePreview` + `programGetInfo`/`programOpen`/`urlOpen` + `projectGetConfig`/`projectSetConfig`). Net `68 - 26 = 45 = 35 standalone + 10 consolidated`.
- **Docs/decl** — `README` 45, `cocos-pilot-3x.d.ts` +1 decorator, `docs/consolidated-migration.md` codemod 26 legacy, `scripts/smoke-utcp.js` expects 45 (consolidated `inspectorGetDefinition` + `previewManage`).
- **Perf already in this line** — `maxDepth`/`maxNodes`/`fields[]` tree budgets, `section` definition pagination, `fields[]` selective dump, `response-trimmer`, desc avg ~76 chars (see `docs/prompt-guidance-risks.md`, `a769a46` bench).

**Migration:** `docs/consolidated-migration.md` — one-line codemod `inspectorGetInstanceProperties`->`inspectorGet` etc., `sceneOpen`->`sceneManage`, `preview*/assetGetPreview`->`previewManage`, `program*/urlOpen`->`programManage`, `project*`->`projectManage`.

## 1.x

Pre-consolidation line (61 tools, `CocosEditor3x7` namespace, Creator `>=3.8.7`). See `main` history.
