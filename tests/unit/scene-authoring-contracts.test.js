'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');

const { SceneTools } = requireDist('utcp/tools/scene-tools.js');
const { ComponentTools } = requireDist('utcp/tools/component-tools.js');
const { SetPropertyTool } = requireDist('utcp/tools/set-properties-tool.js');

const previousEditor = global.Editor;
afterEach(() => { global.Editor = previousEditor; });

it('creates a Creator3.7 scene from its exact flat native template and confirms the output importer', async () => {
  const calls = [];
  global.Editor = { App: { version: '3.7.3' }, Message: { request: async (_module, message, ...args) => {
    calls.push([message, args[0]]);
    if (message === 'query-asset-info') return args[0] === 'scene-created' ? { uuid: 'scene-created', type: 'cc.SceneAsset', isDirectory: false } : { type: 'cc.Asset', isDirectory: false, url: args[0] };
    if (message === 'copy-asset') return { uuid: 'scene-created' };
    throw new Error(message);
  } } };
  const created = await new SceneTools().sceneCreate({ assetPath: 'db://assets/scene.scene' });
  assert.equal(created.reference.type, 'cc.SceneAsset');
  assert.deepEqual(calls[0], ['query-asset-info', 'db://internal/default_file_content/scene']);
});

describe('scene authoring mutation postconditions', () => {
  it('confirms opened scene identity and rejects mismatched read-back', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_module, message, payload) => {
      calls.push([message, payload]);
      if (message === 'open-scene') return true;
      if (message === 'query-current-scene') return { uuid: 'other-scene' };
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().sceneOpen({ reference: { id: 'requested-scene' } }),
      error => error.code === 'SCENE_OPEN_UNCONFIRMED' && error.status === 502,
    );
    assert.deepEqual(calls, [['open-scene', 'requested-scene'], ['query-current-scene', undefined]]);
  });

  it('creates a node only when query-node confirms the returned UUID', async () => {
    let confirmed = false;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'create-node') return 'created-node';
      if (message === 'snapshot') return true;
      if (message === 'query-node') return confirmed ? { uuid: payload } : null;
      throw new Error(`unexpected ${message}`);
    } } };
    const tool = new SceneTools();
    await assert.rejects(
      tool.sceneCreateNode({ name: 'Child', parentReference: { id: 'parent' } }),
      error => error.code === 'NODE_CREATE_UNCONFIRMED',
    );
    confirmed = true;
    assert.deepEqual(await tool.sceneCreateNode({ name: 'Child', parentReference: { id: 'parent' } }), {
      reference: { id: 'created-node', type: 'cc.Node' },
    });
  });

  it('fails move when the authoritative parent read-back differs', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node') {
        queries++;
        return queries === 1 ? { uuid: payload } : { uuid: payload, parent: { value: { uuid: 'wrong-parent' } } };
      }
      if (message === 'set-parent' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().nodeOperate({ operation: 'move', reference: { id: 'child' }, newParentReference: { id: 'parent' } }),
      error => error.code === 'NODE_MOVE_UNCONFIRMED',
    );
  });
});

describe('component authoring mutation postconditions', () => {
  it('removes a component only when query-component confirms absence', async () => {
    let queries = 0;
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-component') return ++queries === 1 ? { uuid: 'component' } : { uuid: 'component' };
      if (message === 'remove-component') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new ComponentTools().nodeComponentRemove({ reference: { id: 'component' } }),
      /still exists after removal/,
    );
  });

  it('adds a component with type and UUID verified from node read-back', async () => {
    let queryCount = 0;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node') {
        queryCount++;
        if (queryCount === 1) return { __comps__: [] };
        return { __comps__: [{ type: 'cc.Label', value: { uuid: { value: 'label-component' } } }] };
      }
      if (message === 'execute-scene-script') return payload.method === 'stopCatchLogging' ? [] : true;
      if (message === 'create-component' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(
      await new ComponentTools().nodeComponentAdd({ reference: { id: 'node' }, componentType: 'cc.Label' }),
      { reference: { id: 'label-component', type: 'cc.Label' } },
    );
  });
});

describe('inspector property mutation postconditions', () => {
  it('rejects a set-property success when a fresh dump keeps the old value', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node') return {
        uuid: payload,
        __type__: 'cc.Node',
        __comps__: [],
        children: { value: [] },
        active: { value: false, type: 'Boolean' },
      };
      if (message === 'set-property' || message === 'snapshot') return true;
      if (_module === 'asset-db') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SetPropertyTool().setInstanceProperties({ reference: { id: 'node' }, propertyPaths: ['active'], values: [true] }),
      /Property mutation was not confirmed/,
    );
  });
});

describe('scene inspection identity contracts', () => {
  it('nodeGetTree returns authoritative component UUID and type', async () => {
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return {
        uuid: 'root', name: 'Root', components: [{ value: { uuid: { value: 'comp-1' }, __type__: { value: 'cc.Label' } } }], children: [],
      };
      if (message === 'query-current-scene') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().nodeGetTree({ fields: ['components'] });
    assert.deepEqual(result.reference, { id: 'root', type: 'cc.Node' });
    assert.deepEqual(result.components, [{ id: 'comp-1', type: 'cc.Label' }]);
    assert.deepEqual(result.children, []);
    assert.equal(result.childrenCount, 0);
    assert.equal(result.childOffset, 0);
    assert.equal(result.pageSize, 200);
    assert.equal(result.nextOffset, null);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
  });
  it('nodeGetTree accepts Creator 3.7 scalar component UUID dumps', async () => {
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return {
        uuid: 'root', name: 'Root', components: [{ type: 'cc.DirectionalLight', value: 'component-3x7' }], children: [],
      };
      if (message === 'query-current-scene') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().nodeGetTree({ fields: ['components'] });
    assert.deepEqual(result.reference, { id: 'root', type: 'cc.Node' });
    assert.deepEqual(result.components, [{ id: 'component-3x7', type: 'cc.DirectionalLight' }]);
    assert.deepEqual(result.children, []);
    assert.equal(result.childrenCount, 0);
    assert.equal(result.childOffset, 0);
    assert.equal(result.pageSize, 200);
    assert.equal(result.nextOffset, null);
    assert.match(result.revision, /^[a-f0-9]{64}$/);
  });
  it('pages root children in native order with a stable revision token', async () => {
    const tree = { uuid: 'root', name: 'Root', children: [
      { uuid: 'a', name: 'A', children: [] },
      { uuid: 'b', name: 'B', children: [] },
      { uuid: 'c', name: 'C', children: [] },
    ] };
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return tree;
      if (message === 'query-current-scene') return { uuid: 'scene-1' };
      if (_module === 'asset-db' && message === 'query-asset-info') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new SceneTools();
    const first = await tools.nodeGetTree({ pageSize: 2 });
    assert.deepEqual(first.children.map((item) => item.reference.id), ['a', 'b']);
    assert.equal(first.childrenCount, 3);
    assert.equal(first.childOffset, 0);
    assert.equal(first.pageSize, 2);
    assert.equal(first.nextOffset, 2);
    assert.match(first.revision, /^[a-f0-9]{64}$/);
    const second = await tools.nodeGetTree({ childOffset: first.nextOffset, pageSize: 2, expectedRevision: first.revision });
    assert.deepEqual(second.children.map((item) => item.reference.id), ['c']);
    assert.equal(second.nextOffset, null);
  });

  it('rejects a page when the hierarchy revision changes', async () => {
    let tree = { uuid: 'root', name: 'Root', children: [{ uuid: 'a', name: 'A', children: [] }] };
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node-tree') return tree;
      if (message === 'query-current-scene') return { uuid: 'scene-1' };
      if (_module === 'asset-db' && message === 'query-asset-info') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new SceneTools();
    const first = await tools.nodeGetTree({ pageSize: 1 });
    tree = { uuid: 'root', name: 'Root', children: [{ uuid: 'b', name: 'B', children: [] }] };
    await assert.rejects(
      tools.nodeGetTree({ childOffset: 0, pageSize: 1, expectedRevision: first.revision }),
      (error) => error.code === 'HIERARCHY_REVISION_CONFLICT' && error.status === 409,
    );
  });

  it('nodeComponentsGet rejects a matched component missing authoritative type', async () => {
    global.Editor = { Message: { request: async (_module, message) => {
      if (message === 'query-node') return { __comps__: [{ value: { uuid: { value: 'comp-1' } } }] };
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new ComponentTools().nodeComponentsGet({ reference: { id: 'node' } }),
      /lacks authoritative uuid\/type/,
    );
  });

  it('inspectorSet rejects malformed property arrays with typed error', async () => {
    await assert.rejects(
      new SetPropertyTool().setInstanceProperties({ reference: { id: 'node' }, propertyPaths: [], values: [] }),
      error => error.code === 'INVALID_ARGUMENT' && error.status === 400,
    );
  });
});
describe('camera authoring adapters', () => {
  it('creates a camera and confirms node/component identity', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root' };
      if (message === 'create-node') return 'camera-node';
      if (message === 'create-component') return true;
      if (message === 'query-node') return { uuid: payload, __comps__: [{ type: 'cc.Camera', uuid: 'camera-component' }] };
      if (message === 'snapshot' || message === 'set-property') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().cameraCreate({ name: 'Camera' }), {
      nodeReference: { id: 'camera-node', type: 'cc.Node' },
      cameraReference: { id: 'camera-component', type: 'cc.Camera' },
    });
  });

  it('lists cameras with bounded authoritative component references', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root', name: 'Root', children: [{ uuid: 'node-1', name: 'Main Camera', children: [] }] };
      if (message === 'query-node') return payload === 'root' ? { uuid: 'root', __comps__: [] } : { uuid: payload, __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, projection: { value: 0 } } }] };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().cameraList(), {
      cameras: [{ nodeReference: { id: 'node-1', type: 'cc.Node' }, name: 'Main Camera', cameraReference: { id: 'camera-1', type: 'cc.Camera' }, priority: undefined, visibility: undefined, projection: 0 }],
      total: 1,
      truncated: false,
    });
  });

  it('sets camera properties only when read-back matches', async () => {
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }], children: [] }] };
      if (message === 'query-node') return { uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }] };
      if (message === 'set-property' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().cameraSetProperties({ reference: { id: 'camera-1' }, properties: { fov: 45 } }), { updated: true, reference: { id: 'camera-1', type: 'cc.Camera' } });
  });
});
  it('restores earlier camera properties when a later write fails', async () => {
    let fov = 45;
    let writes = 0;
    global.Editor = { Message: { request: async (_module, message, payload) => {
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: fov }, priority: { value: 1 } } }] }] };
      if (message === 'query-node') return { uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: fov }, priority: { value: 1 } } }] };
      if (message === 'set-property') { writes++; if (payload.path.endsWith('.fov')) { fov = payload.dump.value; return true; } return false; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().cameraSetProperties({ reference: { id: 'camera-1' }, properties: { fov: 60, priority: 2 } }),
      error => error.code === 'CAMERA_PROPERTY_UPDATE_FAILED' && error.details.rollbackFailure === null,
    );
    assert.equal(fov, 45);
    assert.equal(writes, 4);
  });

describe('final scene adapters', () => {
  it('refuses a directory masquerading as a scene before returning a SceneAsset reference', async () => {
    let directory = true;
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'copy-asset') return { uuid: 'scene-1' };
      if (message === 'query-asset-info') return id === 'scene-1'
        ? { uuid: 'scene-1', type: directory ? 'cc.Asset' : 'cc.SceneAsset', isDirectory: directory }
        : { uuid: 'template', url: id, type: 'cc.SceneAsset', isDirectory: false };
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(new SceneTools().sceneCreate({ assetPath: 'db://assets/final.scene' }), error => error.code === 'SCENE_CREATE_UNCONFIRMED');
    directory = false;
    assert.deepEqual(await new SceneTools().sceneCreate({ assetPath: 'db://assets/final.scene' }), { success: true, reference: { id: 'scene-1', type: 'cc.SceneAsset' } });
  });

  it('returns authoritative node and component inspection payloads', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-node') return { uuid: id, __type__: { value: 'cc.Node' }, __comps__: [] };
      if (message === 'query-component') return { uuid: id, type: 'cc.Label', string: { value: 'hello' } };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.equal((await new SceneTools().sceneNodeType({ reference: { id: 'node-1' } })).type, 'cc.Node');
    assert.equal((await new SceneTools().sceneComponentInfo({ reference: { id: 'component-1' } })).type, 'cc.Label');
  });
});

describe('scene composite residual adapters', () => {
  it('sceneGetInfo returns dirty alias and hierarchy node count', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-scene-bounds') return { x: 0, y: 0, width: 10, height: 20 };
      if (message === 'query-dirty') return true;
      if (message === 'query-current-scene') return { uuid: 'scene-1', name: 'Main' };
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'child', children: [] }] };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().sceneGetInfo(), { bounds: { x: 0, y: 0, width: 10, height: 20 }, name: 'Main', uuid: 'scene-1', dirty: true, isDirty: true, nodeCount: 2, currentScene: { uuid: 'scene-1', name: 'Main' } });
  });

  it('nodeSetTransform applies exact paths and confirms read-back', async () => {
    const calls = [];
    const node = { uuid: 'node-1', position: { value: { x: 1, y: 2, z: 3 } }, eulerAngles: { value: { x: 4, y: 5, z: 6 } }, scale: { value: { x: 1, y: 1, z: 1 } }, active: { value: true } };
    global.Editor = { Message: { request: async (_service, message, payload) => {
      calls.push([message, payload]);
      if (message === 'query-node') return node;
      if (message === 'set-property') { node[payload.path] = { value: payload.dump.value }; return true; }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().nodeSetTransform({ reference: { id: 'node-1' }, position: { x: 8, y: 9, z: 10 }, rotation: { x: 11, y: 12, z: 13 }, scale: { x: 2, y: 3, z: 4 }, active: false }), { updated: true, reference: { id: 'node-1', type: 'cc.Node' } });
    assert.deepEqual(calls.filter(([message]) => message === 'set-property').map(([, payload]) => payload.path), ['position', 'eulerAngles', 'scale', 'active']);
  });

  it('lifecycle save and save-as require authoritative outcomes', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_service, message) => {
      calls.push(message);
      if (message === 'query-dirty') return false;
      if (message === 'save-as-scene') return 'scene-2';
      if (message === 'query-current-scene') return 'scene-2';
      return true;
    } } };
    const tools = new (requireDist('utcp/tools/editor-tools.js').EditorTools)();
    assert.deepEqual(await tools.editorOperate({ operation: 'save_scene_or_prefab' }), { success: true, saved: true });
    assert.deepEqual(await tools.editorOperate({ operation: 'save_as' }), { success: true, reference: { id: 'scene-2', type: 'cc.SceneAsset' } });
    assert.deepEqual(calls, ['save-scene', 'query-dirty', 'save-as-scene', 'query-current-scene']);
  });
});

describe('scene residual bounded contracts', () => {
  it('nodeGetInfo and queryComponents return authoritative bounded data', async () => {
    global.Editor = { Message: { request: async (_service, message, payload) => {
      if (message === 'query-node') return { uuid: payload, __type__: { value: 'cc.Node' }, __comps__: [] };
      if (message === 'query-components') return [{ name: 'cc.Node' }, { name: 'cc.Label' }, { name: 'GameController' }];
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new SceneTools();
    assert.equal((await tools.nodeGetInfo({ reference: { id: 'node-1' } })).uuid, 'node-1');
    assert.deepEqual(await tools.queryComponents({ filter: 'cc.', limit: 1 }), { componentTypes: ['cc.Node'], total: 2, truncated: true });
  });

  it('callComponentMethod rejects non-allowlisted methods before IPC', async () => {
    let calls = 0;
    global.Editor = { Message: { request: async () => { calls += 1; return {}; } } };
    await assert.rejects(new SceneTools().callComponentMethod({ reference: { id: 'component-1' }, methodName: 'arbitraryMethod' }), error => error.code === 'METHOD_NOT_ALLOWED' && error.status === 422);
    assert.equal(calls, 0);
  });

  it('callComponentMethod verifies component, executes, snapshots, and normalizes undefined', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_service, message, payload) => {
      calls.push(message);
      if (message === 'query-component') return { uuid: payload, type: 'cc.Label' };
      if (message === 'execute-component-method') return undefined;
      if (message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().callComponentMethod({ reference: { id: 'component-1' }, methodName: 'unscheduleAllCallbacks' }), { result: null });
    assert.deepEqual(calls, ['query-component', 'execute-component-method', 'snapshot']);
  });
});

describe('scene lifecycle close and reload contracts', () => {
  it('confirms close clears the current scene and reload preserves identity', async () => {
    const calls = [];
    let current = { uuid: 'scene-1' };
    global.Editor = { Message: { request: async (_service, message) => {
      calls.push(message);
      if (message === 'query-current-scene') return current;
      if (message === 'close-scene') { current = null; return true; }
      if (message === 'soft-reload') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    const tools = new (requireDist('utcp/tools/editor-tools.js').EditorTools)();
    assert.deepEqual(await tools.editorOperate({ operation: 'soft_reload' }), { success: true });
    assert.deepEqual(await tools.editorOperate({ operation: 'close_scene_or_prefab' }), { success: true });
    assert.deepEqual(calls, ['query-current-scene', 'soft-reload', 'query-current-scene', 'close-scene', 'query-current-scene']);
  });
});

describe('scene history residual contracts', () => {
  it('routes snapshot abort to the native transaction boundary', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (_service, message) => { calls.push(message); return true; } } };
    const tools = new (requireDist('utcp/tools/editor-tools.js').EditorTools)();
    assert.deepEqual(await tools.editorHistory({ operation: 'abort' }), { success: true });
    assert.deepEqual(calls, ['snapshot-abort']);
  });
});
describe('scene upgrade read-back contracts', () => {
  it('nodeGetInfo returns the complete authoritative node dump, not only identity', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-node') return {
        uuid: id,
        name: 'Player',
        active: { value: true, type: 'Boolean' },
        position: { value: { x: 1, y: 2, z: 3 } },
        __comps__: [{ value: { uuid: { value: 'label-1' }, __type__: { value: 'cc.Label' } } }],
      };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().nodeGetInfo({ reference: { id: 'node-1' } }), {
      uuid: 'node-1',
      name: 'Player',
      active: { value: true, type: 'Boolean' },
      position: { value: { x: 1, y: 2, z: 3 } },
      __comps__: [{ value: { uuid: { value: 'label-1' }, __type__: { value: 'cc.Label' } } }],
    });
  });

  it('nodeComponentsGet returns authoritative component references for the requested node', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-node') return {
        __comps__: [
          { value: { uuid: { value: 'label-1' }, __type__: { value: 'cc.Label' } } },
          { uuid: 'script-1', type: 'GameController' },
        ],
      };
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new ComponentTools().nodeComponentsGet({ reference: { id: 'node-1' }, componentType: 'cc.Label' }), {
      references: [{ id: 'label-1', type: 'cc.Label' }],
    });
    assert.deepEqual(await new ComponentTools().nodeComponentsGet({ reference: { id: 'node-1' } }), {
      references: [{ id: 'label-1', type: 'cc.Label' }, { id: 'script-1', type: 'GameController' }],
    });
  });

  it('nodeSetTransform rejects accepted writes when fresh read-back is stale', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-node') return { uuid: 'node-1', position: { value: { x: 1, y: 2, z: 3 } } };
      if (message === 'set-property' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().nodeSetTransform({ reference: { id: 'node-1' }, position: { x: 8, y: 9, z: 10 } }),
      error => error.code === 'NODE_TRANSFORM_UPDATE_UNCONFIRMED' && error.status === 502,
    );
  });

  it('cameraSetProperties rejects accepted writes when fresh component read-back is stale', async () => {
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-node-tree') return { uuid: 'root', children: [{ uuid: 'node-1', children: [], __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }] }] };
      if (message === 'query-node') return { uuid: 'node-1', __comps__: [{ type: 'cc.Camera', value: { uuid: { value: 'camera-1' }, fov: { value: 45 } } }] };
      if (message === 'set-property' || message === 'snapshot') return true;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().cameraSetProperties({ reference: { id: 'camera-1' }, properties: { fov: 60 } }),
      error => error.code === 'CAMERA_PROPERTY_UPDATE_FAILED' && error.details.rollbackFailure === null,
    );
  });
});

describe('scene asset usage identity contracts', () => {
  const frame = 'image-uuid@spriteFrame';
  const image = 'image-uuid';

  it('rejects a scene node UUID as an asset before querying usages', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (service, message, id) => {
      calls.push([service, message, id]);
      if (message === 'query-asset-info') return null;
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().findNodesByAsset({ reference: { id: 'node-uuid', type: 'cc.Node' } }),
      error => error.code === 'TARGET_NOT_FOUND' && error.status === 404,
    );
    assert.deepEqual(calls, [['asset-db', 'query-asset-info', 'node-uuid']]);
  });

  it('preserves exact sub-asset and node IDs and counts all valid results past the limit', async () => {
    const calls = [];
    global.Editor = { Message: { request: async (service, message, id) => {
      calls.push([service, message, id]);
      if (message === 'query-asset-info') return { uuid: id, type: 'cc.SpriteFrame', importer: 'sprite-frame' };
      if (message === 'query-nodes-by-asset-uuid') return ['node-A', 'node-B', 'node-C'];
      throw new Error(`unexpected ${message}`);
    } } };
    assert.deepEqual(await new SceneTools().spriteFrameUsageInspect({ reference: { id: frame }, limit: 1 }), {
      reference: { id: frame, type: 'cc.SpriteFrame' }, nodes: [{ id: 'node-A', type: 'cc.Node' }], total: 3, truncated: true,
    });
    assert.deepEqual(calls.filter(([, message]) => message === 'query-nodes-by-asset-uuid'), [['scene', 'query-nodes-by-asset-uuid', frame]]);
    assert.equal(calls.filter(([, message]) => message === 'query-node').length, 0);
  });

  it('rejects malformed scene IPC nodes, including those beyond the returned limit', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-asset-info') return { uuid: id, type: 'cc.ImageAsset' };
      if (message === 'query-nodes-by-asset-uuid') return ['node-A', { uuid: '' }];
      throw new Error(`unexpected ${message}`);
    } } };
    await assert.rejects(
      new SceneTools().findNodesByAsset({ reference: { id: image }, limit: 1 }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502,
    );
  });

  it('rejects an asset-db response for a different UUID rather than silently querying it', async () => {
    let sceneQueries = 0;
    global.Editor = { Message: { request: async (_service, message) => {
      if (message === 'query-asset-info') return { uuid: 'another-asset', type: 'cc.SpriteFrame' };
      sceneQueries++;
      return [];
    } } };
    await assert.rejects(
      new SceneTools().findNodesByAsset({ reference: { id: frame } }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502,
    );
    assert.equal(sceneQueries, 0);
  });

  it('isolates invalid SpriteFrame assets as per-item batch errors', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-asset-info') return id === frame ? { uuid: id, type: 'cc.SpriteFrame' } : null;
      if (message === 'query-nodes-by-asset-uuid') return ['node-A', 'node-B'];
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().spriteFrameUsageBatchInspect({ references: [{ id: 'node-uuid' }, { id: frame }], limitPerFrame: 1 });
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.items[0].ok, false);
    assert.deepEqual(result.items[1].result, { reference: { id: frame, type: 'cc.SpriteFrame' }, nodes: [{ id: 'node-A', type: 'cc.Node' }], total: 2, truncated: true });
  });

  it('reports complete image SpriteFrame traversal as non-truncated at the exact frame cap', async () => {
    global.Editor = { Message: { request: async (_service, message, id) => {
      if (message === 'query-asset-info') return id === image
        ? { uuid: image, type: 'cc.ImageAsset', importer: 'image', subAssets: { spriteFrame: { uuid: frame, type: 'cc.SpriteFrame', importer: 'sprite-frame' } } }
        : { uuid: frame, type: 'cc.SpriteFrame', importer: 'sprite-frame' };
      if (message === 'query-nodes-by-asset-uuid') return id === frame ? ['sprite-node'] : [];
      throw new Error(`unexpected ${message}`);
    } } };
    const result = await new SceneTools().imageSceneUsageInspect({ imageReference: { id: image }, maxFrames: 1 });
    assert.equal(result.totalSpriteFrames, 1);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.spriteFrames[0].nodes, [{ id: 'sprite-node', type: 'cc.Node' }]);
  });
});

describe('missing asset node identity contracts', () => {
  it('rejects malformed missing-assets IPC payloads instead of reporting a healthy scene', async () => {
    global.Editor = { Message: { request: async () => ['valid-node', { uuid: '' }] } };
    await assert.rejects(
      new SceneTools().findNodesWithMissingAssets({ limit: 1 }),
      error => error.code === 'INVALID_RESPONSE' && error.status === 502,
    );
  });
});
