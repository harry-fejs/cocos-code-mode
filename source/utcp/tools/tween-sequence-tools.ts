import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { invalidateAfterWrite } from '../utils/memo-cache';
import { generateTweenCode, inspectTweenCode, normalizeTweenModel, requireTweenModel, tweenDiagnostic, tweenDuration, TweenDiagnostic, TweenSequenceModel } from '../utils/tween-sequence-model';
import { queryTweenAsset, readTweenSource, refuseTweenConflict, resolveTweenPath } from '../utils/tween-sequence-source';
import { TweenCreateOutputSchema, TweenInspectionSchema, TweenPathSchema, TweenSequenceSchema, TweenSourceSchema, TweenValidationSchema } from '../utils/tween-sequence-schema';

type TweenSourceInput = { filePath?: string; sequence?: unknown };
interface TweenInspection {
    representation: 'project-code'; nativeAsset: false; inspectable: boolean;
    sequence?: TweenSequenceModel; durationSeconds?: number; diagnostics: TweenDiagnostic[];
    source: Record<string, unknown>; targetBinding: string;
    runtime: { status: 'not-requested' | 'unavailable'; code?: string; message: string };
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

    @utcpTool('tweenSequenceValidate', 'Read-only static tween descriptor/canonical-code diagnostics and current scene target-reference check. Runtime validation is explicitly unavailable; static validity does not prove compilation, Inspector binding or playback.', {
        ...TweenSourceSchema, properties: { ...TweenSourceSchema.properties, runtime: { type: 'boolean', description: 'When true, return RUNTIME_UNAVAILABLE separately; never execute project code.' } },
    }, TweenValidationSchema, 'GET', ['tween', 'project-code', 'validate', 'static'])
    async tweenSequenceValidate(args: TweenSourceInput & { runtime?: boolean }): Promise<TweenInspection & { valid: boolean; static: { valid: boolean; diagnostics: TweenDiagnostic[]; targetChecked: boolean; generatedCode: 'canonical' | 'unsupported'; compilation: 'not-run' } }> {
        assertTweenInput(args, ['filePath', 'sequence', 'runtime']);
        if (args.runtime !== undefined && typeof args.runtime !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'runtime must be a boolean when provided.' });
        const sourceArgs: TweenSourceInput = Object.prototype.hasOwnProperty.call(args, 'filePath') ? { filePath: args.filePath } : { sequence: args.sequence };
        if (Object.prototype.hasOwnProperty.call(args, 'filePath') === Object.prototype.hasOwnProperty.call(args, 'sequence')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide exactly one of filePath or sequence.' });
        const result = await this.tweenSequenceInspect(sourceArgs);
        const issues = [...result.diagnostics];
        if (result.sequence) issues.push(...await checkTarget(result.sequence));
        const staticValid = !!result.sequence && issues.length === 0;
        if (args.runtime === true) result.runtime = { status: 'unavailable', code: 'RUNTIME_UNAVAILABLE', message: 'Tween runtime validation/control is deferred pending an explicit runtime-session contract. No runtime evidence was collected.' };
        return { ...result, valid: staticValid && args.runtime !== true, static: { valid: staticValid, diagnostics: issues, targetChecked: !!result.sequence && !issues.some(issue => issue.code === 'TARGET_QUERY_FAILED' || issue.code === 'TARGET_IDENTITY_MISMATCH'), generatedCode: result.inspectable ? 'canonical' : 'unsupported', compilation: 'not-run' } };
    }
}
