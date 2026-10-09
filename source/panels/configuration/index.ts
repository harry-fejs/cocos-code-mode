import packageJSON from '../../../package.json';
import { readFileSync } from 'fs-extra';
import { isAbsolute, join } from 'path';
import { attachLoggingControl } from './logging-control';
interface Settings { fixedPort: number; configPath: string }
interface SettingsPanel { $: { app: HTMLElement } }
const cleanup = new WeakMap<SettingsPanel, () => void>();
// A panel close must not permit another restart while the original RPC is unresolved.
let pendingSave: Promise<unknown> | null = null;
const instruction = 'Select this editor\'s ccp3x_<port> namespace and project path from Status. Call that namespace\'s editorHandshake with expectedProjectPath; verify projectMatches and bind its instanceId before mutations. Stay bound to that namespace, project path and instanceId. Re-handshake after reconnect or restart; if unavailable or identity changes, stop and ask rather than switching editors.';

function parseSettings(value: unknown): Settings {
    if (!value || typeof value !== 'object' || !('fixedPort' in value) || !('configPath' in value)
        || typeof value.fixedPort !== 'number' || !Number.isInteger(value.fixedPort)
        || value.fixedPort < 0 || value.fixedPort > 65535
        || typeof value.configPath !== 'string' || value.configPath.length > 4096
        || !isAbsolute(value.configPath) || /[\0\r\n]/.test(value.configPath)) {
        throw new Error('Expected an integer port from 0 to 65535 and an absolute registry file path.');
    }
    return { fixedPort: value.fixedPort, configPath: value.configPath };
}

class DeadlineError extends Error {}
function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    // Creator 3.7's runtime has no Promise.withResolvers; use its supported Promise constructor.
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DeadlineError('Request timed out.')), milliseconds);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}
function detail(error: unknown): string { return error instanceof Error ? error.message : String(error); }

module.exports = Editor.Panel.define({
    template: readFileSync(join(__dirname, '../../../static/template/configuration/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/configuration/index.css'), 'utf-8'),
    $: { app: '.panel' },
    ready(this: SettingsPanel) {
        const root = this.$.app;
        const port = root.querySelector<HTMLInputElement>('#port-input')!;
        const path = root.querySelector<HTMLInputElement>('#registry-path')!;
        const mcp = root.querySelector<HTMLTextAreaElement>('#mcp-config')!;
        const agent = root.querySelector<HTMLTextAreaElement>('#agent-instruction')!;
        const apply = root.querySelector<HTMLButtonElement>('#apply-settings')!;
        const reload = root.querySelector<HTMLButtonElement>('#reload-settings')!;
        const feedback = root.querySelector<HTMLElement>('#settings-feedback')!;
        const copyFeedback = root.querySelector<HTMLElement>('#copy-feedback')!;
        const listeners: Array<() => void> = [];
        let closed = false;
        let pending = false;
        let loaded = false;
        let uncertain = false;
        agent.value = instruction;
        const on = (element: HTMLElement, handler: () => void) => {
            element.addEventListener('click', handler);
            listeners.push(() => element.removeEventListener('click', handler));
        };
        const controls = () => {
            port.disabled = path.disabled = pending || !loaded || uncertain;
            apply.disabled = pending || !loaded || uncertain;
            reload.disabled = pending;
            root.querySelectorAll<HTMLButtonElement>('[data-source="mcp-config"]').forEach(button => { button.disabled = !loaded || pending || uncertain; });
        };
        const show = (settings: Settings) => {
            port.value = String(settings.fixedPort);
            path.value = settings.configPath;
            mcp.value = JSON.stringify({ mcpServers: { 'ccp': {
                command: 'npx', args: ['-y', '@utcp/code-mode-mcp'], env: { UTCP_CONFIG_FILE: settings.configPath },
            } } }, null, 2);
            loaded = true;
        };
        const load = async () => {
            if (closed || pending) return;
            pending = true;
            controls();
            feedback.textContent = 'Loading settings…';
            try {
                if (pendingSave) await bounded(pendingSave, 8000);
                const settings: unknown = await bounded(Editor.Message.request(packageJSON.name, 'extension-settings'), 8000);
                if (closed) return;
                show(parseSettings(settings));
                feedback.textContent = 'Settings loaded. Advanced changes apply only when you choose Apply & Restart.';
                reload.hidden = true;
            } catch (error) {
                if (!closed) feedback.textContent = `Could not load settings: ${detail(error)} Use Reload settings to try the read again.`;
            } finally {
                if (!closed) { pending = false; controls(); }
            }
        };
        on(reload, () => { void load(); });
        on(apply, async () => {
            if (closed || pending || !loaded || uncertain || pendingSave) return;
            let settings: Settings;
            try {
                if (!port.value.trim()) throw new Error('Enter a port; use 0 for automatic selection.');
                settings = parseSettings({ fixedPort: Number(port.value), configPath: path.value.trim() });
            } catch (error) { feedback.textContent = detail(error); return; }
            pending = true;
            controls();
            feedback.textContent = 'Applying settings and restarting the server…';
            try {
                const request: Promise<unknown> = Promise.resolve().then(() => Editor.Message.request(packageJSON.name, 'save-extension-settings', settings));
                pendingSave = request;
                void request.then(() => { if (pendingSave === request) pendingSave = null; }, () => { if (pendingSave === request) pendingSave = null; });
                const saved: unknown = await bounded(request, 20000);
                if (closed) return;
                show(parseSettings(saved));
                feedback.textContent = 'Settings applied and server restarted. Check Status and re-handshake before using the editor. Restart your AI client if its registry path changed.';
            } catch (error) {
                if (closed) return;
                uncertain = true;
                feedback.textContent = error instanceof DeadlineError
                    ? 'Apply & Restart timed out; outcome unknown. It may still complete. Do not retry blindly. Check Status, then reopen Settings to inspect the saved values before another change.'
                    : `Apply & Restart was not confirmed: ${detail(error)} Settings may have changed. Check Status, then reopen Settings to inspect the saved values before retrying.`;
            } finally {
                if (!closed) { pending = false; controls(); }
            }
        });
        root.querySelectorAll<HTMLButtonElement>('[data-source]').forEach(button => {
            on(button, async () => {
                const field = button.dataset.source === 'mcp-config' ? mcp : agent;
                field.focus();
                field.select();
                if (button.dataset.action === 'select') {
                    copyFeedback.textContent = 'Text selected. Use Ctrl+C (Cmd+C on macOS) to copy.';
                    return;
                }
                button.disabled = true;
                copyFeedback.textContent = 'Copying…';
                try {
                    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard access is unavailable.');
                    await bounded(navigator.clipboard.writeText(field.value), 5000);
                    if (!closed) copyFeedback.textContent = 'Copied to clipboard.';
                } catch (error) {
                    if (!closed) copyFeedback.textContent = `Copy not confirmed: ${detail(error)} Use Select, then Ctrl+C (Cmd+C on macOS).`;
                } finally {
                    if (!closed) { button.disabled = false; controls(); }
                }
            });
        });
        const detachLogging = attachLoggingControl(root);
        cleanup.set(this, () => { closed = true; listeners.forEach(remove => remove()); detachLogging(); });
        void load();
    },
    close(this: SettingsPanel) { cleanup.get(this)?.(); cleanup.delete(this); },
});
