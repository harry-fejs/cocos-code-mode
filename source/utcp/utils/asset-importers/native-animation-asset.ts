import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { IAssetInfo } from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import { BaseAssetImporter } from './base-importer';
import { ToolError } from '../../tool-error';

export type NativeRecord = Record<string, unknown>;
export const MAX_ANIMATION_ENTRIES = 256;
export const MAX_ANIMATION_EDITS = 64;
export function animationError(code: string, message: string, details: Record<string, unknown> = {}): ToolError {
    return new ToolError({ code, message, status: code === 'UNSUPPORTED_OPERATION' ? 422 : code === 'INVALID_ARGUMENT' ? 400 : 409,
        details: { mutationDispatched: false, retrySafe: true, ...details } });
}
export function animationRecord(value: unknown): NativeRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw animationError('UNSUPPORTED_OPERATION', 'Native animation asset schema is unavailable or incompatible.');
    return value as NativeRecord;
}
export function animationReference(value: unknown, allowEmpty = false): string {
    if (allowEmpty && value === '') return '';
    if (typeof value !== 'string' || value.length > 128 || !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{2}[A-Za-z0-9+/]{20})(?:@[A-Za-z0-9_-]{1,64})?$/i.test(value)) {
        throw animationError('INVALID_ARGUMENT', 'Animation references must be bounded asset UUIDs, not paths or arbitrary objects.');
    }
    return value;
}
export async function requireAnimationReference(value: unknown, type: string): Promise<string> {
    const uuid = animationReference(value, true);
    if (!uuid) return uuid;
    const info = await Editor.Message.request('asset-db', 'query-asset-info', uuid);
    if (!info || info.type !== type || info.invalid) throw animationError('INVALID_ARGUMENT', `Reference must identify an available ${type} asset.`);
    return info.uuid;
}
export function serializedAnimationRoot(value: unknown, type: string): { root: NativeRecord, resolve: (value: unknown) => NativeRecord } {
    const table = Array.isArray(value) ? value : [];
    if (table.length > 4096) throw animationError('LIMIT_EXCEEDED', 'Animation asset object table exceeds 4096 entries.');
    const root = animationRecord(table.length ? table[0] : value);
    if (root.__type__ !== type) throw animationError('UNSUPPORTED_OPERATION', `Source is not a native ${type} serialization.`);
    const resolve = (value: unknown): NativeRecord => {
        const object = animationRecord(value);
        if (!Object.prototype.hasOwnProperty.call(object, '__id__')) return object;
        const id = object.__id__;
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= table.length) throw animationError('UNSUPPORTED_OPERATION', 'Invalid native serialized object reference.');
        return animationRecord(table[id]);
    };
    return { root, resolve };
}
export function serializedAnimationReference(value: unknown): string {
    if (value === null) return '';
    const uuid = animationReference(animationRecord(value).__uuid__);
    const [head, suffix] = uuid.split('@');
    if (head.length !== 22) return uuid.toLowerCase().split('@')[0] + (suffix ? `@${suffix}` : '');
    // Matching 3.7 serialization uses a two-hex-character prefix and base64 pairs.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let hex = head.slice(0, 2);
    for (let index = 2; index < 22; index += 2) {
        const lhs = alphabet.indexOf(head[index]), rhs = alphabet.indexOf(head[index + 1]);
        hex += (lhs >> 2).toString(16) + (((lhs & 3) << 2) | (rhs >> 4)).toString(16) + (rhs & 15).toString(16);
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${suffix ? `@${suffix}` : ''}`;
}
function sourceSnapshot(asset: IAssetInfo): { bytes: Buffer, sha256: string, json: unknown } {
    if (!asset.file || !Editor.Project.path) throw animationError('UNSUPPORTED_OPERATION', 'An independently readable project asset source is required.');
    const root = fs.realpathSync(path.join(Editor.Project.path, 'assets'));
    const file = fs.realpathSync(asset.file), relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw animationError('INVALID_ARGUMENT', 'Native animation source must remain inside project assets.');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1048576) throw animationError('LIMIT_EXCEEDED', 'Native animation source must be a file no larger than 1 MiB.');
    const bytes = fs.readFileSync(file);
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), json: JSON.parse(bytes.toString('utf8')) };
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
interface PendingEdit { original: NativeRecord; expected: NativeRecord; sourceSha256: string; verified: boolean; appliedSourceSha256?: string; }

/** Native Inspector cache changes are distinct from source apply; no .meta writes or direct source overwrites. */
export abstract class NativeAnimationAssetImporter extends BaseAssetImporter {
    private readonly pending = new Map<string, PendingEdit>();
    private readonly recovery = new Map<string, PendingEdit>();
    protected abstract queryNative(uuid: string): Promise<NativeRecord>;
    protected abstract changeNative(uuid: string, dump: NativeRecord): Promise<NativeRecord>;
    protected abstract applyNative(uuid: string, dump: NativeRecord): Promise<void>;
    protected abstract editNative(dump: NativeRecord, property: string, value: unknown): Promise<void>;
    protected abstract projectNative(dump: NativeRecord): unknown;
    protected abstract projectSource(json: unknown): unknown;

    async changeProperty(asset: IAssetInfo, property: string, value: unknown): Promise<{ cachedChanged: true, sourcePersisted: false }> {
        if (asset.importer !== this.name || asset.readonly) throw animationError('INVALID_ARGUMENT', 'Asset importer identity or readonly state refuses this native edit.');
        if (this.pending.has(asset.uuid)) throw animationError('STAGED_EDIT_EXISTS', 'Apply or restore the existing staged native edit before staging another change.');
        if (this.pending.size >= 16) throw animationError('LIMIT_EXCEEDED', 'Apply or restore an existing staged animation asset before staging another.');
        const before = sourceSnapshot(asset);
        const dump = await this.queryNative(asset.uuid);
        if (!equal(this.projectNative(dump), this.projectSource(before.json))) throw animationError('STALE_ASSET_STATE', 'Native cache and saved source differ; refusing to overwrite another authoring change.');
        const edited = JSON.parse(JSON.stringify(dump)) as NativeRecord;
        await this.editNative(edited, property, value);
        const state: PendingEdit = { original: dump, expected: edited, sourceSha256: before.sha256, verified: false };
        if (sourceSnapshot(asset).sha256 !== before.sha256) throw animationError('STALE_ASSET_STATE', 'Native authoring source changed during edit validation.');
        this.pending.set(asset.uuid, state);
        try {
            const changed = await this.changeNative(asset.uuid, edited);
            if (!equal(this.projectNative(changed), this.projectNative(edited)) || sourceSnapshot(asset).sha256 !== before.sha256) throw new Error('Native cached change did not match the requested authoring state, or persisted unexpectedly.');
            state.verified = true;
            return { cachedChanged: true, sourcePersisted: false };
        } catch (error) { throw this.dispatchedError(error); }
    }
    protected stagedNative(uuid: string): NativeRecord | undefined {
        const state = this.pending.get(uuid);
        return state?.verified ? state.expected : undefined;
    }

    async apply(asset: IAssetInfo): Promise<{ cachedChanged: true, sourcePersisted: true, sourceSha256: string }> {
        if (asset.importer !== this.name || asset.readonly) throw animationError('INVALID_ARGUMENT', 'Asset identity or readonly state refuses native apply.');
        const state = this.pending.get(asset.uuid);
        if (!state) throw animationError('INVALID_ARGUMENT', 'No staged animation edit exists for this adapter.');
        if (!state.verified) throw animationError('NATIVE_ANIMATION_MUTATION_UNVERIFIED', 'Native staged authoring state is unverified; apply is forbidden until recovery inspection.', { mutationDispatched: true, retrySafe: false, restoration: 'unknown' });
        if (sourceSnapshot(asset).sha256 !== state.sourceSha256) throw animationError('STALE_ASSET_STATE', 'Source changed since staging; apply refused.');
        try {
            state.verified = false;
            await this.applyNative(asset.uuid, state.expected);
            const saved = sourceSnapshot(asset);
            if (!equal(this.projectSource(saved.json), this.projectNative(state.expected))) throw new Error('Independent native source persistence readback did not match the staged state.');
            state.appliedSourceSha256 = saved.sha256;
            state.verified = true;
            this.pending.delete(asset.uuid);
            this.recovery.delete(asset.uuid);
            if (this.recovery.size >= 16) this.recovery.delete(this.recovery.keys().next().value as string);
            this.recovery.set(asset.uuid, state);
            return { cachedChanged: true, sourcePersisted: true, sourceSha256: saved.sha256 };
        } catch (error) { throw this.dispatchedError(error); }
    }

    async restore(asset: IAssetInfo): Promise<{ restored: true, sourceBytesRestored: true }> {
        if (asset.importer !== this.name || asset.readonly) throw animationError('INVALID_ARGUMENT', 'Asset identity or readonly state refuses native restoration.');
        const state = this.pending.get(asset.uuid) || this.recovery.get(asset.uuid);
        if (!state) throw animationError('INVALID_ARGUMENT', 'No original native snapshot exists for restoration.');
        const current = sourceSnapshot(asset);
        if (current.sha256 !== state.sourceSha256 && current.sha256 !== state.appliedSourceSha256) throw animationError('STALE_ASSET_STATE', 'Source contains an unrelated or unverified change; restoration refused.');
        try {
            const restored = await this.changeNative(asset.uuid, state.original);
            if (!equal(this.projectNative(restored), this.projectNative(state.original))) throw new Error('Native cache restoration readback differs.');
            if (current.sha256 !== state.sourceSha256) await this.applyNative(asset.uuid, restored);
            const saved = sourceSnapshot(asset);
            if (saved.sha256 !== state.sourceSha256 || !equal(this.projectSource(saved.json), this.projectNative(state.original))) throw new Error('Native restoration did not reproduce the original source bytes.');
            this.pending.delete(asset.uuid);
            this.recovery.delete(asset.uuid);
            return { restored: true, sourceBytesRestored: true };
        } catch (error) { throw this.dispatchedError(error); }
    }

    async setProperty(asset: IAssetInfo, property: string, value: unknown): Promise<boolean> {
        if (this.pending.has(asset.uuid)) throw animationError('STAGED_EDIT_EXISTS', 'Apply or restore the existing staged native edit before an immediate setProperty operation.');
        await this.changeProperty(asset, property, value);
        try {
            await this.apply(asset);
            // Retain bounded original native recovery state until the next successful edit or explicit restore.
            return true;
        } catch (error) { throw this.dispatchedError(error); }
    }
    private dispatchedError(error: unknown): ToolError {
        return animationError('NATIVE_ANIMATION_MUTATION_UNVERIFIED', 'Native authoring dispatch requires recovery inspection; do not retry blindly.',
            { mutationDispatched: true, mutationPending: error instanceof Error && /timeout|timed out/i.test(error.message), retrySafe: false, restoration: 'unknown', cause: error instanceof Error ? error.message.slice(0, 512) : 'Native operation failed.' });
    }
}
