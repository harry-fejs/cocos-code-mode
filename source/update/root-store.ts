import { createHash } from "crypto"
import { existsSync, lstatSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { z } from "zod";
import { parseCanonicalJson } from "../protected/canonical-json";
import { CcpError } from "../protected/errors";
import { readPrivateJson, writePrivateJsonAtomic } from "../protected/durable-file";
import { RootBodySchema } from "./metadata";
import type { RootBody } from "./metadata";

const StoredRootSchema = z.object({
  schemaVersion: z.literal(1),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  root: RootBodySchema,
}).strict();

export class TrustedRootStore {
  constructor(
    readonly path = join(homedir(), ".ccp", "trusted-release-root-v1.json"),
    readonly bootstrapPath = process.env.CCP_RELEASE_ROOT_PATH,
    readonly bootstrapSha256 = process.env.CCP_RELEASE_ROOT_SHA256,
  ) {}

  load(): { root: RootBody; payloadSha256: string } {
    const stored = readPrivateJson(this.path, 256 * 1024);
    if (stored !== undefined) {
      const record = StoredRootSchema.parse(stored);
      return { root: record.root, payloadSha256: record.payloadSha256 };
    }
    if (!this.bootstrapPath || !this.bootstrapSha256 || !/^[0-9a-f]{64}$/.test(this.bootstrapSha256)) {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "A pinned initial release root is not configured.");
    }
    if (!existsSync(this.bootstrapPath) || lstatSync(this.bootstrapPath).isSymbolicLink()) {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Pinned initial release root is missing or unsafe.");
    }
    const payload = readFileSync(this.bootstrapPath);
    if (payload.byteLength === 0 || payload.byteLength > 256 * 1024) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", "Pinned initial release root exceeds limits.");
    }
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== this.bootstrapSha256) throw new CcpError("CCP_SIGNATURE_INVALID", "Pinned initial release root hash does not match the configured digest.");
    let root: RootBody;
    try { root = RootBodySchema.parse(parseCanonicalJson(payload, 256 * 1024)); }
    catch { throw new CcpError("CCP_CANONICAL_INVALID", "Pinned initial release root is not canonical valid metadata."); }
    this.persist(root, digest);
    return { root, payloadSha256: digest };
  }

  persist(root: RootBody, payloadSha256: string): void {
    writePrivateJsonAtomic(this.path, { schemaVersion: 1, payloadSha256, root });
  }
}
