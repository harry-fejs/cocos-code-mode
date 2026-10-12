'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { requireDist } = require('../helpers/require-dist');
const { createBundleOperationSource } = requireDist('utcp/utils/game-view-bundle.js');

function fixture() {
    const bundles = new Map();
    const assets = new Map();
    const original = { name: 'existing-bundle' };
    bundles.set(original.name, original);
    const calls = [];
    const scene = {};
    const url = 'http://127.0.0.1:12345/validation';
    class JsonAsset { constructor() { this.uuid = 'resource-uuid'; this.refCount = 0; } }
    const bundle = {
        name: 'validation', base: `${url}/`, deps: [],
        getAssetInfo: uuid => uuid === 'resource-uuid' ? { uuid } : null,
        getInfoWithPath: path => path === 'sample' ? { uuid: 'resource-uuid' } : null,
        get: () => assets.get('resource-uuid') || null,
        releaseAll() { calls.push('release'); assets.delete('resource-uuid'); },
    };
    const manager = {
        bundles, assets, getBundle: name => bundles.get(name) || null,
        loadBundle(_url, options, callback) {
            calls.push('load'); assert.equal(options.maxRetryCount, 0);
            queueMicrotask(() => { bundles.set(bundle.name, bundle); callback(null, bundle); });
        },
        loadAny(_request, options, callback) {
            assert.equal(options.maxRetryCount, 0);
            queueMicrotask(() => { const asset = new JsonAsset(); assets.set(asset.uuid, asset); callback(null, asset); });
        },
        removeBundle(value) { calls.push('remove'); bundles.delete(value.name); },
        dependUtil: { getDepsRecursively: () => [] },
    };
    const context = vm.createContext({ setTimeout, clearTimeout, cc: {
        GAME_VIEW: true, director: { getScene: () => scene }, assetManager: manager, JsonAsset, isValid: () => true,
    } });
    const run = (extra = {}) => vm.runInContext(createBundleOperationSource({
        bundleName: bundle.name, bundleUrl: url, version: '', expiresAt: Date.now() + 1000,
        resource: { path: 'sample', type: 'JsonAsset' }, ...extra,
    }), context);
    return { bundles, assets, original, calls, bundle, manager, JsonAsset, run };
}

describe('caller-owned Game View bundle lifecycle', () => {
    it('proves typed cache identity and removes only the newly loaded bundle', async () => {
        const f = fixture();
        const result = await f.run();
        assert.equal(result.resource.uuid, 'resource-uuid');
        assert.equal(result.absent, true);
        assert.equal(f.bundles.has(f.bundle.name), false);
        assert.equal(f.assets.has('resource-uuid'), false);
        assert.equal(f.bundles.get(f.original.name), f.original);
    });

    it('refuses preloaded bundle identity without load or destructive release', async () => {
        const f = fixture();
        f.bundles.set(f.bundle.name, f.bundle);
        const result = await f.run();
        assert.equal(result.code, 'BUNDLE_ALREADY_LOADED');
        assert.equal(f.bundles.get(f.bundle.name), f.bundle);
        assert.deepEqual(f.calls, []);
    });

    it('retains an original resource even when its UUID occurs in newly loaded metadata', async () => {
        const f = fixture();
        const originalAsset = new f.JsonAsset();
        f.assets.set(originalAsset.uuid, originalAsset);
        const result = await f.run();
        assert.equal(result.code, 'BUNDLE_SHARED_ASSET');
        assert.equal(f.assets.get(originalAsset.uuid), originalAsset);
        assert.equal(f.bundles.has(f.bundle.name), false);
        assert.equal(f.calls.includes('release'), false);
    });

    it('refuses blind retry after timeout and cleans only its exact late callback object', async () => {
        const f = fixture();
        let finish;
        f.manager.loadBundle = (_url, _options, callback) => { finish = callback; };
        const result = await f.run({ expiresAt: Date.now() + 20 });
        assert.equal(result.code, 'BUNDLE_OPERATION_TIMEOUT');
        assert.equal(result.pendingMayComplete, true);
        assert.equal((await f.run()).code, 'BUNDLE_OPERATION_UNCONFIRMED');
        f.bundles.set(f.bundle.name, f.bundle);
        finish(null, f.bundle);
        assert.equal(f.bundles.has(f.bundle.name), false);
        assert.equal(f.bundles.get(f.original.name), f.original);
    });

    it('returns native missing-bundle error instead of claiming runtime readiness', async () => {
        const f = fixture();
        f.manager.loadBundle = (_url, _options, callback) => queueMicrotask(() => callback(new Error('config missing')));
        const result = await f.run();
        assert.equal(result.code, 'BUNDLE_LOAD_FAILED');
        assert.equal(result.pendingMayComplete, false);
        assert.equal(f.calls.includes('release'), false);
        assert.equal(f.bundles.get(f.original.name), f.original);
    });
});
