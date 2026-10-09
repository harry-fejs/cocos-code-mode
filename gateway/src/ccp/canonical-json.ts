/*
 * RFC 8785 canonicalizer derived from canonicalize v2.0.0.
 * Upstream: https://github.com/erdtman/canonicalize/tree/v2.0.0
 * Modified: strict I-JSON validation, bounded parsing, fatal UTF-8 decoding.
 * License: Apache-2.0; see canonical-json.LICENSE.txt.
 */
import { TextDecoder } from "node:util";

export type IJson = null | boolean | string | number | IJson[] | { [key: string]: IJson };

export interface IJsonLimits {
  maxDepth?: number;
  maxEntries?: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_ENTRIES = 100_000;

function assertUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError(`${path}: unpaired high surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${path}: unpaired low surrogate`);
    }
  }
}

export function assertIJson(value: unknown, limits: IJsonLimits = {}): asserts value is IJson {
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ancestors = new Set<object>();
  let entries = 0;

  const visit = (current: unknown, path: string, depth: number): void => {
    if (depth > maxDepth) throw new RangeError(`I-JSON exceeds depth ${maxDepth}`);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      assertUnicode(current, path);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${path}: non-finite number`);
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) throw new TypeError(`${path}: unsafe integer`);
      return;
    }
    if (typeof current !== "object") throw new TypeError(`${path}: not I-JSON`);
    if (ancestors.has(current)) throw new TypeError(`${path}: cyclic value`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)))) {
          throw new TypeError(`${path}: array has non-JSON properties`);
        }
        entries += current.length;
        if (entries > maxEntries) throw new RangeError(`I-JSON exceeds ${maxEntries} entries`);
        for (let index = 0; index < current.length; index += 1) visit(current[index], `${path}[${index}]`, depth + 1);
        return;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path}: not a plain object`);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key !== "string" || !descriptors[key]?.enumerable)) {
        throw new TypeError(`${path}: symbol or non-enumerable property not allowed`);
      }
      const keys = ownKeys as string[];
      entries += keys.length;
      if (entries > maxEntries) throw new RangeError(`I-JSON exceeds ${maxEntries} entries`);
      for (const key of keys) {
        assertUnicode(key, `${path} key`);
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) throw new TypeError(`${path}.${key}: accessor not allowed`);
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, "$", 0);
}

function appendCanonical(value: IJson, output: string[]): void {
  if (value === null || typeof value !== "object") {
    output.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    output.push("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index !== 0) output.push(",");
      appendCanonical(value[index], output);
    }
    output.push("]");
    return;
  }
  output.push("{");
  const keys = Object.keys(value).sort();
  for (let index = 0; index < keys.length; index += 1) {
    if (index !== 0) output.push(",");
    const key = keys[index];
    output.push(JSON.stringify(key), ":");
    appendCanonical(value[key], output);
  }
  output.push("}");
}

export function canonicalizeJson(value: unknown, limits?: IJsonLimits): string {
  assertIJson(value, limits);
  const output: string[] = [];
  appendCanonical(value, output);
  return output.join("");
}

export function canonicalizeToBytes(value: unknown, limits?: IJsonLimits): Buffer {
  return Buffer.from(canonicalizeJson(value, limits), "utf8");
}

export function parseCanonicalJson(payload: Uint8Array, maxBytes: number): IJson {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be positive");
  if (payload.byteLength === 0 || payload.byteLength > maxBytes) throw new RangeError(`payload must contain 1..${maxBytes} bytes`);
  const raw = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const parsed: unknown = JSON.parse(source);
  if (!raw.equals(canonicalizeToBytes(parsed))) throw new TypeError("payload is not canonical RFC 8785 I-JSON");
  return parsed as IJson;
}
