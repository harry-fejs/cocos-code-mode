import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditProductBoundary } from '../../scripts/audit-product-boundary.mjs';

const roots: string[] = [];

function fixture(dependency = '1.0.0', source = "import { value } from './local';\n") {
  const root = mkdtempSync(join(tmpdir(), 'ccp-boundary-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@dtx/tool-auth': dependency } }));
  writeFileSync(join(root, 'yarn.lock'), '# yarn lockfile v1\n');
  writeFileSync(join(root, 'src', 'index.ts'), source);
  writeFileSync(join(root, 'src', 'local.ts'), 'export const value = 1;\n');
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Gateway product boundary audit', () => {
  it('accepts registry dependencies and Gateway-local imports', () => {
    expect(auditProductBoundary(fixture())).toEqual([]);
  });

  it('rejects local dependency specifications and cross-product imports', () => {
    const root = fixture('file:../tool-auth.tgz', "import value from 'mcpdocs/src/ccp';\n");
    expect(auditProductBoundary(root)).toEqual(expect.arrayContaining([
      expect.stringContaining('must resolve from a registry'),
      expect.stringContaining('imports product-owned mcpdocs code'),
    ]));
  });


  it('rejects product-owned packages in the lockfile', () => {
    const root = fixture();
    writeFileSync(join(root, 'yarn.lock'), '"mcpdocs@^1.0.0":\n  version "1.0.0"\n');
    expect(auditProductBoundary(root)).toContain('yarn.lock contains a product-owned mcpdocs package');
  });
  it('rejects relative imports that escape the Gateway root', () => {
    expect(auditProductBoundary(fixture('1.0.0', "export { value } from '../../outside';\n")))
      .toEqual([expect.stringContaining('escapes the Gateway root: ../../outside')]);
  });
});
