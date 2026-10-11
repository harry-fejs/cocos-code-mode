## Why

Creator 3.7.3 đã đạt **321 registered / 154 qualified (86 baseline + 68 portfolio) / 90.28% workflow** — đủ để agent thao tác component/editor "nhanh nhất có thể". Owner quyết định chốt Creator 3.7 làm release đầu tiên; mọi nội dung Creator 3.8 và API breadth sâu hơn chuyển sang một release train sau 3.7.

Plan này là **tủ pending cho phiên bản sau**: không implement, qualify hoặc dùng làm điều kiện chặn build/security/publish/release của artifact 3.7. Giữ nguyên evidence/probe và tách riêng version-bound claims.

- **Deferred release boundary:** change này không thuộc Creator 3.7 release scope. Resume chỉ sau khi artifact 3.7 đóng build, security, clean qualification, publish và release gates.
- Tạo change mới `api-capability-resume` ở trạng thái **pending** (không implement trong đợt publish). Toàn bộ scope dưới đây là deferred, không tính vào gate hiện tại.
- Ghi nhận 11 hàng **treo trực tiếp** trên `docs/tool-portfolio-candidates.json` (2026-09-21, bacd213):
  - `candidate` (3): `renderConfigurationApply` (rendering-materials, read-back _globals thiếu), `previewSessionStart/Stop` (runtime-qa, preview-lifecycle).
  - `implemented-unverified` (2): `assetBundleValidate` (assets-import, runtime-session), `localizationValidate` (localization, resource-contract).
  - `replace` (6): `prefabVariantCreate`, `tilemapCreate`, `tweenSequenceCreate/Inspect/Control/Validate` (tween domain — không có native asset, cần thiết kế lại).
- Ghi nhận 23 hàng **rejected chờ revisit 3.8+** (23 trong 102, gồm 4 reserve): `animationGraphPreview`, `skeletalAnimationPlay/Events`, `audioPlaybackControl/Observe`, `physics2dConfigure/3dConfigure`, `particleConfigure/Playback`, `renderDiagnosticsCollect`, `lightBakeManage`, `terrainEdit`, `localizationInspect/TableEdit/Preview`, `runtimeSessionLifecycle/StateObserve/ScenarioRun/Assert`, `previewSessionInspect/ResolutionSet`, `runtimeWaitForState`, `bitmapFontImportSettingsConfigure`.
- Ghi nhận backlog `docs/next-update-3x8-capability-backlog.json`: 3 `unsupportedOnCreator373` (projectManage set, physics2d/3dConfigure) + 9 `unverifiedOrFixtureBlocked` cần fixture/transport mới.
- Định nghĩa **điều kiện resume**: Creator 3.8+ IPC (`project/set-config`, `_globals` read-back, preview resolution), fixture game-view không còn owner-disable, và thiết kế mới cho tween/prefabVariant/tilemapCreate.
- Lane **R6 — Creator popup observability** implementation is complete in `notes/plans/cc-code-mode-cst/4-done-260922__261004-creator-popup-detection/plan.md`; owner separated live acceptance into `4-done-261004__261011-creator-popup-live-qualification/plan.md` for combined feature testing. Detection remains read-only; no frozen portfolio promotion or release qualification follows from implementation closure.
- Không đụng tới 68 qualified hiện tại; không hạ gate lén — mọi thay đổi `requiredApprovalCount` phải có decision ghi file.

## Capabilities

### New Capabilities
- `resume-orchestrator`: điều kiện/phase để mở lại từng domain khi 3.8 hoặc fixture sẵn sàng.
- `tween-sequence-design`: thiết kế mới cho tween nếu quyết thay thế code-gen.

### Modified Capabilities
- None trong đợt pending này. Khi resume, các capability dưới sẽ được promote thành spec riêng: `render-configuration`, `preview-session`, `bundle-validation`, `localization-validation`, `tween-sequence`.

## Goal (a's intent, frozen)

> Mở rộng API đến **mức vừa đủ dùng để agent thao tác với các components của editor nhanh nhất có thể**, rồi **ngưng** để làm **build/security → publish/release**, sau đó **mở lại API** theo plan pending này. "Vừa đủ" = 154 qualified hiện tại đã cover thao tác component cơ bản; phần pending là mở rộng sâu (preview runtime, project settings, bake, terrain, tween code-gen) không chặn publish.

## Non-Goals (trong pending)

- Không implement bất kỳ tool mới nào trong change này.
- Không đổi `scripts/audit-tool-portfolio.js` gate hay `docs/tool-portfolio-candidates.json` state — mọi promote phải qua live probe mới trên artifact không dirty và commit mới.
