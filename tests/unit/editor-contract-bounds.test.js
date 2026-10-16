'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readSource } = require('../helpers/require-dist');

describe('editor contract bounds', () => {
  it('keeps filtered scene tree fields optional and exposes truncation metadata', () => {
    const source = readSource('utcp/schemas.ts');
    assert.match(source, /name\?: string;/);
    assert.match(source, /active\?: boolean;/);
    assert.match(source, /components\?: Array<IInstanceReference>;/);
    assert.match(source, /required: \['reference', 'children'\]/);
  });


  it('uses conditional schema requirements for delegated operations', () => {
    const source = readSource('utcp/tools/consolidated-tools.ts');
    assert.match(source, /target: \{ const: 'instance' \}.*then: \{ required: \['reference'\] \}/s);
    assert.match(source, /oneOf: \[\{ required: \['propertyPaths', 'values'\] \}, \{ required: \['propertyPath', 'value'\] \}\]/);
    assert.match(source, /category: \{ const: 'enum_values' \}.*required: \['enumPath'\]/s);
    assert.match(source, /operation: \{ const: 'control' \}.*required: \['taskId', 'control'\]/s);
    assert.match(source, /operation:\{const:'asset_preview'\}.*required:\['reference'\]/s);
  });

  it('caps scene, build, project, inspector, and animation response-heavy operations', () => {
    const scene = readSource('utcp/tools/scene-tools.ts');
    const build = readSource('utcp/tools/build-tools.ts');
    const project = readSource('utcp/tools/project-tools.ts');
    const animation = readSource('utcp/tools/animation-tools.ts');
    assert.match(scene, /maximum: VERBOSE_TREE_NODES/);
    assert.match(build, /tasks: tasks\.slice\(0, limit\), total: tasks\.length, truncated:/);
    assert.match(project, /Object\.fromEntries\(entries\.slice\(0, limit\)\)/);
    assert.match(animation, /maxCurves: \{ type: 'number', minimum: 1, maximum: 1000, default: 200/);
    assert.match(animation, /maxItems: 100/);
  });
});
