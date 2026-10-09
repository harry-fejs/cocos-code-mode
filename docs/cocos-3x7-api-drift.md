# 3.7.3 API drift — kết quả điều tra

Nguồn: registry `builtin/*/package.json` + i18n `doc:` block của **chính bản 3.7.3**
(`G:\_ws\app.asar.unpacked`, version 3.7.3), đối chiếu typed `@cocos/creator-types@3.8.7`.

Dump đầy đủ: `cc-3x7-message-registry.json` (20 module, 416 message, 60 có param spec).
Regenerate: `python G:\_ws\_helpers\extract-module-messages.py --json <out.json> <module...>`

⚠️ **npm không có `@cocos/creator-types` < 3.8.0** (`dist-tags.latest = 3.8.7`, danh sách versions
bắt đầu từ 3.8.x). Nên typed `.d.ts` đang dùng **mô tả 3.8.7, không phải 3.7.3** — mọi type ở đó
là giả định cho tới khi verify. Handler `.ccc` mã hoá, không đọc được. i18n `doc:` block là
nguồn signature machine-readable duy nhất cho 3.7.x.

**Doc này = drift theo message + chiến lược branch.** Phân tích *lớp lỗi* (silent failure, `??`
nuốt lỗi, kỷ luật verify, regression `build_info`) nằm ở `agent-tool-failure-modes.md`.

---

## Coverage: 128/132 message dùng bởi 61 tool CÓ ở 3.7.3

⚠️ Bản đầu của doc này ghi **112/117 / 59 tool** — **sai**. Đo lại 2026-08-06 bằng
`grep` 2-literal `Editor.Message.request` + đối chiếu registry:

| Module | Dùng | Có ở 3.7.3 | Thiếu |
|---|---|---|---|
| scene | 95 | 95 | 0 |
| asset-db | 24 | 23 | 1 |
| builder | 5 | 5 | 0 |
| program | 3 | 1 | 2 |
| preview | 2 | 2 | 0 |
| project | 2 | 1 | 1 |
| engine | 1 | 1 | 0 |
| **tổng** | **132** | **128** | **4** |

Con số cũ sót vì đếm trước khi thêm `materialQuery`/`assetDbQuery`/`has_script`, và
`scene/query-uuid` khi đó còn bị tính là "thiếu" (thực ra là bug sẵn có, xem §2b).

Tin tốt: phần lớn tool surface dùng được. Vấn đề nằm ở **signature**, không phải message vắng mặt.

---

## 1. Signature drift — nguy hiểm nhất (fail im lặng hoặc `parameter error`)

Đã xác nhận từ i18n doc 3.7.3:

| Message | 3.7.3 | 3.8.x (code đang theo) | Hệ quả |
|---|---|---|---|
| `asset-db/query-assets` | `pattern?` **{string}** | `options?` **{QueryAssetsOption}** | ❗ `parameter error` code -1 |
| `asset-db/query-asset-info` | `urlOrUUID` | `urlOrUUIDOrPath` | path không resolve được |
| `asset-db/query-uuid` | `url` (chỉ url) | `string` (url\|path) | path không resolve được |

**`query-assets` chính là bug `assetGetTree` a báo** — stack trỏ `query.ccc:1:5648`, do
`asset-tools.ts` truyền `{pattern}` object mà 3.7.3 mong string.

Fix đã có ở branch `custom` commit `ec50962` (`queryAssetsCompat`: try object → catch → string,
kèm re-filter client-side vì fallback làm mất ccType/importer/extname/isBundle).

⚠️ **Chỉ 60/416 message có param doc** → 356 message còn lại signature vẫn là ẩn số. Không thể
kết luận "chỉ 3 cái drift" — chỉ có thể nói "3 cái drift trong số đã kiểm chứng được".

## 2. Message vắng mặt hẳn ở 3.7.3 (5) — ✅ ĐÃ XỬ LÝ HẾT

Cả 4 cái còn lại đã **verify runtime** trên Creator 3.7.3 thật (project
`cc-fws\cc30-new-all-in-one`, 2026-08-06) rồi mới sửa — không suy đoán từ registry.

| Module | Message | Tool ảnh hưởng | Trạng thái |
|---|---|---|---|
| `asset-db` | `query-asset-thumbnail` | `assetGetPreview` (mesh/gltf branch) | ⏳ Chưa verify được — server live lúc test còn chạy build cũ (không có `/build-info`). Đã có fallback renderer-based ngay dưới nhánh này |
| `program` | `open-program` | `programOpen` | ✅ **FIX** `4832cf1` — map sang `execute`. Doc block 3.7.3 khai đúng 2 param `program {string}` + `args {Record<string,any>}` → match có tài liệu, không phải đoán |
| `program` | `open-url` | `urlOpen` | ✅ **FIX** `4832cf1` — fallback `execFile` (không `exec`, không shell), chặn scheme ngoài http(s) vì URL thành command argument |
| `project` | `set-config` | `projectSetConfig` | ✅ **UPDATE 2026-09-04** (`feat/ccp3x-consolidated` / `0483c4f`) — triển khai probe `probeProjectSetConfigCapability()`: trên 3.8 gọi IPC `Editor.Message.request('project','set-config','project', dotPath, value)`; trên 3.7 dùng `isMessageNotExposed` bắt đúng lỗi `Message does not exist: project - set-config` và trả về typed `ToolError` HTTP 422 `UNSUPPORTED_EDITOR_API` kèm recovery guidance sửa file `settings/v2/packages/*.json` trực tiếp; tuyệt đối không dùng filesystem fallback để tránh race. |
| `scene` | `query-uuid` | `nodeOperate` (sibling index) | ✅ **ĐÃ FIX** — xem §2b |

**Lỗi runtime thật đã ghi nhận** (trước khi fix):
```
Message does not exist: program - open-url
Message does not exist: program - open-program
Message does not exist: project - set-config
```

**Vì sao KHÔNG map fake `project/set-config`:** 3.7.3 có `change-script-config` / `import-config` /
`export-config`, nhưng **không cái nào ghi một dotted path đơn lẻ** — cái đầu chỉ đụng script
settings, hai cái sau chuyển cả file. Map bừa = ghi sai key **im lặng**, nguy hiểm hơn là báo lỗi.
Nguyên tắc đã chốt: **fail-loud > map sai**. Đọc vẫn OK (`projectManage get` verify chạy tốt).
Từ 2026-09-04, CCP nâng cấp cơ chế: probe IPC capability khi khởi động/gọi hàm; nếu là Creator 3.8.x thì dùng IPC chuẩn `(project, dotPath, value)`, còn trên Creator 3.7.x thì trả HTTP 422 `UNSUPPORTED_EDITOR_API` kèm recovery action rõ ràng cho Agent.
## 2b. `scene/query-uuid` — bug sẵn có, KHÔNG phải drift

Message này **không tồn tại ở cả 3.7.3 lẫn 3.8.7** (grep typed `scene/@types/message.d.ts` = 0 hit).
Nó nằm ở nhánh fallback của `SceneTools.getParent` — tức mọi lần node không có `parent` ghi nhận
(node nằm thẳng dưới scene root) thì hàm này **luôn throw**, trên mọi version. Không ai phát hiện
vì nhánh đó hiếm khi chạy.

Fix: dùng `scene/query-current-scene` (có ở 3.7.3, và chính file này đã dùng ở `scene-tools.ts:58`).
Shape đa dạng theo version — string uuid hoặc object `{uuid,url,name}` — xử lý cả hai.

Ảnh hưởng: `getParent` → `setSiblingIndex` + `getParentAndSiblingIndex` → `nodeOperate`.

---

## 3. Việc tiếp theo

Runtime test **ĐÃ CHẠY** 2026-08-06 trên Creator 3.7.3 thật — project
`G:\_ws\cc-fws\cc30-new-all-in-one` (KHÔNG phải `AI_CC_Test` như dự định ban đầu).
Kết quả: `plans/reports/verifier-260806-1520-3x7-smoke.md`.

| Việc | Trạng thái |
|---|---|
| Smoke 61 tool | ✅ phần lớn PASS. `materialQuery` / `assetDbQuery` / `has_script` / `assetGetTree` / `assetQuery` đều chạy đúng trên 3.7.3 |
| 4 message thiếu | ✅ 3 fix (`4832cf1`), 1 (`query-asset-thumbnail`) chưa verify được |
| `@types/editor-3x7.d.ts` | ❌ **KHÔNG cần** — chỉ 3 message lệch signature, dưới ngưỡng đáng viết 400 LOC typings. Compat helper try-catch rẻ hơn nhiều |
| Port fix ngược `custom` | ✅ 8/8 (`6c498c9` + `18b3794`) |

**Còn chặn:** editor chưa reload nên nhóm file đã sửa (`asset-tools`, `scene-tools`,
`component-tools`, `editor-tools`, `set-properties-tool`, `utcp-server`) chưa test lại được.
`GET /build-info` là cách xác nhận build nào đang trả lời — 404 = process cũ.

**Đừng file bug khi `/build-info` trả 404.** Bài học đã tốn 1 lượt test: bug được file trên build
tạo ra TRƯỚC khi fix landed, hoá ra là bug đã không còn tồn tại trong source.

---

## 4. Khảo sát message chưa wrap (2026-08-06) → +2 tool, +1 operation

Quét toàn bộ 416 message, trừ 117 message đã dùng:
- **20 public** chưa wrap — phần lớn là broadcast (`asset-db:ready`, `scene:close`…) và UI panel
  (`open-settings`, `open-devtools`)
- **238 non-public, non-broadcast** chưa wrap

Đã thêm (đều read-only, verify có ở registry 3.7.3, signature từ facade):

| Tool / op | Message | Nguồn signature |
|---|---|---|
| `materialQuery` (5 op) | `scene/query-all-effects`, `query-effect`, `query-material`, `query-serialized-material`, `query-render-pipeline` | facade `general-scene-facade.d.ts:139-142` |
| `assetDbQuery` (4 op) | `asset-db/query-db-list`, `is-busy`, `query-asset-mtime`, `query-asset-data` | registry (không typed, không facade) |
| `editorIntrospect` +`has_script` | `scene/query-component-has-script` | typed **+** facade `:76` — hiếm, có cả hai |

**Giá trị nổi bật:** `assetDbQuery busy` cho biết db có đang import dở không — mảnh còn thiếu khi
asset query ngay sau `refresh` trả kết quả cũ. `has_script` chặn typo class name trước khi
`addComponent`/`callComponentMethod` nổ runtime.

### Đã cân nhắc và BỎ (ghi lại để khỏi quét lại)

| Ứng viên | Lý do bỏ |
|---|---|
| `project/query-design-resolution` | Trùng — `projectGetConfig` đã đọc được qua `general.designResolution` |
| `scene/apply-removed-component`, `revert-removed-component` | **Không có facade, không typed** → không có signature đáng tin. Nguyên tắc: không đoán API |
| `scene/set-node-and-children-layer` | Facade nhận `SetPropertyOptions` nhưng không tìm thấy định nghĩa interface đó |
| `scene/getdata-prefab`, `unlink-prefab`, `apply-prefab` | `nodeOperate` đã bao create/link/revert/apply/unwrap/open |
| `messages/*`, `shortcuts/*`, `preferences/*` | Panel-bound / IDE UI, agent không dùng |
| `preview/*` (11 msg) | Panel-bound; `previewGetUrl`/`previewOpenInBrowser` đã đủ |
| `scene/quit-editor`, `unit-test`, `native-*` | Nguy hiểm hoặc internal |
| `builder/*` (29 msg) | Build pipeline đã có 5 tool; còn lại là worker-internal |
| `animator` (24), `animation-graph` (8) | Panel-bound, cần UI state. Animation **editing** ở module `scene` đã wrap ở b8 |

**Kết luận: tool surface đã bão hoà.** Còn ~230 message nhưng gần như toàn bộ là panel-bound,
internal, hoặc trùng chức năng. Batch sau nên chờ feedback runtime, đừng quét registry tiếp.

## 5. Chiến lược branch — ✅ ĐÃ CHỐT: **(a) branch độc lập, phát triển song song**

**Quyết định 2026-08-06.** Lý do chốt: **mỗi editor version có thể cần dependency khác nhau** —
và điều này **đã xảy ra**, không phải giả thuyết.

### Bằng chứng: deps 3 branch đã phân kỳ thật

```
                  @types/node   express    sharp     archiver   creator-types
cc-2x  (2.4.15)   ^14.18.63     ^4.21.2    ^0.30.7   ^7.0.1     (BỎ HẲN)
cc-3x7 (3.7.3)    ^18.17.1       4.21.2     0.30.7   ^8.0.0     ^3.8.7
custom (3.8.x)    ^18.17.1       4.21.2     0.30.7   ^8.0.0     ^3.8.7
                  ▲                                  ▲          ▲
                  └─ Node 14 vs 18 ─────────────────┴──────────┴─ 4 deps lệch
```

`cc-2x` buộc phải hạ **4 dependency** vì Electron 13 / Node 14 của 2.4.15: `@types/node` 18→14,
`archiver` 8→7, và **bỏ hẳn `@cocos/creator-types`** (npm không có bản < 3.8.0) — kèm phải xoá
`scripts/preinstall.js` vì script đó crash khi thiếu key đó trong `devDependencies`.

Đây là **precedent đã tồn tại trong chính repo này**: version editor khác ⇒ runtime khác ⇒
dependency graph khác. Một `package.json` không diễn tả được hai runtime.

### Vì sao (b) — gộp 1 branch — SAI, dù code đang đồng dạng

Phân tích ban đầu của tôi chỉ nhìn **application code** và thấy:
cherry-pick 6 file merge sạch 0 conflict; diff còn 7 file, 0 file là bug lệch; `editor: ">=3.7.0"`
là superset của `>=3.8.7`; deps `custom` ↔ `cc-3x7` hiện **trùng khớp** → kết luận "chưa phân kỳ".

**Chỗ sai: đó là ảnh chụp hôm nay, không phải ràng buộc.** Bài học từ `cc-2x` cho thấy khi
version editor đi xa, **runtime đi trước, deps đi theo, code đi sau**. Gộp branch khoá cứng
**một** `package.json` — đúng chỗ mà version-divergence xuất hiện **sớm nhất và cứng nhất**:

| Trục | Gộp branch giải quyết được? |
|---|---|
| Tên/signature message khác nhau | ✅ `try/catch` guard — đã có 5 cái, verified runtime |
| API vắng mặt (`openBeside`) | ✅ `typeof` check |
| `editor` range | ✅ lấy superset `>=3.7.0` |
| **Dependency version khác nhau** | ❌ **KHÔNG** — `package.json` chỉ khai được 1 giá trị/package |
| **Native module theo Electron ABI** (`sharp`) | ❌ **KHÔNG** — prebuilt binary buộc theo Node ABI |

Guard trong code xử lý được drift **API**. Không guard nào xử lý được drift **build/runtime**.

⚠️ Rủi ro cụ thể chưa loại trừ: `sharp 0.30.7` pin cho Electron của 3.7.3 **chưa verify** — nhánh
dùng nó (`assetGetPreview`) đúng là nhánh duy nhất chưa test được. Nếu 3.8.x cần `sharp` bản khác
thì `custom` ↔ `cc-3x7` phân kỳ deps **ngay**, và branch gộp sẽ vỡ ở đúng chỗ khó sửa nhất.

### (a) hoạt động thế nào

```
cc-2x    (2.4.15)  ──► deps riêng (Node 14)      ──► kiến trúc scene-script
cc-3x7   (3.7.3)   ──► deps riêng               ──► message-async
custom   (3.8.x)   ──► deps riêng               ──► message-async
                          │
        bug CHUNG ────────┴──► port tay, verify branch đích có dính không TRƯỚC khi port
```

**Được:** mỗi branch tự do chọn deps/toolchain theo runtime của nó; đổi ở branch này không thể phá
branch kia; test độc lập.
**Mất:** bug chung phải port tay. **Giảm nhẹ bằng kỷ luật, không bằng abstraction** — xem dưới.

### Kỷ luật bắt buộc cho (a) — rút từ B3 hôm nay

B3 (port 8 fix sang `custom`) là mẫu thực tế. Ba quy tắc:

1. **Verify branch đích CÓ dính bug trước khi port.** Không port mù. Hôm nay tôi kiểm và thấy
   `custom` thật sự còn bug `captureScreenshot` (`args.imageSize ?? {...}` → numeric `256` xuống
   canvas 0×0 → `"data:,"`, **JPEG rỗng trông như hợp lệ**). Nếu port mù thì không biết mình vừa
   sửa bug thật hay thêm code chết.
2. **Phân loại fix trước khi port:** bug logic version-agnostic → **port**; compat shim của 1
   version → **KHÔNG port** (vd `program-tools.ts`/`project-tools.ts` chỉ là compat 3.7.x).
3. **Cherry-pick từng commit "sạch"**, đừng pick commit trộn. `9bb44c3` kèm manifest 3.7.x +
   registry nên phải sửa tay `getParent`, không pick được. Ngược lại `35ec127` thuần bug-fix →
   pick sạch 0 conflict.

### Trạng thái đồng bộ hiện tại (2026-08-06)

| Hạng mục | `cc-3x7` | `custom` |
|---|---|---|
| 8 bug fix chung | ✅ | ✅ `6c498c9` + `18b3794` |
| `materialQuery` / `assetDbQuery` (3 tool) | ✅ | ❌ chưa port |
| `has_script` | ✅ | ❌ chưa port |
| build provenance (`/build-info`) | ✅ | ❌ chưa port |
| compat 3.7.x (`program`/`project-tools`) | ✅ | **KHÔNG port** (đúng ý đồ) |

4 hạng mục "chưa port" là **feature**, không phải bug → port khi nào cần 3.8.x, không gấp.
⚠️ **8 fix trên `custom` chưa runtime-test trên 3.8.x** — branch đó chưa có editor session nào mở.


### Hai phương án đã cân nhắc và BỎ (ghi lại để khỏi bàn lại)

**(b) Gộp 1 branch + compat guard.** Tôi từng khuyến nghị cái này. Lý do bỏ: xem §"Vì sao (b) SAI"
ở trên — guard xử lý được drift **API**, không xử lý được drift **dependency/native-ABI**.
Phần đúng vẫn giữ lại: **5 compat guard vẫn dùng, vẫn là cách xử drift API trong TỪNG branch.**
Cái bỏ là bước *gộp branch*, không phải bỏ guard.

**(c) Freeze `custom` ở 3.8.x, chỉ dev `cc-3x7`.** Bỏ vì trái mục tiêu "phát triển song song" —
3.8.x đứng yên, và mọi bug chung tìm ra ở 3.7.x vẫn sống nguyên trên `custom` cho tới ngày quay lại.
(c) chỉ **hoãn** chi phí port chứ không xoá; (a) trả chi phí đó ngay, từng lần, có kiểm soát.

---

## Unresolved

1. 356/416 message không có param doc → signature ẩn số. **Chiến lược đã chốt: compat helper
   try-catch** như `queryAssetsCompat`. Lý do: 3 drift thật + 3 message vắng mặt đều lộ ra qua lỗi
   runtime rõ ràng (`Message does not exist: …`, `parameter error` code -1), không cần probe hàng
   loạt — mà probe hàng loạt còn phải **đoán args hợp lệ** cho message không rõ signature → dễ
   false-negative (fail vì args sai, không phải vì message thiếu).
2. ~~`project/set-config` map sang gì~~ → ✅ **RESOLVED: KHÔNG map.** `change-script-config` chỉ đụng
   script settings; `import-config`/`export-config` chuyển cả file. Không cái nào ghi 1 dotted path.
   Map bừa = ghi sai key **im lặng**. Đã đổi thành báo unsupported + chỉ workaround (`4832cf1`).
   Nguyên tắc: **bỏ tool > map sai**.
3. `sharp 0.30.7` + `express 4` pin cho 3.7.x đã đúng chưa — chưa verify Electron version của 3.7.3.
   Bằng chứng gián tiếp: 61 tool load được và trả kết quả trên 3.7.3 → transport (express 4) OK.
   `sharp` thì chưa chứng minh: nhánh dùng nó (`assetGetPreview`) là cái duy nhất chưa test được.
   **Đây là rủi ro deps-divergence cụ thể nhất** — nếu 3.8.x cần `sharp` bản khác thì `custom` ↔
   `cc-3x7` phân kỳ deps ngay, và đó chính là tình huống (a) xử được mà (b) không.
4. ~~`scene/query-uuid` nên port ngược về `custom`?~~ → ✅ **RESOLVED: đã port** (`18b3794`).
   Verify trước khi port: `custom` vẫn còn bug thật. Cùng lượt port luôn 6 bug của `35ec127`
   (cherry-pick `6c498c9`, merge sạch 0 conflict). **8/8 fix đã sang `custom`, build exit 0, nhưng
   chưa runtime-test trên 3.8.x** — branch đó không có editor session nào mở.
5. ~~Gộp 1 branch có khả thi không?~~ → ✅ **RESOLVED: chốt (a), KHÔNG gộp.** Xem §5.
6. **Mới:** 4 hạng mục feature chưa port sang `custom` (3 tool `materialQuery`/`assetDbQuery`,
   `has_script`, build provenance). Không gấp vì là feature không phải bug — nhưng cần **1 danh sách
   theo dõi** kẻo quên. Hiện danh sách đó nằm ở §5 bảng "Trạng thái đồng bộ"; nếu (a) chạy dài thì
   nên có chỗ chuyên trách hơn.
