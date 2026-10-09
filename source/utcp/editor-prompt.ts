import { randomBytes } from 'crypto';
import packageJSON from '../../package.json';
import { EditorAskArgs, EditorAskResult, EditorInteractionRequest, EditorPromptArgs, EditorPromptResult } from './editor-interaction-contracts';
import { validatePrompt, validatePromptValues } from './editor-interaction-validation';
import { ToolError } from './tool-error';

interface PendingPrompt {
    request: EditorInteractionRequest;
    finish: (status: 'submitted' | 'cancelled' | 'timedOut', values?: Record<string, string | boolean>, error?: unknown) => void;
}
let pending: PendingPrompt | undefined;

export function getEditorPrompt(requestId?: string): EditorInteractionRequest | null {
    if (!pending || (requestId !== undefined && pending.request.requestId !== requestId)) return null;
    if (Date.now() >= pending.request.expiresAt) {
        pending.finish('timedOut');
        return null;
    }
    return pending.request;
}

export function respondEditorPrompt(response: unknown): { accepted: boolean } {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Prompt response must be an object.' });
    }
    const args = response as Record<string, unknown>;
    if (Object.keys(args).some(key => !['requestId', 'action', 'values', 'buttonIndex'].includes(key)) ||
        typeof args.requestId !== 'string' || !['submit', 'cancel', 'choose'].includes(args.action as string)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Prompt response requires requestId and submit/cancel/choose action.' });
    }
    const active = pending;
    if (!active || !getEditorPrompt(args.requestId)) return { accepted: false };
    if (args.action === 'cancel') active.finish('cancelled');
    else if (args.action === 'submit' && active.request.kind === 'form') {
        active.finish('submitted', validatePromptValues(active.request.fields, args.values));
    } else if (args.action === 'choose' && active.request.kind === 'question' &&
        typeof args.buttonIndex === 'number' && Number.isInteger(args.buttonIndex) &&
        args.buttonIndex >= 0 && args.buttonIndex < active.request.buttons.length) {
        active.finish('submitted', { button: active.request.buttons[args.buttonIndex] });
    } else throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Response action/choice does not match the pending request.' });
    return { accepted: true };
}

export function cancelEditorPrompt(): void { pending?.finish('cancelled'); }

export function promptEditor(input: EditorPromptArgs): Promise<EditorPromptResult> {
    const args = validatePrompt(input);
    return startPrompt({ ...args, kind: 'form', requestId: randomBytes(16).toString('hex'), expiresAt: Date.now() + args.timeoutMs });
}

export function promptEditorQuestion(args: EditorAskArgs & { buttons: string[]; cancelId: number; timeoutMs: number }): Promise<EditorAskResult> {
    return startPrompt({ ...args, kind: 'question', requestId: randomBytes(16).toString('hex'), expiresAt: Date.now() + args.timeoutMs }).then(result => {
        const index = result.submitted ? args.buttons.indexOf(result.values.button as string) : -1;
        return { buttonIndex: index < 0 ? null : index, buttonLabel: index < 0 ? null : args.buttons[index], cancelled: result.cancelled || index === args.cancelId, timedOut: result.timedOut };
    });
}

function notify(event: string, ...args: string[]): void {
    // Broadcast only: routing a message to a closed panel can implicitly open it.
    try { Editor.Message.broadcast(`${packageJSON.name}:${event}`, ...args); }
    catch (error) { console.warn('[cx3][prompt] Agent Inbox notification failed:', error); }
}

function startPrompt(request: EditorInteractionRequest): Promise<EditorPromptResult> {
    if (pending) {
        throw new ToolError({ code: 'EDITOR_INTERACTION_BUSY', status: 409, message: 'Another Agent Inbox request is active. Submit/cancel it or wait for its deadline.' });
    }
    // Creator 3.7's Node runtime predates Promise.withResolvers.
    return new Promise((resolve, reject) => {
        const active: PendingPrompt = {
            request,
            finish(status, values = {}, error) {
                if (pending !== active) return;
                pending = undefined;
                clearTimeout(timer);
                notify('editor-prompt-finished', request.requestId, status);
                if (error !== undefined) reject(error);
                else resolve({ requestId: request.requestId, submitted: status === 'submitted', cancelled: status === 'cancelled', timedOut: status === 'timedOut', values });
            },
        };
        const timer = setTimeout(() => active.finish('timedOut'), Math.max(0, request.expiresAt - Date.now()));
        pending = active;
        console.info(`[cx3][prompt] Agent request ${request.requestId} pending. Open CCP 3x > Agent Inbox to respond before ${new Date(request.expiresAt).toISOString()}.`);
        notify('editor-prompt-changed');
        if (request.openPanel !== true) return;
        // Opening may activate Creator's panel: only permitted by explicit opt-in.
        // The response deadline covers startup even if Panel.open never resolves.
        Promise.resolve().then(() => {
            if (pending !== active) return;
            return Editor.Panel.open(`${packageJSON.name}.prompt`);
        }).then(opened => {
            if (opened === false) active.finish('cancelled', {}, new ToolError({ code: 'EDITOR_PANEL_OPEN_FAILED', message: 'Creator could not open the Agent Inbox panel.' }));
        }, error => active.finish('cancelled', {}, error));
    });
}
