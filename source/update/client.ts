import { createHash } from "crypto"
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from "fs"
import { request as httpsRequest } from "https"
import { dirname } from "path"
import { URL } from "url"
import { CcpError } from "../protected/errors";

const MAX_REDIRECTS = 3;
type Reader = { getReader(): ReadableStreamDefaultReader<Uint8Array> };

function node14Fetch(url: URL, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { "accept-encoding": "identity" },
      ca: process.env.CCP_RELEASE_CA_PATH || process.env.NODE_EXTRA_CA_CERTS
        ? readFileSync(process.env.CCP_RELEASE_CA_PATH || process.env.NODE_EXTRA_CA_CERTS!)
        : undefined,
    }, (incoming) => {
      const pending: Array<{ resolve: (value: ReadResult) => void; reject: (error: Error) => void }> = [];
      const chunks: Buffer[] = [];
      let ended = false;
      let failure: Error | null = null;
      const flush = () => {
        while (pending.length && chunks.length) pending.shift()!.resolve({ done: false, value: new Uint8Array(chunks.shift()!) });
        if (ended && !chunks.length) while (pending.length) pending.shift()!.resolve({ done: true, value: undefined });
        if (failure) while (pending.length) pending.shift()!.reject(failure);
      };
      incoming.on("data", (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); flush(); });
      incoming.once("end", () => { ended = true; flush(); });
      incoming.once("error", (error: Error) => { failure = error; flush(); });
      const status = incoming.statusCode || 0;
      const headers = { get(name: string): string | null {
        const value = incoming.headers[name.toLowerCase()];
        return Array.isArray(value) ? value.join(", ") : value == null ? null : String(value);
      } };
      const body: Reader = { getReader: () => ({
        read: () => new Promise<ReadResult>((readResolve, readReject) => {
          if (failure) readReject(failure);
          else if (chunks.length) readResolve({ done: false, value: new Uint8Array(chunks.shift()!) });
          else if (ended) readResolve({ done: true, value: undefined });
          else pending.push({ resolve: readResolve, reject: readReject });
        }),
        cancel: async () => { incoming.destroy(); },
      } as ReadableStreamDefaultReader<Uint8Array>) };
      resolve({ status, ok: status >= 200 && status < 300, headers, body } as unknown as Response);
    });
    request.once("error", reject);
    if (signal) {
      if (signal.aborted) request.destroy();
      else signal.addEventListener("abort", () => request.destroy(), { once: true });
    }
    request.end();
  });
}

type ReadResult = { done: boolean; value?: Uint8Array };

export function assertReleaseOrigin(origin: string): URL {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.href !== `${url.origin}/`) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Release origin must be an exact HTTPS origin without path, credentials, query, or fragment.");
  }
  return url;
}

export function assertReleaseArtifactUrl(origin: URL, artifactUrl: string): URL {
  const url = new URL(artifactUrl);
  if (url.origin !== origin.origin || url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Release artifact URL must stay on the HTTPS release origin.");
  }
  return url;
}

async function fetchRelease(origin: URL, input: URL, signal?: AbortSignal): Promise<Response> {
  let url = assertReleaseArtifactUrl(origin, input.href);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response;
    try { response = typeof fetch === "function"
      ? await fetch(url, { redirect: "manual", signal, headers: { "accept-encoding": "identity" } })
      : await node14Fetch(url, signal); }
    catch (error) {
      const cause = error && typeof error === "object" && "cause" in error
        ? (error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : undefined)
        : undefined;
      const transport = typeof cause === "string"
        ? cause.slice(0, 64)
        : error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 96) : undefined;
      throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Release artifact request failed.", transport ? { transport } : {});
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Release redirect chain is invalid or too long.");
      url = assertReleaseArtifactUrl(origin, new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new CcpError("CCP_GATEWAY_UNAVAILABLE", `Release origin returned HTTP ${response.status}.`, { status: response.status });
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") throw new CcpError("CCP_CANONICAL_INVALID", "Compressed release responses are not accepted.");
    return response;
  }
  throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Release redirect chain did not terminate.");
}

function declaredLength(response: Response, maxBytes: number): number {
  const header = response.headers.get("content-length");
  const length = header === null ? Number.NaN : Number(header);
  if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) {
    throw new CcpError("CCP_LIMIT_EXCEEDED", `Release response must declare 1..${maxBytes} bytes.`);
  }
  return length;
}

export async function fetchReleaseJson(origin: URL, artifactUrl: string, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchRelease(origin, assertReleaseArtifactUrl(origin, artifactUrl), signal);
  const expected = declaredLength(response, maxBytes);
  if (!response.body) throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Release response body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > expected || total > maxBytes) {
      await reader.cancel();
      throw new CcpError("CCP_LIMIT_EXCEEDED", "Release response exceeded its declared size.");
    }
    chunks.push(value);
  }
  if (total !== expected) throw new CcpError("CCP_SIGNATURE_INVALID", "Release response was truncated.");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new CcpError("CCP_CANONICAL_INVALID", "Release response is not valid JSON."); }
}

export async function downloadReleaseArtifact(
  origin: URL,
  artifactUrl: string,
  destination: string,
  expectedSize: number | { maxBytes: number },
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const exactBytes = typeof expectedSize === "number" ? expectedSize : undefined;
  const maxBytes = typeof expectedSize === "number" ? expectedSize : expectedSize.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new CcpError("CCP_CANONICAL_INVALID", "Signed release artifact bounds are invalid.");
  }
  const response = await fetchRelease(origin, assertReleaseArtifactUrl(origin, artifactUrl), signal);
  const declared = declaredLength(response, maxBytes);
  if (exactBytes !== undefined && declared !== exactBytes) throw new CcpError("CCP_SIGNATURE_INVALID", "Artifact Content-Length differs from signed metadata.");
  if (!response.body) throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Release artifact body is missing.");
  const partial = `${destination}.partial`;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  rmSync(partial, { force: true });
  const output = createWriteStream(partial, { flags: "wx", mode: 0o600 });
  const digest = createHash("sha256");
  let total = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > declared) {
        await reader.cancel();
        throw new CcpError("CCP_LIMIT_EXCEEDED", "Release artifact exceeded its declared size.");
      }
      const chunk = Buffer.from(value);
      digest.update(chunk);
      if (!output.write(chunk)) await new Promise<void>((resolve) => output.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.once("finish", resolve);
      output.end();
    });
    const sha256 = digest.digest("hex");
    if (total !== declared || sha256 !== expectedSha256) throw new CcpError("CCP_SIGNATURE_INVALID", "Release artifact size or hash does not match signed metadata.");
    renameSync(partial, destination);
    return { path: destination, bytes: total, sha256 };
  } catch (error) {
    output.destroy();
    rmSync(partial, { force: true });
    throw error;
  }
}
