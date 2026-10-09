# Cocos Creator MCP Knowledge Index

This file is a **retrieval index**, not a copy of Cocos Creator documentation. The source of truth is the `cc_docs` MCP corpus. Use the keywords and exact paths below to search/read the relevant knowledge before acting.

## MCP-first rule

For Cocos Creator questions, search `cc_docs` first. Prefer the exact `v3.7/` document when the project targets Cocos Creator 3.7. Read local project instructions and live editor state separately; this index does not replace either.

Recommended flow:

```text
classify task → search_docs(corpus="cc_docs") → read_doc/read_cached → inspect live editor → act → verify
```

Use `search_exact` for identifiers, component names, property names, error strings, and file names. Use `search_docs` for concepts and workflows.

## Retrieval map

| Task / question | Search keywords | Start with `cc_docs` paths |
|---|---|---|
| Scene tree, parent/child, node organization | `scene node tree hierarchy rendering order` | `v3.7/concepts/scene/node-tree.md`, `v3.7/concepts/scene/scene.md` |
| Node vs Component | `node component entity component system` | `v3.7/concepts/scene/node-component.md` |
| Transform / coordinate / parent space | `coordinate system transform position rotation scale` | `v3.7/concepts/scene/coord.md` |
| Layer and camera visibility | `Camera visibility node layer culling` | `v3.7/editor/components/camera-component.md`, `v3.7/concepts/scene/layer.md` |
| 2D renderable placement | `2D rendering RenderRoot2D UITransform renderable` | `v3.7/2d-object/2d-render/index.md` |
| Canvas and UI hierarchy | `UI Canvas UITransform Widget Layout` | `v3.7/2d-object/ui-system/index.md`, `v3.7/ui-system/components/editor/canvas.md` |
| UI draw order | `UI rendering order siblingIndex Canvas priority` | `v3.7/ui-system/components/engine/priority.md` |
| UI batching / draw calls | `2D batching material texture mask Graphics` | `v3.7/ui-system/components/engine/ui-batch.md` |
| Camera setup | `Camera projection frustum near far clear flags rect` | `v3.7/editor/components/camera-component.md` |
| Component lifecycle | `onLoad onEnable start update lateUpdate onDestroy` | `v3.7/scripting/life-cycle-callbacks.md` |
| Component order | `executionOrder component execution order` | `v3.7/scripting/component.md`, `v3.7/scripting/decorator.md` |
| Create/destroy nodes | `new Node instantiate destroy removeFromParent` | `v3.7/scripting/create-destroy.md` |
| Create/remove components | `addComponent removeComponent Component lifecycle` | `v3.7/scripting/component.md` |
| Inspector properties / references | `property decorator Inspector asset reference` | `v3.7/scripting/load-assets.md`, `v3.7/scripting/access-node-component.md` |
| Prefab workflow | `Prefab instance nested prefab apply revert unlink` | `v3.7/asset/prefab.md` |
| Dynamic assets | `assetManager resources load release preload` | `v3.7/asset/asset-manager.md`, `v3.7/asset/preload-load.md`, `v3.7/asset/release-manager.md` |
| Asset Bundles | `Asset Bundle bundle.load loadScene release` | `v3.7/asset/bundle.md` |
| Scene switching | `director loadScene preloadScene persistent node` | `v3.7/scripting/scene-managing.md` |
| Node touch/mouse events | `Node EventType touch mouse bubbling capture` | `v3.7/engine/event/event-node.md` |
| Global input | `input Input.EventType keyboard touch mouse` | `v3.7/engine/event/event-input.md` |
| 3D picking | `screenPointToRay PhysicsSystem raycast` | `v3.7/engine/event/event-input.md`, `v3.7/physics/physics-raycast.md` |
| Button / Toggle / input blocking | `Button Toggle BlockInputEvents event propagation` | `v3.7/ui-system/components/editor/button.md`, `v3.7/ui-system/components/editor/block-input-events.md`, `v3.7/engine/event/event-node.md` |
| Animation clips | `Animation AnimationClip AnimationState event` | `v3.7/animation/animation-component.md`, `v3.7/animation/animation-state.md`, `v3.7/animation/animation-event.md` |
| Tween | `Tween easing interface` | `v3.7/tween/index.md`, `v3.7/tween/tween-interface.md` |
| Audio | `AudioSource AudioClip playOneShot pause stop` | `v3.7/audio-system/overview.md`, `v3.7/audio-system/audiosource.md` |
| 3D model rendering | `MeshRenderer SkinnedMeshRenderer material mesh` | `v3.7/engine/renderable/model-component.md`, `v3.7/module-map/mesh/skinnedMeshRenderer.md` |
| Particles | `ParticleSystem renderer emitter module` | `v3.7/particle-system/index.md`, `v3.7/particle-system/renderer.md` |
| Materials / shaders | `material effect shader render pipeline` | `v3.7/material-system/overview.md`, `v3.7/shader/index.md`, `v3.7/render-pipeline/overview.md` |
| Physics | `RigidBody collider physics event group mask` | `v3.7/physics/physics.md`, `v3.7/physics/physics-rigidbody.md`, `v3.7/physics/physics-event.md` |
| Resolution adaptation | `Canvas design resolution Fit Width Fit Height Widget` | `v3.7/ui-system/components/engine/multi-resolution.md`, `v3.7/ui-system/components/engine/widget-align.md` |
| Editor extensions | `Cocos Creator editor extension Message Panel Project` | `v3.7/editor/extension/readme.md`, `v3.7/editor/extension/scene-script.md` |
| Build / publish | `Build Panel publish web native platform` | `v3.7/editor/publish/index.md`, `v3.7/editor/publish/build-guide.md` |
| Spine / skeleton import / skeleton not playing | `Spine skeleton atlas import animation skin` | `v3.7/asset/spine.md`, `v3.7/editor/components/spine.md` |
| DragonBones / armature | `DragonBones ArmatureDisplay skeleton asset` | `v3.7/asset/dragonbones.md`, `v3.7/editor/components/dragonbones.md` |
| Tile map / tile-based map | `TiledMap TiledTile TMX map asset` | `v3.7/asset/tiledmap.md`, `v3.7/editor/components/tiledmap.md` |
| Text / text overflow / font / text outline | `Label font overflow wrap RichText outline` | `v3.7/ui-system/components/engine/label-layout.md`, `v3.7/asset/font.md`, `v3.7/ui-system/components/editor/label-outline.md` |
| Scroll / dynamic list / grid | `ScrollView content Layout dynamic list` | `v3.7/ui-system/components/editor/scrollview.md`, `v3.7/ui-system/components/engine/list-with-data.md`, `v3.7/ui-system/components/editor/layout.md` |
| Responsive / misaligned UI / display notch | `Widget alignment SafeArea screen adaptation` | `v3.7/ui-system/components/editor/safearea.md`, `v3.7/ui-system/components/engine/widget-align.md` |
| Fade / opacity / clipping | `UIOpacity Mask clipping opacity` | `v3.7/ui-system/components/editor/ui-opacity.md`, `v3.7/ui-system/components/editor/mask.md` |
| Texture / missing image / atlas / image compression | `SpriteFrame texture compression atlas import` | `v3.7/asset/sprite-frame.md`, `v3.7/asset/compress-texture.md`, `v3.7/asset/auto-atlas.md` |
| UUID / missing reference / meta | `meta UUID asset reference missing resource` | `v3.7/asset/meta.md`, `v3.7/asset/asset-workflow.md` |
| 2D collision / collision not detected | `physics 2D collider contact callback rigidbody` | `v3.7/physics-2d/physics-2d.md`, `v3.7/physics-2d/physics-2d-contact-callback.md` |
| Light / shadows / sky / fog | `lighting shadow skybox fog` | `v3.7/concepts/scene/light.md`, `v3.7/concepts/scene/light/shadow.md`, `v3.7/concepts/scene/skybox.md`, `v3.7/concepts/scene/fog.md` |
| Terrain / landscape / LOD | `terrain level of detail LOD` | `v3.7/editor/terrain/index.md`, `v3.7/editor/rendering/lod.md` |
| Reflection / light probe / baking | `reflection probe light probe lightmap bake` | `v3.7/concepts/scene/light/probe/reflection-probe.md`, `v3.7/concepts/scene/light/lightmap.md` |
| Animation graph / state machine | `Marionette animation graph transition controller` | `v3.7/animation/marionette/index.md`, `v3.7/animation/marionette/state-transition.md` |
| Scheduler / timer / scheduled callback | `schedule scheduleOnce unschedule timer` | `v3.7/scripting/scheduler.md` |
| TypeScript / module / import errors | `tsconfig module import external npm` | `v3.7/scripting/tsconfig.md`, `v3.7/scripting/modules/index.md`, `v3.7/scripting/modules/config.md` |
| Localization / multiple languages | `L10N localization label translation` | `v3.7/editor/l10n/overview.md`, `v3.7/editor/l10n/script-using.md` |
| Data storage / HTTP / socket | `data storage HTTP WebSocket client` | `v3.7/advanced-topics/data-storage.md`, `v3.7/advanced-topics/http.md`, `v3.7/advanced-topics/websocket.md` |
| Hot update / asset updates | `hot update manifest AssetsManager` | `v3.7/advanced-topics/hot-update.md`, `v3.7/advanced-topics/hot-update-manager.md` |
| Native / JS bridge / memory leak | `native reflection JsbBridge memory leak profiler` | `v3.7/native/overview.md`, `v3.7/advanced-topics/jsb-bridge-wrapper.md`, `v3.7/advanced-topics/memory-leak-detector.md` |
| AR / VR / XR | `XR AR VR device interaction camera` | `v3.7/xr/index.md`, `v3.7/xr/architecture/index.md` |
| Video / WebView | `VideoPlayer WebView platform support` | `v3.7/ui-system/components/editor/videoplayer.md`, `v3.7/ui-system/components/editor/webview.md` |
| Preview / differs from editor | `preview debugging common error browser` | `v3.7/editor/preview/index.md`, `v3.7/editor/preview/preview-guid.md` |
| Build CLI / web packaging | `publish command line build web` | `v3.7/editor/publish/publish-in-command-line.md`, `v3.7/editor/publish/publish-web.md` |

## Intent and failure aliases

Translate the user's wording into a focused query; aliases are retrieval hints, not a diagnosis.

| User wording | Query seeds | Choose route |
|---|---|---|
| add, create, attach component | `create node addComponent Inspector` + component name | Node/component or specific component |
| move, reparent, incorrect position | `reparent local world coordinate transform` | Transform and scene tree |
| invisible, occluded, wrong layer | `invisible visibility rendering order` + object name | Visibility, then 2D or 3D rendering |
| cannot click, click-through, drag not working | `touch input hit test propagation` + control name | Input, ScrollView, blocking |
| clipped text, broken font, incorrect wrapping | `Label overflow font wrapping` | Text and layout |
| missing image, missing UUID, red prefab | `missing asset UUID meta prefab reference` | Assets/meta and prefab |
| runs twice, repeated callback, runs while disabled | `lifecycle event listener onEnable onDisable` | Lifecycle and events |
| lag, stutter, excessive draw calls | `profiling batching draw calls` + affected component | Performance; do not infer cause |
| no sound, autoplay not working | `AudioSource playback compatibility autoplay` | Audio; search platform name too |
| differs from preview, build failure, mobile-only failure | `preview build platform compatibility` + exact error | Preview/publish + target platform |
| connect MCP, tool not found, manual not found | `register_manual list_tools bootstrap` | Local `ccp3x` skill, not engine corpus |
| team slot framework, reel, GameMode | Framework class name | `fw_cc` corpus, not `cc_docs` |

Read a known path directly when it fits; search only when selection is uncertain or an error needs context. Select one or two related routes, not the entire keyword list. Reuse already-read, matching-version context in the current task.

If MCP is unavailable, report the failed retrieval; do not claim the source was read. Confirm tool schemas before composing calls. `cc_docs` needs corpus access; connecting to the editor's `ccp3x` manual does not itself provide that access.

## Search templates

### Concept lookup

```text
search_docs(
  corpus="cc_docs",
  query="Cocos Creator 3.7 <concept> <symptom>",
  domain="cocos-v3.7",
  top_k=8
)
```

### Exact API lookup

```text
search_exact(
  corpus="cc_docs",
  domain="cocos-v3.7",
  pattern="<identifier or property>",
  max_matches=5
)
```

### Read a known page

```text
read_doc(
  corpus="cc_docs",
  rel_path="v3.7/<path>.md",
  heading="<optional section>"
)
```

## Retrieval constraints

- Do not answer engine API questions from memory when a matching corpus page exists.
- Do not assume v2.4 APIs apply to 3.x.
- If a 3.7 search is empty, simplify keywords or try an exact identifier/direct indexed path first. Other versions are comparison evidence, not automatic permission to apply their APIs.
- If docs and live editor state disagree, report the discrepancy and treat live project state as authoritative for the current scene.
- Keep corpus snippets in working context only; do not duplicate large upstream pages into project docs.

## Router keys

Use these aliases as retrieval triggers. Combine one intent key, one object key, and one symptom/version key in the MCP query.

### Scene and hierarchy

`scene-tree`, `scene graph`, `hierarchy`, `parent child`, `node organization`, `node path`, `sibling order`, `siblingIndex`, `render order`, `draw order`, `depth order`, `scene root`, `empty node`, `container node`, `object placement`, `where to put node`

### Rendering and visibility

`renderable`, `render component`, `2D render`, `3D render`, `visible`, `invisible`, `not showing`, `does not render`, `RenderRoot2D`, `Canvas`, `UITransform`, `Sprite`, `Label`, `Graphics`, `Mask`, `RichText`, `Spine`, `DragonBones`, `MeshRenderer`, `SkinnedMeshRenderer`, `Camera`, `work camera`, `editor camera`, `runtime camera`, `frustum`, `near clip`, `far clip`, `layer`, `visibility`, `culling`, `clear flag`, `render target`, `multi camera`, `multi canvas`

### UI layout and interaction

`UI`, `HUD`, `popup`, `modal`, `overlay`, `dialog`, `button`, `toggle`, `scroll view`, `list`, `layout`, `widget`, `anchor`, `safe area`, `design resolution`, `screen adaptation`, `fit width`, `fit height`, `sliced sprite`, `UI opacity`, `hit test`, `touch area`, `input blocker`, `BlockInputEvents`, `event bubbling`, `event capture`, `event swallow`

### Scripting and lifecycle

`Component`, `ccclass`, `decorator`, `property`, `Inspector`, `onLoad`, `onEnable`, `start`, `update`, `lateUpdate`, `onDisable`, `onDestroy`, `executionOrder`, `addComponent`, `removeComponent`, `instantiate`, `new Node`, `destroy`, `removeFromParent`, `active`, `enabled`, `persistent node`, `singleton`, `manager`

### Assets, prefabs, and scenes

`asset`, `asset manager`, `resources`, `load asset`, `preload`, `release asset`, `dependency`, `SpriteFrame`, `Texture2D`, `Prefab`, `prefab instance`, `nested prefab`, `apply prefab`, `revert prefab`, `unlink prefab`, `Asset Bundle`, `bundle.load`, `loadScene`, `preloadScene`, `runScene`, `scene switch`, `scene loading`

### Input, animation, and audio

`input`, `global input`, `keyboard`, `mouse`, `touch`, `Node.EventType`, `Input.EventType`, `raycast`, `screenPointToRay`, `PhysicsSystem`, `Animation`, `AnimationClip`, `AnimationState`, `animation event`, `Tween`, `easing`, `AudioSource`, `AudioClip`, `playOneShot`, `pause audio`, `stop audio`

### Performance and rendering technology

`batching`, `draw calls`, `MeshBuffer`, `dynamic atlas`, `auto atlas`, `bitmap cache`, `material`, `effect`, `shader`, `GLSL`, `render pipeline`, `forward rendering`, `deferred rendering`, `post process`, `particle`, `particle renderer`, `VFX`, `performance`, `memory`, `texture compression`, `LOD`

### Physics and gameplay

`physics`, `2D physics`, `3D physics`, `RigidBody`, `collider`, `contact`, `trigger`, `collision`, `group mask`, `physics material`, `constraint`, `continuous collision`, `raycast`, `world object`, `actor`

### Project and editor operations

`project settings`, `design resolution`, `macro config`, `build`, `publish`, `web build`, `native build`, `mini game`, `editor extension`, `Editor.Message`, `panel`, `selection`, `inspector`, `scene panel`, `preview`, `screenshot`, `debug`, `diagnostic`, `missing asset`, `invalid script`

### Version and migration

`Cocos Creator 3.7`, `cc3.7`, `Cocos 3.x`, `v2.4 migration`, `upgrade guide`, `deprecated`, `API changed`, `version mismatch`, `3.0 upgrade`, `3.4 input`, `AudioSource migration`, `legacy API`

## Query composition examples

```text
scene-tree + renderable + work camera + Cocos Creator 3.7
popup + UITransform + event bubbling + BlockInputEvents
prefab instance + addComponent + apply/revert + Cocos Creator 3.7
invisible Sprite + RenderRoot2D + layer visibility + Camera
3D click + screenPointToRay + PhysicsSystem + raycast
animation event + AnimationState + Tween + lifecycle
```

When a query is ambiguous, use `search_docs` first. When it contains an exact API/class/property name, use `search_exact` first, then read the returned versioned page.
