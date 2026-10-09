# Cocos Creator Retrieval Recipes

These recipes tell an agent **how to retrieve the right `cc_docs` context quickly**. They intentionally do not restate engine rules.

## Recipe 0 — Connect, retrieve, and hand off

1. Discover the MCP documentation tools available in this session. Confirm access using `list_corpora`; select `cc_docs` for engine knowledge, `fw_cc` for the team's framework.
2. Confirm the target engine version. For 3.7, the domain is `cocos-v3.7`; use `list_domains` to discover other supported domains.
3. Choose one or two topic rows from `creator-cookbook.md`. Translate Vietnamese intent to the English query seeds, retaining exact identifiers.
4. If the indexed path answers the task, use `read_doc` directly. Otherwise use a scoped concept search or exact lookup with the current MCP schema.

Concept search arguments:

```json
{"corpus":"cc_docs","domain":"cocos-v3.7","query":"Spine skeleton atlas import animation skin","top_k":3}
```

Exact lookup arguments:

```json
{"corpus":"cc_docs","domain":"cocos-v3.7","pattern":"UITransform","max_matches":5}
```

5. For `search_docs`, take the actual returned `result_id` and hit `idx` into `read_cached` with `window=1`, `max_tokens=2000`. For exact search, read the returned path using `read_doc`; do not assume exact search returns the same cache envelope.
6. Check the returned version, heading, and truncation. Read missing adjacent context if it changes the answer; a search snippet alone is not knowledge retrieval completion.
7. Answer a documentation question directly. For an implementation task, carry only the applicable constraints into the existing CCP workflow.

### Failure handling

| Observation | Next action |
|---|---|
| Docs tools absent / corpus not authorized | Report the missing docs connection/access. Do not register a guessed endpoint or reuse editor credentials. |
| Empty search | Shorten to concept + identifier; try exact search or a path from the inventory. Do not assume API absence. |
| Wrong version | Apply the correct domain filter; treat other versions as comparisons only. |
| Missing indexed path | Search by title/identifier in the same domain; repair the route only after verifying the returned path. |
| Missing heading | Read the document outline or document; select a heading that actually exists. |
| Expired cache result | Read the known path or repeat the scoped search. Never invent result IDs. |
| Truncated content | Narrow the section or expand the cached window within the tool limits. |
| Permission/connection error | Report it accurately; do not present a failed read as inspected knowledge. |

### Minimal context passed to implementation

```text
Task: user's requested behavior
Target: project + engine version + scene/asset identity when needed
Sources: corpus + exact path + heading actually read
Applicable guidance: only the constraints relevant to this task
Unknowns: unsupported version, missing access, or unresolved behavior
Verification: observable result to inspect after the requested action
```

Retain this context within the task; do not generate a new local engine-rule document.

## Recipe 1 — Scene organization

Search:

```text
Cocos Creator 3.7 scene node tree hierarchy rendering order Canvas Camera
```

Read:

- `v3.7/concepts/scene/node-tree.md`
- `v3.7/concepts/scene/node-component.md`
- `v3.7/concepts/scene/scene.md`

Then inspect the live scene tree before deciding where to add a node.

## Recipe 2 — Invisible or incorrectly rendered object

Search:

```text
Cocos Creator 3.7 object not visible Camera frustum layer visibility RenderRoot UITransform
```

Read:

- `v3.7/2d-object/2d-render/index.md`
- `v3.7/editor/components/camera-component.md`
- `v3.7/concepts/scene/layer.md`
- `v3.7/ui-system/components/engine/priority.md`

Inspect live: parent path, active state, components, layer, Camera visibility, transform, material/asset, and sibling order.

## Recipe 3 — Add UI

Search:

```text
Cocos Creator 3.7 UI Canvas UITransform Widget Layout Sprite Label
```

Read:

- `v3.7/2d-object/ui-system/index.md`
- `v3.7/ui-system/components/editor/canvas.md`
- `v3.7/ui-system/components/editor/ui-transform.md`
- relevant component page under `v3.7/ui-system/components/editor/`

Use the project’s existing Canvas structure. Query exact component definitions before mutation.

## Recipe 4 — Camera / multi-camera issue

Search:

```text
Cocos Creator 3.7 Camera projection visibility priority clear flags render target
```

Read:

- `v3.7/editor/components/camera-component.md`
- `v3.7/ui-system/components/engine/priority.md`
- `v3.7/concepts/scene/layer.md`

Inspect every relevant Camera/Canvas and compare layer/visibility, priority, rect, clipping, and clear flags.

## Recipe 5 — Lifecycle or initialization ordering

Search:

```text
Cocos Creator 3.7 component lifecycle execution order onLoad onEnable start update lateUpdate
```

Read:

- `v3.7/scripting/life-cycle-callbacks.md`
- `v3.7/scripting/component.md`
- `v3.7/scripting/decorator.md`

If ordering is load-bearing, prefer an explicit controller sequence and verify the actual registered components.

## Recipe 6 — Prefab / node creation

Search:

```text
Cocos Creator 3.7 prefab instance instantiate addComponent destroy node
```

Read:

- `v3.7/asset/prefab.md`
- `v3.7/scripting/create-destroy.md`
- `v3.7/scripting/component.md`

Inspect prefab ownership before editing. Instantiate under the intended live parent and read back the result.

## Recipe 7 — Assets and bundles

Search:

```text
Cocos Creator 3.7 assetManager load release Asset Bundle prefab SpriteFrame
```

Read:

- `v3.7/asset/asset-manager.md`
- `v3.7/asset/preload-load.md`
- `v3.7/asset/release-manager.md`
- `v3.7/asset/bundle.md`
- `v3.7/scripting/load-assets.md`

Identify asset owner and lifetime before choosing static Inspector wiring versus dynamic loading.

## Recipe 8 — Input and picking

Search:

```text
Cocos Creator 3.7 Node EventType input touch mouse keyboard bubbling capture raycast
```

Read:

- `v3.7/engine/event/event-node.md`
- `v3.7/engine/event/event-input.md`
- `v3.7/physics/physics-raycast.md`
- relevant Button/Toggle/BlockInputEvents pages

Classify the interaction as UI node event, global input, or 3D raycast before writing code.

## Recipe 9 — Animation and tween

Search:

```text
Cocos Creator 3.7 AnimationClip AnimationState animation event Tween easing
```

Read:

- `v3.7/animation/animation-component.md`
- `v3.7/animation/animation-state.md`
- `v3.7/animation/animation-event.md`
- `v3.7/tween/index.md`

Choose serialized timeline versus procedural tween based on ownership and timing requirements.

## Recipe 10 — Rendering performance

Search:

```text
Cocos Creator 3.7 UI batch material texture mask Graphics particle draw call
```

Read:

- `v3.7/ui-system/components/engine/ui-batch.md`
- `v3.7/material-system/overview.md`
- `v3.7/particle-system/renderer.md`
- `v3.7/render-pipeline/overview.md`

Measure first. Do not restructure the scene or introduce atlases/shaders only from intuition.

## Recipe 11 — Physics

Search:

```text
Cocos Creator 3.7 physics RigidBody collider contact event group mask raycast
```

Read:

- `v3.7/physics/physics.md`
- `v3.7/physics/physics-rigidbody.md`
- `v3.7/physics/physics-collider.md`
- `v3.7/physics/physics-event.md`
- `v3.7/physics/physics-group-mask.md`

Separate visibility problems from collision/filter problems; they are different systems.

## Recipe 12 — Version fallback

1. Confirm the target version and use its corpus domain filter.
2. For empty results, simplify the query, try `search_exact`, or read an inventoried path.
3. Consult another version only as comparison evidence; record the version mismatch.
4. Confirm API support in the target engine before applying cross-version guidance.
5. Inspect live component definitions for property names; do not equate an Inspector field with proof of all runtime behavior.
