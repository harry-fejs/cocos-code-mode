import fs from 'fs-extra';
import { createHash } from 'crypto';
import { ToolError } from './utcp/tool-error';

const MAX_BYTES = 5 * 1024 * 1024;
export async function readGraphSnapshot(file: unknown) {
    if (typeof file !== 'string' || !file) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: 'Graph source path unavailable.' });
    const handle = await fs.open(file, 'r');
    try {
        const before = await fs.fstat(handle);
        if (!before.isFile()) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: 'Graph source is not a file.' });
        if (before.size > MAX_BYTES) throw new ToolError({ code: 'SOURCE_TOO_LARGE', status: 422, message: 'Graph source exceeds 5 MiB.' });
        const bytes = Buffer.allocUnsafe(before.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const { bytesRead } = await fs.read(handle, bytes, count, bytes.length - count, null);
            if (!bytesRead) break;
            count += bytesRead;
        }
        const after = await fs.fstat(handle); const current = await fs.stat(file);
        if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
            throw new ToolError({ code: 'GRAPH_SOURCE_CHANGED', status: 409, message: 'Graph source changed while reading; inspect again without mutation.' });
        }
        const content = bytes.subarray(0, count);
        let value: unknown;
        try { value = JSON.parse(content.toString('utf8')); }
        catch { throw new ToolError({ code: 'SOURCE_INVALID', status: 422, message: 'Graph source is not valid JSON.' }); }
        return { value, sourceSha256: createHash('sha256').update(content).digest('hex') };
    } finally { await fs.close(handle); }
}
