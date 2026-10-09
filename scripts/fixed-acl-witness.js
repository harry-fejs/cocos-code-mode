'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ACL_SOURCE_OUTPUT = 'protected/durable-file.js';
const ACL_RENAMED_OUTPUT = 'protected/7472474b.js';
// Reviewed build: fixed system PowerShell, constant ACL script, env-only path/type,
// protected current-user + SYSTEM DACL and fail-closed verification. Pin the WHOLE
// emitted module: extra launches, command changes or weaker ACLs invalidate it.
// Never regenerate this digest automatically; source/toolchain changes need review.
const ACL_MODULE_SHA256 = 'e31eef3a241ff53edae1bc509d840141a67bed4534d65c17b5a3b46d91010521';

function fixedAclOutput(dist) {
  const mapPath = path.join(dist, '.rename-map.json');
  if (!fs.existsSync(mapPath)) return undefined;
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  if (!map || Array.isArray(map) || typeof map !== 'object'
      || !Object.entries(map).every(([from, to]) => typeof from === 'string' && typeof to === 'string')) {
    throw new Error('invalid rename map for fixed ACL witness');
  }
  if (!Object.prototype.hasOwnProperty.call(map, ACL_SOURCE_OUTPUT)) return undefined;
  if (map[ACL_SOURCE_OUTPUT] !== ACL_RENAMED_OUTPUT
      || Object.values(map).filter((value) => value === ACL_RENAMED_OUTPUT).length !== 1) {
    throw new Error('fixed ACL witness requires the unique durable-file rename mapping');
  }
  return `dist/${ACL_RENAMED_OUTPUT}`;
}

function isFixedAclModule(relativePath, bytes, approvedOutput) {
  return relativePath === approvedOutput
    && approvedOutput === `dist/${ACL_RENAMED_OUTPUT}`
    && createHash('sha256').update(bytes).digest('hex') === ACL_MODULE_SHA256;
}

module.exports = { fixedAclOutput, isFixedAclModule };
