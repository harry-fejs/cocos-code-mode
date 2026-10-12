import { BundleResourceType } from './asset-bundle-artifact';

export interface BundleRuntimeRequest {
    bundleName: string; bundleUrl: string; version: string; expiresAt: number;
    resource?: { path: string; type: BundleResourceType };
}
interface RuntimeAsset { uuid: string; refCount?: number }
interface RuntimeBundle {
    name: string; base: string; deps: string[];
    getAssetInfo(uuid: string): { uuid: string; redirect?: string } | null;
    getInfoWithPath(path: string, type: unknown): { uuid: string; redirect?: string } | null;
    get(path: string, type: unknown): RuntimeAsset | null;
    releaseAll(): void;
}
interface RuntimeCache<T> { forEach(callback: (value: T, key: string) => void): void; get(key: string): T | undefined }
interface RuntimeManager {
    bundles: RuntimeCache<RuntimeBundle>; assets: RuntimeCache<RuntimeAsset>;
    getBundle(name: string): RuntimeBundle | null;
    loadBundle(url: string, options: Record<string, unknown>, callback: (error: unknown, bundle?: RuntimeBundle) => void): void;
    loadAny(request: Record<string, unknown>, options: Record<string, unknown>, callback: (error: unknown, asset?: RuntimeAsset) => void): void;
    removeBundle(bundle: RuntimeBundle): void;
    dependUtil: { getDepsRecursively(uuid: string): string[] };
}
interface RuntimeEngine { GAME_VIEW: boolean; assetManager: RuntimeManager; director: { getScene(): unknown }; js?: { getClassByName(name: string): unknown }; isValid(value: unknown): boolean; [key: string]: unknown }
interface BundleLease { bundle?: RuntimeBundle; pending: boolean }

/** Fixed trusted renderer handler: all caller input is data, never source code. */
export async function validateRuntimeBundle(args: BundleRuntimeRequest): Promise<Record<string, unknown>> {
    const globals = globalThis as unknown as { cc?: RuntimeEngine; [key: symbol]: Map<string, BundleLease> | undefined };
    const leasesKey = Symbol.for('ccp3x.bundleRuntimeLeases');
    const leases = globals[leasesKey] ?? new Map<string, BundleLease>();
    globals[leasesKey] = leases;
    const cc = globals.cc; const manager = cc?.assetManager; const scene = cc?.director?.getScene();
    let lease: BundleLease | undefined; let owned: RuntimeBundle | undefined; let mutated = false; let cleaned = false;
    const acquired = new Map<string, RuntimeAsset>();
    const bundlesBefore = new Map<string, RuntimeBundle>(); const assetsBefore = new Map<string, RuntimeAsset>();
    const fail = (code: string, message: string): never => { throw { code, message }; };
    const assertTarget = () => { if (!cc || globals.cc !== cc || cc.GAME_VIEW !== true || !scene || cc.director.getScene() !== scene || cc.assetManager !== manager) fail('RUNTIME_TARGET_CHANGED', 'Game View identity changed during bundle validation.'); };
    const assertDeadline = () => { if (Date.now() >= args.expiresAt) fail('BUNDLE_OPERATION_TIMEOUT', 'Bundle callback deadline elapsed; no retry was sent.'); };
    const preservesOriginals = () => {
        if (!manager) return false;
        for (const [name, bundle] of bundlesBefore) if (manager.getBundle(name) !== bundle) return false;
        for (const [uuid, asset] of assetsBefore) if (manager.assets.get(uuid) !== asset) return false;
        return true;
    };
    const owns = (bundle: RuntimeBundle) => !!manager && bundle.name === args.bundleName && bundle.base === `${args.bundleUrl}/` && manager.getBundle(args.bundleName) === bundle;
    const cleanup = () => {
        if (!owned || cleaned) return;
        assertTarget();
        if (!owns(owned)) fail('BUNDLE_IDENTITY_CHANGED', 'The loaded bundle is no longer the caller-owned exact object; no release was sent.');
        // releaseAll force-releases cached bundle assets and dependencies. Never
        // invoke it on a bundle that contains an original or externally-owned asset.
        for (const [uuid] of assetsBefore) if (owned.getAssetInfo(uuid)) fail('BUNDLE_SHARED_ASSET', 'Bundle asset UUID overlaps data loaded before this call; releaseAll is refused.');
        manager!.assets.forEach((asset, uuid) => {
            if (!owned!.getAssetInfo(uuid) || assetsBefore.has(uuid)) return;
            const dependencies = manager!.dependUtil.getDepsRecursively(asset.uuid);
            if (acquired.get(uuid) !== asset) fail('BUNDLE_ASSET_IN_USE', 'An unrelated consumer loaded a bundle asset during validation; releaseAll is refused.');
            if (!Array.isArray(dependencies) || dependencies.length > 10000 || dependencies.some(id => assetsBefore.has(id) || !owned!.getAssetInfo(id))) fail('BUNDLE_SHARED_DEPENDENCY', 'Loaded resource references preexisting or external assets; destructive release is refused.');
            if (typeof asset.refCount === 'number' && asset.refCount > 0) fail('BUNDLE_ASSET_IN_USE', 'A runtime consumer retained the validation asset; releaseAll is refused.');
        });
        owned.releaseAll(); manager!.removeBundle(owned);
        if (manager!.getBundle(args.bundleName)) fail('BUNDLE_RELEASE_MISMATCH', 'getBundle is not absent after removing the exact loaded bundle.');
        if (!preservesOriginals()) fail('BUNDLE_UNRELATED_STATE_CHANGED', 'Preexisting bundle or resource identity changed during validation.');
        cleaned = true; leases.delete(args.bundleName);
    };
    const callbackOperation = <T>(dispatch: (callback: (error: unknown, value?: T) => void) => void, accept: (value: T) => void): Promise<T> => new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { settled = true; reject({ code: 'BUNDLE_OPERATION_TIMEOUT', message: 'Bundle engine callback did not complete before the deadline; inspect before retrying.' }); }, Math.max(0, args.expiresAt - Date.now()));
        const callback = (error: unknown, value?: T) => {
            if (lease) lease.pending = false;
            const late = settled || Date.now() >= args.expiresAt;
            clearTimeout(timer);
            try {
                if (value !== undefined && !error) accept(value);
                if (late) {
                    // A delayed native callback can still cache its result. Clean
                    // only the captured caller-owned object, never a name lookup.
                    cleanup();
                    if (!owned && lease) leases.delete(args.bundleName);
                    if (!settled) { settled = true; reject({ code: 'BUNDLE_OPERATION_TIMEOUT', message: 'Engine callback arrived after the bundle deadline.' }); }
                    return;
                }
                settled = true;
                if (error || value === undefined) reject({ code: 'BUNDLE_LOAD_FAILED', message: String(error instanceof Error ? error.message : error ?? 'Engine returned no bundle/resource.').slice(0, 512) });
                else resolve(value);
            } catch (failure) { if (!settled) { settled = true; reject(failure); } }
        };
        try { assertDeadline(); if (lease) lease.pending = true; mutated = true; dispatch(callback); }
        catch (error) { clearTimeout(timer); if (lease) lease.pending = false; settled = true; reject(error); }
    });
    try {
        assertTarget(); assertDeadline();
        if (!manager || typeof manager.getBundle !== 'function' || typeof manager.loadBundle !== 'function' || typeof manager.removeBundle !== 'function' || typeof manager.assets?.forEach !== 'function' || typeof manager.bundles?.forEach !== 'function' || typeof manager.dependUtil?.getDepsRecursively !== 'function') fail('UNSUPPORTED_BUNDLE_RUNTIME', 'Public bundle/cache ownership APIs are unavailable.');
        const api = manager!;
        if (leases.has(args.bundleName)) fail('BUNDLE_OPERATION_UNCONFIRMED', 'A prior validation owns this bundle name or has an unsettled native callback; no retry was sent.');
        if (api.getBundle(args.bundleName)) fail('BUNDLE_ALREADY_LOADED', 'The requested bundle is already loaded; it belongs to the runtime and will not be released.');
        api.bundles.forEach((bundle, name) => { if (bundlesBefore.size >= 256) fail('BUNDLE_RUNTIME_LIMIT', 'Runtime bundle cache exceeds 256 entries.'); bundlesBefore.set(name, bundle); });
        api.assets.forEach((asset, uuid) => { if (assetsBefore.size >= 20000) fail('BUNDLE_RUNTIME_LIMIT', 'Runtime asset cache exceeds 20000 entries.'); assetsBefore.set(uuid, asset); });
        lease = { pending: false }; leases.set(args.bundleName, lease);
        await callbackOperation<RuntimeBundle>(callback => api.loadBundle(args.bundleUrl, { version: args.version || undefined, maxRetryCount: 0, xhrTimeout: Math.max(1, args.expiresAt - Date.now()) }, callback), bundle => {
            assertTarget();
            if (!owns(bundle) || bundlesBefore.has(bundle.name)) fail('BUNDLE_IDENTITY_MISMATCH', 'Native loadBundle returned a preexisting or different bundle; it will not be released.');
            owned = bundle; lease!.bundle = bundle;
            if (!Array.isArray(bundle.deps) || bundle.deps.length || typeof bundle.getAssetInfo !== 'function' || typeof bundle.releaseAll !== 'function') fail('UNSUPPORTED_BUNDLE_RUNTIME', 'Loaded bundle ownership/release APIs or standalone dependencies differ.');
        });
        assertTarget(); assertDeadline();
        for (const [uuid] of assetsBefore) if (owned!.getAssetInfo(uuid)) {
            // Loading bundle metadata alone did not acquire these resources.
            // Remove only our config object; never release user's cached assets.
            api.removeBundle(owned!); owned = undefined; leases.delete(args.bundleName);
            fail('BUNDLE_SHARED_ASSET', 'The built bundle contains a preexisting resource UUID; resource loading and releaseAll were refused.');
        }
        let resource: Record<string, unknown> | null = null;
        if (args.resource) {
            const requested = args.resource;
            const ctor = cc![requested.type] ?? cc!.js?.getClassByName(`cc.${requested.type}`);
            if (typeof ctor !== 'function' || typeof owned!.getInfoWithPath !== 'function' || typeof owned!.get !== 'function' || typeof api.loadAny !== 'function') fail('UNSUPPORTED_BUNDLE_RESOURCE', 'The allowlisted resource class or public load API is unavailable.');
            const info = owned!.getInfoWithPath(requested.path, ctor);
            if (!info || info.redirect || !info.uuid) throw { code: 'BUNDLE_RESOURCE_NOT_FOUND', message: 'The exact typed resource is absent from this standalone bundle.' };
            if (api.assets.get(info!.uuid) || owned!.get(requested.path, ctor)) {
                api.removeBundle(owned!); owned = undefined; leases.delete(args.bundleName);
                fail('BUNDLE_RESOURCE_ALREADY_LOADED', 'The requested resource was cached by another consumer; no resource load or release was sent.');
            }
            const loaded = await callbackOperation<RuntimeAsset>(callback => api.loadAny({ path: requested.path, type: ctor, bundle: args.bundleName }, { maxRetryCount: 0, xhrTimeout: Math.max(1, args.expiresAt - Date.now()) }, callback), asset => {
                assertTarget();
                if (!owns(owned!) || asset.uuid !== info.uuid || !cc!.isValid(asset) || owned!.get(requested.path, ctor) !== asset) fail('BUNDLE_RESOURCE_MISMATCH', 'The callback and typed resource cache do not identify the requested asset.');
                acquired.set(asset.uuid, asset);
                for (const uuid of api.dependUtil.getDepsRecursively(asset.uuid)) {
                    const dependency = api.assets.get(uuid);
                    if (dependency && !assetsBefore.has(uuid) && owned!.getAssetInfo(uuid)) acquired.set(uuid, dependency);
                }
            });
            resource = { path: requested.path, type: requested.type, uuid: loaded.uuid, loaded: true };
        }
        assertDeadline(); cleanup();
        return { bundleName: args.bundleName, loaded: true, identityVerified: true, resource, released: true, removed: true, absent: true, unrelatedPreserved: true };
    } catch (error) {
        let cleanupFailure: string | undefined;
        if (lease && !lease.pending) {
            try { cleanup(); if (!owned) leases.delete(args.bundleName); }
            catch (failure) { cleanupFailure = String((failure as { message?: string }).message ?? 'Owned bundle cleanup could not be verified.').slice(0, 512); }
        }
        const known = error as { code?: string; message?: string };
        return { code: known.code ?? 'BUNDLE_RUNTIME_FAILED', message: String(known.message ?? 'Native bundle validation failed.').slice(0, 512), mutationDispatched: mutated, cleanupVerified: cleaned, pendingMayComplete: lease?.pending === true, ...(cleanupFailure ? { cleanupFailure } : {}), retrySafe: !mutated || cleaned };
    }
}

export function createBundleOperationSource(args: BundleRuntimeRequest): string {
    return `(${validateRuntimeBundle.toString()})(${JSON.stringify(args)})`;
}
