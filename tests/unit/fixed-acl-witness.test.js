'use strict';

const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { fixedAclOutput } = require('../../scripts/fixed-acl-witness');
const { assertReleaseInventory } = require('../../scripts/release-inventory');

const project = path.resolve(__dirname, '../..');
let approvedBytes;
let approvedRelative;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-acl-witness-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'dist', 'protected'), { recursive: true });
  for (const name of ['forbidden-material-witness.js', 'fixed-acl-witness.js', 'obfuscate-dist.js', 'rename-dist.js']) {
    fs.copyFileSync(path.join(project, 'scripts', name), path.join(root, 'scripts', name));
  }
  return root;
}

function run(root, script) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(project, 'node_modules') },
    windowsHide: true,
  });
}

function withApprovedFixture(check) {
  const root = fixture();
  try {
    const output = path.join(root, approvedRelative);
    fs.writeFileSync(output, approvedBytes);
    const mapPath = path.join(root, 'dist', '.rename-map.json');
    fs.writeFileSync(mapPath, JSON.stringify({ 'protected/durable-file.js': approvedRelative.slice(5) }));
    check(root, output, mapPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function inventory(root, output) {
  const relativePath = path.relative(root, output).split(path.sep).join('/');
  return [{ relativePath, archivePath: `cc-bridge-3x/${relativePath}`, sourcePath: output }];
}

before(() => {
  // Exercise the actual source -> release compiler options -> production minifier
  // -> renamer pipeline, rather than copying a possibly stale dist artifact.
  const config = ts.readConfigFile(path.join(project, 'tsconfig.release.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, project);
  assert.deepEqual(parsed.errors, []);
  const sourcePath = path.join(project, 'source', 'protected', 'durable-file.ts');
  const emitted = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: parsed.options, fileName: sourcePath,
  });
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'dist', 'protected', 'durable-file.js'), emitted.outputText);
    for (const script of ['obfuscate-dist.js', 'rename-dist.js']) {
      const result = run(root, script);
      assert.equal(result.status, 0, result.stderr);
    }
    approvedRelative = fixedAclOutput(path.join(root, 'dist'));
    assert.equal(typeof approvedRelative, 'string');
    approvedBytes = fs.readFileSync(path.join(root, approvedRelative));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('fixed Windows ACL release exception', () => {
  it('accepts the actual renamed implementation without counting it as an activation launcher', () => {
    withApprovedFixture((root, output) => {
      const result = run(root, 'forbidden-material-witness.js');
      assert.equal(result.status, 0, result.stderr);
      const entries = inventory(root, output);
      const approvedAclOutput = fixedAclOutput(path.join(root, 'dist'));
      assertReleaseInventory(entries, { approvedAclOutput });
      assert.throws(() => assertReleaseInventory(entries, { approvedAclOutput, requireActivationLauncher: true }), /found 0/);
    });
  });

  for (const [name, modify] of [
    ['an additional arbitrary process launch', (text) => `${text};require("child_process").spawn("cmd.exe",["/c","whoami"]);`],
    ['a weakened inherited DACL', (text) => text.replace('$acl.SetAccessRuleProtection($true,$false)', '$acl.SetAccessRuleProtection($false,$true)')],
    ['a changed PowerShell command', (text) => text.replace('-NoProfile', '-EncodedCommand')],
    ['dynamic command replacement', (text) => text.replace('"-Command",n]', '"-Command",process.env.CCB_COMMAND]')],
  ]) {
    it(`rejects ${name} inside the approved security module at both gates`, () => {
      withApprovedFixture((root, output) => {
        const original = approvedBytes.toString('utf8');
        const changed = modify(original);
        assert.notEqual(changed, original, 'mutation must exercise a changed implementation');
        fs.writeFileSync(output, changed);
        const result = run(root, 'forbidden-material-witness.js');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unapproved fixed ACL implementation/);
        assert.throws(() => assertReleaseInventory(inventory(root, output), {
          approvedAclOutput: fixedAclOutput(path.join(root, 'dist')),
        }), /unapproved fixed ACL implementation/);
      });
    });
  }

  it('does not accept the byte-identical helper at another module path', () => {
    withApprovedFixture((root, output) => {
      const moved = path.join(root, 'dist', 'protected', 'other.js');
      fs.renameSync(output, moved);
      assert.notEqual(run(root, 'forbidden-material-witness.js').status, 0);
      assert.throws(() => assertReleaseInventory(inventory(root, moved), {
        approvedAclOutput: fixedAclOutput(path.join(root, 'dist')),
      }), /general process launcher/);
    });
  });

  it('fails closed without the durable-file declaration or with a remapped/colliding identity', () => {
    withApprovedFixture((root, output, mapPath) => {
      for (const map of [
        {},
        { 'protected/durable-file.js': 'protected/other.js' },
        { 'protected/durable-file.js': approvedRelative.slice(5), 'protected/other.js': approvedRelative.slice(5) },
      ]) {
        fs.writeFileSync(mapPath, JSON.stringify(map));
        assert.notEqual(run(root, 'forbidden-material-witness.js').status, 0);
        assert.throws(() => {
          const approvedAclOutput = fixedAclOutput(path.join(root, 'dist'));
          assertReleaseInventory(inventory(root, output), { approvedAclOutput });
        }, /general process launcher|unique durable-file rename mapping/);
      }
    });
  });

  it('continues rejecting arbitrary launchers and unrelated forbidden material outside the helper', () => {
    withApprovedFixture((root) => {
      const other = path.join(root, 'dist', 'protected', 'other.js');
      for (const text of ['require("child_process").execFileSync("cmd.exe");', 'eval("1");']) {
        fs.writeFileSync(other, text);
        const result = run(root, 'forbidden-material-witness.js');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /other\.js/);
        assert.throws(() => assertReleaseInventory(inventory(root, other), {
          approvedAclOutput: fixedAclOutput(path.join(root, 'dist')),
        }), /general process launcher|forbidden release marker/);
      }
    });
  });
});
