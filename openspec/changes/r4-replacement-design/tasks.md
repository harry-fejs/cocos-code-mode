## 1. Proposal boundary

- [x] Create a separate pending R4 change rather than mutating the frozen `api-capability-resume` change.
- [x] Enumerate all six `replace` rows and state that implementation/qualification remains pending.
- [x] State explicit non-goals: no source edits, no portfolio/gate edits, and no native Creator 3.7.3 claim.

## 2. Replacement contracts

- [x] Define `prefabVariantCreate` as a bounded native prefab override/apply workflow with source/instance reload read-back; reject invented variant assets.
- [x] Define `tilemapCreate` as bounded TMX source generation/import/validation; separate source, import, and validation outcomes.
- [x] Define `tweenSequenceCreate` and `tweenSequenceInspect` as project-code composition/diagnostics, not native assets.
- [x] Define `tweenSequenceControl` as explicit live runtime-session control with observable state transitions.
- [x] Define `tweenSequenceValidate` as separated static diagnostics and optional runtime validation.

## 3. Evidence and promotion gate

- [x] Specify required positive and negative witnesses, clean artifact/build identity, fixture identity, route ownership, and persistence/reload or runtime read-back.
- [x] Require fail-closed behavior for unsupported native paths, invalid input, missing prerequisites, unknown identity, and unavailable evidence.
- [x] Keep every row `replace`/deferred until the route is implemented and independently evidenced; do not change portfolio states or thresholds in this change.

## Owner-approved prefab follow-through — 2026-10-08

- Existing native prefab workflow extended, not a new variant asset: prefabInstanceInspect now returns source hash, total override count and truncation; prefabApplyOverrides accepts expectedSourceSha256, refuses stale sources before dispatch and returns bounded source diff with sceneSaved:false.
- prefabValidate reports complete/truncated/totalReferences and never returns valid for a capped check; authoritative Asset DB query failures remain errors.
- Build/Creator load and focused prefab tests 27/27 pass; registered HTTP inspection→conflict refusal→apply diff→stale refusal smoke passes against simulated Creator IPC and a real disposable prefab file.
- Real Creator source/instance persistence after reload and exact-artifact live qualification remain required before promoting the frozen replacement row. No tilemap/tween implementation, portfolio edits, or qualification credit in this follow-through.

## Owner implementation-only review — 2026-10-09

- [x] Accept existing prefab inspection/source-hash apply/diff/completeness implementation for source review only.
- [ ] Verify/re-verify exact current CCP artifact positive/negative conflict boundaries, native source/instance persistence, save/reopen and cleanup later. Prior simulated/offline test outputs remain historical records, not current live qualification.
- [ ] Tween project-code create/inspect/static diagnostics implementation remains open; runtime stays pending under R1. Tilemap remains deferred. Source acceptance does not promote replacement rows or change portfolio thresholds.
