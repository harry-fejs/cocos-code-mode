'use strict';
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { linkProjectExtension } = require('../../scripts/link-project-extension');

const tempPaths = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

function makeTempProject() {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp3x-link-'));
  tempPaths.push(tempPath);
  const sourcePath = path.join(tempPath, 'extension-source');
  const projectPath = path.join(tempPath, 'project');
  fs.mkdirSync(sourcePath);
  fs.mkdirSync(projectPath);
  return { sourcePath, projectPath };
}

describe('linkProjectExtension', () => {
  it('creates an extensions junction that resolves to the extension source', () => {
    const { sourcePath, projectPath } = makeTempProject();

    const result = linkProjectExtension({ projectPath, sourcePath });
    const destination = path.join(projectPath, 'extensions', 'ccp3x');

    assert.equal(result.destination, destination);
    assert.equal(fs.realpathSync(destination), fs.realpathSync(sourcePath));
  });

  it('refuses to replace an installed extension without explicit replace permission', () => {
    const { sourcePath, projectPath } = makeTempProject();
    const destination = path.join(projectPath, 'extensions', 'ccp3x');
    fs.mkdirSync(destination, { recursive: true });

    assert.throws(
      () => linkProjectExtension({ projectPath, sourcePath }),
      /already exists.*--replace/i,
    );
  });

  it('backs up an installed extension before linking when replace is explicit', () => {
    const { sourcePath, projectPath } = makeTempProject();
    const destination = path.join(projectPath, 'extensions', 'ccp3x');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'package.json'), '{}');

    const result = linkProjectExtension({ projectPath, sourcePath, replace: true });

    assert.equal(fs.realpathSync(destination), fs.realpathSync(sourcePath));
    assert.match(result.backup, /\.imported-backup-\d+$/);
    assert.equal(fs.existsSync(path.join(result.backup, 'package.json')), true);
  });
});
