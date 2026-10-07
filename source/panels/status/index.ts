import packageJSON from '../../../package.json';
import { isStatus, renderStatus, Status } from './status-view';

interface StatusPanel {
    $: {
        check: HTMLButtonElement; restart: HTMLButtonElement; recover: HTMLButtonElement; open: HTMLButtonElement; clear: HTMLButtonElement;
        debug: HTMLInputElement; debugLabel: HTMLElement; action: HTMLElement;
        state: HTMLElement; checked: HTMLElement; groups: HTMLElement; root: HTMLElement;
    };
}
interface PanelState {
    closed: boolean; pending: boolean; fresh: boolean; generation: number;
    snapshot: Status | null; cancel?: () => void; refreshTimer?: NodeJS.Timeout;
}
const states = new Map<StatusPanel, PanelState>();
// Keep unresolved operations locked even if the panel is closed and reopened.
let operation: Promise<unknown> | null = null;
let actionMessage = '';
let actionKind = '';

function updateControls(): void {
    for (const [panel, state] of states) {
        const busy = state.pending || operation !== null;
        for (const control of [panel.$.check, panel.$.restart, panel.$.recover, panel.$.open, panel.$.clear]) control.disabled = busy;
        panel.$.recover.hidden = state.snapshot?.startupFailure?.recoverable !== true;
        panel.$.recover.disabled = busy || state.snapshot?.startupFailure?.recoverable !== true;
        panel.$.debug.disabled = busy || !state.fresh;
        panel.$.debug.checked = state.snapshot?.server.debug ?? false;
        panel.$.debug.indeterminate = state.snapshot === null;
        panel.$.debugLabel.textContent = `Debug logging: ${state.snapshot ? (state.snapshot.server.debug ? 'ON' : 'OFF') : 'Unavailable'}${state.snapshot && !state.fresh ? ' — last checked' : ''}`;
        panel.$.action.textContent = actionMessage;
        panel.$.action.dataset.kind = actionKind;
        panel.$.root.setAttribute('aria-busy', String(busy));
    }
}

async function checkStatus(panel: StatusPanel): Promise<void> {
    const state = states.get(panel);
    if (!state || state.closed || state.pending || operation) return;
    state.pending = true;
    const generation = ++state.generation;
    updateControls();
    panel.$.state.dataset.kind = 'pending';
    panel.$.state.textContent = state.snapshot ? 'Checking status… Previous snapshot shown below.' : 'Checking status…';
    let timer: NodeJS.Timeout | undefined;
    try {
        const deadline = new Promise<never>((_resolve, reject) => {
            state.cancel = () => reject(new Error('Panel closed.'));
            timer = setTimeout(() => reject(new Error('No response within 4 seconds. Try Check Status again.')), 4000);
        });
        const request: Promise<unknown> = Promise.resolve().then(() => Editor.Message.request(packageJSON.name, 'extension-status'));
        const response = await Promise.race([request, deadline]);
        if (state.closed || state.generation !== generation) return;
        if (!isStatus(response)) throw new Error('The extension returned an invalid status response.');
        state.snapshot = response;
        state.fresh = true;
        renderStatus(panel.$.groups, response);
        panel.$.checked.textContent = `Last checked: ${new Date(response.checkedAt).toLocaleString()}`;
        panel.$.debugLabel.textContent = `Debug logging: ${state.snapshot ? (state.snapshot.server.logging.server ? 'ON' : 'warnings/errors only') : 'Unavailable'}${state.snapshot && !state.fresh ? ' — last checked' : ''}`;
        panel.$.action.textContent = actionMessage;
        panel.$.action.dataset.kind = actionKind;
    } catch (error: unknown) {
        if (state.closed || state.generation !== generation) return;
        state.fresh = false;
        panel.$.state.dataset.kind = 'error';
        const detail = error instanceof Error ? error.message : String(error);
        panel.$.state.textContent = `${state.snapshot ? 'Check failed — previous snapshot is stale.' : 'Check failed — status unavailable.'} ${detail}`;
    } finally {
        clearTimeout(timer);
        if (!state.closed && state.generation === generation) {
            state.cancel = undefined;
            state.pending = false;
            updateControls();
        }
    }
}

async function performAction(panel: StatusPanel, label: string, message: string, args: unknown[] = [], confirmation?: string): Promise<void> {
    const state = states.get(panel);
    if (!state || state.closed || state.pending || operation) return;
    if (confirmation && !confirm(confirmation)) return;
    for (const current of states.values()) current.fresh = false;
    actionMessage = `${label}… Previous status remains a snapshot.`;
    actionKind = 'pending';
    operation = Promise.resolve().then(() => Editor.Message.request(packageJSON.name, message, ...args));
    updateControls();
    const timer = setTimeout(() => {
        actionMessage = `${label}: outcome unknown — no response within 4 seconds. Waiting for the original request; operations remain disabled to prevent duplicate changes.`;
        actionKind = 'warning';
        updateControls();
    }, 4000);
    let succeeded = false;
    try {
        await operation;
        succeeded = true;
        actionMessage = `${label} completed.`;
        actionKind = 'checked';
    } catch (error: unknown) {
        actionMessage = `${label} failed: ${error instanceof Error ? error.message : String(error)} Check Status before retrying.`;
        actionKind = 'error';
    } finally {
        clearTimeout(timer);
        operation = null;
        updateControls();
        if (succeeded) for (const current of states.keys()) void checkStatus(current);
    }
}

export const statusPanelDefinition = {
    template: `<main id="status-root">
        <header><div><h1>Cocos Pilot 3x</h1><p class="subtitle">Extension status</p></div><button id="check" type="button">Check Status</button></header>
        <div class="check-summary"><p id="state" role="status" aria-live="polite">Status not checked.</p><p id="checked">Not checked yet</p></div>
        <p class="note">Live snapshot refreshes while this panel is open. HTTP checks verify this editor instance, not agent connectivity.</p>
        <div id="groups"></div>
        <section class="operations" aria-label="Server operations">
            <h2>Operations</h2>
            <div class="controls"><button id="restart" type="button">Restart Server</button>
                <button id="recover" type="button" hidden>Recover Port</button>
                <label><input id="debug" type="checkbox" disabled><span id="debug-label">Debug logging: Unavailable</span></label>
                <button id="open" type="button">Open This Editor's Logs</button><button id="clear" type="button">Clear This Editor's Logs</button></div>
            <p id="action" role="status" aria-live="polite"></p>
        </section>
    </main>`,
    style: `:host { display: block; height: 100%; color: #e1e3e8; background: #25262b; font: 13px/1.5 sans-serif; }
        * { box-sizing: border-box; } #status-root { height: 100%; overflow: auto; padding: 16px; }
        header, .controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
        h1 { font-size: 19px; line-height: 1.3; margin: 0; } .subtitle { margin: 3px 0 0; color: #aeb4c0; }
        button { font: inherit; color: #fff; background: #365e96; border: 1px solid #6386b8; border-radius: 4px; padding: 7px 11px; cursor: pointer; }
        button:hover:not(:disabled) { background: #436fa9; } button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid #9ec9ff; outline-offset: 3px; }
        button:disabled, input:disabled { opacity: .6; cursor: wait; } .check-summary { margin-top: 16px; padding: 10px 12px; background: #30333b; border-radius: 5px; }
        #state, #action { margin: 0; font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
        [data-kind="error"], [data-kind="warning"] { color: #ffca95; } [data-kind="pending"] { color: #a9d0ff; }
        #checked { margin: 4px 0 0; font-size: 12px; color: #b8beca; } .note { color: #aeb4c0; font-size: 12px; margin: 12px 0 16px; }
        section, details { border: 1px solid #444852; border-radius: 5px; margin: 0 0 12px; overflow: hidden; }
        h2, summary { font-size: 13px; margin: 0; padding: 8px 11px; background: #30333b; } summary { cursor: pointer; }
        dl { display: grid; grid-template-columns: minmax(85px, 30%) minmax(0, 1fr); gap: 7px 12px; padding: 11px; margin: 0; }
        dt { color: #aeb4c0; } dd { margin: 0; color: #e1e3e8; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
        .request-list { margin: 0; padding: 11px; list-style: none; max-height: calc(5 * 32px + 22px); overflow-y: auto; scrollbar-gutter: stable; }
        .request-list:focus-visible { outline: 2px solid #9ec9ff; outline-offset: -2px; }
        .request-list li { display: flex; align-items: center; gap: 8px; height: 32px; min-width: 0; white-space: nowrap; border-bottom: 1px solid #3e424b; }
        .request-list li:last-child { border-bottom: 0; }
        .request-list time { flex: none; color: #aeb4c0; font-size: 12px; }
        .request-list .request-tool { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
        .request-list li span:last-child { flex: none; font-size: 12px; }
        .controls { padding: 11px; justify-content: flex-start; } label { display: inline-flex; align-items: center; gap: 6px; }
        #action:not(:empty) { padding: 0 11px 11px; }`,
    $: { check: '#check', restart: '#restart', recover: '#recover', open: '#open', clear: '#clear', debug: '#debug', debugLabel: '#debug-label', action: '#action', state: '#state', checked: '#checked', groups: '#groups', root: '#status-root' },
    ready() {
        const panel = this as unknown as StatusPanel;
        states.set(panel, { closed: false, pending: false, fresh: false, generation: 0, snapshot: null });
        renderStatus(panel.$.groups, null);
        panel.$.check.onclick = () => { void checkStatus(panel); };
        panel.$.restart.onclick = () => { void performAction(panel, 'Restart Server', 'restart-server', [], 'Restart the server? Connected agents will be disconnected and may need to reconnect.'); };
        panel.$.recover.onclick = () => { void performAction(panel, 'Recover Port', 'recover-server-port', [], 'Switch this editor from its occupied fixed port to automatic port selection? The process owning the old port will not be stopped.'); };
        panel.$.open.onclick = () => { void performAction(panel, 'Open this editor’s logs', 'open-debug-folder'); };
        panel.$.clear.onclick = () => { void performAction(panel, 'Clear this editor’s logs', 'clear-debug-logs', [], 'Permanently clear logs for this editor instance only? This cannot be undone.'); };
        panel.$.debug.onchange = () => {
            const enabled = panel.$.debug.checked;
            updateControls();
            if (states.get(panel)?.fresh) void performAction(panel, `Turn debug logging ${enabled ? 'ON' : 'OFF'}`, 'set-debug-logging', [enabled]);
        };
        updateControls();
        void checkStatus(panel);
        const state = states.get(panel)!;
        state.refreshTimer = setInterval(() => { void checkStatus(panel); }, 5000);
    },
    close() {
        const panel = this as unknown as StatusPanel;
        const state = states.get(panel);
        if (state) {
            state.closed = true;
            ++state.generation;
            state.cancel?.();
            clearInterval(state.refreshTimer);
            state.refreshTimer = undefined;
            states.delete(panel);
        }
        for (const control of [panel.$.check, panel.$.restart, panel.$.recover, panel.$.open, panel.$.clear]) control.onclick = null;
        panel.$.debug.onchange = null;
    },
};

module.exports = Editor.Panel.define(statusPanelDefinition);
