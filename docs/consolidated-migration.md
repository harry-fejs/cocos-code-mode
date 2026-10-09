# Consolidated Migration — 2.0.x (68→45)

> **2.0.0:** 17 legacy removed → 51 (7 consolidated). **2.0.x delta:** 9 more legacy removed → **45 (10 consolidated)**. Total 26 legacy removed from A1 68. Legacy names 404.

## Mapping (10 consolidated replace 26 legacy — removed)

| Consolidated (keep) | Legacy removed | Status |
|---|---|---|
| `inspectorGet` | `inspectorGetInstanceProperties`, `inspectorGetSettingsProperties` | **removed 2.0.0** |
| `inspectorSet` | `inspectorSetInstanceProperties`, `inspectorSetSettingsProperties` | **removed 2.0.0** |
| `inspectorGetDefinition` | `inspectorGetInstanceDefinition`, `inspectorGetSettingsDefinition` | **removed 2.0.0** |
| `nodeComponentManage` | `nodeComponentAdd`, `nodeComponentRemove` | **removed 2.0.0** |
| `editorQuery` | `editorIntrospect`, `editorListTypes` | **removed 2.0.0** |
| `sceneManage` | `sceneOpen`, `editorOperate` (`save_scene_or_prefab`/`close`/`soft_reload`/`save_as` + preview ops) | **removed 2.0.0** |
| `buildManage` | `buildPanelOpen`, `buildGetTasksInfo`, `buildGetTask`, `buildTrigger`, `buildTaskControl` | **removed 2.0.0** |
| `previewManage` | `previewGetUrl`, `previewOpenInBrowser`, `assetGetPreview`, `editorGetScenePreview` | **removed 2.0.x** |
| `programManage` | `programGetInfo`, `programOpen`, `urlOpen` | **removed 2.0.x** |
| `projectManage` | `projectGetConfig`, `projectSetConfig` | **removed 2.0.x** |

**Count:** `68 - 26 = 45 = 35 standalone + 10 consolidated`.

## One-line codemod (1.x → 2.0.x)

```ts
// before (1.x legacy, now 404)
inspectorGetInstanceProperties({ reference, fields: ['position'] })
sceneOpen({ reference })
editorIntrospect({ category: 'ready' })
nodeComponentAdd({ reference, componentType: 'cc.Sprite' })
buildGetTasksInfo({})
previewGetUrl({})
programGetInfo({ programName: 'vscode' })
urlOpen({ url: 'https://...' })
projectGetConfig({ type: 'general' })
assetGetPreview({ reference })
editorGetScenePreview({ cameraPosition, targetPosition })

// after (2.0.x consolidated)
inspectorGet({ target: 'instance', reference, fields: ['position'] })
sceneManage({ operation: 'open', reference })
editorQuery({ category: 'ready' })
nodeComponentManage({ operation: 'add', reference, componentType: 'cc.Sprite' })
buildManage({ operation: 'tasks_info' })
previewManage({ operation: 'get_url' })
programManage({ operation: 'get_info', programName: 'vscode' })
programManage({ operation: 'open_url', url: 'https://...' })
projectManage({ operation: 'get', type: 'general' })
previewManage({ operation: 'asset_preview', reference })
previewManage({ operation: 'scene_preview', cameraPosition, targetPosition })
```

## `target` / `operation` enums

- `inspectorGet` `target`: `instance` | `CurrentSceneGlobals` | `ProjectSettings`
- `inspectorGetDefinition` `target`: `instance` | `CommonTypes` | `CurrentSceneGlobals` | `ProjectSettings`
- `sceneManage` `operation`: `open` | `save` | `save_as` | `close` | `soft_reload`
- `buildManage` `operation`: `panel_open` | `tasks_info` | `get_task` | `trigger` | `control`
- `previewManage` `operation`: `get_url` | `open_browser` | `asset_preview` | `scene_preview`
- `programManage` `operation`: `get_info` | `open` | `open_url`
- `projectManage` `operation`: `get` | `set`

## Notes

- Legacy method bodies kept (not registered) — consolidated delegates via `new LegacyTool().method()`.
- `ccp3x.d.ts` drops 26 legacy signatures, adds 10 consolidated.
- `maxDepth`/`maxNodes`/`fields[]`/`section`/`response-trimmer` unchanged.
