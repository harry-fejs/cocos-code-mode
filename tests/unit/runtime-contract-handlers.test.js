'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readSource } = require('../helpers/require-dist');

describe('runtime contract handlers', () => {
  it('validates bounded batch entries before dispatching writes', () => {
    const batch = readSource('utcp/tools/batch-tools.ts');

    assert.match(batch, /const MAX_BATCH_SET_ENTRIES = 100;/);
    assert.match(batch, /validateBatchEntry\(entry, index\)/);
    assert.doesNotMatch(batch, /errors\.push\(`\$\{entry\.reference\.id\}:/);
  });

  it('rejects invalid batch reads and caps nested asset query limits', () => {
    const batchRead = readSource('utcp/tools/batch-read-tools.ts');

    assert.match(batchRead, /const MAX_BATCH_READ_ENTRIES = 100;/);
    assert.match(batchRead, /validateSceneBatchEntry\(entry, index, args\.fields\)/);
    assert.match(batchRead, /const MAX_ASSET_QUERY_LIMIT = 200;/);
    assert.match(batchRead, /limit: Math\.min\(query\.limit, MAX_ASSET_QUERY_LIMIT\)/);
  });

  it('preserves UTF-8 boundaries and localizes snapshot truncation metadata', () => {
    const material = readSource('utcp/tools/material-tools.ts');
    const snapshot = readSource('utcp/tools/scene-snapshot-tools.ts');

    assert.match(material, /new TextDecoder\('utf-8', \{ fatal: true \}\)/);
    assert.match(material, /return decoder\.decode\(bytes\.subarray\(0, end\)\)/);
    assert.match(snapshot, /let nodeTruncated: string \| undefined;/);
    assert.match(snapshot, /if \(nodeTruncated\) item\.truncated = nodeTruncated;/);
    assert.doesNotMatch(snapshot, /if \(truncated\) item\.truncated = truncated;/);
  });


});
