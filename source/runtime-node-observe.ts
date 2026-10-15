export interface RuntimeNodeObservation {
    nodeUuid: string;
    parentUuid: string | null;
    childUuids: string[];
    childCount: number;
    childrenTruncated: boolean;
    active: boolean;
    activeInHierarchy: boolean;
    position: { x: number; y: number; z: number };
    worldPosition: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    worldRotation: { x: number; y: number; z: number; w: number };
}

/** Serialized finite Game View reader. No component access, methods supplied by callers or mutation. */
export function observeRuntimeNode(nodeUuid: string, expiresAt: number): RuntimeNodeObservation | { code: string; message: string } {
    try {
        const fail = (code: string, message: string): never => { throw { code, message }; };
        type Node = { uuid: string; children: Node[]; parent: Node | null; active: boolean; activeInHierarchy: boolean; position: unknown; worldPosition: unknown; scale: unknown; rotation: unknown; worldRotation: unknown };
        const cc = (globalThis as unknown as { cc?: { GAME_VIEW?: boolean; ENGINE_VERSION?: string; VERSION?: string; director?: { getScene(): Node | null }; isValid(value: unknown, strict?: boolean): boolean } }).cc;
        if (!cc || cc.GAME_VIEW !== true) fail('UNSUPPORTED_RUNTIME_TRANSPORT', 'Actual Game View required.');
        const engine = cc!;
        if (!/^3\.7\./.test(engine.ENGINE_VERSION ?? engine.VERSION ?? '')) fail('UNSUPPORTED_VERSION', 'Runtime node observation requires Creator3.7.x.');
        const scene = engine.director?.getScene();
        if (!scene) fail('RUNTIME_NOT_READY', 'No running Game View scene.');
        const stack: Array<{ node: Node; depth: number }> = [{ node: scene!, depth: 0 }];
        const seen = new Set<Node>(); let target: Node | undefined; let scheduled = 1;
        while (stack.length) {
            if (Date.now() >= expiresAt) fail('RUNTIME_STATE_TIMEOUT', 'Node observation deadline elapsed.');
            const { node, depth } = stack.pop()!;
            if (!node || typeof node !== 'object' || typeof node.uuid !== 'string' || !node.uuid || node.uuid.length > 256 || seen.has(node) || !Array.isArray(node.children)) fail('RUNTIME_TREE_INVALID', 'Malformed or repeated runtime node.');
            if (depth > 256) fail('RUNTIME_TRAVERSAL_LIMIT', 'Runtime tree exceeds256 levels.');
            seen.add(node);
            if (node.uuid === nodeUuid) {
                if (target) fail('AMBIGUOUS_RUNTIME_TARGET', 'Duplicate runtime node identity.');
                target = node;
            }
            scheduled += node.children.length;
            if (scheduled > 10000) fail('RUNTIME_TRAVERSAL_LIMIT', 'Runtime tree exceeds10000 scheduled nodes.');
            for (const child of node.children) {
                if (!child || child.parent !== node) fail('RUNTIME_TREE_INVALID', 'Runtime child parent mismatch.');
                stack.push({ node: child, depth: depth + 1 });
            }
        }
        if (!target) fail('NODE_NOT_FOUND', 'Exact runtime node absent.');
        const node = target!;
        const vector = (value: unknown) => {
            const row = value as { x?: unknown; y?: unknown; z?: unknown } | null;
            if (!row || [row.x, row.y, row.z].some(n => typeof n !== 'number' || !Number.isFinite(n))) fail('UNSUPPORTED_RUNTIME_METRIC', 'Finite native vector unavailable.');
            return { x: row!.x as number, y: row!.y as number, z: row!.z as number };
        };
        const quaternion = (value: unknown) => {
            const row = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown } | null;
            if (!row || [row.x, row.y, row.z, row.w].some(n => typeof n !== 'number' || !Number.isFinite(n))) fail('UNSUPPORTED_RUNTIME_METRIC', 'Finite native quaternion unavailable.');
            return { x: row!.x as number, y: row!.y as number, z: row!.z as number, w: row!.w as number };
        };
        if (typeof node.active !== 'boolean' || typeof node.activeInHierarchy !== 'boolean') fail('UNSUPPORTED_RUNTIME_METRIC', 'Native activation state unavailable.');
        const parent = node.parent;
        if (node !== scene && (!parent || typeof parent.uuid !== 'string' || !parent.uuid || parent.uuid.length > 256 || !parent.children.includes(node))) fail('RUNTIME_TARGET_CHANGED', 'Runtime parent identity unavailable.');
        const childCount = node.children.length;
        const childUuids = node.children.slice(0, 128).map(child => child.uuid);
        const result = { nodeUuid, parentUuid: parent?.uuid ?? null, childUuids, childCount, childrenTruncated: childCount > childUuids.length, active: node.active, activeInHierarchy: node.activeInHierarchy, position: vector(node.position), worldPosition: vector(node.worldPosition), scale: vector(node.scale), rotation: quaternion(node.rotation), worldRotation: quaternion(node.worldRotation) };
        let ancestor: Node | null = node; let attached = false;
        for (let depth = 0; ancestor && depth <= 256; depth++, ancestor = ancestor.parent) if (ancestor === scene) { attached = true; break; }
        if (!attached || engine !== (globalThis as unknown as { cc?: unknown }).cc || engine.director?.getScene() !== scene || !engine.isValid(node, true) || node.uuid !== nodeUuid) fail('RUNTIME_TARGET_CHANGED', 'Runtime node or scene changed during observation.');
        if (node.parent !== parent || node.children.length !== childCount || childUuids.some((id, index) => node.children[index]?.uuid !== id || node.children[index]?.parent !== node)) fail('RUNTIME_TARGET_CHANGED', 'Runtime hierarchy changed during observation.');
        if (Date.now() >= expiresAt) fail('RUNTIME_STATE_TIMEOUT', 'Node observation completed after deadline.');
        return result;
    } catch (error) {
        const known = error as { code?: unknown; message?: unknown };
        return { code: typeof known?.code === 'string' ? known.code : 'RUNTIME_NODE_OBSERVATION_FAILED', message: typeof known?.message === 'string' ? known.message.slice(0, 256) : 'Runtime node observation failed.' };
    }
}
