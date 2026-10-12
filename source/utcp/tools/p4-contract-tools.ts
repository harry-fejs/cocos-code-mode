import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { ProjectTools } from './project-tools';
import { executeComponentOperation } from '../utils/game-view-components';

const projectTools = new ProjectTools();

function requireText(value: unknown, name: string, max = 256): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must be a non-empty string of at most ${max} characters.` });
    }
    return value;
}

const PHYSICS_PATHS = new Set(['physics.gravity', 'physics.allowSleep', 'physics.sleepThreshold', 'physics.autoSimulation', 'physics.fixedTimeStep', 'physics.maxSubSteps', 'physics.defaultMaterial', 'physics.collisionGroups', 'physics.collisionMatrix']);
function validatePhysicsSetting(path: string, value: unknown): void {
    if (!PHYSICS_PATHS.has(path) && !/^physics\.(collisionGroups|collisionMatrix)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/.test(path)) throw new ToolError({ code: 'UNSUPPORTED_SETTING', status: 422, message: `Physics setting '${path}' is outside the bounded Creator project settings contract.` });
    if (path === 'physics.gravity') {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !['x', 'y', 'z'].every(key => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, unknown>)[key]))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'physics.gravity requires finite numeric x, y and z.' });
    } else if (['physics.allowSleep', 'physics.autoSimulation'].includes(path) && typeof value !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${path} requires a boolean.` });
    else if (['physics.sleepThreshold', 'physics.fixedTimeStep'].includes(path) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${path} requires a finite number from 0 to 60.` });
    else if (path === 'physics.maxSubSteps' && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 64)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'physics.maxSubSteps requires an integer from 1 to 64.' });
}

export class P4ContractTools {
    @utcpTool('physics2dConfigure', 'Configure bounded 2D physics project settings only when Creator exposes a verified project settings writer, then query and verify the persisted value.', {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, value: {} },
        required: ['path', 'value'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' }, readBack: {} }, required: ['success', 'path', 'readBack'] }, 'POST', ['physics', '2d', 'configure'])
    async physics2dConfigure(args: { path?: string, value?: unknown }): Promise<{ success: boolean, path: string, readBack: unknown }> {
        const path = requireText(args?.path, 'path'); validatePhysicsSetting(path, args?.value);
        return projectTools.projectSetConfig({ path, value: args?.value });
    }

    @utcpTool('physics3dConfigure', 'Configure bounded 3D physics project settings only when Creator exposes a verified project settings writer, then query and verify the persisted value.', {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, value: {} },
        required: ['path', 'value'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' }, readBack: {} }, required: ['success', 'path', 'readBack'] }, 'POST', ['physics', '3d', 'configure'])
    async physics3dConfigure(args: { path?: string, value?: unknown }): Promise<{ success: boolean, path: string, readBack: unknown }> {
        const path = requireText(args?.path, 'path'); validatePhysicsSetting(path, args?.value);
        return projectTools.projectSetConfig({ path, value: args?.value });
    }

    @utcpTool('particlePlayback', 'Control one exact cc.ParticleSystem in the active Game View through finite play, stop, or clear operations with actual state read-back.', {
        type: 'object', additionalProperties: false,
        properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 64 },
            operation: { type: 'string', enum: ['play', 'stop', 'clear'] },
            nodeReference: {
                type: 'object', additionalProperties: false,
                properties: { id: { type: 'string', minLength: 1, maxLength: 256 } },
                required: ['id'],
            },
            componentId: { type: 'string', minLength: 1, maxLength: 256 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 },
        },
        required: ['sessionId', 'operation', 'nodeReference'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, sessionId: { type: 'string' }, targetId: { type: 'string' }, operation: { type: 'string' }, nodeReference: {}, nodeUuid: { type: 'string' }, componentId: { type: 'string' }, state: {} }, required: ['success', 'sessionId', 'targetId', 'operation', 'nodeReference', 'nodeUuid', 'componentId', 'state'] }, 'POST', ['particle', 'playback', 'runtime'])
    async particlePlayback(args: { sessionId?: string, operation?: string, nodeReference?: { id?: string }, componentId?: string, timeoutMs?: number }): Promise<Record<string, unknown>> {
        const sessionId = requireText(args?.sessionId, 'sessionId', 64);
        const nodeId = requireText(args?.nodeReference?.id, 'nodeReference.id');
        if (!['play', 'stop', 'clear'].includes(String(args.operation))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, stop, or clear.' });
        }
        if (args.componentId !== undefined) requireText(args.componentId, 'componentId');
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 3000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'timeoutMs must be an integer from 100 to 3000.' });
        return executeComponentOperation({ kind: 'particle', operation: String(args.operation), sessionId, nodeReference: { id: nodeId }, componentId: args.componentId, timeoutMs: args.timeoutMs ?? 1000 });
    }
}
