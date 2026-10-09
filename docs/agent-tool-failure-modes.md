# Lớp lỗi của tool viết cho agent — phân tích từ 7 bug 3.7.3

**Ngày:** 2026-08-06 · **Branch:** `cc-3x7` · **Bằng chứng:** editor thật (Creator 3.7.3, PID 48640), build `cb73726`

Doc này trả lời câu **"vì sao nhóm bug này xảy ra"**, không phải "bug nào ở đâu".
Danh sách drift theo message → `cocos-3x7-api-drift.md`. Kết quả từng lượt test → `plans/reports/verifier-*`.

---

## 1. Phát hiện chính: nửa số bug là **silent failure**

7 bug tìm được khi test 3.7.3. Phân theo *cách chúng biểu hiện*, không theo tool:

```
LOUD  (throw / HTTP 500)          4   ← ai chạy cũng thấy ngay
SILENT (trả "thành công" sai)     3   ← chỉ lộ khi soi giá trị trả về
```

| Bug | Loại | Client nhận được gì |
|---|---|---|
| `assetGetPreview` `Panel.openBeside` | LOUD | HTTP 500 |
| `assetOperate` không nhận uuid | LOUD | `must begin with db://` |
| `inspectorSetSettingsProperties` param | LOUD | `paths and values are required` |
| `programOpen`/`urlOpen` message thiếu | LOUD | `Message does not exist` |
| **`captureScreenshot` canvas 0×0** | **SILENT** | `{type:"image", mimeType:"image/jpeg", data:"data:,"}` |
| **`nodeGetTree` prefab-edit wrapper** | **SILENT** | cây node hợp lệ — nhưng của node sai |
| **`nodeComponentsGet` mất `type`** | **SILENT** | `{id:"...", type:undefined}` |

### Vì sao silent nguy hiểm hơn với agent

Người dùng nhìn ảnh rỗng thì biết ngay. Agent nhận

```json
{"type":"image","mimeType":"image/jpeg","data":"data:,"}
```

thấy đủ 3 field đúng schema → tin, báo "đã chụp scene", đi tiếp. Không exception nào để bắt, lỗi lan xuống downstream.

**Agent không có trực giác sanity-check.** Nó không "thấy" ảnh rỗng, không thấy prefab đáng lẽ phải có 5 con. Nó chỉ có cấu trúc trả về. Nếu cấu trúc hợp lệ, nó tin.

> **Nguyên tắc: tool cho agent phải fail loud. Trả sai còn tệ hơn ném lỗi.**
> Nguyên tắc này đã có tiền lệ trong repo: `projectSetConfig` chọn **báo unsupported** thay vì map bừa sang `change-script-config` (`4832cf1`). Cùng logic, mở rộng ra cả tầng trả về.

### `nodeGetTree` — silent failure tốn nguyên một chẩn đoán sai

Bug report gốc ghi *"create_prefab serialize sai, root = New Node, mất hết component"*. Đọc file `.prefab` trên đĩa:

```
ZZProbe.prefab (9 entries)
1 cc.Node "ZZProbe"  children=1  comps=2   ← đúng hết
2 cc.Node "ZZChild"
```

Prefab **luôn đúng**. Cái sai là `nodeGetTree`: ở prefab-edit mode, editor bọc prefab trong scene tạm

```
New Node                     ← wrapper ảo, query-node không resolve được
└── should_hide_in_hierarchy ← Canvas locked
    └── ZZProbe              ← root thật
        └── ZZChild
```

Tester gọi `nodeGetTree` sau `open_prefab`, thấy `"New Node"` rỗng, kết luận serialization hỏng.

**Bài học:** một tool đọc trả dữ liệu sai làm hỏng chẩn đoán của **tool khác**. Bug bị quy cho `create_prefab` — nơi không có bug nào. Silent failure không chỉ giấu chính nó, nó còn vu oan cho hàng xóm.

Fix không dò theo tên `should_hide_in_hierarchy` (tên sinh runtime, không phải hằng số) mà theo cấu trúc: node nào có `__prefab__.rootUuid === uuid chính nó` và `assetUuid === asset đang mở`.

---

## 2. Nguồn gốc chung: `??` nuốt lỗi ở biên

3 bug silent + 1 bug tôi tự tìm đều cùng một hình dạng — **default value cho input sai**:

```ts
// captureScreenshot: 256 (number) thay vì {width,height}
root.resize(imageSize.width, imageSize.height)   // undefined → canvas 0×0 → "data:,"

// assetOperate: guard không bao giờ chạy
args.targetAssetPath = normalizePath(args.targetAssetPath)  // undefined → 'db://assets'
if (!args.targetAssetPath) throw ...                        // ← chết ở đây, luôn truthy
// hệ quả: move thiếu target = âm thầm move về assets root

// assetOperate return
{ id: result?.uuid ?? '' }   // op không trả AssetInfo → reference rỗng, không phải lỗi
```

Mẫu: **`?? default` ở chỗ đáng lẽ phải `throw`.** Default hợp lý khi thiếu *optional*; sai khi input *bắt buộc* mà sai kiểu.

Sửa: validate ở nguồn (`captureScreenshot` reject size không dương), và verify ở đầu ra (`data.startsWith('/9j/')` — JPEG base64 luôn bắt đầu bằng `/9j/`).

### Chỗ nên quét tiếp

Chưa audit hết. Pattern cần soi trong `source/utcp/tools/`:

- `?? ''` / `?? []` / `?? {}` trên giá trị **bắt buộc**
- `catch {}` nuốt lỗi rồi đi tiếp
- normalize/default chạy **trước** guard bắt buộc
- tool trả `{success:true}` mà không kiểm tra kết quả thật

<!-- §2-audited -->
**Đã audit 2026-09-04** (`feat/ccb3x-fail-loud-smoke`, `plans/260904-fail-loud-smoke/`):
quét toàn bộ `source/utcp/tools/` theo 4 mẫu trên. Kết quả: 0 `catch {}` rỗng còn lại
(best-effort/probe gắn comment chủ ý); false-success bịt ở `set-property`,
`restore-prefab`, `move-array-element`, `add-task`, `animation-operation`,
`validateScene` diagnostics; payload nullish không còn đọc là “rỗng mà khoẻ”
(`query-nodes-miss-assets`, `query-component-function-of-node`, `editorListTypes`,
layers, `scene_mode`, `script_info`, `editorGetLogs`); ảnh verify magic bytes
(`/9j/`, `iVBORw0KGgo`); `simulateKeyCombo` reject input sai thay vì echo success;
prediction “does not exist” neo qua `utils/editor-message-error.ts`.
Guard hồi quy: `tests/unit/fail-loud-contract.test.js` + tier 4 `scripts/smoke-utcp.js`.

---

## 3. Regression tôi tự gây: `build_info` giết cả 61 tool

Ghi lại vì cách nó thoát mọi lớp kiểm tra đáng học hơn bản thân bug.

**Ý định:** deployed `dist/` cũ hơn HEAD nhìn y hệt bản mới — đã tốn một vòng test (bug file trên build cũ hơn fix). Nên stamp commit hash vào `dist/build-info.json`, rồi phơi ra ở 2 chỗ: log khởi động + manual `/utcp`.

**Sai:** nhét field lạ vào manual.

```
register_manual → errors: ["unrecognized_keys: ['build_info']"]  →  tools: []
```

UTCP SDK validate manual bằng **strict schema**. Không phải bỏ qua field lạ, cũng không phải degrade một phần — **reject sạch 61 tool**. Code-mode MCP vô dụng hoàn toàn.

Giả định sai của tôi: *"client không biết field thì bỏ qua"*. Đúng với JSON nói chung, sai với schema strict.

**Vì sao lọt qua hết:**

| Lớp kiểm tra | Kết quả | Vì sao mù |
|---|---|---|
| `tsc --noEmit` | ✅ pass | ép kiểu `(manual as any)` — chính tôi tắt đèn |
| `npm run build` | ✅ pass | tsc không biết runtime schema |
| `curl /utcp` | ✅ JSON hợp lệ | strict schema nằm ở **client**, không phải server |
| Test tool qua MCP | ✅ pass | manual **đã register từ trước**, còn cache |

Cả 4 lớp đều xanh. Chỉ lộ khi editor restart → cache mất → register lại → chết.

**Bài học:** test đường *register*, không chỉ đường *gọi*. Tool gọi được không chứng minh manual hợp lệ — client cache che mất. Đây là loại lỗi chỉ xuất hiện ở **lần khởi động sạch đầu tiên**, tức là ở máy người khác.

Fix `fbdfd64`: bỏ khỏi manual, giữ `GET /build-info` riêng. Kèm comment cảnh báo tại chỗ để người sau không thêm field vào manual lần nữa.

---

## 4. Kỷ luật verify — rút từ 2 lần kết luận vội của tôi

### Lần 1: kết luận trên build cũ

Test `imageSize: 256` sau khi deploy, thấy throw → báo "fix hoạt động". **Sai một nửa.** Lúc đó Cocos mới reload *scene script*, còn *tool module* vẫn cache bản cũ. Cái tôi thấy throw là validate ở `scene.ts`; tầng tool normalize `256` → `{256,256}` chưa chạy.

Sau khi editor restart thật: `imageSize: 256` trả **JPEG thật** (đúng thiết kế — nhận shorthand), chỉ `{0,0}` mới throw. Tôi đã báo cáo sai vì kết luận trên bằng chứng nửa vời.

### Lần 2: tưởng đã restart

Poll `/build-info` 20 lần, vẫn 404. Kiểm process mới thấy port 57025 do **PID cũ** giữ — instance mới đã mở nhưng instance cũ chưa chết, và cái cũ giữ port.

```powershell
Get-NetTCPConnection -LocalPort 57025 -State Listen   # → OwningProcess
```

### Quy tắc

1. **Xác định build đang chạy trước khi test.** `curl /build-info` → so với `git rev-parse --short HEAD`.
2. **Cocos reload theo tầng, không đồng bộ.** Scene script reload khi đổi scene; tool module chỉ reload khi restart process. Sửa 2 tầng thì phải restart, không disable/enable extension là đủ.
3. **Kiểm PID giữ port, không kiểm "có process mới không".** Nhiều instance cùng tồn tại; cái cũ giữ port.
4. **Không test file đã sửa trên build cũ hơn.** Chia kết quả thành "file đã động" / "file không động" như smoke report `260806-1520` đã làm.

---

## 5. Đề xuất: smoke suite chạy qua HTTP

Bằng chứng ủng hộ chính là §3 — một thay đổi typecheck sạch, curl sạch, giết toàn bộ tool surface, và **không lớp nào bắt được**.

UTCP server là HTTP → test không cần automation UI editor. Một file Node là đủ.

**Phải bao 2 tầng, tầng 1 là tầng tôi bỏ sót:**

```js
// 1. Manual hợp lệ — bắt được bug build_info
const m = await fetch('/utcp').then(r => r.json())
assert.deepEqual(Object.keys(m).sort(), ['manual_version','tools','utcp_version'])
assert(m.tools.length === 61)

// 2. Shape từng tool — bắt được silent failure
assert(preview.data.startsWith('/9j/'))            // không phải "data:,"
assert(comps.references.every(r => r.type))        // không undefined
assert(tree.name !== 'New Node')                   // không phải wrapper
```

Điểm mấu chốt: **assert shape, không assert "không throw"**. `data.startsWith('/9j/')` là thứ vừa bắt `captureScreenshot`; assert "không throw" thì bug đó sống sót vì nó *có* trả về thành công.

Suite này unblock việc khác: port fix sang branch mới → chạy suite thay vì test tay 61 tool; và stale build lộ ngay ở assert `/build-info`.

Ước lượng ~200 LOC, không framework, không fixture. Chạy sau mỗi lần restart editor.

<!-- §5-built -->
**Đã dựng 2026-09-04** (`feat/ccb3x-fail-loud-smoke`, `plans/260904-fail-loud-smoke/`): cả 2 tầng
trên nằm trong `scripts/smoke-utcp.js` (tier manual + tier fail-loud typed-body) kèm stale-build
assert `/build-info` vs `git rev-parse --short HEAD`; guard chạy CI:
`tests/unit/fail-loud-contract.test.js`.

---

## 6. Ghi chú về surface

61 tool, trong đó `editorOperate save_as` mở file dialog blocking (treo agent headless), `programOpen`, `urlOpen`. Đây là hình dạng của "cover hết API surface", không phải "cover cái agent cần".

Trong khi đó `captureScreenshot` — tool agent thực sự dùng — ship JPEG rỗng và không ai biết, vì chưa từng chạy thật.

Quan sát, không phải khuyến nghị cắt: **breadth không thay được depth**. 3 con số cạnh nhau:

```
cc-2x     9 tool  →  34/34 pass    (đã runtime test)
cc-3x7   61 tool  →   7 bug/49     (đang runtime test)
custom   59 tool  →   0 test       (8 fix vừa port, chưa chạy lần nào trên 3.8.x)
```

Cái phân biệt chất lượng không phải version editor — mà là **đã chạy thật hay chưa**. Theo tỷ lệ 14% của `cc-3x7`, `custom` còn khoảng 8 bug chưa lộ.

---

## Trạng thái verify (2026-08-06 18:xx, build `cb73726`)

| Bug | Bằng chứng runtime |
|---|---|
| `nodeGetTree` prefab-edit | mở `DemoReel.prefab` → root `DemoReel`, comps `["cc.UITransform","DemoReel"]` |
| `assetOperate` uuid | `refresh` bằng uuid → OK, echo `cc.SceneAsset` |
| `assetGetTree` | `db://assets/` → OK (bug gốc là build cũ, không tái hiện) |
| `captureScreenshot` | `{0,0}` → throw · hợp lệ → `/9j/` |
| `inspectorSetSettingsProperties` | `{propertyPath, value}` → `{success:true}` |
| `nodeComponentsGet` type | `["cc.UITransform","cc.Sprite","SettingsUI"]` — user script resolve đúng |
| manual sau `fbdfd64` | 3 key, register lại 61 tool |


## 7. Typed recovery errors — agent cần biết cách thoát lỗi

Hai lỗi runtime 2026-09-01 cho thấy fail-loud chỉ là nửa contract:

| Tool | Input/runtime state | Trước fix | Recovery đúng |
|---|---|---|---|
| `readPrefabJson` | `.scene` / `cc.SceneAsset` | `not a prefab` string | `sceneSnapshot`, `nodeGetTree`, hoặc `inspectorGet` |
| `projectManage({ operation: 'set' })` | Creator 3.7 không có `project/set-config` | stack + message dài | chỉnh `settings/v2/packages/*.json`; chỉ dùng IPC write trên Creator 3.8 sau live verify |
| `nodeGetTree` | Node UUID không thuộc scene đang mở (hoặc trong prefab đóng) | generic 500 "Node tree not found for ..." | `TARGET_NOT_FOUND` (404): kiểm tra `sceneGetInfo`, chuyển scene qua `sceneOpen`, hoặc đọc offline qua `readPrefabJson` / `cocos-graph navigate` |
| `nodeGetTree` | Truyền nhầm composite handle (`file#uuid`) từ cache | 500 không tìm thấy | `COMPOSITE_HANDLE_NOT_SUPPORTED` (400): tách `file` và truyền bare engine UUID |
Agent không nên parse stack trace hay suy luận từ English message. CCP trả lỗi domain có shape ổn định:

```json
{
  "error": "readPrefabJson accepts cc.Prefab; received cc.SceneAsset.",
  "code": "ASSET_TYPE_MISMATCH",
  "details": {
    "assetPath": "db://.../g9664H.scene",
    "expectedTypes": ["cc.Prefab"],
    "actualType": "cc.SceneAsset"
  },
  "recovery": "Use sceneSnapshot, nodeGetTree, or inspectorGet for a scene."
}
```

```json
{
  "error": "Node tree not found for node \"c8iLDUCc9N4asmC+1q87Xn\" in the currently open scene.",
  "code": "TARGET_NOT_FOUND",
  "details": {
    "requestedId": "c8iLDUCc9N4asmC+1q87Xn",
    "currentSceneUuid": "9a1fafde-45df-4d82-9cd1-7f55dc30dcf8"
  },
  "recovery": "The node may belong to an unopened prefab or a different scene file. (1) Call sceneGetInfo to check the active scene. (2) If it belongs to another scene, call sceneOpen. (3) If it is inside an offline prefab, use readPrefabJson or offline cocos-graph navigate instead of live nodeGetTree."
}
```

`error` vẫn là string để HTTP/Code Mode client cũ hiển thị được; `code`, `details`, `recovery` là machine-readable context cho MCP/agent report và chọn đường thay thế. Expected caller/capability errors dùng HTTP `422`; invalid schema input dùng `400`; lỗi không phân loại trả `500` với `{ "error": "Internal tool error.", "code": "INTERNAL_ERROR" }` để không leak implementation detail.

**Rule:** tool chỉ ném `ToolError` khi biết chính xác error class, input/resource state, và recovery. Không wrap error mơ hồ thành một code giả. Generic Cocos/extension failure vẫn cần full console/debug log để người vận hành điều tra.

**Follow-up:** support `project/set-config` cho Creator 3.8 được queue tại master plan `Cocos 3.8 Project Config Support`; không giả lập bằng filesystem write ở 3.7 vì import/serialization phải do editor sở hữu.

---

## Unresolved

1. **`assetGetPreview` cho prefab vẫn hỏng.** `openBeside` đã fix nhưng lộ tầng sâu hơn:
   `Channel does not exist: scene:prefab-preview`. `panels/preview/index.ts` dựa vào
   `Editor._Module.require('PreviewExtends')` + `scene:prefab-preview` / `query-prefab-preview-data`
   — cụm này là API **3.8-only**. Ảnh qua `sharp` (texture/sprite-frame) vẫn chạy.
   Cần quyết: port sang API preview 3.7.3, hay bỏ preview prefab/material/mesh ở branch này?
2. ~~**Fail-loud audit chưa chạy.**~~ ✅ Đã quét xong 2026-09-04 + sửa + guard —
   xem ghi chú §2; `tests/unit/fail-loud-contract.test.js`.
3. ~~**Smoke suite chưa viết.**~~ ✅ `scripts/smoke-utcp.js` thêm stale-build assert
   (§4 rule 1, so `/build-info` với `git rev-parse --short HEAD`) + tier fail-loud (§5).
4. **`custom` có 8 fix nhưng chưa runtime-test trên 3.8.x** — cùng loại rủi ro đã tạo ra
   nhóm bug này ngay từ đầu.
5. **`origin` = `rex-dtx/cocos-code-mode`, repo người khác.** Cả 3 branch đang push lên đó.
   Nếu không chủ ý → fork riêng + `remote set-url` trước khi push thêm. Câu này tồn qua 2 card chưa ai trả lời.
