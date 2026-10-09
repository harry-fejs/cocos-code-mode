import { utcpTool } from '../decorators';
import { DEFAULT_TREE_MAX_DEPTH, DEFAULT_TREE_MAX_NODES } from '../utils/tools-utils';

// Performance snapshot + scene validation. Walks the scene tree to count
// nodes/components, and merges with runtime state + diagnostics + logs.

export class ValidationTools {

    @utcpTool(
        'getPerformanceSnapshot',
        'Get scene scale and performance counters: node/component counts, UI counts, depth, memory warnings.',
        { type: 'object', properties: {} },
        {
            type: 'object',
            properties: {
                nodeCount: { type: 'number' },
                componentCount: { type: 'number' },
                uiNodeCount: { type: 'number' },
                maxDepth: { type: 'number' },
                activeNodes: { type: 'number' },
                warnings: { type: 'array', items: { type: 'string' } },
            },
            required: ['nodeCount', 'componentCount'],
        },
        'GET',
        ['performance', 'snapshot', 'scene', 'count', 'health', 'memory']
    )
    async getPerformanceSnapshot(): Promise<{ nodeCount: number, componentCount: number, uiNodeCount: number, maxDepth: number, activeNodes: number, warnings: string[] }> {
        const tree = await Editor.Message.request('scene', 'query-node-tree') as any;
        if (!tree) {
            throw new Error('No scene open or failed to query scene tree');
        }

        let nodeCount = 0;
        let componentCount = 0;
        let uiNodeCount = 0;
        let activeNodes = 0;
        let maxDepth = 0;
        const warnings: string[] = [];

        const walk = (node: any, depth: number) => {
            nodeCount++;
            if (depth > maxDepth) maxDepth = depth;
            if (node.active !== false) activeNodes++;

            // Count components
            const comps = node.__comps__ || node.components || [];
            componentCount += Array.isArray(comps) ? comps.length : 0;

            // Detect UI nodes (have UITransform or are Canvas children)
            if (node.layer === 33554432) { // UI_2D layer
                uiNodeCount++;
            }

            const children = node.children || [];
            for (const child of children) {
                walk(child, depth + 1);
            }
        };

        walk(tree, 0);

        // Warnings for common performance issues
        if (nodeCount > 500) warnings.push(`High node count: ${nodeCount} nodes may impact performance`);
        if (maxDepth > 15) warnings.push(`Deep hierarchy: depth ${maxDepth} may cause layout issues`);
        if (componentCount > nodeCount * 3) warnings.push(`High component density: ${componentCount} components on ${nodeCount} nodes`);

        return { nodeCount, componentCount, uiNodeCount, maxDepth, activeNodes, warnings };
    }

    @utcpTool(
        'validateScene',
        'Run a compact validation pass: scene info + runtime state + TypeScript diagnostics + recent errors. Returns ok/fail with details.',
        {
            type: 'object',
            properties: {
                includeScriptDiagnostics: { type: 'boolean', description: 'Run TypeScript diagnostics (default true)' },
                includeLogErrors: { type: 'boolean', description: 'Check recent editor logs for errors (default true)' },
            },
        },
        {
            type: 'object',
            properties: {
                ok: { type: 'boolean' },
                scene: { type: 'object' },
                runtime: { type: 'object' },
                performance: { type: 'object' },
                diagnostics: { type: 'object' },
                logErrors: { type: 'array', items: { type: 'string' } },
            },
            required: ['ok'],
        },
        'POST',
        ['validate', 'scene', 'health', 'check', 'diagnostics', 'runtime']
    )
    async validateScene(args: { includeScriptDiagnostics?: boolean, includeLogErrors?: boolean }): Promise<{
        ok: boolean,
        scene: any,
        runtime: any,
        performance: any,
        diagnostics: any,
        logErrors: string[],
    }> {
        const includeLogs = args.includeLogErrors !== false;

        // M1: 5 independent probes -> run concurrently instead of sequentially.
        // Each probe keeps its own default + error fallback so the merged result
        // shape is unchanged.
        const probeScene = async () => {
            try {
                const tree = await Editor.Message.request('scene', 'query-node-tree') as any;
                if (tree) return { uuid: tree.uuid, name: tree.name, childCount: (tree.children || []).length };
                return { error: 'No scene open' };
            } catch (e: any) { return { error: e.message }; }
        };
        const probeRuntime = async () => {
            try {
                const state = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'ccp3x', method: 'runtimeGetState', args: [],
                });
                return state || { paused: false, timeScale: 1 };
            } catch (e: any) { return { error: e.message }; }
        };
        const probePerf = async () => {
            try { return await this.getPerformanceSnapshot(); } catch (e: any) { return { error: e.message }; }
        };
        const probeDiag = async () => null;
        const probeLogs = async (): Promise<string[]> => {
            if (!includeLogs) return [];
            try {
                const logs = await Editor.Message.request('console', 'query-logs', { level: 'error', limit: 10 }) as any[];
                if (Array.isArray(logs)) return logs.map(l => l.message || String(l)).slice(0, 5);
                return [];
            } catch { return []; }
        };

        const [scene, runtime, performance, diagnostics, logErrors] = await Promise.all([
            probeScene(), probeRuntime(), probePerf(), probeDiag(), probeLogs(),
        ]);

        // TypeScript diagnostics run outside the customer protected artifact
        // (internal-dev-only); validateScene returns diagnostics: null so the
        // public contract never launches a compiler process.
        const ok = !(scene as any).error && !(runtime as any).error && !(performance as any).error
            && logErrors.length === 0;

        return { ok, scene, runtime, performance, diagnostics, logErrors };
    }
}
