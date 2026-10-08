import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { z } from 'zod';
import { UtcpConfig, writeJsonAtomic } from './config-store';

export function connectionRegistryPath(configPath: string): string {
    return join(dirname(resolve(configPath)), '.cc-bridge', 'project-connections.json');
}
export function migrationReportsPath(configPath: string): string {
    return join(dirname(resolve(configPath)), '.cc-bridge', 'migration-reports');
}
export function canonicalProjectPath(path: string): string {
    if (!path || !path.trim()) throw new Error('an explicit Cocos project path is required');
    const canonical = realpathSync(resolve(path)).replace(/\\/g, '/');
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
export function projectIdentity(path: string): { projectPath: string; projectId: string } {
    const projectPath = canonicalProjectPath(path);
    return { projectPath, projectId: createHash('sha256').update(projectPath).digest('hex') };
}
export const GatewayContextSchema = z.object({
    origin: z.string().nullable(), projectId: z.string().nullable(), containerId: z.string().optional(),
}).strict();
export type GatewayContext = z.infer<typeof GatewayContextSchema>;
const ConnectionSchema = z.object({
    projectPath: z.string(), projectId: z.string().regex(/^[a-f0-9]{64}$/),
    port: z.number().int().min(1).max(65535), relayInstanceId: z.string().uuid(),
    tokenPath: z.string(), ownerPid: z.number().int().positive(), active: z.boolean(),
    gateway: GatewayContextSchema,
}).strict();
export type ProjectConnection = z.infer<typeof ConnectionSchema>;
const StateSchema = z.object({ version: z.literal(1), configPath: z.string(), projects: z.record(ConnectionSchema) }).strict();
export type ConnectionState = z.infer<typeof StateSchema>;
export const LegacyConnectionStateSchema = z.object({ version: z.literal(1), projects: z.record(ConnectionSchema),
    quarantined: z.array(z.object({ kind: z.enum(['loader', 'manual']), reference: z.string(),
        reason: z.string(), status: z.literal('unresolved') }).strict()).optional(),
}).strict();
function validateState(state: ConnectionState, configPath: string): ConnectionState {
    const parsed = StateSchema.parse(state);
    if (resolve(parsed.configPath) !== resolve(configPath)) throw new Error('project registry belongs to another UTCP config');
    const ports = new Set<number>();
    for (const [id, connection] of Object.entries(parsed.projects)) {
        if (id !== connection.projectId || createHash('sha256').update(connection.projectPath).digest('hex') !== id || ports.has(connection.port)) throw new Error('project registry contains mismatched identity or duplicate port');
        ports.add(connection.port);
    }
    return parsed;
}
export function readConnectionState(configPath: string): ConnectionState {
    const path = connectionRegistryPath(configPath);
    if (!existsSync(path)) return { version: 1, configPath: resolve(configPath), projects: {} };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('project registry must be a bounded regular file');
    return validateState(StateSchema.parse(JSON.parse(readFileSync(path, 'utf8'))), configPath);
}
export function storeConnectionState(configPath: string, state: ConnectionState): void {
    const parsed = validateState(state, configPath);
    const path = connectionRegistryPath(configPath);
    const directory = dirname(path);
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('refusing symbolic project registry directory');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeJsonAtomic(path, parsed);
}
export function assertConnectionConfig(config: UtcpConfig, state: ConnectionState): void {
    validateState(state, state.configPath);
    if (config.variables?.CCB_PROJECT_CONNECTIONS !== undefined) throw new Error('embedded project metadata must be migrated before using connections');
    for (const connection of Object.values(state.projects)) {
        const templates = config.manual_call_templates.filter((entry) => entry.name === `ccb3x_${connection.port}`);
        const loaders = (config.load_variables_from || []).filter((entry) => entry.variable_loader_type === 'dotenv' && typeof entry.env_file_path === 'string' && resolve(entry.env_file_path) === resolve(connection.tokenPath));
        if (connection.active) {
            if (templates.length !== 1 || templates[0].url !== `http://localhost:${connection.port}/utcp` || loaders.length !== 1) throw new Error('active project registry and UTCP config disagree');
        } else if (templates.length !== 0 || loaders.length !== 0) throw new Error('inactive project registry still has active UTCP registrations');
    }
}
export function ownerIsAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false;
        return true;
    }
}
