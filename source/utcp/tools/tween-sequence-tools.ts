import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { invalidateAfterWrite } from '../utils/memo-cache';
import { generateTweenCode, inspectTweenCode, normalizeTweenModel, requireTweenModel, tweenDiagnostic, tweenDuration, TweenDiagnostic, TweenSequenceModel } from '../utils/tween-sequence-model';
import { queryTweenAsset, readTweenSource, refuseTweenConflict, resolveTweenPath } from '../utils/tween-sequence-source';
import { executeGameViewOperation } from '../utils/game-view-transport';
import { createTweenRuntimeSource, TweenControlOperation, TweenRuntimeReply, TweenRuntimeRequest } from '../utils/game-view-tween';
import { RuntimeSessionTools } from './runtime-session-tools';
import { TweenControlOutputSchema, TweenCreateOutputSchema, TweenInspectionSchema, TweenPathSchema, TweenSequenceSchema, TweenSourceSchema, TweenValidationSchema } from '../utils/tween-sequence-schema';

type TweenSourceInput = { filePath?: string; sequence?: unknown };
interface TweenInspection {
    representation: 'project-code'; nativeAsset: false; inspectable: boolean;
    sequence?: TweenSequenceModel; durationSeconds?: number; diagnostics: TweenDiagnostic[];
    source: Record<string, unknown>; targetBinding: string;
    runtime: { status: 'not-requested' | 'unavailable' | 'verified'; code?: string; message: string };
}
function assertTweenInput(input: unknown, allowed: string[]): asserts input is Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Unsupported tween tool input fields.' });
}
function inspection(result: { model?: TweenSequenceModel; diagnostics: TweenDiagnostic[] }, source: Record<string, unknown>): TweenInspection {
    return {
        representation: 'project-code', nativeAsset: false, inspectable: !!result.model,
        ...(result.model ? { sequence: result.model, durationSeconds: tweenDuration(result.model) } : {}), diagnostics: result.diagnostics, source,
        targetBinding: 'Assign the generated component target in the Inspector; descriptor identity is static authoring intent, not runtime binding evidence.',
        runtime: { status: 'not-requested', message: 'No project code was executed. Compilation, playback and runtime target binding are not proven by static inspection.' },
    };
}
async function checkTarget(model: TweenSequenceModel): Promise<TweenDiagnostic[]> {
    let node: unknown;
    try { node = await Editor.Message.request('scene', 'query-node', model.target.id); }
    catch { return [tweenDiagnostic('TARGET_QUERY_FAILED', 'sequence.target.id', 'Creator scene target query failed; reference validity is unconfirmed.')]; }
    if (!node) return [tweenDiagnostic('MISSING_TARGET', 'sequence.target.id', 'Declared target was not found in the currently open scene.')];
    const value = typeof node === 'object' ? (node as Record<string, unknown>).uuid : undefined;
    const id = value && typeof value === 'object' ? (value as Record<string, unknown>).value : value;
    if (id !== model.target.id) return [tweenDiagnostic('TARGET_IDENTITY_MISMATCH', 'sequence.target.id', 'Creator did not confirm the exact declared node identity.')];
    return [];
}

export class TweenSequenceTools {
    @utcpTool('tweenSequenceCreate', 'Create new project-owned Creator 3.7 TypeScript from a bounded tween descriptor. Explicit write=true; no overwrite, rename, native tween asset, runtime execution or automatic component attachment. Assign the generated target property in the Inspector.', {
        type: 'object', additionalProperties: false, properties: { filePath: TweenPathSchema, sequence: TweenSequenceSchema, write: { type: 'boolean', enum: [true] } }, required: ['filePath', 'sequence', 'write'],
    }, TweenCreateOutputSchema, 'POST', ['tween', 'project-code', 'create', 'static'])
    async tweenSequenceCreate(args: { filePath: string; sequence: unknown; write: true }): Promise<TweenInspection & { created: boolean; bytesWritten: number }> {
        assertTweenInput(args, ['filePath', 'sequence', 'write']);
        if (args.write !== true) throw new ToolError({ code: 'WRITE_CONTRACT_REQUIRED', status: 400, message: 'Creation requires explicit write=true and creates exactly one new TypeScript source through Asset DB.' });
        const model = requireTweenModel(args.sequence);
        const source = resolveTweenPath(args.filePath);
        refuseTweenConflict(source, await queryTweenAsset(source.url));
        const issues = await checkTarget(model);
        if (issues.length) throw new ToolError({ code: issues[0].code, status: issues[0].code === 'MISSING_TARGET' ? 404 : 502, message: issues[0].message, details: { diagnostics: issues } });
        const code = generateTweenCode(model);
        // Repeat preflight immediately before dispatch; Creator also enforces no-overwrite/no-rename.
        refuseTweenConflict(source, await queryTweenAsset(source.url));
        let created: unknown;
        try { created = await Editor.Message.request('asset-db', 'create-asset', source.url, code, { overwrite: false, rename: false }); }
        catch {
            refuseTweenConflict(source, await queryTweenAsset(source.url));
            throw new ToolError({ code: 'TWEEN_SOURCE_CREATE_FAILED', status: 502, message: 'Asset DB rejected tween source creation; no success is claimed.' });
        }
        if (!created || typeof created !== 'object' || !(created as Record<string, unknown>).uuid) {
            refuseTweenConflict(source, await queryTweenAsset(source.url));
            throw new ToolError({ code: 'TWEEN_SOURCE_CREATE_FAILED', status: 502, message: 'Asset DB did not acknowledge tween source creation.' });
        }
        invalidateAfterWrite();
        const readBack = await readTweenSource(source);
        if (readBack.identity.uuid !== (created as Record<string, unknown>).uuid || readBack.code !== code) throw new ToolError({ code: 'TWEEN_SOURCE_READBACK_MISMATCH', status: 502, message: 'Asset DB/source read-back did not match the requested generated tween. Source may exist; inspect it before retrying.', details: { filePath: args.filePath } });
        return { ...inspection(inspectTweenCode(readBack.code), readBack.identity), created: true, bytesWritten: readBack.identity.bytes };
    }

    @utcpTool('tweenSequenceInspect', 'Inspect an explicit descriptor or exact canonical ccp3x-tween-v1 project TypeScript path without executing source. Arbitrary or edited code is unsupported; no native sequence/runtime state is inferred.', TweenSourceSchema, TweenInspectionSchema, 'GET', ['tween', 'project-code', 'inspect', 'static'])
    async tweenSequenceInspect(args: TweenSourceInput): Promise<TweenInspection> {
        assertTweenInput(args, ['filePath', 'sequence']);
        if (Object.prototype.hasOwnProperty.call(args, 'filePath') === Object.prototype.hasOwnProperty.call(args, 'sequence')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exactly one of filePath or sequence.' });
        if (Object.prototype.hasOwnProperty.call(args, 'sequence')) {
            const result = normalizeTweenModel(args.sequence);
            if (result.model) generateTweenCode(result.model);
            return inspection(result, { kind: 'descriptor' });
        }


        const readBack = await readTweenSource(resolveTweenPath(args.filePath));
        return inspection(inspectTweenCode(readBack.code), readBack.identity);
    }
    @utcpTool('tweenSequenceControl', 'Control one bounded canonical tween descriptor on an attached Creator 3.7.3 Game View runtime. The operation is limited to the exact session, sequence and runtime node; no project source is executed.', {
        type: 'object', additionalProperties: false,
        properties: {
            operation: { type: 'string', enum: ['start', 'pause', 'resume', 'stop', 'inspect'] },
            sessionId: { type: 'string', minLength: 1, maxLength: 64 },
            filePath: TweenPathSchema, sequence: TweenSequenceSchema,
            timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 },
        }, required: ['operation', 'sessionId'],
    }, TweenControlOutputSchema, 'POST', ['tween', 'runtime', 'game-view', 'control'])
    async tweenSequenceControl(args: { operation: TweenControlOperation; sessionId: string; filePath?: string; sequence?: unknown; timeoutMs?: number }): Promise<unknown> {
        assertTweenInput(args, ['operation', 'sessionId', 'filePath', 'sequence', 'timeoutMs']);
        if (!['start', 'pause', 'resume', 'stop', 'inspect'].includes(args.operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Unsupported tween control operation.' });
        if (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A bounded runtime sessionId is required.' });
        if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 10000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'timeoutMs must be an integer from 100 to 10000.' });
        const sourceArgs: TweenSourceInput = Object.prototype.hasOwnProperty.call(args, 'filePath') ? { filePath: args.filePath } : { sequence: args.sequence };
        if (Object.prototype.hasOwnProperty.call(args, 'filePath') === Object.prototype.hasOwnProperty.call(args, 'sequence')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exactly one of filePath or sequence.' });
        const inspected = await this.tweenSequenceInspect(sourceArgs);
        if (!inspected.sequence || inspected.diagnostics.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Only a valid canonical tween descriptor can be controlled.', details: { diagnostics: inspected.diagnostics } });
        const sessionResult = await new RuntimeSessionTools().runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs: args.timeoutMs });
        const sessionValue = sessionResult.session;
        if (!sessionValue || !('targetKind' in sessionValue) || sessionValue.targetKind !== 'game-view' || sessionValue.status !== 'attached') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Tween control requires an attached Game View runtime session.' });
        const session = sessionValue;
        const request: TweenRuntimeRequest = { operation: args.operation, sessionId: session.sessionId, sessionCreatedAt: session.createdAt, sceneUuid: session.targetId, model: inspected.sequence };
        const operationSource = createTweenRuntimeSource(request);
        const reply = await executeGameViewOperation(session.targetId, operationSource, args.timeoutMs ?? 5000, args.operation !== 'inspect');
        const result = reply as TweenRuntimeReply;
        if ('error' in result) throw new ToolError({ code: result.error.code, status: 409, message: result.error.message, details: { sessionId: session.sessionId, sequenceId: inspected.sequence.id, runtime: true } });
        return { success: true, operation: args.operation, session: { sessionId: session.sessionId, targetId: session.targetId }, runtime: result.state, static: { valid: true, source: inspected.source, diagnostics: inspected.diagnostics } };
    }

    @utcpTool('tweenSequenceValidate', 'Read-only static tween descriptor/canonical-code diagnostics and optional attached Game View runtime binding diagnostics. Runtime validation never executes project source.', {
        ...TweenSourceSchema, properties: { ...TweenSourceSchema.properties, runtime: { type: 'boolean' }, sessionId: { type: 'string', minLength: 1, maxLength: 64 } },
    }, TweenValidationSchema, 'GET', ['tween', 'project-code', 'validate', 'static', 'runtime'])
    async tweenSequenceValidate(args: TweenSourceInput & { runtime?: boolean; sessionId?: string }): Promise<TweenInspection & { valid: boolean; static: { valid: boolean; diagnostics: TweenDiagnostic[]; targetChecked: boolean; generatedCode: 'canonical' | 'unsupported'; compilation: 'not-run' }; runtimeBinding?: unknown }> {
        assertTweenInput(args, ['filePath', 'sequence', 'runtime', 'sessionId']);
        if (args.runtime !== undefined && typeof args.runtime !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'runtime must be a boolean when provided.' });
        if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 64)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sessionId must be a bounded runtime session identifier.' });
        const sourceArgs: TweenSourceInput = Object.prototype.hasOwnProperty.call(args, 'filePath') ? { filePath: args.filePath } : { sequence: args.sequence };
        if (Object.prototype.hasOwnProperty.call(args, 'filePath') === Object.prototype.hasOwnProperty.call(args, 'sequence')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exactly one of filePath or sequence.' });
        const result = await this.tweenSequenceInspect(sourceArgs);
        const issues = [...result.diagnostics];
        if (result.sequence && !(args.runtime === true && args.sessionId)) issues.push(...await checkTarget(result.sequence));
        const staticValid = !!result.sequence && issues.length === 0;
        let runtimeBinding: unknown;
        if (args.runtime === true) {
            if (!args.sessionId) runtimeBinding = { status: 'unavailable', code: 'RUNTIME_UNAVAILABLE', message: 'Runtime validation requires an attached sessionId; static validation was still performed and no runtime evidence was collected.' };
            else if (!staticValid) runtimeBinding = { status: 'unavailable', code: 'STATIC_INVALID', message: 'Runtime validation was not attempted because static descriptor validation failed.' };
            else {
                const control = await this.tweenSequenceControl({ operation: 'inspect', sessionId: args.sessionId, sequence: result.sequence });
                if (!control || typeof control !== 'object' || !('runtime' in control)) throw new ToolError({ code: 'RUNTIME_DIAGNOSTICS_UNAVAILABLE', status: 409, message: 'Runtime inspect returned no binding diagnostics.' });
                runtimeBinding = control.runtime;
            }
            result.runtime = args.sessionId && runtimeBinding && typeof runtimeBinding === 'object' && 'nodeId' in runtimeBinding
                ? { status: 'verified', code: 'RUNTIME_BINDING_VERIFIED', message: 'Actual Game View binding verified separately; source compilation and generated Inspector component remain unproven.' }
                : { status: 'unavailable', code: 'RUNTIME_UNAVAILABLE', message: 'An attached Game View session and valid canonical descriptor are required for runtime binding diagnostics.' };
        }
        const runtimeValid = runtimeBinding !== null && typeof runtimeBinding === 'object' && 'nodeId' in runtimeBinding && result.sequence !== undefined && runtimeBinding.nodeId === result.sequence.target.id && 'status' in runtimeBinding && runtimeBinding.status !== 'invalidated';
        return { ...result, ...(runtimeBinding === undefined ? {} : { runtimeBinding }), valid: staticValid && (args.runtime !== true || runtimeValid), static: { valid: staticValid, diagnostics: issues, targetChecked: !!result.sequence && !(args.runtime === true && args.sessionId) && !issues.some(issue => issue.code === 'TARGET_QUERY_FAILED' || issue.code === 'TARGET_IDENTITY_MISMATCH'), generatedCode: result.inspectable ? 'canonical' : 'unsupported', compilation: 'not-run' } };
    }
}
