import { CcpError } from "../protected/errors";

type Identifier = number | string;
interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: Identifier[];
}
interface PartialVersion {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: Identifier[];
}
interface Comparator {
  operator: "=" | ">" | ">=" | "<" | "<=";
  version: Version;
}

const NUMERIC = /^(?:0|[1-9]\d*)$/;

function identifiers(value: string | undefined): Identifier[] {
  if (!value) return [];
  return value.split(".").map((part) => NUMERIC.test(part) ? Number(part) : part);
}

function parseVersion(value: string): Version {
  const match = /^\s*[vV]?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\s*$/.exec(value);
  if (!match) throw new CcpError("CCP_CREATOR_INCOMPATIBLE", `Creator version is not valid SemVer: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: identifiers(match[4]) };
}

function parsePartial(value: string): PartialVersion {
  const match = /^[vV]?(x|X|\*|0|[1-9]\d*)(?:\.(x|X|\*|0|[1-9]\d*))?(?:\.(x|X|\*|0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new CcpError("CCP_CANONICAL_INVALID", `Creator compatibility is not a valid SemVer range: ${value}`);
  const number = (part: string | undefined): number | undefined => !part || /^[xX*]$/.test(part) ? undefined : Number(part);
  const major = number(match[1]);
  const minor = major === undefined ? undefined : number(match[2]);
  const patch = minor === undefined ? undefined : number(match[3]);
  if (match[4] && patch === undefined) throw new CcpError("CCP_CANONICAL_INVALID", "Prerelease Creator ranges require major.minor.patch.");
  return { major, minor, patch, prerelease: identifiers(match[4]) };
}

function concrete(partial: PartialVersion): Version {
  return { major: partial.major ?? 0, minor: partial.minor ?? 0, patch: partial.patch ?? 0, prerelease: partial.prerelease };
}

function upperBound(partial: PartialVersion): Version | null {
  if (partial.major === undefined) return null;
  if (partial.minor === undefined) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (partial.patch === undefined) return { major: partial.major, minor: partial.minor + 1, patch: 0, prerelease: [] };
  return null;
}

function compare(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "string") return -1;
    if (typeof a === "string" && typeof b === "number") return 1;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

function expandPlain(operator: Comparator["operator"], partial: PartialVersion): Comparator[] {
  const lower = concrete(partial);
  const upper = upperBound(partial);
  if (!upper) return [{ operator, version: lower }];
  if (operator === "=") return [{ operator: ">=", version: lower }, { operator: "<", version: upper }];
  if (operator === ">=") return [{ operator: ">=", version: lower }];
  if (operator === ">") return [{ operator: ">=", version: upper }];
  if (operator === "<=") return [{ operator: "<", version: upper }];
  return [{ operator: "<", version: lower }];
}

function expandToken(token: string): Comparator[] {
  if (!token || token === "*" || /^[xX]$/.test(token)) return [];
  const match = /^(<=|>=|<|>|=|~|\^)?(.+)$/.exec(token);
  if (!match) throw new CcpError("CCP_CANONICAL_INVALID", `Invalid Creator range token: ${token}`);
  const operator = (match[1] ?? "=") as Comparator["operator"] | "~" | "^";
  const partial = parsePartial(match[2]);
  if (operator !== "~" && operator !== "^") return expandPlain(operator, partial);
  if (partial.major === undefined) return [];
  const lower = concrete(partial);
  let upper: Version;
  if (operator === "~") {
    upper = partial.minor === undefined
      ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: [] }
      : { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: [] };
  } else if (lower.major > 0 || partial.minor === undefined) {
    upper = { major: lower.major + 1, minor: 0, patch: 0, prerelease: [] };
  } else if (lower.minor > 0 || partial.patch === undefined) {
    upper = { major: 0, minor: lower.minor + 1, patch: 0, prerelease: [] };
  } else {
    upper = { major: 0, minor: 0, patch: lower.patch + 1, prerelease: [] };
  }
  return [{ operator: ">=", version: lower }, { operator: "<", version: upper }];
}

function expandHyphen(set: string): string {
  return set.replace(/(^|\s)([^\s]+)\s+-\s+([^\s]+)(?=\s|$)/g, (_match, prefix: string, left: string, right: string) => {
    const lower = concrete(parsePartial(left));
    const upperPartial = parsePartial(right);
    const upper = upperBound(upperPartial);
    const upperText = upper
      ? `<${upper.major}.${upper.minor}.${upper.patch}`
      : `<=${concrete(upperPartial).major}.${concrete(upperPartial).minor}.${concrete(upperPartial).patch}${upperPartial.prerelease.length ? `-${upperPartial.prerelease.join(".")}` : ""}`;
    return `${prefix}>=${lower.major}.${lower.minor}.${lower.patch}${lower.prerelease.length ? `-${lower.prerelease.join(".")}` : ""} ${upperText}`;
  });
}

function passes(version: Version, comparator: Comparator): boolean {
  const result = compare(version, comparator.version);
  if (comparator.operator === "=") return result === 0;
  if (comparator.operator === ">") return result > 0;
  if (comparator.operator === ">=") return result >= 0;
  if (comparator.operator === "<") return result < 0;
  return result <= 0;
}

export function satisfiesSemverRange(versionText: string, rangeText: string): boolean {
  const version = parseVersion(versionText);
  if (!rangeText.trim()) throw new CcpError("CCP_CANONICAL_INVALID", "Creator compatibility range is empty.");
  return rangeText.split("||").some((rawSet) => {
    const normalizedSet = expandHyphen(rawSet.trim())
      .replace(/,/g, " ")
      .replace(/(<=|>=|<|>|=|~|\^)\s+(?=[vV0-9xX*])/g, "$1");
    const tokens = normalizedSet.split(/\s+/).filter(Boolean);
    const comparators = tokens.flatMap(expandToken);
    if (!comparators.every((comparator) => passes(version, comparator))) return false;
    if (version.prerelease.length === 0) return true;
    return comparators.some((comparator) => comparator.version.prerelease.length > 0
      && comparator.version.major === version.major
      && comparator.version.minor === version.minor
      && comparator.version.patch === version.patch);
  });
}
