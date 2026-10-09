import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { dirname, join, posix } from "path"
import { TextDecoder } from "util"
import { inflateRawSync } from "zlib"
import { z } from "zod";
import { CcpError } from "../protected/errors";

const MAX_ENTRIES = 4096;
const MAX_PATH_DEPTH = 16;
const MAX_NAME_BYTES = 512;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  package: z.literal("ccp3x"),
  version: z.string().min(1).max(128),
  files: z.array(z.object({
    path: z.string().min(1).max(MAX_NAME_BYTES),
    size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
    sha256: Sha256Schema,
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
  }).strict()).min(1).max(MAX_ENTRIES),
}).strict();
export type PackageManifest = z.infer<typeof ManifestSchema>;

interface ZipEntry {
  path: string;
  method: number;
  compressedSize: number;
  expandedSize: number;
  localOffset: number;
  externalAttributes: number;
}

export interface ReleaseSetExpectation {
  packageSha256: string;
  packageBytes: number;
  packageManifestSha256: string;
  sbomSha256: string;
  provenanceSha256: string;
  targetPayloadSha256: string;
  policyPayloadSha256: string;
  rootMetadataSha256: string;
  targetMetadataSha256: string;
  policyMetadataSha256: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSafePackageEntry(entryPath: string, declared: ReadonlySet<string>): string {
  const normalized = posix.normalize(entryPath.replace(/\\/g, "/"));
  const segments = normalized.split("/").filter(Boolean);
  if (!normalized || normalized.startsWith("/") || normalized.includes(":") || segments.includes("..") || normalized.endsWith("/")) {
    throw new CcpError("CCP_SIGNATURE_INVALID", `Unsafe package path: ${entryPath}`);
  }
  if (segments.length > MAX_PATH_DEPTH) throw new CcpError("CCP_LIMIT_EXCEEDED", `Package path is too deep: ${entryPath}`);
  if (!declared.has(normalized)) throw new CcpError("CCP_SIGNATURE_INVALID", `Undeclared package path: ${entryPath}`);
  return normalized;
}

export function assertPackageLimits(entryCount: number): void {
  if (!Number.isSafeInteger(entryCount) || entryCount < 1 || entryCount > MAX_ENTRIES) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", `Package must contain 1..${MAX_ENTRIES} entries.`);
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minimum = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new CcpError("CCP_SIGNATURE_INVALID", "ZIP end-of-central-directory record is missing.");
}

function parseZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const disk = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralOffset + centralSize > eocd) {
    throw new CcpError("CCP_SIGNATURE_INVALID", "Multi-disk or ZIP64 packages are not supported.");
  }
  assertPackageLimits(entryCount);
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let expandedTotal = 0;
  const seen = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) throw new CcpError("CCP_SIGNATURE_INVALID", "ZIP central directory is malformed.");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const expandedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const localOffset = zip.readUInt32LE(offset + 42);
    if (flags & 0x1) throw new CcpError("CCP_SIGNATURE_INVALID", "Encrypted ZIP entries are not accepted.");
    const nameBytes = zip.subarray(offset + 46, offset + 46 + nameLength);
    if ((flags & 0x800) === 0 && nameBytes.some((byte) => byte > 0x7f)) {
      throw new CcpError("CCP_SIGNATURE_INVALID", "Non-ASCII ZIP entry names must declare UTF-8.");
    }
    if (method !== 0 && method !== 8) throw new CcpError("CCP_SIGNATURE_INVALID", `ZIP compression method ${method} is unsupported.`);
    if (nameLength < 1 || nameLength > MAX_NAME_BYTES || offset + 46 + nameLength + extraLength + commentLength > zip.length) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", "ZIP entry name or metadata exceeds limits.");
    }
    let entryPath: string;
    try { entryPath = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); }
    catch { throw new CcpError("CCP_SIGNATURE_INVALID", "ZIP entry name is not valid UTF-8."); }
    const collisionKey = entryPath.replace(/\\/g, "/").toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) throw new CcpError("CCP_SIGNATURE_INVALID", `Duplicate or case-colliding ZIP path: ${entryPath}`);
    seen.add(collisionKey);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new CcpError("CCP_SIGNATURE_INVALID", `ZIP symlink is not accepted: ${entryPath}`);
    if (expandedSize > MAX_FILE_BYTES || (compressedSize === 0 ? expandedSize > 0 : expandedSize / compressedSize > MAX_COMPRESSION_RATIO)) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", `ZIP expansion limit exceeded: ${entryPath}`);
    }
    expandedTotal += expandedSize;
    if (expandedTotal > MAX_EXPANDED_BYTES) throw new CcpError("CCP_LIMIT_EXCEEDED", "ZIP expanded-byte limit exceeded.");
    entries.push({ path: entryPath, method, compressedSize, expandedSize, localOffset, externalAttributes });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== centralOffset + centralSize) throw new CcpError("CCP_SIGNATURE_INVALID", "ZIP central-directory length does not match its header.");
  return entries;
}

function entryBytes(zip: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== 0x04034b50) throw new CcpError("CCP_SIGNATURE_INVALID", `ZIP local header is missing: ${entry.path}`);
  const nameLength = zip.readUInt16LE(offset + 26);
  const extraLength = zip.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.length) throw new CcpError("CCP_SIGNATURE_INVALID", `ZIP entry data is truncated: ${entry.path}`);
  const compressed = zip.subarray(dataStart, dataEnd);
  let expanded: Buffer;
  try {
    expanded = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: entry.expandedSize });
  } catch {
    throw new CcpError("CCP_SIGNATURE_INVALID", `ZIP entry cannot be decompressed: ${entry.path}`);
  }
  if (expanded.length !== entry.expandedSize) throw new CcpError("CCP_SIGNATURE_INVALID", `ZIP entry size is invalid: ${entry.path}`);
  return expanded;
}

export function extractVerifiedPackage(zipPath: string, manifestInput: unknown, destination: string): PackageManifest {
  let manifest: PackageManifest;
  try { manifest = ManifestSchema.parse(manifestInput); }
  catch { throw new CcpError("CCP_CANONICAL_INVALID", "Package manifest is invalid."); }
  const declared = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (declared.size !== manifest.files.length) throw new CcpError("CCP_SIGNATURE_INVALID", "Package manifest contains duplicate paths.");
  const zip = readFileSync(zipPath);
  const entries = parseZipEntries(zip);
  const actualPaths = new Set(entries.map((entry) => entry.path.replace(/\\/g, "/")));
  if (actualPaths.size !== declared.size) throw new CcpError("CCP_SIGNATURE_INVALID", "ZIP entry set differs from the signed manifest.");
  if (existsSync(destination)) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Staging destination already exists.");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    for (const entry of entries) {
      const normalized = assertSafePackageEntry(entry.path, new Set(declared.keys()));
      const expected = declared.get(normalized);
      if (!expected) throw new CcpError("CCP_SIGNATURE_INVALID", `Missing manifest row: ${normalized}`);
      const bytes = entryBytes(zip, entry);
      if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new CcpError("CCP_SIGNATURE_INVALID", `ZIP entry does not match the signed manifest: ${normalized}`);
      const outputPath = join(destination, ...normalized.split("/"));
      mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
      writeFileSync(outputPath, bytes, { flag: "wx", mode: expected.mode });
    }
    return manifest;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function stageVerifiedReleaseSet(
  zipPath: string,
  manifestPath: string,
  sbomPath: string,
  provenancePath: string,
  destination: string,
  expected: ReleaseSetExpectation,
): { directory: string; version: string; descriptorPath: string; descriptorSha256: string } {
  const zip = readFileSync(zipPath);
  const manifestBytes = readFileSync(manifestPath);
  const sbomBytes = readFileSync(sbomPath);
  const provenanceBytes = readFileSync(provenancePath);
  if (zip.length !== expected.packageBytes || digest(zip) !== expected.packageSha256
    || digest(manifestBytes) !== expected.packageManifestSha256
    || digest(sbomBytes) !== expected.sbomSha256
    || digest(provenanceBytes) !== expected.provenanceSha256) {
    throw new CcpError("CCP_SIGNATURE_INVALID", "Immutable release set does not match signed target metadata.");
  }
  let manifestInput: unknown;
  try { manifestInput = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw new CcpError("CCP_CANONICAL_INVALID", "Package manifest is not valid JSON."); }
  const manifest = extractVerifiedPackage(zipPath, manifestInput, destination);
  const packageRoot = join(destination, manifest.package);
  const stagedManifestPath = join(packageRoot, ".ccp-package-manifest.json");
  writeFileSync(stagedManifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
  const descriptor = {
    schemaVersion: 1,
    packageSha256: expected.packageSha256,
    packageBytes: expected.packageBytes,
    packageManifestSha256: expected.packageManifestSha256,
    sbomSha256: expected.sbomSha256,
    provenanceSha256: expected.provenanceSha256,
    targetPayloadSha256: expected.targetPayloadSha256,
    policyPayloadSha256: expected.policyPayloadSha256,
    rootMetadataSha256: expected.rootMetadataSha256,
    targetMetadataSha256: expected.targetMetadataSha256,
    policyMetadataSha256: expected.policyMetadataSha256,
    version: manifest.version,
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8");
  const descriptorPath = join(packageRoot, ".ccp-staged.json");
  writeFileSync(descriptorPath, descriptorBytes, { flag: "wx", mode: 0o600 });
  return { directory: packageRoot, version: manifest.version, descriptorPath, descriptorSha256: digest(descriptorBytes) };
}
