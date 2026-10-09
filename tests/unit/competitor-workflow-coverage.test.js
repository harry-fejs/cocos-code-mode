'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/competitor-workflow-coverage-20260912.json'), 'utf8'));
const portfolio = JSON.parse(fs.readFileSync(path.join(root, 'docs/tool-portfolio-candidates.json'), 'utf8'));

function registeredTools() {
  const names = new Set(['executeJavascript']);
  const toolsDir = path.join(root, 'source/utcp/tools');
  for (const file of fs.readdirSync(toolsDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(toolsDir, file), 'utf8');
    for (const match of source.matchAll(/@utcpTool\(\s*['"]([^'"]+)/g)) names.add(match[1]);
  }
  return names;
}

describe('frozen competitor workflow coverage ledger', () => {
  it('accounts for every competitor source row exactly once', () => {
    assert.deepEqual(report.denominator.sourceCatalogTools, { ALX: 163, 'Cocos Pilot 2x': 96 });
    assert.equal(report.denominator.rawUnionRows, 259);
    assert.equal(report.denominator.accountedRows, 259);
    assert.equal(report.denominator.allRowsAccounted, true);
    assert.equal(new Set(report.rows.map((row) => `${row.sourceCatalog}:${row.competitorTool}`)).size, 259);
    assert.equal(report.denominator.consolidatedCcbContractSignatures, 106);
  });

  it('references only current CCP tools and source files', () => {
    const registered = registeredTools();
    for (const row of report.rows) {
      for (const tool of row.ccbTools) assert.ok(registered.has(tool), `${row.competitorTool}: missing ${tool}`);
      for (const file of row.ccbSourceFiles) assert.ok(fs.existsSync(path.join(root, file)), `${row.competitorTool}: missing ${file}`);
      if (row.disposition === 'intentional-exclusion') {
        assert.deepEqual(row.ccbTools, []);
      } else if (row.disposition === 'unsupported-creator') {
        assert.ok(row.ccbTools.length <= 1, `${row.sourceCatalog}:${row.competitorTool}: unsupported row must remain bounded`);
      } else {
        assert.ok(row.ccbTools.length > 0, `${row.sourceCatalog}:${row.competitorTool}: unaccounted workflow`);
      }
    }
  });

  it('keeps candidate states synchronized with the frozen portfolio', () => {
    const states = new Map([
      ...portfolio.domains.flatMap((domain) => domain.candidates.map((candidate) => [candidate.name, candidate.state])),
      ...portfolio.reserveCandidates.map((candidate) => [candidate.name, candidate.state]),
    ]);
    for (const row of report.rows) {
      for (const [tool, state] of Object.entries(row.candidateStates)) {
        assert.equal(states.get(tool), state, `${row.competitorTool}: stale state for ${tool}`);
      }
    }
  });
});
