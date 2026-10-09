'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { requireDist } = require('../helpers/require-dist');
const { canonicalProjectPath } = requireDist('utcp/project-connection.js');
const { readGatewayFile } = requireDist('protected/relay-host.js');
it('selects valid project with unrelated unavailable Gateway map keys while refusing missing or ambiguous selection', () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ccp-gateway-map-test-'));
  try {
    const project = path.join(root, 'current'); fs.mkdirSync(project);
    const canonical = canonicalProjectPath(project);
    const configPath = path.join(root, 'gateway.json');
    const selected = { origin: 'https://current.invalid', projectId: 'current-project' };
    fs.writeFileSync(configPath, JSON.stringify({ projects: { [path.join(root, 'deleted')]: { origin: 'https://stale.invalid' }, [project]: selected } }));
    assert.deepEqual(readGatewayFile(canonical, configPath), selected);
    const missing = path.join(root, 'missing-current'); fs.mkdirSync(missing);
    assert.throws(() => readGatewayFile(canonicalProjectPath(missing), configPath), /unambiguous/);
    fs.writeFileSync(configPath, JSON.stringify({ projects: { [project]: selected, [`${project}${path.sep}.`]: selected } }));
    assert.throws(() => readGatewayFile(canonical, configPath), /unambiguous/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
