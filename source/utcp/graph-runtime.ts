import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { ToolError } from './tool-error';
export type GraphWorkerErrorCode = 'GRAPH_NOT_BUILT' | 'GRAPH_BUILD_TIMEOUT' | 'GRAPH_OPERATION_TIMEOUT' | 'GRAPH_BUILD_FAILED' | 'GRAPH_PATH_INVALID' | 'GRAPH_CACHE_CORRUPT' | 'GRAPH_SCHEMA_UNSUPPORTED' | 'GRAPH_LIVE_INCOMPLETE';

export interface GraphWorkerResponse {
    ok: boolean;
    result?: unknown;
    code?: GraphWorkerErrorCode;
    error?: string;
}


export interface GraphOperationInput {
    project: string;
    outDir: string;
    [key: string]: unknown;
}

function contained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveProjectGraphCache(projectPath: unknown): { project: string, outDir: string } {
    if (typeof projectPath !== 'string' || !projectPath.trim() || !path.isAbsolute(projectPath)) {
        throw new ToolError({ code: 'GRAPH_PATH_INVALID', status: 400, message: 'The active Creator project path is unavailable or not absolute.' });
    }
    let project: string;
    try {
        project = fs.realpathSync(projectPath);
        if (!fs.statSync(project).isDirectory()) throw new Error('project root is not a directory');
    } catch (error) {
        throw new ToolError({ code: 'GRAPH_PATH_INVALID', status: 400, message: 'The active Creator project root could not be resolved.', details: { cause: error instanceof Error ? error.message : String(error) } });
    }

    const graphRoot = path.resolve(project, '.cocos-graph');
    try {
        if (fs.existsSync(graphRoot)) {
            const realGraphRoot = fs.realpathSync(graphRoot);
            if (!contained(project, realGraphRoot)) throw new Error('graph cache root escapes the project');
        } else {
            fs.mkdirSync(graphRoot);
        }
        const realGraphRoot = fs.realpathSync(graphRoot);
        if (!contained(project, realGraphRoot)) throw new Error('graph cache root escapes the project');
        const cacheRoot = path.resolve(realGraphRoot, 'ccp');
        if (!fs.existsSync(cacheRoot)) fs.mkdirSync(cacheRoot);
        const outDir = fs.realpathSync(cacheRoot);
        if (!contained(project, outDir) || !contained(realGraphRoot, outDir)) throw new Error('graph cache namespace escapes the project');
        return { project, outDir };
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'GRAPH_PATH_INVALID', status: 400, message: 'The project graph cache path is not contained in the active Creator project.', details: { cause: error instanceof Error ? error.message : String(error) } });
    }
}

export function runGraphWorker(operation: string, input: GraphOperationInput): Promise<unknown> {
    const workerPath = path.resolve(__dirname, '../cocos-graph/runtime-worker.mjs');
    if (!fs.existsSync(workerPath)) {
        throw new ToolError({ code: 'GRAPH_BUILD_FAILED', status: 500, message: 'The packaged Cocos Graph runtime worker is missing.', recovery: 'Rebuild and reinstall the CCP extension package.' });
    }
    const timeoutMs = operation === 'build' ? 5 * 60 * 1000 : 60 * 1000;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout;
        let worker: Worker;
        const finish = (error?: Error, result?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.removeAllListeners();
            void worker.terminate().catch(() => {});
            if (error) reject(error);
            else resolve(result);
        };
        try {
            worker = new Worker(workerPath, { workerData: { operation, input } });
        } catch (error) {
            reject(new ToolError({ code: 'GRAPH_BUILD_FAILED', status: 500, message: 'Cocos Graph worker could not start.', details: { cause: error instanceof Error ? error.message : String(error) } }));
            return;
        }
        timer = setTimeout(() => finish(new ToolError({
            code: operation === 'build' ? 'GRAPH_BUILD_TIMEOUT' : 'GRAPH_OPERATION_TIMEOUT',
            status: 504,
            message: `Cocos Graph ${operation} exceeded its ${timeoutMs}ms worker deadline.`,
            recovery: operation === 'build' ? 'Retry the explicit build when Creator is idle; the previous published generation remains authoritative.' : 'Retry the read after the worker has completed or the project is idle.',
        })), timeoutMs);
        worker.once('message', (message: unknown) => {
            if (!message || typeof message !== 'object' || !('ok' in message)) {
                finish(new ToolError({ code: 'GRAPH_BUILD_FAILED', status: 502, message: 'Cocos Graph worker returned an invalid response.' }));
                return;
            }
            const response = message as { ok: boolean, result?: unknown, code?: string, error?: string };
            if (response.ok) finish(undefined, response.result);
            else finish(new ToolError({
                code: response.code ?? 'GRAPH_BUILD_FAILED',
                status: response.code === 'GRAPH_NOT_BUILT' ? 422 : response.code === 'GRAPH_PATH_INVALID' ? 400 : 502,
                message: response.error ?? `Cocos Graph ${operation} failed.`,
                recovery: response.code === 'GRAPH_NOT_BUILT' ? 'Call graphManage with operation=build and the same bundle.' : 'Inspect the active project and cache status, then rebuild if the graph data is unavailable.',
            }));
        });
        worker.once('error', (error: Error) => finish(new ToolError({ code: 'GRAPH_BUILD_FAILED', status: 502, message: 'Cocos Graph worker failed.', details: { cause: error.message } })));
        worker.once('exit', (code: number) => {
            if (!settled && code !== 0) finish(new ToolError({ code: 'GRAPH_BUILD_FAILED', status: 502, message: `Cocos Graph worker exited with code ${code} before returning a result.` }));
        });
    });
}
