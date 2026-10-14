type Row = Record<string, unknown>;
/** Creator 3.7 serializable motion/_items fields; never deserializes engine objects. */
export function inspectGraphMotionClips(value: unknown) {
    const table = Array.isArray(value) ? value : [];
    const row = (input: unknown): Row | undefined => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Row : undefined;
    const issues: Array<{ code: string; path: string }> = [];
    let truncated = false; let visitedObjects = 0;
    const add = (code: string, path: string) => { if (issues.length < 128) issues.push({ code, path: path.slice(0, 256) }); else truncated = true; };
    const resolve = (input: unknown, path: string) => {
        const item = row(input);
        if (!item) return undefined;
        if (!('__id__' in item)) return item;
        const id = item.__id__;
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= table.length || !row(table[id])) { add('INVALID_MOTION_REFERENCE', path); return undefined; }
        return row(table[id]);
    };
    const root = row(Array.isArray(value) ? value[0] : value);
    const clips = new Set<string>();
    const seen = new Set<Row>();
    const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value: root, path: '$', depth: 0 }];
    while (stack.length) {
        if (visitedObjects >= 2048) { truncated = true; break; }
        const next = stack.pop()!;
        if (next.depth > 64) { truncated = true; continue; }
        const object = resolve(next.value, next.path);
        if (!object) { add('INVALID_MOTION_OBJECT', next.path); continue; }
        if (seen.has(object)) continue;
        seen.add(object); visitedObjects++;
        const type = object.__type__;
        if (type === 'cc.animation.ClipMotion') {
            const clip = row(object.clip);
            if (typeof clip?.__uuid__ === 'string' && clip.__uuid__ && clip.__uuid__.length <= 256) clips.add(clip.__uuid__);
            else add('MOTION_CLIP_UNAVAILABLE', next.path);
        }
        const fields = type === 'cc.animation.AnimationGraph' ? ['_layers'] : type === 'cc.animation.Layer' || type === 'cc.animation.SubStateMachine' ? ['_stateMachine']
            : type === 'cc.animation.StateMachine' ? ['_states'] : type === 'cc.animation.Motion' ? ['motion']
            : ['cc.animation.AnimationBlend1D', 'cc.animation.AnimationBlend2D', 'cc.animation.AnimationBlendDirect'].includes(String(type)) ? ['_items']
            : ['cc.animation.AnimationBlend1DItem', 'cc.animation.AnimationBlend2DItem', 'cc.animation.AnimationBlendDirectItem', 'cc.animation.AnimationBlendItem'].includes(String(type)) ? ['motion'] : [];
        if (typeof type === 'string' && type.startsWith('cc.animation.') && !fields.length && type !== 'cc.animation.ClipMotion' && !['cc.animation.State', 'cc.animation.EmptyState'].includes(type)) add('UNSUPPORTED_MOTION_OBJECT', next.path);
        for (const field of fields) {
            const child = object[field];
            if (child === null && field === 'motion') continue;
            if (Array.isArray(child)) {
                if (child.length > 512) truncated = true;
                for (let index = Math.min(child.length, 512) - 1; index >= 0; index--) stack.push({ value: child[index], path: `${next.path}.${field}[${index}]`, depth: next.depth + 1 });
            } else if (row(child)) stack.push({ value: child, path: `${next.path}.${field}`, depth: next.depth + 1 });
            else add('INVALID_MOTION_CHILD', `${next.path}.${field}`);
        }
    }
    const nativeShape = root?.__type__ === 'cc.animation.AnimationGraph';
    return { clipReferences: [...clips].map(clipUuid => ({ clipUuid })), motionIssues: issues, motionTraversalComplete: nativeShape && !truncated && issues.length === 0, motionTraversalTruncated: truncated, inspectedMotionObjects: visitedObjects };
}
