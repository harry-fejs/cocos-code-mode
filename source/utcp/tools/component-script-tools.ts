import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { invalidateAfterWrite } from '../utils/memo-cache';
import { assertComponentScriptInput, COMPONENT_PROPERTY_TYPES, REQUIRED_COMPONENT_TYPES, generateComponentScriptSource, preflightComponentScriptPath, readComponentScriptSource } from '../../component-script-source';
import type { ComponentPropertyDescriptor, RequiredComponentType } from '../../component-script-source';

export interface ScriptComponentCreateInput {
    assetUrl: string;
    className: string;
    properties?: ComponentPropertyDescriptor[];
    requiredComponents?: RequiredComponentType[];
    disallowMultiple?: boolean;
    menu?: string;
    executionOrder?: number;
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
            requiredComponents: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: [...REQUIRED_COMPONENT_TYPES] }, description: 'Native @requireComponent dependencies only. Creator applies them when the script is later attached; this tool never attaches components.' },
            disallowMultiple: { type: 'boolean', description: 'Native class multiplicity declaration, enforced by Creator on later attachment. No scene mutation or runtime singleton guarantee.' },
            menu: { type: 'string', minLength: 1, maxLength: 256, description: 'Nonblank native Add Component menu path; escaped source metadata only.' },
            executionOrder: { type: 'integer', minimum: -2147483648, maximum: 2147483647, description: 'Native lifecycle priority declaration; does not invoke callbacks or enable edit-mode execution.' },
            properties: {
                type: 'array', maxItems: 64,
                items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
                        type: { type: 'string', enum: [...COMPONENT_PROPERTY_TYPES], description: 'Typed serialized data or native asset/component reference. UI/playback references start null (scalar) or empty (array); assign separately in Inspector. No lookup, component construction, event binding or gameplay execution.' },
                        array: { type: 'boolean', description: 'Serialize an array instead of a scalar; defaults to false.' },
                        tooltip: { type: 'string', maxLength: 1024, description: 'Native Inspector field guidance only; escaped as data, no expression execution. Empty string supported.' },
                        displayName: { type: 'string', maxLength: 256, description: 'Escaped native Inspector label only; does not rename the serialized field identifier. Empty string supported.' },
                        group: { type: 'string', minLength: 1, maxLength: 256, description: 'Nonblank native Inspector group label only; serialized identifiers and runtime behavior stay unchanged.' },
                        visible: { type: 'boolean', description: 'Native Inspector visibility only; field remains serialized.' },
                        readOnly: { type: 'boolean', description: 'Native Inspector readonly metadata only, not TypeScript readonly or runtime immutability.' },
                        displayOrder: { type: 'number', description: 'Finite native Inspector display order; source field order and serialized identifiers unchanged.' },
                        multiline: { type: 'boolean', description: 'Scalar string Inspector editing only; preserves content and serialization, no localization or runtime binding.' },
                        formerlySerializedAs: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'Native prior serialized field name; must be unique and disjoint from current fields. Metadata only, no scene/prefab migration execution or persistence proof.' },
                        serializable: { type: 'boolean', description: 'Native property serialization option. False marks transient data; incompatible with formerlySerializedAs. Omitted retains Creator default. No persistence proof.' },
                        editorOnly: { type: 'boolean', description: 'Native property editorOnly metadata, not executeInEditMode. Does not prove build stripping or prevent runtime field initialization.' },
                        range: { type: 'object', additionalProperties: false, properties: { slider: { type: 'boolean', description: 'Native Inspector slide option; true requires min < max, not a runtime clamp.' }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number', exclusiveMinimum: 0 } }, required: ['min', 'max'], description: 'Scalar number/integer Inspector bounds only; default must be inside inclusive range. Integer fields require safe integer bounds/step. No runtime clamp or step-grid inference.' },
                        entries: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }, value: { type: 'integer', minimum: 0, maximum: 2147483647 } }, required: ['name', 'value'] }, description: 'Scalar enum only: unique labels/values and explicit default selecting one entry. No automatic -1 or bitmask semantics.' },
                        default: { anyOf: [{ type: 'object', additionalProperties: false, properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } }, required: ['x', 'y', 'z', 'w'] }, { type: 'number' }, { type: 'string', maxLength: 4096 }, { type: 'boolean' }, { type: 'null' }, { type: 'object', additionalProperties: false, properties: { r: { type: 'integer', minimum: 0, maximum: 255 }, g: { type: 'integer', minimum: 0, maximum: 255 }, b: { type: 'integer', minimum: 0, maximum: 255 }, a: { type: 'integer', minimum: 0, maximum: 255 } }, required: ['r', 'g', 'b', 'a'] }, { type: 'array', maxItems: 256, items: { anyOf: [{ type: 'object', additionalProperties: false, properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, w: { type: 'number' } }, required: ['x', 'y', 'z', 'w'] }, { type: 'object', additionalProperties: false, properties: { r: { type: 'integer', minimum: 0, maximum: 255 }, g: { type: 'integer', minimum: 0, maximum: 255 }, b: { type: 'integer', minimum: 0, maximum: 255 }, a: { type: 'integer', minimum: 0, maximum: 255 } }, required: ['r', 'g', 'b', 'a'] }, { type: 'number' }, { type: 'string', maxLength: 4096 }, { type: 'boolean' }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }] } }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, { type: 'object', additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] }], description: 'Must match the property type. Size uses exact finite width/height, Rect exact finite x/y/width/height, scalar defaults zero; no dimension normalization or layout writes. integer uses native CCInteger, requires safe integer scalar/array defaults and emits TypeScript number. Scalar Color requires exact RGBA integer bytes 0..255; omitted Color is opaque white; Color arrays require the same exact RGBA bytes. Quat requires exact finite xyzw, omitted scalar is identity (0,0,0,1); no normalization or node rotation assignment. Quat arrays use native instances. Vec4 requires exact finite xyzw with scalar zero default; Vec2/Vec3 require exact finite coordinates and scalar defaults are zero vectors; references permit only null. array=true supports dense primitive/vector/Color defaults or empty reference arrays, at most 256 entries; omitted array defaults are empty.' },
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
        assertComponentScriptInput(args, ['assetUrl', 'className', 'menu', 'executionOrder', 'disallowMultiple', 'requiredComponents', 'properties', 'write']);
        if (typeof args.write !== 'boolean') throw new ToolError({ code: 'WRITE_CONTRACT_REQUIRED', status: 400, message: 'write must be an explicit boolean; only write=true permits creating a new source.' });
        const write = args.write;
        const generated = generateComponentScriptSource({ className: args.className, ...(args.menu === undefined ? {} : { menu: args.menu }), ...(args.executionOrder === undefined ? {} : { executionOrder: args.executionOrder }), ...(args.disallowMultiple === undefined ? {} : { disallowMultiple: args.disallowMultiple }), ...(args.requiredComponents === undefined ? {} : { requiredComponents: args.requiredComponents }), ...(args.properties === undefined ? {} : { properties: args.properties }) });
        const source = await preflightComponentScriptPath(args.assetUrl);
        const result: ScriptComponentCreateResult = { assetUrl: source.assetUrl, ...generated, sourceCreated: false, uuid: null, classRegistration: 'unknown', attached: false, runtimeVerified: false, sceneSaved: false };
        if (!write) return result;
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
