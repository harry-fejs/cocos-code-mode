# Parity v2 ↔ v3 — tool surface + đường thay thế

Tham chiếu sống cho câu hỏi "bản kia có tool tương đương không". Cập nhật mỗi khi port xong một dòng.

**v3** `ccp3x` (Creator 3.7.x/3.8.x, branch `feat/ccb3x-consolidated` / `cc-3x7`) = **86 tools** · **v2** `ccp2x` (Creator 2.4.15, branch `cc-2x`) = **53 tools**
**Cập nhật:** 2026-09-05 (Consolidated baseline @ `0483c4f`: Graph v4, Fail-Loud §2/§5/§7, strict UTCP manual 0-annotations, 3.8 project-config probe & IPC implementation, Lane C intake; unit tests 158/158 pass)
**Đối chiếu message:** `docs/cc-3x7-message-registry.json` (416 msg / 20 module, dump 3.7.3) · coverage 131/416 xem `plans/reports/verify-260821-0939-cc3x7-api.md`

## Nguyên tắc đọc bảng

Tên khác nhau **không** đồng nghĩa thiếu chức năng — v3 gom 10 consolidated (`*Manage`/`*Operate`/`inspector*`), v2 giữ standalone. Trùng tên 16 · chỉ-v3 30 · chỉ-v2 37.

| Ký hiệu | Nghĩa |
|---|---|
| ✅ | có tool tương đương, dùng thay được ngay |
| ⚠️ | chỉ cover một phần, hoặc phải ghép nhiều call / read-modify-write |
| ❌ | không có đường — engine không expose message |
| 🔧 | message CÓ sẵn, chỉ chưa expose thành tool → sửa được ngay |

## Trùng tên nhưng lệch ops

| Tool | v3 | v2 | Kết luận |
|---|---|---|---|
| `animationQuery` | 10 ops (`root_info/root/edit_info/clips_info/clip_dump/properties/state/current_info/clip_time/value_at_frame`) | 4 (`clips_info/clip_dump/properties/state`) | v2 thiếu 6 — port được |
| `animationEdit` | 8 (`record_start/stop/change_root/set_edit_clip/set_edit_time/clip_state/save_clip/operate`) | 4 (`record_start/stop/save_clip/operate`) | v2 thiếu 4 |
| `editorSelect` | 7 (`select/unselect/clear/query/select_all/hover/update`) | 10 (`query/select/unselect/clear/hover/set_context/patch/filter/confirm/cancel`) | **lệch 2 chiều** — v3 thiếu `set_context/patch/filter/confirm/cancel` (module `selection` 3.7 không có msg), v2 thiếu `select_all/update` |
| `nodeClipboard` | `copy/cut/paste` | + `duplicate` | v3 `duplicate` → `nodeOperate copy` (dùng `duplicate-node`) ✅ |
| `assetQuery` | filter-based (`glob/ccType/importer/extname/isBundle`) | 8 ops umbrella (`search/tree/info/meta/types/sub_assets/used_by/metas`) | tương đương sau khi cộng `assetGetTree` + `assetResolvePath` + `assetFindReferences` + `editorQuery asset_types` ✅ |

## Chỉ v3 có (30) — v2 dùng gì thay

| v3 tool | v2 thay thế | |
|---|---|---|
| `assetGetAtPath` | `assetResolve uuid_from_url` | ✅ |
| `assetGetTree` | `assetQuery tree` | ✅ |
| `assetSaveContent` | `assetWriteContent` | ✅ |
| `assetResolvePath` | `assetResolve` — v2 giàu hơn (+`is_sub_asset/contains_sub_assets/mount_info/relative_path/backup_path`) | ✅ |
| `assetOperate` move/delete/refresh | `assetMove` · `assetDelete` · `assetRefresh` | ✅ |
| `assetOperate` copy/open/reimport | `assetReadContent`+`assetWriteContent` · `programOpen` · `assetRefresh` | ⚠️ |
| `assetFindReferences` used_by | `assetQuery used_by` | ✅ |
| `assetFindReferences` depends_on | — | ⚠️ 2.4 không có `query-asset-dependinces` |
| `assetCreate` (16 kiểu) | `assetCreateFolder` + `assetWriteContent` | ⚠️ folder/text OK; asset có template (material/effect/anim-clip/render-texture) phải tự viết content |
| `editorHistory` | `editorUndo` | ✅ |
| `editorQuery` creatable_assets/asset_types/importers | `editorListTypes` | ✅ |
| `editorQuery` scene_mode/ready/enum_values/layers/sorting_layers/script_info/has_script | `sceneInfo` (một phần) | ⚠️ thiếu 7 ops |
| `editorViewport` (12 ops gizmo/2d/align) | — | ❌ `scene:change-gizmo-*` timeout (Probe 4: 14/14 fire-and-forget) |
| `findNodesByAsset` | `sceneSnapshot` + filter client-side | ⚠️ |
| `findNodes` (by name/component, G3) | — (mới, v2 không có) | ✅ walk `nodeGetTree` in-memory (2026-08-28) |
| `findNodesWithMissingAssets` | `sceneSnapshot` + scan null ref | ⚠️ |
| `inspectorGet` | `nodeQuery dump` + `componentQuery props` | ✅ |
| `inspectorSet` | `nodeSetProperty` / `nodeSetPropertyUndo` | ✅ |
| `inspectorGetDefinition` (gen d.ts runtime) | file tĩnh `ccp2x.d.ts` | ✅ khác cơ chế, cùng nhu cầu |
| `listComponentClasses` · `nodeGetAvailableComponentTypes` · `nodeComponentsGet` | `componentQuery classes` / `props` | ✅ |
| `nodeGetTree` · `nodeGetAtPath` | `nodeQuery tree` / `at_path` · `sceneSnapshot` | ✅ |
| `nodeOperate` move/copy/delete/apply_prefab | `nodeMove` · `nodeDuplicate` · `nodeRemove` · `prefabSync` | ✅ |
| `nodeOperate` lock/unlock + create/link/revert/unwrap/open_prefab | — | ❌ `scene:*` prefab IPC timeout (Probe 4) |
| `previewManage` (4 ops) | `previewGetUrl` + `previewOpenInBrowser` + `assetGetPreview` + `editorGetScenePreview` | ✅ 1:4 |
| `programManage` (3 ops) | `programGetInfo` + `programOpen` + `urlOpen` | ✅ 1:3 |
| `projectManage` (get/set) | `projectGetConfig` (read-only) | ⚠️ v3 hỗ trợ `get` trên 3.7+ và `set` qua 3.8 IPC `Editor.Message.request('project','set-config','project', dotPath, value)` (probe-gated; 3.7 trả HTTP 422 `UNSUPPORTED_EDITOR_API` kèm recovery guidance sửa `settings/v2/packages/*.json`); 2.4 chỉ hỗ trợ đọc |
| `sceneGetInfo` | `sceneInfo` | ✅ |
| `sceneManage` open/save | `sceneOpen` · `editorOperate save_scene` | ✅ |
| `sceneManage` save_as/close/soft_reload | — | ⚠️ chưa port |
| `propertyArrayElement` (remove/move phần tử array) | `nodeSetProperty` toàn array (read-modify-write) | ⚠️ không atomic |
| `assetDbQuery` (databases/busy/mtime/data/db_info/meta/ready) | `assetResolve mount_info` + `assetQuery meta` | ⚠️ Lane C intake: 3x cover 7 IPC ops (missing-asset được bảo vệ qua `isMessageNotExposed`); 2x thiếu busy/mtime/raw data |
| `materialQuery` (effects/effect/material/serialized/render_pipeline/physics_material) | `assetReadContent` file `.mtl` | ❌ Lane C intake: 3x cover 6 IPC ops (facade + registry 3.7.3); 2.4 không có effect/render-pipeline API |
| `buildManage` (5 ops) | — | ❌ 2.4 Build panel không expose qua bridge |
| `editorQuery has_script` | — | ⚠️ Lane C intake: 3x kiểm tra component class có script hay không qua `scene/query-component-has-script`; 2x chưa có message tương đương |
| `cocos-graph` (offline structural oracle) | — | ❌ v3 có bộ chỉ mục cấu trúc offline T0/T1 (`.cocos-graph/<namespace>/<bundle>/graph.json`, composite handles `{file, nodeUuid}`, writer locking, staleness tracking); 2.4 chưa có |

## Chỉ v2 có (37) — v3 dùng gì thay

| v2 tool | v3 thay thế | |
|---|---|---|
| `assetCreateFolder` | `assetCreate {folder}` | ✅ |
| `assetDelete` · `assetMove` · `assetRefresh` | `assetOperate delete/move/refresh` | ✅ |
| `assetWriteContent` | `assetSaveContent` | ✅ |
| `assetGetPreview` · `editorGetScenePreview` | `previewManage asset_preview` / `scene_preview` | ✅ |
| `previewGetUrl` · `previewOpenInBrowser` | `previewManage get_url` / `open_browser` | ✅ |
| `programGetInfo` · `programOpen` · `urlOpen` | `programManage get_info/open/open_url` | ✅ `open`→`execute`, `open_url`→`execFile` http(s) (3.7.3 không có `open-program`/`open-url`) |
| `editorListTypes` | `editorQuery creatable_assets/asset_types/importers` | ✅ |
| `editorOperate` | `sceneManage save` + `assetOperate refresh` | ✅ |
| `editorUndo` | `editorHistory` | ✅ |
| `componentQuery` | `nodeComponentsGet` + `listComponentClasses` + `findNodesByAsset` | ✅ |
| `nodeQuery` | `nodeGetTree` + `nodeGetAtPath` + `inspectorGet` + `listComponentMethods` | ✅ |
| `sceneSnapshot` | `nodeGetTree` (transform/size/components) | ✅ |
| `nodeSetProperty` · `nodeSetPropertyUndo` · `sceneSetPropertyHL` | `inspectorSet` — write 3.x undo-aware native qua `snapshot` | ✅ |
| `sceneCreateNodeHL` | `nodeCreate` | ✅ |
| `nodeRemove` · `nodeMove` · `nodeDuplicate` | `nodeOperate delete/move/copy` | ✅ |
| `prefabSync` | `nodeOperate apply_prefab` | ✅ |
| `sceneOpen` · `sceneInfo` | `sceneManage open` · `sceneGetInfo` | ✅ |
| `projectGetConfig` | `projectManage get` | ✅ |
| `assetResolve` core (uuid/url/fspath/exists) | `assetResolvePath` | ✅ |
| `assetResolve mount_info` | `assetDbQuery databases/db_info` | ✅ |
| `assetResolve` is_sub_asset/contains_sub_assets/relative_path/backup_path | — | ✅ `assetResolvePath` +4 fields (2026-08-28 — G1) |
| `batchSetProperties` (multi-node) | `nodeBatchSet` (batch write) + `sceneBatchGet` (batch read, M2) | ✅ |
| `sceneNew` | `assetCreate {scene}` + `sceneManage open` | ❌ 3.7.3 không có `new-scene` (probe 2026-08-28: `Message does not exist: scene - new-scene`, registry 0/191) |
| `assetSaveMeta` | `assetOperate save_meta` (+ `assetDbQuery meta` để đọc trước) | ✅ |
| `projectSaveConfig` | `projectManage set` → báo `unsupported` | ❌ 3.7.3 không có `project:set-config` (v2 mạnh hơn) |
| `assetExchangeUuid` | — | ❌ không có msg `exchange-uuid` trong 416 msg 3.7.3 |
| `sceneScript` (gọi bất kỳ scene-script handler) | `callComponentMethod` (chỉ component method) | ⚠️ escape hatch v2-only, cố ý |
| `probeSceneIpc` (probe 14 `scene:*`) | — | ✅ N/A by design — chẩn đoán v2, gate đã đóng |

## Gap thật — việc còn lại

| # | Thiếu ở | Mục | Nguyên nhân | Hướng |
|---|---|---|---|---|
| 1 | ~~v3~~ | ~~`assetSaveMeta`~~ | — | ✅ **XONG** — `assetOperate save_meta` + `assetDbQuery meta` (read-modify-write) |
| 2 | v3 | `projectManage set` | 3.7.3 không có `project:set-config` | giữ `unsupported` — map bừa = ghi sai key im lặng |
| 3 | v3 | `assetExchangeUuid` | không có message | không port |
| 4 | v3 | `editorSelect` set_context/patch/filter/confirm/cancel | module `selection` 3.7 không có | backlog, mở khi agent cần |
| 5 | ~~v3~~ | ~~`assetResolve` 4 op phụ~~ | — | ✅ **XONG** — `assetResolvePath` +`isSubAsset/containsSubAssets/relativePath/backupPath` (G1, 2026-08-28) |
| 6 | v2 | `editorViewport` | `scene:change-gizmo-*` timeout | chặn cứng |
| 7 | v2 | `nodeOperate` lock + prefab ops | `scene:*` prefab IPC timeout | chặn cứng |
| 8 | v2 | `buildManage` · `materialQuery` | 2.4 không có API | N/A vĩnh viễn |
| 9 | v2 | `editorQuery` 7 ops · `animation*` 10 ops · `sceneManage` save_as/close/soft_reload · `propertyArrayElement` · `findNodesWithMissingAssets` · `assetCreate` typed | chưa port, có đường làm | ledger P2 — ưu tiên `editorQuery` + `animation*` |
| 10 | ~~v3~~ | ~~`sceneNew`~~ | — | ✅ **Chốt NOT-EXPOSED** — probe live 2026-08-28 `scene - new-scene` = "Message does not exist"; giữ workaround `assetCreate {scene}`+`sceneManage open` |
| 11 | ~~v3~~ | ~~`find_nodes` by name/component~~ | — | ✅ **XONG** — tool `findNodes` (G3, 2026-08-28), walk `nodeGetTree` in-memory |

## Chốt

Không bản nào là superset:

- **v3 mạnh:** inspector (get/set/gen d.ts runtime), viewport/gizmo, build, material/effect/render-pipeline, prefab ops đầy đủ, animation 10+8 ops, `assetCreate` 16 kiểu.
- **v2 mạnh:** asset-db sync (`assetResolve` 10 ops, `exchangeUuid`), `projectSaveConfig`, escape hatch `sceneScript`. Gap `batchSetProperties` multi-node đã đóng — v3 `nodeBatchSet`/`sceneBatchGet` ✅.

Chênh lệch còn lại **toàn bộ là engine limit hai chiều**, không phải nợ code — mục #1 (`assetSaveMeta`) đã đóng.

**Menu + 7 handler extension:** đã parity từ `416fcb1` — 2 top-level (`Configuration` · `About`) + `Debug` 5 con; `About` gộp port/config/url + build info; `show-info` giữ làm alias.
