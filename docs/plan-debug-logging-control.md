---
status: pending
feature: debug-logging-control
---

# Debug Logging Control Implementation Plan

## Goal

Add a Configuration panel switch for per-project verbose interaction logging. Default OFF shows warnings/errors only; ON shows complete tool lifecycle metadata. Toggle applies without server restart.

## Scope

1. Add server debug state API with quiet/verbose filtering.
2. Load and persist `debugLogging` through `Editor.Profile` in `main.ts`.
3. Add extension message handlers for reading and setting state.
4. Add Configuration panel switch and status text.
5. Keep existing menu shortcut and debug JSONL viewer compatible.
6. Add unit and live Creator verification.

## Contract

- `debugLogging: boolean`, default `false`, project scoped.
- `start` and successful `complete` interaction events only emit when enabled.
- `warning` and `error` events always emit.
- Event payload contains metadata only; never request values or full response payloads.
- State changes are visible immediately and survive Creator restart for the same project.

## Files

- `source/utcp/utcp-server.ts`
- `source/main.ts`
- `source/panels/configuration/index.ts`
- `static/template/configuration/index.html`
- `static/style/configuration/index.css` if needed
- unit tests for server/main/panel contracts
- live Creator smoke test
- `docs/ccp-code-mode-usage.md`

## Verification

- Build.
- Full unit suite.
- Live panel/message toggle smoke test.
- Confirm quiet mode suppresses successful lifecycle logs and verbose mode restores them.
- Confirm errors remain visible in both modes.
