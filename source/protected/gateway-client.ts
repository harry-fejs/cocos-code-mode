import { Agent as HttpsAgent, RequestOptions, request as httpsRequest } from "https";
import { Agent as HttpAgent, IncomingMessage, request as httpRequest } from "http";
import { URL } from "url";
import { z } from "zod";
import { CCP_ERROR_CODES, CcpError, CcpErrorCode } from "./errors";
import { canonicalizeToBytes } from "./canonical-json";
import { EXECUTE_PATH, SignedGatewayDecision, SignedProtectedRequest, WRAPPER_MAX_BYTES } from "./protocol";
import { parseSignedGatewayDecision } from "./schemas";
import { decodeBase64UrlBuffer } from "./node14-compat";
import type { QualificationTraceRecorder } from "./qualification-trace";

const GatewayErrorSchema = z.object({
  error: z.string().min(1).max(512),
  code: z.string().min(1).max(64),
  details: z.record(z.string(), z.union([z.null(), z.boolean(), z.number(), z.string()])).default({}),
  recovery: z.string().min(1).max(1024),
}).strict();

export interface GatewayClientOptions {
  origin: string;
  memberCredential: () => Promise<string> | string;
  deadlineMs?: number;
  responseMaxBytes?: number;
  minimumBackoffMs?: number;
  maximumBackoffMs?: number;
  allowInsecureLoopback?: boolean;
  qualificationTrace?: QualificationTraceRecorder;
}

function readBoundedResponse(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) {
        response.destroy(new CcpError("CCP_LIMIT_EXCEEDED", "Gateway response exceeded the wire limit.", { maxBytes }));
        return;
      }
      chunks.push(bytes);
    });
    response.once("end", () => resolve(Buffer.concat(chunks, size)));
    response.once("error", reject);
  });
}

function isCcpErrorCode(value: string): value is CcpErrorCode {
  return (CCP_ERROR_CODES as readonly string[]).includes(value);
}

export class GatewayClient {
  private readonly endpoint: URL;
  private readonly agent: HttpAgent | HttpsAgent;
  private readonly deadlineMs: number;
  private readonly responseMaxBytes: number;
  private readonly minimumBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(private readonly options: GatewayClientOptions) {
    const origin = new URL(options.origin);
    const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "localhost" || origin.hostname === "::1";
    const allowInsecure = (process.env.CCP_ALLOW_INSECURE_GATEWAY === "1" || options.allowInsecureLoopback === true)
      && origin.protocol === "http:" && loopback;
    if (origin.username || origin.password || origin.search || origin.hash || (origin.pathname !== "/" && origin.pathname !== "")) {
      throw new Error("Gateway origin must be an exact origin without credentials, path, query, or fragment");
    }
    if (origin.protocol !== "https:" && !allowInsecure) {
      throw new Error("Gateway origin must be HTTPS, or http://127.0.0.1 with CCP_ALLOW_INSECURE_GATEWAY=1");
    }
    this.endpoint = new URL(EXECUTE_PATH, origin.origin);
    this.agent = origin.protocol === "https:"
      ? new HttpsAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, timeout: 30_000 })
      : new HttpAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, timeout: 30_000 });
    this.deadlineMs = options.deadlineMs ?? 15_000;
    this.responseMaxBytes = options.responseMaxBytes ?? WRAPPER_MAX_BYTES;
    this.minimumBackoffMs = options.minimumBackoffMs ?? 250;
    this.maximumBackoffMs = options.maximumBackoffMs ?? 10_000;
  }

  async execute(wrapper: SignedProtectedRequest): Promise<SignedGatewayDecision> {
    const now = Date.now();
    if (now < this.nextAttemptAt) {
      throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Gateway reconnect backoff is active.", { retryAfterMs: this.nextAttemptAt - now });
    }
    const body = canonicalizeToBytes(wrapper);
    if (body.byteLength > WRAPPER_MAX_BYTES) throw new CcpError("CCP_LIMIT_EXCEEDED", "Signed request wrapper exceeds the wire limit.");
    const memberCredential = await this.options.memberCredential();
    if (!memberCredential || /[\r\n]/.test(memberCredential)) throw new CcpError("CCP_AUTH_REQUIRED", "A valid member credential is required.");
    try {
      const decision = await this.sendOnce(body, memberCredential);
      this.failures = 0;
      this.nextAttemptAt = 0;
      return decision;
    } catch (error) {
      if (!(error instanceof CcpError) || error.body.code === "CCP_GATEWAY_UNAVAILABLE") {
        this.failures += 1;
        const delay = Math.min(this.maximumBackoffMs, this.minimumBackoffMs * (2 ** Math.min(this.failures - 1, 8)));
        this.nextAttemptAt = Date.now() + delay;
      }
      if (error instanceof CcpError) throw error;
      throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Gateway request failed before a decision was accepted.");
    }
  }
  private requestId(body: Buffer): string {
    try {
      const wrapper = JSON.parse(body.toString("utf8")) as { payload?: string };
      if (typeof wrapper.payload !== "string") return "";
      const request = JSON.parse(decodeBase64UrlBuffer(wrapper.payload).toString("utf8")) as { requestId?: string };
      return typeof request.requestId === "string" ? request.requestId : "";
    } catch {
      return "";
    }
  }


  close(): void {
    this.agent.destroy();
  }

  private async sendOnce(body: Buffer, memberCredential: string): Promise<SignedGatewayDecision> {
    const requestOptions: RequestOptions = {
      protocol: this.endpoint.protocol,
      hostname: this.endpoint.hostname,
      port: this.endpoint.port || (this.endpoint.protocol === "https:" ? 443 : 80),
      path: this.endpoint.pathname,
      method: "POST",
      agent: this.agent,
      servername: this.endpoint.hostname,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${memberCredential}`,
        "content-type": "application/json; charset=utf-8",
        "content-length": body.byteLength,
      },
    };

    const transport = this.endpoint.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<SignedGatewayDecision>((resolve, reject) => {
      const traceId = this.options.qualificationTrace ? this.requestId(body) : "";
      const outgoing = transport(requestOptions, async (response) => {
        try {
          if (response.headers.location) throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Gateway redirects are not accepted.");
          if (response.headers["content-encoding"]) throw new CcpError("CCP_CANONICAL_INVALID", "Compressed Gateway responses are not accepted.");
          const bytes = await readBoundedResponse(response, this.responseMaxBytes);
          this.options.qualificationTrace?.gatewayResponse(traceId, bytes.byteLength, bytes);
          const mediaType = String(response.headers["content-type"] ?? "").toLowerCase();
          if (!mediaType.startsWith("application/json")) throw new CcpError("CCP_CANONICAL_INVALID", "Gateway returned an unsupported media type.");
          const parsed: unknown = JSON.parse(bytes.toString("utf8"));
          if (response.statusCode !== 200) {
            const gatewayError = GatewayErrorSchema.safeParse(parsed);
            if (gatewayError.success && isCcpErrorCode(gatewayError.data.code)) {
              throw new CcpError(gatewayError.data.code, gatewayError.data.error, gatewayError.data.details, gatewayError.data.recovery);
            }
            throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Gateway denied the request without a valid error envelope.", { status: response.statusCode ?? 0 });
          }
          resolve(parseSignedGatewayDecision(parsed));
        } catch (error) {
          reject(error);
        }
      });
      outgoing.setTimeout(this.deadlineMs, () => outgoing.destroy(new CcpError("CCP_GATEWAY_UNAVAILABLE", "Gateway request deadline exceeded.")));
      outgoing.once("error", reject);
      this.options.qualificationTrace?.gatewayRequest(traceId, body);
      outgoing.end(body);
    });
  }
}
