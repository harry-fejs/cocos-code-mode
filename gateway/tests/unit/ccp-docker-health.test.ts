import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatewayRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("Gateway Docker health contract", () => {
  it("requires HTTP success, body ok=true, and an available signer", () => {
    const dockerfile = readFileSync(join(gatewayRoot, "Dockerfile"), "utf8");
    const compose = readFileSync(join(gatewayRoot, "docker-compose.yml"), "utf8");
    for (const health of [dockerfile, compose]) {
      expect(health).toContain("r.ok&&b?.ok===true&&b?.signer==='configured'");
      expect(health).not.toMatch(/process\.exit\(r\.ok\?0:1\)/);
    }
  });
});
