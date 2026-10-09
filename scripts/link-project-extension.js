'use strict';

const fs = require('node:fs');
const path = require('node:path');

const extensionName = 'ccp3x';
const repositoryRoot = path.resolve(__dirname, '..');

function backupPathFor(destination) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `${destination}.imported-backup-${timestamp}`;
}

function linkProjectExtension({ projectPath, sourcePath = repositoryRoot, replace = false }) {
  if (!projectPath) throw new Error('A Cocos project path is required.');

  const project = path.resolve(projectPath);
  const source = path.resolve(sourcePath);
  const destination = path.join(project, 'extensions', extensionName); for (const legacy of ['cc-bridge-3x', 'cocos-pilot-3x']) if (fs.existsSync(path.join(project, 'extensions', legacy))) throw new Error(`Legacy extension ${legacy} is still installed; close Creator and preserve it outside extensions before installing CCP (no double loading).`);

  if (!fs.statSync(project).isDirectory()) {
    throw new Error(`Cocos project directory does not exist: ${project}`);
  }
  if (!fs.statSync(source).isDirectory()) {
    throw new Error(`Extension source directory does not exist: ${source}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  let backup;
  if (fs.existsSync(destination)) {
    if (fs.realpathSync(destination) === fs.realpathSync(source)) {
      return { destination, status: 'already-linked' };
    }
    if (!replace) {
      throw new Error(`Extension destination already exists: ${destination}. Re-run with --replace to preserve it as a backup and create the junction.`);
    }

    backup = backupPathFor(destination);
    fs.renameSync(destination, backup);
  }

  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  return { destination, backup, status: 'linked' };
}

function usage() {
  return [
    'Usage: npm run link:project -- <path-to-cocos-project> [--replace]',
    '',
    '--replace  Rename an existing ccp3x directory to a timestamped backup before linking.',
  ].join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const projectPath = args.find((arg) => arg !== '--replace');

  if (!projectPath || args.some((arg) => arg !== '--replace' && arg !== projectPath)) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    try {
      const result = linkProjectExtension({ projectPath, replace });
      console.log(`${result.status}: ${result.destination}`);
      if (result.backup) console.log(`backup: ${result.backup}`);
      console.log('Run npm run build, then reload the extension or restart Creator before testing cached modules.');
    } catch (error) {
      console.error(`link:project failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { linkProjectExtension };
