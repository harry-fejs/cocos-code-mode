import { randomUUID } from 'crypto';
import { ToolError } from './tool-error';

export interface NativeProbeBakeArgs { operation: 'start' | 'inspect' | 'cancel'; sceneUuid?: string; jobId?: string }
export interface NativeProbeBakeResult {
    jobId: string; status: 'running' | 'completed' | 'cancelled' | 'failed' | 'indeterminate'; sceneUuid: string;
    startedAt: number; updatedAt: number; finishedAt: number | null; outputPath: string; probeCount: number; processId: number | null;
    native: { started: boolean; finished: boolean; error: boolean; processOpen: boolean; timerOpen: boolean; serverOpen: boolean };
    verification: { outputFile: boolean; topologyUnchanged: boolean; coefficientsFinite: boolean; coefficientsChanged: boolean };
    reason: string | null;
}
interface Remote { objectId?: string; value?: unknown; description?: string }
interface ProtocolReply { result?: Remote | Array<{ name: string; value?: Remote }>; internalProperties?: Array<{ name: string; value: Remote }>; exceptionDetails?: unknown }
interface Debugger { isAttached(): boolean; attach(version: string): void; detach(): void; sendCommand(command: string, params?: Record<string, unknown>): Promise<ProtocolReply> }
interface Contents { id: number; getType(): string; getURL(): string; isDestroyed(): boolean; debugger: Debugger }
const jobs = new Map<string, { renderer: number; url: string; project: string }>();
let busy = false;

// Runs in the edit renderer against the recovered installed Lightmap instance; no caller source is accepted.
function nativeOperation(this: any, request: NativeProbeBakeArgs & { newId: string }): NativeProbeBakeResult {
    const fs = require('fs'), path = require('path');
    const root = globalThis as any;
    const store: Map<string, any> = root.__ccpNativeProbeJobs ?? (root.__ccpNativeProbeJobs = new Map());
    const app = this.lfxApp, baker = app?.Baker, scene = this.scene;
    const fail = (code: string, message: string): never => { throw new Error(`${code}: ${message}`); };
    if (!app || !baker || !scene || typeof this.bakeLightProbe !== 'function') fail('UNSUPPORTED_EDITOR_API', 'Installed native probe owner is unavailable.');
    const snapshot = () => {
        const probes = scene.globals?.lightProbeInfo?.data?.probes;
        if (!Array.isArray(probes) || probes.length < 4 || probes.length > 256) fail('INVALID_PROBE_FIXTURE', 'From4 to256 native probes are required.');
        return probes.map((p: any) => ({ position: [p.position.x, p.position.y, p.position.z], coefficients: p.coefficients.map((v: any) => [v.x, v.y, v.z]) }));
    };
    let job: any;
    if (request.operation === 'start') {
        if (scene.uuid !== request.sceneUuid) fail('SCENE_CHANGED', 'Exact edit scene does not match.');
        if (Array.from(store.values()).some(job => !job.terminal)) fail('BAKE_BUSY', 'Reconcile the prior owned job before starting another bake.');
        if (app._process || app._timer || baker._server || baker._client) fail('BAKE_BUSY', 'Native baker is already occupied.');
        if (store.size >= 32) fail('BAKE_HISTORY_LIMIT', 'Restart the bridge after retaining32 job witnesses.');
        const baseline = snapshot();
        if (!baseline.every((p: any) => p.position.every(Number.isFinite))) fail('INVALID_PROBE_FIXTURE', 'Probe positions must be finite.');
        const p0 = baseline[0].position;
        let volume = false;
        for (let i = 1; i < baseline.length && !volume; i++) for (let j = i + 1; j < baseline.length && !volume; j++) for (let k = j + 1; k < baseline.length && !volume; k++) {
            const a = baseline[i].position.map((v: number, n: number) => v - p0[n]);
            const b = baseline[j].position.map((v: number, n: number) => v - p0[n]);
            const c = baseline[k].position.map((v: number, n: number) => v - p0[n]);
            volume = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) > 1e-8;
        }
        if (!volume) fail('INVALID_PROBE_FIXTURE', 'Probe topology must contain a noncoplanar tetrahedron.');
        const info = scene.globals.lightProbeInfo;
        if (!Number.isInteger(info.giSamples) || info.giSamples < 64 || info.giSamples > 1024 || !Number.isInteger(info.bounces) || info.bounces < 1 || info.bounces > 4 || !Number.isFinite(info.giScale) || info.giScale < 0 || info.giScale > 10) fail('INVALID_BAKE_SETTINGS', 'GI settings exceed the bounded bake contract.');
        const output = path.join(Editor.Project.path, 'temp', 'ccp-bake', request.newId);
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output);
        job = { id: request.newId, owner: this, app, baker, scene, baseline, output, startedAt: Date.now(), process: null, cancelled: false };
        store.set(job.id, job);
        try { this.bakeLightProbe({ path: output, name: 'CCPProbeBake', msaa: 1, size: 64, threads: 1 }, Editor.App.path); job.world = baker.World; job.timer = app._timer; }
        catch (error) { job.world = baker.World; job.timer = app._timer; job.dispatchError = String(error); }
    } else {
        job = store.get(request.jobId!);
        if (!job) fail('BAKE_JOB_NOT_FOUND', 'No owned native bake has this identity.');
    }
    if (job.terminal) return job.terminal;
    const original = job.owner === this && job.app === app && job.baker === baker && job.scene === scene && job.world === baker.World && app._uploadPath === job.output && app.Scene === scene;
    let reason: string | null = job.dispatchError ?? null;
    let status: NativeProbeBakeResult['status'] = 'running';
    if (!original) { status = 'indeterminate'; reason = 'Native owner, scene, world or output path changed; refusing control.'; }
    else {
        if (app._process && !job.process) job.process = app._process;
        if (app._process && app._process !== job.process) { status = 'indeterminate'; reason = 'Native process identity changed.'; }
        if (request.operation === 'cancel' && status === 'running') {
            if (app._timer && app._timer === job.timer && app._process === job.process) { this.cancelLightProbe(); job.cancelled = true; }
            else if (app._process || app._timer || baker._server) { status = 'indeterminate'; reason = 'Native cancellation cannot prove process ownership.'; }
        }
    }
    let topologyUnchanged = false, coefficientsFinite = false, coefficientsChanged = false;
    if (original) {
        const current = snapshot();
        topologyUnchanged = JSON.stringify(current.map((p: any) => p.position)) === JSON.stringify(job.baseline.map((p: any) => p.position));
        coefficientsFinite = current.every((p: any) => p.coefficients.length === 9 && p.coefficients.every((v: number[]) => v.length === 3 && v.every(Number.isFinite)));
        coefficientsChanged = JSON.stringify(current.map((p: any) => p.coefficients)) !== JSON.stringify(job.baseline.map((p: any) => p.coefficients));
    }
    const closed = !app._process && !app._timer && !baker._server && !baker._client;
    if (job.dispatchError && closed && job.owner === this && job.app === app && job.baker === baker && job.world === baker.World) status = 'failed';
    let outputFile = false;
    try { const stat = fs.statSync(path.join(job.output, 'output', 'lfx.out')); outputFile = stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024 * 1024; } catch { /* Output may not exist while running. */ }
    if (status === 'running' && original) {
        if (job.cancelled && closed) status = 'cancelled';
        else if (baker.Error || job.dispatchError) { status = closed ? 'failed' : 'indeterminate'; reason ??= 'Native backend failed; retained ownership until closure.'; }
        else if (baker.Finished && closed) { status = outputFile && topologyUnchanged && coefficientsFinite && coefficientsChanged ? 'completed' : 'failed'; if (status === 'failed') reason = 'Native completion lacked output or SH postconditions.'; }
        else if (Date.now() - job.startedAt > 120000) { status = 'indeterminate'; reason = 'Deadline elapsed; native job is not automatically cancelled or retried.'; }
    }
    const reply: NativeProbeBakeResult = { jobId: job.id, status, sceneUuid: job.scene.uuid, startedAt: job.startedAt, updatedAt: Date.now(), finishedAt: ['completed', 'cancelled', 'failed'].includes(status) ? (job.finishedAt ?? (job.finishedAt = Date.now())) : null, outputPath: job.output, probeCount: job.baseline.length, processId: job.process?.pid ?? null,
        native: { started: !!baker.Started, finished: !!baker.Finished, error: !!baker.Error, processOpen: !!app._process, timerOpen: !!app._timer, serverOpen: !!baker._server },
        verification: { outputFile, topologyUnchanged, coefficientsFinite, coefficientsChanged }, reason };
    if (['completed', 'cancelled', 'failed'].includes(status)) job.terminal = reply;
    return reply;
}

export async function manageNativeProbeBake(args: NativeProbeBakeArgs): Promise<NativeProbeBakeResult> {
    if (busy) throw new ToolError({ code: 'BAKE_BUSY', status: 409, message: 'Another probe operation is in flight.' });
    if (Editor.App.version !== '3.8.8') throw new ToolError({ code: 'UNSUPPORTED_EDITOR_VERSION', status: 422, message: 'Native probe bake adapter is qualified only for Creator3.8.8.' });
    busy = true;
    let debuggerHandle: Debugger | undefined;
    try {
        const electron = require('electron') as { webContents: { getAllWebContents(): Contents[] } };
        const candidates = electron.webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview' && /\/preload\/web\/preload\.js(?:$|[&#?])/.test(decodeURIComponent(w.getURL()).replace(/\\/g, '/')));
        if (candidates.length !== 1) throw new ToolError({ code: 'BAKE_RENDERER_UNAVAILABLE', status: 422, message: 'One exact edit-scene renderer is required.' });
        const renderer = candidates[0], prior = args.jobId ? jobs.get(args.jobId) : undefined;
        if (args.operation !== 'start' && (!prior || prior.renderer !== renderer.id || prior.url !== renderer.getURL() || prior.project !== Editor.Project.path)) throw new ToolError({ code: 'BAKE_JOB_NOT_FOUND', status: 404, message: 'Job is not owned by this project and renderer.' });
        const d = renderer.debugger;
        if (d.isAttached()) throw new ToolError({ code: 'BAKE_DEBUGGER_BUSY', status: 409, message: 'Edit renderer debugger is owned by another client.' });
        d.attach('1.3'); debuggerHandle = d;
        const r = await d.sendCommand('Runtime.evaluate', { expression: "Object.values(require.cache).find(m=>m.filename.includes('lightmap')&&m.exports?.methods?.bakeLightProbe).exports.methods.bakeLightProbe" });
        const functionId = (r.result as Remote)?.objectId;
        if (r.exceptionDetails || !functionId) throw new Error('Installed lightmap function is unavailable.');
        const p = await d.sendCommand('Runtime.getProperties', { objectId: functionId });
        const scopeId = p.internalProperties?.find(x => x.name === '[[Scopes]]')?.value.objectId;
        if (!scopeId) throw new Error('Native closure scope is unavailable.');
        const scopes = await d.sendCommand('Runtime.getProperties', { objectId: scopeId, ownProperties: true });
        let ownerId: string | undefined;
        for (const scope of scopes.result as Array<{ value?: Remote }>) {
            if (!scope.value?.objectId || scope.value.description !== 'Closure') continue;
            const values = await d.sendCommand('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
            ownerId = (values.result as Array<{ name: string; value?: Remote }>).find(x => x.name === 'lightMap')?.value?.objectId;
            if (ownerId) break;
        }
        if (!ownerId) throw new Error('Native lightMap owner is unavailable.');
        const id = args.operation === 'start' ? randomUUID() : args.jobId!;
        // Retain identity before dispatch: a lost reply must never authorize a blind resubmission.
        if (args.operation === 'start') jobs.set(id, { renderer: renderer.id, url: renderer.getURL(), project: Editor.Project.path });
        const result = await d.sendCommand('Runtime.callFunctionOn', { objectId: ownerId, functionDeclaration: nativeOperation.toString(), arguments: [{ value: { ...args, newId: id } }], returnByValue: true });
        if (result.exceptionDetails) throw new ToolError({ code: 'BAKE_OPERATION_FAILED', status: 502, message: 'Native probe operation failed; inspect owned state before retrying.', details: { jobId: id, retrySafe: false } });
        const value = (result.result as Remote)?.value as NativeProbeBakeResult;
        if (!value || value.jobId !== id || typeof value.status !== 'string') throw new Error('Invalid native bake response.');
        return value;
    } finally { try { debuggerHandle?.detach(); } finally { busy = false; } }
}
