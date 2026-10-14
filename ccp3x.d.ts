// Instance reference should newer be kept in memory
// Agent-facing tool surface for Cocos Creator 3.7.x.
// Type-only documentation namespace: ccp3x. Runtime manuals use ccp3x_<port>.
// Register and call the exact per-port manual; no bare runtime latest alias exists.
// STATIC hand-written. See source/utcp/tools/*.ts for impl.

type InstanceReference = { id: string; type: string };

interface EditorPromptFieldBase { name: string; label: string; required?: boolean }
type EditorPromptField =
    | (EditorPromptFieldBase & { type: "text"; defaultValue?: string; maxLength?: number })
    | (EditorPromptFieldBase & { type: "select"; options: string[]; defaultValue?: string })
    | (EditorPromptFieldBase & { type: "confirm"; defaultValue?: boolean });

type AssetImportSettingValue = null | string | number | boolean | AssetImportSettingValue[] | { [key: string]: AssetImportSettingValue };
interface AssetImportSettingsSource {
    uuid: string;
    url: string;
    type: string;
    name: string;
    isDirectory: boolean;
}
interface AssetImportSettingDescriptor {
    path: string;
    type: string;
    readonly: boolean;
    visible: boolean;
    displayName?: string;
    enumValues?: AssetImportSettingValue[];
}
interface AssetImportSettingsSchema {
    importer: string;
    className: string;
    properties: AssetImportSettingDescriptor[];
    mutablePaths: string[];
}
interface AssetImportSettingsResult {
    reference: InstanceReference;
    importer: string;
    schema: AssetImportSettingsSchema;
    settings: { [key: string]: AssetImportSettingValue };
    source: AssetImportSettingsSource;
}
interface EngineApiDiscoveryArgs { operation?: 'records' | 'list_domains' | 'list_classes'; namespace?: 'engine-runtime' | 'engine-authoring' | 'editor-ipc' | 'bridge'; className?: string; targetVersion?: '3.7.3' | '3.8.8'; domain?: string; filter?: string; reference?: InstanceReference; maxEntries?: number; maxBytes?: number; cursor?: string }
interface EngineApiDiscoveryResult { version: string; operation: 'records' | 'list_domains' | 'list_classes'; coverage: { scope: string; fullCatalogLoaded: boolean; originalCatalogHash: string | null }; catalogHash: string; records: Array<Record<string, unknown>>; total: number; count: number; truncated: boolean; nextCursor: string | null; live: Record<string, unknown>; runtimeVerified: false; qualified: false }
interface ImportOutputEvidence { kind: 'source' | 'library'; extension: string; path: string; status: 'verified' | 'missing' | 'unreadable' | 'too_large' | 'changed' | 'empty'; bytes: number | null; sha256: string | null }
interface UiReflowEvidence {
    success: boolean; operation: 'reflow'; sceneSaved: false; complete: boolean;
    reference: InstanceReference; checkedNodes: number; changedNodeIds: string[];
    restoration: 'not-needed' | 'confirmed' | 'partial' | 'unknown';
    history: { status: 'not-requested' | 'snapshot-requested' | 'unknown'; undoRedoVerified: false };
    preservation: 'confirmed' | 'unknown'; before?: Record<string, unknown>[]; after?: Record<string, unknown>[];
    order?: Array<{ nodeId: string; componentType: 'cc.Layout' | 'cc.Widget' }>;
    error?: { code: string; message: string; mutationStarted: boolean };
}
interface NativeGraphInspection {
    reference: InstanceReference; format: 'native-creator-3.7' | 'legacy-synthetic' | 'unsupported';
    nativeShape: boolean; structuralValid: boolean; semanticsVerified: false; runtimeVerified: false;
    layers: Record<string, unknown>[]; stateMachines: Record<string, unknown>[]; states: Record<string, unknown>[];
    transitions: Record<string, unknown>[]; variables: Record<string, unknown>[]; conditions: Record<string, unknown>[];
    layerCount: number; stateMachineCount: number; stateCount: number; transitionCount: number; variableCount: number; conditionCount: number;
    issues: Array<{ code: string; path: string }>; truncated: boolean; limits: Record<string, number>; verificationScope: string;
}
interface IAssetTree {
    filesystemPath?: string;
    reference: InstanceReference;
    name: string;
    children: IAssetTree[];
    truncated?: string;
    childrenOmitted?: number;
    childrenCount?: number;
}
interface IHierarchyTree {
    path?: string;
    reference: InstanceReference;
    name: string;
    active: boolean;
    components: InstanceReference[];
    children: IHierarchyTree[];
    truncated?: string;
    childrenOmitted?: number;
    childrenCount?: number;
}

interface IExposedAttributes { type?: string, visible?: boolean, multiline?: boolean, min?: number, max?: number }
// Decorator for properties
declare function property(options: IExposedAttributes): any

// Cocos types
type Vector2 = { x: number; y: number };
type Vector3 = { x: number; y: number; z: number };
type Vector4 = { x: number; y: number; z: number; w: number };
type Quaternion = { x: number; y: number; z: number; w: number };
type Vec2 = Vector2;
type Vec3 = Vector3;
type Vec4 = Vector4;
type Quat = Quaternion;
type Mat3 = {
    m00: number; m01: number; m02: number;
    m03: number; m04: number; m05: number;
    m06: number; m07: number; m08: number;
}
type Mat4 = {
    m00: number; m01: number; m02: number; m03: number;
    m04: number; m05: number; m06: number; m07: number;
    m08: number; m09: number; m10: number; m11: number;
    tm12: number; m13: number; m14: number; m15: number;
}
type Color = { r: number; g: number; b: number; a: number; }
type Rect = { x: number; y: number; width: number; height: number; }
type Size = { width: number, height: number };
// The single difference between Unity and Cocos gradient is color represented as flat 3 numbers array (r, g, b)
type Gradient = { colorKeys: Array<{ color: Array<number>, time: number }>, alphaKeys: Array<{ alpha: number, time: number }>, mode: number }

/**
 * Cocos Editor Tools — 46 tools (36 standalone + 10 consolidated)
 * Legacy inspector/scene/editor/build + preview/program/project shims removed in 2.0.x — use consolidated entry points.
 */
declare namespace ccp3x {
    /** Remove or reorder ONE element of an array-valued property by index. Use instead of inspectorSet, which replaces the whole array and loses object references. */
    function propertyArrayElement(args: {
        operation: "remove" | "move",
        reference: InstanceReference,
        propertyPath: string,
        index: number,
        toIndex?: number
    }): { success: boolean, error?: string };

    /** Get the asset and subAsset hierarchy tree. Pass maxDepth/maxNodes to bound wide scenes (truncated branches set truncated/childrenOmitted). */
    function assetGetTree(args: {
        reference?: InstanceReference,
        assetPath?: string,
        maxDepth?: number,
        maxNodes?: number
    }): IAssetTree;

    /** Get asset reference by given local path and name. */
    function assetGetAtPath(args: { assetPath: string }): { reference: InstanceReference };

    /** Resolve asset locations (uuid <-> db:// url <-> filesystem path) and probe existence. Accepts uuid (reference) OR db:// path (assetPath). */
    function assetResolvePath(args: { reference?: InstanceReference, assetPath?: string }): { filesystemPath: string, url?: string, uuid?: string, exists: boolean, isDirectory?: boolean, type?: string, importer?: string };

    /** Read text content of an asset by uuid or db:// path. Rejects binary/oversized files; use maxBytes to raise the cap. */
    function assetReadContent(args: { reference?: InstanceReference, assetPath?: string, maxBytes?: number }): { content: string, filesystemPath: string, bytes: number, truncated: boolean };

    /** Asset-level dependency analysis: used_by = assets/scripts referencing this asset (who breaks if deleted), depends_on = assets it references. Wider than findNodesByAsset, which only scans the open scene. */
    function assetFindReferences(args: {
        direction: "used_by" | "depends_on",
        reference: InstanceReference,
        assetKind?: "asset" | "script" | "all",
        resolveUrls?: boolean
    }): { references: InstanceReference[], assets?: { uuid: string, url?: string, type?: string }[], total: number };

    /** Search the asset database with filters (glob pattern, ccType, importer, extname, isBundle). At least one filter required. */
    function assetQuery(args: {
        pattern?: string,
        ccType?: string,
        importer?: string,
        extname?: string,
        isBundle?: boolean,
        limit?: number
    }): { assets: { uuid: string, name: string, url: string, type: string, importer?: string, isDirectory: boolean }[], total: number, truncated: boolean };

    /** Read bounded importer-specific settings, typed property descriptors, and explicit source identity for one asset. */
    function assetImportSettingsGet(args: { reference: InstanceReference }): AssetImportSettingsResult;

    /** Preflight and set one typed mutable importer property, reimport, and verify read-back. */
    function assetImportSettingsSet(args: {
        reference: InstanceReference,
        path: string,
        value: AssetImportSettingValue
    }): {
        changed: boolean,
        path: string,
        previous: AssetImportSettingValue,
        readBack: AssetImportSettingValue,
        result: AssetImportSettingsResult,
        settingsSaved: boolean,
        importComplete: boolean | null,
        generatedOutputVerified: boolean | null,
        retrySafe: false,
        importCompletion: { signal: 'asset-db/is-busy' | 'unsupported' | 'unavailable' | 'not_requested'; polls: number },
        outputs: ImportOutputEvidence[],
        outputsTruncated: boolean
    };

    /** Assign a platform-aware Creator texture-compression preset and return deterministic reimport evidence. */
    function assetCompressionConfigure(args: {
        reference: InstanceReference,
        presetId: string,
        platform: "miniGame" | "web" | "ios" | "android" | "pc"
    }): {
        changed: boolean,
        reference: InstanceReference,
        presetId: string,
        previousPresetId: string | null,
        platform: "miniGame" | "web" | "ios" | "android" | "pc",
        formats: { format: string, quality: string | number }[],
        sourceSha256: string,
        generatedOutputs: { extension: string, path: string, bytes: number, sha256: string }[],
        buildArtifactVerified: boolean
    };

    /** Export a bounded deterministic asset manifest with dependencies, source hashes, and explicit exclusions. */
    function assetManifestExport(args: {
        assetPath?: string,
        maxAssets?: number,
        maxFileBytes?: number
    }): {
        assets: {
            uuid: string,
            url: string,
            type: string,
            importer: string,
            name: string,
            isSubAsset: boolean,
            dependencies: string[],
            dependenciesTruncated: boolean,
            bytes: number,
            sha256: string
        }[],
        exclusions: {
            uuid: string,
            url: string,
            reason: "source-file-unavailable" | "source-file-too-large" | "hash-failed",
            bytes?: number,
            maxFileBytes?: number
        }[],
        truncated: boolean,
        count: number,
        total: number
    };

    /** Analyze project-wide serialized asset reachability from scene/prefab roots with bounded graph evidence. */
    function assetUsageAnalyze(args: {
        assetPath?: string,
        maxAssets?: number,
        maxGraphAssets?: number,
        rootReferences?: InstanceReference[]
    }): {
        graphVersion: "v4",
        complete: boolean,
        roots: { id: string, url: string, type?: string }[],
        graphAssets: number,
        graphEdges: number,
        graphTruncated: boolean,
        exclusions: { uuid: string, url: string, reason: string }[],
        candidates: {
            uuid: string,
            url: string,
            type?: string,
            confidence: "serialized-project-unreachable",
            referenceCount: number,
            references: InstanceReference[]
        }[],
        checkedAssets: number,
        referenceEvidence: {
            uuid: string,
            url: string,
            type?: string,
            status: "root-reachable" | "project-unreachable",
            root: boolean,
            referenceCount: number,
            references: InstanceReference[]
        }[],
        dynamicLoadCaveat: string
    };

    /** Overwrite the content of an existing text-based asset (TypeScript, JSON, effect, txt...). Identify by db:// path or uuid. Binary not supported. */
    function assetSaveContent(args: { assetPath?: string, reference?: InstanceReference, content: string }): { reference: InstanceReference, filesystemPath?: string };

    /** Returns an available (non-colliding) db:// url for a desired path - appends suffix if an asset exists there. */
    function assetGetAvailableUrl(args: { assetPath: string }): { url: string };

    /** Create empty asset or folder of given type. */
    function assetCreate(args: {
        assetPath: string,
        preset: "folder" | "material" | "effect" | "scene" | "prefab" | "typescript" | "animation-clip" | "render-texture" | "physics-material" | "animation-graph" | "animation-graph-variant" | "animation-mask" | "auto-atlas" | "effect-header" | "label-atlas" | "terrain",
        options?: { overwrite?: boolean, rename?: boolean }
    }): { reference: InstanceReference };

    /** Import an external file as an asset into the project. */
    function assetImport(args: {
        sourceFilesystemPath: string,
        targetAssetPath: string,
        imageType?: "raw" | "texture" | "normal-map" | "sprite-frame" | "texture-cube",
        options?: { overwrite?: boolean, rename?: boolean }
    }): { reference: InstanceReference };

    /** Perform operations on assets (move, copy, delete, open, refresh, reimport, save_meta). */
    function assetOperate(args: {
        operation: "move" | "copy" | "delete" | "open" | "refresh" | "reimport" | "save_meta" | 'stage_import_setting' | 'apply_import_settings' | 'restore_import_settings',
        reference: InstanceReference,
        targetAssetPath?: string,
        /** save_meta only: meta object (or JSON string) read via assetDbQuery "meta", then mutated. */
        meta?: any,
        path?: string,
        value?: AssetImportSettingValue,
        options?: { overwrite?: boolean, rename?: boolean }
    }): { reference: InstanceReference; lifecycle?: { cachedChanged?: true; sourcePersisted?: boolean; sourceSha256?: string; restored?: true; sourceBytesRestored?: true } };

    /** Import a bounded batch and return an outcome for every item. */
    function assetBatchImport(args: {
        items: {
            sourceFilesystemPath: string,
            targetAssetPath: string,
            imageType?: "raw" | "texture" | "normal-map" | "sprite-frame" | "texture-cube",
            options?: { overwrite?: boolean, rename?: boolean }
        }[]
    }): {
        outcomes: { index: number, ok: boolean, reference?: InstanceReference, error?: { code: string, status: number, message: string } }[],
        succeeded: number,
        failed: number,
        partial: boolean
    };

    /** Apply a bounded batch of asset operations with per-item recovery evidence. */
    function assetBatchOperate(args: {
        items: {
            operation: "move" | "copy" | "delete" | "open" | "refresh" | "reimport" | "save_meta",
            reference: InstanceReference,
            targetAssetPath?: string,
            meta?: any,
            options?: { overwrite?: boolean, rename?: boolean }
        }[]
    }): {
        outcomes: { index: number, ok: boolean, reference?: InstanceReference, error?: { code: string, status: number, message: string } }[],
        succeeded: number,
        failed: number,
        partial: boolean
    };

    /** Audit all bounded project scenes for serialized UUID references missing from the asset database. */
    function assetMissingReferenceAudit(args?: {
        assetPath?: string,
        maxScenes?: number,
        maxReferences?: number
    }): {
        complete: boolean,
        scannedScenes: number,
        missingReferences: { source: { uuid: string, url: string }, referenceId: string, line: number }[],
        exclusions: { uuid: string, url: string, reason: string, bytes?: number, error?: string }[],
        truncated: boolean,
        dynamicLoadCaveat: string
    };

    function referenceImageManage(args: { operation: "inspect" | "set" | "clear", reference?: InstanceReference, imagePath?: string }): { operation: string, supported: boolean, persisted: boolean, imagePath?: string | null, reference?: InstanceReference | null, result?: unknown };
    function prefabOverrideDiff(args: { reference: InstanceReference, baselineReference: InstanceReference }): { equal: boolean, changes: { path: string, identity: string, before: unknown, after: unknown }[], source: unknown, baseline: unknown };
    function prefabReferenceAudit(args: { reference: InstanceReference, maxReferences?: number }): { valid: boolean, nestedPrefabs: unknown[], missingReferences: unknown[], source: unknown };
    function sceneReferenceValidate(args: { reference: InstanceReference, maxReferences?: number }): { valid: boolean, references: string[], missingReferences: string[], source: unknown };
    function prefabInstantiate(args: { reference: InstanceReference, parentReference?: InstanceReference, name?: string }): { reference: InstanceReference, source: { id: string, url: string }, persisted: boolean, readBack?: unknown };
    function prefabApplyOverrides(args: { reference: InstanceReference, operation?: 'apply' | 'removed_component_apply', fileID?: string, expectedSourceSha256?: string, maxBytes?: number }): { reference: InstanceReference, operation: 'apply' | 'removed_component_apply', persisted: boolean, readBack: unknown, sourceReadBack: { id: string, url: string, beforeSha256: string, afterSha256: string }, sourceChanges?: Array<{ path: string; before: unknown; after: unknown }>, sourceDiffTruncated?: boolean, responseTruncated: boolean, readBackTruncated?: boolean, sceneSaved: false, outcome?: 'verified', rollbackStatus?: string, fileID?: string };
    function prefabInstanceInspect(args: { reference: InstanceReference; maxOverrides?: number; maxBytes?: number }): { reference: InstanceReference; isPrefabInstance: boolean; prefabReference: InstanceReference | null; overrides: unknown[]; mountedChildren: unknown[]; mountedComponents: unknown[]; removedComponents: unknown[]; overrideCounts: Record<'propertyOverrides' | 'mountedChildren' | 'mountedComponents' | 'removedComponents', number>; totalOverrides: number; truncated: boolean; responseTruncated: boolean; readBackTruncated: boolean; source: { id: string; url: string; sha256: string } | null; readBack: unknown };
    /** Full restore remains distinct; selective removed-component restore uses an authoritative prefab fileID. Nonempty arbitrary paths remain unsupported. */
    function prefabRevertOverrides(args: { reference: InstanceReference, operation?: 'revert' | 'removed_component_revert', fileID?: string, paths?: string[], maxBytes?: number }): { reference: InstanceReference, operation: 'revert' | 'removed_component_revert', persisted: boolean, readBack: unknown, sourceReadBack: { id: string, url: string, beforeSha256: string, afterSha256: string }, sceneSaved?: false, outcome?: 'verified', rollbackStatus?: string, fileID?: string };
    function prefabInfo(args: { reference?: InstanceReference, assetPath?: string }): { reference: InstanceReference, url: string, uuid: string, rootNode: unknown, totalEntries: number, components: string[], references: string[] };
    function prefabValidate(args: { reference?: InstanceReference, assetPath?: string, maxReferences?: number }): { valid: boolean, complete: boolean, truncated: boolean, totalReferences: number, reference: InstanceReference, url: string, uuid: string, references: string[], missingReferences: { id: string }[], issues: { code: string, id: string }[], totalEntries: number };
    function tilemapInspect(args: { reference: InstanceReference, maxLayers?: number }): { reference: InstanceReference, format: "tmx", map: Record<string, unknown>, tilesets: Record<string, unknown>[], layers: Array<{ id: string, name: string, width: number, height: number, visible: boolean, opacity: number, offsetX: number, offsetY: number, tileCount: number }>, objectGroups: Array<{ id: string, name: string, objects: Array<{ id: string, name: string, type: string, x: number, y: number, width: number, height: number }> }>, count: number };
    function tilemapLayerEdit(args: { reference: InstanceReference, path: `layers.${string}.${string}`, value: unknown }): { reference: InstanceReference, path: string, changed: boolean, previous: unknown, readBack: unknown, persisted: boolean, source: { url: string, beforeSha256: string, afterSha256: string } };
    function tilemapObjectEdit(args: { reference: InstanceReference, path: `objects.${string}.${string}`, value: unknown }): { reference: InstanceReference, path: string, changed: boolean, previous: unknown, readBack: unknown, persisted: boolean, source: { url: string, beforeSha256: string, afterSha256: string } };
    function tilemapValidate(args: { reference: InstanceReference }): { reference: InstanceReference, valid: boolean, missingReferences: { id: string }[], checkedNodes: number, source: { url: string, sha256: string, references: string[] } };
    function spriteAtlasConfigure(args: { reference: InstanceReference, presetId: "default" | "MaxRects" | "Basic", maxWidth?: number, maxHeight?: number }): { reference: InstanceReference, presetId: string, changed: boolean, operations: unknown[], generatedOutputs: { path: string, bytes: number, sha256: string }[], sourceSha256: string, settings: Record<string, unknown>, persisted: boolean };
    function uiAccessibilityAudit(args: { root?: InstanceReference, rootPath?: string, maxNodes?: number, maxIssues?: number }): { complete?: boolean, valid?: boolean, truncated?: boolean, checkedNodes?: number, root?: { uuid: string, path: string, name: string }, nodes?: unknown[], issues?: unknown[], truncation?: unknown[], error?: { code: string, message: string, evidence: Record<string, unknown> } };
    function uiResponsivePreview(args: { resolutions: { width: number, height: number }[], reference?: InstanceReference }): { supported: boolean, comparisons: Array<{ resolution: { width: number, height: number }, scale: { x: number, y: number }, projectedRects: unknown[], evidence: string }>, stable: boolean, caveat: string };
    /** Rejects with UNSUPPORTED_PREVIEW_IPC on Creator 3.7.3 because preview:set-resolution is not exposed. */
    function previewResolutionSet(args: { width: number, height: number }): { width: number, height: number, persisted: boolean, supported: boolean, readBack?: unknown };
    function editorUndoTransactionProbe(): { supported: boolean, boundaries: string[], clean: boolean };
    function broadcastObserve(args: { topic: "ccp3x:probe" | "scene:change" | "asset-db:change" }): { topic: string, supported: boolean, observed: boolean, lifecycle: string[], event: unknown, eventBytes: number, truncated: boolean, retainedListener: false };

    /** Get list of globally available component types. */
    function nodeGetAvailableComponentTypes(args: {
        includeInternal: boolean,
        filter?: string
    }): { componentTypes: string[] };

    /** Get components of specific type on a node. */
    function nodeComponentsGet(args: {
        reference: InstanceReference,
        componentType?: string
    }): { references: InstanceReference[] };

    /** Get info about the current scene: bounds (canvas/scene size), unsaved changes (dirty), and which scene asset is open. */
    function sceneGetInfo(): { bounds: { x: number, y: number, width: number, height: number }, dirty: boolean, currentScene?: { uuid?: string, url?: string, name?: string } };

    /** Find all nodes in the current scene that reference the given asset uuid (reverse-reference / impact analysis). */
    function findNodesByAsset(args: { reference: InstanceReference }): { references: InstanceReference[] };

    /** Find all nodes whose asset references are missing/broken. QA/health check for scene integrity. */
    function findNodesWithMissingAssets(): { references: InstanceReference[] };

    /** Scan the open scene/prefab for unregistered script classes and return exact node paths plus repair inputs. */
    function sceneScriptHealthScan(args?: { limit?: number }): {
        findings: {
            nodeReference: InstanceReference,
            nodeName: string,
            nodePath: string,
            componentReference?: InstanceReference,
            classId: string,
            repair: string
        }[],
        total: number,
        truncated: boolean
    };

    /** Replace one invalid script component with an existing registered class or script asset. */
    function sceneScriptRepair(args: {
        nodeReference: InstanceReference,
        componentReference?: InstanceReference,
        expectedClassId?: string,
        replacementClassId?: string,
        scriptReference?: InstanceReference
    }): { success: boolean, removedComponent?: string, createdComponent: InstanceReference };

    /** Reset nodes, one component, or one property to defaults. operation property needs a single uuid + propertyPath. */
    function nodeReset(args: { operation: "node" | "component" | "property", references: InstanceReference[], propertyPath?: string }): { success: boolean, error?: string };

    /** Execute a method on a component by its uuid. Arguments and return value must be JSON-serializable. Get the component uuid via nodeComponentsGet. */
    function callComponentMethod(args: { reference: InstanceReference, methodName: string, methodArgs?: any[] }): { result: any };

    /** List classes known to the editor, optionally filtered by base class (e.g. "cc.Component"). Helps resolve valid class names before nodeComponentAdd. */
    function listComponentClasses(args: { extends?: string, excludeSelf?: boolean, filter?: string }): { classes: string[] };

    /** Discovered methods are not automatically permitted; finite invocation allowlist is reported separately. */
    function listComponentMethods(args: { reference: InstanceReference }): {
        components: { reference: InstanceReference, methods: string[], permittedMethods: string[], deniedMethods: string[], permissionReason: string }[]
    };

    /** Copy/cut/paste nodes. For paste pass targetReference plus the copied references. Returns references of pasted nodes for paste. */
    function nodeClipboard(args: {
        operation: "copy" | "cut" | "paste",
        references: InstanceReference[],
        targetReference?: InstanceReference,
        keepWorldTransform?: boolean,
        pasteAsChild?: boolean
    }): { success: boolean, references?: InstanceReference[] };

    /** Get the hierarchy tree of specific node or scene root. Pass maxDepth/maxNodes/fields to bound payload (wide scenes). */
    function nodeGetTree(args: { reference?: InstanceReference, maxDepth?: number, maxNodes?: number, fields?: string[] }): IHierarchyTree;

    /** Get nodes at specific path in the scene hierarchy. */
    function nodeGetAtPath(args: { hierarchyPath: string }): { references?: InstanceReference[] };

    /** Create a new node with predefined primitive geometry. */
    function nodeCreatePrimitive(args: {
        name?: string,
        primitiveType?: "Capsule" | "Cone" | "Cube" | "Cylinder" | "Plane" | "Quad" | "Sphere" | "Torus",
        parentReference?: InstanceReference
    }): { reference: InstanceReference };

    /** Create a new node in the scene. */
    function nodeCreate(args: {
        name: string,
        parentReference?: InstanceReference,
        assetReference?: InstanceReference
    }): { reference: InstanceReference };

    /** Perform operation on referenced node, including prefab operations and hierarchy lock/unlock. link_prefab binds an existing node to a prefab asset (inverse of unwrap_prefab). */
    function nodeOperate(args: {
        operation: "move" | "copy" | "delete" | "lock" | "unlock" | "create_prefab" | "link_prefab" | "revert_prefab" | "apply_prefab" | "unwrap_prefab" | "unwrap_prefab_completely" | "open_prefab",
        reference: InstanceReference,
        newParentReference?: InstanceReference,
        newPrefabPath?: string,
        prefabAssetReference?: InstanceReference,
        siblingIndex?: number,
        recursive?: boolean
    }): {
        success?: boolean,
        createdPrefabAssetReference?: InstanceReference,
        updatedNodeReference?: InstanceReference,
        copiedNodeReference?: InstanceReference
    };

    /** Get info about the current editor environment: editor version, engine version and paths, native engine info, current project path. */
    function editorEnvInfo(): { editor: string, engineVersion: string, enginePath?: string, nativeVersion?: string, nativePath?: string, projectPath: string };

    /** Undo/redo/last-op snapshot; abort drops a pending snapshot without creating an undo step. */
    function editorHistory(args: { operation: "undo" | "redo" | "abort" }): { success: boolean, error?: string };

    /** Control the editor scene viewport: focus camera on nodes, 2D/3D mode, grid visibility, icon gizmo 3D/size, gizmo tool/pivot/coordinate, align view/node (align ops act on the current selection). query_viewport reads 2D/grid/icon state, query_gizmo reads gizmo state. Frame nodes before editorGetScenePreview. */
    function editorViewport(args: {
        operation: "focus" | "set_2d_mode" | "set_grid_visible" | "set_icon_gizmo_3d" | "set_icon_gizmo_size" | "set_gizmo_tool" | "set_gizmo_pivot" | "set_gizmo_coordinate" | "query_gizmo" | "query_viewport" | "align_view_to_selected_node" | "align_selected_node_to_view",
        references?: InstanceReference[],
        enabled?: boolean,
        size?: number,
        gizmoTool?: "move" | "rotate" | "scale" | "rect",
        gizmoPivot?: "center" | "pivot",
        gizmoCoordinate?: "local" | "global"
    }): {
        success: boolean,
        error?: string,
        gizmoTool?: string,
        gizmoPivot?: string,
        gizmoCoordinate?: string,
        is2D?: boolean,
        gridVisible?: boolean,
        iconGizmo3D?: boolean,
        iconGizmoSize?: number
    };

    /** Select, deselect, clear, hover, update or query the editor selection for nodes or assets. select_all selects every node of the scene. hover with no reference = hover-out. Enables align operations in editorViewport. */
    function editorSelect(args: {
        operation: "select" | "unselect" | "clear" | "query" | "select_all" | "hover" | "update",
        selectionType?: "node" | "asset",
        references?: InstanceReference[]
    }): { success: boolean, selected?: string[], lastSelected?: string, lastSelectedType?: string };

    /** Read animation data. Start with root_info on any node. clip_dump returns a track summary unless includeCurves is set. */
    function animationQuery(args: {
        operation: "root_info" | "root" | "edit_info" | "clips_info" | "clip_dump" | "properties" | "state" | "current_info" | "clip_time" | "value_at_frame",
        nodeReference?: InstanceReference,
        clipReference?: InstanceReference,
        includeCurves?: boolean,
        nodePath?: string,
        propKey?: string,
        frame?: number
    }): { result: any };

    /** Edit animation clips. Flow: record_start (root node + clip) -> operate -> save_clip -> record_stop. */
    function animationEdit(args: {
        operation: "record_start" | "record_stop" | "change_root" | "set_edit_clip" | "set_edit_time" | "clip_state" | "save_clip" | "operate",
        nodeReference?: InstanceReference,
        clipReference?: InstanceReference,
        time?: number,
        clipState?: "play" | "pause" | "resume" | "stop",
        operations?: { funcName: string, args: any[] }[]
    }): { success: boolean, error?: string, result?: any };

    /** Configure native clip sample rate, speed, or wrap mode. */
    function animationClipConfigure(args: {
        clipReference: InstanceReference,
        operation: "sample" | "speed" | "wrap_mode",
        value: number
    }): { success: boolean, error?: string, result?: any };

    /** Create, remove, move, or copy native animation property tracks. */
    function animationTrackEdit(args: {
        clipReference: InstanceReference,
        operation: "create" | "remove" | "move_node" | "copy_to",
        nodePath: string,
        propKey: string,
        destinationNodePath?: string,
        destinationPropKey?: string
    }): { success: boolean, error?: string, result?: any };

    /** Create, move, remove, copy, space, clear, or retime native animation keyframes. */
    function animationKeyframeEdit(args: {
        clipReference: InstanceReference,
        operation: "create" | "move" | "remove" | "update" | "copy_to" | "spacing" | "clear" | "modify_curve",
        nodePath: string,
        propKey: string,
        frame?: number,
        frames?: number[],
        offsets?: number | number[],
        destinationFrame?: number,
        spacingFrames?: number,
        customData?: unknown,
        curveData?: unknown
    }): { success: boolean, error?: string, result?: any };

    /** Add, update, move, copy, or delete ordered animation event keyframes. */
    function animationEventEdit(args: {
        clipReference: InstanceReference,
        operation: "add" | "update" | "move" | "copy_to" | "delete",
        frame?: number,
        frames?: number[],
        destinationFrame?: number,
        offset?: number,
        functionName?: string,
        parameters?: string[],
        events?: unknown[]
    }): { success: boolean, error?: string, result?: any };

    /** Manage auxiliary animation curves and keys. */
    function animationAuxCurveEdit(args: {
        clipReference: InstanceReference,
        operation: "add" | "rename" | "remove" | "create_key" | "remove_key" | "move_keys" | "copy_key" | "modify_curve",
        name: string,
        newName?: string,
        frame?: number,
        frames?: number[],
        offset?: number | number[],
        customData?: unknown,
        curveData?: unknown,
        source?: unknown,
        destination?: unknown
    }): { success: boolean, error?: string, result?: any };

    /** Write to the editor console/project log. Message: 1-4096 characters, trimmed and non-blank. Data: JSON, at most 64 KiB serialized. debug uses console.log with a [debug] prefix. */
    function editorLog(args: {
        level: "debug" | "info" | "warn" | "error",
        message: string,
        data?: unknown
    }): { success: true, level: "debug" | "info" | "warn" | "error", message: string };

    /** Analyze scene animation usage, current states, defaults, cache modes, and setup recommendations. */
    function animationUsageAnalyze(args?: {
        nodeReference?: InstanceReference,
        maxNodes?: number
    }): {
        nodeReference: InstanceReference,
        visitedNodes: number,
        truncated: boolean,
        componentCount: number,
        findings: Array<{
            nodeUuid: string | null,
            nodeName: string | null,
            component: string,
            clipCount: number,
            clips: Array<{ uuid: string | null, name: string | null, duration: number | null, sample?: number | null }>,
            defaultClip: string | null,
            playOnLoad: boolean | null,
            stateCount: number,
            states: Array<{ name: string, playing: boolean, paused: boolean, time: number | null, speed: number | null }>,
            cacheMode: number | string | null,
            cached: boolean | null,
            recommendations: string[]
        }>
    };

    /** Control live Animation/SkeletalAnimation playback and Spine/DragonBones cache configuration with read-back. */
    function animationRuntimeControl(args: {
        nodeReference: InstanceReference,
        operation: "inspect" | "play" | "cross_fade" | "pause" | "resume" | "stop" | "set_default" | "set_play_on_load" | "set_state" | "set_cache_mode" | "invalidate_cache",
        clipName?: string,
        duration?: number,
        playOnLoad?: boolean,
        loop?: boolean,
        speed?: number,
        time?: number,
        repeatCount?: number,
        wrapMode?: number,
        cacheMode?: "REALTIME" | "SHARED_CACHE" | "PRIVATE_CACHE"
    }): {
        nodeReference: InstanceReference,
        operation: string,
        animation?: unknown,
        spine?: unknown,
        dragonBones?: unknown
    };

    type EditorTaskStatus = "running" | "completed" | "failed" | "cancelled" | "timedOut";
    interface EditorTask {
        taskId: string;
        title: string;
        message: string;
        progress: number | null;
        status: EditorTaskStatus;
        cancelRequested: boolean;
        createdAt: number;
        updatedAt: number;
        expiresAt: number;
        finishedAt: number | null;
    }
    interface EditorNotification {
        id: string;
        level: "info" | "warning" | "error";
        title: string;
        message: string;
        createdAt: number;
    }
    /** Bounded read-only snapshot with detection-only popup summary. */
    function editorState(args?: { timeoutMs?: number }): {
        capturedAt: number, projectPath: string | null, engineVersion: string | null,
        scene: { ready: boolean | null, dirty: boolean | null, current: { uuid: string | null, url: string | null, name: string | null } | null },
        busy: { scene: boolean | null, assetImport: boolean | null, build: boolean | null, tasks: boolean, inbox: boolean },
        popup: { detected: boolean | null, blocking: boolean | null, complete: boolean, count: number, raceDetected: boolean },
        tasks: { running: number, cancellationRequested: number, retained: number },
        inbox: { pending: boolean, requestId: string | null, kind: "form" | "question" | null, expiresAt: number | null },
        unavailable: string[]
    };
    /** Start cooperative work, heartbeat/update, or finish explicitly. Inactivity timeout 1-300000ms (default 60000); updates renew it, cancellation requests do not. Progress 0-100. Expiry is timedOut, not interruption. Finish completed sets progress 100. Terminal states immutable; unknown IDs 404, transitions/capacity 409. Max 100 tasks, terminal retention 5min with oldest-terminal eviction at capacity. */
    function editorProgress(args:
        | { operation: "start", title: string, message?: string, progress?: number, timeoutMs?: number }
        | { operation: "update", taskId: string, message?: string, progress?: number }
        | { operation: "finish", taskId: string, status: "completed" | "failed" | "cancelled", message?: string }
    ): EditorTask;

    /** Newest-first bounded list, default 50/max 100. Poll cancelRequested between work steps. */
    function editorTaskList(args?: { status?: EditorTaskStatus, taskId?: string, limit?: number }): { tasks: EditorTask[], total: number, truncated: boolean };

    /** Flag only, never interrupts work. requested:true while running (including repeated requests); false when already terminal. Worker must stop safely then finish cancelled. */
    function editorTaskCancel(args: { taskId: string }): { task: EditorTask, requested: boolean, interrupted: false };

    /** Bounded read-only snapshot. Default deadline 1000ms, maximum 5000ms; null + incomplete popup status means adapter uncertainty. busy.scene means not ready, not a global busy lock. Popup status is detection-only; no scene tree, prompt values, popup detail records, or dialog actions. */
    function editorState(args?: { timeoutMs?: number }): {
        capturedAt: number,
        projectPath: string | null,
        engineVersion: string | null,
        scene: { ready: boolean | null, dirty: boolean | null, current: { uuid: string | null, url: string | null, name: string | null } | null },
        busy: { scene: boolean | null, assetImport: boolean | null, build: boolean | null, tasks: boolean, inbox: boolean },
        popup: { detected: boolean | null, blocking: boolean | null, complete: boolean, count: number, raceDetected: boolean },
        tasks: { running: number, cancellationRequested: number, retained: number },
        inbox: { pending: boolean, requestId: string | null, kind: "form" | "question" | null, expiresAt: number | null },
        unavailable: string[]
    };

    /** Nonmodal Agent Inbox question by default, without opening/focusing the panel. User opens CCP 3x > Agent Inbox. Native dialogs require explicit presentation:"native"; openPanel:true permits panel activation. Default buttons OK/Cancel, cancelId last button. Deadline 1-300000ms, default 60000. Native timeout does not dismiss the native window. */
    function editorAsk(args: {
        title: string,
        message: string,
        detail?: string,
        type?: "info" | "warning" | "error" | "question",
        buttons?: string[],
        cancelId?: number,
        timeoutMs?: number,
        presentation?: "panel" | "native",
        openPanel?: boolean
    }): { buttonIndex: number | null, buttonLabel: string | null, cancelled: boolean, timedOut: boolean };

    /** Nonmodal Agent Inbox form; does not open/focus by default. openPanel:true explicitly permits activation. 1-16 uniquely named fields, text <=4096 chars, select <=64 options; required confirm means checked. One inbox request at a time (409 otherwise). Deadline 1-300000ms, default 60000. Do not request secrets. */
    function editorPrompt(args: {
        title: string,
        message: string,
        fields: EditorPromptField[],
        timeoutMs?: number,
        openPanel?: boolean
    }): { requestId: string, submitted: boolean, cancelled: boolean, timedOut: boolean, values: { [name: string]: string | boolean } };

    /** Read bounded project log entries with optional plain-text filtering. */
    function editorGetLogs(args: {
        count?: number,
        showStack?: boolean,
        order?: "newest-to-oldest" | "oldest-to-newest",
        pattern?: string,
        maxBytes?: number
    }): { logLines: string[], total: number, truncated: boolean };

    /** Inspect materials, shader effects and the render pipeline. Read-only — use inspectorSetProperty to change material properties. Result shapes are whatever the engine returns and are not yet runtime-verified. */
    function materialQuery(args: {
        operation: "effects" | "effect" | "material" | "serialized_material" | "render_pipeline" | "physics_material",
        reference?: InstanceReference,
        effectName?: string
    }): { result: any };

    /** Introspect the asset database: mounted databases, import-busy state, asset mtime, raw imported data, db_info, asset meta, ready. Poll "busy" after a refresh before trusting asset queries. */
    function assetDbQuery(args: {
        operation: "databases" | "busy" | "mtime" | "data" | "db_info" | "meta" | "ready",
        reference?: InstanceReference,
        dbName?: string
    }): { result: any };

    /** Read-only bounded live 2D UI layout diagnostics. Optional overlay returns a transient bounded PNG payload and never mutates scene state. */
    function uiLayoutReport(args: {
        root?: InstanceReference,
        rootPath?: string,
        designResolution: { width: number, height: number },
        viewport: { width: number, height: number },
        fitMode?: "fitWidth" | "fitHeight" | "contain" | "cover" | "stretch" | "none",
        maxNodes?: number,
        maxIssues?: number,
        maxBytes?: number,
        overlay?: boolean,
        alignmentTolerance?: number,
        gapTolerance?: number
    }): {
        complete: boolean,
        designResolution: Size,
        viewport: Size,
        fitMode: string,
        fit: { scale: Vector2, offset: Vector2 },
        root: { uuid: string, path: string, name: string },
        nodes: any[],
        issues: any[],
        truncation: any[],
        overlay: {
            requested: boolean, valid: boolean, rendered: boolean, cleaned: boolean,
            maxArtifactBytes: number, maxResponseBytes: number, responseBytes: number,
            sourceNodeCount: number, sourceIssueCount: number,
            artifact?: { mimeType: "image/png", encoding: "base64", data: string, byteLength: number, width: number, height: number, scale: Vector2 },
            error?: { code: string, message: string, evidence: Record<string, any> },
            dirtyBefore?: boolean, dirtyAfter?: boolean, dirtyPreserved?: boolean
        },
        tolerances: { alignment: number, gap: number }
    } | {
        error: { code: string, message: string, evidence: Record<string, any> }
    };

    /** Read-only all-node inventory in Creator tree order (maxNodes 1..128, default 64).
     * Local position/active are preserved. worldRect is the world-axis-aligned bound of the
     * node's own anchored UITransform corners, including all ancestor transforms, not descendants.
     * Nodes without UITransform have null size/anchor/worldRect; unavailable live geometry fails explicitly.
     */
    function uiLayoutInspect(args: {
        reference?: InstanceReference & { type?: "cc.Node" },
        maxNodes?: number
    }): {
        nodes: Array<{
            reference: InstanceReference & { type: "cc.Node" },
            name: string,
            active: boolean,
            position: { x: number, y: number, z: number },
            size: { width: number, height: number } | null,
            anchor: { x: number, y: number } | null,
            worldRect: { x: number, y: number, width: number, height: number } | null,
            components: string[]
        }>,
        truncated: boolean
    };

    /** Candidate: inspect active UI nodes for inferred labels, known interactability components, and duplicate or missing labels. Read-only inference only; no screen-reader runtime support is claimed. */
    function uiAccessibilityAudit(args: {
        root?: InstanceReference,
        rootPath?: string,
        maxNodes?: number,
        maxIssues?: number
    }): {
        complete: boolean,
        valid: boolean,
        truncated: boolean,
        checkedNodes: number,
        root: { uuid: string, path: string, name: string },
        nodes: Array<{
            uuid: string,
            path: string,
            name: string,
            active: true,
            role: "button" | "toggle" | "slider" | "edit-box" | "label" | "generic",
            label: string | null,
            labelSource: "label" | "descendant-label" | "edit-box-placeholder" | "node-name" | null,
            interactable: boolean,
            interactionComponent: "cc.Button" | "cc.Toggle" | "cc.Slider" | "cc.EditBox" | null,
            components: string[]
        }>,
        issues: Array<{
            code: "MISSING_ACCESSIBLE_LABEL" | "DUPLICATE_ACCESSIBLE_LABEL",
            severity: "warning",
            nodeId: string,
            relatedNodeIds: string[],
            message: string,
            evidence: Record<string, unknown>
        }>,
        truncation: Array<{ kind: "nodes" | "issues", limit: number, omitted?: number, reason: string }>
    } | {
        error: { code: string, message: string, evidence: Record<string, unknown> }
    };

    /** Candidate: inspect bounded live 2D UI bounds against a caller-provided safe-area rectangle or root-relative insets. Read-only; live evidence is required before qualification. */
    function uiSafeAreaInspect(args: {
        root?: InstanceReference,
        rootPath?: string,
        safeArea: {
            rect?: { x: number, y: number, width: number, height: number },
            insets?: { top: number, right: number, bottom: number, left: number },
            x?: number, y?: number, width?: number, height?: number
        },
        maxNodes?: number,
        maxIssues?: number
    }): {
        complete: boolean,
        valid: boolean,
        truncated: boolean,
        safeArea: { rect: { x: number, y: number, width: number, height: number }, insets?: { top: number, right: number, bottom: number, left: number } },
        root: { uuid: string, path: string, name: string },
        checkedNodes: number,
        nodes: Array<{ uuid: string, path: string, name: string, active: boolean, bounds: { x: number, y: number, width: number, height: number }, inside: boolean, overlaps: boolean, outside: boolean }>,
        issues: Array<{ code: "SAFE_AREA_OUTSIDE" | "SAFE_AREA_CLIPPED", severity: "error" | "warning", nodeId: string, message: string, evidence: Record<string, unknown> }>,
        truncation: unknown[]
    } | {
        error: { code: string, message: string, evidence: Record<string, unknown> }
    };

    /** Candidate: validate bounded UI geometry for clipping, overlap, anchors and optional safe-area constraints. Read-only; live evidence is required before qualification. */
    function uiLayoutValidate(args: {
        root?: InstanceReference,
        rootPath?: string,
        designResolution?: { width: number, height: number },
        viewport?: { width: number, height: number },
        fitMode?: "fitWidth" | "fitHeight" | "contain" | "cover" | "stretch" | "none",
        safeArea?: { rect?: { x: number, y: number, width: number, height: number }, insets?: { top: number, right: number, bottom: number, left: number } },
        maxNodes?: number,
        maxIssues?: number,
        checks?: { clipping?: boolean, overlap?: boolean, anchors?: boolean, safeArea?: boolean }
    }): {
        complete: boolean,
        valid: boolean,
        truncated: boolean,
        checkedNodes: number,
        root: Record<string, unknown>,
        nodes: unknown[],
        issues: unknown[],
        truncation: unknown[]
    } | { error: { code: string, message: string, evidence: Record<string, unknown> } }
      | { valid: boolean, issues: string[], checkedNodes: number };

    /** Candidate: create one bounded PhysX 3D constraint between two existing cc.RigidBody nodes. Other backends, constraint types, and generic mesh/compound behavior are unsupported until separately qualified. */
    function physics3dCreateJoint(args: {
        backend: "builtin" | "cannon" | "physx",
        joint?: "fixed" | "hinge" | "pointToPoint",
        bodyReference: InstanceReference,
        connectedBodyReference: InstanceReference
    }): {
        backend: "physx",
        jointReference: InstanceReference,
        bodyReference: InstanceReference,
        connectedBodyReference: InstanceReference,
        jointType: "cc.FixedConstraint" | "cc.HingeConstraint" | "cc.PointToPointConstraint"
    };

    interface LightBakeManageArgs {
        operation: "start" | "inspect" | "cancel";
        sceneUuid?: string;
        jobId?: string;
    }
    interface LightBakeManageResult {
        jobId: string;
        sceneUuid: string;
        status: "running" | "completed" | "cancelled" | "failed" | "indeterminate";
        startedAt: number;
        updatedAt: number;
        finishedAt: number | null;
        outputPath: string;
        probeCount: number;
        processId: number | null;
        native: { started: boolean; finished: boolean; error: boolean; processOpen: boolean; timerOpen: boolean; serverOpen: boolean };
        verification: { outputFile: boolean; topologyUnchanged: boolean; coefficientsFinite: boolean; coefficientsChanged: boolean };
        reason: string | null;
    }
    /** Native Creator 3.8.8 light-probe SH bake only (at most 256 finite noncoplanar probes; bounded scene GI settings). start requires the exact current edit sceneUuid; inspect/cancel require an owned jobId. Completion requires native/output/coefficient verification, not an end broadcast. Output is retained; no caller code/path, texture-lightmap bake, scene save or save/reopen persistence proof. */
    function lightBakeManage(args: LightBakeManageArgs): LightBakeManageResult;

    /** Candidate: configure bounded serialized cc.AudioSource properties on one existing typed node or AudioSource component. Only volume, loop, playOnAwake, and a proven cc.AudioClip UUID are accepted; no playback is started. Typed preflight, one successful scene snapshot, read-back, and rollback on failure are part of the contract. Live evidence is required before qualification. */
    function audioSourceConfigure(args: {
        reference: InstanceReference & { type: "cc.Node" | "cc.AudioSource" },
        properties: {
            volume?: number,
            loop?: boolean,
            playOnAwake?: boolean,
            clip?: InstanceReference & { type: "cc.AudioClip" }
        }
    }): {
        reference: InstanceReference,
        componentReference: InstanceReference,
        properties: {
            volume: number,
            loop: boolean,
            playOnAwake: boolean,
            clip: (InstanceReference & { type: "cc.AudioClip" }) | null
        },
        changed: Array<"volume" | "loop" | "playOnAwake" | "clip">,
        verified: true
    };

    interface AudioPlaybackResult {
        success: true;
        sessionId: string;
        targetId: string;
        nodeUuid: string;
        operation: "play" | "pause" | "stop" | "seek" | "observe";
        state: {
            currentTime: number;
            duration: number;
            playing: boolean;
            playbackState: "init" | "playing" | "paused" | "stopped" | "interrupted";
            loaded: boolean;
            userActivation: "active" | "inactive" | "unknown";
            activationRequirement: "unknown";
        };
        started: boolean;
        ended: boolean;
    }
    /** Session-bound Game View AudioSource control with actual state/event readback; activation/timeout uncertainty fails closed. */
    function audioPlaybackControl(args: {
        sessionId: string;
        nodeReference: { id: string };
        operation: "play" | "pause" | "stop" | "seek";
        time?: number;
        timeoutMs?: number;
    }): AudioPlaybackResult;
    /** Observe actual Game View audio state without edit-renderer substitution. */
    function audioPlaybackObserve(args: { sessionId: string; nodeReference: { id: string } }): AudioPlaybackResult;
    /** Build-folder data-only preflight; no serving, load or runtime validity inference. */
    function assetBundleArtifactInspect(args: { bundlePath: string; bundleName: string; maxResources?: number }): { bundleName: string; version: string; files: Array<{ name: string; bytes: number; sha256: string }>; resources: Array<{ index: string; path: string; type: string | null }>; resourceCount: number; truncated: boolean; writes: false; runtimeVerified: false; verificationScope: string };
    function skeletalAnimationPlay(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; operation: 'play' | 'pause' | 'resume' | 'stop' | 'observe'; timeoutMs?: number }): Record<string, unknown>;
    /** Exact clip state observation only; never starts/pauses/stops playback. Verification pending. */
    function skeletalAnimationWaitForState(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; playing?: boolean; paused?: boolean; minTime?: number; timeoutMs?: number; pollMs?: number }): { matched: boolean; timedOut: boolean; observations: number; state: Record<string, unknown> };
    function skeletalAnimationEvents(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; maxEvents?: number; timeoutMs?: number }): Record<string, unknown>;
    /** Exact attached Game View Animation/SkeletalAnimation clip read; no playback mutation. */
    function animationPlaybackObserve(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; timeoutMs?: number }): Record<string, unknown>;
    /** Component controls refuse other active clips; exact requested clip read-back. No replay on unknown outcome. */
    function animationPlaybackControl(args: { sessionId: string; nodeReference: { id: string }; componentId: string; operation: 'play' | 'pause' | 'resume' | 'stop'; clipName: string; clipUuid: string; timeoutMs?: number }): Record<string, unknown>;
    /** Observe only events emitted after listener registration; finite deadline and cleanup, no playback dispatch. */
    function animationPlaybackEvents(args: { sessionId: string; nodeReference: { id: string }; componentId: string; clipName: string; clipUuid: string; maxEvents?: number; timeoutMs?: number }): Record<string, unknown>;
    function animationGraphPreview(args: { sessionId: string; nodeReference: { id: string }; componentId: string; operation: 'inspect' | 'setVariable'; variable?: { name: string; type: 'float' | 'integer' | 'boolean'; value: number | boolean }; timeoutMs?: number }): Record<string, unknown>;
    /** Exact runtime graph variable observation; no write. Deadline expiry is an error. */
    function animationGraphWaitForVariable(args: { sessionId: string; nodeReference: { id: string }; componentId: string; graphUuid: string; name: string; type: 'float' | 'integer' | 'boolean'; value: number | boolean; timeoutMs?: number; pollMs?: number }): { matched: true; observations: number; graphUuid: string; variable: { name: string; type: 'float' | 'integer' | 'boolean'; value: number | boolean }; writes: false };
    /** Canonical descriptor/source only; no project code evaluation. Isolated pause/resume is version/API-dependent. */
    function tweenSequenceControl(args: { operation: 'start' | 'pause' | 'resume' | 'stop' | 'inspect'; sessionId: string; filePath?: string; sequence?: unknown; timeoutMs?: number }): Record<string, unknown>;

    interface RuntimeSession {
        sessionId: string;
        targetKind: "game-view" | "browser-preview" | "simulator";
        targetId: string;
        status: "attached" | "stopped";
        createdAt: number;
        stoppedAt?: number;
    }
    interface RuntimePreviewResult {
        success: true;
        operation: string;
        session?: RuntimeSession;
        preview: { state: "play" | "pause" | "stop"; sceneUuid: string; gamePaused: boolean | null; enabled: boolean; ready: boolean; platform: string; webContentsId: number | null };
        state?: { running: boolean; paused: boolean; timeScale: number | null; frameCount: number | null; sceneUuid: string };
        ready: boolean;
    }
    /** Creator 3.7.3 game-view only. targetId is an expected real scene UUID; stop verifies native termination. */
    function runtimePreviewControl(args: {
        operation: "start" | "pause" | "resume" | "stop" | "step" | "state";
        sessionId?: string;
        targetId?: string;
        timeoutMs?: number;
    }): RuntimePreviewResult;
    /** These controls target actual Game View, never the edit renderer. Stopped/unverified targets fail closed. */
    function runtimePause(args?: { sessionId?: string; targetId?: string; timeoutMs?: number }): { success: true };
    function runtimeResume(args?: { sessionId?: string; targetId?: string; timeoutMs?: number }): { success: true };
    function runtimeSetTimeScale(args: { scale: number }): { success: true; scale: number };
    function runtimeGetState(): { paused: boolean; timeScale: number | null; frameCount: number | null };
    /** reset releases a local handle only. It does not stop the preview. */
    function runtimeSessionLifecycle(args: {
        operation: "start" | "attach" | "inspect" | "stop" | "reset" | "list";
        targetKind?: "game-view" | "browser-preview" | "simulator";
        targetId?: string;
        sessionId?: string;
        timeoutMs?: number;
    }): {
        success: boolean;
        operation: string;
        session?: RuntimeSession | { sessionId: string; reset: true };
        sessions?: RuntimeSession[];
        state?: RuntimePreviewResult["state"];
        ready?: boolean;
    };

    /** Candidate: audit up to 64 explicitly typed cc.AudioClip assets against a declared target using only public asset metadata. Reports source extension/importer and exposed web load mode; it does not claim decode, duration, or playback success. Candidate remains unqualified until live importer evidence exists. */
    function audioAssetCompatibilityAudit(args: {
        assets: Array<InstanceReference & { type: "cc.AudioClip" }>,
        target: "web-mobile" | "web-desktop" | "native-mobile" | "native-desktop",
        maxIssues?: number
    }): {
        target: "web-mobile" | "web-desktop" | "native-mobile" | "native-desktop",
        valid: boolean,
        complete: boolean,
        items: Array<{
            reference: InstanceReference & { type: "cc.AudioClip" },
            target: "web-mobile" | "web-desktop" | "native-mobile" | "native-desktop",
            valid: boolean,
            url?: string,
            path?: string,
            extension?: string,
            importer?: string,
            loadMode?: string,
            issues: Array<{
                code: "ASSET_NOT_FOUND" | "TYPE_MISMATCH" | "UNSUPPORTED_FORMAT" | "UNKNOWN_METADATA",
                assetId: string,
                field?: string,
                value?: unknown,
                message: string
            }>
        }>,
        issues: Array<{
            code: "ASSET_NOT_FOUND" | "TYPE_MISMATCH" | "UNSUPPORTED_FORMAT" | "UNKNOWN_METADATA",
            assetId: string,
            field?: string,
            value?: unknown,
            message: string
        }>
    };

    /** Candidate: validate 1-256 unique localization keys (each at most 256 characters) in the current Creator language through the fixed ccp3x package scene seam. Unsupported localization packages return supported=false; this call never changes language or restarts Creator. */
    function localizationValidate(args: { keys: string[] }): {
        supported: true,
        language: string | null,
        checkedKeys: number,
        missingKeys: string[]
    } | {
        supported: false,
        language: null,
        checkedKeys: 0,
        missingKeys: [],
        error: string
    };
    /** Official editor resource metadata; runtime overrides/fallback resolution and switching remain unverified. */
    function localizationResourceInspect(): { languages: string[]; defaultLanguage: string; fallbackLanguage: string; issues: Array<{ code: string; locale: string }>; writes: false; runtimeVerified: false; verificationScope: string };
    /** Official editor fallback presence; empty translations do not imply fallback, runtime policy remains unverified. */
    function localizationFallbackCoverage(args: { locale: string; keys: string[] }): { locale: string; fallbackLanguage: string; complete: boolean; items: Array<{ key: string; status: string }>; writes: false; runtimeVerified: false; verificationScope: string };
    /** Creator3.8.8 official package IPC; edits one existing key with expected-value conflict guard. Live qualification pending. */
    function localizationTableEdit(args: { locale: string; key: string; value: string; expectedValue: string }): { supported: true; locale: string; key: string; changed: boolean; persisted: true; mutationDispatched: boolean; previousValueSha256: string; readBackValueSha256: string; evidence: { channel: 'localization-editor'; readMethod: 'get-translate-data-object'; writeMethod: 'save-translate-data'; payloadBytes: number; redacted: true } };
    /** Read selected official package translations with a whole-response cap; no locale switch or write. Verification pending. */
    function localizationTableInspect(args: { locale: string; keys: string[]; maxBytes?: number }): { locale: string; items: Array<{ key: string; value: string; valueSha256: string }>; missingKeys: string[]; requestedKeys: number; totalFound: number; totalMissing: number; truncated: boolean; writes: false };
    /** Bounded key presence across explicit locales; never infers fallback/font/layout correctness. */
    function localizationTableCoverage(args: { locales: string[]; keys: string[] }): { complete: boolean; valid: boolean; checkedLocales: number; checkedKeys: number; locales: Array<{ locale: string; missingKeys: string[]; emptyKeys: string[]; checkedKeys: number; complete: boolean }>; writes: false; fallbackVerified: false };
    /** Finite Game View3.7 component controls; inspect never dispatches playback. */
    function particlePlayback(args: { sessionId: string; nodeReference: { id: string }; componentId?: string; operation: 'play' | 'stop' | 'clear' | 'inspect'; timeoutMs?: number }): { success: true; sessionId: string; targetId: string; componentId: string; nodeUuid: string; state: { playing: boolean; paused: boolean | null; stopped: boolean | null; particleCount: number | null; time: number | null } };
    /** No-mutation particle state polling under exact session/node/component identity; verification pending. */
    function particleWaitForState(args: { sessionId: string; nodeReference: { id: string }; componentId: string; playing?: boolean; maxParticleCount?: number; timeoutMs?: number; pollMs?: number }): { matched: boolean; timedOut: boolean; observations: number; state: Record<string, unknown> };
    /** Expected-file hashes tied to successful task options, not proof of producer freshness. Verification pending. */
    function buildTaskOutputInspect(args: { taskId: string | number; expectedFiles: string[]; maxBytes?: number }): { taskId: string; platform: string; state: 'success'; artifactPath: string; files: Array<{ path: string; bytes: number; sha256: string }>; totalBytes: number; producerVerified: false; verificationScope: string };

    /** Generates options only: no persistence/build dispatch or asset/toolchain qualification. */
    function buildTemplate(args: { operation: 'list' | 'create'; platform?: 'web-mobile' | 'web-desktop' | 'android' | 'ios' | 'windows' | 'mac'; mode?: 'debug' | 'release'; name?: string; scenes?: Array<{ uuid: string; url: string }>; startScene?: string; packageName?: string; orientation?: 'auto' | 'portrait' | 'landscape'; buildPath?: string; remoteServerAddress?: string }): { options?: Record<string, unknown>; platforms?: string[]; modes?: string[]; writes: false; readiness?: string; requirements?: string[] };
    /** Creator builder preferences only; does not mutate existing task options or trigger builds. */
    function buildSettingsManage(args: { operation: 'get' | 'set'; key?: string; value?: string | boolean; scope?: 'local' | 'global' }): Promise<{ scope: string; settings?: Record<string, unknown>; success?: boolean; affectsExistingTasks: false }>;
    /** Persistent ccp-owned project profiles, not native Creator presets. Credentials forbidden; options validated and writes read back. */
    function buildProfileManage(args: { operation: 'list' | 'get' | 'save' | 'delete'; name?: string; options?: Record<string, unknown> }): Promise<{ profiles?: Array<{ name: string; platform: string }>; total?: number; name?: string; options?: Record<string, unknown>; success?: boolean }>;
    /** Candidate: pure, read-only audit of bounded public Creator build options for six explicit targets. Reports normalized platform, supported/unsupported/unknown options, errors and warnings; it never dispatches a build or claims an artifact. Candidate remains unqualified. */
    function buildPresetAudit(args: {
        platform: "web-mobile" | "web-desktop" | "android" | "ios" | "windows" | "mac" | string,
        options: Record<string, unknown>
    }): {
        platform: string,
        supportedOptions: string[],
        unsupportedOptions: string[],
        unknownOptions: string[],
        errors: Array<{
            code: "UNKNOWN_PLATFORM" | "INVALID_OPTIONS" | "MISSING_REQUIRED_OPTION" | "INVALID_OPTION" | "UNSUPPORTED_OPTION" | "UNKNOWN_OPTION" | "OPTIONS_TRUNCATED",
            path?: string,
            value?: unknown,
            message: string
        }>,
        warnings: Array<{
            code: "UNKNOWN_PLATFORM" | "INVALID_OPTIONS" | "MISSING_REQUIRED_OPTION" | "INVALID_OPTION" | "UNSUPPORTED_OPTION" | "UNKNOWN_OPTION" | "OPTIONS_TRUNCATED",
            path?: string,
            value?: unknown,
            message: string
        }>,
        valid: boolean,
        complete: boolean
    };
    /** Candidate: inspect a bounded, read-only project-local build artifact inventory. artifactPath must be relative and contained by the project; traversal and control characters are rejected. Files are returned in lexical order up to maxFiles. */
    function buildArtifactInspect(args: {
        artifactPath: string,
        maxFiles?: number
    }): {
        exists: boolean,
        files: Array<{
            path: string,
            bytes: number
        }>,
        count: number,
        truncated: boolean
    };

    /** Candidate: inspect one Creator builder task through query-task only. Unavailable logs use available=false, never fabricated entries.
     * Integer maxEntries 1..256; integer maxBytes 256..2097152 caps the entire successful UTF-8 JSON response.
     * Oversized optional data is omitted with truncated=true; task identity/state are never sliced.
     * An unfit mandatory envelope fails with BUILD_LOG_RESPONSE_TOO_LARGE (422).
     * Invalid limits fail with INVALID_ARGUMENT (400) before IPC.
     */
    function buildLogInspect(args: {
        taskId: string | number,
        maxEntries?: number,
        maxBytes?: number
    }): {
        available: boolean,
        terminal: boolean,
        state: string,
        progress: number,
        task: {
            id: string,
            progress: number,
            state: string,
            message?: string,
            time?: string,
            stage?: string,
            dirty?: boolean,
            name?: string,
            platform?: string,
            buildPath?: string
        },
        entries: Array<{
            message: string,
            severity?: string,
            code?: string,
            file?: string,
            line?: number
        }>,
        count: number,
        truncated: boolean
    };
    /** Selected simple-braces/i18next identifiers and explicit character repertoire; no formatter/font/layout/runtime validity. */
    function localizationTableTextAudit(args: { baseLocale: string; locales: string[]; keys: string[]; supportedCharacters?: string; placeholderSyntax?: 'simple-braces' | 'i18next' }): { baseLocale: string; complete: boolean; checkedTranslations: number; issues: Array<{ locale: string; key: string; code: string; missingPlaceholders?: string[]; extraPlaceholders?: string[]; uncoveredCharacters?: string[] }>; placeholderSyntax: string; characterCoverageChecked: boolean; fontVerified: false; layoutVerified: false; runtimeVerified: false; writes: false };

    // ── Consolidated (preferred) ── 10 tools replace 26 legacy (removed in 2.0.x)
    /** Consolidated: get properties (instance or settings). Use instead of removed inspectorGet*Properties. */
    function inspectorGet(args: { target: "instance" | "CurrentSceneGlobals" | "ProjectSettings", reference?: InstanceReference, fields?: string[] }): { dump: any };
    /** Consolidated: set properties (instance or settings). */
    function inspectorSet(args: { target: "instance" | "CurrentSceneGlobals" | "ProjectSettings", reference?: InstanceReference, propertyPaths?: string[], values?: any[], propertyPath?: string, value?: any }): { success: boolean, error?: string };
    /** Consolidated: TS definition (instance or settings). */
    function inspectorGetDefinition(args: EngineApiDiscoveryArgs & { target: 'class'; className: string }): EngineApiDiscoveryResult;
    function inspectorGetDefinition(args: { target: 'instance' | 'CommonTypes' | 'CurrentSceneGlobals' | 'ProjectSettings'; reference?: InstanceReference; section?: string }): { definition: string; sections: string[]; totalSections: number };
    /** Reflow is edit-scene native Layout/Widget authoring, not Game View simulation; success does not imply save or verified undo. */
    function uiLayoutApply(args: { operation: 'reflow'; reference: InstanceReference; maxNodes?: number; maxDepth?: number; maxBytes?: number }): UiReflowEvidence;
    function uiLayoutApply(args: { operation?: 'apply'; reference: InstanceReference; position?: { x?: number; y?: number; z?: number }; size?: { width: number; height: number }; anchor?: { x: number; y: number }; active?: boolean }): { success: true; layout: Record<string, unknown> | null };
    function materialEdit(args: { reference: InstanceReference; path: string; value: unknown }): { reference: InstanceReference; path: string; changed: boolean; before: unknown; after: unknown; requestedValue: unknown; readBackValue: unknown; passIndices: number[]; verification: { requestedValueMatched: boolean; unaffectedPassesUnchanged: boolean; unaffectedPassesApplicable: boolean }; persistence: { nativeApplyInvoked: boolean; sourceSaved: null; importCompleted: null; generatedOutputVerified: null; reimportVerified: false; reopenVerified: false } };
    function animationGraphInspect(args: { reference: InstanceReference }): NativeGraphInspection;
    /** Conservative static variable/path diagnostics; no playable/runtime validity. */
    function animationGraphDiagnostics(args: { reference: InstanceReference }): { reference: InstanceReference; complete: boolean; issues: Array<{ code: string; id: string; variable?: string }>; truncated: boolean; checkedStates: number; checkedConditions: number; clips: Array<{ uuid: string; status: 'verified' | 'missing' | 'wrong-type' | 'identity-mismatch'; assetType: string | null }>; checkedClips: number; directClipsValid: boolean; clipVerificationScope: string; motionIssues: Array<{ code: string; path: string }>; motionTraversalComplete: boolean; motionTraversalTruncated: boolean; inspectedMotionObjects: number; semanticsVerified: false; runtimeVerified: false; verificationScope: string };
    function animationGraphValidate(args: { reference: InstanceReference }): NativeGraphInspection & { valid: false };
    /** Refuses synthetic node/transition edits; no verified native graph serializer is implemented. */
    function animationGraphEdit(args: { reference: InstanceReference; operations: Array<{ operation: 'add_node' | 'remove_node' | 'update_node' | 'add_transition' | 'remove_transition'; node?: unknown; nodeId?: string; transition?: unknown; transitionId?: string }> }): never;
    /** Consolidated: add/remove component on node. */
    function nodeComponentManage(args: { operation: "add" | "remove", reference: InstanceReference, componentType?: string }): { reference?: InstanceReference, success?: boolean };
    /** Consolidated: query editor state or vocabularies. Use instead of removed editorIntrospect/editorListTypes. Plus: shared_settings (= programming builtins) and sorted_plugins (typed after 3.7 — may report not-supported on 3.7.3). */
    function editorQuery(args: EngineApiDiscoveryArgs & { category: 'engine_api' | 'component_schema' }): EngineApiDiscoveryResult;
    function editorQuery(args: { category: 'scene_mode' | 'ready' | 'enum_values' | 'layers' | 'sorting_layers' | 'script_info' | 'has_script' | 'creatable_assets' | 'asset_types' | 'importers' | 'shared_settings' | 'sorted_plugins'; enumPath?: string; className?: string; reference?: InstanceReference }): Record<string, unknown>;
    /** Consolidated: scene lifecycle open/save/close/soft_reload. Use instead of removed sceneOpen/editorOperate. */
    function sceneManage(args: { operation: "open" | "save" | "save_as" | "close" | "soft_reload", reference?: InstanceReference }): { success: boolean, error?: string, reference?: InstanceReference };
    /** Consolidated: preview (asset/scene capture, get url, open browser). */
    function previewManage(args: { operation: "get_url" | "open_browser" | "asset_preview" | "scene_preview", reference?: InstanceReference, imageSize?: number, jpegQuality?: number, transparentColor?: Color, cameraPosition?: Vector3, targetPosition?: Vector3, orthographic?: boolean, orthographicSize?: number }): any;
    /** Consolidated: external programs and url open. */
    function programManage(args: { operation: "get_info" | "open" | "open_url", programName?: string, commandArguments?: Record<string, any>, url?: string }): any;
    /** Consolidated: project settings read/write. */
    function projectManage(args: { operation: "get" | "set", type?: string, key?: string, path?: string, value?: any }): any;
    /** Consolidated: build panel/tasks/trigger/control. */
    function buildManage(args: { operation: "panel_open" | "tasks_info" | "get_task" | "trigger" | "control", panel?: string, taskId?: string | number, options?: Record<string, unknown>, control?: "break" | "remove" | "recompile" }): unknown;
    /** Authoritative scene/target/bundle checks only; not toolchain or signing readiness. */
    function buildPreflight(args: { options: Record<string, unknown> }): { valid: boolean; complete: boolean; targetAvailable: boolean; sceneCount: number; issues: Array<{ code: string; path: string }>; writes: false; toolchainVerified: false; signingVerified: false };
    /** Registered SDK/NDK/Java configuration, paths redacted; never writes. */
    function buildEnvironmentInspect(args?: {}): { programs: Record<string, { available: boolean; configured: boolean; pathRedacted: true }>; writes: false; toolchainVerified: false; signingVerified: false; javaInspection: string };
    /** Guarded terminal-task update; native update-task is in-memory, not persistent preset storage. */
    function buildTaskConfigManage(args: { operation: 'get' | 'set'; taskId: string | number; options?: Record<string, unknown>; expectedOptionsSha256?: string }): { taskId: string; options: Record<string, unknown>; optionsSha256: string; writes: boolean; persisted: false };
    interface TweenSequenceDescriptor {
        version: 1; id: string; target: { id: string; type: 'cc.Node' };
        steps: Array<{ kind: 'delay'; duration: number } | { kind: 'to' | 'by'; duration: number; easing: 'linear' | 'quadIn' | 'quadOut' | 'quadInOut' | 'cubicIn' | 'cubicOut' | 'cubicInOut' | 'sineIn' | 'sineOut' | 'sineInOut'; properties: Partial<Record<'position' | 'scale' | 'eulerAngles', Vector3>> }>;
        lifecycle: { start: 'manual' | 'on-enable'; stop: 'on-disable' | 'on-destroy'; repeat: number };
    }
    interface TweenSequenceInspection {
        representation: 'project-code'; nativeAsset: false; inspectable: boolean;
        sequence?: TweenSequenceDescriptor; durationSeconds?: number;
        diagnostics: Array<{ code: string; path: string; message: string }>;
        source: Record<string, unknown>; targetBinding: string;
        runtime: { status: 'not-requested' | 'unavailable' | 'verified'; code?: string; message: string };
    }
    function tweenSequenceCreate(args: { filePath: string; sequence: TweenSequenceDescriptor; write: true }): TweenSequenceInspection & { created: boolean; bytesWritten: number };
    function tweenSequenceInspect(args: { filePath: string; sequence?: never } | { sequence: TweenSequenceDescriptor; filePath?: never }): TweenSequenceInspection;
    function tweenSequenceValidate(args: ({ filePath: string; sequence?: never } | { sequence: TweenSequenceDescriptor; filePath?: never }) & { runtime?: boolean; sessionId?: string }): TweenSequenceInspection & { valid: boolean; runtimeBinding?: Record<string, unknown>; static: { valid: boolean; diagnostics: Array<{ code: string; path: string; message: string }>; targetChecked: boolean; generatedCode: 'canonical' | 'unsupported'; compilation: 'not-run' } };
    /** T0/T1 graph lookup. Verify a bare UUID through live tools before mutation; never mutate through a composite graph handle. */
    function graphManage(args: {
        operation: 'status' | 'build' | 'query' | 'resolve' | 'navigate' | 'refs' | 'validate';
        bundle?: string; refresh?: boolean; source?: 'disk' | 'auto'; text?: string;
        byComponent?: string; byScript?: string; componentUuid?: string; pathGlob?: string;
        explain?: boolean; handle?: string; uuid?: string;
        relation?: 'ancestors' | 'children' | 'descendants'; depth?: number;
        assetUuid?: string; limit?: number; cursor?: number;
    }): any;
}
