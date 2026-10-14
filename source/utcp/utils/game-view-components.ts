import { ToolError } from '../tool-error';
import { executeGameViewOperation } from './game-view-transport';
import { RuntimeSessionTools } from '../tools/runtime-session-tools';

export interface ComponentTarget { sessionId: string; nodeReference: { id: string }; componentId?: string }
export interface ComponentOperation extends ComponentTarget {
    kind: 'particle' | 'animation' | 'skeletal' | 'events' | 'graph'; operation: string; clipName?: string; clipUuid?: string;
    timeoutMs?: number; maxEvents?: number; variable?: { name: string; type: 'float' | 'integer' | 'boolean'; value: number | boolean; expectedValue?: number | boolean };
    expectedGraphUuid?: string;
    maxClips?: number; clipOffset?: number;
}
interface RuntimeClip { name: string; uuid: string }
interface RuntimeState { clip: RuntimeClip; isPlaying: boolean; isPaused: boolean; time?: unknown; duration?: unknown; speed?: unknown }
interface RuntimeValue { [key: string]: unknown }
type RuntimeCallback = (...values: unknown[]) => void;
interface RuntimeComponent {
    uuid: string; node: RuntimeNode; clips: unknown; graph: unknown; layerCount: unknown;
    isPlaying: unknown; isPaused?: unknown; isStopped?: unknown; time?: unknown;
    play?: RuntimeCallback; pause?: RuntimeCallback; resume?: RuntimeCallback; stop?: RuntimeCallback; clear?: RuntimeCallback; getParticleCount?: () => unknown;
    getState?: (name: string) => RuntimeState | null; on?: (type: string, callback: RuntimeCallback) => unknown; off?: (type: string, callback: RuntimeCallback) => unknown;
    getVariables?: () => Iterable<readonly [string, RuntimeValue]>; getValue?: (name: string) => unknown; setValue?: (name: string, value: number | boolean) => unknown;
    getCurrentStateStatus?: (layer: number) => RuntimeValue | null; getCurrentClipStatuses?: (layer: number) => Iterable<RuntimeValue>; getCurrentTransition?: (layer: number) => RuntimeValue | null;
}
interface RuntimeNode { uuid: string; children: RuntimeNode[]; parent: RuntimeNode | null; getComponents(ctor: unknown): RuntimeComponent[] }
interface RuntimeEngine { GAME_VIEW: boolean; ENGINE_VERSION?: unknown; VERSION?: unknown; director: { getScene(): RuntimeNode }; ParticleSystem?: unknown; Animation?: unknown; SkeletalAnimation?: unknown; js?: { getClassByName(name: string): unknown }; animation?: { AnimationController?: unknown; VariableType?: RuntimeValue }; isValid(value: unknown, strict?: boolean): boolean }
interface RuntimeResolved { cc: RuntimeEngine; scene: RuntimeNode; node: RuntimeNode; component: RuntimeComponent; valid: () => boolean; fail: (code: string, message: string) => never }

function requireDefined<T>(value: T | null | undefined, name: string): T {
    if (value === undefined || value === null) throw new Error(`${name} is unavailable`);
    return value;
}
export function requireComponentText(value: unknown, name: string, max = 256): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must contain 1..${max} characters.` });
}
export function validateComponentTarget(args: ComponentTarget, exact = true): void {
    requireComponentText(args?.sessionId, 'sessionId', 64);
    requireComponentText(args?.nodeReference?.id, 'nodeReference.id');
    if (exact || args.componentId !== undefined) requireComponentText(args.componentId, 'componentId');
}

// This function is serialized only after all contract fields have been validated by the host tool.
function resolveComponent(args: ComponentOperation): RuntimeResolved {
    const globalObject = globalThis as { cc?: unknown };
    const cc = requireDefined(globalObject.cc as RuntimeEngine | undefined, 'cc');
    const fail = (code: string, message: string): never => { throw { code, message }; };
    if (cc.GAME_VIEW !== true) fail('UNSUPPORTED_RUNTIME_TRANSPORT', 'An actual Creator Game View renderer is required.');
    const version = cc.ENGINE_VERSION ?? cc.VERSION;
    if (typeof version !== 'string' || !/^3\.7\./.test(version)) fail('UNSUPPORTED_VERSION', 'Component runtime routes require Creator 3.7.x; Creator 3.8 and unknown versions are unsupported.');
    const scene = requireDefined(cc.director?.getScene(), 'scene');
    const pending: Array<{ node: RuntimeNode; depth: number }> = [{ node: scene, depth: 0 }];
    const seen = new Set<RuntimeNode>();
    let node: RuntimeNode | undefined;
    while (pending.length) {
        const next = pending.pop();
        if (!next) continue;
        if (seen.has(next.node)) fail('RUNTIME_TREE_INVALID', 'Runtime node tree contains a cycle or duplicate reference.');
        if (seen.size >= 10000 || next.depth > 256) fail('RUNTIME_TRAVERSAL_LIMIT', 'Node traversal exceeded the bounded runtime tree capacity.');
        seen.add(next.node);
        if (next.node.uuid === args.nodeReference.id) {
            if (node) fail('AMBIGUOUS_RUNTIME_TARGET', 'Multiple runtime nodes expose the declared identity.');
            node = next.node;
        }
        if (!Array.isArray(next.node.children) || next.node.children.length + pending.length > 10000) fail('RUNTIME_TRAVERSAL_LIMIT', 'Node children exceed the bounded traversal capacity.');
        for (const child of next.node.children) {
            if (!child || typeof child !== 'object' || typeof child.uuid !== 'string' || !Array.isArray(child.children)) fail('RUNTIME_TREE_INVALID', 'Runtime child is not a valid node.');
            if (seen.has(child)) fail('RUNTIME_TREE_INVALID', 'Runtime node tree contains a cycle or duplicate reference.');
            pending.push({ node: child, depth: next.depth + 1 });
        }
    }
    const targetNode = requireDefined(node, 'node');
    const ctor = args.kind === 'particle'
        ? requireDefined(cc.ParticleSystem ?? cc.js?.getClassByName('cc.ParticleSystem'), 'ParticleSystem')
        : args.kind === 'graph'
            ? requireDefined(cc.animation?.AnimationController ?? cc.js?.getClassByName('cc.animation.AnimationController'), 'AnimationController')
            : args.kind === 'skeletal'
                ? requireDefined(cc.SkeletalAnimation ?? cc.js?.getClassByName('cc.SkeletalAnimation'), 'SkeletalAnimation')
                : requireDefined(cc.Animation ?? cc.js?.getClassByName('cc.Animation'), 'Animation');
    const components = targetNode.getComponents(ctor);
    if (!Array.isArray(components) || components.length > 256) fail('RUNTIME_COMPONENT_LIMIT', 'Component collection exceeds 256 entries.');
    const matches = args.componentId === undefined ? components : components.filter((item) => item.uuid === args.componentId);
    if (!matches.length) fail('COMPONENT_NOT_FOUND', 'The exact supported component is absent; Spine, DragonBones and ParticleSystem2D are not supported.');
    if (matches.length !== 1) fail('AMBIGUOUS_RUNTIME_COMPONENT', 'Specify componentId when a node contains multiple supported components.');
    const component = requireDefined(matches[0], 'component');
    if (!component.uuid || component.node !== targetNode) fail('INVALID_RUNTIME_RESPONSE', 'Component identity is unavailable.');
    const valid = () => cc === (globalThis as { cc?: unknown }).cc && cc.GAME_VIEW === true && cc.director.getScene() === scene
        && cc.isValid(targetNode, true) && cc.isValid(component, true) && component.node === targetNode && targetNode.uuid === args.nodeReference.id
        && component.uuid === matches[0].uuid && targetNode.getComponents(ctor).includes(component) && (() => {
            let parent: RuntimeNode | null = targetNode;
            for (let depth = 0; parent && depth <= 256; depth++, parent = parent.parent) if (parent === scene) return true;
            return false;
        })();
    if (!valid()) fail('RUNTIME_TARGET_CHANGED', 'Node or component is not a valid member of the running scene.');
    return { cc, scene, node: targetNode, component, valid, fail };
}

function finiteNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function objectValue(value: unknown): RuntimeValue | null { return value && typeof value === 'object' ? value as RuntimeValue : null; }

async function componentOperation(args: ComponentOperation & { expiresAt: number }): Promise<Record<string, unknown>> {
    let mutated = false;
    try {
        const { cc, node, component: c, valid, fail } = resolveComponent(args);
        const identity = { nodeUuid: node.uuid, componentId: c.uuid };
        const assertTarget = () => { if (!valid()) fail('RUNTIME_TARGET_CHANGED', 'Game View node/component identity changed.'); };
        const assertDeadline = () => { if (Date.now() >= args.expiresAt) fail('RUNTIME_STATE_TIMEOUT', 'Component operation deadline expired.'); };
        if (args.kind === 'particle') {
            if (typeof c.play !== 'function' || typeof c.stop !== 'function' || typeof c.clear !== 'function' || typeof c.getParticleCount !== 'function') fail('UNSUPPORTED_RUNTIME_COMPONENT', 'ParticleSystem playback APIs are unavailable.');
            if (!['play', 'stop', 'clear', 'inspect'].includes(args.operation)) fail('INVALID_ARGUMENT', 'Unknown particle operation.');
            assertDeadline();
            if (args.operation !== 'inspect') {
                mutated = true;
                if (args.operation === 'play') c.play!.call(c); else if (args.operation === 'stop') c.stop!.call(c); else c.clear!.call(c);
            }
            assertTarget();
            const count = finiteNumber(c.getParticleCount!.call(c));
            if (typeof c.isPlaying !== 'boolean' || (args.operation === 'play' && !c.isPlaying) || (args.operation === 'stop' && c.isPlaying) || (args.operation === 'clear' && count !== 0)) fail('READBACK_MISMATCH', 'Particle playback postcondition did not match actual engine state.');
            return { ...identity, state: { playing: c.isPlaying, paused: typeof c.isPaused === 'boolean' ? c.isPaused : null, stopped: typeof c.isStopped === 'boolean' ? c.isStopped : null, particleCount: count, time: finiteNumber(c.time) } };
        }
        if (args.kind === 'animation' || args.kind === 'skeletal' || args.kind === 'events') {
            const clipsValue: unknown = c.clips;
            if (!Array.isArray(clipsValue) || clipsValue.length > 256) fail('UNSUPPORTED_RUNTIME_COMPONENT', 'Animation clips/state API is unavailable or exceeds 256 clips.');
            const clipList = clipsValue as unknown[];
            if (args.operation === 'inspect' && args.kind === 'animation') {
                assertDeadline();
                const limit = args.maxClips ?? 32;
                if (!Number.isInteger(limit) || limit < 1 || limit > 128) fail('INVALID_ARGUMENT', 'maxClips must be1..128.');
                const offset = args.clipOffset ?? 0;
                if (!Number.isInteger(offset) || offset < 0 || offset > clipList.length) fail('INVALID_ARGUMENT', 'clipOffset must be within the current clip collection.');
                const inventory: Array<{ clipName: string | null; clipUuid: string | null; uniqueName: boolean; empty: boolean }> = [];
                const names = new Map<string, number>();
                const slots: Array<[string, string] | null> = [];
                for (const candidate of clipList) {
                    if (candidate === null) { slots.push(null); continue; }
                    const clip = objectValue(candidate);
                    if (!clip || typeof clip.name !== 'string' || !clip.name || clip.name.length > 256 || typeof clip.uuid !== 'string' || !clip.uuid || clip.uuid.length > 256) fail('INVALID_RUNTIME_RESPONSE', 'Runtime clip identity is unavailable or exceeds bounds.');
                    const name = (clip as RuntimeValue).name as string;
                    names.set(name, (names.get(name) ?? 0) + 1);
                    slots.push([name, (clip as RuntimeValue).uuid as string]);
                }
                for (const candidate of clipList.slice(offset, offset + limit)) {
                    if (candidate === null) { inventory.push({ clipName: null, clipUuid: null, uniqueName: false, empty: true }); continue; }
                    const clip = candidate as RuntimeClip;
                    inventory.push({ clipName: clip.name, clipUuid: clip.uuid, uniqueName: names.get(clip.name) === 1, empty: false });
                }
                assertTarget(); assertDeadline();
                if (c.clips !== clipsValue || clipList.length !== slots.length || slots.some((slot, index) => { const clip = clipList[index] as RuntimeClip | null; return slot === null ? clip !== null : !clip || clip.name !== slot[0] || clip.uuid !== slot[1]; })) fail('RUNTIME_TARGET_CHANGED', 'Clip inventory changed during inspection.');
                const nextOffset = offset + inventory.length < clipList.length ? offset + inventory.length : null;
                return { ...identity, clips: inventory, totalClips: clipList.length, clipOffset: offset, nextOffset, truncated: nextOffset !== null, inventorySnapshot: JSON.stringify(slots) };
            }
            const clips = (clipsValue as unknown[]).filter((value: unknown): value is RuntimeClip => { const item = objectValue(value); return !!item && typeof item.name === 'string' && typeof item.uuid === 'string' && item.name === args.clipName; });
            if (clips.length !== 1 || clips[0].uuid !== args.clipUuid) fail('ANIMATION_CLIP_NOT_FOUND', 'Clip name must identify exactly one clip with the requested UUID.');
            const clip = clips[0]; const getState = requireDefined(c.getState, 'animation getState').bind(c); const state = requireDefined(getState(args.clipName!), 'animation state');
            if (state.clip !== clip || typeof state.isPlaying !== 'boolean' || typeof state.isPaused !== 'boolean') fail('UNSUPPORTED_RUNTIME_COMPONENT', 'The named AnimationState is unavailable or identifies another clip.');
            const assertAnimation = () => { assertTarget(); if (getState(args.clipName!) !== state || state.clip !== clip || clip.uuid !== args.clipUuid || clip.name !== args.clipName || !Array.isArray(c.clips) || !c.clips.includes(clip)) fail('RUNTIME_TARGET_CHANGED', 'Animation clip/state identity changed.'); };
            const snapshot = () => ({ playing: state.isPlaying, paused: state.isPaused, time: finiteNumber(state.time), duration: finiteNumber(state.duration), speed: finiteNumber(state.speed) });
            const skeletalCtor = cc.SkeletalAnimation ?? cc.js?.getClassByName('cc.SkeletalAnimation');
            const animationIdentity = { ...identity, componentType: args.kind === 'skeletal' ? 'cc.SkeletalAnimation' : typeof skeletalCtor === 'function' && c instanceof skeletalCtor ? 'cc.SkeletalAnimation' : 'cc.Animation', clipName: clip.name, clipUuid: clip.uuid };
            if (args.operation === 'observe' && args.kind !== 'events') {
                assertDeadline(); assertAnimation();
                return { ...animationIdentity, state: snapshot() };
            }
            if ((args.kind === 'animation' || args.kind === 'skeletal') && args.operation !== 'observe') {
                const play = requireDefined(c.play, 'animation play'); const pause = requireDefined(c.pause, 'animation pause'); const resume = requireDefined(c.resume, 'animation resume'); const stop = requireDefined(c.stop, 'animation stop');
                for (const otherClip of c.clips as Array<RuntimeClip | null>) {
                    if (otherClip === null || otherClip === clip) continue;
                    const otherState = getState(otherClip.name);
                    if (otherState?.isPlaying) fail('ANIMATION_TARGET_BUSY', 'Another clip is active on this component; component-wide control would affect an unrelated playback.');
                }
                if (args.operation === 'pause' && (!state.isPlaying || state.isPaused)) fail('INVALID_ANIMATION_STATE', 'Pause requires a playing clip.');
                if (args.operation === 'resume' && (!state.isPlaying || !state.isPaused)) fail('INVALID_ANIMATION_STATE', 'Resume requires a paused clip.');
                assertAnimation(); assertDeadline(); mutated = true;
                if (args.operation === 'play') play.call(c, args.clipName); else if (args.operation === 'pause') pause.call(c); else if (args.operation === 'resume') resume.call(c); else if (args.operation === 'stop') stop.call(c); else fail('INVALID_ARGUMENT', 'Unknown animation operation.');
                assertAnimation(); const result = snapshot();
                if (args.operation === 'stop' ? result.playing : !result.playing || result.paused !== (args.operation === 'pause')) fail('READBACK_MISMATCH', 'Animation state did not match operation.');
                return { ...animationIdentity, state: result };
            }
            if (typeof c.on !== 'function' || typeof c.off !== 'function') fail('UNSUPPORTED_RUNTIME_COMPONENT', 'Animation event APIs are unavailable.');
            assertDeadline();
            const events: Array<Record<string, unknown>> = []; const listeners: Array<{ type: string; callback: RuntimeCallback }> = [];
            let timer: ReturnType<typeof setTimeout> | undefined; let poll: ReturnType<typeof setInterval> | undefined; const start = Date.now(); let reason = 'deadline';
            try {
                await new Promise<void>((done, reject) => {
                    let settled = false;
                    const finish = () => { if (settled) return; settled = true; done(); };
                    const abort = (error: unknown) => { if (settled) return; settled = true; reject(error); };
                    const capture = (type: string, eventState: unknown) => { if (settled) return; try { assertAnimation(); if (Date.now() >= args.expiresAt) { finish(); return; } if (eventState !== state) return; events.push({ sequence: events.length + 1, type, elapsedMs: Date.now() - start, clipName: clip.name, clipUuid: clip.uuid, state: snapshot() }); if (events.length >= (args.maxEvents ?? 20)) { reason = 'max-events'; finish(); } } catch (error) { abort(error); } };
                    for (const type of ['play', 'pause', 'resume', 'stop', 'lastframe', 'finished']) { const callback: RuntimeCallback = (_type: unknown, eventState: unknown) => capture(type, eventState); listeners.push({ type, callback }); c.on!.call(c, type, callback); }
                    timer = setTimeout(finish, Math.max(0, args.expiresAt - Date.now())); poll = setInterval(() => { if (settled) return; try { assertAnimation(); } catch (error) { abort(error); } }, 25);
                });
                assertAnimation(); return { ...animationIdentity, events, reason, elapsedMs: Date.now() - start, state: snapshot() };
                } finally { clearTimeout(timer); clearInterval(poll); let cleanupFailed = false; for (const listener of listeners) { try { c.off!.call(c, listener.type, listener.callback); } catch { cleanupFailed = true; } } if (cleanupFailed) fail('RUNTIME_LISTENER_CLEANUP_FAILED', 'Animation listeners could not all be removed.'); }
        }
        if (args.kind !== 'graph' || !c.graph || typeof c.getVariables !== 'function' || typeof c.getValue !== 'function' || typeof c.setValue !== 'function' || typeof c.getCurrentStateStatus !== 'function' || typeof c.getCurrentClipStatuses !== 'function' || typeof c.getCurrentTransition !== 'function') fail('UNSUPPORTED_RUNTIME_COMPONENT', 'AnimationController graph/runtime status APIs are unavailable.');
        const getVariables = c.getVariables!.bind(c); const getValue = c.getValue!.bind(c); const setValue = c.setValue!.bind(c); const getCurrentStateStatus = c.getCurrentStateStatus!.bind(c); const getCurrentClipStatuses = c.getCurrentClipStatuses!.bind(c); const getCurrentTransition = c.getCurrentTransition!.bind(c);
        const graph = c.graph; const graphUuid = objectValue(graph)?.uuid;
        if (args.expectedGraphUuid !== undefined && graphUuid !== args.expectedGraphUuid) fail('RUNTIME_TARGET_CHANGED', 'Runtime graph UUID does not match caller precondition.');
        const assertGraph = () => { assertTarget(); if (c.graph !== graph || objectValue(graph)?.uuid !== graphUuid) fail('RUNTIME_TARGET_CHANGED', 'AnimationController graph identity changed during operation.'); };
        const layerCountValue: unknown = c.layerCount;
        if (typeof layerCountValue !== 'number' || !Number.isInteger(layerCountValue) || layerCountValue < 0 || layerCountValue > 16) fail('RUNTIME_GRAPH_LIMIT', 'Graph layer count must be within 0..16.');
        const layerCount = layerCountValue;
        const variables: Array<Record<string, unknown>> = [];
        const variableNames = new Set<string>();
        for (const [name, description] of getVariables()) {
            if (variables.length >= 64 || typeof name !== 'string' || !name || name.length > 256 || !description || typeof description.type !== 'number' || !Number.isInteger(description.type) || description.type < 0 || description.type > 3) fail('INVALID_RUNTIME_RESPONSE', 'Graph variable metadata is invalid or exceeds bounds.');
            if (variableNames.has(name)) fail('AMBIGUOUS_GRAPH_VARIABLE', 'Graph variable names must identify exactly one declaration; no mutation dispatched.');
            variableNames.add(name);
            const value = getValue(name); variables.push({ name, type: description.type, value: typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 256 ? value : null });
        }
        if (args.operation === 'setVariable') {
            const variable = requireDefined(args.variable, 'variable'); const entry = requireDefined(variables.find(item => item.name === variable.name), 'graph variable');
            const currentValue = entry.value;
            const declaredType = variable.type === 'boolean' ? 1 : variable.type === 'integer' ? 3 : 0;
            if (entry.type !== declaredType || (variable.type === 'boolean' ? typeof currentValue !== 'boolean' : typeof currentValue !== 'number')) fail('UNSUPPORTED_GRAPH_VARIABLE', 'Only matching Creator3.7 FLOAT, INTEGER and BOOLEAN variables may change.');
            if (variable.expectedValue !== undefined && getValue(variable.name) !== variable.expectedValue) fail('GRAPH_VARIABLE_CONFLICT', 'Graph variable differs from expectedValue; no mutation dispatched.');
            assertDeadline(); assertGraph(); mutated = true; setValue(variable.name, variable.value); assertGraph(); const readBack = getValue(variable.name); if (readBack !== variable.value) fail('READBACK_MISMATCH', 'Graph variable mutation did not match runtime read-back.'); entry.value = readBack;
        } else if (args.operation !== 'inspect') fail('INVALID_ARGUMENT', 'Unknown graph operation.');
        const layers: Array<Record<string, unknown>> = [];
        for (let index = 0; index < Number(layerCount); index++) { const current = getCurrentStateStatus(index); const transition = getCurrentTransition(index); const clips: Array<Record<string, unknown>> = []; for (const status of getCurrentClipStatuses(index)) { if (clips.length >= 32) fail('RUNTIME_GRAPH_LIMIT', 'Graph layer exceeds 32 current clips.'); const clipValue = objectValue(status.clip); clips.push({ clipName: typeof clipValue?.name === 'string' ? clipValue.name.slice(0, 256) : null, clipUuid: typeof clipValue?.uuid === 'string' ? clipValue.uuid.slice(0, 256) : null, weight: finiteNumber(status.weight) }); } layers.push({ index, current: current ? { progress: finiteNumber(current.progress) } : null, transition: transition ? { duration: finiteNumber(transition.duration) } : null, clips }); }
        assertGraph(); return { ...identity, graphUuid: typeof graphUuid === 'string' ? graphUuid : null, variables, layers };
    } catch (error) { const known = error as { code?: string; message?: string }; return { code: known.code ?? 'RUNTIME_COMPONENT_FAILED', message: String(known.message ?? 'Component runtime operation failed.').slice(0, 512), mutationDispatched: mutated }; }
}

export function createComponentOperationSource(args: ComponentOperation): string {
    const timeoutMs = args.timeoutMs ?? 1000;
    const data = { kind: args.kind, operation: args.operation, nodeReference: { id: args.nodeReference.id }, componentId: args.componentId, clipName: args.clipName, clipUuid: args.clipUuid, maxEvents: args.maxEvents, maxClips: args.maxClips, clipOffset: args.clipOffset, expectedGraphUuid: args.expectedGraphUuid, variable: args.variable ? { name: args.variable.name, type: args.variable.type, value: args.variable.value, expectedValue: args.variable.expectedValue } : undefined, expiresAt: Date.now() + timeoutMs };
    return `(() => { const requireDefined = ${requireDefined.toString()}; const finiteNumber = ${finiteNumber.toString()}; const objectValue = ${objectValue.toString()}; const resolveComponent = ${resolveComponent.toString()}; return (${componentOperation.toString()})(${JSON.stringify(data)}); })()`;
}

export async function executeComponentOperation(args: ComponentOperation): Promise<Record<string, unknown>> {
    validateComponentTarget(args, args.kind !== 'particle');
    const runtime = new RuntimeSessionTools(); const inspected = await runtime.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId }); const session = inspected.session;
    if (!session || !('status' in session) || !('targetId' in session) || !('targetKind' in session) || session.sessionId !== args.sessionId || session.status !== 'attached' || session.targetKind !== 'game-view' || typeof session.targetId !== 'string' || !inspected.ready) { if (session && 'status' in session && session.status === 'stopped') throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: 'The runtime session is stopped.' }); throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'The exact attached Game View session is not ready.' }); }
    const mutation = args.kind !== 'events' && !['inspect', 'observe'].includes(args.operation); const result = await executeGameViewOperation(session.targetId, createComponentOperationSource(args), (args.timeoutMs ?? 1000) + 2000, mutation) as Record<string, unknown> | null;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Component operation returned no typed runtime state.' });
    if (typeof result.code === 'string') throw new ToolError({ code: result.code, status: /NOT_FOUND$/.test(result.code) ? 404 : result.code.startsWith('UNSUPPORTED') ? 422 : 409, message: typeof result.message === 'string' ? result.message : 'Component operation failed.', details: { mutationDispatched: result.mutationDispatched === true, retrySafe: result.mutationDispatched === false } });
    if (result.nodeUuid !== args.nodeReference.id || typeof result.componentId !== 'string' || !result.componentId || args.componentId !== undefined && result.componentId !== args.componentId) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Runtime component response does not identify the requested component.' });
    const after = await runtime.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId }); const afterSession = after.session;
    if (!after.ready || !afterSession || !('status' in afterSession) || !('targetId' in afterSession) || !('targetKind' in afterSession) || afterSession.status !== 'attached' || afterSession.sessionId !== session.sessionId || afterSession.targetId !== session.targetId || afterSession.targetKind !== session.targetKind) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Runtime session identity changed during the component operation.', details: { mutationDispatched: mutation, retrySafe: !mutation } });
    return { success: true, sessionId: session.sessionId, targetId: session.targetId, operation: args.operation, nodeReference: { id: args.nodeReference.id }, ...result };
}
