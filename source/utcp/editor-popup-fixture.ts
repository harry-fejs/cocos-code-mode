import { randomBytes } from 'crypto';
import { askEditor } from './editor-ask';
import { ToolError } from './tool-error';

const FIXTURE_MS = 300000;
const TITLE_PREFIX = 'CCP3X Action Qualification ';
const TRACKED_KEY = Symbol.for('ccp.editor-popup-fixture');
type TrackedFixture = { title: string; expiresAt: number };
const fixtureStore = globalThis as unknown as Record<symbol, TrackedFixture | null | undefined>;
function trackedFixture(): TrackedFixture | null { return fixtureStore[TRACKED_KEY] ?? null; }
function setTrackedFixture(value: TrackedFixture | null): void { fixtureStore[TRACKED_KEY] = value; }

export function getTrackedPopupFixture(): { title: string; expiresAt: number } | null {
    const current = trackedFixture();
    return current ? { ...current } : null;
}

export function startTrackedPopupFixture(): { title: string; expiresAt: number } {
    if (trackedFixture()) throw new ToolError({ code: 'POPUP_FIXTURE_BUSY', status: 409, message: 'A disposable Creator popup is still pending or awaiting manual dismissal.' });
    const title = TITLE_PREFIX + randomBytes(16).toString('hex');
    const current = { title, expiresAt: Date.now() + FIXTURE_MS };
    setTrackedFixture(current);
    const release = () => { if (trackedFixture() === current) setTrackedFixture(null); };
    try {
        askEditor({ title, message: 'Disposable popup-action qualification. No scene or file changes.', presentation: 'native', type: 'warning', buttons: ['Continue', 'Cancel'], cancelId: 1, timeoutMs: FIXTURE_MS }, release)
            .then(result => { if (!result.timedOut) release(); }, release);
    } catch (error) {
        release();
        throw error;
    }
    return { ...current };
}
