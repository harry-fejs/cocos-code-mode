import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { URL } from "url";
import { CcpError, toCcpErrorBody } from "../protected/errors";
import { LocalAuthContext, validateLocalIngress } from "./local-auth";

const MAX_BODY_BYTES = 1024 * 1024;
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface LocalHttpContext {
  method: HttpMethod;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  request: IncomingMessage;
  response: ServerResponse;
  startedAt: number;
}

export type LocalHttpHandler = (context: LocalHttpContext) => void | Promise<void>;
const jsonWitnesses = new WeakMap<ServerResponse, (status: number, bytes: Buffer, finished: boolean) => void>();

/** Opt-in qualification hook, at the actual post-trim/envelope serialization boundary. */
export function bindJsonWitness(response: ServerResponse, witness: (status: number, bytes: Buffer, finished: boolean) => void): void {
  jsonWitnesses.set(response, witness);
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
    ...headers,
  });
  const witness = jsonWitnesses.get(response);
  if (witness) {
    let recorded = false;
    const record = (finished: boolean) => { if (recorded) return; recorded = true; try { witness(status, bytes, finished); } catch { /* Evidence failure never changes HTTP outcomes. */ } };
    response.once("finish", () => record(true));
    response.once("close", () => record(response.writableFinished));
  }
  response.end(bytes);
}

function decodeScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "__null__") return null;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function parseQuery(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, raw] of url.searchParams) {
    const value = decodeScalar(raw);
    const current = result[key];
    if (current === undefined) result[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else result[key] = [current, value];
  }
  return result;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET") return undefined;
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", `Local request body must not exceed ${MAX_BODY_BYTES} bytes.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new CcpError("CCP_LIMIT_EXCEEDED", `Local request body must not exceed ${MAX_BODY_BYTES} bytes.`);
    chunks.push(bytes);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new CcpError("CCP_CANONICAL_INVALID", "Local request body is not valid JSON.");
  }
}

export class LocalHttpServer {
  private readonly routes = new Map<string, LocalHttpHandler>();
  private server: Server | null = null;
  private lifecycle: "idle" | "accepting" | "draining" | "closed" = "idle";
  private inFlight = 0;
  private closePromise: Promise<void> | null = null;
  private readonly drainWaiters: Array<() => void> = [];

  constructor(private readonly auth: LocalAuthContext) {}

  route(method: HttpMethod, path: string, handler: LocalHttpHandler): void {
    const key = `${method} ${path}`;
    if (this.routes.has(key)) throw new Error(`duplicate local route: ${key}`);
    this.routes.set(key, handler);
  }

  async listen(port: number): Promise<number> {
    if (this.server || this.lifecycle !== "idle") throw new Error("local HTTP server already started");
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
    this.lifecycle = "accepting";
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local HTTP server did not expose a TCP port");
    return address.port;
  }

  beginDrain(): void {
    if (this.lifecycle === "accepting") this.lifecycle = "draining";
  }

  isDraining(): boolean {
    return this.lifecycle === "draining";
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.beginDrain();
    const server = this.server;
    if (!server) {
      this.lifecycle = "closed";
      return;
    }
    this.closePromise = (async () => {
      const socketClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      const workDrained = this.inFlight === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => this.drainWaiters.push(resolve));
      await Promise.all([socketClosed, workDrained]);
      this.server = null;
      this.lifecycle = "closed";
    })();
    return this.closePromise;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    if (this.lifecycle !== "accepting") {
      sendJson(response, 503, toCcpErrorBody(new CcpError("CCP_BUSY", "Local server is draining and is not accepting new work.")));
      return;
    }
    this.inFlight += 1;
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const denial = validateLocalIngress(this.auth, request, url.pathname);
      if (denial) {
        sendJson(response, denial.status, denial.body);
        return;
      }
      const method = request.method as HttpMethod;
      const handler = this.routes.get(`${method} ${url.pathname}`);
      if (!handler) {
        sendJson(response, 404, { error: "Local route not found." });
        return;
      }
      const body = await readJsonBody(request);
      await handler({ method, path: url.pathname, query: parseQuery(url), body, request, response, startedAt });
      if (!response.writableEnded) sendJson(response, 204, null);
    } catch (error) {
      const typed = error instanceof CcpError ? error : new CcpError("CCP_INTERNAL", "Local request failed.");
      const status = typed.body.code === "CCP_LIMIT_EXCEEDED" ? 413
        : typed.body.code === "CCP_CANONICAL_INVALID" ? 400
          : typed.body.code === "CCP_IDEMPOTENCY_CONFLICT" ? 409
            : typed.body.code === "CCP_BUSY" ? 503
              : typed.body.code === "CCP_INTERNAL" ? 500 : 422;
      sendJson(response, status, toCcpErrorBody(typed), { "x-duration-ms": String(Date.now() - startedAt) });
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const resolve of this.drainWaiters.splice(0)) resolve();
      }
    }
  }
}
