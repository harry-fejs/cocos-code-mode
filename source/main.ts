import { existsSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import packageJSON from '../package.json';
import { UtcpServerManager, setServerProfile } from './utcp/utcp-server';
import { getConfigManager } from './utcp/config-manager';
import { formatBuildInfo, getBuildInfo } from './build-info';
import { ProtectedRelayHost } from './protected/relay-host';
import { dispatchProtectedCustomerTool } from './protected/protected-route';
import { BOOT_LOG_PATH, bootLog, bootWarnDialog } from './protected/boot-log';
import { toCcbErrorBody } from './protected/errors';
import { launchPendingHealthRollback, launchStagedActivation } from './update/activation';
import { UpdateManager, type StagedUpdate } from './update/manager';
import { UpdateStateStore } from './update/state';
import { evaluateUpdateHealth } from './update/health';

let utcpServer: UtcpServerManager | null = null;
let relayHost: ProtectedRelayHost | null = null;
let updateManager: UpdateManager | null = null;
let stagedUpdate: StagedUpdate | null = null;
const extensionRoot = resolve(__dirname, '..');
const activationHelperPath = join(extensionRoot, 'scripts', 'install-update.ps1');
let pendingHealthRollback = false;

async function finishPendingHealth(utcpReady: boolean): Promise<void> {
    const backup = `${extensionRoot}.prev`;
    const backupPresent = existsSync(backup);
    const stateStore = new UpdateStateStore();
    try {
        const recovered = stateStore.recoverActivation(backupPresent);
        if (recovered.activationState === 'rollback-required') {
            pendingHealthRollback = true;
            relayHost?.state.lock({ code: 'CCB_BUILD_INCOMPATIBLE', error: 'Signed update rollback is required before protected execution can resume.' });
            bootLog('error', 'Signed update rollback-required state recovered; rollback queued for Creator shutdown');
            return;
        }
        if (recovered.activationState === 'retiring-backup') {
            rmSync(backup, { recursive: true, force: true });
            stateStore.markBackupRetired(existsSync(backup));
            bootLog('info', 'Signed update backup retirement completed');
            return;
        }
        if (recovered.activationState !== 'pending-health') return;
        const host = relayHost;
        const health = await evaluateUpdateHealth({
            utcpReady,
            relayState: host?.state.state ?? 'LOCKED',
            identityCompatible: host?.identity !== null && host?.identity !== undefined,
            packageCompatible: typeof host?.packageHash === 'string',
            creatorCompatible: typeof Editor.App.version === 'string' && Editor.App.version.length > 0,
            protectedProbeTimeoutMs: 5_000,
            protectedProbe: async () => {
                if (!host) return false;
                await dispatchProtectedCustomerTool(host, 'editorQuery', { category: 'ready' });
                return true;
            },
        });
        if (!health.healthy) {
            stateStore.markRollbackRequired();
            pendingHealthRollback = true;
            bootLog('error', `Signed update failed startup health (${health.failures.join(',')}); rollback queued for Creator shutdown`);
            return;
        }
        stateStore.markHealthPassed();
        rmSync(backup, { recursive: true, force: true });
        stateStore.markBackupRetired(existsSync(backup));
        bootLog('info', 'Signed update passed startup health; prior package removed');
    } catch (error) {
        const code = toCcbErrorBody(error).code;
        relayHost?.state.lock({ code: 'CCB_BUILD_INCOMPATIBLE', error: 'Signed update recovery could not be completed; protected execution remains locked.' });
        pendingHealthRollback = backupPresent;
        bootLog('error', `Unable to resolve pending update health: ${code}`);
    }
}

function stageUpdateInBackground(): void {
    if (!updateManager) return;
    if (existsSync(`${extensionRoot}.prev`)) return;
    void updateManager.checkAndStage().then((result) => {
        stagedUpdate = result;
        bootLog('info', `Signed update staged: ${result.accepted.target.package.version}`);
    }).catch((error) => {
        const body = toCcbErrorBody(error);
        const transport = typeof body.details.transport === 'string' ? ` transport=${body.details.transport}` : '';
        const status = typeof body.details.status === 'number' ? ` status=${body.details.status}` : '';
        const detailError = typeof body.details.detail === 'string' ? ` detail=${body.details.detail}` : ` message=${body.error.replace(/[\r\n]+/g, ' ').slice(0, 160)}`;
        bootLog('error', `Background update check failed: ${body.code}${transport}${status}${detailError}`);
    });
}

export const methods: Record<string, Function> = {

    openPanel() {
        Editor.Panel.open(packageJSON.name + '.configuration');
    },

    openPreviewPanel() {
        Editor.Panel.open(packageJSON.name + '.preview');
    },

    async showInfo() {
        return methods.showBuildInfo();
    },

    async restartServer(newPort?: number) {
        if (!utcpServer) {
            console.warn(`[${packageJSON.name}] UTCP Server is not running.`);
            return;
        }
        if (typeof newPort !== 'number' || !newPort) {
            newPort = await getConfigManager().getProjectPort(Editor.Project.path);
        }

        const previousServer = utcpServer;
        let nextServer: UtcpServerManager | undefined;
        try {
            await previousServer.stop();
            nextServer = new UtcpServerManager(relayHost ?? undefined);
            const actualPort = await nextServer.start(newPort);
            const authBinding = nextServer.getLocalAuthBinding();
            if (!authBinding) throw new Error('UTCP server started without a local authentication binding');
            utcpServer = nextServer;
            await getConfigManager().updatePort(actualPort);
            bootLog('info', `UTCP connected/listening at http://localhost:${actualPort}/utcp`);
            console.log(`[${packageJSON.name}] UTCP Server restarted on port ${actualPort}`);
        } catch (err) {
            utcpServer = null;
            if (nextServer) await nextServer.stop().catch(() => undefined);
            bootLog('error', 'UTCP disconnected after restart failure', err);
            console.error(`[${packageJSON.name}] Failed to restart UTCP Server:`, err);
        }
    },


    async showBuildInfo() {
        const b = getBuildInfo();
        const cm = getConfigManager();
        // ponytail: merged Server Info + About — single log has port/config/url + build info (same as 2x)
        const port = await cm.getCurrentPort().catch(() => 0);
        const configPath = cm.getConfigPath();
        const isRunning = Boolean(port && utcpServer);
        const statusIcon = isRunning ? '🟢' : '🔴';
        const statusUrl = isRunning ? `http://localhost:${port}/utcp` : 'Server not running';
        const commitStr = `${b.commit}${b.dirty ? '-dirty' : ''}`;
        const versionTag = `v${b.version}@${commitStr}`;

        const lines = [
            `[${packageJSON.name}] ${statusIcon} ${statusUrl} (${versionTag})`,
            `  Build info:`,
            `    Port:     ${port || '(not running)'}`,
            `    Config:   ${configPath}`,
            `    Branch:   ${b.branch}`,
            `    Built at: ${b.builtAt}`,
            `    Boot log: ${BOOT_LOG_PATH}`,
        ];
        console.log(lines.join('\n'));
    },
    async checkForUpdates() {
        if (!updateManager) return { staged: false, reason: 'Signed updates are not configured.' };
        try {
            const result = await updateManager.checkAndStage();
            stagedUpdate = result;
            return { staged: true, version: result.accepted.target.package.version };
        } catch (error) {
            const body = toCcbErrorBody(error);
            bootLog('error', `Update check failed: ${body.code}`);
            return { staged: false, ...body };
        }
    },
    async getBootLog(count = 100) {
        const limit = Number.isSafeInteger(count) ? Math.min(Math.max(count, 1), 500) : 100;
        try {
            const lines = readFileSync(BOOT_LOG_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
            return { path: BOOT_LOG_PATH, lines: lines.slice(-limit) };
        } catch (error) {
            return { path: BOOT_LOG_PATH, lines: [`Unable to read boot log: ${error instanceof Error ? error.message : String(error)}`] };
        }
    },

    
};

export async function load() {
    bootLog("info", `Loaded ${formatBuildInfo()}`);
    bootLog("info", `Runtime node=${process.version} electron=${process.versions.electron || "unknown"}`);
    try {
        const configManager = getConfigManager();
        await configManager.initialize();
        const profileConfig = await configManager.getToolProfileConfig();
        const profile = profileConfig.profile === 'core' || profileConfig.profile === 'full' ? profileConfig.profile : 'full';
        setServerProfile(profile, profileConfig.enabled, profileConfig.disabled, profileConfig.envelope);

        try {
            relayHost = new ProtectedRelayHost(Editor.Project.path);
            relayHost.activateIfConfigured();
            const lockReason = relayHost.state.reason;
            bootLog('info', `Protected relay state=${relayHost.state.state}${lockReason ? ` code=${lockReason.code} reason=${lockReason.error}` : ''}`);
            if (relayHost.identity) bootLog("info", `relay identity=${relayHost.identity.deviceKeyId}`);
        } catch (err) {
            relayHost = null;
            bootLog("error", "Protected relay failed to boot; menus and local tools still start", err);
        }
        const releaseOrigin = process.env.CCB_RELEASE_ORIGIN;
        if (releaseOrigin && relayHost?.identity) {
            const configuredRing = process.env.CCB_RELEASE_RING;
            const allowedRing = configuredRing === '3' || configuredRing === '10' ? configuredRing : '1';
            const build = getBuildInfo();
            updateManager = new UpdateManager({
                origin: releaseOrigin,
                compatibility: {
                    protocolVersion: 1,
                    creatorVersion: Editor.App.version,
                    os: process.platform,
                    arch: process.arch,
                    currentBuild: build.version,
                    deviceId: relayHost.identity.deviceId,
                    channel: process.env.CCB_RELEASE_CHANNEL || 'stable',
                    allowedRing,
                },
            });
            if (relayHost.targetPayloadHash && updateManager.shouldInitializeInstalledTarget()) {
                updateManager.initializeInstalledTarget(relayHost.targetPayloadHash);
            }
        }
        if (process.env.CCB_DISABLE_LOCAL_UTCP === "1") {
            bootLog("info", "Local broker disabled by CCB_DISABLE_LOCAL_UTCP=1");
            stageUpdateInBackground();
            await finishPendingHealth(false);
            return;
        }
        utcpServer = new UtcpServerManager(relayHost ?? undefined);
        let wasConfiguredPort = true;
        let port = await configManager.getProjectPort(Editor.Project.path);
        if (!port) {
            port = 0;
            wasConfiguredPort = false;
        }
        try {
            const actualPort = await utcpServer.start(port);
            const authBinding = utcpServer.getLocalAuthBinding();
            if (!authBinding) throw new Error('UTCP server started without a local authentication binding');
            const url = `http://localhost:${actualPort}/utcp`;
            await configManager.updatePort(actualPort);
            bootLog("info", `UTCP listening at ${url}; boot log ${BOOT_LOG_PATH}`);
            stageUpdateInBackground();
            await finishPendingHealth(true);
        } catch (err) {
            await utcpServer.stop().catch(() => undefined);
            utcpServer = null;
            bootWarnDialog(`UTCP failed to start. See ${BOOT_LOG_PATH}`);
            bootLog("error", "Failed to start UTCP Server", err);
            await finishPendingHealth(false);
        }
        if (!wasConfiguredPort) {
            Editor.Panel.open(packageJSON.name + ".configuration");
        }
    } catch (err) {
        bootWarnDialog(`Extension load failed. See ${BOOT_LOG_PATH}`);
        bootLog("error", "Extension load failed; menu handlers remain registered", err);
        await finishPendingHealth(false);
    }
}

export async function unload() {
    const currentServer = utcpServer;
    const currentRelay = relayHost;
    const currentUpdateManager = updateManager;
    const currentStagedUpdate = stagedUpdate;
    const shouldRollback = pendingHealthRollback;
    utcpServer = null;
    relayHost = null;
    updateManager = null;
    stagedUpdate = null;
    pendingHealthRollback = false;
    currentServer?.beginDrain();
    if (currentRelay) {
        const drained = await currentRelay.state.drain(5_000);
        if (!drained) bootLog('error', 'Protected relay drain timed out; in-flight outcome remains ambiguous');
    }
    if (currentServer) {
        console.log(`[${packageJSON.name}] Stopping UTCP Server...`);
        const port = currentServer.port;
        bootLog('info', `UTCP disconnecting from port ${port}`);
        await currentServer.stop();
        bootLog('info', `UTCP disconnected from port ${port}`);
    }
    currentRelay?.close();
    if (shouldRollback) {
        try {
            await launchPendingHealthRollback({
                creatorPid: process.pid,
                creatorExecutablePath: process.execPath,
                liveDirectory: extensionRoot,
                helperPath: activationHelperPath,
            });
        } catch (error) {
            bootLog('error', `Unable to queue pending-health rollback: ${toCcbErrorBody(error).code}`);
        }
        return;
    }
    if (!currentStagedUpdate || !currentUpdateManager) return;
    try {
        currentUpdateManager.beginActivationLaunch();
        await launchStagedActivation({
            creatorPid: process.pid,
            creatorExecutablePath: process.execPath,
            stagedDirectory: currentStagedUpdate.stagedDirectory,
            liveDirectory: extensionRoot,
            descriptorSha256: currentStagedUpdate.descriptorSha256,
            helperPath: activationHelperPath,
        });
        currentUpdateManager.markActivationSpawned();
        bootLog('info', `Signed update queued for Creator shutdown: ${currentStagedUpdate.accepted.target.package.version}`);
    } catch (error) {
        currentUpdateManager.markActivationLaunchFailed();
        bootLog('error', `Unable to queue staged update: ${toCcbErrorBody(error).code}`);
    }
}
