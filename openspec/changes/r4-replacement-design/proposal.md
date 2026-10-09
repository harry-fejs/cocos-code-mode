## Why

The frozen `api-capability-resume` change deliberately deferred lane R4 because the six portfolio rows describe concepts that do not map directly to native Creator 3.7.3 assets or editor APIs. This change reopens R4 only as a bounded replacement-design proposal. It does **not** implement, qualify, or promote any capability.

The proposal preserves the distinction between an agent-useful workflow and a native Creator capability. A replacement may be considered only when its observable contract is explicit, its ownership boundary is honest, and fresh evidence proves the route on the target Creator version.

**Owner update — 2026-10-08:** the original proposal-only boundary below is historical for the frozen replacement inventory. The owner separately selected native prefab override/apply follow-through (implementation commit 72c3bc3; live qualification pending) and tween project-code static development. Tilemap remains deferred; tween runtime control/validation remains pending with R1. See tasks.md and api-capability-resume/tasks.md for approved delivery order. No new native asset type, portfolio state or threshold change is authorized.

## Scope

Rows in scope, all remaining `replace` and pending:

- `prefabVariantCreate`
- `tilemapCreate`
- `tweenSequenceCreate`
- `tweenSequenceInspect`
- `tweenSequenceControl`
- `tweenSequenceValidate`

The current portfolio rows in `docs/tool-portfolio-candidates.json` remain the source of truth for portfolio state. This change MUST NOT edit those rows, the portfolio denominator, approval thresholds, or any source implementation.

## Replacement boundaries

### `prefabVariantCreate`

Proposed replacement: a **native prefab override/apply workflow**, not a new prefab-variant asset.

- Input: an existing prefab source and a resolvable scene instance or prefab editing context.
- Operation boundary: identify a bounded set of instance overrides, persist them through Creator's supported prefab override/apply path, and report source/instance identity plus the applied override set.
- Success contract: after reload, the instance/source relationship and override/apply result are readable through the supported editor/asset route; no claim is made that Creator produced a separate variant asset.
- Non-goals: inventing a variant file type, copying a prefab into an unowned asset, or treating arbitrary scene mutation as variant creation.
- Status: proposal-only until a Creator 3.7.3 route and reload read-back are proven.

### `tilemapCreate`

Proposed replacement: **bounded TMX source generation/import/validation**, not native map authoring.

- Input: a bounded, schema-valid TMX source description plus referenced tileset/resource identities.
- Operation boundary: generate or provide a TMX source artifact, import it through the supported Creator workflow, and validate the imported map/layer/object/tileset structure.
- Success contract: source identity, import outcome, and typed imported-data read-back are all available; validation MUST distinguish source-generation success from Creator import success.
- Non-goals: claiming a native Creator tilemap authoring API, silently editing an imported asset without a source-format contract, or replacing Tiled/source ownership.
- Status: proposal-only until the TMX generation, import, and validation boundaries are separately evidenced on Creator 3.7.3.

### `tweenSequenceCreate`

Proposed replacement: **project-code composition/diagnostics**, not a native tween sequence asset.

- Input: a bounded declarative sequence model with target identity, ordered steps, timing, easing, and lifecycle policy.
- Operation boundary: compose or validate project-owned TypeScript/JavaScript tween code (or a deterministic code representation) and return diagnostics; generated code remains project code.
- Success contract: the returned artifact identifies the generated/updated project path or an explicit non-writing diagnostic result, includes deterministic sequence metadata, and never reports a native Creator asset.
- Non-goals: registering a fake asset, presenting generated code as an editor-native sequence, or writing project files without an explicit write contract.
- Status: proposal-only; implementation and qualification remain pending.

### `tweenSequenceInspect`

Proposed replacement: **project-code sequence diagnostics**.

- Input: an explicit project-code path or bounded sequence descriptor.
- Operation boundary: inspect only the declared project-code representation and return ordered steps, targets, timing/easing metadata, source location, and parse/diagnostic status.
- Success contract: inspection identifies whether the sequence is represented and whether it is statically inspectable; it MUST not imply a persistent native sequence exists.
- Non-goals: inspecting an imaginary asset ID, inferring runtime state from source alone, or silently executing project code.
- Status: proposal-only until a stable code representation and negative/error behavior are evidenced.

### `tweenSequenceControl`

Proposed replacement: **runtime control of project-code-owned sequences**.

- Input: an explicit runtime session, sequence identity/handle, and bounded control action (for example start, pause, resume, or stop where supported).
- Operation boundary: route control through a live runtime session and report accepted/rejected action plus observable sequence state.
- Success contract: control is tied to a declared project-code sequence and has a live runtime read-back; absence of a runtime session or unknown sequence MUST fail closed.
- Non-goals: controlling a native asset that does not exist, mutating editor state as a substitute for runtime control, or claiming control from static source inspection.
- Status: proposal-only and dependent on a separately proven runtime-session contract.

### `tweenSequenceValidate`

Proposed replacement: **static diagnostics plus optional runtime validation** for project-code composition.

- Input: a bounded sequence descriptor or project-code representation, with optional live runtime/session context.
- Operation boundary: validate schema, references, timing/easing constraints, generated-code diagnostics, and (when explicitly requested and available) runtime postconditions.
- Success contract: output separates static validity from runtime evidence and reports stable errors for missing targets, malformed steps, unsupported easing, compile/parse failures, and unavailable runtime context.
- Non-goals: treating TypeScript compilation as proof of editor-native asset support, claiming visual correctness without a runtime witness, or mutating project/scene state as validation.
- Status: proposal-only until static and runtime evidence contracts are implemented and exercised.

## Native Creator 3.7.3 position

No native Creator 3.7.3 capability is claimed by this change. Existing `replace` states remain unchanged. Where the proposed route cannot be proven on Creator 3.7.3, the route remains documentation-only and the row remains pending/deferred. A proposal is not an implementation, and a generated artifact is not evidence of native Creator support.

## Acceptance boundary before any portfolio state change

A future implementation MUST provide, for each row independently:

1. A stable capability contract and route-specific fixture on a clean, identified Creator artifact.
2. Positive evidence proving the intended replacement outcome, including round-trip/reload or runtime read-back where relevant.
3. Negative evidence proving deterministic fail-closed behavior for unsupported native paths, invalid input, missing prerequisites, and ambiguous identity.
4. Evidence that separates external/project-code/source-format behavior from native Creator behavior.
5. A bounded evidence artifact under `reports/evidence/candidates/<name>/<creator>-<artifact-sha>.json` containing the exact Creator version/build, artifact commit/hash, inputs, outputs, and positive/negative witness IDs.
6. A recorded decision for any gate or denominator change.

Until all applicable evidence exists and is reviewed, no row may change from `replace`, no row may become `qualified`, and no frozen portfolio state may be edited.

## Non-goals

- No source-code changes.
- No portfolio-state or gate edits.
- No claim that Creator 3.7.3 exposes prefab variants, native tilemap creation, or native tween sequence assets.
- No implementation of external Tiled integration, code generation, runtime controls, or diagnostics in this proposal.
- No dismissal of existing deferred/rejected boundaries from `api-capability-resume`.
