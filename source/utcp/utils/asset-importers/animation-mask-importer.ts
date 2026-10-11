import { IAssetInfo } from '@cocos/creator-types/editor/packages/asset-db/@types/public';
import { IPropertyValueType } from '@cocos/creator-types/editor/packages/scene/@types/public';
import { animationError, animationRecord, MAX_ANIMATION_EDITS, MAX_ANIMATION_ENTRIES, NativeAnimationAssetImporter, NativeRecord, serializedAnimationRoot } from './native-animation-asset';

type MaskJoint = { path: string, enabled: boolean };
type MaskMessage = 'query-animation-mask' | 'change-animation-mask' | 'apply-animation-mask';
type MaskRequest = (channel: 'scene', message: MaskMessage, ...args: unknown[]) => Promise<unknown>;

function jointPath(value: unknown): string {
    if (typeof value !== 'string' || value.length > 512 || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)
        || (value !== '' && value.split('/').some(segment => !segment || segment === '.' || segment === '..'))) {
        throw animationError('INVALID_ARGUMENT', 'Joint path must be a bounded relative native joint path without empty or traversal segments.');
    }
    return value;
}
function maskJoints(dump: NativeRecord): MaskJoint[] {
    const values = animationRecord(dump.joints).value;
    if (!Array.isArray(values) || values.length > MAX_ANIMATION_ENTRIES) throw animationError('UNSUPPORTED_OPERATION', 'Native mask joints dump must be a complete bounded property array.');
    const paths = new Set<string>();
    return values.map(item => {
        const fields = animationRecord(animationRecord(item).value);
        const path = jointPath(animationRecord(fields.path).value), enabled = animationRecord(fields.enabled).value;
        if (typeof enabled !== 'boolean' || paths.has(path)) throw animationError('UNSUPPORTED_OPERATION', 'Native mask has duplicate paths or non-Boolean enable entries.');
        paths.add(path);
        return { path, enabled };
    });
}

/** Matches Creator 3.7 native Inspector change-dump and apply routes; joint identity is never rewritten. */
export class AnimationMaskImporter extends NativeAnimationAssetImporter {
    name = 'animation-mask';
    override get className(): string { return 'AnimationMaskAssetImporter'; }

    async getProperties(asset: IAssetInfo): Promise<{ [key: string]: IPropertyValueType }> {
        return { joints: { type: 'AnimationMaskJoint[]', value: maskJoints(await this.queryNative(asset.uuid)), readonly: asset.readonly === true, visible: true } };
    }
    protected async queryNative(uuid: string): Promise<NativeRecord> {
        let result: unknown;
        try { result = await (Editor.Message.request as unknown as MaskRequest)('scene', 'query-animation-mask', uuid); }
        catch (error) {
            if (error instanceof Error && /(?:message|method|feature).*(?:not found|not registered|not supported|unavailable)|(?:unknown|unsupported).*(?:message|method)/i.test(error.message)) throw animationError('UNSUPPORTED_OPERATION', 'Installed Creator does not provide the native animation mask query route.');
            throw error;
        }
        const dump = animationRecord(result);
        maskJoints(dump);
        return dump;
    }
    protected async changeNative(uuid: string, dump: NativeRecord): Promise<NativeRecord> {
        const result = await (Editor.Message.request as unknown as MaskRequest)('scene', 'change-animation-mask', { method: 'change-dump', dump: { ...dump, uuid } });
        return animationRecord(result);
    }
    protected async applyNative(uuid: string, _dump: NativeRecord): Promise<void> {
        const result = await (Editor.Message.request as unknown as MaskRequest)('scene', 'apply-animation-mask', uuid);
        if (result === false) throw new Error('Native animation mask apply refused.');
    }
    protected async editNative(dump: NativeRecord, property: string, value: unknown): Promise<void> {
        const joints = maskJoints(dump);
        let edits: unknown[];
        const indexed = /^joints\.(0|[1-9]\d*)\.enabled$/.exec(property);
        if (property === 'joints') {
            if (!Array.isArray(value) || !value.length || value.length > MAX_ANIMATION_EDITS) throw animationError('INVALID_ARGUMENT', 'joints accepts one to 64 selected {path,enabled} changes, not an arbitrary replacement dump.');
            edits = value;
        } else if (indexed && Number(indexed[1]) < joints.length) edits = [{ path: joints[Number(indexed[1])].path, enabled: value }];
        else throw animationError('INVALID_ARGUMENT', 'Only joints selected enable edits or joints.<index>.enabled are writable.');
        const selected = new Set<string>();
        for (const edit of edits) {
            const fields = animationRecord(edit), path = jointPath(fields.path);
            if (Object.keys(fields).some(key => key !== 'path' && key !== 'enabled') || typeof fields.enabled !== 'boolean' || selected.has(path)) throw animationError('INVALID_ARGUMENT', 'Mask edits require unique existing paths and Boolean enabled values.');
            const index = joints.findIndex(joint => joint.path === path);
            if (index < 0) throw animationError('INVALID_ARGUMENT', 'Selected joint path does not exist in the queried native mask.');
            selected.add(path);
            const values = animationRecord(dump.joints).value as unknown[];
            const joint = animationRecord(animationRecord(values[index]).value);
            animationRecord(joint.enabled).value = fields.enabled;
        }
    }
    protected projectNative(dump: NativeRecord): MaskJoint[] {
        return maskJoints(dump).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }
    protected projectSource(json: unknown): MaskJoint[] {
        const { root, resolve } = serializedAnimationRoot(json, 'cc.animation.AnimationMask');
        if (!Array.isArray(root._jointMasks) || root._jointMasks.length > MAX_ANIMATION_ENTRIES) throw animationError('UNSUPPORTED_OPERATION', 'Native mask source joint collection is unavailable or exceeds the bounded adapter.');
        const seen = new Set<string>();
        return root._jointMasks.map((item: unknown) => {
            const joint = resolve(item), path = jointPath(joint.path);
            if (typeof joint.enabled !== 'boolean' || seen.has(path)) throw animationError('UNSUPPORTED_OPERATION', 'Native source mask contains invalid or duplicate joint entries.');
            seen.add(path);
            return { path, enabled: joint.enabled };
        }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }
}
