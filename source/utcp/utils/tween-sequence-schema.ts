import { JsonSchema } from '@utcp/sdk';
import { TWEEN_EASINGS } from './tween-sequence-model';

const vector: JsonSchema = { type: 'object', additionalProperties: false, properties: { x: { type: 'number', minimum: -1000000, maximum: 1000000 }, y: { type: 'number', minimum: -1000000, maximum: 1000000 }, z: { type: 'number', minimum: -1000000, maximum: 1000000 } }, required: ['x', 'y', 'z'] };
export const TweenSequenceSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        version: { type: 'integer', enum: [1] }, id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$', maxLength: 64 },
        target: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$', maxLength: 128 }, type: { type: 'string', enum: ['cc.Node'] } }, required: ['id', 'type'] },
        steps: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: [
            { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['delay'] }, duration: { type: 'number', exclusiveMinimum: 0, maximum: 600 } }, required: ['kind', 'duration'] },
            { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['to', 'by'] }, duration: { type: 'number', exclusiveMinimum: 0, maximum: 600 }, easing: { type: 'string', enum: [...TWEEN_EASINGS] }, properties: { type: 'object', additionalProperties: false, minProperties: 1, properties: { position: vector, scale: vector, eulerAngles: vector } } }, required: ['kind', 'duration', 'easing', 'properties'] },
        ] } },
        lifecycle: { type: 'object', additionalProperties: false, properties: { start: { type: 'string', enum: ['manual', 'on-enable'] }, stop: { type: 'string', enum: ['on-disable', 'on-destroy'] }, repeat: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['start', 'stop', 'repeat'] },
    }, required: ['version', 'id', 'target', 'steps', 'lifecycle'],
};
export const TweenPathSchema: JsonSchema = { type: 'string', minLength: 1, maxLength: 512, description: 'Exact project-relative assets/.../*.ts path. Existing parent directory required; no overwrite, rename, native asset or traversal.' };
export const TweenSourceSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: { filePath: TweenPathSchema, sequence: TweenSequenceSchema },
    oneOf: [{ required: ['filePath'] }, { required: ['sequence'] }],
};
const diagnostics: JsonSchema = { type: 'array', items: { type: 'object', additionalProperties: false, properties: { code: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'path', 'message'] } };
export const TweenInspectionSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        representation: { type: 'string', enum: ['project-code'] }, nativeAsset: { type: 'boolean', enum: [false] }, inspectable: { type: 'boolean' },
        sequence: TweenSequenceSchema, durationSeconds: { type: 'number' }, diagnostics,
        source: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['descriptor', 'typescript'] }, filePath: { type: 'string' }, assetUrl: { type: 'string' }, uuid: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' }, descriptorLine: { type: 'integer' } }, required: ['kind'] },
        targetBinding: { type: 'string', enum: ['Assign the generated component target in the Inspector; descriptor identity is static authoring intent, not runtime binding evidence.'] },
        runtime: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['not-requested', 'unavailable'] }, code: { type: 'string' }, message: { type: 'string' } }, required: ['status', 'message'] },
    }, required: ['representation', 'nativeAsset', 'inspectable', 'diagnostics', 'source', 'targetBinding', 'runtime'],
};
export const TweenCreateOutputSchema: JsonSchema = { ...TweenInspectionSchema, properties: { ...TweenInspectionSchema.properties, created: { type: 'boolean' }, bytesWritten: { type: 'integer' } }, required: [...TweenInspectionSchema.required as string[], 'created', 'bytesWritten'] };
export const TweenValidationSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: { ...TweenInspectionSchema.properties, valid: { type: 'boolean' }, static: { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, diagnostics, targetChecked: { type: 'boolean' }, generatedCode: { type: 'string', enum: ['canonical', 'unsupported'] }, compilation: { type: 'string', enum: ['not-run'] } }, required: ['valid', 'diagnostics', 'targetChecked', 'generatedCode', 'compilation'] } },
    required: [...TweenInspectionSchema.required as string[], 'valid', 'static'],
};
