export type RequestOutcome = 'completed' | 'failed';

export interface ActiveRequestActivity {
    requestId: string;
    tool: string;
    startedAt: number;
    ageMs: number;
}

export interface FinishedRequestActivity {
    requestId: string;
    tool: string;
    outcome: RequestOutcome;
    status: number;
    finishedAt: number;
    durationMs: number;
}

export interface RequestActivitySnapshot {
    activeCount: number;
    active: ActiveRequestActivity[];
    overflowCount: number;
    lastReceived: { tool: string; receivedAt: number; ageMs: number } | null;
    recentFinished: FinishedRequestActivity[];
}

const MAX_VISIBLE_ACTIVE = 20;
const MAX_RECENT_FINISHED = 20;
const EXCLUDED_TOOLS = new Set(['editorHandshake', 'editorSessionHeartbeat']);

interface VisibleActive {
    requestId: string;
    tool: string;
    startedAt: number;
}

/** Bounded metadata-only activity. It never retains arguments, results, prompts, or source data. */
export class RequestActivityStore {
    private activeCount = 0;
    private readonly visible = new Map<string, VisibleActive>();
    private lastReceived: { tool: string; receivedAt: number } | null = null;
    private readonly recentFinished: FinishedRequestActivity[] = [];

    constructor(private readonly now: () => number = Date.now) {}

    start(requestId: string, tool: string): boolean {
        if (EXCLUDED_TOOLS.has(tool)) return false;
        const receivedAt = this.now();
        this.lastReceived = { tool, receivedAt };
        this.activeCount += 1;
        if (this.visible.size < MAX_VISIBLE_ACTIVE) {
            this.visible.set(requestId, { requestId, tool, startedAt: receivedAt });
        }
        return true;
    }

    finish(requestId: string, tool: string, outcome: RequestOutcome, status: number, startedAt: number): void {
        if (EXCLUDED_TOOLS.has(tool)) return;
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.visible.delete(requestId);
        const finishedAt = this.now();
        this.recentFinished.unshift({
            requestId,
            tool,
            outcome,
            status,
            finishedAt,
            durationMs: Math.max(0, finishedAt - startedAt),
        });
        if (this.recentFinished.length > MAX_RECENT_FINISHED) this.recentFinished.pop();
    }

    snapshot(): RequestActivitySnapshot {
        const now = this.now();
        const active = [...this.visible.values()].map((entry) => ({
            ...entry,
            ageMs: Math.max(0, now - entry.startedAt),
        }));
        return {
            activeCount: this.activeCount,
            active,
            overflowCount: Math.max(0, this.activeCount - active.length),
            lastReceived: this.lastReceived ? { ...this.lastReceived, ageMs: Math.max(0, now - this.lastReceived.receivedAt) } : null,
            recentFinished: this.recentFinished.map((entry) => ({ ...entry })),
        };
    }

    clear(): void {
        this.activeCount = 0;
        this.visible.clear();
        this.lastReceived = null;
        this.recentFinished.length = 0;
    }
}
