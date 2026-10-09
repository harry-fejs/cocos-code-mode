# Independent CCP Strategy

**Status:** Active direction
**Updated:** 2026-09-11
**Scope:** Product and architecture direction after reviewing the external ALX tool inventory and demo.

## Strategic position

CCP is an independent in-house tool for Cocos Creator. External tools, demos, API inventories, and black-box builds may provide ideas, but they are not runtime dependencies or architectural authorities.

The goal is not to reproduce another vendor's tool count. The goal is to provide a safer, more capable, and more useful agent interface for the studio's Creator and slot-game workflows.

## Architectural principles

### Independent implementation

CCP must remain buildable, testable, and deployable without:

- ALX source code;
- ALX binaries;
- ALX licenses or policy services;
- ALX-specific tool names or transport assumptions;
- network access to an external provider.

### Consolidated public surface

Prefer one bounded tool with explicit operations over many granular wrappers when the operations share a resource and lifecycle. Consolidation is useful only when the schema remains understandable and operation-specific validation is preserved.

Examples:

- `sceneManage` rather than separate open/save/close tools;
- `editorViewport` rather than separate gizmo/grid/view tools;
- `uiLayoutAlign` rather than separate align-left/align-right/distribute tools.

### Domain workflows over raw editor verbs

The high-value layer is workflow completion:

```text
inspect → preflight → mutate → verify → report → recover
```

A tool should return evidence that a consumer can act on, not only a boolean from an IPC call.

### Fail closed

Unsupported Creator messages, missing scene state, malformed references, partial writes, and failed read-backs must produce typed errors or explicit incomplete results. CCP must never turn an unavailable API into fabricated success.

### Bounded by default

Every response-heavy operation needs limits for nodes, assets, lines, events, bytes, or depth. Truncation must be explicit and machine-readable.

## Capability layers

```text
Agent
  ↓
CCP consolidated UTCP tools
  ↓
Preflight / safety / transaction / read-back layer
  ↓
Creator public or qualified editor IPC
  ↓
Scene, asset, build, runtime, and project state
```

### Layer 1 — Agent-facing contracts

Responsibilities:

- concise operation-based schemas;
- descriptions containing Creator-specific parameter traps;
- tool profile filtering;
- response trimming and result envelopes;
- stable references and typed errors.

### Layer 2 — Workflow services

Responsibilities:

- batch reads/writes;
- scene hierarchy traversal;
- layout calculations;
- asset/reference analysis;
- preflight and rollback;
- postcondition verification.

### Layer 3 — Creator adapters

Responsibilities:

- call only known Creator messages;
- isolate version-specific signatures;
- classify `NOT_EXPOSED` separately from domain failure;
- preserve evidence of the exact request and result shape.

### Layer 4 — Domain engines

Responsibilities:

- slot UI scaffolding;
- physics and audio audits;
- build artifact and log inspection;
- script health and repair;
- runtime smoke workflows;
- localization and responsive layout verification.

## Expansion roadmap

### P1 — High-value editor ergonomics

Implemented:

- `uiLayoutAlign`: multi-node align/distribute with bounded, rollback-safe mutation.
- `nodeGetPath`: reverse UUID-to-hierarchy lookup.

Next:

- qualify and implement `referenceImageManage` if the 3.7.3 IPC is stable;
- improve project-log search with bounded pattern filtering;
- probe explicit undo transactions.

### P2 — Asynchronous observability

Potential capability:

- `editorEvents` or equivalent bounded broadcast observation.

Contract requirements:

- event allowlist;
- fixed ring buffer;
- byte/event ceilings;
- lifecycle cleanup;
- explicit stale state;
- no arbitrary subscription to every editor payload.

Use cases:

- wait for asset import completion;
- detect script compilation completion;
- observe scene save completion;
- correlate build task transitions.

### P3 — Visual closed-loop verification

Combine:

- reference image lifecycle;
- scene/editor screenshots;
- `uiLayoutReport`;
- `uiLayoutValidate`;
- responsive preview qualification.

The desired workflow is:

```text
reference image
  → construct or modify UI
  → capture bounded evidence
  → compare geometry and visual artifact
  → apply bounded correction
  → verify again
```

Pixel-perfect comparison should not be introduced before geometry, viewport, and artifact provenance are stable.

### P4 — Studio domain automation

Build workflows that are independent of ALX and tailored to slot production:

- reel-grid and symbol layout creation;
- payline and win-overlay visualization;
- slot UI responsive checks;
- localization overflow checks;
- audio event mapping audits;
- runtime spin smoke scenarios;
- build artifact qualification.

These capabilities form the strongest long-term moat because they encode studio conventions rather than generic Creator CRUD.

## Rejected direction

Do not implement:

1. A compatibility layer that forwards CCP calls to ALX.
2. A 163-tool mirror solely for parity metrics.
3. An unrestricted listener or script-execution surface to close gaps quickly.
4. A vendor-specific abstraction that makes CCP unable to run independently.
5. High-level slot workflows that silently depend on undocumented external templates.

## Qualification policy

Each new Creator capability must provide:

- exact target Creator version;
- known IPC or runtime route;
- positive witness;
- negative witness;
- bounded output contract;
- mutation rollback or explicit non-atomic behavior;
- live evidence when the feature depends on editor internals;
- unit tests for pure calculations and contract validation.

A demo is evidence that a workflow is possible. It is not evidence that the API is production-safe, version-stable, or recoverable after failure.

## Success metrics

Track capability quality using these measures rather than tool count:

- successful end-to-end workflows;
- percentage of mutating tools with read-back verification;
- typed failure rate versus fabricated success rate;
- average round trips for compound workflows;
- bounded response compliance;
- live qualification coverage by Creator version;
- time from scene intent to verified scene state;
- number of slot-specific workflows completed without manual editor repair.

## Ownership rule

CCP owns the contract, safety policy, qualification evidence, and domain workflows. Creator owns the underlying editor/runtime behavior. External implementations are references only and must never become hidden dependencies.

## Related documents

- [ALX capability comparison](./alx-capability-comparison.md)
- [CCP usage](./ccp-code-mode-usage.md)
- [CCP API parity](./parity-v2-v3.md)
- [Tool portfolio candidates](./tool-portfolio-candidates.json)
