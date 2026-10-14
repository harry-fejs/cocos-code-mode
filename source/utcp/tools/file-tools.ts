import { utcpTool } from '../decorators';
import { invalidateAfterWrite } from '../utils/memo-cache';
import fs from 'fs-extra';
import path from 'path';
import { VERBOSE_FILE_BYTES, VERBOSE_SEARCH_LIMIT } from '../utils/verbose';
import { ToolError } from '../tool-error';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = VERBOSE_FILE_BYTES;
const MAX_PATH_LENGTH = 4096;
const MAX_SEARCH_PATTERN_LENGTH = 256;
const MAX_SEARCH_RESULTS = 100;
const DEFAULT_DIRECTORY_ENTRIES = 200;
const MAX_DIRECTORY_ENTRIES = 1000;

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
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
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

function atomicWriteVerified(filePath: string, content: string): number {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
        throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `File content exceeds the ${MAX_WRITE_BYTES} byte cap.` });
    }
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.ccp3x-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
        fs.writeFileSync(tempPath, content, 'utf8');
        fs.renameSync(tempPath, filePath);
        const readBack = fs.readFileSync(filePath, 'utf8');
        if (readBack !== content) {
            throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `File write read-back did not match ${filePath}.` });
        }
        return bytes;
    } finally {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* best effort cleanup */ }
    }
}

export class FileTools {
    @utcpTool('projectReadFile', 'Read a bounded UTF-8 text file from the project directory.', {
        type: 'object', properties: { filePath: { type: 'string' }, verbose: { type: 'boolean' } }, required: ['filePath'],
    }, { type: 'object', properties: { content: { type: 'string' }, bytes: { type: 'number' } }, required: ['content', 'bytes'] }, 'GET', ['file', 'read', 'project', 'text'])
    async projectReadFile(args: { filePath: string, verbose?: boolean }): Promise<{ content: string, bytes: number }> {
        const root = projectRoot();
        const filePath = resolveSafePath(root, args.filePath);
        if (!fs.existsSync(filePath)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `File not found: ${args.filePath}` });
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Path is not a regular file: ${args.filePath}` });
        const cap = args.verbose === true ? VERBOSE_FILE_BYTES : MAX_FILE_BYTES;
        if (stat.size > cap) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `File too large (${stat.size} bytes, cap ${cap}).` });
        const content = fs.readFileSync(filePath, 'utf8');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > cap) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: `File content exceeds the ${cap} byte cap.` });
        return { content, bytes };
    }

    @utcpTool('projectWriteFile', 'Atomically write bounded UTF-8 text within the project and verify read-back.', {
        type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' }, createDirs: { type: 'boolean' } }, required: ['filePath', 'content'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, bytesWritten: { type: 'number' } }, required: ['success', 'bytesWritten'] }, 'POST', ['file', 'write', 'project', 'text'])
    async projectWriteFile(args: { filePath: string, content: string, createDirs?: boolean }): Promise<{ success: boolean, bytesWritten: number }> {
        const root = projectRoot();
        if (typeof args.content !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'content must be a string.' });
        const filePath = resolveSafePath(root, args.filePath);
        if (args.createDirs !== false) fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const bytesWritten = atomicWriteVerified(filePath, args.content);
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        if (relative.startsWith('assets/')) {
            try { await Editor.Message.request('asset-db', 'refresh-asset', `db://${relative}`); } catch { /* write/read-back remain authoritative */ }
            invalidateAfterWrite();
        }
        return { success: true, bytesWritten };
    }

    @utcpTool('projectSearchFiles', 'Search bounded project files by glob-like pattern, optionally scoped to a project directory.', {
        type: 'object', properties: { pattern: { type: 'string' }, directory: { type: 'string' }, limit: { type: 'number' }, verbose: { type: 'boolean' } }, required: ['pattern'],
    }, { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['files', 'total', 'truncated'] }, 'GET', ['file', 'search', 'find', 'project'])
    async projectSearchFiles(args: { pattern: string, directory?: string, limit?: number, verbose?: boolean }): Promise<{ files: string[], total: number, truncated: boolean }> {
        const root = projectRoot();
        if (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > MAX_SEARCH_PATTERN_LENGTH || /[\u0000\r\n]/.test(args.pattern)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'pattern must be a bounded non-empty string.' });
        }
        const scope = resolveSafePath(root, args.directory ?? '.');
        if (!fs.existsSync(scope) || !fs.statSync(scope).isDirectory()) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Directory not found: ${args.directory ?? '.'}` });
        const maximum = args.verbose === true ? VERBOSE_SEARCH_LIMIT : 500;
        const limit = boundedPositive(args.limit, args.verbose === true ? VERBOSE_SEARCH_LIMIT : MAX_SEARCH_RESULTS, maximum);
        const regexText = args.pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '<<<GLOBSTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<GLOBSTAR>>>/g, '.*');
        const regex = new RegExp(`^${regexText}$`, 'i');
        const files: string[] = [];
        const walk = (directory: string): void => {
            if (files.length >= limit) return;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
            catch {
                throw new ToolError({ code: 'PROJECT_SEARCH_FAILED', status: 503, message: 'A project directory could not be read; search results are incomplete.', recovery: 'Check directory availability and permissions before retrying the read-only search.' });
            }
            for (const entry of entries) {
                if (files.length >= limit) return;
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'library' || entry.name === 'temp') continue;
                const fullPath = path.join(directory, entry.name);
                const relative = path.relative(root, fullPath).replace(/\\/g, '/');
                if (entry.isDirectory()) walk(fullPath);
                else if (regex.test(relative) || (args.directory && regex.test(path.relative(scope, fullPath).replace(/\\/g, '/')))) files.push(relative);
            }
        };
        walk(scope);
        return { files, total: files.length, truncated: files.length >= limit };
    }

    @utcpTool('projectReplaceInFile', 'Atomically replace bounded literal text in a project file and verify read-back.', {
        type: 'object', properties: { filePath: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['filePath', 'search', 'replace'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, replacements: { type: 'number' } }, required: ['success', 'replacements'] }, 'POST', ['file', 'replace', 'edit', 'project'])
    async projectReplaceInFile(args: { filePath: string, search: string, replace: string, replaceAll?: boolean }): Promise<{ success: boolean, replacements: number }> {
        if (typeof args.search !== 'string' || typeof args.replace !== 'string' || args.search.length > MAX_SEARCH_PATTERN_LENGTH || args.replace.length > MAX_WRITE_BYTES) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'search and replace must be bounded strings.' });
        const root = projectRoot();
        const filePath = resolveSafePath(root, args.filePath);
        if (!fs.existsSync(filePath)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `File not found: ${args.filePath}` });
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Replacement source must be a regular file within the bounded file size.' });
        const content = fs.readFileSync(filePath, 'utf8');
        if (!args.search) return { success: false, replacements: 0 };
        const replaceAll = args.replaceAll !== false;
        let next = content;
        let replacements = 0;
        if (replaceAll) {
            const parts = content.split(args.search);
            replacements = parts.length - 1;
            next = parts.join(args.replace);
        } else {
            const index = content.indexOf(args.search);
            if (index >= 0) { replacements = 1; next = content.slice(0, index) + args.replace + content.slice(index + args.search.length); }
        }
        if (!replacements) return { success: false, replacements: 0 };
        atomicWriteVerified(filePath, next);
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        if (relative.startsWith('assets/')) {
            try { await Editor.Message.request('asset-db', 'refresh-asset', `db://${relative}`); } catch { /* write/read-back remain authoritative */ }
            invalidateAfterWrite();
        }
        return { success: true, replacements };
    }

    @utcpTool('projectFileSnippet', 'Read a bounded line snippet from a project file.', {
        type: 'object', properties: { filePath: { type: 'string' }, line: { type: 'integer', minimum: 1 }, radius: { type: 'integer', minimum: 0, maximum: 50 } }, required: ['filePath', 'line'],
    }, { type: 'object', properties: { snippet: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['snippet', 'startLine', 'endLine'] }, 'GET', ['file', 'snippet', 'project'])
    async projectFileSnippet(args: { filePath: string, line: number, radius?: number }): Promise<{ snippet: string, startLine: number, endLine: number }> {
        const root = projectRoot();
        const radius = args.radius === undefined ? 5 : args.radius;
        if (!Number.isInteger(args.line) || args.line < 1 || !Number.isInteger(radius) || radius < 0 || radius > 50) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'line must be positive and radius must be an integer from 0 to 50.' });
        const filePath = resolveSafePath(root, args.filePath);
        if (!fs.existsSync(filePath)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `File not found: ${args.filePath}` });
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Snippet source must be a regular file within the bounded file size.' });
        const content = fs.readFileSync(filePath, 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Snippet content exceeds the bounded file size.' });
        const lines = content.split(/\r?\n/);
        if (args.line > lines.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Requested line exceeds the source line count (${lines.length}).` });
        const startLine = Math.max(1, args.line - radius);
        const endLine = Math.min(lines.length, args.line + radius);
        return { snippet: lines.slice(startLine - 1, endLine).join('\n'), startLine, endLine };
    }

    @utcpTool('projectFileExists', 'Check bounded project-relative file or directory existence.', { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }, { type: 'object', properties: { exists: { type: 'boolean' }, isDirectory: { type: 'boolean' } }, required: ['exists', 'isDirectory'] }, 'GET', ['file', 'exists', 'project'])
    async projectFileExists(args: { filePath: string }): Promise<{ exists: boolean, isDirectory: boolean }> {
        const filePath = resolveSafePath(projectRoot(), args.filePath);
        if (!fs.existsSync(filePath)) return { exists: false, isDirectory: false };
        return { exists: true, isDirectory: fs.statSync(filePath).isDirectory() };
    }

    @utcpTool('projectListDirectory', 'List bounded entries in a project-relative directory.', { type: 'object', properties: { dirPath: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: MAX_DIRECTORY_ENTRIES } } }, { type: 'object', properties: { entries: { type: 'array' }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['entries', 'total', 'truncated'] }, 'GET', ['file', 'list', 'directory', 'project'])
    async projectListDirectory(args: { dirPath?: string, limit?: number }): Promise<{ entries: { name: string, type: 'file' | 'directory', size?: number }[], total: number, truncated: boolean }> {
        const directory = resolveSafePath(projectRoot(), args.dirPath ?? '.');
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Directory not found: ${args.dirPath ?? '.'}` });
        const allEntries = fs.readdirSync(directory, { withFileTypes: true });
        const limit = boundedPositive(args.limit, DEFAULT_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES);
        const entries = allEntries.slice(0, limit).map((entry) => {
            const fullPath = path.join(directory, entry.name);
            const stat = fs.statSync(fullPath);
            return { name: entry.name, type: (entry.isDirectory() ? 'directory' : 'file') as 'file' | 'directory', size: entry.isFile() ? stat.size : undefined };
        });
        return { entries, total: allEntries.length, truncated: allEntries.length > entries.length };
    }
}
