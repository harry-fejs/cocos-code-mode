import { utcpTool } from '../decorators';
import { invalidateAfterWrite } from '../utils/memo-cache';
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { VERBOSE_FILE_BYTES, VERBOSE_SEARCH_LIMIT } from '../utils/verbose';
import { ToolError } from '../tool-error';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = VERBOSE_FILE_BYTES;
const MAX_PATH_LENGTH = 4096;
const MAX_SEARCH_PATTERN_LENGTH = 256;
const MAX_SEARCH_RESULTS = 100;
const DEFAULT_DIRECTORY_ENTRIES = 200;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_SEARCH_ENTRIES = 100000;

function boundedPositive(value: unknown, fallback: number, maximum: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? Math.min(value, maximum)
        : fallback;
}

function projectRoot(): string {
    const project = Reflect.get(Editor, 'Project');
    const root = project && typeof project === 'object' ? Reflect.get(project, 'path') : undefined;
    if (typeof root !== 'string' || !root || root.length > MAX_PATH_LENGTH) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Editor project path is unavailable.' });
    }
    return path.resolve(root);
}

function assertInside(root: string, candidate: string, input: string): string {
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ToolError({
            code: 'INVALID_ARGUMENT',
            status: 400,
            message: `Path escapes project boundary: ${input}`,
            details: { path: input },
            recovery: 'Pass a path relative to the open project without parent-directory traversal.',
        });
    }
    return candidate;
}

function resolveSafePath(projectPath: string, relPath: string): string {
    if (typeof relPath !== 'string' || !relPath || relPath.length > MAX_PATH_LENGTH || /[\u0000\r\n]/.test(relPath)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Project path must be a non-empty bounded string.' });
    }
    if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Project paths must be relative, without drive-qualified or absolute paths.' });
    if (path.sep === '\\' && relPath.includes(':')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Windows project paths must not address alternate data streams.' });
    const root = path.resolve(projectPath);
    const resolved = assertInside(root, path.resolve(root, relPath), relPath);
    let probe = resolved;
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    try {
        const realRoot = fs.realpathSync(root);
        const realProbe = fs.realpathSync(probe);
        assertInside(realRoot, realProbe, relPath);
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Cannot resolve project path safely: ${relPath}` });
    }
    return resolved;
}
function readBoundedProjectText(filePath: string, cap: number): { content: string, bytes: number } {
    const realPath = fs.realpathSync(filePath);
    const handle = fs.openSync(realPath, 'r');
    try {
        const before = fs.fstatSync(handle);
        if (!before.isFile()) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Path is not a regular file.' });
        if (before.size > cap) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `File too large (${before.size} bytes, cap ${cap}).` });
        const buffer = Buffer.allocUnsafe(before.size + 1);
        let count = 0;
        while (count < buffer.length) {
            const read = fs.readSync(handle, buffer, count, buffer.length - count, null);
            if (!read) break;
            count += read;
        }
        const after = fs.fstatSync(handle);
        const current = fs.statSync(realPath);
        if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
            || fs.realpathSync(filePath) !== realPath) {
            throw new ToolError({ code: 'FILE_CHANGED_DURING_READ', status: 409, message: 'Project file changed during bounded read.' });
        }
        const content = buffer.subarray(0, count).toString('utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > cap) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `File content exceeds the ${cap} byte cap.` });
        return { content, bytes };
    } finally { fs.closeSync(handle); }
}

function requireUtf8RoundTrip(content: string): void {
    for (let index = 0; index < content.length; index++) {
        const code = content.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = content.charCodeAt(++index);
            if (next >= 0xdc00 && next <= 0xdfff) continue;
        } else if (code < 0xdc00 || code > 0xdfff) continue;
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'File text contains an unpaired surrogate and cannot round-trip UTF-8; no write dispatched.' });
    }
}

function atomicWriteVerified(filePath: string, content: string): number {
    requireUtf8RoundTrip(content);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
        throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `File content exceeds the ${MAX_WRITE_BYTES} byte cap.` });
    }
    let existingMode: number | undefined;
    if (process.platform !== 'win32') {
        try {
            const existing = fs.lstatSync(filePath);
            if (existing.isFile()) existingMode = existing.mode & 0o777;
        } catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
    }
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.ccp3x-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    let tempOwned = false;
    try {
        const handle = fs.openSync(tempPath, 'wx');
        tempOwned = true;
        try {
            fs.writeFileSync(handle, content, 'utf8');
            if (existingMode !== undefined) fs.fchmodSync(handle, existingMode);
        }
        finally { fs.closeSync(handle); }
        fs.renameSync(tempPath, filePath);
        tempOwned = false;
        const { content: readBack } = readBoundedProjectText(filePath, MAX_WRITE_BYTES);
        if (readBack !== content) {
            throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `File write read-back did not match ${filePath}.` });
        }
        return bytes;
    } finally {
        try { if (tempOwned) fs.unlinkSync(tempPath); } catch { /* best effort cleanup of our own temporary file */ }
    }
}

export class FileTools {
    @utcpTool('projectReadFile', 'Read a bounded UTF-8 text file from the project directory.', {
        type: 'object', properties: { filePath: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['filePath'],
    }, { type: 'object', properties: { content: { type: 'string' }, bytes: { type: 'number' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['content', 'bytes', 'sha256'] }, 'GET', ['file', 'read', 'project', 'text'])
    async projectReadFile(args: { filePath: string, verbose?: boolean }): Promise<{ content: string, bytes: number, sha256: string }> {
        const root = projectRoot();
        const filePath = resolveSafePath(root, args.filePath);
        if (!fs.existsSync(filePath)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `File not found: ${args.filePath}` });
        const cap = args.verbose === true ? VERBOSE_FILE_BYTES : MAX_FILE_BYTES;
        const result = readBoundedProjectText(filePath, cap);
        return { ...result, sha256: createHash('sha256').update(result.content, 'utf8').digest('hex') };
    }

    @utcpTool('projectWriteFile', 'Atomically write bounded UTF-8 text within the project and verify read-back.', {
        type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' }, createDirs: { type: 'boolean' }, expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Optional decoded-text revision from projectReadFile; requires an existing matching file before mutation, not atomic compare-and-set.' } }, required: ['filePath', 'content'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, bytesWritten: { type: 'number' }, sha256: { type: 'string' } }, required: ['success', 'bytesWritten', 'sha256'] }, 'POST', ['file', 'write', 'project', 'text'])
    async projectWriteFile(args: { filePath: string, content: string, createDirs?: boolean, expectedSha256?: string }): Promise<{ success: boolean, bytesWritten: number, sha256: string }> {
        const root = projectRoot();
        if (typeof args.content !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'content must be a string.' });
        if (args.createDirs !== undefined && typeof args.createDirs !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'createDirs must be a boolean.' });
        if (Buffer.byteLength(args.content, 'utf8') > MAX_WRITE_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `File content exceeds the ${MAX_WRITE_BYTES} byte cap.` });
        requireUtf8RoundTrip(args.content);
        if (args.expectedSha256 !== undefined && (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedSha256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedSha256 must be a lowercase SHA-256 of decoded UTF-8 text.' });
        const filePath = resolveSafePath(root, args.filePath);
        if (args.expectedSha256 !== undefined) {
            if (!fs.existsSync(filePath)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Guarded write requires an existing file; no write dispatched.' });
            const previous = readBoundedProjectText(filePath, MAX_WRITE_BYTES);
            if (createHash('sha256').update(previous.content, 'utf8').digest('hex') !== args.expectedSha256) throw new ToolError({ code: 'FILE_CONTENT_CHANGED', status: 409, message: 'Project file text differs from expectedSha256; no write dispatched.' });
        }
        if (args.createDirs !== false) fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const bytesWritten = atomicWriteVerified(filePath, args.content);
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        if (relative.startsWith('assets/')) {
            try { await Editor.Message.request('asset-db', 'refresh-asset', `db://${relative}`); } catch { /* write/read-back remain authoritative */ }
            invalidateAfterWrite();
        }
        return { success: true, bytesWritten, sha256: createHash('sha256').update(args.content, 'utf8').digest('hex') };
    }

    @utcpTool('projectSearchFiles', 'Search bounded project files by glob-like pattern, optionally scoped to a project directory.', {
        type: 'object', properties: { pattern: { type: 'string' }, directory: { type: 'string' }, limit: { type: 'number' }, verbose: { type: 'boolean' } }, required: ['pattern'],
    }, { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['files', 'total', 'truncated'] }, 'GET', ['file', 'search', 'find', 'project'])
    async projectSearchFiles(args: { pattern: string, directory?: string, limit?: number, verbose?: boolean }): Promise<{ files: string[], total: number, truncated: boolean }> {
        const maximum = args.verbose === true ? VERBOSE_SEARCH_LIMIT : 500;
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > maximum)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Search limit must be an integer from 1 to ${maximum}.` });
        const root = projectRoot();
        if (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > MAX_SEARCH_PATTERN_LENGTH || /[\u0000\r\n]/.test(args.pattern)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'pattern must be a bounded non-empty string.' });
        }
        const scope = resolveSafePath(root, args.directory ?? '.');
        if (!fs.existsSync(scope) || !fs.statSync(scope).isDirectory()) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Directory not found: ${args.directory ?? '.'}` });
        const limit = boundedPositive(args.limit, args.verbose === true ? VERBOSE_SEARCH_LIMIT : MAX_SEARCH_RESULTS, maximum);
        const regexText = args.pattern.replace(/\*\*|\*|[.?+^${}()|[\]\\]/g, token =>
            token === '**' ? '.*' : token === '*' ? '[^/]*' : `\\${token}`);
        const regex = new RegExp(`^${regexText}$`, 'i');
        const files: string[] = [];
        let truncated = false;
        const stack: Array<{ directory: string; handle: fs.Dir }> = [];
        let visitedEntries = 0;
        const realRoot = fs.realpathSync(root);
        const openDirectory = async (directory: string) => {
            try {
                const realDirectory = fs.realpathSync(directory);
                assertInside(realRoot, realDirectory, path.relative(root, directory));
                return await fs.opendir(realDirectory);
            }
            catch (error) {
                if (error instanceof ToolError) throw error;
                throw new ToolError({ code: 'PROJECT_SEARCH_FAILED', status: 503, message: 'A project directory could not be read; search results are incomplete.', recovery: 'Check directory availability and permissions before retrying the read-only search.' });
            }
        };
        let traversalFailed = false;
        try {
            stack.push({ directory: scope, handle: await openDirectory(scope) });
            while (stack.length) {
                const frame = stack[stack.length - 1];
                let entry: fs.Dirent | null;
                try { entry = await frame.handle.read(); }
                catch {
                    throw new ToolError({ code: 'PROJECT_SEARCH_FAILED', status: 503, message: 'A project directory could not be read; search results are incomplete.' });
                }
                if (!entry) {
                    try { await frame.handle.close(); }
                    catch { throw new ToolError({ code: 'PROJECT_SEARCH_CLOSE_FAILED', status: 503, message: 'Search directory cleanup could not be confirmed.' }); }
                    stack.pop();
                    continue;
                }
                if (++visitedEntries > MAX_SEARCH_ENTRIES) {
                    throw new ToolError({ code: 'PROJECT_SEARCH_LIMIT', status: 413, message: 'Project search exceeded the 100000-entry traversal limit.', recovery: 'Select a narrower directory before searching again.' });
                }
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'library' || entry.name === 'temp') continue;
                const fullPath = path.join(frame.directory, entry.name);
                const relative = path.relative(root, fullPath).replace(/\\/g, '/');
                if (entry.isDirectory()) {
                    if (stack.length >= 128) throw new ToolError({ code: 'PROJECT_SEARCH_LIMIT', status: 413, message: 'Project search exceeded the 128-directory nesting limit.', recovery: 'Select a narrower directory before searching again.' });
                    stack.push({ directory: fullPath, handle: await openDirectory(fullPath) });
                }
                else if (entry.isFile() && (regex.test(relative) || (args.directory && regex.test(path.relative(scope, fullPath).replace(/\\/g, '/'))))) {
                    if (files.length === limit) { truncated = true; break; }
                    files.push(relative);
                }
            }
            return { files, total: files.length, truncated };
        } catch (error) {
            traversalFailed = true;
            throw error;
        } finally {
            const closures = await Promise.allSettled(stack.map(async ({ handle }) => { await handle.close(); }));
            if (!traversalFailed && closures.some(result => result.status === 'rejected')) throw new ToolError({ code: 'PROJECT_SEARCH_CLOSE_FAILED', status: 503, message: 'Search directory cleanup could not be confirmed.' });
        }
    }

    @utcpTool('projectReplaceInFile', 'Atomically replace bounded literal text in a project file and verify read-back.', {
        type: 'object', properties: { filePath: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, replaceAll: { type: 'boolean' }, expectedOccurrences: { type: 'integer', minimum: 0, maximum: MAX_FILE_BYTES, description: 'Required total non-overlapping literal matches, independently of replaceAll. Empty search counts as zero.' }, expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'SHA-256 of decoded UTF-8 text from projectReadFile; optimistic precondition, not atomic compare-and-set.' } }, required: ['filePath', 'search', 'replace'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, replacements: { type: 'number' }, sha256: { type: 'string' } }, required: ['success', 'replacements', 'sha256'] }, 'POST', ['file', 'replace', 'edit', 'project'])
    async projectReplaceInFile(args: { filePath: string, search: string, replace: string, replaceAll?: boolean, expectedSha256?: string, expectedOccurrences?: number }): Promise<{ success: boolean, replacements: number, sha256: string }> {
        if (typeof args.search !== 'string' || typeof args.replace !== 'string' || args.search.length > MAX_SEARCH_PATTERN_LENGTH || args.replace.length > MAX_WRITE_BYTES) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'search and replace must be bounded strings.' });
        if (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'replaceAll must be a boolean; no replacement dispatched.' });
        if (args.expectedSha256 !== undefined && (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedSha256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedSha256 must be a lowercase SHA-256 of decoded UTF-8 text.' });
        if (args.expectedOccurrences !== undefined && (!Number.isInteger(args.expectedOccurrences) || args.expectedOccurrences < 0 || args.expectedOccurrences > MAX_FILE_BYTES)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedOccurrences must be an integer from 0 to 524288.' });
        const root = projectRoot();
        const filePath = resolveSafePath(root, args.filePath);
        if (!fs.existsSync(filePath)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `File not found: ${args.filePath}` });
        const { content } = readBoundedProjectText(filePath, MAX_FILE_BYTES);
        if (args.expectedSha256 !== undefined && createHash('sha256').update(content, 'utf8').digest('hex') !== args.expectedSha256) throw new ToolError({ code: 'FILE_CONTENT_CHANGED', status: 409, message: 'Project file text differs from expectedSha256; no replacement dispatched.' });
        if (args.expectedOccurrences !== undefined) {
            let occurrences = 0;
            if (args.search) {
                let offset = 0;
                let found: number;
                while ((found = content.indexOf(args.search, offset)) !== -1) {
                    occurrences++;
                    offset = found + args.search.length;
                }
            }
            if (occurrences !== args.expectedOccurrences) throw new ToolError({ code: 'FILE_MATCH_COUNT_CHANGED', status: 409, message: 'Literal match count differs from expectedOccurrences; no replacement dispatched.', details: { expected: args.expectedOccurrences, observed: occurrences } });
        }
        if (!args.search) return { success: false, replacements: 0, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
        const replaceAll = args.replaceAll !== false;
        let next = content;
        let replacements = 0;
        const parts = replaceAll ? content.split(args.search) : [];
        if (replaceAll) replacements = parts.length - 1;
        else {
            const index = content.indexOf(args.search);
            if (index >= 0) {
                replacements = 1;
                parts.push(content.slice(0, index), content.slice(index + args.search.length));
            }
        }
        if (replacements) {
            let bytes = 0;
            let lastCode = 0;
            const replacementBytes = Buffer.byteLength(args.replace, 'utf8');
            const countBytes = (text: string, textBytes = Buffer.byteLength(text, 'utf8')) => {
                if (!text.length) return;
                bytes += textBytes;
                const firstCode = text.charCodeAt(0);
                if (lastCode >= 0xd800 && lastCode <= 0xdbff && firstCode >= 0xdc00 && firstCode <= 0xdfff) bytes -= 2;
                lastCode = text.charCodeAt(text.length - 1);
            };
            for (let index = 0; index < parts.length; index++) {
                if (index) countBytes(args.replace, replacementBytes);
                countBytes(parts[index]);
            }
            if (bytes > MAX_WRITE_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `Replacement output exceeds the ${MAX_WRITE_BYTES} byte cap.` });
            next = parts.join(args.replace);
        }
        if (!replacements) return { success: false, replacements: 0, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
        atomicWriteVerified(filePath, next);
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        if (relative.startsWith('assets/')) {
            try { await Editor.Message.request('asset-db', 'refresh-asset', `db://${relative}`); } catch { /* write/read-back remain authoritative */ }
            invalidateAfterWrite();
        }
        return { success: true, replacements, sha256: createHash('sha256').update(next, 'utf8').digest('hex') };
    }

    @utcpTool('projectFileSnippet', 'Read a bounded line snippet from a project file.', {
        type: 'object', properties: { filePath: { type: 'string' }, line: { type: 'integer', minimum: 1 }, radius: { type: 'integer', minimum: 0, maximum: 50 }, expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['filePath', 'line'],
    }, { type: 'object', properties: { snippet: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['snippet', 'startLine', 'endLine', 'sha256'] }, 'GET', ['file', 'snippet', 'project'])
    async projectFileSnippet(args: { filePath: string, line: number, radius?: number, expectedSha256?: string }): Promise<{ snippet: string, startLine: number, endLine: number, sha256: string }> {
        const root = projectRoot();
        const radius = args.radius === undefined ? 5 : args.radius;
        if (!Number.isInteger(args.line) || args.line < 1 || !Number.isInteger(radius) || radius < 0 || radius > 50) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'line must be positive and radius must be an integer from 0 to 50.' });
        if (args.expectedSha256 !== undefined && (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedSha256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedSha256 must be a lowercase SHA-256 of decoded UTF-8 text.' });
        const filePath = resolveSafePath(root, args.filePath);
        if (!fs.existsSync(filePath)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `File not found: ${args.filePath}` });
        const { content } = readBoundedProjectText(filePath, MAX_FILE_BYTES);
        const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
        if (args.expectedSha256 !== undefined && args.expectedSha256 !== sha256) throw new ToolError({ code: 'FILE_CONTENT_CHANGED', status: 409, message: 'Project text revision changed; restart snippet reading.' });
        const lines = content.split(/\r?\n/);
        if (args.line > lines.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Requested line exceeds the source line count (${lines.length}).` });
        const startLine = Math.max(1, args.line - radius);
        const endLine = Math.min(lines.length, args.line + radius);
        return { snippet: lines.slice(startLine - 1, endLine).join('\n'), startLine, endLine, sha256 };
    }

    @utcpTool('projectFileExists', 'Check bounded project-relative file or directory existence.', { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }, { type: 'object', properties: { exists: { type: 'boolean' }, isDirectory: { type: 'boolean' } }, required: ['exists', 'isDirectory'] }, 'GET', ['file', 'exists', 'project'])
    async projectFileExists(args: { filePath: string }): Promise<{ exists: boolean, isDirectory: boolean }> {
        const filePath = resolveSafePath(projectRoot(), args.filePath);
        try {
            const stat = fs.statSync(filePath);
            return { exists: true, isDirectory: stat.isDirectory() };
        } catch (error: unknown) {
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
            if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, isDirectory: false };
            throw new ToolError({ code: 'PROJECT_FILE_STAT_FAILED', status: 503, message: 'Project path metadata could not be read.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }

    @utcpTool('projectListDirectory', 'List bounded entries in a project-relative directory.', { type: 'object', properties: { dirPath: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: MAX_DIRECTORY_ENTRIES } } }, { type: 'object', properties: { entries: { type: 'array' }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['entries', 'total', 'truncated'] }, 'GET', ['file', 'list', 'directory', 'project'])
    async projectListDirectory(args: { dirPath?: string, limit?: number }): Promise<{ entries: { name: string, type: 'file' | 'directory', size?: number }[], total: number, truncated: boolean }> {
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_DIRECTORY_ENTRIES)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Directory limit must be an integer from 1 to 1000.' });
        const directory = resolveSafePath(projectRoot(), args.dirPath ?? '.');
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Directory not found: ${args.dirPath ?? '.'}` });
        const limit = boundedPositive(args.limit, DEFAULT_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES);
        const entries: { name: string, type: 'file' | 'directory', size?: number }[] = [];
        let handle: fs.Dir;
        try { handle = await fs.opendir(directory); }
        catch { throw new ToolError({ code: 'PROJECT_DIRECTORY_READ_FAILED', status: 503, message: 'A project directory could not be opened.', recovery: 'Check directory availability and permissions before retrying the read-only listing.' }); }
        let closeError: unknown;
        let total = 0;
        try {
            let entry: fs.Dirent | null;
            for (;;) {
                try { entry = await handle.read(); }
                catch { throw new ToolError({ code: 'PROJECT_DIRECTORY_READ_FAILED', status: 503, message: 'Project directory enumeration failed; results are incomplete.' }); }
                if (entry === null) break;
                if (++total > MAX_SEARCH_ENTRIES) throw new ToolError({ code: 'PROJECT_DIRECTORY_LIMIT', status: 413, message: 'Directory listing exceeded the 100000-entry traversal limit.' });
                if (entries.length >= limit) continue;
                let stat: fs.Stats;
                try { stat = fs.lstatSync(path.join(directory, entry.name)); }
                catch { throw new ToolError({ code: 'PROJECT_DIRECTORY_ENTRY_FAILED', status: 503, message: `A directory entry could not be inspected: ${entry.name}.` }); }
                if (!stat.isFile() && !stat.isDirectory()) throw new ToolError({ code: 'PROJECT_DIRECTORY_ENTRY_UNSUPPORTED', status: 422, message: `Directory entry is not a regular file or directory: ${entry.name}.` });
                entries.push({ name: entry.name, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : undefined });
            }
        } finally { try { await handle.close(); } catch (error) { closeError = error; } }
        if (closeError) throw new ToolError({ code: 'PROJECT_DIRECTORY_CLOSE_FAILED', status: 503, message: 'Project directory handle could not be closed.' });
        return { entries, total, truncated: total > entries.length };
    }
}
