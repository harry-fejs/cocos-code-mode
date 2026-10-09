'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { sha256 } = require('./release-inventory');

function writeCanonicalJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.writeFileSync(filePath, bytes);
  return { path: filePath, sha256: sha256(bytes), size: bytes.length };
}

function packageNameFromPath(packagePath, metadata) {
  if (typeof metadata.name === 'string' && metadata.name) return metadata.name;
  const segments = packagePath.split('/');
  return segments.at(-2)?.startsWith('@') ? `${segments.at(-2)}/${segments.at(-1)}` : segments.at(-1);
}

function npmPurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replace('%40', '@')}@${encodeURIComponent(version)}`;
}

function createSbom(projectRoot, packageName, version, packageDigest) {
  const lockPath = path.join(projectRoot, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const components = Object.entries(lock.packages || {})
    .filter(([packagePath, metadata]) => packagePath.startsWith('node_modules/') && metadata && metadata.dev !== true)
    .map(([packagePath, metadata]) => {
      const name = packageNameFromPath(packagePath, metadata);
      const component = {
        type: 'library',
        'bom-ref': npmPurl(name, metadata.version),
        name,
        version: metadata.version,
        purl: npmPurl(name, metadata.version),
      };
      if (typeof metadata.integrity === 'string' && metadata.integrity.startsWith('sha512-')) {
        const digest = Buffer.from(metadata.integrity.slice('sha512-'.length), 'base64');
        if (digest.length === 64) component.hashes = [{ alg: 'SHA-512', content: digest.toString('hex') }];
      }
      return component;
    })
    .sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `pkg:npm/${packageName}@${version}`,
        name: packageName,
        version,
        hashes: [{ alg: 'SHA-256', content: packageDigest }],
      },
    },
    components,
  };
}

function readBuildInfo(projectRoot) {
  const filePath = path.join(projectRoot, 'dist', 'build-info.json');
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value.commit || value.commit === 'unknown' || value.dirty) {
    throw new Error('production provenance requires a clean recorded source commit');
  }
  return value;
}

function fileDigest(projectRoot, relativePath) {
  const bytes = fs.readFileSync(path.join(projectRoot, relativePath));
  return { uri: relativePath, digest: { sha256: sha256(bytes) } };
}

function createProvenance(projectRoot, zipPath, manifestArtifact, sbomArtifact) {
  const zipBytes = fs.readFileSync(zipPath);
  const buildInfo = readBuildInfo(projectRoot);
  const builtAt = new Date(Number(process.env.SOURCE_DATE_EPOCH || '315532800') * 1000).toISOString();
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: path.basename(zipPath), digest: { sha256: sha256(zipBytes) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://ccp.dev/build-types/extension-zip/v1',
        externalParameters: {
          package: 'ccp3x',
          platform: { os: ['win32'], arch: ['x64'], creator: '>=3.7.0' },
        },
        internalParameters: {
          sourceCommit: buildInfo.commit,
          sourceBranch: buildInfo.branch,
          builtAt,
          sourceDateEpoch: process.env.SOURCE_DATE_EPOCH || '315532800',
        },
        resolvedDependencies: [
          fileDigest(projectRoot, 'package-lock.json'),
          fileDigest(projectRoot, 'package.json'),
        ],
      },
      runDetails: {
        builder: { id: 'https://ccp.dev/builders/extension-package-js/v1' },
        metadata: { invocationId: `${buildInfo.commit}:${path.basename(zipPath)}` },
        byproducts: [
          { name: path.basename(manifestArtifact.path), digest: { sha256: manifestArtifact.sha256 } },
          { name: path.basename(sbomArtifact.path), digest: { sha256: sbomArtifact.sha256 } },
        ],
      },
    },
  };
}

function writeReleaseSidecars(projectRoot, zipPath, manifestArtifact, packageName, version) {
  const distDir = path.join(projectRoot, 'dist');
  const zipDigest = sha256(fs.readFileSync(zipPath));
  const sbom = writeCanonicalJson(
    path.join(distDir, 'sbom.cdx.json'),
    createSbom(projectRoot, packageName, version, zipDigest),
  );
  const provenance = writeCanonicalJson(
    path.join(distDir, 'provenance.intoto.json'),
    createProvenance(projectRoot, zipPath, manifestArtifact, sbom),
  );
  return { sbom, provenance, zipSha256: zipDigest };
}

module.exports = {
  createProvenance,
  createSbom,
  writeCanonicalJson,
  writeReleaseSidecars,
};
