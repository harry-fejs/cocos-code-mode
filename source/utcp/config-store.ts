import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';

export interface UtcpConfig {
    manual_call_templates: Array<Record<string, unknown>>;
    load_variables_from?: Array<Record<string, unknown>> | null;
    variables?: Record<string, string>;
    [key: string]: unknown;
}
export function readUtcpConfig(path: string): UtcpConfig {
    if (!existsSync(path)) return { manual_call_templates: [] };
    if (!lstatSync(path).isFile() || statSync(path).size > 4 * 1024 * 1024) throw new Error('UTCP config must be a bounded regular file');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('UTCP config root must be an object');
    const config = parsed as UtcpConfig;
    if (!Array.isArray(config.manual_call_templates)) throw new Error('manual_call_templates must be an array');
    if (config.load_variables_from !== undefined && config.load_variables_from !== null && !Array.isArray(config.load_variables_from)) throw new Error('load_variables_from must be an array or null');
    if (config.variables !== undefined && (!config.variables || typeof config.variables !== 'object' || Array.isArray(config.variables) || Object.values(config.variables).some((value) => typeof value !== 'string'))) throw new Error('UTCP variables must be a string map');
    return config;
}
export function writeBytesAtomic(path: string, bytes: Buffer): void {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('refusing symbolic UTCP config path');
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, path);
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}
export function writeJsonAtomic(path: string, value: unknown): void {
    writeBytesAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}
export function writeUtcpConfig(path: string, config: UtcpConfig): void {
    writeJsonAtomic(path, config);
}
export function withConfigLock<T>(path: string, operation: () => T): T {
    mkdirSync(dirname(path), { recursive: true });
    const lock = `${path}.ccp-lock`;
    const deadline = Date.now() + 5000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    // Never steal a lock based on age: a suspended writer may still resume.
    for (;;) {
        try {
            mkdirSync(lock);
            break;
        } catch (error: unknown) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) throw new Error('UTCP configuration is busy; abandoned locks require owner verification before removal');
            Atomics.wait(wait, 0, 0, 25);
        }
    }
    try {
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        return operation();
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}
export function mutateUtcpConfig<T>(path: string, operation: (config: UtcpConfig) => T): T {
    return withConfigLock(path, () => {
        const config = readUtcpConfig(path);
        const result = operation(config);
        writeUtcpConfig(path, config);
        return result;
    });
}
