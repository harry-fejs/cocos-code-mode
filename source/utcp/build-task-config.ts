import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { ToolError } from './tool-error';
import { boundedBuildOptions, inspectBuildPreflight } from './build-preflight';

type RecordValue = Record<string, unknown>;
let writing = false;
function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function task(id: string): Promise<RecordValue> {
    const value: unknown = await Editor.Message.request('builder', 'query-task', id);
    if (!record(value) || !record(value.options)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Build task with readable options not found.' });
    return value;
}
export interface BuildTaskConfigArgs { operation: 'get' | 'set'; taskId: string | number; options?: RecordValue; expectedOptionsSha256?: string }
export async function manageBuildTaskConfig(args: BuildTaskConfigArgs) {
    const id = typeof args.taskId === 'number' && Number.isSafeInteger(args.taskId) && args.taskId >= 0 ? String(args.taskId) : args.taskId;
    if (typeof id !== 'string' || !id.length || id.length > 256 || /[\s\x00-\x1f\x7f]/.test(id)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Invalid build task identity.' });
    if (args.operation !== 'get' && args.operation !== 'set') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Unknown task configuration operation.' });
    const before = await task(id);
    const options = boundedBuildOptions(before.options);
    const optionsSha256 = hash(options);
    if (args.operation === 'get') return { taskId: id, options, optionsSha256, writes: false, persisted: false };
    if (!/^[a-f0-9]{64}$/.test(args.expectedOptionsSha256 ?? '') || args.expectedOptionsSha256 !== optionsSha256) throw new ToolError({ code: 'BUILD_TASK_CONFIG_CONFLICT', status: 409, message: 'Task options changed or expected hash is missing.' });
    if (!['success', 'failure', 'cancel', 'cancelled', 'generated'].includes(String(before.state))) throw new ToolError({ code: 'BUILD_TASK_CONFIG_BUSY', status: 409, message: 'Only a terminal build task may be reconfigured.' });
    const next = boundedBuildOptions(args.options);
    if (next.platform !== options.platform) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Task reconfiguration cannot change platform.' });
    const preflight = await inspectBuildPreflight(next);
    if (!preflight.valid) throw new ToolError({ code: 'BUILD_PREFLIGHT_FAILED', status: 422, message: 'Build task options failed preflight.', details: { issues: preflight.issues } });
    if (writing) throw new ToolError({ code: 'BUILD_TASK_CONFIG_BUSY', status: 409, message: 'Another task configuration write is pending.' });
    writing = true;
    try {
        const current = await task(id);
        if (!isDeepStrictEqual(current.options, before.options) || current.state !== before.state) throw new ToolError({ code: 'BUILD_TASK_CONFIG_CONFLICT', status: 409, message: 'Task changed before dispatch.' });
        try {
            await Editor.Message.request('builder', 'update-task' as never, { id, options: next, rawOptions: next, dirty: true } as never);
            if (!isDeepStrictEqual((await task(id)).options, next)) throw new Error('Read-back mismatch');
        } catch {
            try {
                await Editor.Message.request('builder', 'update-task' as never, { id, options: before.options, rawOptions: before.rawOptions, dirty: before.dirty } as never);
                const restored = await task(id);
                if (!isDeepStrictEqual(restored.options, before.options) || !isDeepStrictEqual(restored.rawOptions, before.rawOptions) || restored.dirty !== before.dirty) throw new Error('Restoration mismatch');
            } catch { throw new ToolError({ code: 'BUILD_TASK_CONFIG_ROLLBACK_FAILED', status: 500, message: 'Native task update and restoration could not be confirmed.' }); }
            throw new ToolError({ code: 'BUILD_TASK_CONFIG_WRITE_FAILED', status: 502, message: 'Native task update failed; previous state restored.' });
        }
        return { taskId: id, options: next, optionsSha256: hash(next), writes: true, persisted: false };
    } finally { writing = false; }
}
