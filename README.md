# CCP 3x — Cocos Creator 3.7 bridge (UTCP)

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

## Tools (85 — 10 consolidated replaces 26 legacy + 2 additive + 16 đợt 1 + 6 đợt 2 + 14 đợt 3 + 2 đợt 4 batch-read)

![Tools <> UI Mapping](tools_screenshot.jpg)

> **2.0.x breaking:** 26 legacy tools removed (was 68 at A1 shims → 45 via 10 consolidated). Legacy 1.x clients must migrate — see `docs/consolidated-migration.md` + codemod. **2.1:** +1 `assetReadContent` (text read) → 46. **2.2:** +1 `executeJavascript` (JS escape hatch, safety-guarded) → 47. **Đợt 1:** +2 diagnostics +6 files +4 UI +4 runtime → **63**. **Đợt 2:** +1 batch +2 validation +3 screenshot → **69**. **Đợt 3:** +1 sceneSnapshot +2 events +3 prefabJSON +2 instruction +2 preference +4 input → **83**. **Đợt 4:** +2 `sceneBatchGet`/`assetBatchQuery` (batch-read) + perf (M1 parallel + M4 memo + `verbose=true` convention) → **85**.

| Category | Tools | Purpose |
|----------|-------|---------|
| **Scene** (13) | `sceneGetInfo`, `findNodesByAsset`, `findNodesWithMissingAssets`, `nodeReset`, `callComponentMethod`, `listComponentMethods`, `listComponentClasses`, `nodeClipboard`, `nodeGetTree`*, `nodeGetAtPath`, `nodeCreatePrimitive`, `nodeCreate`, `nodeOperate` | Hierarchy, prefab, clipboard. *`nodeGetTree` bounded `maxDepth`=4/`maxNodes`=200 by default; `fields` filter |
| **Assets** (11) | `assetGetTree`*, `assetGetAtPath`, `assetResolvePath`, `assetReadContent`, `assetFindReferences`, `assetQuery`, `assetSaveContent`, `assetGetAvailableUrl`, `assetCreate`, `assetImport`, `assetOperate` | Browse/search/create/import/mutate. *`assetGetTree` bounded `maxDepth`=4/`maxNodes`=200 by default |
| **Inspector** (3) | `inspectorGet`*, `inspectorSet`*, `inspectorGetDefinition`* | Dump/set + TS definitions. *`fields[]`/`section` |
| **Components** (3) | `nodeGetAvailableComponentTypes`, `nodeComponentsGet`, `nodeComponentManage`* | Discover + attach |
| **Editor** (4) | `editorEnvInfo`, `editorViewport`, `editorSelect`, `editorHistory` + `editorQuery`*, `sceneManage`* | Viewport, selection, lifecycle |
| **Preview** (1) | `previewManage`* | `get_url`/`open_browser`/`asset_preview`/`scene_preview` (replaces 4: preview*, assetGetPreview, editorGetScenePreview) |
| **Program** (1) | `programManage`* | `get_info`/`open`/`open_url` (replaces 3: program*, urlOpen) |
| **Project** (1) | `projectManage`* | `get`/`set` (replaces 2: project*) |
| **Build** (1) | `buildManage`* | Panel, tasks, trigger, control (replaces 5) |
| **Animation** (2) | `animationQuery`, `animationEdit` | Slim clip dumps |
| **Material/DB** (2) | `materialQuery`, `assetDbQuery` | Effects/pipeline |
| **System** (2) | `editorGetLogs`, `propertyArrayElement` | Logs, array ops |
| **Execute** (1) | `executeJavascript`* | Run JS in scene/editor context. *`safety_checks` regex guard on by default |
| **Diagnostics** (2) | `runScriptDiagnostics`, `getScriptDiagnosticContext` | TS compile check + source snippets for error triage |
| **Files** (6) | `projectReadFile`, `projectWriteFile`, `projectSearchFiles`, `projectReplaceInFile`, `projectFileExists`, `projectListDirectory` | Project-scoped file ops with path-safety |
| **UI** (4) | `createUiNode`, `createLabel`, `createButton`, `createSprite` | Create UI nodes from internal prefabs (Canvas/Label/Button/Sprite/etc.) |
| **Runtime** (4) | `runtimePause`, `runtimeResume`, `runtimeSetTimeScale`, `runtimeGetState` | Pause/resume game loop, time scale control |
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

* QA: `scripts/smoke-utcp.js` (expects 85) · Perf: `a769a46` bench + `e419276` trim.

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
// Preferred (consolidated): discover → set in one session
const tree = ccp3x_49650.nodeGetTree({ maxDepth: 2, fields: ['name', 'active'] });
const ref = tree.children[0].reference;

// Single-class definition instead of full dump
const { definition } = await ccp3x_49650.inspectorGetDefinition({ target: 'instance', reference: ref, section: 'UITransform' });

// Unified get/set — no need to pick inspector*Instance vs inspector*Settings
const { dump } = await ccp3x_49650.inspectorGet({ target: 'instance', reference: ref, fields: ['position'] });
await ccp3x_49650.inspectorSet({ target: 'instance', reference: ref, propertyPaths: ['position.x'], values: [120] });

// 2.0.0: legacy removed — use consolidated names above.
```

## Architecture

### Tool Execution

The extension runs an Express.js HTTP server on a configurable port (default: auto-assigned). Tool handlers execute asynchronously using Cocos Creator's Editor Message API — all editor interactions go through `Editor.Message.request`, which marshals calls to the appropriate editor subsystem.

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

Customer releases prohibit generic process launch. In addition to the existing fixed updater activation launcher, Windows protected-state storage has one bounded security exception: `source/protected/durable-file.ts` invokes the system PowerShell executable with a constant ACL script, passing only the path and file/directory flag through environment variables. It removes inherited access and enforces/verifies FullControl for the current user and SYSTEM only. Both the final renamed-package witness and release inventory require the unique `protected/durable-file.js` rename-map identity and the reviewed SHA-256 of the entire emitted module (`scripts/fixed-acl-witness.js`); adding a launcher or changing the command/ACL invalidates that approval. Source or compiler/minifier changes require reviewing the emitted code before updating the pin, never automatic repinning. This build witness is not signed installed/runtime evidence. Focused regression: `node --test tests/unit/fixed-acl-witness.test.js`.

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

### Installed-live protected qualification

The source witness (`verify-qualification-witness.js`) remains source-only and always refuses signed-live acceptance. Use the separate installed-live pair only against a genuinely updater-installed signed package:

```powershell
$env:CCP_INSTALLED_LIVE_CONFIG_PATH = 'C:\Users\you\.ccp\qualification\config.json'
node scripts/run-installed-live-qualification.js
node scripts/verify-installed-live-qualification.js
```

Before starting Creator, set `CCP_QUALIFICATION_TRACE_PATH` (fresh source NDJSON), `CCP_QUALIFICATION_LIVE_TRACE_PATH` (fresh signed live NDJSON), `CCP_QUALIFICATION_LIVE_RUN_ID` (fresh v4 UUID), and optionally `CCP_QUALIFICATION_MARKERS_PATH`. Trace paths must be absolute, inside the user home, not traverse links, and not already exist. Without this opt-in the authenticated `/qualification/identity` route and HTTP witness collection do not exist. Restarting requires fresh trace paths.

The private client config is JSON with `schemaVersion: 1`, matching `runId`, `projectPath`, `configPath` (UTCP config), `installedDirectory`, `releaseDirectory` (immutable updater release set containing `root.signed.json`, `target.signed.json`, `policy.signed.json` and the four release artifacts), `trustedRootPath` (raw canonical root payload), `trustedRootSha256` (independent trust pin), `devicePublicKeyDer` (independently approved enrolled device public key), `sourceTracePath`, `liveTracePath`, fresh `runPath`/`reportPath`, and `scenarios`. Each scenario specifies `id`, `toolId`, actual `inputs`, `expectedOutcome`, and `workflow` (`read`, `mutation`, `ten-step`, or `local-screenshot`); a stable `idempotencyKey` is optional. Inputs can consume a preceding actual HTTP result using `{ "$result": "scenario-id/path/to/field" }`. No node IDs or image data are fabricated. The canonical project registry selects the exact current port/session/token/Gateway and `/connection` must agree before and after the run.

The runner verifies trusted signatures, release artifact hashes, every installed file, descriptor/target/build identity, and the independent device-key pin before making scenario calls. It retains only approved metadata and hashes, not credentials, raw results, or screenshots. Signed device events bind real post-trim/envelope HTTP response bytes to the client hashes, protected dispatch phases, actual Creator IPC counters, Gateway response-byte hashes, ten executed command counts, and observed next-request completion telemetry. Device signatures authenticate local instrumentation, not hardware attestation.

To reverify immutable evidence without overwriting its original report or changing the pinned config, set `CCP_INSTALLED_LIVE_REPORT_PATH` to a fresh absolute report path. Per-operation runtime credit is separate from request-pointer projection audit: when a real observation reaches the 512-pointer cap, measured HTTP/counters/phases can earn runtime credit, but `payloadProjectionVerified: false` remains an overall unverified gap. Denied effectful calls may perform measured upfront observation IPC; denial credit requires zero **post-Gateway effect IPC**, not a fabricated zero total. Completion telemetry proves the observed signed next-request carrier only; inspect real Gateway persistence separately. Optional `large-result` scenarios specify `minimumHttpBytes` (at least 65536) and earn credit only from actually measured independent HTTP result bytes.

For canary credit, `markersPath` contains the existing marker policy fields (`label`, private `value`, `allowedInGatewayRequest`, `allowedSurfaces`) plus `sourceKind` (`operation-input`, `creator-observation`, or `local-result`). Inject the canary into the real selected input/Creator state/result, not a source fixture; signed instrumentation must observe that source. `surfacesPath` uses the existing six-surface manifest (`name`, absolute `root`, `files`); installed-live scans every file under each non-overlapping root, including undeclared files, with 32 MiB/file and 128 MiB/4096-file total limits. Capture real Gateway DB/logs/metrics, relay logs, update state and support-bundle snapshots before verification; source fixture contents are not live capture evidence. Absent or empty surfaces, unobserved injection, unavailable counters, HTTP errors/mismatches, missing workflows or telemetry produce explicit unverified gaps and `pass: false`. Screenshot credit is local-only, never a claimed Gateway round trip. Exit codes: runner `0` means collection finished, not acceptance; verifier `0` means all required evidence verified, `2` means a published partial report, `1` means rejected evidence.

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

The extension provides a **Configuration** panel in the **CCP 3x** menu. It shows the current server port, the path to the UTCP config file, and lets you manage additional UTCP call templates for the Code Mode MCP bridge.

You can find Call Template structures in [UTCP documentation](https://www.utcp.io/protocols):
- [MCP Call Template](https://utcp.io/protocols/mcp#call-template-structure)
- [HTTP Call Template](https://utcp.io/protocols/http#call-template-structure) ([Streamable](https://utcp.io/protocols/http#call-template-structure), [SSE](https://utcp.io/protocols/http#call-template-structure))
- [CLI Call Template](https://utcp.io/protocols/cli#call-template-structure)
- [Text Call Template](http://utcp.io/protocols/text#call-template-structure)

Connections are project-first: the canonical real Cocos project path (Windows case-normalized) determines a stable SHA-256 project identity and private `~/.ccp/local-auth/<project-id>.env` credential file. Each start rotates the relay session UUID and token; only `ccp3x_<port>` is registered, with namespaced token, session, port, and project variables. There is no global credential or latest-project pointer. Normal shutdown removes only its own active session registration and retains the project's dedicated port reservation. Another project cannot reuse that reserved port; a second live session for the same project is rejected.

Project connection metadata lives in a readable, pretty-printed `<UTCP-config-directory>/.ccp/project-connections.json`, not in UTCP variables. The registry contains `version: 1`, its owning `configPath`, and a `projects` map keyed by stable local path identity. Each binding contains `projectPath`, `projectId`, `port`, `relayInstanceId`, `tokenPath`, `ownerPid`, `active`, and nonsecret `gateway` context (`origin`, configured Gateway `projectId`, and optional explicitly configured `containerId`). The registry and ordinary SDK-compatible UTCP config are checked together under the shared config lock; disagreement fails closed. Separate custom config directories have separate registries. This local path identity is distinct from the Gateway's project ID. No container ID is inferred. `gateway.json` may contain a `projects` map keyed by canonical project paths; project-scoped records contain the existing Gateway configuration fields. If using a legacy single assignment, its optional `projectPath` must match the current editor. Global environment overrides remain explicit runtime configuration, not an inferred project assignment.

Live scripts require `CCP_PROJECT_PATH` or an explicit registered loopback endpoint, reject mismatched project/port metadata, and verify `/connection` before using it. `check-live-prereqs.js` uses the selected project's assigned Gateway, never a hardcoded other container. `@utcp/dotenv-loader` resolves namespaced variables on each access; the consuming Code Mode process must import that plugin and reload/register the current manual after a restart.

For per-session registrations or embedded project metadata (legacy `CCB_PROJECT_CONNECTIONS` is migration input only), build first, then run `node scripts/migrate-project-connections.js --dry-run --config <path>`; review its nonsecret report before `--apply`. Apply creates an exclusive config backup, serializes with editor config/registry writes, persists the external registry and a pretty JSON history report under `<UTCP-config-directory>/.ccp/migration-reports/` before removing embedded metadata or quarantined registrations from active config. Existing external project records must agree exactly; conflicts stop without mutation. Migration is idempotent. Reports retain unresolved offline CCP3x manual references and proven CCP UUID dotenv registration references separately from active project bindings. It does not infer projects from offline ports, copy secret template fields, delete credential files, or modify unrelated `ccp2x_<port>`/`ccp3x`. Occupied or inconclusive endpoints and unproven loaders stay active and are reported honestly. An abandoned `.ccp-lock` is never removed automatically: verify its owner is gone before manual recovery. Invalid JSON/config fails closed rather than being replaced by an empty configuration.

`node scripts/smoke-project-connections.js` exercises two isolated native HTTP servers with the actual UTCP SDK and dotenv plugin, including restart credential rotation, collision rejection, and stale cleanup. Set `CCP_UTCP_CONSUMER_ROOT` to an installed consumer's package root if that plugin is not installed in this extension. It never touches the real user config.

The CCP cutover is breaking: only `ccp3x` / `@ccp/gateway`, `CCP_*`, `x-ccp-*`, `/ccp/v1/*` and `CCP1` signing domains are current. Existing JWT grants, enrollment proofs, release signatures and installed-live evidence do not gain CCP validity through a text rename. Issue fresh authorized CCP product credentials/enrollment and a freshly signed `ccp3x` release; requalify separately. Neutral DTX issuer settings are unchanged.

For an offline registry (external or ownership-proven embedded metadata) whose credential files are all under the same explicitly owned legacy root, use `node scripts/migrate-ccp-identity.js --dry-run --config <absolute-config> --state-root <config-directory>/.cc-bridge`, review the report, then invoke the same command with `--apply`. It is never invoked automatically; use this cutover command directly for a legacy state root, not the current-registry externalizer above. It refuses live/unknown owner PIDs, occupied/unknown ports, links, destination conflicts, unowned registrations, credential roots outside that registry root, Gateway databases/sockets, and installed legacy extensions. Close Creator and preserve legacy extension directories **outside** `extensions` before installing CCP; link/install commands reject double loading. Apply preserves exclusive private config/state backups, migrates only ownership-proven credential namespaces and inactive dedicated port reservations, and archives all other old bytes under `.ccp/legacy-signed-state` without making them active trust. Interrupted publication fails closed on the destination conflict. Editor.Profile migration is explicitly refused because offline ownership is unavailable: select the intended CCP config/profile manually. Independent custom credential roots and stopped Gateway DB migration require separately verified ownership and are not inferred.

## Agent Prompt Guidance

Use the copy-ready instruction and mandatory `register_manual` bootstrap in the [CCP with Code Mode MCP guide](docs/ccp-code-mode-usage.md). The output rules below further reduce raw tree dumps by 50-80% while retaining useful references.

```text
When returning data from ccp3x_<port> tools (manual `ccp3x_<port>`):
- Return stats/aggregates (counts, top-N) unless the question needs items.
- User asks list/find/which/show → return capped list with .slice(0, N), not count.
- Drop empty arrays/objects and deep subtrees a summary already answers.
- Keep reference/id for any node you may operate on in a next step (verbs: set/add/remove/destroy).
- If an aggregate looks anomalous (large branch, mixed active, errors), drill into that branch before concluding.
```

Full failure-mode analysis and trade-offs: [`docs/prompt-guidance-risks.md`](docs/prompt-guidance-risks.md).
Migration for consolidated tools (A1 shims → 45): [`docs/consolidated-migration.md`](docs/consolidated-migration.md).

See [CCP with Code Mode MCP](docs/ccp-code-mode-usage.md) for connection setup, manual registration, workflows, and troubleshooting.

## Code Mode MCP Integration

CCP exposes its Cocos Creator tools through a UTCP manual. The [Code Mode MCP server](https://github.com/universal-tool-calling-protocol/code-mode/?tab=readme-ov-file#even-easier-ready-to-use-mcp-server) registers that manual for an AI client. Configure the bridge, then have the agent call `register_manual` and verify with `list_tools`.

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
