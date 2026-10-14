import { ToolError } from './tool-error';

export interface GraphVariableWaitCondition { graphUuid: string; name: string; type: 'float' | 'integer' | 'boolean'; value: number | boolean; timeoutMs?: number; pollMs?: number }
export async function waitForGraphVariable(condition: GraphVariableWaitCondition, observe: (timeoutMs: number) => Promise<Record<string, unknown>>) {
    const timeoutMs = condition?.timeoutMs ?? 3000; const pollMs = condition?.pollMs ?? 100;
    if (!condition || typeof condition.graphUuid !== 'string' || !condition.graphUuid || condition.graphUuid.length > 256
        || typeof condition.name !== 'string' || !condition.name.trim() || condition.name.length > 256
        || !['float', 'integer', 'boolean'].includes(condition.type)
        || (condition.type === 'boolean' ? typeof condition.value !== 'boolean' : typeof condition.value !== 'number' || !Number.isFinite(condition.value) || condition.type === 'integer' && !Number.isInteger(condition.value))
        || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exact graph UUID, typed variable condition and bounded timeout/poll interval.' });
    const deadline = Date.now() + timeoutMs; let observations = 0;
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Graph variable wait deadline expired; no mutation dispatched.' });
        let timer: NodeJS.Timeout | undefined; let snapshot: Record<string, unknown>;
        try { snapshot = await Promise.race([observe(Math.max(100, Math.min(remaining, 1000))), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Graph variable observation exceeded caller deadline; no mutation dispatched.' })), remaining); })]); }
        finally { clearTimeout(timer); }
        if (Date.now() >= deadline) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Graph variable read completed after deadline.' });
        if (snapshot.graphUuid !== condition.graphUuid) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Runtime graph UUID changed during variable wait.' });
        if (!Array.isArray(snapshot.variables)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Graph variable list unavailable.' });
        const matches = snapshot.variables.filter(variable => variable && typeof variable === 'object' && variable.name === condition.name);
        if (matches.length !== 1) throw new ToolError({ code: 'GRAPH_VARIABLE_NOT_FOUND', status: 404, message: 'Expected exactly one named graph variable.' });
        const variable = matches[0] as Record<string, unknown>;
        const type = condition.type === 'boolean' ? 1 : condition.type === 'integer' ? 3 : 0;
        if (variable.type !== type || (condition.type === 'boolean' ? typeof variable.value !== 'boolean' : typeof variable.value !== 'number' || !Number.isFinite(variable.value) || condition.type === 'integer' && !Number.isInteger(variable.value))) throw new ToolError({ code: 'UNSUPPORTED_GRAPH_VARIABLE', status: 422, message: 'Observed graph variable does not match the requested finite type.' });
        observations++;
        if (variable.value === condition.value) return { matched: true as const, observations, graphUuid: condition.graphUuid, variable: { name: condition.name, type: condition.type, value: variable.value }, writes: false as const };
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
}
