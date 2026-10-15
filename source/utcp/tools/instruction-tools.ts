import { utcpTool } from '../decorators';
import fs from 'fs-extra';
import path from 'path';
import { VERBOSE_FILE_BYTES } from '../utils/verbose';
import { ToolError } from '../tool-error';
import { FileTools } from './file-tools';

// Project instruction files — allowlist mirrors funplay's instruction-tools.
// Raw fs + path-safety, same pattern as file-tools.ts.

function resolveSafePath(projectPath: string, relPath: string): string {
    const resolved = path.resolve(projectPath, relPath);
    const rel = path.relative(projectPath, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new ToolError({
            code: 'INVALID_ARGUMENT',
            status: 400,
            message: `Path escapes project boundary: ${relPath}`,
            details: { filePath: relPath },
            recovery: 'Use a project-relative instruction path.',
        });
    }
    return resolved;
}

export class InstructionTools {

    @utcpTool(
        'readProjectInstruction',
        'Read a project instruction file (AGENTS.md, CLAUDE.md, GEMINI.md, .codex, rules/*.md). Returns content or not-found. Default 512KB; verbose=true lifts to 10MB.',
        {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Project-relative path, e.g. "AGENTS.md" or "CLAUDE.md" or "docs/rules.md"' },
                verbose: { type: 'boolean', description: 'When true, lifts size cap to 10MB.' },
            },
            required: ['filePath'],
        },
        {
            type: 'object',
            properties: {
                content: { type: 'string' },
                exists: { type: 'boolean' },
                filePath: { type: 'string' },
                bytes: { type: 'number' },
            },
            required: ['content', 'exists', 'filePath'],
        },
        'GET',
        ['instruction', 'project', 'read', 'agent', 'prompt', 'AGENTS', 'CLAUDE']
    )
    async readProjectInstruction(args: { filePath: string, verbose?: boolean }): Promise<{ content: string, exists: boolean, filePath: string, bytes: number }> {
        const projectPath = (Editor.Project as any).path as string;
        const resolved = resolveSafePath(projectPath, args.filePath);
        if (!fs.existsSync(resolved)) {
            return { content: '', exists: false, filePath: args.filePath, bytes: 0 };
        }
        const stat = fs.statSync(resolved);
        const cap = args.verbose ? VERBOSE_FILE_BYTES : 512 * 1024;
        if (stat.size > cap) throw new Error(`Instruction file too large (${stat.size} bytes, cap ${cap}). ${args.verbose ? 'Already at verbose cap (10MB).' : 'Pass verbose=true to lift to 10MB.'}`);
        const content = fs.readFileSync(resolved, 'utf-8');
        return { content, exists: true, filePath: args.filePath, bytes: stat.size };
    }

    @utcpTool(
        'writeProjectInstruction',
        'Atomically write bounded UTF-8 project instruction text and verify read-back. Creates parent dirs; asset refresh is best-effort, not importer completion proof.',
        {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Project-relative path, e.g. "AGENTS.md"' },
                content: { type: 'string', description: 'Full file content to write' },
            },
            required: ['filePath', 'content'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                filePath: { type: 'string' },
                bytesWritten: { type: 'number' },
            },
            required: ['success', 'filePath'],
        },
        'POST',
        ['instruction', 'project', 'write', 'save', 'agent', 'prompt', 'AGENTS', 'CLAUDE']
    )
    async writeProjectInstruction(args: { filePath: string, content: string }): Promise<{ success: boolean, filePath: string, bytesWritten: number }> {
        const result = await new FileTools().projectWriteFile(args);
        return { ...result, filePath: args.filePath };
    }
}
