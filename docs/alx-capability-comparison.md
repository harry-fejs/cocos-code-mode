# ALX Capability Comparison and CCP Reimplementation Map

**Status:** Reference
**Updated:** 2026-09-11
**Scope:** Compare the external ALX tool inventory with the independent CCP 3x implementation.
**Source:** `G:\alx-tool-api.txt`; current CCP source under `source/utcp/`.

## Purpose

ALX is treated as a functional reference only. CCP does not depend on ALX source code, binaries, policies, transport, or runtime availability. The comparison identifies useful workflows and implementation ideas that CCP can independently reproduce with its own contracts, safety model, and Creator 3.7.x qualification process.

## Inventory

The supplied ALX configuration contains **163 enabled tools** across 15 categories. Its surface is mostly granular:

| ALX area | Count | CCP interpretation |
|---|---:|---|
| Project | 26 | Mostly covered by `projectManage`, asset tools, build tools, and preview/runtime tools |
| Scene advanced | 23 | Mostly covered by scene/node consolidated tools; some transaction and readiness ideas remain |
| Scene view | 20 | Mostly consolidated into `editorViewport` |
| Node | 13 | Covered by `nodeCreate`, `nodeOperate`, `findNodes`, `nodeGetTree`, and inspector tools |
| Reference image | 12 | Candidate `referenceImageManage`; requires a live IPC probe |
| Asset advanced | 11 | Mostly covered by asset query/operate/reference tools; texture compression remains a possible gap |
| Prefab | 10 | Covered by node prefab operations and prefab JSON tools, with structural audit opportunities remaining |
| Debug | 10 | Covered by diagnostics, editor logs, performance, validation, and safe JavaScript execution |
| Component | 7 | Covered by component and inspector tools |
| Preferences | 7 | Partially covered by editor preference get/set |
| Scene | 8 | Covered by scene management and scene information tools |
| Broadcast | 5 | New observation capability; not yet implemented in CCP |
| Server | 6 | Mostly environment/transport diagnostics rather than Creator authoring capability |
| Validation | 3 | Client/request formatting helpers; not a reason to expose more CCP tools |
| Template | 2 | Domain-specific slot-machine workflow; CCP should own its own higher-level version |

## Coverage model

Name differences do not imply capability gaps. CCP intentionally consolidates related operations to reduce agent tool-selection noise and request-side schema cost.

Examples:

- ALX scene open/save/save-as/close → CCP `sceneManage`.
- ALX 20 scene-view tools → CCP `editorViewport` operations.
- ALX node property/transform/delete/move/duplicate → CCP `nodeOperate`, `inspectorSet`, and `nodeBatchSet`.
- ALX component add/remove/read/write → CCP `nodeComponentManage`, `nodeComponentsGet`, `inspectorGet`, and `inspectorSet`.
- ALX execute script → CCP `executeJavascript`, protected by the CCP safety guards and context rules.

The correct comparison unit is therefore **workflow coverage plus contract quality**, not raw tool count.

## High-value ideas to reimplement independently

### 1. Multi-node layout alignment

ALX exposes `align_nodes` for world-space alignment and distribution. CCP now exposes `uiLayoutAlign` with a stricter contract:

- `align` or `distribute` operation.
- Horizontal or vertical axis.
- Edge validation for align operations.
- Minimum node counts: two for align, three for distribute.
- Maximum 100 references.
- Unique target validation.
- Same-parent restriction for deterministic local-space writes.
- Preflight, mutation, read-back, one snapshot, and rollback on partial failure.

Implementation:

- `source/utcp/tools/ui-tools.ts`
- `source/ui-layout-align.ts`
- `tests/unit/alx-inspired-tools.test.js`

### 2. Reverse hierarchy lookup

ALX provides `get_node_path`. CCP now exposes `nodeGetPath`:

- UUID → hierarchy path.
- Optional relative root.
- Optional root omission.
- Returns both string path and segments.
- Fails with typed `NOT_FOUND` when the node is outside the requested hierarchy.

This supports generated controller code using `getChildByPath` or equivalent scene lookup logic.

### 3. Reference-image workflow

ALX has 12 granular reference-image tools. CCP should not copy that surface one-for-one. The target is one bounded `referenceImageManage` tool with finite operations:

- add
- remove
- select/switch
- transform
- query
- list
- clear

The feature remains `probe-required` until Creator 3.7.3 exposes a stable, verifiable IPC contract. The qualification requirement is persistent lifecycle plus transform read-back, not merely a fire-and-forget command.

### 4. Undo transaction boundaries

ALX exposes begin/end/cancel undo recording. CCP already uses snapshots and rollback patterns. The next step is to probe whether explicit transaction boundaries are stable in the target Creator version.

If qualified, use them internally around compound mutations first. Do not expose an unrestricted stateful transaction API until lifecycle, failure, nesting, and cleanup behavior are proven.

### 5. Persistent project-log search

ALX separates project-log inspection from editor console inspection. CCP's `editorGetLogs` already reads the project log file path, so the useful remaining idea is contract expansion:

- bounded `pattern` search;
- explicit line order;
- maximum bytes and lines;
- typed result indicating truncation;
- no assumption that a missing or unreadable log means a healthy project.

### 6. Broadcast observation

ALX's broadcast tools suggest a useful asynchronous observation layer for asset import, script compilation, scene save, and build completion. CCP should implement this as a bounded event buffer, not as unrestricted listener management:

- allowlisted event names;
- ring buffer with fixed event and byte limits;
- explicit start/stop lifecycle;
- no arbitrary payload retention;
- cleanup on server/editor shutdown;
- typed stale/empty state.

## Ideas not worth copying directly

- Exposing all 163 granular tools: increases schema and selection cost.
- Client-side JSON formatting helpers as public editor tools: belong in the caller or gateway.
- Generic network-interface tools: useful for diagnostics but not core Creator authoring.
- Raw execute-script fallback for every missing feature: weakens safety and makes qualification impossible.
- Unbounded scene snapshots or logs: incompatible with CCP response-size and truncation contracts.

## CCP advantage to preserve

CCP's differentiation is not raw CRUD coverage. Preserve and extend:

- bounded contracts and explicit truncation;
- typed fail-closed errors;
- preflight/read-back/rollback mutation workflows;
- batch reads and writes;
- tool profiles and schema slimming;
- runtime session lifecycle;
- physics, audio, build, diagnostics, and scene-health domain tools;
- independent Creator-version qualification evidence.

## Decision

Use ALX as a **black-box feature catalog and workflow reference**. Reimplement only validated, high-value capabilities behind CCP-native consolidated contracts. No CCP module may import, invoke, or require ALX.

## Related documents

- [Independent CCP strategy](./independent-ccp-strategy.md)
- [CCP usage](./ccp-code-mode-usage.md)
- [v2/v3 parity](./parity-v2-v3.md)
- [Tool portfolio candidates](./tool-portfolio-candidates.json)
