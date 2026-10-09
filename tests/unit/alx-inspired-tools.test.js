'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('../helpers/require-dist');

const { calculateLayoutAlignment } = requireDist('ui-layout-align.js');
const { SceneTools } = requireDist('utcp/tools/scene-tools.js');
const { UiTools } = requireDist('utcp/tools/ui-tools.js');

const item = (id, x, y, width, height, anchorX = 0.5, anchorY = 0.5) => ({
  id,
  position: { x, y, z: 7 },
  worldRect: { x: x - width * anchorX, y: y - height * anchorY, width, height },
});

describe('ALX-inspired CCP capabilities', () => {
  it('aligns sibling UI rectangles by a shared edge while preserving other axes and Z', () => {
    const updates = calculateLayoutAlignment([
      item('wide', 20, 10, 20, 10),
      item('narrow', 50, 40, 10, 10),
    ], 'align', 'horizontal', 'left');

    assert.deepEqual(updates, [
      { id: 'wide', position: { x: 20, y: 10, z: 7 } },
      { id: 'narrow', position: { x: 15, y: 40, z: 7 } },
    ]);
  });

  it('distributes variable-width UI rectangles with equal gaps and fixed outer bounds', () => {
    const updates = calculateLayoutAlignment([
      item('left', 5, 0, 10, 10),
      item('middle', 35, 0, 20, 10),
      item('right', 75, 0, 10, 10),
    ], 'distribute', 'horizontal');

    assert.deepEqual(updates.map((update) => [update.id, update.position.x]), [
      ['left', 5],
      ['middle', 40],
      ['right', 75],
    ]);
  });

  it('rejects incompatible alignment edges before mutation', () => {
    assert.throws(
      () => calculateLayoutAlignment([item('a', 0, 0, 10, 10), item('b', 20, 0, 10, 10)], 'align', 'horizontal', 'top'),
      /incompatible with horizontal alignment/,
    );
  });

  it('resolves reverse hierarchy paths relative to a requested root', async () => {
    const tree = {
      uuid: 'scene', name: 'Scene', children: [
        { uuid: 'canvas', name: 'Canvas', children: [
          { uuid: 'panel', name: 'Panel', children: [
            { uuid: 'button', name: 'Button', children: [] },
          ] },
        ] },
      ],
    };
    global.Editor = { Message: { request: async (module, message) => {
      assert.equal(module, 'scene');
      assert.equal(message, 'query-node-tree');
      return tree;
    } } };

    const result = await new SceneTools().nodeGetPath({
      reference: { id: 'button', type: 'cc.Node' },
      relativeTo: { id: 'canvas', type: 'cc.Node' },
      includeRoot: false,
    });
    assert.equal(result.path, 'Panel/Button');
    assert.deepEqual(result.segments, ['Panel', 'Button']);
  });

  it('fails closed when reverse path target is outside the requested hierarchy', async () => {
    global.Editor = { Message: { request: async () => ({
      uuid: 'scene', name: 'Scene', children: [
        { uuid: 'left', name: 'Left', children: [] },
        { uuid: 'right', name: 'Right', children: [] },
      ],
    }) } };

    await assert.rejects(
      new SceneTools().nodeGetPath({
        reference: { id: 'right', type: 'cc.Node' },
        relativeTo: { id: 'left', type: 'cc.Node' },
      }),
      (error) => error.code === 'NOT_FOUND' && error.status === 404,
    );
  });

  it('applies one verified sibling distribution and snapshots once', async () => {
    const positions = new Map([['left', 5], ['middle', 35], ['right', 75]]);
    const widths = new Map([['left', 10], ['middle', 20], ['right', 10]]);
    const calls = [];
    const nodeDump = (id) => ({
      uuid: id,
      name: id,
      parent: { value: { uuid: 'parent' } },
      position: { value: { x: positions.get(id), y: 0, z: 3 } },
      active: { value: true },
      children: [],
      __comps__: [{
        type: 'cc.UITransform',
        value: { contentSize: { width: widths.get(id), height: 10 }, anchorPoint: { x: 0.5, y: 0.5 } },
      }],
    });
    global.Editor = { Message: { request: async (module, message, payload) => {
      assert.equal(module, 'scene');
      calls.push({ message, payload });
      if (message === 'query-node') return nodeDump(payload);
      if (message === 'query-node-tree') return { uuid: payload, name: payload, children: [] };
      if (message === 'execute-scene-script' && payload.method === 'uiLayoutInspectGeometry') {
        return { nodes: payload.args[0].nodeIds.map((id) => ({
          id,
          size: { width: widths.get(id), height: 10 },
          anchor: { x: 0.5, y: 0.5 },
          worldRect: { x: positions.get(id) - widths.get(id) / 2, y: -5, width: widths.get(id), height: 10 },
        })) };
      }
      if (message === 'set-property') {
        positions.set(payload.uuid, payload.dump.value.x);
        return true;
      }
      if (message === 'snapshot') return true;
      throw new Error(`unexpected message ${message}`);
    } } };

    const result = await new UiTools().uiLayoutAlign({
      references: ['left', 'middle', 'right'].map((id) => ({ id, type: 'cc.Node' })),
      operation: 'distribute',
      axis: 'horizontal',
    });
    assert.equal(result.success, true);
    assert.deepEqual([...positions], [['left', 5], ['middle', 40], ['right', 75]]);
    assert.equal(calls.filter((call) => call.message === 'set-property').length, 3);
    assert.equal(calls.filter((call) => call.message === 'snapshot').length, 1);
    assert.equal(result.layouts.length, 3);
  });
});
