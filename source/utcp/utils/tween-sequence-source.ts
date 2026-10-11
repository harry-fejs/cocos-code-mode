import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { ToolError } from '../tool-error';
import { MAX_TWEEN_BYTES } from './tween-sequence-model';

export interface TweenProjectPath { filePath: string; file: string; url: string }
export interface TweenAssetInfo { uuid: string; url: string; file: string }
export function resolveTweenPath(input: unknown): TweenProjectPath {
    if (typeof input !== 'string' || input.length > 512 || !/^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.ts$/.test(input)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'filePath must be an exact project-relative assets/.../*.ts path with bounded safe segments.' });
    const project = typeof Editor.Project?.path === 'string' ? Editor.Project.path : '';
    if (!project) throw new ToolError({ code: 'PROJECT_UNAVAILABLE', status: 503, message: 'An open Creator project is required.' });
    try {
        const root = fs.realpathSync(project);
        const file = path.resolve(root, input);
        const parent = fs.realpathSync(path.dirname(file));
        const relative = path.relative(root, parent);
        if (relative !== 'assets' && !relative.startsWith(`assets${path.sep}`)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Tween path parent escapes the project assets boundary.' });
        if (!fs.statSync(parent).isDirectory()) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Tween path parent must be an existing directory.' });
        // Resolve writes against the real parent; reject aliases to preserve exact Asset DB identity.
        if (path.resolve(parent, path.basename(file)) !== file) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Symlinked tween asset directories are not supported.' });
        return { filePath: input, file, url: `db://${input}` };
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Tween path requires an existing accessible project assets directory.' });
    }
}
export async function queryTweenAsset(url: string): Promise<TweenAssetInfo | null> {
    try { return await Editor.Message.request('asset-db', 'query-asset-info', url) as TweenAssetInfo | null; }
    catch { throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Authoritative Asset DB query failed; tween source identity is unconfirmed.' }); }
}
export function refuseTweenConflict(source: TweenProjectPath, info: TweenAssetInfo | null): void {
    if (info || fs.existsSync(source.file) || fs.existsSync(`${source.file}.meta`)) throw new ToolError({ code: 'TWEEN_SOURCE_CONFLICT', status: 409, message: 'Tween create never overwrites or renames an existing source or metadata file.', details: { filePath: source.filePath } });
    // existsSync follows links, so also refuse dangling symlink collisions.
    for (const file of [source.file, `${source.file}.meta`]) {
        try { fs.lstatSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new ToolError({ code: 'TWEEN_SOURCE_ACCESS_FAILED', status: 502, message: 'Cannot confirm absence of the requested tween source or metadata; no mutation was attempted.' }); }
        throw new ToolError({ code: 'TWEEN_SOURCE_CONFLICT', status: 409, message: 'Tween create refuses existing filesystem entries.' });
    }
}
export async function readTweenSource(source: TweenProjectPath): Promise<{ code: string; identity: { kind: 'typescript'; filePath: string; assetUrl: string; uuid: string; sha256: string; bytes: number; descriptorLine: number } }> {
    const info = await queryTweenAsset(source.url);
    if (!info) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Tween project code was not found in Asset DB.', details: { filePath: source.filePath } });
    if (!info.uuid || info.url !== source.url || typeof info.file !== 'string' || path.resolve(info.file) !== source.file) throw new ToolError({ code: 'TWEEN_SOURCE_IDENTITY_MISMATCH', status: 502, message: 'Asset DB did not confirm the exact requested project TypeScript source.' });
    let fd: number | undefined;
    try {
        if (fs.lstatSync(source.file).isSymbolicLink()) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Symlink tween sources are not supported.' });
        fd = fs.openSync(source.file, 'r');
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Tween source must be a regular file.' });
        if (stat.size > MAX_TWEEN_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Tween source exceeds 64 KiB.' });
        const buffer = Buffer.alloc(MAX_TWEEN_BYTES + 1);
        let count = 0;
        while (count < buffer.length) {
            const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
            if (!read) break;
            count += read;
        }
        if (count > MAX_TWEEN_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Tween source exceeds 64 KiB.' });
        const bytes = buffer.subarray(0, count);
        return { code: bytes.toString('utf8'), identity: { kind: 'typescript', filePath: source.filePath, assetUrl: source.url, uuid: info.uuid, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: count, descriptorLine: 1 } };
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'TWEEN_SOURCE_READ_FAILED', status: 502, message: 'Authoritative tween source read-back failed.' });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
