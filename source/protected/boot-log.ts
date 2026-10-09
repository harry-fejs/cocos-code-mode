import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const BOOT_LOG_PATH = join(homedir(), ".ccp", "boot.log");

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack || ""}`;
  return String(error);
}

export function bootLog(level: "info" | "error", message: string, error?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${message}${error ? `\n${formatError(error)}` : ""}\n`;
  try {
    mkdirSync(join(homedir(), ".ccp"), { recursive: true });
    appendFileSync(BOOT_LOG_PATH, line);
  } catch {
    /* still print */
  }
  if (level === "error") console.error(`[ccp3x][BOOT] ${message}`, error || "");
  else console.log(`[ccp3x][BOOT] ${message}`);
}

export function bootWarnDialog(message: string): void {
  bootLog("error", message);
  try {
    const dialog = (globalThis as { Editor?: { Dialog?: { warn?: (title: string, options?: { detail?: string }) => unknown } } }).Editor?.Dialog;
    if (dialog && typeof dialog.warn === "function") {
      void dialog.warn("ccp3x", { detail: `${message}\n\nLog: ${BOOT_LOG_PATH}` });
    }
  } catch {
    /* Creator dialog is optional */
  }
}
