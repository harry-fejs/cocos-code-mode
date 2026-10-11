import { ToolError } from '../tool-error';

export const MAX_TWEEN_BYTES = 64 * 1024;
export const TWEEN_EASINGS = ['linear', 'quadIn', 'quadOut', 'quadInOut', 'cubicIn', 'cubicOut', 'cubicInOut', 'sineIn', 'sineOut', 'sineInOut'] as const;
export type TweenVector = { x: number; y: number; z: number };
export type TweenStep = { kind: 'delay'; duration: number } | { kind: 'to' | 'by'; duration: number; easing: string; properties: Partial<Record<'position' | 'scale' | 'eulerAngles', TweenVector>> };
export interface TweenSequenceModel {
    version: 1;
    id: string;
    target: { id: string; type: 'cc.Node' };
    steps: TweenStep[];
    lifecycle: { start: 'manual' | 'on-enable'; stop: 'on-disable' | 'on-destroy'; repeat: number };
}
export interface TweenDiagnostic { code: string; path: string; message: string }
export function tweenDiagnostic(code: string, path: string, message: string): TweenDiagnostic { return { code, path, message }; }

export function normalizeTweenModel(input: unknown): { model?: TweenSequenceModel; diagnostics: TweenDiagnostic[] } {
    const diagnostics: TweenDiagnostic[] = [];
    const issue = (path: string, message: string, code = 'INVALID_DESCRIPTOR') => diagnostics.push(tweenDiagnostic(code, path, message));
    const object = (value: unknown, keys: string[], location: string): value is Record<string, unknown> => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { issue(location, 'Expected an object.'); return false; }
        const actual = Object.keys(value);
        if (actual.length > keys.length || actual.some(key => !keys.includes(key))) issue(location, 'Unknown fields are not supported.');
        return true;
    };
    if (!object(input, ['version', 'id', 'target', 'steps', 'lifecycle'], 'sequence')) return { diagnostics };
    if (input.version !== 1) issue('sequence.version', 'Only descriptor version 1 is supported.');
    if (typeof input.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.id)) issue('sequence.id', 'Use 1 to 64 ASCII identifier characters beginning with a letter.');
    if (object(input.target, ['id', 'type'], 'sequence.target')) {
        if (typeof input.target.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.target.id)) issue('sequence.target.id', 'A bounded scene node identity is required.', 'MISSING_TARGET');
        if (input.target.type !== 'cc.Node') issue('sequence.target.type', 'Only cc.Node targets are supported.');
    }
    if (object(input.lifecycle, ['start', 'stop', 'repeat'], 'sequence.lifecycle')) {
        if (input.lifecycle.start !== 'manual' && input.lifecycle.start !== 'on-enable') issue('sequence.lifecycle.start', 'Use manual or on-enable.');
        if (input.lifecycle.stop !== 'on-disable' && input.lifecycle.stop !== 'on-destroy') issue('sequence.lifecycle.stop', 'Use on-disable or on-destroy.');
        if (!Number.isInteger(input.lifecycle.repeat) || (input.lifecycle.repeat as number) < 1 || (input.lifecycle.repeat as number) > 100) issue('sequence.lifecycle.repeat', 'Execution count must be an integer from 1 to 100.');
    }
    const steps: TweenStep[] = [];
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 64) issue('sequence.steps', 'Provide 1 to 64 ordered steps.');
    else input.steps.forEach((step: unknown, index: number) => {
        const location = `sequence.steps[${index}]`;
        if (!step || typeof step !== 'object' || Array.isArray(step)) { issue(location, 'Expected a step object.'); return; }
        const row = step as Record<string, unknown>;
        if (!object(row, row.kind === 'delay' ? ['kind', 'duration'] : ['kind', 'duration', 'easing', 'properties'], location)) return;
        if (row.kind !== 'delay' && row.kind !== 'to' && row.kind !== 'by') issue(`${location}.kind`, 'Only delay, to and by are supported.', 'MALFORMED_STEP');
        if (typeof row.duration !== 'number' || !Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 600) issue(`${location}.duration`, 'Duration must be finite, positive and at most 600 seconds.', 'INVALID_TIMING');
        if (row.kind === 'delay') { steps.push({ kind: 'delay', duration: row.duration as number }); return; }
        if (!TWEEN_EASINGS.includes(row.easing as typeof TWEEN_EASINGS[number])) issue(`${location}.easing`, 'Unsupported easing; use a declared Creator 3.7 easing.', 'UNSUPPORTED_EASING');
        const properties: Partial<Record<'position' | 'scale' | 'eulerAngles', TweenVector>> = {};
        if (object(row.properties, ['position', 'scale', 'eulerAngles'], `${location}.properties`)) {
            if (!Object.keys(row.properties).length) issue(`${location}.properties`, 'At least one transform property is required.', 'MALFORMED_STEP');
            for (const key of ['position', 'scale', 'eulerAngles'] as const) {
                if (!Object.prototype.hasOwnProperty.call(row.properties, key)) continue;
                const vector = row.properties[key];
                if (object(vector, ['x', 'y', 'z'], `${location}.properties.${key}`)) {
                    for (const axis of ['x', 'y', 'z']) if (typeof vector[axis] !== 'number' || !Number.isFinite(vector[axis]) || Math.abs(vector[axis] as number) > 1000000) issue(`${location}.properties.${key}.${axis}`, 'Axis must be finite and within +/-1000000.');
                    properties[key] = { x: vector.x as number, y: vector.y as number, z: vector.z as number };
                }
            }
        }
        steps.push({ kind: row.kind as 'to' | 'by', duration: row.duration as number, easing: row.easing as string, properties });
    });
    if (diagnostics.length) return { diagnostics };
    const lifecycle = input.lifecycle as TweenSequenceModel['lifecycle'];
    const model: TweenSequenceModel = { version: 1, id: input.id as string, target: { id: (input.target as Record<string, unknown>).id as string, type: 'cc.Node' }, steps, lifecycle: { start: lifecycle.start, stop: lifecycle.stop, repeat: lifecycle.repeat } };
    if (tweenDuration(model) > 3600) return { diagnostics: [tweenDiagnostic('INVALID_TIMING', 'sequence.steps', 'Total repeated duration must not exceed 3600 seconds.')] };
    return { model, diagnostics };
}

export function tweenDuration(model: TweenSequenceModel): number { return model.steps.reduce((sum, step) => sum + step.duration, 0) * model.lifecycle.repeat; }
export function requireTweenModel(input: unknown): TweenSequenceModel {
    const result = normalizeTweenModel(input);
    if (!result.model) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Invalid tween sequence descriptor.', details: { diagnostics: result.diagnostics } });
    return result.model;
}

export function generateTweenCode(model: TweenSequenceModel): string {
    const className = `CCPTween_${model.id}`;
    const lines = [
        `// ccp3x-tween-v1:${JSON.stringify(model)}`,
        '// Project-owned Creator 3.7 code; not a native tween asset. Assign target in the Inspector.',
        "import { _decorator, Component, Node, Tween, tween, Vec3 } from 'cc';",
        'const { ccclass, property } = _decorator;',
        `@ccclass('${className}')`,
        `export class ${className} extends Component {`,
        '    @property(Node)',
        '    target: Node | null = null;',
        '    private sequence: Tween<Node> | null = null;',
        '    play(): void {',
        '        this.stop();',
        "        if (!this.target || !this.target.isValid) throw new Error('Assign a valid tween target in the Inspector.');",
        '        this.sequence = tween(this.target)',
    ];
    for (const step of model.steps) {
        if (step.kind === 'delay') lines.push(`            .delay(${step.duration})`);
        else {
            const properties = Object.entries(step.properties).map(([key, v]) => `${key}: new Vec3(${v.x}, ${v.y}, ${v.z})`).join(', ');
            lines.push(`            .${step.kind}(${step.duration}, { ${properties} }, { easing: '${step.easing}' })`);
        }
    }
    if (model.lifecycle.repeat > 1) lines.push(`            .union().repeat(${model.lifecycle.repeat})`);
    lines.push('            .start();', '    }', '    stop(): void {', '        this.sequence?.stop();', '        this.sequence = null;', '    }');
    if (model.lifecycle.start === 'on-enable') lines.push('    onEnable(): void { this.play(); }');
    if (model.lifecycle.stop === 'on-disable') lines.push('    onDisable(): void { this.stop(); }');
    lines.push('    onDestroy(): void { this.stop(); }', '}', '');
    const code = lines.join('\n');
    if (Buffer.byteLength(code, 'utf8') > MAX_TWEEN_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Generated tween code exceeds 64 KiB.' });
    return code;
}

export function inspectTweenCode(code: string): { model?: TweenSequenceModel; diagnostics: TweenDiagnostic[] } {
    const marker = '// ccp3x-tween-v1:';
    if (!code.startsWith(marker)) return { diagnostics: [tweenDiagnostic('UNSUPPORTED_REPRESENTATION', 'source', 'Only canonical ccp3x-tween-v1 generated TypeScript is statically inspectable.')] };
    let input: unknown;
    try { input = JSON.parse(code.slice(marker.length, code.indexOf('\n'))); }
    catch { return { diagnostics: [tweenDiagnostic('PARSE_ERROR', 'source:1', 'Malformed tween descriptor header.')] }; }
    const result = normalizeTweenModel(input);
    if (!result.model) return result;
    if (generateTweenCode(result.model) !== code) return { diagnostics: [tweenDiagnostic('SOURCE_MISMATCH', 'source', 'Source differs from its supported deterministic representation; no code was executed.')] };
    return result;
}
