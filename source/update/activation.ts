import { createHash } from "crypto"
import { spawn } from "child_process"
import { once } from "events"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs"
import { homedir } from "os"
import { isAbsolute, join, resolve } from "path"
import { CcpError } from "../protected/errors";
import { prepareActivation } from "../protected/staged-update";

export interface ActivationLaunch {
  creatorPid: number;
  creatorExecutablePath: string;
  stagedDirectory: string;
  liveDirectory: string;
  descriptorSha256: string;
  helperPath: string;
}

function stableHelper(sourcePath: string): string {
  const source = readFileSync(resolve(sourcePath));
  if (source.length === 0 || source.length > 128 * 1024) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Fixed update activation helper is invalid.");
  const directory = join(homedir(), ".ccp", "update-helper");
  const destination = join(directory, "install-update.ps1");
  const expected = createHash("sha256").update(source).digest("hex");
  if (existsSync(destination) && createHash("sha256").update(readFileSync(destination)).digest("hex") === expected) return destination;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, source, { flag: "wx", mode: 0o600 });
  rmSync(destination, { force: true });
  renameSync(temporary, destination);
  return destination;
}
async function spawnPowerShell(powershell: string, args: string[]): Promise<void> {
  const child = spawn(powershell, args, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
  await once(child, "spawn");
  child.unref();
}


export async function launchStagedActivation(input: ActivationLaunch): Promise<void> {
  const verified = prepareActivation(input.creatorPid, input.stagedDirectory, input.liveDirectory, input.descriptorSha256);
  const helperPath = stableHelper(input.helperPath);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Windows system root is unavailable.");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell) || !existsSync(helperPath)) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Fixed update activation helper is unavailable.");
  await spawnPowerShell(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath,
    "-CreatorPid", String(verified.creatorPid),
    "-CreatorExecutablePath", resolve(input.creatorExecutablePath),
    "-StagedDirectory", verified.directory,
    "-LiveDirectory", verified.liveDirectory,
    "-DescriptorSha256", verified.descriptorSha256,
  ]);
}

export async function launchPendingHealthRollback(input: {
  creatorPid: number;
  creatorExecutablePath: string;
  liveDirectory: string;
  helperPath: string;
}): Promise<void> {
  if (!Number.isSafeInteger(input.creatorPid) || input.creatorPid < 1) throw new CcpError("CCP_CANONICAL_INVALID", "Creator PID must be a positive integer.");
  const liveDirectory = resolve(input.liveDirectory);
  const helperPath = stableHelper(input.helperPath);
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Windows system root is unavailable.");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell) || !existsSync(helperPath) || !existsSync(`${liveDirectory}.prev`)) {
    throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Pending-health rollback prerequisites are unavailable.");
  }
  await spawnPowerShell(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath,
    "-CreatorPid", String(input.creatorPid),
    "-CreatorExecutablePath", resolve(input.creatorExecutablePath),
    "-LiveDirectory", liveDirectory,
    "-RollbackPendingHealth",
  ]);
}
