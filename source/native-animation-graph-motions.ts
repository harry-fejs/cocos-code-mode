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
    const declarations = resolve(root?._variables, '$._variables');
    const checkBinding = (input: unknown, path: string) => {
        const binding = resolve(input, path);
        if (!binding || binding.__type__ !== 'cc.animation.BindableNumber' || typeof binding.variable !== 'string') { add('INVALID_BLEND_PARAMETER', path); return; }
        if (!binding.variable) {
            if (typeof binding.value !== 'number' || !Number.isFinite(binding.value)) add('INVALID_BLEND_PARAMETER_VALUE', path);
            return;
        }
        if (!declarations || !Object.prototype.hasOwnProperty.call(declarations, binding.variable)) { add('UNDECLARED_BLEND_VARIABLE', path); return; }
        const variable = resolve(declarations[binding.variable], `${path}.variable`);
        if (!variable || variable.__type__ !== 'cc.animation.PlainVariable' || (variable._type !== 0 && variable._type !== 3)) add('BLEND_VARIABLE_NOT_NUMERIC', path);
    };
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
        if (type === 'cc.animation.AnimationBlend1D') {
            checkBinding(object.param, `${next.path}.param`);
            if (Array.isArray(object._items)) {
                let previous: number | undefined;
                for (let index = 0; index < Math.min(object._items.length, 512); index++) {
                    const item = resolve(object._items[index], `${next.path}._items[${index}]`);
                    const threshold = item?.threshold;
                    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) { previous = undefined; continue; }
                    if (previous !== undefined && threshold < previous) add('UNSORTED_BLEND_THRESHOLDS', `${next.path}._items[${index}].threshold`);
                    previous = threshold;
                }
            }
        }
        if (type === 'cc.animation.AnimationBlend2D') {
            checkBinding(object.paramX, `${next.path}.paramX`);
            checkBinding(object.paramY, `${next.path}.paramY`);
            if (typeof object.algorithm !== 'number' || !Number.isInteger(object.algorithm) || object.algorithm < 0 || object.algorithm > 2) add('INVALID_BLEND_ALGORITHM', `${next.path}.algorithm`);
        }
        if (type === 'cc.animation.AnimationBlend1DItem' && (typeof object.threshold !== 'number' || !Number.isFinite(object.threshold))) add('INVALID_BLEND_THRESHOLD', `${next.path}.threshold`);
        if (type === 'cc.animation.AnimationBlend2DItem') {
            const threshold = resolve(object.threshold, `${next.path}.threshold`);
            if (!threshold || typeof threshold.x !== 'number' || !Number.isFinite(threshold.x) || typeof threshold.y !== 'number' || !Number.isFinite(threshold.y)) add('INVALID_BLEND_THRESHOLD', `${next.path}.threshold`);
        }
        if (type === 'cc.animation.AnimationBlendDirectItem' && (typeof object.weight !== 'number' || !Number.isFinite(object.weight))) add('INVALID_BLEND_WEIGHT', `${next.path}.weight`);
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
