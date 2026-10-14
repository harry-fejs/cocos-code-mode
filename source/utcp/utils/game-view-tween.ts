import type { TweenSequenceModel, TweenVector } from './tween-sequence-model';

export type TweenControlOperation = 'start' | 'pause' | 'resume' | 'stop' | 'inspect';
export interface TweenRuntimeState {
    sessionId: string; sceneUuid: string; sequenceId: string; nodeId: string;
    status: 'not-started' | 'running' | 'paused' | 'completed' | 'stopped' | 'invalidated';
    elapsedSeconds: number | null; durationSeconds: number;
    transform: Record<'position' | 'scale' | 'eulerAngles', TweenVector | null>;
    capabilities: { pause: boolean; resume: boolean };
}
export interface TweenRuntimeRequest { operation: TweenControlOperation; sessionId: string; sessionCreatedAt: number; sceneUuid: string; model: TweenSequenceModel }
export type TweenRuntimeReply = { state: TweenRuntimeState } | { error: { code: string; message: string } };

type NodeLike = { uuid: string; children: NodeLike[]; position?: TweenVector; scale?: TweenVector; eulerAngles?: TweenVector; activeInHierarchy?: boolean; on?: (event: unknown, cb: () => void) => void; off?: (event: unknown, cb: () => void) => void };
type ActionLike = { getElapsed?: () => number; getOriginalTarget?: () => NodeLike };
type TweenLike = { tag: (n: number) => TweenLike; delay: (n: number) => TweenLike; to: (n: number, p: Record<string, unknown>, o: { easing: string }) => TweenLike; by: (n: number, p: Record<string, unknown>, o: { easing: string }) => TweenLike; union: () => TweenLike; repeat: (n: number) => TweenLike; call: (cb: () => void) => TweenLike; start: () => TweenLike; stop: () => TweenLike; pause?: (this: TweenLike) => TweenLike; resume?: (this: TweenLike) => TweenLike };
type ManagerLike = { getActionByTag: (tag: number, node: NodeLike) => ActionLike | null };
type CcLike = { GAME_VIEW?: boolean; ENGINE_VERSION?: unknown; VERSION?: unknown; director?: { getScene: () => NodeLike | null; getSystem?: (id: string) => { ActionManager?: ManagerLike } | null; on?: (e: unknown, cb: () => void) => void; off?: (e: unknown, cb: () => void) => void }; isValid?: (v: unknown, strict?: boolean) => boolean; Node?: { EventType?: { NODE_DESTROYED?: unknown } }; Director?: { EVENT_AFTER_UPDATE?: unknown }; Vec3?: new (x: number, y: number, z: number) => TweenVector; tween?: (n: NodeLike) => TweenLike; TweenSystem?: { instance?: { ActionManager?: ManagerLike } }; Tween?: { prototype?: { pause?: () => unknown; resume?: () => unknown } } };
type Handle = { node: NodeLike; scene: NodeLike; descriptor: string; tween: TweenLike; tag: number; action: ActionLike | null; status: TweenRuntimeState['status']; elapsed: number | null; duration: number; stopOnDisable: boolean; finish: (s: TweenRuntimeState['status']) => void };
type Store = { scene: NodeLike; handles: Map<string, Handle>; nextTag: number };
const isNode = (v: unknown): v is NodeLike => !!v && typeof v === 'object' && 'uuid' in v && 'children' in v && Array.isArray(v.children) && typeof (v as { uuid?: unknown }).uuid === 'string';
const vec = (v: unknown): TweenVector | null => isNode(v) ? null : (v && typeof v === 'object' && ['x', 'y', 'z'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number' && Number.isFinite((v as Record<string, unknown>)[k]))) ? { x: (v as { x: number }).x, y: (v as { y: number }).y, z: (v as { z: number }).z } : null;

const isTweenControl = (value: unknown): value is (this: TweenLike) => TweenLike => typeof value === 'function';
const bindTweenControl = (value: unknown, receiver: TweenLike, message: string): (() => TweenLike) => { if (!isTweenControl(value)) throw { code: 'TWEEN_CONTROL_UNSUPPORTED', message }; return () => value.call(receiver); };
export function gameViewTweenOperation(request: TweenRuntimeRequest, cc: CcLike, root: Record<string, unknown>): TweenRuntimeReply {
    const fail = (code: string, message: string): never => { throw { code, message }; };
    const required = <T>(value: T | null | undefined, message: string): T => { if (value === null || value === undefined) throw new Error(message); return value; };
    try {
        const director = required(cc.director, 'director unavailable');
        const version = cc.ENGINE_VERSION ?? cc.VERSION;
        if (typeof version !== 'string' || !/^3\.7\./.test(version)) fail('UNSUPPORTED_VERSION', 'Tween runtime control requires Creator 3.7.x; Creator 3.8 and unknown versions are unsupported.');
        const scene = required(director.getScene(), 'scene unavailable');
        if (cc.GAME_VIEW !== true || scene.uuid !== request.sceneUuid || !isNode(scene)) fail('RUNTIME_TARGET_CHANGED', 'The bound Game View scene changed.');
        const seen = new Set<NodeLike>(); const stack: NodeLike[] = [scene]; let node: NodeLike | undefined;
        while (stack.length > 0) {
            const current = required(stack.pop(), 'runtime traversal exhausted');
            if (seen.has(current)) fail('RUNTIME_TREE_INVALID', 'Runtime node tree is invalid.');
            seen.add(current);
            if (seen.size > 10000 || stack.length > 10000) fail('RUNTIME_TREE_LIMIT', 'Exact target lookup exceeds 10000 runtime nodes.');
            if (current.uuid === request.model.target.id) { if (node) fail('RUNTIME_TARGET_AMBIGUOUS', 'Multiple runtime nodes expose the declared identity.'); node = current; }
            for (const child of current.children) if (!isNode(child)) fail('RUNTIME_TREE_INVALID', 'Runtime child is not a valid node.'); else stack.push(child);
        }
        const target = required(node, 'target unavailable'); const isValid = required(cc.isValid, 'isValid unavailable');
        if (!isValid(target, true)) fail('RUNTIME_TARGET_NOT_FOUND', 'The exact declared runtime cc.Node is unavailable.');
        const namespace = '__ccpGameViewTweensV1'; let store = root[namespace] as Store | undefined;
        if (store && store.scene !== scene) { for (const h of store.handles.values()) h.finish('invalidated'); delete root[namespace]; store = undefined; }
        const key = JSON.stringify([request.sessionId, request.sessionCreatedAt, request.sceneUuid, request.model.id, request.model.target.id]); const descriptor = JSON.stringify(request.model); let handle = store?.handles.get(key);
        if (handle && (handle.node !== target || handle.scene !== scene)) fail('RUNTIME_TARGET_CHANGED', 'Owned tween target changed.');
        if (handle && handle.descriptor !== descriptor) fail('TWEEN_DESCRIPTOR_CONFLICT', 'Sequence identity is already owned by a different descriptor.');
        const manager = required(cc.TweenSystem?.instance?.ActionManager ?? director.getSystem?.('TWEEN')?.ActionManager, 'tween manager unavailable'); const factory = required(cc.tween, 'tween factory unavailable'); const Vec3 = required(cc.Vec3, 'Vec3 unavailable');
        const reconcile = (h: Handle): void => { if (h.status !== 'running' && h.status !== 'paused') return; if (!isValid(h.node, true) || director.getScene() !== h.scene || (h.node.activeInHierarchy === false && h.stopOnDisable)) { h.finish('invalidated'); return; } if (manager.getActionByTag(h.tag, h.node) !== h.action) h.finish('stopped'); };
        if (handle) reconcile(handle);
        if (request.operation === 'start') {
            if (handle?.status === 'running' || handle?.status === 'paused') fail('TWEEN_ALREADY_ACTIVE', 'Owned sequence is already active.');
            if (target.activeInHierarchy === false) fail('RUNTIME_TARGET_INACTIVE', 'Runtime node is inactive.');
            if (!store) { store = { scene, handles: new Map<string, Handle>(), nextTag: -2 }; root[namespace] = store; }
            for (const h of store.handles.values()) { reconcile(h); if (h.node === target && (h.status === 'running' || h.status === 'paused')) fail('TWEEN_TARGET_BUSY', 'Another CCP tween is active on this node.'); }
            if (!store.handles.has(key) && store.handles.size >= 64) {
                for (const [oldKey, oldHandle] of store.handles) { if (oldHandle.status !== 'running' && oldHandle.status !== 'paused') store.handles.delete(oldKey); if (store.handles.size < 64) break; }
                if (store.handles.size >= 64) fail('TWEEN_HANDLE_LIMIT', 'At most64 active owned sequence handles are permitted per Game View scene.');
            }
            const event = required(cc.Director?.EVENT_AFTER_UPDATE, 'update event unavailable'); const dead = required(cc.Node?.EventType?.NODE_DESTROYED, 'destroy event unavailable'); const on = required(director.on, 'director on unavailable').bind(director); const off = required(director.off, 'director off unavailable').bind(director); const nodeOn = required(target.on, 'node on unavailable').bind(target); const nodeOff = required(target.off, 'node off unavailable').bind(target);
            let tag = store.nextTag--; while (manager.getActionByTag(tag, target)) tag = store.nextTag--;
            const tween = factory(target); for (const step of request.model.steps) { if (step.kind === 'delay') tween.delay(step.duration); else { const props: Record<string, unknown> = {}; for (const p of ['position', 'scale', 'eulerAngles'] as const) { const v = step.properties[p]; if (v) props[p] = new Vec3(v.x, v.y, v.z); } step.kind === 'to' ? tween.to(step.duration, props, { easing: step.easing }) : tween.by(step.duration, props, { easing: step.easing }); } } if (request.model.lifecycle.repeat > 1) tween.union().repeat(request.model.lifecycle.repeat);
            const duration = request.model.steps.reduce((sum, s) => sum + s.duration, 0) * request.model.lifecycle.repeat; const owned: Handle = { node: target, scene, descriptor, tween, tag, action: null, status: 'running', elapsed: 0, duration, stopOnDisable: request.model.lifecycle.stop === 'on-disable', finish: () => undefined };
            const capture = (): void => { const elapsed = owned.action?.getElapsed?.(); owned.elapsed = typeof elapsed === 'number' && Number.isFinite(elapsed) ? Math.max(0, Math.min(duration, elapsed)) : null; }; const tick = (): void => { reconcile(owned); if (owned.status === 'running') capture(); }; const destroyed = (): void => owned.finish('invalidated');
            owned.finish = (status): void => { if (owned.status !== 'running' && owned.status !== 'paused') return; capture(); owned.status = status; if (status === 'completed') owned.elapsed = duration; off(event, tick); nodeOff(dead, destroyed); if (status !== 'completed') tween.stop(); };
            tween.tag(tag).call(() => owned.finish(owned.scene === director.getScene() && isValid(target, true) ? 'completed' : 'invalidated'));
            store.handles.set(key, owned);
            try {
                on(event, tick); nodeOn(dead, destroyed); tween.start(); owned.action = manager.getActionByTag(tag, target);
                if (!owned.action) fail('TWEEN_START_UNCONFIRMED', 'Engine did not register the owned tween action.');
            } catch (error) { owned.finish('invalidated'); store.handles.delete(key); throw error; }
            handle = owned;
        } else if (request.operation !== 'inspect') {
            const active = required(handle, 'No owned tween exists.');
            if (request.operation === 'stop') active.finish('stopped');
            else if (request.operation === 'pause') { const invoke = bindTweenControl(active.tween.pause, active.tween, 'Isolated tween pause is unavailable; target-wide control is forbidden.'); invoke(); active.status = 'paused'; }
            else { const invoke = bindTweenControl(active.tween.resume, active.tween, 'Isolated tween resume is unavailable; target-wide control is forbidden.'); invoke(); active.status = 'running'; }
        }
        if (handle) reconcile(handle); const prototype = cc.Tween?.prototype; return { state: { sessionId: request.sessionId, sceneUuid: scene.uuid, sequenceId: request.model.id, nodeId: target.uuid, status: handle?.status ?? 'not-started', elapsedSeconds: handle?.elapsed ?? 0, durationSeconds: request.model.steps.reduce((sum, s) => sum + s.duration, 0) * request.model.lifecycle.repeat, transform: { position: vec(target.position), scale: vec(target.scale), eulerAngles: vec(target.eulerAngles) }, capabilities: { pause: typeof (handle?.tween.pause ?? prototype?.pause) === 'function', resume: typeof (handle?.tween.resume ?? prototype?.resume) === 'function' } } };
    } catch (error) { const failure = error as { code?: unknown; message?: unknown }; return { error: { code: typeof failure.code === 'string' ? failure.code : 'TWEEN_RUNTIME_FAILED', message: typeof failure.message === 'string' ? failure.message : 'Runtime tween operation failed; success is not claimed.' } }; }
}

export function createTweenRuntimeSource(request: TweenRuntimeRequest): string {
    return `(() => { const isNode = ${isNode.toString()}; const vec = ${vec.toString()}; const isTweenControl = ${isTweenControl.toString()}; const bindTweenControl = ${bindTweenControl.toString()}; return (${gameViewTweenOperation.toString()})(${JSON.stringify(request)}, globalThis.cc, globalThis); })()`;
}
