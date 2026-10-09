import { realpathSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_WORKER = join(RUNTIME_ROOT, 'runtime-worker.mjs');
const MAX_RUNTIME_TIMEOUT_MS = 5 * 60 * 1000;

export function resolveProjectCache(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim() || !isAbsolute(projectPath)) {
    throw new Error('cocos-graph: project root must be an absolute path from the active Creator project');
  }
  const project = realpathSync(projectPath);
  const outDir = resolve(project, '.cocos-graph', 'ccp');
  mkdirSync(outDir, { recursive: true });
  const realOutDir = realpathSync(outDir);
  const rel = relative(project, realOutDir);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('cocos-graph: project cache escapes the active Creator project');
  }
  return { project, outDir: realOutDir };
}

export function runGraphWorker(operation, input, { timeoutMs = 120000 } = {}) {
  if (!['status', 'build', 'query', 'resolve', 'navigate', 'refs', 'validate'].includes(operation)) {
    throw new Error(`cocos-graph: unsupported runtime operation "${operation}"`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RUNTIME_TIMEOUT_MS) {
    throw new Error(`cocos-graph: timeoutMs must be an integer from 1 to ${MAX_RUNTIME_TIMEOUT_MS}`);
  }
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    const worker = new Worker(RUNTIME_WORKER, { workerData: { operation, input, coreDir: join(RUNTIME_ROOT, 'src') } });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.terminate().catch(() => {});
      if (error) rejectResult(error);
      else resolveResult(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`cocos-graph: worker operation timed out after ${timeoutMs}ms`);
      error.code = 'GRAPH_BUILD_TIMEOUT';
      finish(error);
    }, timeoutMs);
    worker.once('message', (message) => {
      if (!message || typeof message !== 'object') {
        finish(new Error('cocos-graph: worker returned an invalid response'));
      } else if (message.ok === true) {
        finish(null, message.result);
      } else {
        const error = new Error(typeof message.error === 'string' ? message.error : 'cocos-graph: worker operation failed');
        error.code = typeof message.code === 'string' ? message.code : 'GRAPH_BUILD_FAILED';
        finish(error);
      }
    });
    worker.once('error', (cause) => finish(cause));
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error(`cocos-graph: worker exited with code ${code} before returning a result`));
    });
  });
}
