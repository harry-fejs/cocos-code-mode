import { JsonSchema } from '@utcp/sdk';
import { SuccessIndicatorSchema, ISuccessIndicator } from '../schemas';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { buildBuildPresetAudit, BuildPresetAuditResult } from '../../build-preset-audit';
import { BUILD_SETTING_RULES, BuildProfileArgs, BuildSettingsArgs, BuildTemplateArgs, createBuildTemplate, manageBuildProfiles, manageBuildSettings } from '../build-profiles';
// Slim view of a build task for agent consumption (full IBuildTaskItemJSON is huge)
interface IBuildTaskSummary {
    id: string;
    progress: number;
    state: string;
    message?: string;
    time?: string;
    stage?: string;
    dirty?: boolean;
    name?: string;
    platform?: string;
    buildPath?: string;
}
interface BuildDiagnostic {
    message: string;
    severity?: string;
    code?: string;
    file?: string;
    line?: number;
}

interface BuildLogInspectResult {
    available: boolean;
    terminal: boolean;
    state: string;
    progress: number;
    task: IBuildTaskSummary;
    entries: BuildDiagnostic[];
    count: number;
    truncated: boolean;
}

function normalizeSeverity(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const severity = value.trim().toLowerCase();
    return severity === 'warn' ? 'warning' : severity;
}

function normalizeDiagnosticLine(value: string): BuildDiagnostic {
    const text = value.trim();
    let message = text;
    let file: string | undefined;
    let line: number | undefined;
    const location = text.match(/^(.*?)(?:\((\d+)(?:,\d+)?\)|:(\d+)(?::\d+)?):\s*(.*)$/);
    if (location) {
        file = location[1].trim() || undefined;
        line = Number(location[2] || location[3]);
        message = location[4].trim();
    }
    const severityMatch = message.match(/^(error|warning|warn|info|debug)\b\s*:?\s*/i);
    const severity = normalizeSeverity(severityMatch?.[1]);
    if (severityMatch) message = message.slice(severityMatch[0].length).trim();
    const codeMatch = message.match(/^(?:\[([A-Za-z][\w.-]*)\]|([A-Z][A-Z0-9_.-]{1,31}))\s*:?\s*/);
    const code = (codeMatch?.[1] || codeMatch?.[2])?.trim() || undefined;
    if (codeMatch) message = message.slice(codeMatch[0].length).trim();
    const validLine = typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : undefined;
    return {
        message,
        ...(severity ? { severity } : {}),
        ...(code ? { code } : {}),
        ...(file ? { file } : {}),
        ...(validLine !== undefined ? { line: validLine } : {}),
    };
}

export function normalizeBuildDiagnostic(value: unknown): BuildDiagnostic | null {
    if (typeof value === 'string') {
        const line = normalizeDiagnosticLine(value);
        return line.message ? line : null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const text = [item.message, item.text, item.detailMessage, item.value].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    if (!text) return null;
    const parsed = normalizeDiagnosticLine(text);
    const severity = normalizeSeverity(item.severity ?? item.level ?? item.type) || parsed.severity;
    const code = typeof item.code === 'string' && item.code.trim() ? item.code.trim() : parsed.code;
    const fileValue = item.file ?? item.path ?? item.filename;
    const file = typeof fileValue === 'string' && fileValue.trim() ? fileValue.trim() : parsed.file;
    const lineValue = typeof item.line === 'number' ? item.line : typeof item.line === 'string' ? Number(item.line) : parsed.line;
    const validLine = typeof lineValue === 'number' && Number.isInteger(lineValue) && lineValue > 0 ? lineValue : undefined;
    return {
        message: parsed.message,
        ...(severity ? { severity } : {}),
        ...(code ? { code } : {}),
        ...(file ? { file } : {}),
        ...(validLine !== undefined ? { line: validLine } : {}),
    };
}

function* normalizeBuildDiagnostics(raw: unknown): Generator<BuildDiagnostic> {
    if (Array.isArray(raw)) {
        for (const value of raw) {
            const entry = normalizeBuildDiagnostic(value);
            if (entry) yield entry;
        }
    } else if (typeof raw === 'string') {
        const lines = /[^\n]+/g;
        let match: RegExpExecArray | null;
        while ((match = lines.exec(raw)) !== null) {
            const entry = normalizeBuildDiagnostic(match[0]);
            if (entry) yield entry;
        }
    }
}

function boundedBuildLog(task: IBuildTaskSummary, raw: unknown, maxEntries: number, maxBytes: number): BuildLogInspectResult {
    const result: BuildLogInspectResult = {
        available: Array.isArray(raw) || typeof raw === 'string',
        terminal: BUILD_TERMINAL_STATES[task.state.toLowerCase()] === true,
        state: task.state,
        progress: task.progress,
        task: { id: task.id, progress: task.progress, state: task.state },
        entries: [],
        count: 0,
        truncated: false,
    };
    let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    // true is one byte shorter than false; only omitted data may set truncated.
    if (bytes - 1 > maxBytes) throw new ToolError({
        code: 'BUILD_LOG_RESPONSE_TOO_LARGE',
        status: 422,
        message: 'The required build task identity and state exceed maxBytes.',
        details: { maxBytes },
        recovery: 'Increase maxBytes within its supported range.',
    });
    const markTruncated = () => {
        if (!result.truncated) {
            result.truncated = true;
            bytes--;
        }
    };
    const optionalKeys = ['message', 'time', 'stage', 'dirty', 'name', 'platform', 'buildPath'] as const;
    for (const key of optionalKeys) {
        const value = task[key];
        if (value === undefined) continue;
        if (typeof value !== (key === 'dirty' ? 'boolean' : 'string')) {
            markTruncated();
            continue;
        }
        // Replace the fragment's braces with the comma joining the existing task.
        const extraBytes = Buffer.byteLength(JSON.stringify({ [key]: value }), 'utf8') - 1;
        if (bytes + extraBytes > maxBytes) {
            markTruncated();
            continue;
        }
        Object.assign(result.task, { [key]: value });
        bytes += extraBytes;
    }
    for (const entry of normalizeBuildDiagnostics(raw)) {
        if (result.count >= maxEntries) {
            markTruncated();
            break;
        }
        const nextCount = result.count + 1;
        const extraBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
            + (result.count ? 1 : 0) + String(nextCount).length - String(result.count).length;
        if (bytes + extraBytes > maxBytes) {
            markTruncated();
            break;
        }
        result.entries.push(entry);
        result.count = nextCount;
        bytes += extraBytes;
    }
    if (bytes > maxBytes) throw new ToolError({
        code: 'BUILD_LOG_RESPONSE_TOO_LARGE',
        status: 422,
        message: 'The required build task identity and state exceed maxBytes.',
        details: { maxBytes },
        recovery: 'Increase maxBytes within its supported range.',
    });
    return result;
}

const BUILD_LOG_DEFAULT_ENTRIES = 64;
const BUILD_LOG_MAX_ENTRIES = 256;
const BUILD_LOG_DEFAULT_BYTES = 512 * 1024;
const BUILD_LOG_MAX_BYTES = 2 * 1024 * 1024;

const BuildTaskSummarySchema: JsonSchema = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        progress: { type: 'number' },
        state: { type: 'string' },
        message: { type: 'string' },
        time: { type: 'string' },
        stage: { type: 'string' },
        dirty: { type: 'boolean' },
        name: { type: 'string' },
        platform: { type: 'string' },
        buildPath: { type: 'string' }
    },
    required: ['id', 'progress', 'state']
};
const BUILD_TERMINAL_STATES: Record<string, true> = { success: true, succeeded: true, failed: true, failure: true, error: true, cancelled: true, canceled: true, cancel: true, done: true, finished: true };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function slimTask(task: any): IBuildTaskSummary {
    return {
        id: task.id,
        progress: task.progress,
        state: task.state,
        message: task.message,
        time: task.time,
        stage: task.stage,
        dirty: task.dirty,
        name: task.options?.name || task.options?.taskName,
        platform: task.options?.platform,
        buildPath: task.options?.buildPath
    };
}

export class BuildTools {
    @utcpTool('buildTemplate', 'List/create options-only debug/release templates for web-mobile, web-desktop, Android, iOS, Windows and macOS. Requires real scene UUID/URLs and native package IDs. Never writes settings, triggers builds or claims toolchain/signing readiness. Save generated options via buildProfileManage if needed.', {
        type: 'object', additionalProperties: false,
        properties: { operation: { type: 'string', enum: ['list', 'create'] }, platform: { type: 'string', enum: ['web-mobile', 'web-desktop', 'android', 'ios', 'windows', 'mac'] }, mode: { type: 'string', enum: ['debug', 'release'], default: 'debug' }, name: { type: 'string', minLength: 1, maxLength: 64 }, scenes: { type: 'array', minItems: 1, maxItems: 512, items: { type: 'object', additionalProperties: false, properties: { uuid: { type: 'string' }, url: { type: 'string' } }, required: ['uuid', 'url'] } }, startScene: { type: 'string' }, packageName: { type: 'string', maxLength: 256 }, orientation: { type: 'string', enum: ['auto', 'portrait', 'landscape'] }, buildPath: { type: 'string', maxLength: 512 }, remoteServerAddress: { type: 'string', maxLength: 2048 } }, required: ['operation'],
        allOf: [{ if: { properties: { operation: { const: 'create' } } }, then: { required: ['platform', 'name', 'scenes'] } }],
    }, { type: 'object', properties: { options: { type: 'object' }, platforms: { type: 'array', items: { type: 'string' } }, modes: { type: 'array', items: { type: 'string' } }, writes: { type: 'boolean' }, readiness: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } } }, required: ['writes'] }, 'POST', ['build', 'template', 'config'])
    async buildTemplate(args: BuildTemplateArgs) { return createBuildTemplate(args); }

    @utcpTool('buildSettingsManage', 'Read/write allowlisted Creator builder editor preferences via Profile API. Defaults and cache settings only; does not modify existing task options, trigger builds, configure SDK/NDK or store credentials. Writes verify read-back and restore on failure.', {
        type: 'object', additionalProperties: false,
        properties: { operation: { type: 'string', enum: ['get', 'set'] }, key: { type: 'string', enum: Object.keys(BUILD_SETTING_RULES) }, value: { type: ['string', 'boolean'] }, scope: { type: 'string', enum: ['local', 'global'], default: 'local' } },
        required: ['operation'], allOf: [{ if: { properties: { operation: { const: 'set' } } }, then: { required: ['key', 'value'] } }],
    }, { type: 'object', properties: { scope: { type: 'string' }, settings: { type: 'object' }, success: { type: 'boolean' }, key: { type: 'string' }, value: {}, affectsExistingTasks: { type: 'boolean' } }, required: ['scope', 'affectsExistingTasks'] }, 'POST', ['build', 'settings', 'profile'])
    async buildSettingsManage(args: BuildSettingsArgs) { return manageBuildSettings(args); }

    @utcpTool('buildProfileManage', 'List/get/save/delete reusable cocos-pilot-owned project build profiles. Not Creator task history or a native build preset asset. Validates with buildPresetAudit, refuses credential fields, verifies persistence and rollback. Max 32 profiles / 32KiB each. Does not trigger builds; get options then explicitly call buildManage trigger.', {
        type: 'object', additionalProperties: false,
        properties: { operation: { type: 'string', enum: ['list', 'get', 'save', 'delete'] }, name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, options: { type: 'object', maxProperties: 64 } },
        required: ['operation'], allOf: [{ if: { properties: { operation: { enum: ['get', 'save', 'delete'] } } }, then: { required: ['name'] } }, { if: { properties: { operation: { const: 'save' } } }, then: { required: ['options'] } }],
    }, { type: 'object', properties: { profiles: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, storage: { type: 'string' }, name: { type: 'string' }, options: { type: 'object' }, success: { type: 'boolean' }, operation: { type: 'string' } } }, 'POST', ['build', 'preset', 'profile'])
    async buildProfileManage(args: BuildProfileArgs) { return manageBuildProfiles(args); }

    @utcpTool('buildPresetAudit', 'Audit a bounded build preset against a public target profile without dispatching or mutating a build task.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            platform: { type: 'string', minLength: 1, maxLength: 32 },
            options: { type: 'object', maxProperties: 64, additionalProperties: true },
        },
        required: ['platform', 'options'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            platform: { type: 'string' },
            supportedOptions: { type: 'array', items: { type: 'string' } },
            unsupportedOptions: { type: 'array', items: { type: 'string' } },
            unknownOptions: { type: 'array', items: { type: 'string' } },
            errors: { type: 'array', items: { type: 'object' } },
            warnings: { type: 'array', items: { type: 'object' } },
            valid: { type: 'boolean' },
            complete: { type: 'boolean' },
        },
        required: ['platform', 'supportedOptions', 'unsupportedOptions', 'unknownOptions', 'errors', 'warnings', 'valid', 'complete'],
    }, 'POST', ['build', 'preset', 'audit', 'read-only'])
    async buildPresetAudit(args: { platform: string, options: Record<string, unknown> }): Promise<BuildPresetAuditResult> {
        return buildBuildPresetAudit(args.platform, args.options);
    }

    /** @deprecated Use buildManage({ operation: 'panel_open' }) — not registered, kept for delegation */
    async buildPanelOpen(args: { panel?: string }): Promise<ISuccessIndicator> {
        const panel = args.panel === 'build-bundle' ? 'build-bundle' : 'default';
        await Editor.Message.request('builder', 'open', panel);
        return { success: true };
    }

    /** @deprecated Use buildManage({ operation: 'tasks_info' }) — not registered, kept for delegation */
    async buildGetTasksInfo(args: { limit?: number } = {}): Promise<{ workerReady: boolean, free: boolean, tasks: IBuildTaskSummary[], total: number, truncated: boolean }> {
        const workerReady = await Editor.Message.request('builder', 'query-worker-ready');
        const info = await Editor.Message.request('builder', 'query-tasks-info');
        const queue = (info && info.queue) || {};
        const tasks = Object.values(queue).map((task: any) => slimTask(task));
        const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);
        return { workerReady: !!workerReady, free: !!(info && info.free), tasks: tasks.slice(0, limit), total: tasks.length, truncated: tasks.length > limit };
    }

    /** @deprecated Use buildManage({ operation: 'get_task' }) — not registered, kept for delegation */
    async buildGetTask(args: { taskId: string }): Promise<{ task: IBuildTaskSummary, options?: any }> {
        if (!args.taskId) {
            throw new Error('buildGetTask requires taskId');
        }
        const item = await Editor.Message.request('builder', 'query-task', args.taskId);
        if (!item) {
            throw new Error(`Build task ${args.taskId} not found`);
        }
        return { task: slimTask(item), options: item.options || undefined };
    }

    /** @deprecated Use buildManage({ operation: 'trigger' }) — not registered, kept for delegation */
    async buildTrigger(args: { options: any }): Promise<{ success: boolean, taskId?: string }> {
        if (!args.options || typeof args.options !== 'object') {
            throw new Error('buildTrigger requires an options object (copy it from buildGetTask and modify)');
        }
        if (!args.options.platform) {
            throw new Error('options.platform is required (e.g. web-mobile)');
        }
        const result = await Editor.Message.request('builder', 'add-task', args.options);
        const taskId = typeof result === 'string' ? result : ((result && (result as any).id) || undefined);
        if (!taskId) throw new Error(`builder add-task returned no task id (got ${JSON.stringify(result ?? null)})`);
        return { success: true, taskId };
    }

    /** @deprecated Use buildManage({ operation: 'control' }) — not registered, kept for delegation */
    async buildTaskControl(args: { operation: string, taskId: string }): Promise<ISuccessIndicator> {
        if (!args.taskId) {
            throw new Error('buildTaskControl requires taskId');
        }
        const messageByOperation: Record<string, string> = {
            break: 'break-task',
            remove: 'remove-task',
            recompile: 'recompile-task'
        };
        const message = messageByOperation[args.operation];
        if (!message) {
            throw new Error(`Unknown build task operation: ${args.operation}`);
        }
        await Editor.Message.request('builder', message, args.taskId);
        return { success: true };
    }
    @utcpTool('buildTaskWait', 'Wait boundedly for one build task to reach a terminal state.', {
        type: 'object',
        properties: { taskId: { type: ['string', 'integer'] }, timeoutMs: { type: 'integer', minimum: 0, maximum: 120000, default: 30000 }, pollMs: { type: 'integer', minimum: 50, maximum: 5000, default: 500 } },
        required: ['taskId'],
    }, { type: 'object', properties: { completed: { type: 'boolean' }, timedOut: { type: 'boolean' }, task: { type: 'object' } }, required: ['completed', 'timedOut', 'task'] }, 'GET', ['build', 'task', 'wait', 'poll'])
    async buildTaskWait(args: { taskId: string | number, timeoutMs?: number, pollMs?: number }): Promise<{ completed: boolean, timedOut: boolean, task: IBuildTaskSummary }> {
        const taskId = String(args.taskId ?? '');
        if (!taskId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'buildTaskWait requires taskId', recovery: 'Provide a Creator builder task id.' });
        const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 30000, 0), 120000);
        const pollMs = Math.min(Math.max(args.pollMs ?? 500, 50), 5000);
        const deadline = Date.now() + timeoutMs;
        let item: any;
        do {
            item = await Editor.Message.request('builder', 'query-task', taskId);
            if (!item) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Build task ${taskId} not found`, recovery: 'Query build tasks and retry with an existing task id.' });
            const task = slimTask(item);
            if (BUILD_TERMINAL_STATES[String(task.state).toLowerCase()] === true) return { completed: true, timedOut: false, task };
            if (Date.now() >= deadline) return { completed: false, timedOut: true, task };
            await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        } while (true);
    }
    @utcpTool('buildLogInspect', 'Inspect bounded structured diagnostics exposed by one Creator build task.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            taskId: { type: ['string', 'integer'] },
            maxEntries: { type: 'integer', minimum: 1, maximum: BUILD_LOG_MAX_ENTRIES, default: BUILD_LOG_DEFAULT_ENTRIES },
            maxBytes: { type: 'integer', minimum: 256, maximum: BUILD_LOG_MAX_BYTES, default: BUILD_LOG_DEFAULT_BYTES, description: 'Maximum UTF-8 bytes of the entire serialized successful response, including task metadata. Oversized optional fields and diagnostics are omitted with truncated=true; required identity/state that cannot fit causes a typed error.' },
        },
        required: ['taskId'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            available: { type: 'boolean' },
            terminal: { type: 'boolean' },
            state: { type: 'string' },
            progress: { type: 'number' },
            task: BuildTaskSummarySchema,
            entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { message: { type: 'string' }, severity: { type: 'string' }, code: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' } }, required: ['message'] } },
            count: { type: 'integer' },
            truncated: { type: 'boolean' },
        },
        required: ['available', 'terminal', 'state', 'progress', 'task', 'entries', 'count', 'truncated'],
    }, 'GET', ['build', 'log', 'diagnostics', 'inspect'])
    async buildLogInspect(args: { taskId: string | number, maxEntries?: number, maxBytes?: number }): Promise<BuildLogInspectResult> {
        const taskId = String(args.taskId ?? '');
        if (!taskId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'buildLogInspect requires taskId', recovery: 'Provide a Creator builder task id.' });
        const maxEntries = args.maxEntries === undefined ? BUILD_LOG_DEFAULT_ENTRIES : args.maxEntries;
        const maxBytes = args.maxBytes === undefined ? BUILD_LOG_DEFAULT_BYTES : args.maxBytes;
        if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > BUILD_LOG_MAX_ENTRIES ||
            !Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > BUILD_LOG_MAX_BYTES) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'maxEntries and maxBytes must be integers within their supported ranges.',
                recovery: `Use maxEntries from 1 to ${BUILD_LOG_MAX_ENTRIES} and maxBytes from 256 to ${BUILD_LOG_MAX_BYTES}.`,
            });
        }
        let item: unknown;
        try {
            item = await Editor.Message.request('builder', 'query-task', taskId);
        } catch (error: unknown) {
            throw new ToolError({
                code: 'BUILD_TASK_QUERY_FAILED',
                status: 502,
                message: `Failed to query build task ${taskId}.`,
                details: { cause: error instanceof Error ? error.message : String(error) },
                recovery: 'Retry after the Creator builder is ready.',
            });
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Build task ${taskId} not found`, recovery: 'Query build tasks and retry with an existing task id.' });
        const taskData = item as Record<string, unknown>;
        const task = slimTask(taskData);
        if (typeof task.id !== 'string' || !task.id || typeof task.state !== 'string' || !task.state ||
            typeof task.progress !== 'number' || !Number.isFinite(task.progress)) {
            throw new ToolError({ code: 'BUILD_TASK_INVALID_RESPONSE', status: 502, message: `Build task ${taskId} returned an invalid summary.`, recovery: 'Retry after the Creator builder returns a complete task record.' });
        }
        const rawCandidates = [taskData.logs, taskData.log, taskData.output, taskData.diagnostics, taskData.detailMessage];
        const raw = rawCandidates.find((candidate) => Array.isArray(candidate) || typeof candidate === 'string');
        return boundedBuildLog(task, raw, maxEntries, maxBytes);
    }
}
