# Changelog

## Unreleased — project-scoped connections

- Bind canonical Cocos project identity, dedicated port, fresh relay session, and configured Gateway context together in a readable external project registry; keep ordinary UTCP config free of metadata variables.
- Replace growing UUID dotenv registrations with one private stable credential file per project and correctly namespaced token/session/port/project variables.
- Serialize shared config transactions; reject ambiguous/live project or reserved-port collisions, malformed config, and stale panel writes. Own-session shutdown cannot remove a replacement session.
- Add backup-first dry-run/apply migration that externalizes earlier embedded metadata and stores unresolved offline CCB3x history separately, without deleting env files or changing unrelated products.
- Make live readiness/qualification and benchmark selection project-first; add real-SDK authenticated two-project smoke and behavioral concurrency/collision coverage.
- Preserve the Windows current-user + SYSTEM protected-state DACL while permitting only its reviewed, rename-map-bound, whole-module SHA-256-pinned security operation through both packaging gates. Added arbitrary-launch, altered-command/DACL, and renamed-identity rejection regressions; the separate single updater activation requirement and unrelated forbidden-material checks remain enforced.

## 2.2.0 — 2026-09-05 — Cocos Graph v4 + Typed Recovery Errors + 3x Baseline Consolidation

Hợp nhất toàn bộ các nhánh `feat/ccb3x-consolidated`, `feat/ccb3x-fail-loud-smoke`, và `feat/ccb3x-scene-graph-index` vào `cc-3x7` (commit `53589bb`). 159 unit tests pass, 31 graph tests pass.

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
  - Sửa script đóng gói `npm run package` hỗ trợ đa nền tảng bằng `archiver` v8 streaming, tạo gói cài đặt zip hoàn chỉnh `cc-bridge-3x-v200-*.zip` (33MB).
  - Bổ sung Ma trận điều phối Tool (Tool Selection Matrix) vào `SKILL.md` và `docs/agent-tool-failure-modes.md` hướng dẫn agent phân định giữa scene đang mở, file scene trên disk, và prefab đóng.

## 2.1.1 — 2026-08-23 — clean break + asset meta parity

- **Clean break:** bỏ hết compat `cc3x7`/`cc2x4` khỏi bootstrap/skill/smoke; `~/.utcp_config.json` chỉ nhận `cc-bridge-3x`/`ccb3x` + `cc-bridge-2x`/`ccb2x`. Xoá shim `scripts/code-mode-bootstrap.js`.
- **Parity gap #1 đóng:** `assetOperate` +`save_meta` (`save-asset-meta`) và `assetDbQuery` +`meta` (`query-asset-meta`) — cặp read-modify-write, ngang `assetSaveMeta` của 2x. Vẫn **46 tools** (chỉ thêm op).
- **Dọn tên sót:** `source/scene.ts` log tag, error message của `smoke-utcp.js`/`bench-utcp-tools.js`, README title/zip name → `cc-bridge-3x`.

## 2.1.0 — 2026-08-21 — game-complete enrich (CC Bridge 3x)

- **Enrich 46:** `assetResolvePath` -> accepts `reference` OR `assetPath`, returns `exists`/`isDirectory`/`type`/`importer` alongside `filesystemPath`/`url`/`uuid` (verified `query-path`/`query-url`/`query-asset-info`/`query-uuid`).
- **New +1:** `assetReadContent` (text read by uuid or db:// path, 512KB cap + binary guard, `maxBytes` override) -> 45 -> **46** (additive).
- **Enrich:** `editorSelect` +`hover`/`update` (`hover(type,uuid?)` null=hover-out, `update(type,uuid[])`) port verified from 2x `Editor.Selection` surface (`update`/`hover` exist on 3.7.3 `editor.d.ts`).
- **Enrich:** `materialQuery` +`physics_material` (`query-physics-material`, facade + registry), `assetDbQuery` +`db_info` (`query-db-info dbName`).
- **Rename 3x:** `cocos-code-mode-3x7` -> `cc-bridge-3x`, manual `cc3x7` -> `cc-bridge-3x` + alias `ccb3x` (JS `cc_bridge_3x`/`ccb3x`, compat `ccb-3x`/`ccb_3x`), package menu `CC Bridge 3x`, d.ts `cc-bridge-3x.d.ts`, bootstrap `cc-bridge-bootstrap.js`, skills `.claude/skills/cc-bridge-3x`, removed legacy `cc-code-mode` shim + `code-mode-references.d.ts`.

## 2.0.0 — 2026-08-19 — CC Bridge 3x (formerly Code Mode for Cocos Creator)

**Breaking:** consolidate 68 legacy+A1 tools -> **45** via 10 consolidated dispatchers. 26 legacy names removed from `/utcp`; consolidated surface is now the only one. Legacy method bodies kept (not registered) for `consolidated-tools.ts` delegation (`new LegacyTool().method()`).

- **A1 shims (68)** — `bacb693`: added 7 consolidated tools alongside 61 legacy (`deprecated` tag), both names coexisted.
- **2.0.0 (68->51)** — `d1975d9`: strip 17 legacy `@utcpTool` (`inspectorGet/Set*`, `inspectorGet*Definition`, `nodeComponentAdd/Remove`, `sceneOpen`+`editorOperate`, `build*` 5).
- **2.0.x (51->45)** — `df6a1c2`: add 3 consolidated (`previewManage` 4->1, `programManage` 3->1, `projectManage` 2->1), strip 9 legacy (`previewGetUrl`/`previewOpenInBrowser`/`assetGetPreview`/`editorGetScenePreview` + `programGetInfo`/`programOpen`/`urlOpen` + `projectGetConfig`/`projectSetConfig`). Net `68 - 26 = 45 = 35 standalone + 10 consolidated`.
- **Docs/decl** — `README` 45, `cc-bridge-3x.d.ts` +1 decorator, `docs/consolidated-migration.md` codemod 26 legacy, `scripts/smoke-utcp.js` expects 45 (consolidated `inspectorGetDefinition` + `previewManage`).
- **Perf already in this line** — `maxDepth`/`maxNodes`/`fields[]` tree budgets, `section` definition pagination, `fields[]` selective dump, `response-trimmer`, desc avg ~76 chars (see `docs/prompt-guidance-risks.md`, `a769a46` bench).

**Migration:** `docs/consolidated-migration.md` — one-line codemod `inspectorGetInstanceProperties`->`inspectorGet` etc., `sceneOpen`->`sceneManage`, `preview*/assetGetPreview`->`previewManage`, `program*/urlOpen`->`programManage`, `project*`->`projectManage`.

## 1.x

Pre-consolidation line (61 tools, `CocosEditor3x7` namespace, Creator `>=3.8.7`). See `main` history.
