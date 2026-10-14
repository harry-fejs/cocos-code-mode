import { ToolError } from '../tool-error';

export const MAX_TRANSIENT_RETRIES = 3;
const RETRYABLE_CODES = new Set(['RUNTIME_STATE_TIMEOUT', 'RUNTIME_NOT_READY', 'ASSET_QUERY_FAILED', 'BUILD_TASK_QUERY_FAILED']);

export function isRetrySafeTransient(error: unknown): boolean {
    return error instanceof ToolError
        && error.details?.mutationDispatched !== true
        && error.details?.outcome !== 'unknown'
        && error.details?.submission !== 'outcome-unknown'
        && error.details?.pendingMayComplete !== true
        && error.details?.retrySafe === true
        && RETRYABLE_CODES.has(error.code);
}

export async function retryTransient<T>(operation: () => Promise<T>, options: { attempts?: number; delayMs?: number; deadline?: number } = {}): Promise<T> {
    if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > MAX_TRANSIENT_RETRIES)
        || options.delayMs !== undefined && (!Number.isFinite(options.delayMs) || options.delayMs < 0 || options.delayMs > 1000)
        || options.deadline !== undefined && !Number.isFinite(options.deadline)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Retry attempts must be1..3 and delayMs finite within0..1000.' });
    }
    const attempts = Math.min(Math.max(options.attempts ?? MAX_TRANSIENT_RETRIES, 1), MAX_TRANSIENT_RETRIES);
    const delayMs = Math.min(Math.max(options.delayMs ?? 100, 0), 1000);
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
            if (last !== undefined) throw last;
            throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Observation deadline elapsed before retry dispatch.' });
        }
        try {
            return await operation();
        } catch (error) {
            last = error;
            if (!isRetrySafeTransient(error) || attempt === attempts - 1) throw error;
            const waitMs = delayMs * (attempt + 1);
            if (options.deadline !== undefined && Date.now() + waitMs >= options.deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
    throw last;
}
