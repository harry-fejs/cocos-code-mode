const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver'); // archiver v8: class-based API (ccp3x Node >= 18)

const packageJsonPath = path.join(__dirname, '../package.json');
if (!fs.existsSync(packageJsonPath)) {
    console.error('package.json not found!');
    process.exit(1);
}

const packageJson = require(packageJsonPath);
const packageName = packageJson.name;
const projectRoot = path.join(__dirname, '..');

// Also gate direct packaging, before removing or creating any archive.
require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'check-creator-load.js')], { cwd: projectRoot, stdio: 'inherit' });

// Zip name carries version + build timestamp so artifacts from different
// sessions never silently collide: ccp3x-<version>-YYMMDD-HHMMSS.zip.
// Timestamp comes from dist/build-info.json (stamped at build time) so the
// name always matches the packaged build; falls back to now.
function buildTimestamp() {
    try {
        const info = JSON.parse(fs.readFileSync(path.join(projectRoot, 'dist', 'build-info.json'), 'utf8'));
        if (info.builtAt) return new Date(info.builtAt);
    } catch { /* fall through to now */ }
    return new Date();
}
const ts = buildTimestamp();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${String(ts.getFullYear()).slice(2)}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
const zipFileName = `${packageName}-v${packageJson.version.replace(/\./g, '')}-${stamp}.zip`;

// Derive zip version from build-info.json stamped at build time, so the
// Extensions Manager header shows which commit produced this artifact.
// Source package.json stays at 1.0.0; only the archived copy is patched.
function resolveZipVersion() {
    const fallback = packageJson.version;
    try {
        const infoPath = path.join(projectRoot, 'dist', 'build-info.json');
        if (!fs.existsSync(infoPath)) return fallback;
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        if (!info.commit || info.commit === 'unknown') return fallback;
        const suffix = info.dirty ? '-dirty' : '';
        return `${fallback}-dev.${info.commit}${suffix}`;
    } catch {
        return fallback;
    }
}
const zipVersion = resolveZipVersion();
if (zipVersion !== packageJson.version) {
    console.log(`Patched zip version: ${packageJson.version} -> ${zipVersion}`);
}

// List of files/folders to include in the archive
const filesToInclude = [
    '@types',
    'dist',
    'i18n',
    'node_modules',
    'static',
    'package-lock.json',
    'package.json',
    'README.md'
];

const outputPath = path.join(projectRoot, zipFileName);

// Each package run supersedes the previous build (dist/ is overwritten anyway),
// so drop any leftover ccp3x*.zip first — artifacts must not pile up.
for (const old of fs.readdirSync(projectRoot)) {
    if (old === zipFileName || !/^ccp3x.*\.zip$/.test(old)) continue;
    fs.unlinkSync(path.join(projectRoot, old));
    console.log(`Removed old package: ${old}`);
}

console.log(`Packaging project into ${zipFileName}...`);

const output = fs.createWriteStream(outputPath);
const archive = new ZipArchive({ zlib: { level: 9 } });

output.on('close', () => {
    const sizeMb = (archive.pointer() / 1024 / 1024).toFixed(1);
    console.log(`\nPackage created successfully: ${outputPath} (${sizeMb} MB)`);
});

archive.on('error', (err) => {
    console.error('Error creating package:', err.message);
    process.exit(1);
});

archive.pipe(output);

for (const item of filesToInclude) {
    if (item === 'package.json') {
        // Patch version in archived copy; leave source untouched. Wrap in package prefix (v2 parity).
        const patched = { ...packageJson, version: zipVersion };
        const content = JSON.stringify(patched, null, 2);
        archive.append(content, { name: `${packageName}/package.json` });
        continue;
    }
    const itemPath = path.join(projectRoot, item);
    if (!fs.existsSync(itemPath)) {
        // Skip missing items; 'dist' missing is significant, warn loudly
        console.warn(`Warning: '${item}' not found, skipping${item === 'dist' ? ' (build output missing - run npm run build!)' : ''}`);
        continue;
    }
    if (fs.statSync(itemPath).isDirectory()) {
        archive.directory(itemPath, `${packageName}/${item}`);
    } else {
        archive.file(itemPath, { name: `${packageName}/${item}` });
    }
}

archive.finalize();
