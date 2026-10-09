import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  createMemberTokenVerifierFromEnv,
  type AuthContext,
  type MemberTokenVerifier,
} from "../auth.ts";
import { CcpError, toCcpErrorBody } from "./errors.ts";
import { assertCcBridgeProduct } from "./product-grant.ts";

declare global {
  namespace Express {
    interface Request {
      toolAuth?: AuthContext;
    }
  }
}

function deny(res: Response, status: number, error: CcpError): void {
  res.status(status).json(toCcpErrorBody(error));
}

export function createMemberAuthMiddleware(
  verifier?: MemberTokenVerifier,
): RequestHandler {
  let resolved = verifier;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      resolved ??= createMemberTokenVerifierFromEnv();
    } catch {
      deny(res, 503, new CcpError("CCP_GATEWAY_UNAVAILABLE", "Member JWT public key is not configured."));
      return;
    }
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      deny(res, 401, new CcpError("CCP_AUTH_REQUIRED", "Member authentication is required."));
      return;
    }
    const token = authorization.slice("Bearer ".length).trim();
    if (!token || token.includes(" ")) {
      deny(res, 401, new CcpError("CCP_AUTH_INVALID", "Member credential is invalid or expired."));
      return;
    }
    try {
      req.toolAuth = await resolved.verify(token);
      next();
    } catch {
      deny(res, 401, new CcpError("CCP_AUTH_INVALID", "Member credential is invalid or expired."));
    }
  };
}

export const requireCcBridgeProduct: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.toolAuth) {
    deny(res, 401, new CcpError("CCP_AUTH_REQUIRED", "Member authentication is required."));
    return;
  }
  try {
    assertCcBridgeProduct(req.toolAuth);
    next();
  } catch (error) {
    deny(
      res,
      401,
      error instanceof CcpError
        ? error
        : new CcpError("CCP_AUTH_INVALID", "Member credential is invalid or expired."),
    );
  }
};
