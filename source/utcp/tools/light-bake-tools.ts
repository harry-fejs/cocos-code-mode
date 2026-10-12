import { JsonSchema } from '@utcp/sdk';
import { manageNativeProbeBake, NativeProbeBakeResult } from '../native-probe-bake';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';

export interface LightBakeManageArgs {
    operation: 'start' | 'inspect' | 'cancel';
    sceneUuid?: string;
    jobId?: string;
}

const outputSchema: JsonSchema = {
    type: 'object', maxProperties: 64,
    properties: {
        jobId: { type: 'string', minLength: 1, maxLength: 64 },
        status: { type: 'string', enum: ['running', 'completed', 'cancelled', 'failed', 'indeterminate'] },
        sceneUuid: { type: 'string', minLength: 1, maxLength: 256 },
        startedAt: { type: 'integer', minimum: 0 }, updatedAt: { type: 'integer', minimum: 0 },
        finishedAt: { type: ['integer', 'null'], minimum: 0 },
        outputPath: { type: 'string', maxLength: 4096 }, probeCount: { type: 'integer', minimum: 0, maximum: 256 },
        processId: { type: ['integer', 'null'], minimum: 1 },
        native: {
            type: 'object', additionalProperties: false,
            properties: {
                started: { type: 'boolean' }, finished: { type: 'boolean' }, error: { type: 'boolean' },
                processOpen: { type: 'boolean' }, timerOpen: { type: 'boolean' }, serverOpen: { type: 'boolean' },
            }, required: ['started', 'finished', 'error', 'processOpen', 'timerOpen', 'serverOpen'],
        },
        verification: {
            type: 'object', additionalProperties: false,
            properties: {
                outputFile: { type: 'boolean' }, topologyUnchanged: { type: 'boolean' },
                coefficientsFinite: { type: 'boolean' }, coefficientsChanged: { type: 'boolean' },
            }, required: ['outputFile', 'topologyUnchanged', 'coefficientsFinite', 'coefficientsChanged'],
        },
        reason: { type: ['string', 'null'], maxLength: 4096 },
    },
    required: ['jobId', 'status', 'sceneUuid', 'startedAt', 'updatedAt', 'finishedAt', 'outputPath', 'probeCount', 'processId', 'native', 'verification', 'reason'],
};

export class LightBakeTools {
    @utcpTool('lightBakeManage', 'Start, inspect or cancel an owned native Creator 3.8.8 light-probe spherical-harmonic (SH) bake in the exact current edit scene. Supports at most 256 finite noncoplanar probes and bounded scene GI settings. Start requires sceneUuid; inspect/cancel require the returned jobId. Cancellation never targets foreign jobs. Native end broadcasts alone do not prove completion; inspect verifies owned native state, output and nine finite SH coefficients per probe. No caller JavaScript or output path, texture-lightmap bake, scene save or save/reopen persistence proof.', {
        type: 'object', additionalProperties: false,
        properties: {
            operation: { type: 'string', enum: ['start', 'inspect', 'cancel'] },
            sceneUuid: { type: 'string', minLength: 1, maxLength: 256, description: 'Required for start; must match the exact currently open edit scene UUID.' },
            jobId: { type: 'string', minLength: 1, maxLength: 64, description: 'Required for inspect/cancel; exact adapter-owned job ID returned by start.' },
        },
        required: ['operation'],
        oneOf: [
            { properties: { operation: { const: 'start' } }, required: ['sceneUuid'], not: { required: ['jobId'] } },
            { properties: { operation: { enum: ['inspect', 'cancel'] } }, required: ['jobId'], not: { required: ['sceneUuid'] } },
        ],
    }, outputSchema, 'POST', ['light', 'bake', 'probe', 'native', 'lifecycle'])
    async lightBakeManage(args: LightBakeManageArgs): Promise<NativeProbeBakeResult> {
        const invalid = (message: string): never => { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); };
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['operation', 'sceneUuid', 'jobId'].includes(key))) invalid('Only operation, sceneUuid and jobId are supported.');
        if (!['start', 'inspect', 'cancel'].includes(args.operation)) invalid('operation must be start, inspect or cancel.');
        if (args.operation === 'start') {
            if (typeof args.sceneUuid !== 'string' || !args.sceneUuid.trim() || args.sceneUuid.length > 256 || args.jobId !== undefined) invalid('start requires sceneUuid (1..256 characters) and does not accept jobId.');
        } else if (typeof args.jobId !== 'string' || !args.jobId.trim() || args.jobId.length > 64 || args.sceneUuid !== undefined) invalid('inspect/cancel require jobId (1..64 characters) and do not accept sceneUuid.');
        return manageNativeProbeBake(args);
    }
}
