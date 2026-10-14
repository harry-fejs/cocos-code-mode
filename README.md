# CCP 3x — Cocos Creator 3.7 (UTCP)

**CCP 3x** (formerly `cocos-code-mode-3x7`) turns the Cocos Creator Editor into an AI-controllable tool. It runs an HTTP server inside the editor that exposes scene manipulation, asset management, and property inspection as structured tool calls via [UTCP Protocol](https://www.utcp.io/) — letting AI agents build, inspect, and modify Cocos Creator projects the same way a developer would through the UI.
These tools are combined in [UTCP Code Mode](https://github.com/universal-tool-calling-protocol/code-mode/) environment to achieve maximum performance and token efficiency for AI agents, letting them call the tools in isolated JS sandbox.

## Quickstart

1. [Install extension](https://github.com/RomaRogov/cocos-code-mode/?tab=readme-ov-file#installation) in the Cocos Creator project
2. [Integrate](https://github.com/RomaRogov/cocos-code-mode/?tab=readme-ov-file#integration) extension with CodeMode MCP Server
3. Design a system prompt for you agent or use [provided example](https://github.com/RomaRogov/cocos-code-mode/blob/main/prompt_example.md)
4. Ask AI to help you and see how it learns!

## What is Code Mode?

In contrast to rigid MCP tool defenitions, which always kept in LLM context, CodeMode is an approach which helps AI to call tools in the most familiar way - by writing JavaScript code based on TypeScript defenitions of tools. This helps AI to keep token consumption low, implement loops and chained calls for complex tasks, organize output in compact form and reuse output from different existing servers and endpoints in one JavaScript execution context, isolating LLM context from unnecessary data.
This opens endless possibilities for interaction between different environments. Here is some examples:
1. Move scene from blender with [Blender MCP](https://github.com/ahujasid/blender-mcp), exporting particular objects as FBX straight into Cocos project
2. Use [Figma MCP](https://www.figma.com/mcp-catalog/) to fetch UI layout from figma and implement these layouts in your project in the smart way instead of blindly recreating every panel
3. Use [Unity Code Mode](https://github.com/RomaRogov/unity-code-mode) to perform game porting between engines
4. Bring your own examples 🙃

All this becomes possible with community-friendly, flexible and open solution from UTCP team: [CodeMode](https://github.com/universal-tool-calling-protocol/code-mode) and it's MCP Server.
You can read more about Code Mode concept in papers from [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp), [Apple](https://machinelearning.apple.com/research/codeact) and [Cloudflare](https://blog.cloudflare.com/code-mode/).

## Tools (88 — 10 consolidated replaces 26 legacy + 2 additive + 16 đợt 1 + 6 đợt 2 + 14 đợt 3 + 2 đợt 4 batch-read + 2 scene script health)

![Tools <> UI Mapping](tools_screenshot.jpg)

* **2.5:** +2 `sceneScriptHealthScan`/`sceneScriptRepair` for missing or invalid script components → **88**.
### Development build modes

`npm run build` stays readable. `npm run build:debug` compiles/copies and checks readable output, then applies pinned Terser 5.44.0 minification/local-identifier mangling and reruns Creator-load checks. Properties, exported tool strings and class/function names are preserved; no obfuscator or dependency/Python transform. Build provenance exposes `mode: readable | debug-minified`.

Private source maps live in ignored `.debug-maps/`, outside runtime `dist` and packaging inputs. Debug package: `npm run build:debug && node scripts/package.js`; ordinary `npm run package` intentionally rebuilds readable output. Rollback: run `npm run build`, then reload/restart the owned Creator extension. Minification changes size, not confidentiality or proven runtime performance.


| Category | Tools | Purpose |
|----------|-------|---------|
| **Scene** (15) | `sceneGetInfo`, `findNodesByAsset`, `findNodesWithMissingAssets`, `sceneScriptHealthScan`, `sceneScriptRepair`, `nodeReset`, `callComponentMethod`, `listComponentMethods`, `listComponentClasses`, `nodeClipboard`, `nodeGetTree`*, `nodeGetAtPath`, `nodeCreatePrimitive`, `nodeCreate`, `nodeOperate` | Hierarchy, prefab, script health and repair. *`nodeGetTree` bounded `maxDepth`=4/`maxNodes`=200 by default; `fields` filter |
| **Assets** (11) | `assetGetTree`*, `assetGetAtPath`, `assetResolvePath`, `assetReadContent`, `assetFindReferences`, `assetQuery`, `assetSaveContent`, `assetGetAvailableUrl`, `assetCreate`, `assetImport`, `assetOperate` | Browse/search/create/import/mutate. *`assetGetTree` bounded `maxDepth`=4/`maxNodes`=200 by default |
| **Inspector** (3) | `inspectorGet`*, `inspectorSet`*, `inspectorGetDefinition`* | Dump/set + TS definitions. *`fields[]`/`section` |
| **Components** (3) | `nodeGetAvailableComponentTypes`, `nodeComponentsGet`, `nodeComponentManage`* | Discover + attach |
| **Editor** (4) | `editorEnvInfo`, `editorViewport`, `editorSelect`, `editorHistory` + `editorQuery`*, `sceneManage`* | Viewport, selection, lifecycle |
| **Preview** (1) | `previewManage`* | `get_url`/`open_browser`/`asset_preview`/`scene_preview` (replaces 4: preview*, assetGetPreview, editorGetScenePreview) |
| **Program** (1) | `programManage`* | `get_info`/`open`/`open_url` (replaces 3: program*, urlOpen) |
| **Project** (1) | `projectManage`* | `get`/`set` (replaces 2: project*) |
| **Build** | `buildManage`, `buildSettingsManage`, `buildProfileManage` | Tasks/trigger/control; Creator defaults/cache preferences; reusable project build options |
| **Animation** (2) | `animationQuery`, `animationEdit` | Slim clip dumps |
| **Material/DB** (2) | `materialQuery`, `assetDbQuery` | Effects/pipeline |
| **System** (2) | `editorGetLogs`, `propertyArrayElement` | Logs, array ops |
| **Execute** (1) | `executeJavascript`* | Run JS in scene/editor context. *`safety_checks` regex guard on by default |
| **Diagnostics** (2) | `runScriptDiagnostics`, `getScriptDiagnosticContext` | TS compile check + source snippets for error triage |
| **Files** (6) | `projectReadFile`, `projectWriteFile`, `projectSearchFiles`, `projectReplaceInFile`, `projectFileExists`, `projectListDirectory` | Project-scoped file ops with path-safety |
| **UI** (4) | `createUiNode`, `createLabel`, `createButton`, `createSprite` | Create UI nodes from internal prefabs (Canvas/Label/Button/Sprite/etc.) |
| **Runtime** | `runtimeSessionLifecycle`, `runtimePreviewControl`, `runtimePause`, `runtimeResume`, `runtimeSetTimeScale`, `runtimeGetState`, state wait/assert/scenario helpers | Actual Creator Game View renderer; bounded lifecycle and verified state/time scale, never edit-renderer metrics |
| **Batch** (3) | `nodeBatchSet` + `sceneBatchGet`*, `assetBatchQuery` | Batch writes/reads (single snapshot / 1 HTTP). *`fields` filter |
| **Validation** (2) | `getPerformanceSnapshot`, `validateScene` | Scene health + perf counters |
| **Snapshot** (1) | `sceneSnapshot` | Full dump/diff (unbounded, fields filter) |
| **Events** (2) | `simulateButtonClick`, `bindButtonClickEvent` | Fire/attach cc.Button handlers |
| **Prefab JSON** (3) | `readPrefabJson`, `editPrefabJson`, `duplicatePrefab` | File-level prefab read/write/copy |
| **Instruction** (2) | `readProjectInstruction`, `writeProjectInstruction` | AGENTS.md/CLAUDE.md lifecycle |
| **Preference** (2) | `getEditorPreference`, `setEditorPreference` | Editor.Profile persistence |
| **Input Sim** (4) | `simulateKeyPress`, `simulateKeyCombo`, `simulateMouseClick`, `simulateMouseDrag` | Electron webContents input |
| **Screenshot** (3) | `captureSceneScreenshot`, `captureEditorScreenshot`, `listEditorWindows` | Scene/editor capture, window listing |
| **Consolidated** (10) | `inspectorGet/Set/Definition`, `nodeComponentManage`, `editorQuery`, `sceneManage`, `previewManage`, `programManage`, `projectManage`, `buildManage` | Replaces 26 legacy — now the only surface |

### Game View runtime (Creator 3.7.3)

Select **Game View** in the Creator preview toolbar before starting. `runtimeSessionLifecycle({operation:'start',targetKind:'game-view'})` returns a session bound to the actual runtime scene. Use its sessionId for pause/resume/step, observation, wait/assert and stop; reset releases only the local handle. Start waits boundedly for the selected preview renderer to finish reloading. Step requires pause and proves frame advancement.

`runtimeGetState` fails `RUNTIME_NOT_READY` when stopped; unavailable frame/time-scale metrics are null, never fabricated. Time scale accepts finite 0..10 and verifies the actual Game View scheduler. Scene/renderer identity changes fail closed. An ambiguous dispatched lifecycle outcome blocks further mutations until explicit `runtimePreviewControl({operation:'state'})` reconciles settled request and native postcondition; do not blindly retry. Runtime audio/particle/skeletal/animation-graph/localization playback and browser/simulator transports are not qualified by lifecycle support. Current evidence: `reports/game-view-runtime-reenable-20261011.json` (dirty readable hybrid Creator artifact, not clean release qualification).

Read-only runtime state observation retries only explicitly marked safe transient failures: at most **3 total attempts**, with 50/100ms backoff within the original caller deadline. Missing retry-safety metadata, unsupported/invalid inputs, target changes, `mutationDispatched:true`, unknown outcomes or callbacks that may complete are never automatically retried. Start/stop/control mutations are not replayed; reconcile actual state first.

Finite component routes use the attached Game View session and exact node/component/clip IDs: `audioPlaybackControl/Observe`, `particlePlayback`, `skeletalAnimationPlay/Events` (Animation/SkeletalAnimation only), and `animationGraphPreview` (inspect or typed float/integer/boolean variable read-back). Animation event observation is bounded and removes its listeners. Spine/DragonBones/ParticleSystem2D are not covered. `tweenSequenceControl` consumes only validated canonical descriptors/code metadata, never evaluates project source; start/stop/inspect own one sequence handle. Creator3.7 lacks isolated Tween pause/resume, so those operations fail rather than pausing unrelated target actions. Runtime binding diagnostics in `tweenSequenceValidate` require sessionId. Evidence scopes and latest installed replay limits are recorded in `reports/runtime-component-capabilities-20261012.json`.

Implementation-only additions: `skeletalAnimationPlay({operation:'observe', ...})` and `skeletalAnimationWaitForState` read one exact clip without playback mutation or event listeners. Wait requires at least one `playing`, `paused` or `minTime` condition; caller deadline is 100–10000ms. `buildTaskOutputInspect` derives the output directory from one successful native task and hashes 1–64 explicit expected files under a bounded byte budget. It returns `producerVerified:false`: task linkage is not producer freshness, packaging, device or launch proof. Full regression and Creator-live qualification remain deferred.

`localizationTableTextAudit` compares `{identifier}` placeholder names against an explicit base locale and optionally reports characters absent from a supplied repertoire. It reads official localization tables only. This is not ICU/printf validation, native font glyph extraction, shaping, layout, fallback resolution or runtime qualification; those gaps remain in the central API plan.

`animationGraphDiagnostics` reports undeclared variable references and conservative state entry paths from the existing bounded native graph inspector. Conditions are not evaluated, incomplete structures cannot prove an absent path, and native serializer/blend-tree/clip/runtime verification remains pending. `animationGraphValidate.valid` remains false.

Graph diagnostics also query unique directly inspected clip UUIDs through Asset DB, reporting missing assets, wrong types and identity drift. Query failure is not interpreted as absence; an empty clip set does not grant `directClipsValid`. This does not cover blend-tree descendants, imported output, bindings or runtime loading.

Graph diagnostics recheck graph Asset DB identity/path/type and source SHA-256 after clip queries. Changed source returns `GRAPH_SOURCE_CHANGED`, not mixed evidence. Bounded file-handle reads check size/time/file identity. Endpoint equality is not an atomic Asset DB transaction or proof against transient ABA changes.

* QA: `scripts/smoke-utcp.js` (expects 88) · Perf: `a769a46` bench + `e419276` trim.


### Build settings and reusable profiles

`buildSettingsManage` reads or writes allowlisted Creator `builder` preferences through `Editor.Profile`, with explicit `local` (default) or `global` scope. Supported keys are `common.name`, `common.server`, `common.platform`, `common.buildPath`, `common.debug`, `common.md5Cache`, `common.skipCompressTexture`, `common.sourceMaps`, `useBuildAssetCache`, `useBuildEngineCache`, `useBuildTextureCompressCache`, `useBuildAutoAtlasCache`, `supportTaskQueue`, and `serializedOptions.keepNodeUuid`. These defaults do not change existing task options. No SDK/NDK, signing credentials, project-settings filesystem fallback, or automatic build dispatch is provided.

`buildProfileManage` supports `list`, `get`, `save`, and `delete` for reusable **CCP-owned project profiles**, not native Creator task/preset assets. Each profile contains a supported `platform` and audited build options, with at most 32 profiles and 32 KiB per profile. Nested credential fields are rejected. Writes verify read-back and attempt restoration on failure; failed restoration returns `BUILD_PROFILE_ROLLBACK_FAILED`. Concurrent writes are rejected while one is pending. Retrieve profile `options` and explicitly pass them to `buildManage({operation:'trigger', options})` only when a build is intended. Creator-live persistence and actual build output qualification remain separate from offline/HTTP verification.

`buildTemplate({operation:'list'})` lists six targets: `web-mobile`, `web-desktop`, `android`, `ios`, `windows`, `mac`. `create` requires `platform`, `name` and real scene UUID/URL pairs; `startScene` defaults to the first supplied scene and must belong to that list. Debug templates enable source maps; release templates disable debug/source maps and Android debug signing. Android/iOS require a real `packageName` and put target options in `packages[platform]`. Android defaults to arm64-v8a; iOS targets iphoneos with Metal. Orientation defaults to landscape. Scene existence, remote bundle configuration, SDK/NDK/Xcode and release signing are not verified by generation; response requirements/readiness state those limits. Generate → save with `buildProfileManage` → inspect options → explicitly trigger is the intended workflow. Templates never persist or dispatch by themselves.

`buildManage` get/control, `buildTaskWait` and `buildLogInspect` accept a nonnegative safe integer or a bounded nonempty task-ID string and normalize it before IPC; returned summaries expose string IDs. Explicit trigger returns `submission:'submitted'` only for a usable returned ID. Invalid options are refused before dispatch; IPC failures and non-ID native responses return `BUILD_SUBMISSION_OUTCOME_UNKNOWN` with `retrySafe:false`. Inspect the builder queue before another submission; a missing acknowledgment does not prove no build started. Native submission semantics and exact Creator end-to-end qualification remain pending.

`buildPreflight({options})` queries Creator's registered target and bundle configuration and resolves each scene UUID and URL through Asset DB. It rejects mismatched identities, excluded start scenes, unsupported target compression and remote main bundles without an HTTP(S) server. It never dispatches, probes remote servers or certifies native toolchains/signing. `buildEnvironmentInspect` reads registered Android SDK/NDK/Java program metadata with paths redacted; missing Java registration is explicitly unavailable, not guessed from shell state. Environment writes remain unsupported pending restoration qualification.

`buildTaskConfigManage` gets or replaces one terminal native task's options. `set` requires the hash returned by `get`, unchanged task state, same platform and successful preflight; writes use Creator `builder/update-task` with read-back and rollback. This route changes in-memory task options only: `persisted:false`. It does not create native presets, persist task history or rebuild. Use CCP profiles for reusable persistent options.

### Tween project-code static workflow

`tweenSequenceCreate({filePath,sequence,write:true})` creates one new `assets/.../*.ts` source through Asset DB; existing sources/sidecars and path conflicts are refused. Descriptor version 1 supports bounded `to`/`by`/`delay` steps, declared easing, position/scale/eulerAngles vectors and explicit start/stop/repeat policy. Assign the generated component's target in the Inspector: descriptor UUID is static authoring intent, not runtime binding. No native tween asset or automatic attachment is claimed.

`tweenSequenceInspect` accepts exactly one descriptor or generated source path. It recognizes only the canonical generated representation without executing code. `tweenSequenceValidate` adds current-scene target diagnostics and reports static validity separately; `runtime:true` returns `RUNTIME_UNAVAILABLE`, not playback credit. Compilation, save/reopen, Inspector binding and runtime behavior require separate evidence.

### Prefab override/apply workflow

Use `prefabInstanceInspect({reference,maxOverrides})` to inspect the linked source SHA-256 and override count/truncation. Review overrides, then pass `source.sha256` as `expectedSourceSha256` to `prefabApplyOverrides`; source conflicts return `PREFAB_SOURCE_CONFLICT` before dispatch. Apply returns bounded serialized source changes and `sourceDiffTruncated`; `sceneSaved:false` explicitly means no scene save/reopen witness. This is the native override/apply workflow, not a new prefab variant asset. Apply affects all native supported overrides, not only the inspected response window. Full revert remains available; selective revert remains unsupported on Creator 3.7.3. Prefab validation now reports `totalReferences`, `complete` and `truncated`; capped validation never reports valid, and unavailable Asset DB inventory is an error. Persistence after scene reopen still requires an explicit disposable Creator witness.

Prefab inspection unwraps Creator property descriptors for both property and structural override arrays. `mountedChildren`, `mountedComponents`, `removedComponents` and `overrideCounts` expose each category; `totalOverrides` counts all four categories. Inspect/apply accept `maxBytes` (default 32768, range 2048..262144) for the whole serialized successful response. Oversized read-back is reduced to identity/name/active metadata and lists are shortened with `responseTruncated`, `readBackTruncated` and category truncation flags; source identities/hashes remain intact. A bounded inspection window does not limit what native apply changes.

### Verbose convention

Query/read tools return a compact default view; pass `verbose: true` to lift the cap and get the full output. Explicit numeric params (`maxDepth`, `maxNodes`, `limit`, `maxBytes`, `count`) still win when set.

| Tool | Default | `verbose=true` |
|------|---------|----------------|
| `nodeGetTree` / `assetGetTree` | depth 4 / 200 nodes | depth 99 / 10 000 nodes |
| `projectReadFile` / `readProjectInstruction` | 512 KB | 10 MB |
| `readPrefabJson` | 4 MB | 10 MB |
| `assetReadContent` | 512 KB | 10 MB |
| `projectSearchFiles` | 100 results | 1 000 |
| `getScriptDiagnosticContext` | limit 10 (ceiling 50) | ceiling 100 |

Caps live in `source/utcp/utils/verbose.ts`. Tools already exposing a caller-controlled knob (`assetQuery.limit`, `editorGetLogs.count`, `sceneSnapshot` 99/5000) need no flag — pass the number.


## How It Works

This extension architecture follows a **discover, then act** pattern. AI agents never guess at property names or component structures — they query for the real definitions first.

```
1. Get the scene tree         →  find the node you need
2. Get its type definition    →  learn its actual properties
3. Set properties by name     →  make precise changes
```

### Example

```typescript
// Example selected manual ccp3x_49650: register it and handshake before this chain.
const tree = ccp3x_49650.nodeGetTree({ maxDepth: 2, fields: ['name', 'active'] });
const ref = tree.children[0].reference;

// Single-class definition instead of full dump
const { definition } = await ccp3x_49650.inspectorGetDefinition({ target: 'instance', reference: ref, section: 'UITransform' });

// Unified get/set — no need to pick inspector*Instance vs inspector*Settings
const { dump } = await ccp3x_49650.inspectorGet({ target: 'instance', reference: ref, fields: ['position'] });
await ccp3x_49650.inspectorSet({ target: 'instance', reference: ref, propertyPaths: ['position.x'], values: [120] });

// 2.0.0: legacy removed — use consolidated names above.
```

### Missing or invalid script repair

Use the read-only scan first. It walks the open scene/prefab, compares each serialized component class against the editor's currently registered component classes, and returns the exact node path, component UUID, and class ID. Repair is deliberately explicit: pass the affected node plus component reference (or expected class ID), then provide either the replacement class ID or a script asset reference. The bridge verifies the replacement is registered, removes only the selected component, adds the replacement, snapshots for undo, and reads back the created component. A missing source script cannot be recreated automatically; restore the script asset or choose an existing registered replacement.

```typescript
const report = await ccp3x_49650.sceneScriptHealthScan({ limit: 200 });
const finding = report.findings[0];
await ccp3x_49650.sceneScriptRepair({
  nodeReference: finding.nodeReference,
  componentReference: finding.componentReference,
  expectedClassId: finding.classId,
  scriptReference: { id: 'restored-script-uuid', type: 'cc.Script' },
});
```

## Architecture

Identity glossary: `docs/architecture-identity.md` — `cce`/`ccpe`/`ccpi:ccp3x_<port>`/`ccpr`/`ccpt`/`cm`/`cmm`/`bd`/`prs` (C1-C4). Use explicit architecture roles. Chi tiết bootstrap/handshake/presence xem `docs/ccp-code-mode-usage.md`.

### Tool Execution (`ccpi` → `cce`, C3)

The extension (`ccpe`) runs an Express.js HTTP server (`exs`) on a configurable port (default: auto-assigned). Tool handlers (`ccpt`) execute asynchronously using Cocos Creator's Editor Message API — all editor interactions go through `Editor.Message.request`, which marshals calls to the appropriate editor subsystem.

- **Read tools** (GET) — query scene state and return structured data immediately.
- **Write tools** (POST) — mutate scene state and call `Editor.Message.request('scene', 'snapshot')` to register the change as an undoable step.

This means AI agents can safely chain read calls and batch writes without blocking the editor.

### Tool Discovery

Tools are TypeScript class methods decorated with `@utcpTool`. The `ToolRegistry` collects them at startup, builds JSON schemas from the inline definitions, and serves a UTCP manual at the `/utcp` endpoint.

```typescript
export class SceneTools {

    @utcpTool(
        'nodeGetTree',
        'Get the hierarchy tree of specific node or scene root if no reference is provided.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema
            }
        },
        SceneTreeItemSchema, "GET", ['scene', 'graph', 'node', 'hierarchy', 'tree']
    )
    async nodeGetTree(args: { reference?: IInstanceReference }): Promise<ISceneTreeItem> {
        // ...
    }
}
```

### Instance References

Nodes, components, and assets are passed around as lightweight UUID-based handles:

```typescript
{ id: "a1b2c3d4-...", type: "cc.Camera" }
```

Returned by tree queries, component lookups, and creation tools. Passed back to any tool that needs to target a specific object.

### TypeScript Definitions

Code Mode dynamically generates TypeScript class definitions from the live editor property dump. When an AI agent calls `inspectorGetInstanceDefinition`, it receives a complete TypeScript class with the correct field names, types, enums, and decorator hints — including `@property` attributes like `min`, `max`, `unit`, and `tooltip`.

```typescript
// Example output for a Transform-like node
export class Node {
    readonly uuid: string;
    /** World position */
    worldPosition: Vec3;
    /** World rotation (euler angles) */
    worldRotation: Vec3;
    worldScale: Vec3;
    active: boolean;
}
```

Components without special handling are reflected automatically from the serialized property dump. Common Cocos math types (`Vec2`, `Vec3`, `Vec4`, `Color`, `Rect`, `Quat`, `Mat4`, `Gradient`, etc.) are always available via `inspectorGetSettingsDefinition({ settingsType: 'CommonTypes' })`.

### Settings Inspection

Two special settings types can be inspected and modified directly:
- **`CurrentSceneGlobals`** — ambient light, skybox, shadows, and other scene-level rendering settings.
- **`ProjectSettings`** — engine and project configuration.

## Installation

### From release

1. Download last release from this repository.
2. Open Cocos Creator, go to **Extension → Extension Manager**, and click `Import Extension File(.zip)` button (icon with arrow).
3. Select the downloaded zip file.
4. The UTCP server starts automatically and registers itself in `~/.utcp_config.json` by default.

### Build from source

1. Clone this repository.
2. Install `node` and `npm`.
3. run
```bash
git clone https://github.com/romarogov/cocos-code-mode.git
cd cocos-code-mode
npm i
npm run package
```
4. If everything builds fine, `ccp3x.zip` file should appear in repository root.
5. Install it in Cocos Creator with **Extension Manager**.

### Development testing

For rapid iteration, link the project extension directory directly to this repository instead of repeatedly importing the packaged zip:

```powershell
npm run link:project -- "G:\path\to\cocos-project"
```

If the project already has an imported `ccp3x`, preserve it as a timestamped backup while replacing it:

```powershell
npm run link:project -- "G:\path\to\cocos-project" --replace
```

Then build from this repository with `npm run build`. Reload the extension from **Extension Manager** for ordinary changes. Restart Creator before testing changes that touch tool modules and scene scripts together: their module caches do not reload as one unit.

Do not use **Delete** in Extension Manager while the extension path is a junction; remove the junction from the filesystem instead.

### Breaking CCP identity migration

CCP uses package/profile namespace `ccp3x`, MCP key `ccp`, declaration `ccp3x.d.ts` (type-only namespace), per-port runtime manuals, and `.cocos-graph/ccp/`. No old package or declaration alias remains active. `link:project --replace` preserves old `cocos-pilot-3x` / `cc-bridge-3x` installs as inactive timestamped backups; bootstrap discards old metadata cache files rather than relabeling them as qualified CCP evidence.

Before installation, export settings from the old extension profile. Creator profile values are **not automatically migrated**: explicitly restore reviewed preferences (port, UTCP config path, tool profile, logging policy), saved build profiles, and reference-image records under the new `ccp3x` package. Existing old profile data is left intact, not deleted or silently claimed as migrated. Do not copy credentials or trust settings. Rebuild graph caches and register/handshake each intended endpoint again after the authorized cutover. Frozen reports, workflow ledgers, witness contracts, hashes, and generated historical catalogs describe the prior artifacts; their qualification does not transfer to renamed CCP source.

## Adding Custom Tools

You should add custom tools right in extension package and build it from source as described above.

Implementation example:

```typescript
import { utcpTool } from './utcp/decorators';

export class MyTools {

    @utcpTool(
        'myCustomTool',
        'Describe what this tool does',
        {
            type: 'object',
            properties: {
                input: { type: 'string' },
                count: { type: 'number', default: 10 }
            },
            required: ['input']
        },
        { type: 'object', properties: { result: { type: 'string' } } },
        "POST",
        ['custom', 'tags']
    )
    async myCustomTool(args: { input: string, count?: number }): Promise<{ result: string }> {
        // Implementation
    }
}
```

Register the class by importing it in `utcp-server.ts`. Tools are served automatically at startup. No additional registration needed.

## UTCP Call Templates Configuration

The extension provides a **Configuration** panel in the **CCP 3x** menu. It shows the current server port, the path to the UTCP config file, and lets you manage additional UTCP call templates for the Code Mode MCP.

You can find Call Template structures in [UTCP documentation](https://www.utcp.io/protocols):
- [MCP Call Template](https://utcp.io/protocols/mcp#call-template-structure)
- [HTTP Call Template](https://utcp.io/protocols/http#call-template-structure) ([Streamable](https://utcp.io/protocols/http#call-template-structure), [SSE](https://utcp.io/protocols/http#call-template-structure))
- [CLI Call Template](https://utcp.io/protocols/cli#call-template-structure)
- [Text Call Template](http://utcp.io/protocols/text#call-template-structure)

The extension publishes only `ccp3x_<port>` in `~/.utcp_config.json`; Creator 2.x uses `ccp2x_<port>`. There is no bare latest runtime alias. Internal API publication migrates bare `ccp3x` entries to their URL port and explicitly removes obsolete discovery names while preserving authenticated relay templates. Select the intended endpoint/project and register that exact per-port manual for each MCP session.

## Agent Prompt Guidance

Use the copy-ready instruction and mandatory `register_manual` bootstrap in the [CCP with Code Mode MCP guide](docs/ccp-code-mode-usage.md). The output rules below further reduce raw tree dumps by 50-80% while retaining useful references.

```text
When returning data from CCP 3x tools (manual `ccp3x_<port>`):
- Return stats/aggregates (counts, top-N) unless the question needs items.
- User asks list/find/which/show → return capped list with .slice(0, N), not count.
- Drop empty arrays/objects and deep subtrees a summary already answers.
- Keep reference/id for any node you may operate on in a next step (verbs: set/add/remove/destroy).
- If an aggregate looks anomalous (large branch, mixed active, errors), drill into that branch before concluding.
```

Full failure-mode analysis and trade-offs: [`docs/prompt-guidance-risks.md`](docs/prompt-guidance-risks.md).
Migration for consolidated tools (A1 shims → 45): [`docs/consolidated-migration.md`](docs/consolidated-migration.md).

See [CCP with Code Mode MCP](docs/ccp-code-mode-usage.md) for connection setup, manual registration, workflows, and troubleshooting.

### Graph-assisted scene changes

When available on the selected `ccpi:ccp3x_<port>`, use `graphManage(query/resolve)` for bounded T0/T1 lookup, then verify the candidate against that same endpoint/project and current `bd.iid` using `sceneGetInfo` plus `nodeGetTree` or inspector. The graph is advisory, never write authority. Resolve `<file>#<uuid>` to a bare engine UUID; never pass the composite handle to a live mutation tool. Make a narrow change with the live tool and read it back through the same endpoint. Cache is project-scoped at `<project>/.cocos-graph/ccp/`. This is workflow guidance, not evidence of registered tools or live release qualification; retain the `cmm` registration and handshake bootstrap above.

## Code Mode MCP Integration

CCP exposes its Cocos Creator tools through a UTCP manual. The [Code Mode MCP server](https://github.com/universal-tool-calling-protocol/code-mode/?tab=readme-ov-file#even-easier-ready-to-use-mcp-server) registers that manual for an AI client. Configure CCP, then have the agent call `register_manual` and verify with `list_tools`.

### MCP Server Config

```json
{
  "mcpServers": {
    "ccp": {
      "command": "npx",
      "args": ["@utcp/code-mode-mcp"],
      "env": {
        "UTCP_CONFIG_FILE": "~/.utcp_config.json"
      }
    }
  }
}
```

### Claude Code Configuration

To register Code Mode MCP for a Claude Code agent, open your project and run:

Linux/MacOS:
``` bash
claude mcp add --transport stdio --env UTCP_CONFIG_FILE="~/.utcp_config.json" -- ccp npx @utcp/code-mode-mcp
```

Windows:
``` powershell
claude mcp add --transport stdio --env UTCP_CONFIG_FILE="%userprofile%/.utcp_config.json" -- ccp cmd /c npx @utcp/code-mode-mcp
```

### Creator 3.8.8 native probe baking

`lightBakeManage` provides finite `start`, `inspect`, and owned `cancel` operations for native light-probe SH baking on Creator 3.8.8. Start binds the exact current edit-scene UUID and accepts no caller code or output path. The scene must contain 4–256 finite noncoplanar probes; GI samples are bounded to 64–1024, bounces to 1–4, and scale to 0–10. An existing native job or attached renderer debugger is refused.

Completion requires the original scene/native owner/output identity, native Finished without Error, closed process/timer/server, an actual result file, unchanged probe topology and nine finite changed RGB SH coefficients per probe. Native end broadcasts alone are not success. Output remains under the project `temp/ccp-bake/<jobId>` directory for caller inspection. Cancellation never falls back to a global foreign-job cancel; an uncertain timeout remains indeterminate rather than being retried.

This version-specific adapter inspects the installed native lightmap owner through a temporary Chromium debugger session and detaches afterward. It does not patch engine code, generate texture lightmaps, automatically save a scene, or authorize publish. Disposable public start/inspect/cancel, foreign-job refusal and saved/reloaded SH persistence evidence: `reports/native-probe-public-qualification-20261012.json`.
