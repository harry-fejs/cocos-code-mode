import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../../src/auth.ts";
import {
  approveEnrolledDevice, createGrant, enrollDevice, issueEnrollmentChallenge,
  listAdminDevices, listAdminGrants, revokeAdminGrant, revokeEnrolledDevice,
} from "../../src/ccp/enrollment.ts";
import { enrollmentProofBytes } from "../../src/ccp/device-proof.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";


function auth(role: "admin" | "searcher"): AuthContext {
  return {
    member_id: "member-1",
    label: "fixture",
    jti: "jti-1",
    is_legacy: false,
    clearance: "internal",
    products: ["ccp"],
    tokenAlg: "EdDSA",
    role,
    exp: 2_000_000_000,
  };
}

function enrollmentBody(
  store: CcBridgeStore,
  member: AuthContext,
  overrides: Partial<{
    challengeId: string;
    challenge: string;
    memberId: string;
    label: string;
    expiresAtMs: number;
    deviceId: string;
    deviceKeyId: string;
    publicKeySpki: string;
  }> = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const challenge = issueEnrollmentChallenge(store, member, { label: "desk" }, 1_000);
  const fields = {
    ...challenge,
    deviceId: "11111111-2222-4333-8444-555555555555",
    deviceKeyId: "device-fixture-1",
    publicKeySpki: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64url"),
    ...overrides,
  };
  return {
    body: {
      ...fields,
      proofSignature: sign(null, enrollmentProofBytes(fields), privateKey).toString("base64url"),
    },
    privateKey,
  };
}

describe("CCP admin grants", () => {
  it("lets an admin approve, grant, and revoke a device", () => {
    const store = new CcBridgeStore(":memory:");
    const member = auth("searcher");
    const admin = auth("admin");
    const { body } = enrollmentBody(store, member);
    const enrolled = enrollDevice(store, member, body, 1_001);
    expect(enrolled).toMatchObject({
      deviceId: body.deviceId,
      status: "pending",
    });
    expect(approveEnrolledDevice(store, admin, body.deviceId).status).toBe("approved");
    const grant = createGrant(store, admin, {
      memberId: member.member_id,
      deviceId: body.deviceId,
      operationClass: "mutation",
    });
    expect(listAdminDevices(store, admin).devices).toHaveLength(1);
    expect(listAdminGrants(store, admin).grants).toHaveLength(1);
    expect(revokeAdminGrant(store, admin, grant.grantId).status).toBe("revoked");
    expect(revokeEnrolledDevice(store, admin, body.deviceId).status).toBe("revoked");
  });

  it("rejects grant writes from a non-admin", () => {
    const store = new CcBridgeStore(":memory:");
    expect(() => createGrant(store, auth("searcher"), { operationClass: "read" })).toThrow(/Only an admin/);
  });

  it("binds every identity field and consumes each Gateway challenge once", () => {
    const store = new CcBridgeStore(":memory:");
    const member = auth("searcher");
    const original = enrollmentBody(store, member);
    const substitutions = [
      { deviceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      { deviceKeyId: "device-substituted" },
      { publicKeySpki: Buffer.alloc(44, 3).toString("base64url") },
      { label: "other-desk" },
      { memberId: "other-member" },
      { challenge: Buffer.alloc(32, 7).toString("base64url") },
    ];
    for (const substitution of substitutions) {
      expect(() => enrollDevice(store, member, {
        ...original.body,
        ...substitution,
      }, 1_001)).toThrow();
    }
    expect(enrollDevice(store, member, original.body, 1_001).deviceId).toBe(original.body.deviceId);
    expect(() => enrollDevice(store, member, original.body, 1_002)).toThrow(/already used|already enrolled/);
    expect(store.getDeviceByKeyId(original.body.deviceKeyId)?.id).toBe(original.body.deviceId);
  });

  it("rejects expired and unissued challenges even with a valid device proof", () => {
    const store = new CcBridgeStore(":memory:");
    const member = auth("searcher");
    const expired = enrollmentBody(store, member);
    expect(() => enrollDevice(store, member, expired.body, expired.body.expiresAtMs)).toThrow(/expired/);

    const unissued = enrollmentBody(store, member, {
      challengeId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      challenge: Buffer.alloc(32, 9).toString("base64url"),
    });
    expect(() => enrollDevice(store, member, unissued.body, 1_001)).toThrow(/unknown/);
  });
});
