import type { AuthContext } from "../auth.ts";
import { CcpError } from "./errors.ts";

export const CC_BRIDGE_PRODUCT = "ccp";

export function assertCcBridgeProduct(auth: AuthContext): void {
  if (auth.is_legacy) {
    throw new CcpError("CCP_PRODUCT_DENIED", "Legacy admin credentials cannot execute protected tools.");
  }
  if (auth.tokenAlg !== "EdDSA") {
    throw new CcpError("CCP_AUTH_INVALID", "Protected execute requires an EdDSA member JWT.");
  }
  if (!auth.products?.includes(CC_BRIDGE_PRODUCT)) {
    throw new CcpError("CCP_PRODUCT_DENIED", "Member token is missing the ccp product grant.");
  }
}
