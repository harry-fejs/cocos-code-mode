'use strict';
const { it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');
const { manageBuildProfiles, manageBuildSettings } = requireDist('utcp/build-profiles.js');
afterEach(() => { delete global.Editor; });
function storage() {
  const values = new Map();
  const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const key = (pkg, field, scope) => `${pkg}/${scope}/${field}`;
  global.Editor = { Profile: {
    getProject: async (...args) => copy(values.get(key(...args))),
    setProject: async (pkg, field, value, scope) => { values.set(key(pkg, field, scope), copy(value)); },
    removeProject: async (...args) => { values.delete(key(...args)); },
    getConfig: async (...args) => copy(values.get(key(...args))),
    setConfig: async (pkg, field, value, scope) => { values.set(key(pkg, field, scope), copy(value)); },
    removeConfig: async (...args) => { values.delete(key(...args)); },
  } };
  return values;
}
it('saves reusable options without mutating caller input and deletes the exact profile', async () => {
  storage();
  const options = { platform: 'web-desktop', debug: true, buildPath: 'project://build' };
  await manageBuildProfiles({ operation: 'save', name: 'web-debug', options });
  options.debug = false;
  const saved = await manageBuildProfiles({ operation: 'get', name: 'web-debug' });
  assert.equal(saved.options.debug, true);
  await manageBuildProfiles({ operation: 'save', name: 'web-release', options });
  await manageBuildProfiles({ operation: 'delete', name: 'web-debug' });
  await assert.rejects(manageBuildProfiles({ operation: 'get', name: 'web-debug' }), e => e.code === 'TARGET_NOT_FOUND');
  assert.equal((await manageBuildProfiles({ operation: 'get', name: 'web-release' })).options.debug, false);
});
it('refuses nested credentials and invalid target options before persistence', async () => {
  const values = storage();
  await assert.rejects(manageBuildProfiles({ operation: 'save', name: 'android', options: { platform: 'android', packages: { android: { keystorePassword: 'sensitive' } } } }), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(manageBuildProfiles({ operation: 'save', name: 'bad', options: { platform: 'unknown' } }), e => e.code === 'INVALID_BUILD_PROFILE');
  assert.equal(values.size, 0);
});
it('restores previous setting when Creator rejects the requested value on read-back', async () => {
  const values = storage();
  await manageBuildSettings({ operation: 'set', key: 'common.debug', value: true });
  global.Editor.Profile.setConfig = async (pkg, key, value, scope) => { values.set(`${pkg}/${scope}/${key}`, value === false ? 'invalid' : value); };
  await assert.rejects(manageBuildSettings({ operation: 'set', key: 'common.debug', value: false }), e => e.code === 'BUILD_PROFILE_WRITE_FAILED');
  assert.equal((await manageBuildSettings({ operation: 'get', key: 'common.debug' })).settings['common.debug'], true);
});
it('restores absence after partially applied profile save fails', async () => {
  const values = storage();
  global.Editor.Profile.setProject = async (pkg, key, value, scope) => { values.set(`${pkg}/${scope}/${key}`, value); throw new Error('save failed after applying'); };
  await assert.rejects(manageBuildProfiles({ operation: 'save', name: 'web', options: { platform: 'web-desktop' } }), e => e.code === 'BUILD_PROFILE_WRITE_FAILED');
  assert.equal((await manageBuildProfiles({ operation: 'list' })).total, 0);
});
it('refuses concurrent writes while another profile write is unresolved', async () => {
  storage();
  const setter = global.Editor.Profile.setConfig;
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  global.Editor.Profile.setConfig = async (...args) => { started(); await new Promise(resolve => { release = resolve; }); await setter(...args); };
  const pending = manageBuildSettings({ operation: 'set', key: 'common.debug', value: true });
  await waiting;
  await assert.rejects(manageBuildProfiles({ operation: 'save', name: 'web', options: { platform: 'web-desktop' } }), e => e.code === 'BUILD_PROFILE_BUSY');
  release();
  await pending;
});
it('reports unconfirmed restoration instead of claiming a safe rollback', async () => {
  storage();
  global.Editor.Profile.setConfig = async () => { throw new Error('write failed'); };
  global.Editor.Profile.removeConfig = async () => { throw new Error('restore failed'); };
  await assert.rejects(manageBuildSettings({ operation: 'set', key: 'common.debug', value: true }), e => e.code === 'BUILD_PROFILE_ROLLBACK_FAILED');
});
it('refuses oversized profiles and unsupported settings before storage changes', async () => {
  const values = storage();
  await assert.rejects(manageBuildProfiles({ operation: 'save', name: 'large', options: { platform: 'web-desktop', name: 'x'.repeat(32768) } }), e => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(manageBuildSettings({ operation: 'set', key: 'sdkPath', value: 'C:/sdk' }), e => e.code === 'INVALID_ARGUMENT');
  assert.equal(values.size, 0);
});
it('creates native package settings and refuses an excluded start scene', () => {
  const { createBuildTemplate } = requireDist('utcp/build-profiles.js');
  const scene = { uuid: '12345678-1234-1234-1234-123456789abc', url: 'db://assets/main.scene' };
  const release = createBuildTemplate({ operation: 'create', platform: 'android', mode: 'release', name: 'Game', packageName: 'com.example.game', scenes: [scene] });
  assert.equal(release.options.packages.android.useDebugKeystore, false);
  assert.equal(release.options.debug, false);
  assert.equal(release.options.sourceMaps, false);
  assert.equal(release.options.startScene, scene.uuid);
  assert.throws(() => createBuildTemplate({ operation: 'create', platform: 'web-mobile', name: 'Game', scenes: [scene], startScene: 'not-in-build' }), e => e.code === 'INVALID_ARGUMENT');
  assert.throws(() => createBuildTemplate({ operation: 'create', platform: 'ios', name: 'Game', scenes: [scene] }), e => e.code === 'INVALID_ARGUMENT');
});
it('round trips all platform template options through reusable profiles', async () => {
  storage();
  const { createBuildTemplate } = requireDist('utcp/build-profiles.js');
  const scene = { uuid: '12345678-1234-1234-1234-123456789abc', url: 'db://assets/main.scene' };
  for (const platform of createBuildTemplate({ operation: 'list' }).platforms) {
    const { options } = createBuildTemplate({ operation: 'create', platform, name: 'Game', scenes: [scene], ...(['android', 'ios'].includes(platform) ? { packageName: 'com.example.game' } : {}) });
    await manageBuildProfiles({ operation: 'save', name: platform, options });
    assert.deepEqual((await manageBuildProfiles({ operation: 'get', name: platform })).options, options);
  }
});
