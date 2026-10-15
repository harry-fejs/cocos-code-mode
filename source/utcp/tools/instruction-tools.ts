import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { FileTools } from './file-tools';


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
        try {
            const result = await new FileTools().projectReadFile(args);
            return { content: result.content, bytes: result.bytes, exists: true, filePath: args.filePath };
        } catch (error) {
            if (error instanceof ToolError && error.code === 'TARGET_NOT_FOUND') {
                return { content: '', exists: false, filePath: args.filePath, bytes: 0 };
            }
            throw error;
        }
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
