import { IAssetInfo } from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import { IPropertyValueType } from '@cocos/creator-types/editor/packages/scene/@types/public';
import { animationError, animationRecord, animationReference, MAX_ANIMATION_EDITS, MAX_ANIMATION_ENTRIES, NativeAnimationAssetImporter, NativeRecord, requireAnimationReference, serializedAnimationReference, serializedAnimationRoot } from './native-animation-asset';

type ClipOverride = { original: string, replacement: string };
type VariantMessage = 'query-animation-graph-variant' | 'change-animation-graph-variant' | 'apply-animation-graph-variant';
type VariantRequest = (channel: 'scene', message: VariantMessage, ...args: unknown[]) => Promise<unknown>;
function clipEntries(value: unknown): ClipOverride[] {
    const clips = animationRecord(value), keys = Object.keys(clips).sort();
    if (keys.length > MAX_ANIMATION_ENTRIES) throw animationError('LIMIT_EXCEEDED', 'Native variant clip collection exceeds 256 entries.');
    return keys.map(original => ({ original: animationReference(original), replacement: animationReference(clips[original], true) }));
}
function variantState(dump: NativeRecord): { baseGraph: string, clipOverrides: ClipOverride[] } {
    return { baseGraph: dump.graphUuid === undefined ? '' : animationReference(dump.graphUuid, true), clipOverrides: clipEntries(dump.clips).filter(entry => entry.replacement !== '') };
}

/** Creator 3.7 native DTO is graphUuid + clips, not the serialized _graph/_clipOverrides object table. */
export class AnimationGraphVariantImporter extends NativeAnimationAssetImporter {
    name = 'animation-graph-variant';
    override get className(): string { return 'AnimationGraphVariantAssetImporter'; }

    async getProperties(asset: IAssetInfo): Promise<{ [key: string]: IPropertyValueType }> {
        const dump = await this.queryNative(asset.uuid);
        // Stock 3.7 returns invalids; only expose diagnostics actually present in its native DTO.
        const invalidAvailable = Object.prototype.hasOwnProperty.call(dump, 'invalids');
        return {
            baseGraph: { type: 'String', value: dump.graphUuid === undefined ? '' : animationReference(dump.graphUuid, true), readonly: asset.readonly === true, visible: true },
            clipOverrides: { type: 'AnimationClipOverride[]', value: clipEntries(dump.clips), readonly: asset.readonly === true, visible: true },
            invalidEntries: { type: 'AnimationClipOverride[]', value: invalidAvailable ? clipEntries(dump.invalids) : null, readonly: true, visible: true },
            invalidEntriesAvailable: { type: 'Boolean', value: invalidAvailable, readonly: true, visible: true },
        };
    }
    protected async queryNative(uuid: string): Promise<NativeRecord> {
        let result: unknown;
        try { result = await (Editor.Message.request as unknown as VariantRequest)('scene', 'query-animation-graph-variant', uuid); }
        catch (error) {
            if (error instanceof Error && /(?:message|method|feature).*(?:not found|not registered|not supported|unavailable)|(?:unknown|unsupported).*(?:message|method)/i.test(error.message)) throw animationError('UNSUPPORTED_OPERATION', 'Installed Creator does not provide the native animation graph variant query route.');
            throw error;
        }
        const dump = animationRecord(result);
        if (Object.prototype.hasOwnProperty.call(dump, 'invalids')) clipEntries(dump.invalids);
        variantState(dump);
        return dump;
    }
    protected async changeNative(uuid: string, dump: NativeRecord): Promise<NativeRecord> {
        // The stock query DTO can omit uuid; bind cached changes explicitly to the queried asset.
        return animationRecord(await (Editor.Message.request as unknown as VariantRequest)('scene', 'change-animation-graph-variant', { ...dump, uuid }));
    }
    protected async applyNative(uuid: string, dump: NativeRecord): Promise<void> {
        // Same argument shape as the matching-version native Inspector; facade declaration omits the optional DTO.
        const result = await (Editor.Message.request as unknown as VariantRequest)('scene', 'apply-animation-graph-variant', uuid, dump);
        if (result === false) throw new Error('Native animation graph variant apply refused.');
    }
    protected async editNative(dump: NativeRecord, property: string, value: unknown): Promise<void> {
        if (property === 'baseGraph') {
            if (value === dump.graphUuid) return;
            dump.graphUuid = await requireAnimationReference(value, 'cc.animation.AnimationGraph');
            if (clipEntries(dump.clips).some(entry => entry.replacement)) throw animationError('INVALID_ARGUMENT', 'Clear existing clip substitutions before changing baseGraph; implicit override invalidation is not permitted.');
            return;
        }
        let edits: unknown[];
        const entries = clipEntries(dump.clips), indexed = /^clipOverrides\.(0|[1-9]\d*)\.replacement$/.exec(property);
        if (property === 'clipOverrides') {
            if (!Array.isArray(value) || !value.length || value.length > MAX_ANIMATION_EDITS) throw animationError('INVALID_ARGUMENT', 'clipOverrides accepts one to 64 selected {original,replacement} edits.');
            edits = value;
        } else if (indexed && Number(indexed[1]) < entries.length) edits = [{ original: entries[Number(indexed[1])].original, replacement: value }];
        else throw animationError('INVALID_ARGUMENT', 'Only baseGraph or selected clipOverrides replacements are writable; originals and invalidEntries are read-only.');
        const seen = new Set<string>();
        for (const edit of edits) {
            const fields = animationRecord(edit), original = animationReference(fields.original);
            if (Object.keys(fields).some(key => key !== 'original' && key !== 'replacement') || seen.has(original) || !Object.prototype.hasOwnProperty.call(dump.clips, original)) throw animationError('INVALID_ARGUMENT', 'Clip originals must be unique entries present in the queried native base graph.');
            seen.add(original);
            await requireAnimationReference(original, 'cc.AnimationClip');
            animationRecord(dump.clips)[original] = await requireAnimationReference(fields.replacement, 'cc.AnimationClip');
        }
    }
    protected projectNative(dump: NativeRecord): { baseGraph: string, clipOverrides: ClipOverride[] } { return variantState(dump); }
    protected projectSource(json: unknown): { baseGraph: string, clipOverrides: ClipOverride[] } {
        const { root, resolve } = serializedAnimationRoot(json, 'cc.animation.AnimationGraphVariant');
        const overrides = resolve(root._clipOverrides);
        if (!Array.isArray(overrides._entries) || overrides._entries.length > MAX_ANIMATION_ENTRIES) throw animationError('UNSUPPORTED_OPERATION', 'Native variant source clip entries are unavailable or exceed the bounded adapter.');
        const seen = new Set<string>(), clips: ClipOverride[] = [];
        for (const candidate of overrides._entries) {
            const entry = resolve(candidate), original = serializedAnimationReference(entry.original), replacement = serializedAnimationReference(entry.substitution);
            if (!original || seen.has(original)) throw animationError('UNSUPPORTED_OPERATION', 'Native variant source has missing or duplicate clip original references.');
            seen.add(original);
            if (replacement) clips.push({ original, replacement });
        }
        clips.sort((left, right) => left.original < right.original ? -1 : left.original > right.original ? 1 : 0);
        return { baseGraph: serializedAnimationReference(root._graph), clipOverrides: clips };
    }
}
