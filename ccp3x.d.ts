// Instance reference should newer be kept in memory
// Agent-facing tool surface for Cocos Creator 3.7.x.
// Manual: ccp3x (UTCP, hyphen). JS: ccp3x (underscore).
// Static declaration only; runtime manuals use the exact ccp3x_<port> namespace.
// STATIC hand-written. See source/utcp/tools/*.ts for impl.

type InstanceReference = { id: string; type: string };
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
        operation: "move" | "copy" | "delete" | "open" | "refresh" | "reimport" | "save_meta",
        reference: InstanceReference,
        targetAssetPath?: string,
        /** save_meta only: meta object (or JSON string) read via assetDbQuery "meta", then mutated. */
        meta?: any,
        options?: { overwrite?: boolean, rename?: boolean }
    }): { reference: InstanceReference };

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

    /** Reset nodes, one component, or one property to defaults. operation property needs a single uuid + propertyPath. */
    function nodeReset(args: { operation: "node" | "component" | "property", references: InstanceReference[], propertyPath?: string }): { success: boolean, error?: string };

    /** Execute a method on a component by its uuid. Arguments and return value must be JSON-serializable. Get the component uuid via nodeComponentsGet. */
    function callComponentMethod(args: { reference: InstanceReference, methodName: string, methodArgs?: any[] }): { result: any };

    /** List classes known to the editor, optionally filtered by base class (e.g. "cc.Component"). Helps resolve valid class names before nodeComponentAdd. */
    function listComponentClasses(args: { extends?: string, excludeSelf?: boolean, filter?: string }): { classes: string[] };

    /** List callable method names of every component on a node - discovery step for callComponentMethod (otherwise the method name must be guessed). */
    function listComponentMethods(args: { reference: InstanceReference }): {
        components: { reference: InstanceReference, methods: string[] }[]
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

    /** Get last N editor log entries. */
    function editorGetLogs(args: {
        count: number,
        showStack?: boolean,
        order: "newest-to-oldest" | "oldest-to-newest"
    }): { logLines: string[] };

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

    // ── Consolidated (preferred) ── 10 tools replace 26 legacy (removed in 2.0.x)
    /** Consolidated: get properties (instance or settings). Use instead of removed inspectorGet*Properties. */
    function inspectorGet(args: { target: "instance" | "CurrentSceneGlobals" | "ProjectSettings", reference?: InstanceReference, fields?: string[] }): { dump: any };
    /** Consolidated: set properties (instance or settings). */
    function inspectorSet(args: { target: "instance" | "CurrentSceneGlobals" | "ProjectSettings", reference?: InstanceReference, propertyPaths?: string[], values?: any[], propertyPath?: string, value?: any }): { success: boolean, error?: string };
    /** Consolidated: TS definition (instance or settings). */
    function inspectorGetDefinition(args: { target: "instance" | "CommonTypes" | "CurrentSceneGlobals" | "ProjectSettings", reference?: InstanceReference, section?: string }): { definition: string, sections: string[], totalSections: number };
    /** Consolidated: add/remove component on node. */
    function nodeComponentManage(args: { operation: "add" | "remove", reference: InstanceReference, componentType?: string }): { reference?: InstanceReference, success?: boolean };
    /** Consolidated: query editor state or vocabularies. Use instead of removed editorIntrospect/editorListTypes. Plus: shared_settings (= programming builtins) and sorted_plugins (typed after 3.7 — may report not-supported on 3.7.3). */
    function editorQuery(args: { category: "scene_mode" | "ready" | "enum_values" | "layers" | "sorting_layers" | "script_info" | "has_script" | "creatable_assets" | "asset_types" | "importers" | "shared_settings" | "sorted_plugins", enumPath?: string, className?: string, reference?: InstanceReference }): any;
    /** Consolidated: scene lifecycle open/save/close/soft_reload. Use instead of removed sceneOpen/editorOperate. */
    function sceneManage(args: { operation: "open" | "save" | "save_as" | "close" | "soft_reload", reference?: InstanceReference }): { success: boolean, error?: string, reference?: InstanceReference };
    /** Consolidated: preview (asset/scene capture, get url, open browser). */
    function previewManage(args: { operation: "get_url" | "open_browser" | "asset_preview" | "scene_preview", reference?: InstanceReference, imageSize?: number, jpegQuality?: number, transparentColor?: Color, cameraPosition?: Vector3, targetPosition?: Vector3, orthographic?: boolean, orthographicSize?: number }): any;
    /** Consolidated: project settings read/write. */
    function projectManage(args: { operation: "get" | "set", type?: string, key?: string, path?: string, value?: any }): any;
    /** Consolidated: build panel/tasks/trigger/control. */
    function buildManage(args: { operation: "panel_open" | "tasks_info" | "get_task" | "trigger" | "control", panel?: string, taskId?: string, options?: any, control?: "break" | "remove" | "recompile" }): any;
}
