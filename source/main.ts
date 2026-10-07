import packageJSON from '../package.json';
import { UtcpServerManager, setServerProfile } from './utcp/utcp-server';
import { getCreatorLogPolicy, parseCreatorLogPolicy, setCreatorLogPolicy } from './utcp/logging-policy';
import { closeArtifactServers } from './utcp/tools/artifact-server-tools';
import { getConfigManager } from './utcp/config-manager';
import { formatBuildInfo } from './build-info';
import { exec } from 'child_process';
import { isAbsolute } from 'path';
import { mkdirSync } from 'fs';
import { clearDebugLogFiles, getDebugLogDirectory } from './utcp/log-path';
import { cancelEditorAsk } from './utcp/editor-ask';
import { cancelEditorPrompt, getEditorPrompt, respondEditorPrompt } from './utcp/editor-prompt';
import { cancelEditorTask, disposeEditorControl, getEditorControl } from './utcp/editor-control-plane';
import { inspectExtensionStatus } from './extension-status';

let utcpServer: UtcpServerManager | null = null;
let lifecycle: Promise<unknown> = Promise.resolve();
let sceneLogging: 'enabled' | 'disabled' | 'unavailable' | 'error' | 'unknown' = 'unknown';
const registryPaths = new WeakMap<UtcpServerManager, string>();
type ServerStartupFailure = {
    code: string;
    message: string;
    requestedPort: number;
    recoverable: boolean;
    occurredAt: number;
};
let serverStartupFailure: ServerStartupFailure | null = null;

function captureStartupFailure(error: unknown, requestedPort: number): ServerStartupFailure {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'SERVER_START_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    const failure = { code, message: message.slice(0, 512), requestedPort, recoverable: code === 'EADDRINUSE' && requestedPort > 0, occurredAt: Date.now() };
    serverStartupFailure = failure;
    return failure;
}

function runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycle.then(operation);
    lifecycle = result.catch(() => {});
    return result;
}

async function stopPublishedServer(server: UtcpServerManager): Promise<void> {
    const { port, instanceId } = server;
    try {
        await server.stop();
    } finally {
        if (port > 0) await getConfigManager().removeCocosEditorTemplate(port, instanceId, registryPaths.get(server));
    }
}
async function syncSceneLogging(enabled: boolean, instanceId: string | null): Promise<'enabled' | 'disabled' | 'unavailable' | 'error'> {
    try {
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: packageJSON.name,
            method: enabled ? 'startCatchAll' : 'stopCatchAll',
            args: enabled && instanceId ? [instanceId] : [],
        });
        return enabled ? (result === true ? 'enabled' : 'unavailable') : 'disabled';
    } catch (error: unknown) {
        console.warn(`[cx3][scene] Console capture not toggled: ${error instanceof Error ? error.message : String(error)}`);
        return enabled ? 'error' : 'disabled';
    }
}

async function startPublishedServer(port: number, debugLogging: boolean): Promise<number> {
    const config = getConfigManager();
    const preferred = port === 0 ? await config.getLastAutoPort() : port;
    const attempts = preferred && port === 0 ? [preferred, 0] : [preferred];
    let lastError: unknown;
    for (const candidate of attempts) {
        const server = new UtcpServerManager();
        server.setDebugEnabled(debugLogging);
        try {
            const actualPort = await server.start(candidate);
            registryPaths.set(server, config.getConfigPath());
            await config.updatePort(actualPort, server.instanceId);
            if (port === 0) await config.setLastAutoPort(actualPort);
            utcpServer = server;
            serverStartupFailure = null;
            sceneLogging = await syncSceneLogging(debugLogging, server.instanceId);
            return actualPort;
        } catch (error) {
            lastError = error;
            try { await stopPublishedServer(server); }
            catch (cleanupError) {
                console.error('[cx3][api] Failed to clean up unpublished UTCP Server:', cleanupError);
                throw cleanupError;
            }
            if (!(port === 0 && candidate === preferred && preferred > 0
                && error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
        }
    }
    throw lastError;
}


export const methods: { [key: string]: (...any: any) => any } = {
    getEditorPrompt,
    respondEditorPrompt,
    getEditorControl,
    cancelEditorTask,
    openStatus() {
        return Editor.Panel.open(`${packageJSON.name}.status`);
    },
    async getExtensionStatus() {
        const server = utcpServer;
        const snapshot = await inspectExtensionStatus(server ? {
            port: server.port, instanceId: server.instanceId, debug: server.getDebugEnabled(),
            scene: sceneLogging, logDirectory: server.getLogDirectory(), logFile: server.getLogFile(),
        } : null, (server && registryPaths.get(server)) || getConfigManager().getConfigPath());
        if (server !== utcpServer || (server && server.instanceId !== snapshot.server.instanceId)) {
            snapshot.http = { status: 'error', detail: 'Server changed during this check. Check status again.' };
            snapshot.probe = null;
        }
        const current = server === utcpServer && server?.port ? server : null;
        return {
            ...snapshot,
            startupFailure: serverStartupFailure,
            sessions: current ? current.sessionPresence.snapshot() : [],
            activity: current ? current.requestActivity.snapshot() : { activeCount: 0, active: [], overflowCount: 0, lastReceived: null, recentFinished: [] },
        };
    },
    openAgentInbox() {
        return Editor.Panel.open(`${packageJSON.name}.prompt`);
    },

    openPanel() {
        Editor.Panel.open(packageJSON.name + '.configuration');
    },
    async getExtensionSettings() {
        const config = getConfigManager();
        return { fixedPort: await config.getCurrentPort(), configPath: config.getConfigPath() };
    },
    async saveExtensionSettings(input: unknown) {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some(key => key !== 'fixedPort' && key !== 'configPath')
            || !('fixedPort' in input) || typeof input.fixedPort !== 'number' || !Number.isInteger(input.fixedPort)
            || input.fixedPort < 0 || input.fixedPort > 65535
            || !('configPath' in input) || typeof input.configPath !== 'string' || !isAbsolute(input.configPath)
            || /[\0\r\n]/.test(input.configPath) || input.configPath.length > 4096) {
            throw new Error('Settings require fixedPort (0–65535) and an absolute configPath.');
        }
        const { fixedPort, configPath } = input;
        return runLifecycle(async () => {
            const config = getConfigManager();
            await config.setConfiguredPort(fixedPort);
            await config.setConfigPath(configPath);
            const previous = utcpServer;
            const debug = previous?.getDebugEnabled() ?? false;
            cancelEditorAsk();
            cancelEditorPrompt();
            utcpServer = null;
            if (previous) await stopPublishedServer(previous);
            await startPublishedServer(fixedPort, debug);
            return { fixedPort, configPath };
        });
    },

    openPreviewPanel() {
        Editor.Panel.open(packageJSON.name + '.preview');
    },


    async restartServer(newPort?: number) {
        return runLifecycle(async () => {
            const configManager = getConfigManager();
            const port = newPort === undefined ? await configManager.getCurrentPort() : newPort;
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                throw new RangeError('Port must be an integer between 0 and 65535 (0 = auto).');
            }
            if (newPort !== undefined) await configManager.setConfiguredPort(port);
            cancelEditorAsk();
            cancelEditorPrompt();
            const previousServer = utcpServer;
            const debugLogging = previousServer?.getDebugEnabled()
                ?? (await Editor.Profile.getConfig(packageJSON.name, 'debugLogging') === true);
            utcpServer = null;
            try {
                if (previousServer) await stopPublishedServer(previousServer);
                const actualPort = await startPublishedServer(port, debugLogging);
                console.log(`[cx3][api] UTCP Server restarted on port ${actualPort}`);
                return actualPort;
            } catch (err) {
                captureStartupFailure(err, port);
                console.error('[cx3][api] Failed to restart UTCP Server:', err);
                throw err;
            }
        });
    },
    async recoverServerPort() {
        return runLifecycle(async () => {
            const failure = serverStartupFailure;
            if (!failure?.recoverable || failure.code !== 'EADDRINUSE') {
                throw new Error('Port recovery is available only after a confirmed EADDRINUSE startup failure.');
            }
            const config = getConfigManager();
            const debugLogging = utcpServer?.getDebugEnabled()
                ?? (await Editor.Profile.getConfig(packageJSON.name, 'debugLogging') === true);
            const previousServer = utcpServer;
            if (previousServer) await stopPublishedServer(previousServer);
            utcpServer = null;
            await config.setConfiguredPort(0);
            const actualPort = await startPublishedServer(0, debugLogging);
            console.info(`[cx3][api] Recovered from occupied port ${failure.requestedPort}; server listening on ${actualPort}.`);
            return { recovered: true, previousPort: failure.requestedPort, port: actualPort, namespace: `ccp3x_${actualPort}` };
        });
    },
    toggleDebugLogging() {
        return runLifecycle(async () => {
            const enabled = utcpServer?.getDebugEnabled()
                ?? Boolean(await Editor.Profile.getConfig(packageJSON.name, 'debugLogging'));
            return methods.setDebugLogging(!enabled);
        });
    },

    async getDebugLogging() {
        const server = utcpServer;
        const stored = await Editor.Profile.getConfig(packageJSON.name, 'creatorLogPolicy');
        const policy = setCreatorLogPolicy(parseCreatorLogPolicy(stored));
        await Editor.Profile.setConfig(packageJSON.name, 'creatorLogPolicy', policy);
        const enabled = server?.getDebugEnabled() ?? Boolean(await Editor.Profile.getConfig(packageJSON.name, 'debugLogging'));
        return { enabled, policy, tier: policy.tier, groups: policy.groups, scene: sceneLogging, logDirectory: server?.getLogDirectory() ?? null, logFile: server?.getLogFile() ?? null };
    },
    async setDebugLogging(input: unknown) {
        const candidate = typeof input === 'boolean' ? { enabled: input } : input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
        if (!candidate || typeof candidate.enabled !== 'boolean') throw new Error('setDebugLogging requires boolean enabled');
        const policyValue = 'policy' in candidate ? candidate.policy : { tier: candidate.tier, groups: candidate.groups };
        const policy = setCreatorLogPolicy(parseCreatorLogPolicy(policyValue));
        await Editor.Profile.setConfig(packageJSON.name, 'creatorLogPolicy', policy);
        await Editor.Profile.setConfig(packageJSON.name, 'debugLogging', candidate.enabled);
        const applied = utcpServer?.setDebugEnabled(candidate.enabled) ?? candidate.enabled;
        const scene = await syncSceneLogging(candidate.enabled, utcpServer?.instanceId ?? null);
        sceneLogging = scene;
        return { enabled: applied, policy, tier: policy.tier, groups: policy.groups, scene, logDirectory: utcpServer?.getLogDirectory() ?? null, logFile: utcpServer?.getLogFile() ?? null };
    },
    async getLoggingPolicy() {
        const stored = await Editor.Profile.getConfig(packageJSON.name, 'creatorLogPolicy');
        return setCreatorLogPolicy(parseCreatorLogPolicy(stored));
    },
    async setLoggingPolicy(input: unknown) {
        const candidate = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
        const policy = setCreatorLogPolicy(parseCreatorLogPolicy('policy' in candidate ? candidate.policy : input));
        await Editor.Profile.setConfig(packageJSON.name, 'creatorLogPolicy', policy);
        return policy;
    },


    openDebugFolder() {
        const directory = utcpServer?.getLogDirectory() ?? getDebugLogDirectory('unscoped');
        mkdirSync(directory, { recursive: true });
        const cmd = process.platform === 'win32'
            ? `start "" "${directory}"`
            : process.platform === 'darwin' ? `open "${directory}"` : `xdg-open "${directory}"`;
        return new Promise<void>((resolve, reject) => {
            exec(cmd, err => err ? reject(err) : resolve());
        });
    },

    clearDebugLogs() {
        const directory = utcpServer?.getLogDirectory() ?? getDebugLogDirectory('unscoped');
        const removed = clearDebugLogFiles(directory);
        console.log(`[cx3][lifecycle] Cleared ${removed} log file(s) from the current editor scope.`);
        return { removed, directory };
    },

};

export async function load() {
    return runLifecycle(async () => {
        console.log('[cx3][lifecycle] Loaded');
        console.log(`[cx3][lifecycle] build ${formatBuildInfo()}`);

        const configManager = getConfigManager();
        await configManager.initialize();
        const storedPolicy = await Editor.Profile.getConfig(packageJSON.name, 'creatorLogPolicy');
        setCreatorLogPolicy(parseCreatorLogPolicy(storedPolicy));
        const debugLogging = await Editor.Profile.getConfig(packageJSON.name, 'debugLogging') === true;
        const profileConfig = await configManager.getToolProfileConfig();
        const profile = profileConfig.profile;
        if (profile !== 'core' && profile !== 'full' && profile !== 'custom') throw new Error('Invalid tool profile.');
        setServerProfile(profile, profileConfig.enabled, profileConfig.disabled, profileConfig.envelope);

        const port = await configManager.getCurrentPort();
        try {
            const actualPort = await startPublishedServer(port, debugLogging);
            const url = `http://localhost:${actualPort}/utcp`;
            console.log(
                `[cx3][lifecycle] Ready: UTCP server listening at ${url}\n` +
                `[cx3][config] Code Mode config updated: ${configManager.getConfigPath()}\n` +
                `[cx3][lifecycle] New AI sessions discover ccp3x_${actualPort}; reconnect an existing Code Mode MCP session to refresh it.`
            );
        } catch (err) {
            captureStartupFailure(err, port);
            console.error('[cx3][api] Failed to start UTCP Server:', err);
        }
    });
}

export async function unload() {
    return runLifecycle(async () => {
        cancelEditorAsk();
        cancelEditorPrompt();
        disposeEditorControl();
        await closeArtifactServers();
        const server = utcpServer;
        utcpServer = null;
        if (server) {
            console.log('[cx3][lifecycle] Stopping UTCP Server...');
            await stopPublishedServer(server);
        }
    });
}
