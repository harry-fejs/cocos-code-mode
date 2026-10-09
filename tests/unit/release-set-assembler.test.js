'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const script = path.resolve(__dirname, '..', '..', 'scripts', 'assemble-release-set.js');
const wrapper = JSON.stringify({ payload: 'e30', signatures: [{ keyId: 'test', signature: 'AA' }] });

function run(project, root, zip, output) {
  return spawnSync(process.execPath, [path.join(project, 'scripts', 'assemble-release-set.js')], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, CCP_RELEASE_ROOT_METADATA_PATH: root, CCP_RELEASE_ZIP: zip, CCP_RELEASE_DIRECTORY: output },
  });
}

test('release-set assembler preflights before immutable writes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-release-set-'));
  try {
    const project = path.join(temp, 'project');
    const dist = path.join(project, 'dist');
    fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
    fs.mkdirSync(dist);
    fs.copyFileSync(script, path.join(project, 'scripts', 'assemble-release-set.js'));
    const root = path.join(temp, 'root.signed.json');
    const zip = path.join(temp, 'release.zip');
    const output = path.join(temp, 'served');
    fs.writeFileSync(root, wrapper);
    fs.writeFileSync(zip, 'zip');
    fs.writeFileSync(path.join(dist, 'release-target.signed.json'), wrapper);
    fs.writeFileSync(path.join(dist, 'rollout-policy.signed.json'), wrapper);
    fs.writeFileSync(path.join(dist, 'package-manifest.json'), '{}');
    fs.writeFileSync(path.join(dist, 'sbom.cdx.json'), '{}');

    const incomplete = run(project, root, zip, output);
    assert.notEqual(incomplete.status, 0);
    assert.equal(fs.existsSync(output), false, 'preflight failure must not leave a partial release set');

    fs.writeFileSync(path.join(dist, 'provenance.intoto.json'), '{}');
    const complete = run(project, root, zip, output);
    assert.equal(complete.status, 0, complete.stderr);
    assert.deepEqual(
      fs.readdirSync(output).sort(),
      ['metadata', 'package-manifest.json', 'provenance.intoto.json', 'release.zip', 'sbom.cdx.json'],
    );
    assert.deepEqual(fs.readdirSync(path.join(output, 'metadata')).sort(), ['policy.json', 'root.json', 'target.json']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
