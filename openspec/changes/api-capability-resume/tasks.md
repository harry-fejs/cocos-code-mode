## Release boundary — Creator 3.7 first

- [x] Owner decision recorded: complete build/security, clean qualification, packaging, publish and release for the supported Creator 3.7 artifact before reopening any 3.8/API-resume lane.
- [x] Keep this change `status: pending`; do not use its 3.8 probes, forward-runtime evidence or pending candidates as Creator 3.7 release credit or blockers.

### CCP source cutover and current release gates — 2026-10-09

- [x] Apply final active CCP naming across API3x/protected3x/2x/Gateway source and callers; preserve immutable historical signed evidence and frozen portfolio inputs.
- [x] Verify source artifacts: API build/Creator-load and unit 671/671; protected build/unit 258/258; 2x build/unit 117/117; Gateway typecheck/tests 83/83. Isolated project-bound HTTP/CLI smoke and Compose config pass; these are not installed Creator release witnesses.
- [ ] Review/migrate exact owned legacy package/profile/config/state without dual loading; preserve signed legacy bytes as archive only. Protected CCP requires fresh authorized product credentials/enrollment and a clean signed `ccp3x` release.
- [ ] Repeat exact current CCP package discovery/project-instance binding, persistence/reload, restart/rollback and selected Creator3.7 workflow witnesses; update current manifests/evidence hashes without relabeling old signatures or changing frozen thresholds. R1/R3/tilemap/3.8 lanes remain held.


## 1. Freeze and evidence

- [x] Ghi snapshot hash-reference trong `freeze-evidence.json`: `docs/tool-portfolio-candidates.json` (80+22=102, qualified 68) + `reports/api-capability-probe-20260920.json` + `reports/api-capability-preview-disabled-reconciliation-20260920.json` + backlog, tất cả bind với commit `bacd213`.
- [x] Giữ `api-capability-resume` ở `status: pending`; `node scripts/audit-tool-portfolio.js` hiện pass với `potentiallyQualifiable 73`, `approvedCount 70`, `requiredApprovalCount 82`, `marginEroded:true`. Change không sửa threshold hay portfolio state; `--require-ready` vẫn phải fail cho publish gate.
- [x] Trace smoke freeze `bacd213` ngày 2026-09-21: commit tồn tại; claim `10/10 pass`, scene open, handshake responsive được giữ trong `proposal.md`, `design.md`, `docs/tool-catalog.md`, và `freeze-evidence.json`. Không có transcript live độc lập để nâng thành witness mới.

## 2. Resume lanes (mở khi a quay lại — mỗi lane là một spec riêng)

- [ ] **Lane R1 — Runtime preview re-enable** — blocked after clean artifact probe `reports/r1-preview-gate-probe-20260922.json` (`cdc2de2`, bound handshake): `runtimePreviewControl start` and `runtimeSessionLifecycle start/game-view` both fail 422 `PREVIEW_FEATURE_DISABLED` without lifecycle mutation. Owner must enable `GAME_VIEW_PREVIEW_DISABLED`, then supply a non-flaky Game View fixture for `preview-lifecycle + runtime-transport`. Rows: `previewSessionStart/Stop`, `runtimeSessionLifecycle/StateObserve/ScenarioRun/Assert`, `previewSessionInspect`, `runtimeWaitForState`, `animationGraphPreview`, `skeletalAnimationPlay/Events`, `audioPlaybackControl/Observe`, `particlePlayback`, `renderDiagnosticsCollect`, `localizationPreview`.
- [ ] **Lane R2 — Project/Scene globals** — blocked after clean artifact probe `reports/r2-project-globals-probe-20260922.json` (`cdc2de2`, Creator 3.7.3): `project/set-config` returns `Message does not exist`, and scene `_globals` is `undefined`; no mutation occurred. Creator ≥3.8 with an authoritative project writer and `_globals` read-back is required. Rows: `renderConfigurationApply`, `physics2dConfigure/3dConfigure`, `bitmapFontImportSettingsConfigure`.
- [ ] **Lane R3 — Verification bundles** — blocked after clean artifact probe `reports/r3-fixture-probe-20260922.json` (`cdc2de2`, Creator 3.7.3, bound handshake): negative boundaries observed, but project has zero bundle assets and localization module/resource unavailable. Fresh positive/negative witnesses remain required for `assetBundleValidate` and `localizationValidate`; no promotion.
- [ ] **Lane R4 — Selected prefab/tween follow-through** — owner decision 2026-10-08 supersedes blanket deferral: native prefab override/apply follow-through approved; tween create/inspect/static validation desired next. Tilemap remains deferred. Tween runtime control/validation remains pending with R1. No native variant/tween asset claim or portfolio promotion without exact evidence.
- [ ] **Lane R5 — Engine features 3.8** — blocked after clean read-only probe `reports/r5-engine-api-probe-20260922.json` (`cdc2de2`, Creator 3.7.3): `cc.Terrain`, `cc.ParticleSystem`, and `cc.LightProbeInfo` are `undefined`; no mutation attempted. Creator ≥3.8 engine APIs and fresh witnesses required for `lightBakeManage`, `terrainEdit`, `particleConfigure`; physics topology remains qualified.
- [x] **Lane R6 — Creator popup observability/control implementation** — owner accepted implementation-only closure on 2026-10-04. Detection plan `4-done-260922__261004-creator-popup-detection` and action child `4-done-260923__260925-creator-popup-actions` are complete. Live qualification is separately queued in vault plan `2-todo-261004__tbd-creator-popup-live-qualification` for combined feature testing; clean canonical Scene Not Response, stacked public-action reliability and cleanup remain pending. No portfolio promotion or parent resume closure.

### Build/config priority — owner decision 2026-10-08

- Owner approved development of build configuration, settings and reusable profiles. This does not reopen project/scene globals, Game View, tilemap, bundle/localization or engine-feature qualification.
- Implemented `buildSettingsManage` for allowlisted Creator builder local/global defaults and cache preferences; writes verify read-back and rollback. No changes to existing tasks, SDK/NDK or signing credentials.
- Implemented `buildProfileManage` for CCP-owned project profiles (list/get/save/delete), audited options, credential refusal, bounded storage and guarded writes. These are not native Creator build preset assets.
- Implemented `buildTemplate` list/create for six platforms and debug/release options; scene identity syntax/start-scene membership/native package ID are validated, target settings use packages[platform], and nested target profile validation rejects incompatible option types. Templates never persist/dispatch and disclose missing asset/toolchain/signing qualification.
- Offline build and HTTP persistence smoke use a simulated Creator Profile backend; real Creator persistence/reload and exact build artifact qualification remain pending. No portfolio promotion or threshold changes.
- Pending separately: numeric task-ID acceptance in buildManage, builder add-task outcome verification, native task/preset settings route, and Android environment configuration after authoritative API discovery. Do not retry ambiguous build submission.

### Approved delivery sequence — 2026-10-08

- [ ] **P0 task identity:** accept safe numeric/string builder task IDs in get_task/control, normalize before IPC, verify returned IDs work directly and invalid IDs fail before dispatch.
- [ ] **P0 logging:** preserve/omit optional undefined metadata; remove false test:undefined and Details/Recovery:undefined without suppressing real errors.
- [ ] **P0 build submission:** verify native add-task return semantics; distinguish refused/submitted/outcome-unknown. Inspect queue before retry; never infer success from an unrelated task.
- [ ] **Build config/preflight:** discover authoritative native task/preset update routes; verify scene UUID/URL/start-scene identity, target availability and remote bundle/server requirements. No editor-owned filesystem fallback.
- [ ] **Environment:** inspect Android SDK/NDK/Java through verified APIs with redacted output. Enable writes only after route/read-back/restoration proof; no signing secrets in tools/profiles/logs.
- [ ] **Web-mobile end-to-end:** disposable clean artifact, template/profile persistence and reload, explicit submit, task identity, terminal state, diagnostics/output proof and cleanup.
- [ ] **Prefab live closure:** inspect, bounded override mutation, guarded apply, source/instance identity, save/reopen, conflict/no-mutation negative and cleanup. Review mounted/removed/nested contracts and total payload bounds; no fake variant asset.
- [ ] **Tween static:** implement project-code create/inspect/static diagnostics with bounded ownership and deterministic errors; runtime remains pending under R1.
- [ ] **Android qualification:** exact toolchain/project/package identity, explicit build lifecycle and output/cleanup evidence. iOS build qualification requires macOS/Xcode; config generation on Windows is not build proof.
- [ ] **Combined UI/observability:** visual Status five-row scroll/refresh and original responsive UUID retry; run popup acceptance only in its owner-approved combined feature test.
- [ ] **Evidence/plan reconciliation:** fix input hash drift, current versus historical 228/236 full counts, transferred checklists, stale lane metadata and broken dashboard links without changing thresholds silently.
- [ ] **Package/release:** clean packaged install, discovery/handshake, restart/rollback and selected 3.7 scope witnesses; keep minifier integration separate until combined artifact proof.

Execution order: build/log P0 → native build config/preflight → web-mobile end-to-end → prefab live closure → tween static → Android qualification → package/release. Evidence reconciliation accompanies each phase. R1 pending, R3/tilemap deferred, R5 consideration only; no automatic reopening of 3.8 breadth.

## Deferred hierarchy browsing — owner idea, not a release gate

- [ ] Sau release Creator 3.7, thiết kế bounded `nodeGetTree` browsing: giữ mặc định depth 4 / 200 nodes (không mở depth vô hạn); khi `truncated`, agent dùng `reference` để đọc tiếp nhánh cần thiết. Với cha rộng, cân nhắc `childOffset` + `pageSize`, trả `childrenCount` và `nextOffset`/end-of-page; giới hạn từng request và không auto-fetch toàn scene. Chốt thứ tự children và semantics khi scene đổi giữa các trang; chứng minh kết quả trên fixture sâu/rộng và đo payload/token trước khi implement. Không tính vào qualification hay publish gate hiện tại.

## 3. Re-entry checklist (khi a bảo "back lại")

- [ ] Chọn lane, tạo proposal riêng từ change này, bump `requiredApprovalCount` nếu potřeba qua decision ghi file, không hạ lén.
- [ ] Chạy `reports/api-capability-probe-20260920.json` pattern probe mới trên artifact không dirty, ghi commit `builtAt` vào evidence.
- [ ] Mỗi row promote phải có `reports/evidence/candidates/<name>/<creator>-<sha>.json` + `positiveTestID/negativeTestID` pass, rồi mới đổi `candidate → qualified` trong `docs/tool-portfolio-candidates.json`.
