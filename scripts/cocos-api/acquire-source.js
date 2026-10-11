'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPOSITORY = 'cocos/cocos-engine';
const PINS = {
  '3.7.3': '4a183b14c0eab966d119bb0bcca5115015c784cd',
  '3.8.8': '411f98df047c25902f93440d4b22925c2fb65461',
};
const MAX_ARCHIVE = 256 * 1024 * 1024;
const EXTRACTOR = path.join(__dirname, 'extract-source.py');
const headers = { 'User-Agent': 'CCP-Cocos-API-Discovery', Accept: 'application/vnd.github+json' };

async function request(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(180000), redirect: 'error' });
  if (!response.ok) throw new Error(`Source request failed: HTTP ${response.status} ${url}`);
  return response;
}

async function resolveTag(version) {
  const ref = await (await request(`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${version}`)).json();
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 4; depth++) {
    object = (await (await request(`https://api.github.com/repos/${REPOSITORY}/git/tags/${object.sha}`)).json()).object;
  }
  if (object.type !== 'commit' || object.sha !== PINS[version]) throw new Error('Official tag no longer matches the approved commit');
  return object.sha;
}

async function acquire({ version, outputRoot }) {
  if (!Object.hasOwn(PINS, version)) throw new Error('Only approved versions 3.7.3 and 3.8.8 may be acquired');
  const root = path.resolve(outputRoot);
  fs.mkdirSync(root, { recursive: true });
  const commit = PINS[version];
  const destination = path.join(root, `engine-${version}-${commit.slice(0, 8)}`);
  const manifestDirectory = path.join(root, 'manifests');
  fs.mkdirSync(manifestDirectory, { recursive: true });
  const manifestPath = path.join(manifestDirectory, `engine-${version}-${commit}.json`);
  const archivePath = path.join(root, `engine-${version}-${commit}.zip`);
  if ([destination, manifestPath, archivePath].some(file => fs.existsSync(file))) throw new Error('Destination already exists; refusing to overlay source or provenance');
  const lock = path.join(root, `.acquire-${version}.lock`);
  fs.mkdirSync(lock);
  const stage = fs.mkdtempSync(path.join(root, `.stage-${version}-`));
  let published = false;
  let sourcePublished = false;
  try {
    await resolveTag(version);
    const latest = await (await request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`)).json();
    if (latest.tag_name !== '3.8.8') throw new Error(`Latest stable changed to ${latest.tag_name}; review the approved comparison before acquiring`);
    const downloadURL = `https://codeload.github.com/${REPOSITORY}/zip/${commit}`;
    const response = await request(downloadURL);
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > MAX_ARCHIVE) throw new Error('Archive download exceeds size limit');
    const temporaryArchive = path.join(stage, 'source.zip');
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE) return callback(new Error('Archive download exceeds size limit'));
      digest.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(temporaryArchive, { flags: 'wx' }));
    const sourceStage = path.join(stage, 'source');
    const extraction = spawnSync(process.env.CCP_API_PYTHON || 'python', [EXTRACTOR, temporaryArchive, sourceStage, commit, version], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000, windowsHide: true });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) throw new Error(`Archive validation failed: ${extraction.stderr.trim()}`);
    const metadata = JSON.parse(extraction.stdout);
    const manifest = {
      schemaVersion: 1, repository: REPOSITORY, ref: `refs/tags/${version}`, resolvedCommit: commit,
      resolvedAtVN: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()) + '+07:00',
      downloadURL, archiveSHA256: digest.digest('hex'), archiveBytes: bytes,
      extractorVersion: crypto.createHash('sha256').update(fs.readFileSync(EXTRACTOR)).digest('hex'),
      nodeVersion: process.version, latestObserved: latest.tag_name, upstreamHooksExecuted: false,
      ...metadata,
    };
    // The per-version lock prevents another acquisition publishing the same target.
    if ([destination, manifestPath, archivePath].some(file => fs.existsSync(file))) throw new Error('Destination appeared during acquisition; refusing publication');
    let archivePublished = false;
    try {
      fs.copyFileSync(temporaryArchive, archivePath, fs.constants.COPYFILE_EXCL);
      archivePublished = true;
      fs.mkdirSync(destination); // Exclusive directory creation; never rename over an unowned empty directory.
      sourcePublished = true;
      for (const entry of fs.readdirSync(sourceStage)) fs.renameSync(path.join(sourceStage, entry), path.join(destination, entry));
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      published = true;
    } catch (error) {
      if (sourcePublished) fs.rmSync(destination, { recursive: true });
      if (archivePublished) fs.rmSync(archivePath, { force: true });
      throw error;
    }
    return { destination, manifestPath, archivePath, packageVersion: metadata.packageVersion,
      sourceTreeHash: metadata.sourceTreeHash, fileCount: metadata.fileCount, archiveSHA256: manifest.archiveSHA256 };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmdirSync(lock);
    // A foreign manifest may have appeared during publication; never remove or relabel it.
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--version' || args[2] !== '--output-root') {
    console.error('Usage: node scripts/cocos-api/acquire-source.js --version <3.7.3|3.8.8> --output-root <fresh-source-root>');
    process.exitCode = 1;
  } else acquire({ version: args[1], outputRoot: args[3] }).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
module.exports = { acquire, PINS };
