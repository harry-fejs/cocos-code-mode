import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { invalidateAfterWrite } from '../utils/memo-cache';
import { assertComponentScriptInput, COMPONENT_PROPERTY_TYPES, generateComponentScriptSource, preflightComponentScriptPath, readComponentScriptSource } from '../../component-script-source';
import type { ComponentPropertyDescriptor } from '../../component-script-source';

export interface ScriptComponentCreateInput {
    assetUrl: string;
    className: string;
    properties?: ComponentPropertyDescriptor[];
    write: boolean;
}
export interface ScriptComponentCreateResult {
    assetUrl: string;
    className: string;
    source: string;
    sha256: string;
    bytes: number;
    sourceCreated: boolean;
    uuid: string | null;
    classRegistration: 'unknown' | 'pending';
    attached: false;
    runtimeVerified: false;
    sceneSaved: false;
}

export class ComponentScriptTools {
    @utcpTool('scriptComponentCreate', 'Generate a project-owned Creator 3.7 data component with bounded typed serialized properties. write=false previews source only; write=true creates one new explicit db://assets/.../*.ts source via Asset DB with no overwrite or rename. Requires an existing project-owned parent. No gameplay, lifecycle stubs, arbitrary code/imports, execution or automatic attachment. Source read-back does not prove compilation or class registration.', {
        type: 'object', additionalProperties: false,
        properties: {
            assetUrl: { type: 'string', maxLength: 512, pattern: '^db://assets/(?:[A-Za-z0-9_-]+/)*[A-Za-z][A-Za-z0-9_-]*\\.ts$' },
            className: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
            properties: {
                type: 'array', maxItems: 64,
                items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
                        type: { type: 'string', enum: [...COMPONENT_PROPERTY_TYPES] },
                        array: { type: 'boolean', description: 'Serialize an array instead of a scalar; defaults to false.' },
                        default: { anyOf: [{ type: 'number' }, { type: 'string', maxLength: 4096 }, { type: 'boolean' }, { type: 'null' }, { type: 'array', maxItems: 256, items: { anyOf: [{ type: 'number' }, { type: 'string', maxLength: 4096 }, { type: 'boolean' }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }] } }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }], description: 'Must match the property type. Vec2/Vec3 require exact finite coordinates and scalar defaults are zero vectors; references permit only null. array=true supports dense primitive/vector defaults or empty reference arrays, at most 256 entries; omitted array defaults are empty.' },
                    }, required: ['name', 'type'],
                },
            },
            write: { type: 'boolean', description: 'Explicit false previews without mutation; only explicit true permits creation.' },
        }, required: ['assetUrl', 'className', 'write'],
    }, {
        type: 'object', additionalProperties: false,
        properties: {
            assetUrl: { type: 'string' }, className: { type: 'string' }, source: { type: 'string' }, sha256: { type: 'string' }, bytes: { type: 'integer' },
            sourceCreated: { type: 'boolean' }, uuid: { anyOf: [{ type: 'string' }, { type: 'null' }] }, classRegistration: { type: 'string', enum: ['unknown', 'pending'] },
            attached: { type: 'boolean', enum: [false] }, runtimeVerified: { type: 'boolean', enum: [false] }, sceneSaved: { type: 'boolean', enum: [false] },
        }, required: ['assetUrl', 'className', 'source', 'sha256', 'bytes', 'sourceCreated', 'uuid', 'classRegistration', 'attached', 'runtimeVerified', 'sceneSaved'],
    }, 'POST', ['script', 'component', 'project-code', 'create', 'static'])
    async scriptComponentCreate(args: ScriptComponentCreateInput): Promise<ScriptComponentCreateResult> {
        assertComponentScriptInput(args, ['assetUrl', 'className', 'properties', 'write']);
        if (typeof args.write !== 'boolean') throw new ToolError({ code: 'WRITE_CONTRACT_REQUIRED', status: 400, message: 'write must be an explicit boolean; only write=true permits creating a new source.' });
        const generated = generateComponentScriptSource({ className: args.className, ...(args.properties === undefined ? {} : { properties: args.properties }) });
        const source = await preflightComponentScriptPath(args.assetUrl);
        const result: ScriptComponentCreateResult = { assetUrl: source.assetUrl, ...generated, sourceCreated: false, uuid: null, classRegistration: 'unknown', attached: false, runtimeVerified: false, sceneSaved: false };
        if (!args.write) return result;
        let created: unknown;
        try { created = await Editor.Message.request('asset-db', 'create-asset', source.assetUrl, generated.source, { overwrite: false, rename: false }); }
        catch {
            invalidateAfterWrite();
            throw new ToolError({ code: 'SOURCE_CREATE_OUTCOME_UNKNOWN', status: 502, message: 'Asset DB creation did not return a confirmed outcome. Source may exist; inspect the exact path before any further action. No retry or deletion was attempted.', details: { assetUrl: source.assetUrl, expectedSha256: generated.sha256, sourceCreated: null, classRegistration: 'unknown', attached: false, runtimeVerified: false, sceneSaved: false } });
        }
        invalidateAfterWrite();
        if (!created || typeof created !== 'object' || !('uuid' in created) || typeof created.uuid !== 'string' || !created.uuid) throw new ToolError({ code: 'SOURCE_CREATE_OUTCOME_UNKNOWN', status: 502, message: 'Asset DB did not acknowledge source identity. Source may exist; no retry or deletion was attempted.', details: { assetUrl: source.assetUrl, expectedSha256: generated.sha256, sourceCreated: null, classRegistration: 'unknown', attached: false, runtimeVerified: false, sceneSaved: false } });
        await readComponentScriptSource(source, created.uuid, generated);
        return { ...result, sourceCreated: true, uuid: created.uuid, classRegistration: 'pending' };
    }
}
