import { aabbFromCorners, localCorners, transformCorners, Aabb } from './ui-layout-report';

export interface UiReflowRequest { nodeUuid: string; maxNodes?: number; maxDepth?: number; maxBytes?: number }
export interface UiReflowGeometry {
    id: string; position: { x: number; y: number; z: number };
    size: { width: number; height: number } | null; anchor: { x: number; y: number } | null; worldRect: Aabb | null;
}
export interface UiReflowResult {
    success: boolean; operation: 'reflow'; sceneSaved: false; complete: boolean;
    reference: { id: string; type: 'cc.Node' }; checkedNodes: number; changedNodeIds: string[];
    restoration: 'not-needed' | 'confirmed' | 'partial' | 'unknown';
    history: { status: 'not-requested' | 'snapshot-requested' | 'unknown'; undoRedoVerified: false };
    preservation: 'confirmed' | 'unknown';
    before?: UiReflowGeometry[]; after?: UiReflowGeometry[];
    order?: Array<{ nodeId: string; componentType: 'cc.Layout' | 'cc.Widget' }>;
    limits?: { maxNodes: number; maxDepth: number; maxBytes: number };
    engineVersion?: string; error?: { code: string; message: string; mutationStarted: boolean };
}
interface LiveComponent {
    uuid: string; node: UiReflowNode; constructor: unknown; enabled: boolean;
    contentSize?: unknown; anchorPoint?: unknown; setContentSize?: (width: number, height: number) => void;
    type?: number; resizeMode?: number; startAxis?: number; affectedByScale?: boolean;
    alignHorizontal?: boolean; alignVertical?: boolean; updateLayout?: (force?: boolean) => void;
    target?: UiReflowNode | null; updateAlignment?: () => void;
    isAlignLeft?: boolean; isAlignRight?: boolean; isAlignTop?: boolean; isAlignBottom?: boolean;
    isAlignHorizontalCenter?: boolean; isAlignVerticalCenter?: boolean; isStretchWidth?: boolean; isStretchHeight?: boolean;
}
export interface UiReflowNode {
    uuid: string; parent: UiReflowNode | null; children: UiReflowNode[]; activeInHierarchy: boolean;
    position: { x: number; y: number; z: number }; worldMatrix: unknown;
    scale?: { x: number; y: number; z: number };
    getComponent(type: unknown): LiveComponent | null;
    getComponents(type: unknown): LiveComponent[];
    setPosition(x: number, y: number, z: number): void;
}
export interface UiReflowEngine {
    ENGINE_VERSION?: string; VERSION?: string; GAME_VIEW?: boolean;
    Layout?: unknown; Widget?: unknown; UITransform?: unknown;
    js?: { getClassByName(name: string): unknown };
    director?: { getScene(): UiReflowNode | null };
}
/** Matching Creator 3.7 facade, not a generic lifecycle/method gateway. */
export interface UiReflowFacade {
    queryMode(): string;
    querySceneSerializedData(): Promise<string>;
    recordNode(node: UiReflowNode, enable?: boolean): unknown;
    snapshot(): Promise<unknown>;
}
interface ScopeNode { node: UiReflowNode; children: UiReflowNode[]; transform: LiveComponent | null; layout: LiveComponent | null; widget: LiveComponent | null }
interface Step { node: UiReflowNode; component: LiveComponent; type: 'cc.Layout' | 'cc.Widget'; reads: Set<string>; writes: Set<string> }
class ReflowFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
function requireValue(value: unknown, code: string, message: string): asserts value { if (!value) throw new ReflowFailure(code, message); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finiteFields<K extends string>(value: unknown, keys: K[]): value is Record<K, number> { return record(value) && keys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key])); }

/** Validate the JSON IPC evidence without promoting incomplete geometry to a successful reflow. */
export function isUiReflowResult(value: unknown, expectedId: string, maxNodes: number, maxBytes: number): value is UiReflowResult {
    if (!record(value) || value.operation !== 'reflow' || value.sceneSaved !== false || typeof value.success !== 'boolean' || typeof value.complete !== 'boolean'
        || !record(value.reference) || value.reference.id !== expectedId || value.reference.type !== 'cc.Node'
        || typeof value.checkedNodes !== 'number' || !Number.isInteger(value.checkedNodes) || value.checkedNodes < 0 || value.checkedNodes > maxNodes
        || !Array.isArray(value.changedNodeIds) || value.changedNodeIds.length > maxNodes
        || !value.changedNodeIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)
        || !['not-needed', 'confirmed', 'partial', 'unknown'].includes(String(value.restoration))
        || !['confirmed', 'unknown'].includes(String(value.preservation)) || !record(value.history)
        || !['not-requested', 'snapshot-requested', 'unknown'].includes(String(value.history.status)) || value.history.undoRedoVerified !== false) return false;
    const validGeometry = (rows: unknown): rows is UiReflowGeometry[] => Array.isArray(rows) && rows.length === value.checkedNodes && rows.every(row => record(row)
        && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 256 && finiteFields(row.position, ['x', 'y', 'z'])
        && (row.size === null ? row.anchor === null && row.worldRect === null : finiteFields(row.size, ['width', 'height']) && row.size.width >= 0 && row.size.height >= 0
            && finiteFields(row.anchor, ['x', 'y']) && finiteFields(row.worldRect, ['x', 'y', 'width', 'height']) && row.worldRect.width >= 0 && row.worldRect.height >= 0));
    if ((value.before !== undefined && !validGeometry(value.before)) || (value.after !== undefined && !validGeometry(value.after))) return false;
    if (value.order !== undefined && (!Array.isArray(value.order) || value.order.length > maxNodes * 2 || !value.order.every(row => record(row)
        && typeof row.nodeId === 'string' && ['cc.Layout', 'cc.Widget'].includes(String(row.componentType))))) return false;
    if (value.success) {
        if (!value.complete || !validGeometry(value.before) || !validGeometry(value.after) || !Array.isArray(value.order)
            || value.restoration !== 'not-needed' || value.preservation !== 'confirmed' || value.history.status !== 'snapshot-requested' || value.error !== undefined) return false;
        const ids = value.before.map(row => row.id);
        if (value.after.some((row, index) => row.id !== ids[index]) || value.changedNodeIds.some(id => !ids.includes(id))) return false;
    } else if (value.complete || !record(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string' || typeof value.error.mutationStarted !== 'boolean') return false;
    try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes; } catch { return false; }
}
function limit(value: unknown, fallback: number, minimum: number, maximum: number): number {
    if (value === undefined) return fallback;
    requireValue(Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum, 'INVALID_ARGUMENT', `Reflow limit must be an integer from ${minimum} to ${maximum}.`);
    return value as number;
}
function component(node: UiReflowNode, type: unknown): LiveComponent | null {
    const found = node.getComponents(type);
    requireValue(Array.isArray(found) && found.length <= 1, 'UI_REFLOW_UNSUPPORTED_TARGET', 'Duplicate UI components are unsupported.');
    const value = found[0] ?? null;
    requireValue(!value || (value.node === node && value.constructor === type && typeof value.uuid === 'string' && value.uuid.length > 0 && value.uuid.length <= 256 && typeof value.enabled === 'boolean'), 'UI_REFLOW_UNSUPPORTED_TARGET', 'Only matching native UI components with authoritative identities are supported.');
    return value;
}
function collect(root: UiReflowNode, cc: UiReflowEngine, maxNodes: number, maxDepth: number): ScopeNode[] {
    const nodes: ScopeNode[] = []; const seen = new Set<string>(); const stack = [{ node: root, depth: 0 }];
    while (stack.length) {
        const { node, depth } = stack.pop()!;
        requireValue(node && typeof node.uuid === 'string' && node.uuid.length > 0 && node.uuid.length <= 256 && !seen.has(node.uuid), 'UI_REFLOW_UNSUPPORTED_TARGET', 'The subtree contains missing or duplicate node identities or a hierarchy cycle.');
        requireValue(nodes.length < maxNodes, 'UI_REFLOW_NODE_LIMIT', 'The entire subtree must fit maxNodes before reflow.');
        requireValue(typeof node.activeInHierarchy === 'boolean' && Array.isArray(node.children) && typeof node.getComponents === 'function' && typeof node.getComponent === 'function' && typeof node.setPosition === 'function', 'UI_REFLOW_UNSUPPORTED_TARGET', 'Native node hierarchy/component/geometry access is unavailable.');
        requireValue(depth < maxDepth || node.children.length === 0, 'UI_REFLOW_DEPTH_LIMIT', 'The entire subtree must fit maxDepth before reflow.');
        requireValue(nodes.length + stack.length + node.children.length < maxNodes, 'UI_REFLOW_NODE_LIMIT', 'The entire subtree must fit maxNodes before reflow.');
        seen.add(node.uuid);
        const children = node.children.slice();
        nodes.push({ node, children, transform: component(node, cc.UITransform), layout: component(node, cc.Layout), widget: component(node, cc.Widget) });
        for (let index = children.length - 1; index >= 0; index--) {
            requireValue(children[index]?.parent === node, 'UI_REFLOW_UNSUPPORTED_TARGET', 'A subtree child does not confirm its parent.');
            stack.push({ node: children[index], depth: depth + 1 });
        }
    }
    requireValue(nodes[0].transform, 'UI_REFLOW_UNSUPPORTED_TARGET', 'Reflow requires a UITransform on the selected root.');
    return nodes;
}
function geometry(entry: ScopeNode): UiReflowGeometry {
    const { node, transform } = entry;
    requireValue(finiteFields(node.position, ['x', 'y', 'z']), 'UI_REFLOW_GEOMETRY_UNAVAILABLE', 'Native local position is unavailable or non-finite.');
    const position = { x: node.position.x, y: node.position.y, z: node.position.z };
    if (!transform) return { id: node.uuid, position, size: null, anchor: null, worldRect: null };
    requireValue(finiteFields(transform.contentSize, ['width', 'height']) && transform.contentSize.width >= 0 && transform.contentSize.height >= 0 && finiteFields(transform.anchorPoint, ['x', 'y']) && typeof transform.setContentSize === 'function', 'UI_REFLOW_GEOMETRY_UNAVAILABLE', 'Native UI size/anchor and geometry restoration are unavailable or invalid.');
    const size = { width: transform.contentSize.width, height: transform.contentSize.height };
    const anchor = { x: transform.anchorPoint.x, y: transform.anchorPoint.y };
    const matrix = node.worldMatrix;
    requireValue(finiteFields(matrix, ['m00', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15']), 'UI_REFLOW_GEOMETRY_UNAVAILABLE', 'Native world matrix is unavailable or non-finite.');
    const worldRect = aabbFromCorners(transformCorners(localCorners(size, anchor), matrix));
    requireValue(finiteFields(worldRect, ['x', 'y', 'width', 'height']), 'UI_REFLOW_GEOMETRY_UNAVAILABLE', 'Native UI world bounds exceed finite numeric range.');
    return { id: node.uuid, position, size, anchor, worldRect };
}
function add(set: Set<string>, node: UiReflowNode, property: string, dimensions: string[]) { for (const dimension of dimensions) set.add(`${node.uuid}:${property}:${dimension}`); }
function stepsFor(nodes: ScopeNode[], cc: UiReflowEngine): Step[] {
    const scope = new Map(nodes.map(entry => [entry.node, entry])); const steps: Step[] = [];
    for (const entry of nodes) {
        const { node, layout, widget } = entry;
        if (layout && layout.enabled && node.activeInHierarchy && layout.type !== 0) {
            requireValue(typeof layout.type === 'number' && [1, 2, 3].includes(layout.type) && typeof layout.resizeMode === 'number' && [0, 1, 2].includes(layout.resizeMode) && typeof layout.updateLayout === 'function' && entry.transform, 'UI_REFLOW_UNSUPPORTED_TARGET', 'Layout type, resize mode or updateLayout is unsupported.');
            requireValue(typeof layout.affectedByScale === 'boolean' && typeof layout.alignHorizontal === 'boolean' && typeof layout.alignVertical === 'boolean', 'UI_REFLOW_UNSUPPORTED_TARGET', 'Native Layout alignment/scale settings are unavailable.');
            const step: Step = { node, component: layout, type: 'cc.Layout', reads: new Set(), writes: new Set() };
            const grid = layout.type === 3; const horizontal = layout.type === 1 || (grid && layout.startAxis === 0);
            requireValue(!grid || (typeof layout.startAxis === 'number' && [0, 1].includes(layout.startAxis)), 'UI_REFLOW_UNSUPPORTED_TARGET', 'Grid start axis is unsupported.');
            const main = horizontal ? 'width' : 'height'; const cross = horizontal ? 'height' : 'width';
            if (layout.resizeMode !== 1 || grid) add(step.reads, node, 'size', [main]);
            if (layout.resizeMode === 1) add(step.writes, node, 'size', [grid ? cross : main]);
            for (const child of entry.children) {
                const childEntry = scope.get(child)!;
                if (!child.activeInHierarchy || !childEntry.transform) continue;
                const dims = grid ? ['width', 'height'] : [main];
                if (layout.resizeMode === 2) {
                    requireValue(!layout.affectedByScale || (finiteFields(child.scale, ['x', 'y']) && child.scale.x !== 0 && child.scale.y !== 0), 'UI_REFLOW_UNSUPPORTED_TARGET', 'Layout child resizing with zero or unreadable scale is unsupported.');
                    add(step.writes, child, 'size', dims);
                } else add(step.reads, child, 'size', dims);
                add(step.writes, child, 'position', grid || (horizontal ? layout.alignHorizontal : layout.alignVertical) ? ['x', 'y'] : [horizontal ? 'x' : 'y']);
            }
            steps.push(step);
        }
        if (widget && widget.enabled && node.activeInHierarchy) {
            requireValue(entry.transform && typeof widget.updateAlignment === 'function' && typeof widget.isAlignLeft === 'boolean' && typeof widget.isAlignRight === 'boolean' && typeof widget.isAlignTop === 'boolean' && typeof widget.isAlignBottom === 'boolean' && typeof widget.isAlignHorizontalCenter === 'boolean' && typeof widget.isAlignVerticalCenter === 'boolean' && typeof widget.isStretchWidth === 'boolean' && typeof widget.isStretchHeight === 'boolean', 'UI_REFLOW_UNSUPPORTED_TARGET', 'Native Widget alignment settings/updateAlignment are unavailable.');
            const step: Step = { node, component: widget, type: 'cc.Widget', reads: new Set(), writes: new Set() };
            const target: UiReflowNode | null = widget.target ?? node.parent;
            const ancestors: UiReflowNode[] = []; const visited = new Set<UiReflowNode>();
            let ancestor = node.parent;
            while (ancestor) {
                requireValue(!visited.has(ancestor) && ancestors.length < 128, 'UI_REFLOW_UNSUPPORTED_ORDER', 'Widget ancestor traversal is cyclic or exceeds 128 nodes.');
                visited.add(ancestor); ancestors.push(ancestor);
                const ancestorWidget = ancestor.getComponent(cc.Widget);
                requireValue(!ancestorWidget || (scope.has(ancestor) && ancestorWidget.enabled && ancestor.activeInHierarchy), 'UI_REFLOW_EXTERNAL_DEPENDENCY', 'Widget.updateAlignment would realign an out-of-scope or disabled ancestor Widget. Select its enclosing subtree.');
                ancestor = ancestor.parent;
            }
            requireValue(target && ancestors.includes(target), 'UI_REFLOW_UNSUPPORTED_TARGET', 'Widget target must be an authoritative ancestor.');
            for (const dimension of ['width', 'height']) {
                const horizontal = dimension === 'width';
                const aligned = horizontal ? widget.isAlignLeft || widget.isAlignRight || widget.isAlignHorizontalCenter : widget.isAlignTop || widget.isAlignBottom || widget.isAlignVerticalCenter;
                if (!aligned) continue;
                const axis = horizontal ? 'x' : 'y';
                add(step.reads, target, 'size', [dimension]); add(step.writes, node, 'position', [axis]);
                if (horizontal ? widget.isStretchWidth : widget.isStretchHeight) add(step.writes, node, 'size', [dimension]);
                else add(step.reads, node, 'size', [dimension]);
                if (widget.target && target !== node.parent) for (const intermediate of ancestors.slice(0, ancestors.indexOf(target))) add(step.reads, intermediate, 'position', [axis]);
            }
            steps.push(step);
        }
    }
    requireValue(steps.length > 0, 'UI_REFLOW_UNSUPPORTED_TARGET', 'The subtree has no active enabled native Layout or Widget to reflow.');
    const root = nodes[0].node; const parentLayout = root.parent?.getComponent(cc.Layout);
    requireValue(!parentLayout || !parentLayout.enabled || parentLayout.type === 0 || !steps.some(step => [...step.writes].some(key => key.startsWith(`${root.uuid}:size:`))), 'UI_REFLOW_EXTERNAL_DEPENDENCY', 'Root resizing would dirty an out-of-scope parent Layout. Select its enclosing subtree.');
    return steps;
}
function ordered(steps: Step[]): Step[] {
    const edges = steps.map(() => new Set<number>()); const incoming = steps.map(() => 0);
    for (let writer = 0; writer < steps.length; writer++) for (let reader = 0; reader < steps.length; reader++) {
        if (writer === reader) continue;
        requireValue(![...steps[writer].writes].some(key => steps[reader].writes.has(key)), 'UI_REFLOW_UNSUPPORTED_ORDER', 'Layout and Widget have competing writers for the same geometry.');
        const ancestorWidget = steps[writer].type === 'cc.Widget' && steps[reader].type === 'cc.Widget' && isAncestor(steps[writer].node, steps[reader].node);
        if (ancestorWidget || [...steps[writer].writes].some(key => steps[reader].reads.has(key))) { edges[writer].add(reader); incoming[reader]++; }
    }
    const ready = incoming.map((count, index) => count === 0 ? index : -1).filter(index => index >= 0); const result: Step[] = [];
    while (ready.length) { const index = ready.shift()!; result.push(steps[index]); for (const next of edges[index]) if (--incoming[next] === 0) ready.push(next); }
    requireValue(result.length === steps.length, 'UI_REFLOW_UNSUPPORTED_ORDER', 'Layout/Widget dependencies form an unsupported ordering cycle.');
    return result;
}
function isAncestor(parent: UiReflowNode, node: UiReflowNode): boolean { let value = node.parent; let depth = 0; while (value && depth++ < 128) { if (value === parent) return true; value = value.parent; } return false; }
function stableScope(nodes: ScopeNode[]): void {
    for (const entry of nodes) requireValue(entry.node.children.length === entry.children.length && entry.children.every((child, index) => entry.node.children[index] === child && child.parent === entry.node), 'UI_REFLOW_TARGET_CHANGED', 'The planned hierarchy changed during reflow.');
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}
async function serialized(facade: UiReflowFacade): Promise<Record<string, unknown>[]> {
    const text = await facade.querySceneSerializedData();
    requireValue(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= 8388608, 'UI_REFLOW_SERIALIZATION_LIMIT', 'Complete native scene serialization must be available within the 8 MiB internal preflight cap.');
    const value: unknown = JSON.parse(text);
    requireValue(Array.isArray(value) && value.length <= 100000 && value.every(record), 'UI_REFLOW_SERIALIZATION_UNAVAILABLE', 'Native scene serialization is not a supported bounded record array.');
    return value;
}
function protectedSerialization(rows: Record<string, unknown>[], nodes: ScopeNode[], steps: Step[]): string {
    const identities = new Map<string, number>();
    for (let index = 0; index < rows.length; index++) {
        const id = rows[index]._id;
        if (typeof id !== 'string' || !id) continue;
        requireValue(!identities.has(id), 'UI_REFLOW_SERIALIZATION_UNAVAILABLE', 'Native serialization contains duplicate identities.');
        identities.set(id, index);
    }
    const ignored = new Map<number, Map<string, Set<string>>>();
    for (const entry of nodes) {
        const index = identities.get(entry.node.uuid);
        requireValue(index !== undefined && rows[index].__type__ === 'cc.Node', 'UI_REFLOW_SERIALIZATION_UNAVAILABLE', 'Native serialization cannot confirm every planned node identity (linked prefab elision is unsupported).');
        for (const step of steps) for (const key of step.writes) {
            if (!key.startsWith(`${entry.node.uuid}:`)) continue;
            const [property, dimension] = key.slice(entry.node.uuid.length + 1).split(':');
            const target = property === 'position' ? index : entry.transform ? identities.get(entry.transform.uuid) : undefined;
            requireValue(target !== undefined && (property === 'position' || rows[target].__type__ === 'cc.UITransform'), 'UI_REFLOW_SERIALIZATION_UNAVAILABLE', 'Native serialization cannot confirm a planned UITransform identity.');
            const name = property === 'position' ? '_lpos' : '_contentSize';
            requireValue(finiteFields(rows[target][name], property === 'position' ? ['x', 'y', 'z'] : ['width', 'height']), 'UI_REFLOW_SERIALIZATION_UNAVAILABLE', 'Native serialization cannot capture the planned geometry fields.');
            if (!ignored.has(target)) ignored.set(target, new Map());
            const fields = ignored.get(target)!; if (!fields.has(name)) fields.set(name, new Set()); fields.get(name)!.add(dimension);
        }
    }
    return canonical(rows.map((row, index) => {
        const fields = ignored.get(index); if (!fields) return row;
        const copy = { ...row }; for (const [property, dimensions] of fields) { const value = row[property]; requireValue(record(value), 'UI_REFLOW_SERIALIZATION_UNAVAILABLE', 'Native geometry serialization is unavailable.'); const remaining = { ...value }; for (const dimension of dimensions) delete remaining[dimension]; copy[property] = remaining; } return copy;
    }));
}
function sameGeometry(a: UiReflowGeometry[], b: UiReflowGeometry[]): boolean { return canonical(a) === canonical(b); }
function bounded(result: UiReflowResult, maxBytes: number): UiReflowResult {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes) return result;
    const { before: _before, after: _after, order: _order, ...summary } = result;
    return { ...summary, success: false, complete: false, error: { code: 'UI_REFLOW_RESPONSE_LIMIT', message: 'Complete geometry response exceeds maxBytes; inspect changed identities before retrying.', mutationStarted: result.error?.mutationStarted ?? true } };
}

/** Calls only native updateLayout(true)/updateAlignment, with full preflight and independent readback. */
export async function executeUiReflow(
    request: UiReflowRequest, cc: UiReflowEngine,
    resolveNode: (uuid: string) => Promise<UiReflowNode | null>, facade: UiReflowFacade,
): Promise<UiReflowResult> {
    let maxBytes = 32768; let nodes: ScopeNode[] = []; let before: UiReflowGeometry[] = []; let rows: Record<string, unknown>[] | undefined;
    let mutationStarted = false; let recordsRequested = false; let snapshotRequested = false;
    const result: UiReflowResult = { success: false, operation: 'reflow', sceneSaved: false, complete: false, reference: { id: '', type: 'cc.Node' }, checkedNodes: 0, changedNodeIds: [], restoration: 'not-needed', history: { status: 'not-requested', undoRedoVerified: false }, preservation: 'unknown' };
    try {
        requireValue(record(request) && Object.keys(request).every(key => ['nodeUuid', 'maxNodes', 'maxDepth', 'maxBytes'].includes(key)) && typeof request.nodeUuid === 'string' && request.nodeUuid.length > 0 && request.nodeUuid.length <= 256 && request.nodeUuid.trim() === request.nodeUuid, 'INVALID_ARGUMENT', 'Reflow requires one bounded authoritative nodeUuid and optional maxNodes/maxDepth/maxBytes.');
        maxBytes = limit(request.maxBytes, 32768, 32768, 131072);
        const maxNodes = limit(request.maxNodes, 32, 1, 128); const maxDepth = limit(request.maxDepth, 4, 0, 8);
        result.reference.id = request.nodeUuid; result.limits = { maxNodes, maxDepth, maxBytes };
        const version = cc?.ENGINE_VERSION ?? cc?.VERSION;
        requireValue(typeof version === 'string' && /^3\.7\.3(?:$|-)/.test(version), 'UI_REFLOW_VERSION_UNSUPPORTED', 'Reflow requires a matching 3.7.3 engine; 3.8 comparison APIs are not executable contracts.');
        result.engineVersion = version;
        // Stock 3.7.3 exposes UITransformComponent/registry while cc.UITransform can be absent.
        const native: UiReflowEngine = {
            UITransform: cc.UITransform ?? cc.js?.getClassByName('cc.UITransform'),
            Layout: cc.Layout ?? cc.js?.getClassByName('cc.Layout'),
            Widget: cc.Widget ?? cc.js?.getClassByName('cc.Widget'),
        };
        requireValue(cc.GAME_VIEW === false && typeof native.Layout === 'function' && typeof native.Widget === 'function' && typeof native.UITransform === 'function' && typeof facade?.queryMode === 'function' && ['general', 'prefab'].includes(facade.queryMode()) && typeof facade.recordNode === 'function' && typeof facade.snapshot === 'function' && typeof facade.querySceneSerializedData === 'function', 'UI_REFLOW_CONTEXT_UNAVAILABLE', 'Reflow requires the edit-scene native Layout/Widget and recording/serialization facade, not preview or animation mode.');
        const scene = cc.director?.getScene(); const root = await resolveNode(request.nodeUuid);
        requireValue(scene && root && root.uuid === request.nodeUuid && (root === scene || isAncestor(scene, root)), 'UI_REFLOW_TARGET_CHANGED', 'The requested node identity is not in the active edit scene.');
        nodes = collect(root, native, maxNodes, maxDepth); result.checkedNodes = nodes.length;
        const steps = ordered(stepsFor(nodes, native));
        before = nodes.map(geometry); result.before = before;
        result.order = steps.map(step => ({ nodeId: step.node.uuid, componentType: step.type }));
        const reserve = { ...result, success: true, complete: true, after: before, changedNodeIds: nodes.map(entry => entry.node.uuid), restoration: 'not-needed', preservation: 'confirmed', history: { status: 'snapshot-requested', undoRedoVerified: false } };
        // Future finite numbers may need 24 UTF-8 bytes each; reserve the whole response, not one array.
        const serializedReserve = JSON.stringify(reserve, (_key, value) => typeof value === 'number' ? -1.7976931348623157e308 : value);
        requireValue(Buffer.byteLength(serializedReserve, 'utf8') + 1024 <= maxBytes, 'UI_REFLOW_RESPONSE_LIMIT', 'The entire planned before/after geometry response cannot fit maxBytes; no mutation was started.');
        rows = await serialized(facade); const baseline = protectedSerialization(rows, nodes, steps);
        requireValue(cc.director?.getScene() === scene && await resolveNode(request.nodeUuid) === root, 'UI_REFLOW_TARGET_CHANGED', 'The active scene or root identity changed during preflight.');
        stableScope(nodes); requireValue(sameGeometry(before, nodes.map(geometry)), 'UI_REFLOW_TARGET_CHANGED', 'Target geometry changed during preflight.');
        requireValue(canonical(await serialized(facade)) === canonical(rows), 'UI_REFLOW_TARGET_CHANGED', 'Serialized scene state changed before mutation; no reflow was started.');
        requireValue(cc.director?.getScene() === scene && root.uuid === request.nodeUuid, 'UI_REFLOW_TARGET_CHANGED', 'The active scene changed before native dispatch.');
        stableScope(nodes); requireValue(sameGeometry(before, nodes.map(geometry)), 'UI_REFLOW_TARGET_CHANGED', 'Target geometry changed before native dispatch.');
        const changedByPlan = new Set<string>();
        for (const entry of nodes) if (steps.some(step => [...step.writes].some(key => key.startsWith(`${entry.node.uuid}:`)))) changedByPlan.add(entry.node.uuid);
        for (const entry of nodes) if (changedByPlan.has(entry.node.uuid)) {
            recordsRequested = true; requireValue(facade.recordNode(entry.node, true) !== false, 'UI_REFLOW_HISTORY_UNAVAILABLE', 'Native facade refused the pre-mutation node record.');
        }
        const execute = () => {
            for (const step of steps) {
                mutationStarted = true;
                if (step.type === 'cc.Layout') step.component.updateLayout!(true);
                else step.component.updateAlignment!();
            }
        };
        execute(); stableScope(nodes); const first = nodes.map(geometry);
        // A second bounded pass is a convergence witness, not an arbitrary retry or lifecycle invocation.
        execute(); stableScope(nodes); const after = nodes.map(geometry);
        requireValue(sameGeometry(first, after), 'UI_REFLOW_POSTCONDITION_FAILED', 'Native reflow did not reach stable geometry in dependency order.');
        const afterRows = await serialized(facade);
        requireValue(cc.director?.getScene() === scene && root.uuid === request.nodeUuid && sameGeometry(after, nodes.map(geometry)), 'UI_REFLOW_TARGET_CHANGED', 'Target geometry or scene changed during readback.');
        requireValue(protectedSerialization(afterRows, nodes, steps) === baseline, 'UI_REFLOW_PRESERVATION_FAILED', 'Reflow changed serialized fields outside the planned positions/sizes.');
        result.changedNodeIds = after.filter((value, index) => canonical(value) !== canonical(before[index])).map(value => value.id);
        result.after = after; result.preservation = 'confirmed';
        snapshotRequested = true; requireValue(await facade.snapshot() !== false, 'UI_REFLOW_HISTORY_UNAVAILABLE', 'Native facade refused the history snapshot after reflow.');
        requireValue(canonical(await serialized(facade)) === canonical(afterRows), 'UI_REFLOW_POSTCONDITION_FAILED', 'Serialized state changed while recording the reflow snapshot.');
        result.success = true; result.complete = true; result.history.status = 'snapshot-requested';
        return bounded(result, maxBytes);
    } catch (error: unknown) {
        result.error = { code: error instanceof ReflowFailure ? error.code : 'UI_REFLOW_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 512), mutationStarted };
        result.history.status = recordsRequested || snapshotRequested ? 'unknown' : 'not-requested';
        if (mutationStarted) {
            let readable = false; let geometryRestored = false;
            // Restore only the captured mutable geometry, never reload the scene or replay a failed operation.
            for (let index = nodes.length - 1; index >= 0; index--) {
                const entry = nodes[index]; const original = before[index];
                try {
                    if (!finiteFields(entry.node.position, ['x', 'y', 'z']) || original.position.x !== entry.node.position.x || original.position.y !== entry.node.position.y || original.position.z !== entry.node.position.z) {
                        entry.node.setPosition(original.position.x, original.position.y, original.position.z);
                    }
                } catch { /* independent readback below decides restoration */ }
                try {
                    if (original.size && entry.transform && (!finiteFields(entry.transform.contentSize, ['width', 'height'])
                        || original.size.width !== entry.transform.contentSize.width || original.size.height !== entry.transform.contentSize.height)) {
                        entry.transform.setContentSize!(original.size.width, original.size.height);
                    }
                } catch { /* independent readback below decides restoration */ }
            }
            try {
                const after = nodes.map(geometry); result.after = after; readable = true; geometryRestored = sameGeometry(before, after);
                result.changedNodeIds = after.filter((value, index) => canonical(value) !== canonical(before[index])).map(value => value.id);
                const restoredRows = await serialized(facade);
                const restored = rows !== undefined && geometryRestored && canonical(restoredRows) === canonical(rows);
                result.restoration = restored ? 'confirmed' : 'partial'; result.preservation = restored ? 'confirmed' : 'unknown';
            } catch { result.restoration = readable ? 'partial' : 'unknown'; result.preservation = 'unknown'; }
            if (!readable) result.changedNodeIds = nodes.map(entry => entry.node.uuid);
        }
        // Aborting a shared pending snapshot could discard unrelated records. Never do it blindly.
        return bounded(result, maxBytes);
    }
}
