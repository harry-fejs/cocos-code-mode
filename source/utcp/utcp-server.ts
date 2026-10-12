import { randomBytes } from 'crypto';
import { debugEnabled, isCreatorLogVisible, setDebugLogging, CreatorLogGroup } from './logging-policy';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { ToolRegistry } from './decorators';
import './tools/typescript-defenition';
import './tools/get-properties-tool';
import './tools/set-properties-tool';
import './tools/asset-tools';
import './tools/component-tools';
import './tools/scene-tools';
import './tools/editor-tools';
import { EditorHandshakeTools } from './tools/editor-handshake-tools';
import { resetEditorMessageProbes } from './editor-state';
import { SessionPresenceStore } from './session-presence';
import { SessionTools } from './tools/session-tools';
import { RequestActivityStore } from './request-activity';
import './tools/project-tools';
import './tools/preview-start-scene-tools';
import './tools/preview-tools';
import './tools/property-array-tools';
import './tools/material-tools';
import './tools/consolidated-tools';
import './tools/build-tools';
import './execute/execute-tool';
import './tools/diagnostics-tools';
import './tools/file-tools';
import './tools/ui-tools';
import './tools/runtime-tools';
import './tools/runtime-session-tools';
import './tools/audio-playback-tools';
import './tools/component-runtime-tools';
import './tools/screenshot-tools';
import './tools/batch-tools';
import './tools/batch-read-tools';
import './tools/validation-tools';
import './tools/scene-snapshot-tools';
import './tools/event-tools';
import './tools/prefab-json-tools';
import './tools/instruction-tools';
import './tools/preference-tools';
import './tools/input-tools';
import './tools/advanced-capability-tools';
import './tools/tilemap-create-tools';
import './tools/expansion-tools';
import './tools/portfolio-completion-tools';
import './tools/portfolio-validation-tools';
import './tools/p4-contract-tools';
import './tools/artifact-server-tools';
import './tools/asset-bundle-runtime-tools';
import './tools/graph-tools';
import './tools/tween-sequence-tools';
import './tools/light-bake-tools';
import { registerAllImporters } from './utils/asset-importers';
import { slimOutputsSchema } from './utils/schema-slimmer';
import { trimResponse } from './utils/response-trimmer';
import { JsonSchema, Tool, UtcpManual } from '@utcp/sdk';
import { parse } from 'qs';
import { getBuildInfo } from '../build-info';
import { readFileSync } from 'fs';
import { isToolExposed, ToolProfile } from './tool-profiles';
import { appendJsonl, createDebugLogFile, getDebugLogDirectory, listDebugLogFiles } from './log-path';
import { createResultEnvelope } from './response-envelope';
import { ToolError, toToolErrorResponse } from './tool-error';
import { formatInteractionHeadline, renderInteraction, snapshotInteraction } from './interaction-log';
const handshakeStates: Record<string, string> = Object.create(null);

function handshakeState(entry: Record<string, unknown>): string | null {
    if (entry.tool !== 'editorHandshake' || entry.phase !== 'complete') return null;
    const result = entry.result && typeof entry.result === 'object' ? entry.result as Record<string, unknown> : null;
    const probe = result?.probe && typeof result.probe === 'object' ? result.probe as Record<string, unknown> : null;
    const status = typeof probe?.status === 'string' ? probe.status : 'unknown';
    return status === 'responsive' && result?.projectMatches === false ? 'identity-mismatch' : status;
}

function shouldShowHandshake(entry: Record<string, unknown>): boolean {
    const state = handshakeState(entry);
    if (state === null) return true;
    const result = entry.result as Record<string, unknown>;
    const key = `${typeof result.instanceId === 'string' ? result.instanceId : 'unknown'}\u0000${typeof result.projectPath === 'string' ? result.projectPath : ''}`;
    const previous = handshakeStates[key];
    handshakeStates[key] = state;
    return previous !== state;
}


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
export function shouldLogToolError(error: unknown): boolean {
    return !(error instanceof ToolError && error.status < 500);
}

export function expectedTestWitnessId(headers: Record<string, unknown>): string | undefined {
    if (headers['x-ccp-expected-error'] !== 'true') return undefined;
    const id = headers['x-ccp-test-id'];
    return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : undefined;
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

// Console output is intentionally concise; JSONL keeps the complete structured event.
let debugLogFile: string | null = null;

function activateDebugLog(instanceId: string): string | null {
    try {
        return createDebugLogFile(getDebugLogDirectory(instanceId), 'utcp', instanceId);
    } catch {
        return null;
    }
}



export function formatInteractionSummary(entry: Record<string, unknown>): string {
    const safe = snapshotInteraction(entry);
    const headline = formatInteractionHeadline(safe);
    if (safe.phase === 'complete' && safe.tier === 'summary') delete safe.result;
    const rendered = renderInteraction(safe, headline);
    return rendered.text + (rendered.truncated ? '\n[truncated: display budget; additional detail may also be bounded]' : '')
        + (typeof entry.detailFile === 'string' ? `\nDetails file: ${entry.detailFile}` : '');
}

export function creatorInteractionLog(entry: Record<string, unknown>): void {
    const phase = entry.phase;
    const message = formatInteractionSummary(entry);
    const consoleWriter = console[phase === 'error' ? 'error' : phase === 'warning' ? 'warn' : 'info'];
    try {
        // Write through the standard console so Creator's Console panel renders the
        // verbose lifecycle line, and retain Editor.info/warn/error for versions that
        // route extension messages through the editor logger.
        if (typeof consoleWriter === 'function') consoleWriter(message);
        const editor = (globalThis as {
            Editor?: Partial<Record<'info' | 'warn' | 'error', (message: string) => void>>
        }).Editor;
        const level = phase === 'error' ? 'error' : phase === 'warning' ? 'warn' : 'info';
        if (editor && typeof editor[level] === 'function') editor[level](message);
    } catch {
        // Creator logging must never change the HTTP result or tool lifecycle.
    }
}

function interactionLog(entry: Record<string, unknown>, group: CreatorLogGroup = 'read'): void {
    const phase = entry.phase;
    if (!debugEnabled && phase !== 'warning' && phase !== 'error') return;
    const safe = snapshotInteraction({ ...entry, ts: new Date().toISOString() });
    if (debugLogFile) {
        try {
            appendJsonl(debugLogFile, { type: 'interaction', ...safe });
            safe.detailFile = debugLogFile;
        } catch {
            safe.recovery = `${safe.recovery ?? ''}\nLog detail file unavailable; check filesystem permissions.`;
        }
    } else {
        safe.recovery = `${safe.recovery ?? ''}\nLog detail file unavailable; check filesystem permissions.`;
    }
    if (isCreatorLogVisible(phase, group) && shouldShowHandshake(safe)) creatorInteractionLog({ ...safe, tier: phase === 'complete' && isCreatorLogVisible('trace', group) ? 'trace' : 'summary' });
}

function debugLog(entry: Record<string, unknown>): void {
    if (!debugEnabled || !debugLogFile) return;
    try { appendJsonl(debugLogFile, snapshotInteraction({ ts: new Date().toISOString(), ...entry })); } catch {}
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
    console.log(`[cx3][config] Profile set to '${profile}', envelope=${envelope}, enabled=${enabled.length}, disabled=${disabled.length}`);
}

export class UtcpServerManager {
    private app: express.Application;
    private server: any;
    private logDirectory: string | null = null;
    private logFile: string | null = null;
    // Resolved port after start(); used by unload to GC the config entry.
    public port: number = 0;
    public instanceId: string = '';
    public sessionPresence = new SessionPresenceStore('not-started');
    public requestActivity = new RequestActivityStore();

    constructor() {
        this.app = express();
        registerAllImporters();
    }

    async start(port: number = 0): Promise<number> {
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new RangeError('Port must be an integer between 0 and 65535 (0 = auto).');
        }
        if (this.server) throw new Error('UTCP Server is already started. Stop it before starting again.');
        this.app = express();
        this.instanceId = randomBytes(16).toString('hex');
        this.logDirectory = getDebugLogDirectory(this.instanceId);
        this.logFile = activateDebugLog(this.instanceId);
        debugLogFile = this.logFile;
        this.sessionPresence = new SessionPresenceStore(this.instanceId);
        this.requestActivity.clear();
        // PHAI set TRUOC moi app.use(): express bind 'query parser fn' luc lazyrouter
        // chay (o use() dau tien) va khong doc lai. Set sau -> decoder nay khong bao gio
        // chay, moi arg so/bool ve tay tool duoi dang string.
        this.app.set("query parser", (queryString: string) =>
            parse(queryString, {
                decoder(value, defaultDecoder, charset, type) {
                    const decoded = defaultDecoder(value);

                    if (decoded === "true") return true;
                    if (decoded === "false") return false;

                    if (
                        typeof decoded === "string" &&
                        decoded !== "" &&
                        !Number.isNaN(Number(decoded))
                    ) {
                        return Number(decoded);
                    }

                    if (decoded === "__null__") return null;

                    return decoded;
                }
            })
        );

        this.app.use(cors());
        this.app.use(express.json({ limit: '50mb' }));

        // M1 timing baseline: stamp request start so handlers and clients can
        // measure wall time (via X-Duration-Ms header) before/after batching.
        this.app.use((req: any, _res: any, next: any) => {
            req._t0 = Date.now();
            next();
        });

        const tools = ToolRegistry.getTools();
        const toolInstances = new Map<Function, any>();
        const utcpTools: Tool[] = [];

        let currentPort = port;

        // Let's listen first to get the port if it's 0
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(port, "127.0.0.1", () => {
                const addr = this.server.address();
                if (addr && typeof addr === 'object') {
                    currentPort = addr.port;
                }
                if (isCreatorLogVisible('complete', 'lifecycle')) console.info(`[cx3][api] LISTENING <- http://localhost:${currentPort}/utcp`);
                // Now register tools with the correct port
                this.port = currentPort;
                resetEditorMessageProbes();
                try {
                    this.registerTools(currentPort, tools, toolInstances, utcpTools);
                } catch (error) {
                    this.stop().then(() => reject(error), reject);
                    return;
                }

                const message = `[cx3][lifecycle] CONNECTED <- http://localhost:${currentPort}/utcp`;
                if (isCreatorLogVisible('complete', 'lifecycle')) {
                    console.info(message);
                    const editor = (globalThis as { Editor?: { info?: (message: string) => void } }).Editor;
                    try { editor?.info?.(message); } catch {}
                }
                resolve(currentPort);
            });
            this.server.on('error', (err: any) => {
                if (!this.server?.listening) {
                    this.server = null;
                    this.port = 0;
                }
                const message = `[cx3][lifecycle] CONNECTION_ERROR <- ${err?.message ?? String(err)}`;
                console.error(message);
                const editor = (globalThis as any).Editor;
                try { if (editor && typeof editor.error === 'function') editor.error(message); } catch {}
                reject(err);
            });
        });
    }

    private registerTools(port: number, tools: any[], toolInstances: Map<Function, any>, utcpTools: Tool[]) {
        const baseUrl = `http://localhost:${port}`;

        // Initialize tool instances and build UTCP definitions
        for (const toolMeta of tools) {
            const ToolClass = toolMeta.target.constructor;
            let instance = toolInstances.get(ToolClass);
            if (!instance) {
                instance = ToolClass === EditorHandshakeTools
                    ? new EditorHandshakeTools(this.instanceId)
                    : ToolClass === SessionTools ? new SessionTools(this.sessionPresence) : new ToolClass();
                toolInstances.set(ToolClass, instance);
            }

            const toolDef = JSON.parse(JSON.stringify(toolMeta.tool));
            // ponytail: slim outputs schema to top-level keys only; nested detail is token bloat.
            // Inputs schemas stay intact — Claude needs full param shape to call correctly.
            if (toolDef.outputs) {
                toolDef.outputs = slimOutputsSchema(toolDef.outputs);
            }
            const toolUrlPath = toolDef.tool_call_template.url;

            toolDef.tool_call_template.url = `${baseUrl}${toolUrlPath}`;

            // Profile annotations remain in ToolProfileRegistry. The Code Mode manual parser
            // rejects unknown per-tool fields, so do not expose them in the UTCP manual.

            utcpTools.push(toolDef);

            const handler = async (req: Request, res: Response) => {
                const t0 = Date.now();
                const requestId = randomBytes(16).toString('hex');
                res.setHeader('X-Request-Id', requestId);
                const body: unknown = req.body;
                const args: Record<string, unknown> = {
                    ...req.query,
                    ...(isPlainJsonObject(body) ? body : {}),
                };
                const activityStarted = this.requestActivity.start(requestId, toolDef.name);
                const finishActivity = (outcome: 'completed' | 'failed', status: number) => {
                    if (activityStarted) this.requestActivity.finish(requestId, toolDef.name, outcome, status, t0);
                };
                interactionLog({ phase: 'start', requestId, tool: toolDef.name, method: req.method, path: req.path, args }, toolMeta.logGroup);
                try {
                    // Check profile exposure
                    if (!isToolExposed(toolDef.name, activeProfile, enabledTools, disabledTools)) {
                        const ms = Date.now() - ((req as any)._t0 ?? t0);
                        res.setHeader('X-Duration-Ms', String(ms));
                        interactionLog({ phase: 'error', requestId, tool: toolDef.name, args, status: 404, durationMs: ms, code: 'TOOL_NOT_EXPOSED', message: `Tool '${toolDef.name}' is not exposed by the current profile '${activeProfile}'.` }, toolMeta.logGroup);
                        res.status(404).json({ error: `Tool '${toolDef.name}' is not exposed by the current profile '${activeProfile}'.` });
                        finishActivity('failed', 404);
                        return;
                    }

                    const validationErrors = body === undefined || isPlainJsonObject(body)
                        ? validateSchemaArguments(toolDef.inputs, args)
                        : validateSchemaArguments(toolDef.inputs, body);
                    if (validationErrors.length > 0) {
                        const missingInputs = validationErrors
                            .filter((error) => error.keyword === 'required' && !error.path.includes('.') && !error.path.includes('['))
                            .map((error) => error.path);
                        const plural = missingInputs.length === 1 ? '' : 's';
                        const ms = Date.now() - ((req as any)._t0 ?? t0);
                        res.setHeader('X-Duration-Ms', String(ms));
                        const errorMessage = missingInputs.length > 0
                            ? `Missing required input${plural}: ${missingInputs.join(', ')}`
                            : 'Invalid tool input.';
                        interactionLog({ phase: 'error', requestId, tool: toolDef.name, status: 400, durationMs: ms, code: 'INVALID_TOOL_INPUT', message: errorMessage, args }, toolMeta.logGroup);
                        res.status(400).json({
                            error: errorMessage,
                            ...(missingInputs.length > 0 ? { missingInputs } : {}),
                            validationErrors,
                        });
                        finishActivity('failed', 400);
                        return;
                    }

                    debugLog({
                        requestId,
                        type: 'request',
                        tool: toolDef.name,
                        method: req.method,
                        url: req.originalUrl,
                        args
                    });

                    let result = await toolMeta.method.apply(instance, [args]);

                    if (result === undefined || result === null) {
                        const ms = Date.now() - ((req as any)._t0 ?? t0);
                        interactionLog({ phase: 'complete', requestId, tool: toolDef.name, args, status: 200, durationMs: ms, result: null }, toolMeta.logGroup);
                        debugLog({ type: 'response', requestId, tool: toolDef.name, result: null, size: 0, durationMs: ms });
                        res.json(null);
                        finishActivity('completed', 200);
                        return;
                    }

                    // Log the payload actually sent, only after transformation and serialization succeed.
                    const trimmed = trimResponse(result, toolMeta.tool.outputs);
                    const payload = envelopeEnabled
                        ? createResultEnvelope(toolDef.name, args, trimmed ?? null)
                        : trimmed ?? null;
                    res.json(payload);
                    const ms = Date.now() - t0;
                    interactionLog({ phase: 'complete', requestId, tool: toolDef.name, args, status: 200, durationMs: ms, result: payload }, toolMeta.logGroup);
                    debugLog({ type: 'response', requestId, tool: toolDef.name, result: payload, durationMs: ms });
                    finishActivity('completed', 200);

                } catch (err: any) {
                    const ms2 = Date.now() - ((req as any)._t0 ?? t0);
                    const response = toToolErrorResponse(err);
                    const testId = expectedTestWitnessId(req.headers);
                    const errorMessage = response.body.error;
                    const diagnosticMessage = shouldLogToolError(err) && err instanceof Error
                        ? err.message
                        : errorMessage;
                    interactionLog({
                        phase: 'error',
                        requestId,
                        tool: toolDef.name,
                        status: response.status,
                        durationMs: ms2,
                        code: response.body.code ?? 'UNKNOWN',
                        message: diagnosticMessage,
                        details: response.body.details,
                        recovery: response.body.recovery,
                        testId,
                        args,
                        stack: err instanceof Error ? err.stack : undefined,
                        expectedTest: Boolean(testId && err instanceof ToolError && err.status < 500),
                    }, toolMeta.logGroup);
                    debugLog({
                        type: 'error',
                        requestId,
                        tool: toolDef.name,
                        error: errorMessage,
                        code: response.body.code,
                        details: response.body.details,
                        recovery: response.body.recovery,
                        cause: diagnosticMessage !== errorMessage ? diagnosticMessage : undefined,
                        stack: err instanceof Error ? err.stack : undefined,
                        testId,
                        durationMs: ms2,
                    });
                    res.status(response.status).json(response.body);
                    finishActivity('failed', response.status);
                }
            };


            switch (toolDef.tool_call_template.http_method) {
                case 'POST':
                    this.app.post(toolUrlPath, handler);
                    break;
                case 'GET':
                    this.app.get(toolUrlPath, handler);
                    break;
                case 'DELETE':
                    this.app.delete(toolUrlPath, handler);
                    break;
                case 'PUT':
                    this.app.put(toolUrlPath, handler);
                    break;
                default:
                // throw new Error(`Unsupported HTTP method: ${toolDef.tool_call_template.http_method}`);
            }
        }

        // Serve UTCP Manual
        this.app.get('/utcp', (req, res) => {
            // Filter tools based on active profile
            const filteredTools = utcpTools.filter(t => isToolExposed(t.name, activeProfile, enabledTools, disabledTools));
            const manual: UtcpManual = {
                utcp_version: "1.0.1",
                manual_version: "1.0.0",
                tools: filteredTools
            };
            // Do NOT add fields here. The UTCP SDK validates the manual with a strict
            // schema: an extra key fails registration for EVERY tool, not just itself.
            // Build provenance lives on /build-info below for exactly this reason.
            res.json(manual);
        });

        // Provenance on its own endpoint, out of the manual's strict schema.
        this.app.get('/build-info', (req, res) => {
            res.json(getBuildInfo());
        });

        // Debug logs are scoped to this editor instance and bounded by the logger helper.
        this.app.get('/debug-logs', (req, res) => {
            if (!debugEnabled) {
                res.status(404).json({ error: 'Debug mode not enabled. Toggle via menu or set UTCP_DEBUG=1.' });
                return;
            }
            try {
                const files = listDebugLogFiles(this.logDirectory ?? getDebugLogDirectory(this.instanceId));
                const toolFilter = typeof req.query.tool === 'string' ? req.query.tool : undefined;
                const requested = Number(req.query.last);
                const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 500) : 200;
                const collected: Record<string, unknown>[] = [];
                for (const file of files.slice().reverse()) {
                    if (collected.length >= limit) break;
                    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
                    for (const line of lines) {
                        try {
                            const entry = JSON.parse(line) as Record<string, unknown>;
                            if (!toolFilter || entry.tool === toolFilter) collected.push(entry);
                        } catch {}
                    }
                }
                res.json(collected.slice(-limit));
            } catch (err: any) {
                res.status(500).json({ error: err?.message ?? String(err) });
            }
        });
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (!server) return;

        await new Promise<void>((resolve, reject) => {
            server.close((err?: Error) => {
                this.server = null;
                this.port = 0;
                if (err) reject(err);
                else resolve();
            });
        });
        this.requestActivity.clear();
        if (debugLogFile === this.logFile) debugLogFile = null;
        this.logFile = null;
        this.logDirectory = null;
        const message = '[cx3][lifecycle] DISCONNECTED <- UTCP Server stopped';
        if (isCreatorLogVisible('complete', 'lifecycle')) {
            console.log(message);
            const editor = (globalThis as { Editor?: { info?: (message: string) => void } }).Editor;
            try { editor?.info?.(message); } catch {}
        }
    }

    getDebugEnabled(): boolean {
        return debugEnabled;
    }

    getLogDirectory(): string | null {
        return this.logDirectory;
    }

    getLogFile(): string | null {
        return this.logFile;
    }

    setDebugEnabled(enabled: boolean): boolean {
        setDebugLogging(enabled);
        if (enabled && !this.logFile && this.instanceId) {
            this.logDirectory = getDebugLogDirectory(this.instanceId);
            this.logFile = activateDebugLog(this.instanceId);
            debugLogFile = this.logFile;
        }
        return debugEnabled;
    }

}
