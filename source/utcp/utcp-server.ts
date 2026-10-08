import { ToolMetadata, ToolRegistry } from './decorators';
import {
    extractIdempotencyKey, createProjectLocalAuth, LocalAuthContext,
    LOCAL_INSTANCE_HEADER, LOCAL_INSTANCE_VARIABLE, LOCAL_PORT_HEADER, LOCAL_PORT_VARIABLE,
    LOCAL_TOKEN_HEADER, LOCAL_TOKEN_VARIABLE, LOCAL_PROJECT_HEADER, LOCAL_PROJECT_VARIABLE,
} from './local-auth';
import { LocalHttpContext, LocalHttpServer, sendJson } from './http-server';
import { ProtectedRelayHost } from '../protected/relay-host';
import { CcbError, toCcbErrorBody } from '../protected/errors';
import { getConfigManager } from './config-manager';
import { randomUUID } from '../protected/node14-compat';
import { dirname, join } from 'path';
import { REMOVED_CUSTOMER_TOOLS } from '../protected/removed-tools';
import { dispatchProtectedCustomerTool, isProtectedCustomerTool } from '../protected/protected-route';
import './tools/typescript-defenition';
import './tools/get-properties-tool';
import './tools/set-properties-tool';
import './tools/asset-tools';
import './tools/component-tools';
import './tools/scene-tools';
import './tools/editor-tools';
import './tools/build-tools';
import './tools/project-tools';
import './tools/preview-tools';
import './tools/animation-tools';
import './tools/property-array-tools';
import './tools/material-tools';
import './tools/consolidated-tools';
import './tools/file-tools';
import './tools/ui-tools';
import './tools/runtime-tools';
import './tools/batch-tools';
import './tools/batch-read-tools';
import './tools/validation-tools';
import './tools/screenshot-tools';
import './tools/scene-snapshot-tools';
import './tools/event-tools';
import './tools/prefab-json-tools';
import './tools/instruction-tools';
import './tools/preference-tools';
import './tools/input-tools';
import { registerAllImporters } from './utils/asset-importers';
import { slimOutputsSchema } from './utils/schema-slimmer';
import { trimResponse } from './utils/response-trimmer';
import { JsonSchema, Tool, UtcpManual } from '@utcp/sdk';
import { getBuildInfo } from '../build-info';
import { isToolExposed, ToolProfile } from './tool-profiles';
import { createResultEnvelope } from './response-envelope';
import { toToolErrorResponse } from './tool-error';

export interface SchemaValidationError {
    path: string;
    keyword: string;
    message: string;
}

function isPlainJsonObject(value: unknown): value is object {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
    return isPlainJsonObject(value);
}

function schemaKeywordNumber(schema: JsonSchema, keyword: string): number | undefined {
    const value = schema[keyword];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function schemaKeywordSchemas(schema: JsonSchema, keyword: string): JsonSchema[] {
    const value = schema[keyword];
    return Array.isArray(value) ? value.filter(isSchema) : [];
}

function schemaKeywordSchema(schema: JsonSchema, keyword: string): JsonSchema | undefined {
    const value = schema[keyword];
    return isSchema(value) ? value : undefined;
}

function propertyPath(path: string, property: string): string {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)) {
        return path === '$' ? property : `${path}.${property}`;
    }
    return `${path}[${JSON.stringify(property)}]`;
}


function matchesJsonValue(left: unknown, right: unknown): boolean {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => matchesJsonValue(value, right[index]));
    }
    if (isPlainJsonObject(left) && isPlainJsonObject(right)) {
        const leftObject = left as Record<string, unknown>;
        const rightObject = right as Record<string, unknown>;
        const leftKeys = Object.keys(leftObject);
        const rightKeys = Object.keys(rightObject);
        return leftKeys.length === rightKeys.length
            && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightObject, key) && matchesJsonValue(leftObject[key], rightObject[key]));
    }
    return false;
}

function matchesSchemaType(value: unknown, type: string): boolean {
    switch (type) {
        case 'object':
            return isPlainJsonObject(value);
        case 'array':
            return Array.isArray(value);
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'null':
            return value === null;
        default:
            return true;
    }
}

function schemaTypes(schema: JsonSchema): string[] {
    if (typeof schema.type === 'string') {
        return [schema.type];
    }
    return Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === 'string') : [];
}

function validateSchemaValue(schema: JsonSchema, value: unknown, path: string): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];
    const types = schemaTypes(schema);

    if (types.length > 0 && !types.some((type) => matchesSchemaType(value, type))) {
        errors.push({
            path,
            keyword: 'type',
            message: `Expected ${types.join(' or ')}.`,
        });
        return errors;
    }

    if (schema.const !== undefined && !matchesJsonValue(value, schema.const)) {
        errors.push({ path, keyword: 'const', message: 'Must equal the declared constant.' });
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => matchesJsonValue(value, candidate))) {
        errors.push({ path, keyword: 'enum', message: 'Must equal one of the declared values.' });
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const minimum = schemaKeywordNumber(schema, 'minimum');
        const maximum = schemaKeywordNumber(schema, 'maximum');
        if (minimum !== undefined && value < minimum) {
            errors.push({ path, keyword: 'minimum', message: `Must be at least ${minimum}.` });
        }
        if (maximum !== undefined && value > maximum) {
            errors.push({ path, keyword: 'maximum', message: `Must be at most ${maximum}.` });
        }
    }

    if (typeof value === 'string') {
        const minLength = schemaKeywordNumber(schema, 'minLength');
        const maxLength = schemaKeywordNumber(schema, 'maxLength');
        if (minLength !== undefined && value.length < minLength) {
            errors.push({ path, keyword: 'minLength', message: `Must contain at least ${minLength} characters.` });
        }
        if (maxLength !== undefined && value.length > maxLength) {
            errors.push({ path, keyword: 'maxLength', message: `Must contain at most ${maxLength} characters.` });
        }
    }

    if (Array.isArray(value)) {
        const minItems = schemaKeywordNumber(schema, 'minItems');
        const maxItems = schemaKeywordNumber(schema, 'maxItems');
        if (minItems !== undefined && value.length < minItems) {
            errors.push({ path, keyword: 'minItems', message: `Must contain at least ${minItems} items.` });
        }
        if (maxItems !== undefined && value.length > maxItems) {
            errors.push({ path, keyword: 'maxItems', message: `Must contain at most ${maxItems} items.` });
        }
        const itemSchema = schema.items;
        if (isSchema(itemSchema)) {
            value.forEach((item, index) => errors.push(...validateSchemaValue(itemSchema, item, `${path}[${index}]`)));
        } else if (Array.isArray(itemSchema)) {
            itemSchema.forEach((tupleItemSchema, index) => {
                if (isSchema(tupleItemSchema) && index < value.length) {
                    errors.push(...validateSchemaValue(tupleItemSchema, value[index], `${path}[${index}]`));
                }
            });
        }
    }

    if (isPlainJsonObject(value)) {
        const objectValue = value as Record<string, unknown>;
        const required = Array.isArray(schema.required) ? schema.required.filter((property): property is string => typeof property === 'string') : [];
        for (const property of required) {
            if (!Object.prototype.hasOwnProperty.call(objectValue, property) || objectValue[property] === undefined) {
                errors.push({ path: propertyPath(path, property), keyword: 'required', message: 'Required property is missing.' });
            }
        }

        if (isPlainJsonObject(schema.properties)) {
            for (const [property, propertySchema] of Object.entries(schema.properties)) {
                if (Object.prototype.hasOwnProperty.call(objectValue, property) && objectValue[property] !== undefined && isSchema(propertySchema)) {
                    errors.push(...validateSchemaValue(propertySchema, objectValue[property], propertyPath(path, property)));
                }
            }
        }
    }

    for (const variant of schemaKeywordSchemas(schema, 'allOf')) {
        errors.push(...validateSchemaValue(variant, value, path));
    }

    const anyOf = schemaKeywordSchemas(schema, 'anyOf');
    if (anyOf.length > 0 && !anyOf.some((variant) => validateSchemaValue(variant, value, path).length === 0)) {
        errors.push({ path, keyword: 'anyOf', message: 'Value must match at least one schema.' });
    }

    const oneOf = schemaKeywordSchemas(schema, 'oneOf');
    if (oneOf.length > 0 && oneOf.filter((variant) => validateSchemaValue(variant, value, path).length === 0).length !== 1) {
        errors.push({ path, keyword: 'oneOf', message: 'Value must match exactly one schema.' });
    }

    const condition = schemaKeywordSchema(schema, 'if');
    if (condition) {
        const branch = validateSchemaValue(condition, value, path).length === 0
            ? schemaKeywordSchema(schema, 'then')
            : schemaKeywordSchema(schema, 'else');
        if (branch) {
            errors.push(...validateSchemaValue(branch, value, path));
        }
    }

    return errors;
}

export function validateSchemaArguments(schema: JsonSchema, args: unknown): SchemaValidationError[] {
    return validateSchemaValue(schema, args, '$');
}

export function findMissingRequiredInputs(schema: JsonSchema, args: Record<string, unknown>): string[] {
    return validateSchemaArguments(schema, args)
        .filter((error) => error.keyword === 'required' && !error.path.includes('.') && !error.path.includes('['))
        .map((error) => error.path);
}

// Profile config — mutable at runtime via panel.
let activeProfile: ToolProfile = 'full'; // default: expose everything (backward compat)
let enabledTools = new Set<string>();
let disabledTools = new Set<string>();
let envelopeEnabled = false; // default OFF for backward compat

export function getServerProfile(): { profile: ToolProfile, enabled: string[], disabled: string[], envelope: boolean } {
    return { profile: activeProfile, enabled: [...enabledTools], disabled: [...disabledTools], envelope: envelopeEnabled };
}

export function setServerProfile(profile: ToolProfile, enabled: string[] = [], disabled: string[] = [], envelope: boolean = false): void {
    activeProfile = profile;
    enabledTools = new Set(enabled);
    disabledTools = new Set(disabled);
    envelopeEnabled = envelope;
    console.log(`[UTCP] Profile set to '${profile}', envelope=${envelope}, enabled=${enabled.length}, disabled=${disabled.length}`);
}

export class UtcpServerManager {
    private http: LocalHttpServer | null = null;
    public port: number = 0;
    private readonly host?: ProtectedRelayHost;
    private localAuth: LocalAuthContext | null = null;
    constructor(host?: ProtectedRelayHost) {
        this.host = host;
        registerAllImporters();
    }

    async start(port: number = 3000): Promise<number> {
        if (this.http) throw new Error('UTCP Server is already running');
        if (!this.host) throw new CcbError('CCB_GATEWAY_UNAVAILABLE', 'UTCP startup requires a bound protected relay instance.');
        const localAuth = createProjectLocalAuth(Editor.Project.path, randomUUID(), join(dirname(getConfigManager().getConfigPath()), '.cc-bridge', 'local-auth'));
        const http = new LocalHttpServer(localAuth);
        this.http = http;
        try {
            const actualPort = await http.listen(port);
            await getConfigManager().ensureCocosEditorTemplate(actualPort, localAuth, this.host.gatewayContext);
            this.host.relayInstanceId = localAuth.relayInstanceId;
            this.localAuth = localAuth;
            this.port = actualPort;
            this.registerTools(actualPort, ToolRegistry.getTools(), new Map<Function, object>(), []);
            return actualPort;
        } catch (error) {
            if (this.localAuth) await getConfigManager().removeCocosEditorTemplate(this.localAuth).catch(() => undefined);
            await http.close().catch(() => {});
            this.http = null;
            this.localAuth = null;
            throw error;
        }
    }

    private registerTools(port: number, tools: ToolMetadata[], toolInstances: Map<Function, object>, utcpTools: Tool[]): void {
        const http = this.http;
        if (!http) throw new Error('UTCP Server is not running');
        const baseUrl = `http://localhost:${port}`;

        for (const toolMeta of tools) {
            if (REMOVED_CUSTOMER_TOOLS.has(toolMeta.tool.name)) continue;
            const ToolClass = toolMeta.target.constructor;
            let instance = toolInstances.get(ToolClass);
            if (!instance) {
                instance = Reflect.construct(ToolClass, []) as object;
                toolInstances.set(ToolClass, instance);
            }

            const toolDef = JSON.parse(JSON.stringify(toolMeta.tool));
            if (toolDef.outputs) toolDef.outputs = slimOutputsSchema(toolDef.outputs);
            const toolUrlPath = toolDef.tool_call_template.url;
            toolDef.tool_call_template.url = `${baseUrl}${toolUrlPath}`;
            toolDef.tool_call_template.headers = {
                ...(toolDef.tool_call_template.headers || {}),
                [LOCAL_INSTANCE_HEADER]: `\${${LOCAL_INSTANCE_VARIABLE}}`,
                [LOCAL_PORT_HEADER]: `\${${LOCAL_PORT_VARIABLE}}`,
                [LOCAL_PROJECT_HEADER]: `\${${LOCAL_PROJECT_VARIABLE}}`,
            };
            toolDef.tool_call_template.auth = {
                auth_type: 'api_key',
                var_name: LOCAL_TOKEN_HEADER,
                api_key: `\${${LOCAL_TOKEN_VARIABLE}}`,
                location: 'header',
            };
            utcpTools.push(toolDef);

            const handler = async (context: LocalHttpContext): Promise<void> => {
                const { body, query, response, startedAt } = context;
                const duration = () => ({ 'x-duration-ms': String(Date.now() - startedAt) });
                try {
                    if (!isToolExposed(toolDef.name, activeProfile, enabledTools, disabledTools)) {
                        sendJson(response, 404, { error: `Tool '${toolDef.name}' is not exposed by the current profile '${activeProfile}'.` }, duration());
                        return;
                    }
                    const bodyArgs = isPlainJsonObject(body) ? body as Record<string, unknown> : {};
                    const args: Record<string, unknown> = { ...query, ...bodyArgs };
                    const validationErrors = body === undefined || isPlainJsonObject(body)
                        ? validateSchemaArguments(toolDef.inputs, args)
                        : validateSchemaArguments(toolDef.inputs, body);
                    if (validationErrors.length > 0) {
                        const missingInputs = validationErrors
                            .filter((error) => error.keyword === 'required' && !error.path.includes('.') && !error.path.includes('['))
                            .map((error) => error.path);
                        const plural = missingInputs.length === 1 ? '' : 's';
                        sendJson(response, 400, {
                            error: missingInputs.length > 0
                                ? `Missing required input${plural}: ${missingInputs.join(', ')}`
                                : 'Invalid tool input.',
                            ...(missingInputs.length > 0 ? { missingInputs } : {}),
                            validationErrors,
                        }, duration());
                        return;
                    }

                    const result = isProtectedCustomerTool(toolDef.name)
                        ? await this.dispatchProtected(toolDef.name, args, extractIdempotencyKey(context.request))
                        : await toolMeta.method.apply(instance, [args]);
                    const trimmed = result === undefined || result === null ? null : trimResponse(result) ?? null;
                    sendJson(
                        response,
                        200,
                        envelopeEnabled ? createResultEnvelope(toolDef.name, args, trimmed) : trimmed,
                        duration(),
                    );
                } catch (error) {
                    if (error instanceof CcbError) {
                        sendJson(response, 422, toCcbErrorBody(error), duration());
                        return;
                    }
                    console.error(`Error in tool ${toolDef.name}:`, error);
                    const toolError = toToolErrorResponse(error);
                    sendJson(response, toolError.status, toolError.body, duration());
                }
            };

            const method = toolDef.tool_call_template.http_method;
            if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'DELETE') {
                http.route(method, toolUrlPath, handler);
            }
        }

        http.route('GET', '/utcp', ({ response }) => {
            // Profile annotations remain in ToolProfileRegistry.
            // Do NOT add fields here — Code Mode rejects extra manual keys.
            const manual: UtcpManual = {
                utcp_version: '1.0.1',
                manual_version: '1.0.0',
                tools: utcpTools.filter((tool) => isToolExposed(tool.name, activeProfile, enabledTools, disabledTools)),
            };
            sendJson(response, 200, manual);
        });
        http.route('GET', '/build-info', ({ response }) => sendJson(response, 200, getBuildInfo()));
        http.route('GET', '/connection', ({ response }) => sendJson(response, 200, {
            projectPath: this.localAuth?.projectPath, projectId: this.localAuth?.projectId,
            port: this.port, relayInstanceId: this.localAuth?.relayInstanceId,
            gateway: this.host?.gatewayContext,
        }));
    }

    private async dispatchProtected(toolName: string, args: Record<string, unknown>, idempotencyKey?: string): Promise<unknown> {
        if (!this.host) throw new CcbError('CCB_GATEWAY_UNAVAILABLE', 'Protected tools require an active Gateway relay host.');
        return dispatchProtectedCustomerTool(this.host, toolName, args, { idempotencyKey });
    }
    
    getLocalAuthBinding(): Readonly<Pick<LocalAuthContext, 'relayInstanceId' | 'tokenPath' | 'boundPort' | 'projectPath' | 'projectId'>> | null {
        if (!this.localAuth) return null;
        return { relayInstanceId: this.localAuth.relayInstanceId, tokenPath: this.localAuth.tokenPath, boundPort: this.localAuth.boundPort, projectPath: this.localAuth.projectPath, projectId: this.localAuth.projectId };
    }

    beginDrain(): void {
        this.http?.beginDrain();
    }

    async stop(): Promise<void> {
        const http = this.http;
        if (!http) return;
        this.beginDrain();
        await http.close();
        if (this.localAuth) await getConfigManager().removeCocosEditorTemplate(this.localAuth);
        this.http = null;
        this.localAuth = null;
        this.port = 0;
        console.log('UTCP Server stopped');
    }
}
