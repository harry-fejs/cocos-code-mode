const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Stamps build provenance into dist/ (not source/) so the repo stays clean and
// tsc keeps working without this. main.ts reads it with a fallback.
// Point: a deployed dist/ that predates HEAD looks identical to a fresh one --
// this is what makes "the editor is running a stale build" visible.

const projectRoot = path.join(__dirname, '..');

function git(args, fallback) {
    try {
        return execSync(`git ${args}`, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim();
    } catch (e) {
        // No git, no repo, or git not on PATH -- a build is still valid without it.
        return fallback;
    }
}

const info = {
    commit: git('rev-parse --short HEAD', 'unknown'),
    branch: git('rev-parse --abbrev-ref HEAD', 'unknown'),
    // Uncommitted changes at build time: "the code you tested isn't in git".
    // Scoped to what actually ends up in the build -- the editor drops temp files
    // at the repo root, and a flag that cries wolf is a flag people stop reading.
    // Untracked files count here: a new source/*.ts does get compiled in.
    dirty: git('status --porcelain -- source static scripts tools/cocos-graph package.json base.tsconfig.json tsconfig.json', '') !== '',
    mode: 'readable',
    builtAt: new Date().toISOString()
};

const distDir = path.join(projectRoot, 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(info, null, 2));
console.log(`build-info: ${info.commit}${info.dirty ? '-dirty' : ''} (${info.branch})`);
