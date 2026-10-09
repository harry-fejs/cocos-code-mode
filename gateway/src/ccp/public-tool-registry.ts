import { PUBLIC_TOOL_MANIFEST } from "./tool-catalog.ts";
import type { PublicToolContract, PublicToolManifest } from "./schemas.ts";

const CONTRACT_BY_KEY: Readonly<Record<string, PublicToolContract>> = Object.freeze(
  Object.fromEntries(PUBLIC_TOOL_MANIFEST.tools.map((tool) => [`${tool.name}@${tool.contractVersion}`, tool])),
);

export class PublicToolRegistry {
  get(name: string, contractVersion: number): PublicToolContract | undefined {
    return CONTRACT_BY_KEY[`${name}@${contractVersion}`];
  }

  exportManifest(): PublicToolManifest {
    return PUBLIC_TOOL_MANIFEST;
  }
}
