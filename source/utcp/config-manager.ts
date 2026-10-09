import { resolve } from 'path';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'fs';
import { GatewayContextSchema } from './project-connection';
import { assertLocalAuthFile, bindLocalAuthToPort, LocalAuthContext } from './local-auth';
import { assertConnectionConfig, connectionRegistryPath, GatewayContext, ownerIsAlive, projectIdentity, readConnectionState, storeConnectionState } from './project-connection';
import { readUtcpConfig, UtcpConfig, withConfigLock, writeBytesAtomic, writeUtcpConfig } from './config-store';
// @ts-ignore package.json is supplied by the extension build.
import packageJSON from '../../package.json';

export class UtcpConfigManager {
    private static instance: UtcpConfigManager;
    private configPath = '';
    private readonly snapshots = new WeakMap<UtcpConfig, string>();
    private constructor() {}
    static getInstance(): UtcpConfigManager {
        if (!this.instance) this.instance = new UtcpConfigManager();
        return this.instance;
    }
    async initialize(): Promise<void> {
        const saved = await Editor.Profile.getConfig(packageJSON.name, 'utcpConfigPath');
        this.configPath = typeof saved === 'string' && saved ? saved : join(homedir(), '.utcp_config.json');
    }
    getConfigPath(): string { return this.configPath || join(homedir(), '.utcp_config.json'); }
    async setConfigPath(path: string): Promise<void> {
        this.configPath = resolve(path);
        await Editor.Profile.setConfig(packageJSON.name, 'utcpConfigPath', this.configPath);
    }
    readConfig(): UtcpConfig {
        const config = readUtcpConfig(this.getConfigPath());
        this.snapshots.set(config, JSON.stringify(config));
        return config;
    }
    writeConfig(config: UtcpConfig): void {
        // Panel edits are optimistic transactions: refuse to clobber another Editor.
        withConfigLock(this.getConfigPath(), () => {
            const expected = this.snapshots.get(config);
            if (expected === undefined || JSON.stringify(readUtcpConfig(this.getConfigPath())) !== expected) throw new Error('UTCP config changed; refresh before editing');
            assertConnectionConfig(config, readConnectionState(this.getConfigPath()));
            writeUtcpConfig(this.getConfigPath(), config);
            this.snapshots.set(config, JSON.stringify(config));
        });
    }
    async getProjectPort(projectPath: string): Promise<number> {
        const identity = projectIdentity(projectPath);
        return withConfigLock(this.getConfigPath(), () => {
            const state = readConnectionState(this.getConfigPath());
            assertConnectionConfig(readUtcpConfig(this.getConfigPath()), state);
            return state.projects[identity.projectId]?.port || 0;
        });
    }
    private mutateConnection<T>(auth: LocalAuthContext | undefined, operation: (config: UtcpConfig) => T, configPath = this.getConfigPath()): T {
        return withConfigLock(configPath, () => {
            const config = readUtcpConfig(configPath);
            const paths = [connectionRegistryPath(configPath), ...(auth ? [auth.tokenPath] : [])];
            const originals = paths.map((path) => {
                if (!existsSync(path)) return undefined;
                const stat = lstatSync(path);
                if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('connection transaction requires bounded regular files');
                return readFileSync(path);
            });
            const previousPort = auth?.boundPort;
            try {
                const result = operation(config);
                // Config is the last atomic publication; no further fallible
                // writes happen after its rename. A failure rolls back every
                // registry/credential publication while still holding the lock.
                writeUtcpConfig(configPath, config);
                return result;
            } catch (error: unknown) {
                for (let index = paths.length - 1; index >= 0; index--) {
                    const path = paths[index];
                    const original = originals[index];
                    if (original === undefined) {
                        if (existsSync(path)) unlinkSync(path);
                    } else if (!existsSync(path) || !readFileSync(path).equals(original)) writeBytesAtomic(path, original);
                }
                if (auth) auth.boundPort = previousPort;
                throw error;
            }
        });
    }
    async ensureCocosEditorTemplate(port: number, auth: LocalAuthContext, gateway: GatewayContext): Promise<boolean> {
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new RangeError('port must be in 1..65535');
        if (!auth.projectId || !auth.projectPath) throw new Error('authenticated rendezvous requires a canonical project identity');
        const identity = projectIdentity(auth.projectPath);
        if (identity.projectId !== auth.projectId) throw new Error('credential project identity is invalid');
        const assignedGateway = GatewayContextSchema.parse(gateway);
        return this.mutateConnection(auth, (config) => {
            const state = readConnectionState(this.getConfigPath());
            assertConnectionConfig(config, state);
            const prior = state.projects[identity.projectId];
            if (prior?.active && prior.relayInstanceId !== auth.relayInstanceId && ownerIsAlive(prior.ownerPid)) throw new Error('Cocos project already has an active relay session');
            for (const connection of Object.values(state.projects)) {
                if (connection.projectId !== identity.projectId && connection.port === port) throw new Error('port belongs to a different Cocos project');
            }
            const name = `ccp3x_${port}`;
            const ownNames = prior ? [`ccp3x_${prior.port}`] : [];
            const colliding = config.manual_call_templates.filter((template) => template.name === name || template.url === `http://localhost:${port}/utcp`);
            if (colliding.some((template) => !ownNames.includes(String(template.name)))) throw new Error('port has an unresolved or foreign UTCP registration; migrate explicitly first');
            if (prior && resolve(prior.tokenPath) !== resolve(auth.tokenPath)) throw new Error('project credential location changed unexpectedly');
            const namespace = `ccp3x__${port}_`;
            if (Object.keys(config.variables || {}).some((key) => key.startsWith(namespace))) throw new Error('inline credentials shadow this port namespace; reconcile explicitly');
            for (const loader of config.load_variables_from || []) {
                if (loader.variable_loader_type !== 'dotenv' || typeof loader.env_file_path !== 'string' || resolve(loader.env_file_path) === resolve(auth.tokenPath)) continue;
                if (!existsSync(loader.env_file_path)) continue;
                const stat = lstatSync(loader.env_file_path);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('cannot safely exclude credential loader collisions');
                if (readFileSync(loader.env_file_path, 'utf8').split(/\r?\n/).some((line) => line.trimStart().startsWith(namespace))) throw new Error('another credential loader shadows this port; migrate or reconcile explicitly');
            }
            // Shared lock covers credential replacement; refused duplicates cannot rotate a live token.
            bindLocalAuthToPort(auth, port);
            assertLocalAuthFile(auth);
            config.manual_call_templates = config.manual_call_templates.filter((template) => !ownNames.includes(String(template.name)));
            config.manual_call_templates.push({ name, call_template_type: 'http', url: `http://localhost:${port}/utcp`, http_method: 'GET', content_type: 'application/json',
                headers: { 'x-ccp-relay-instance': '${CCP_RELAY_INSTANCE_ID}', 'x-ccp-bound-port': '${CCP_BOUND_PORT}', 'x-ccp-project-id': '${CCP_LOCAL_PROJECT_ID}' } });
            const loaders = config.load_variables_from || [];
            config.load_variables_from = [...loaders.filter((loader) => loader.variable_loader_type !== 'dotenv' || resolve(String(loader.env_file_path)) !== resolve(auth.tokenPath)),
                { variable_loader_type: 'dotenv', env_file_path: resolve(auth.tokenPath) }];
            state.projects[identity.projectId] = { ...identity, port, relayInstanceId: auth.relayInstanceId, tokenPath: resolve(auth.tokenPath), ownerPid: process.pid, active: true, gateway: assignedGateway };
            assertConnectionConfig(config, state);
            storeConnectionState(this.getConfigPath(), state);
            return true;
        });
    }
    async removeCocosEditorTemplate(auth: LocalAuthContext, configPath = this.getConfigPath()): Promise<boolean> {
        if (!auth.projectId || auth.boundPort === undefined) return false;
        return this.mutateConnection(undefined, (config) => {
            const state = readConnectionState(configPath);
            assertConnectionConfig(config, state);
            const connection = state.projects[auth.projectId!];
            if (!connection || !connection.active || connection.relayInstanceId !== auth.relayInstanceId || connection.port !== auth.boundPort) return false;
            connection.active = false;
            config.manual_call_templates = config.manual_call_templates.filter((template) => template.name !== `ccp3x_${connection.port}`);
            config.load_variables_from = (config.load_variables_from || []).filter((loader) => loader.variable_loader_type !== 'dotenv' || resolve(String(loader.env_file_path)) !== resolve(connection.tokenPath));
            assertConnectionConfig(config, state);
            storeConnectionState(configPath, state);
            return true;
        }, configPath);
    }
    async getCurrentPort(): Promise<number> {
        const port = await Editor.Profile.getConfig(packageJSON.name, 'serverPort');
        return typeof port === 'number' ? port : 0;
    }
    async updatePort(port: number): Promise<void> {
        await Editor.Profile.setConfig(packageJSON.name, 'serverPort', port);
    }
    async getToolProfileConfig(): Promise<{ profile: string, enabled: string[], disabled: string[], envelope: boolean }> {
        const profile = await Editor.Profile.getConfig(packageJSON.name, 'toolProfile') as string || 'full';
        const enabled = await Editor.Profile.getConfig(packageJSON.name, 'enabledTools') as string[] || [];
        const disabled = await Editor.Profile.getConfig(packageJSON.name, 'disabledTools') as string[] || [];
        const envelope = await Editor.Profile.getConfig(packageJSON.name, 'responseEnvelope') as boolean || false;
        return { profile, enabled, disabled, envelope };
    }
    async setToolProfileConfig(config: { profile: string, enabled: string[], disabled: string[], envelope: boolean }): Promise<void> {
        await Editor.Profile.setConfig(packageJSON.name, 'toolProfile', config.profile);
        await Editor.Profile.setConfig(packageJSON.name, 'enabledTools', config.enabled);
        await Editor.Profile.setConfig(packageJSON.name, 'disabledTools', config.disabled);
        await Editor.Profile.setConfig(packageJSON.name, 'responseEnvelope', config.envelope);
    }
}
export function getConfigManager(): UtcpConfigManager { return UtcpConfigManager.getInstance(); }
