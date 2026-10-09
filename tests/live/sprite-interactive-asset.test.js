'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { getJson, postTool, repeatTestcase, healthCheck, getCanvasReference } = require('../helpers/utcp-client');

const SPRITE_FRAME = '20835ba4-6145-4fbc-a58a-051ce700aa3e@f9941';

/** Live integration qualification: public CCP APIs against Creator state. */
describe('live: Sprite interactive asset workflow', { concurrency: false }, () => {
  let health;
  before(async () => { health = await healthCheck(); });

  it('creates a Canvas-hosted SpriteFrame node and mutates its public properties', async (t) => {
    if (!health?.ok) { t.skip(`editor not running: ${health?.reason ?? 'unknown'}`); return; }
    const canvas = await getCanvasReference();
    if (!canvas) { t.skip('active scene has no Canvas fixture'); return; }

    await repeatTestcase('SPRITE-C01', async () => {
      const created = await postTool('createSprite', {
        name: `__ccp3x_sprite_interactive_${Date.now()}__`,
        spriteFrameUuid: SPRITE_FRAME,
        parentReference: canvas,
      });
      assert.equal(created.ok, true, JSON.stringify(created.body));
      const node = created.body.reference;
      assert.equal(typeof node?.id, 'string');
      try {
        const components = await getJson(`/tools/nodeComponentsGet?reference%5Bid%5D=${encodeURIComponent(node.id)}`);
        assert.equal(components.ok, true, JSON.stringify(components.body));
        const sprite = components.body.references.find((item) => item.type === 'cc.Sprite');
        const uiTransform = components.body.references.find((item) => item.type === 'cc.UITransform');
        assert.equal(typeof sprite?.id, 'string');
        assert.equal(typeof uiTransform?.id, 'string');
        const transformed = await postTool('nodeBatchSet', {
          entries: [{ reference: node, propertyPaths: ['position', 'scale'], values: [{ x: 140, y: -60, z: 0 }, { x: 1.25, y: 0.8, z: 1 }] }],
        });
        assert.equal(transformed.ok, true, JSON.stringify(transformed.body));
        const tinted = await postTool('inspectorSet', { target: 'instance', reference: sprite, propertyPath: 'color', value: { r: 40, g: 180, b: 240, a: 255 } });
        assert.equal(tinted.ok, true, JSON.stringify(tinted.body));
        const resized = await postTool('inspectorSet', { target: 'instance', reference: uiTransform, propertyPath: 'contentSize', value: { width: 256, height: 128 } });
        assert.equal(resized.ok, true, JSON.stringify(resized.body));
        const readBack = await postTool('sceneBatchGet', { entries: [{ target: 'instance', reference: node, fields: ['position', 'scale'] }] });
        assert.equal(readBack.ok, true, JSON.stringify(readBack.body));
        const preview = await postTool('previewManage', {
          operation: 'scene_preview',
          imageSize: { width: 640, height: 360 },
          cameraPosition: { x: 640, y: 360, z: 1000 },
          targetPosition: { x: 640, y: 360, z: 0 },
          orthographic: true,
          orthographicSize: 360,
        });
        assert.equal(preview.ok, true, JSON.stringify(preview.body));
        assert.equal(preview.body.type, 'image');
        assert.match(preview.body.mimeType, /^image\//);
      } finally {
        const deleted = await postTool('nodeOperate', { operation: 'delete', reference: node });
        assert.equal(deleted.ok, true, JSON.stringify(deleted.body));
      }
    });
  });
});
