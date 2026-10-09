import { createHash } from "crypto"
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "fs"
import { dirname, relative, resolve, sep } from "path"
import { z } from "zod";
import { CcpError } from "./errors";

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const DescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  packageSha256: DigestSchema,
  packageBytes: z.number().int().positive().safe(),
  packageManifestSha256: DigestSchema,
  sbomSha256: DigestSchema,
  provenanceSha256: DigestSchema,
  targetPayloadSha256: DigestSchema,
  policyPayloadSha256: DigestSchema,
  version: z.string().min(1).max(128),
  rootMetadataSha256: DigestSchema,
  targetMetadataSha256: DigestSchema,
  policyMetadataSha256: DigestSchema,
}).strict();
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  package: z.literal("ccp3x"),
  version: z.string().min(1).max(128),
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    size: z.number().int().nonnegative(),
    sha256: DigestSchema,
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
  }).strict()).min(1).max(4096),
}).strict();

export interface VerifiedStagedDirectory {
  directory: string;
  descriptorSha256: string;
  packageSha256: string;
  targetPayloadSha256: string;
  policyPayloadSha256: string;
  version: string;
}

function digestFile(path: string): { bytes: number; sha256: string } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  let bytes = 0;
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: hash.digest("hex") };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new CcpError("CCP_SIGNATURE_INVALID", `Staged package contains a symlink: ${rel}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(rel);
      else throw new CcpError("CCP_SIGNATURE_INVALID", `Staged package contains a special file: ${rel}`);
    }
  };
  walk(root);
  return files.sort();
}

export function verifyStagedDirectory(directory: string, expectedDescriptorSha256: string): VerifiedStagedDirectory {
  if (!/^[0-9a-f]{64}$/.test(expectedDescriptorSha256)) throw new CcpError("CCP_CANONICAL_INVALID", "Activation descriptor digest is invalid.");
  const root = resolve(directory);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Staged extension directory is missing or unsafe.");
  }
  const descriptorBytes = readFileSync(resolve(root, ".ccp-staged.json"));
  if (digest(descriptorBytes) !== expectedDescriptorSha256) throw new CcpError("CCP_SIGNATURE_INVALID", "Activation descriptor digest does not match.");
  let descriptor: z.infer<typeof DescriptorSchema>;
  try { descriptor = DescriptorSchema.parse(JSON.parse(descriptorBytes.toString("utf8"))); }
  catch { throw new CcpError("CCP_CANONICAL_INVALID", "Activation descriptor is invalid."); }
  const releaseRoot = dirname(dirname(root));
  const artifacts: Array<[string, string, number | undefined]> = [
    ["release.zip", descriptor.packageSha256, descriptor.packageBytes],
    ["package-manifest.json", descriptor.packageManifestSha256, undefined],
    ["sbom.cdx.json", descriptor.sbomSha256, undefined],
    ["provenance.intoto.json", descriptor.provenanceSha256, undefined],
    ["root.signed.json", descriptor.rootMetadataSha256, undefined],
    ["target.signed.json", descriptor.targetMetadataSha256, undefined],
    ["policy.signed.json", descriptor.policyMetadataSha256, undefined],
  ];
  for (const [name, expectedHash, expectedBytes] of artifacts) {
    const path = resolve(releaseRoot, name);
    if (!existsSync(path) || !statSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new CcpError("CCP_SIGNATURE_INVALID", `Immutable release-set file is missing or unsafe: ${name}`);
    }
    const actual = digestFile(path);
    if (actual.sha256 !== expectedHash || (expectedBytes !== undefined && actual.bytes !== expectedBytes)) {
      throw new CcpError("CCP_SIGNATURE_INVALID", `Immutable release-set file does not match: ${name}`);
    }
  }
  const manifestBytes = readFileSync(resolve(root, ".ccp-package-manifest.json"));
  if (digest(manifestBytes) !== descriptor.packageManifestSha256) throw new CcpError("CCP_SIGNATURE_INVALID", "Staged package manifest digest does not match.");
  let manifest: z.infer<typeof ManifestSchema>;
  try { manifest = ManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8"))); }
  catch { throw new CcpError("CCP_CANONICAL_INVALID", "Staged package manifest is invalid."); }
  if (manifest.version !== descriptor.version) throw new CcpError("CCP_SIGNATURE_INVALID", "Staged descriptor and package versions differ.");
  const packagePrefix = `${manifest.package}/`;
  const declared = new Map(manifest.files.map((entry) => {
    if (!entry.path.startsWith(packagePrefix) || entry.path.length === packagePrefix.length) {
      throw new CcpError("CCP_SIGNATURE_INVALID", `Staged manifest path is outside the package root: ${entry.path}`);
    }
    return [entry.path.slice(packagePrefix.length), entry] as const;
  }));
  if (declared.size !== manifest.files.length) throw new CcpError("CCP_SIGNATURE_INVALID", "Staged package manifest contains duplicate paths.");
  const actual = filesUnder(root).filter((entry) => entry !== ".ccp-staged.json" && entry !== ".ccp-package-manifest.json");
  if (actual.length !== declared.size || actual.some((entry) => !declared.has(entry))) {
    throw new CcpError("CCP_SIGNATURE_INVALID", "Staged directory file set differs from its signed manifest.");
  }
  for (const [entryPath, expected] of declared) {
    const full = resolve(root, ...entryPath.split("/"));
    if (full !== root && !full.startsWith(`${root}${sep}`)) throw new CcpError("CCP_SIGNATURE_INVALID", `Staged path escapes its root: ${entryPath}`);
    const bytes = readFileSync(full);
    if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new CcpError("CCP_SIGNATURE_INVALID", `Staged file does not match its manifest: ${entryPath}`);
  }
  return {
    directory: root,
    descriptorSha256: expectedDescriptorSha256,
    packageSha256: descriptor.packageSha256,
    targetPayloadSha256: descriptor.targetPayloadSha256,
    policyPayloadSha256: descriptor.policyPayloadSha256,
    version: descriptor.version,
  };
}

export function prepareActivation(
  creatorPid: number,
  stagedDirectory: string,
  liveDirectory: string,
  descriptorSha256: string,
): VerifiedStagedDirectory & { creatorPid: number; liveDirectory: string } {
  if (!Number.isSafeInteger(creatorPid) || creatorPid < 1) throw new CcpError("CCP_CANONICAL_INVALID", "Creator PID must be a positive integer.");
  const staged = verifyStagedDirectory(stagedDirectory, descriptorSha256);
  const live = resolve(liveDirectory);
  if (!existsSync(live) || !lstatSync(live).isDirectory() || lstatSync(live).isSymbolicLink()) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Live extension directory is missing or unsafe.");
  }
  return { ...staged, creatorPid, liveDirectory: live };
}
