const fs = require("node:fs");
const path = require("node:path");
const { fixedAclOutput, isFixedAclModule } = require("./fixed-acl-witness");

const dist = path.join(__dirname, "..", "dist");
const approvedAclOutput = fixedAclOutput(dist);
const forbidden = [
  /new Function\s*\(/,
  /\beval\s*\(/,
  /CCP_EXECUTION_PRIVATE_KEY/,
  /planCreateUiNode/,
  /sourceMappingURL=data:/,
  /"sourcesContent"\s*:/,
  /\bexecuteJavascript\b/,
  /\.utcp-debug/,
  /\bDEBUG_LOG_DIR\b/,
  /require\(['"]node:/,
  /from\s+['"]node:/,
  /require\(['"](?:stream|timers)\/promises['"]\)/,
  /\bAbortSignal\.timeout\s*\(/,
  /\.at\s*\(/,
  /\.toString\(['"]base64url['"]\)/,
  /Buffer\.from\([^)]*,\s*['"]base64url['"]\)/,
];
const updaterProcess = [
  /require\(['"]child_process['"]\)/,
  /from\s+['"]child_process['"]/,
  /\b(?:execFile(?:Sync)?|execSync)\b/,
  /\b(?:spawn(?:Sync)?|fork)\s*\(/,
];
let hits = 0;

function walk(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`missing ${dir}`);
    process.exit(1);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.name.endsWith(".map") || entry.name.endsWith(".ts")) {
      console.error(`${full}: source/source-map file must not ship`);
      hits += 1;
      continue;
    }
    const bytes = fs.readFileSync(full);
    const text = bytes.toString("utf8");
    const isUpdaterRuntime = full.startsWith(`${path.join(dist, "update")}${path.sep}`);
    const relativePath = `dist/${path.relative(dist, full).split(path.sep).join("/")}`;
    const isAclRuntime = isFixedAclModule(relativePath, bytes, approvedAclOutput);
    if (relativePath === approvedAclOutput && !isAclRuntime) {
      console.error(`${full}: unapproved fixed ACL implementation`);
      hits += 1;
    }
    const patterns = isUpdaterRuntime || isAclRuntime ? forbidden : [...forbidden, ...updaterProcess];
    for (const pattern of patterns) {
      if (pattern.source === "\\bexecuteJavascript\\b" && text.includes("REMOVED_CUSTOMER_TOOLS")) continue;
      if (pattern.test(text)) {
        console.error(`${full}: ${pattern}`);
        hits += 1;
      }
    }
  }
}

walk(dist);
if (fs.existsSync(path.join(dist, "utcp", "execute"))) {
  console.error("dist/utcp/execute must not ship");
  hits += 1;
}
for (const stale of ["dist/utcp/tools/program-tools.js", "dist/utcp/tools/diagnostics-tools.js"]) {
  if (fs.existsSync(path.join(__dirname, "..", stale))) {
    console.error(`${stale} must not ship`);
    hits += 1;
  }
}
if (hits) {
  console.error(`forbidden material witness failed: ${hits} hit(s)`);
  process.exit(1);
}
console.log("forbidden material witness: clean");
