# Cocos Creator Agent Docs

Local fast-reference context for Cocos Creator work in this repository.

## Start here

1. [`creator-cookbook.md`](creator-cookbook.md) — topic keywords, English intent/symptom aliases, and versioned MCP paths.
2. [`creator-recipes.md`](creator-recipes.md) — retrieval procedures for recurring questions.
3. [`../../../../docs/ccp-code-mode-usage.md`](../../../../docs/ccp-code-mode-usage.md) — Code Mode / CCP bootstrap and tool usage.
4. [`../SKILL.md`](../SKILL.md) — skill entry point for MCP knowledge retrieval.
5. [`../../cc-scene-graph/SKILL.md`](../../cc-scene-graph/SKILL.md) — offline graph boundaries and live-read mutation contract.

## Agent routing

| Request | Read first |
|---|---|
| Where should a node/component/object go? | `creator-cookbook.md`: Retrieval map → Scene tree; recipe 1 |
| Add or repair a scene object | `creator-cookbook.md`: Intent and failure aliases |
| UI, popup, overlay, or click failure | `creator-recipes.md`: recipes 3, 8 |
| Prefab or dynamic asset | `creator-recipes.md`: recipes 6, 7 |
| Invisible object or camera issue | `creator-recipes.md`: recipes 2, 4 |
| Spine, localization, physics 2D, XR, native, build | `creator-cookbook.md`: Retrieval map |
| Cocos Editor automation | `ccp-code-mode-usage.md`, `ccp3x` skill |
| Offline hierarchy search | `cc-scene-graph` skill |
| Unknown 3.7 API/property/version behavior | Query the `cc_docs` corpus for the exact versioned page |

## Maintenance rule

- Keep local content a retrieval index, not an engine-rule copy.
- Add keywords and exact corpus paths when a repeated retrieval gap is found.
- Verify paths against the versioned corpus inventory and exercise representative searches.
- Select the engine version from the target project; validate matching corpus domain metadata.
- Editor MCP bootstrap and docs-corpus access are separate prerequisites.
