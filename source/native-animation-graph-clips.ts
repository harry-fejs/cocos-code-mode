import { ToolError } from './utcp/tool-error';

export interface GraphClipAsset { uuid: string; status: 'verified' | 'missing' | 'wrong-type' | 'identity-mismatch'; assetType: string | null }
/** Checks direct clip references only. Blend-tree descendants are outside this inspection. */
export async function inspectGraphClipAssets(states: Record<string, unknown>[], query: (uuid: string) => Promise<unknown>) {
    const ids = [...new Set(states.flatMap(state => typeof state.clipUuid === 'string' && state.clipUuid ? [state.clipUuid] : []))];
    const clips: GraphClipAsset[] = [];
    for (const uuid of ids) {
        let raw: unknown;
        try { raw = await query(uuid); }
        catch { throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Authoritative graph clip Asset DB query failed; absence is not inferred.' }); }
        if (raw === null || raw === undefined) { clips.push({ uuid, status: 'missing', assetType: null }); continue; }
        if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Asset DB returned malformed graph clip metadata.' });
        const asset = raw as Record<string, unknown>;
        const assetType = typeof asset.type === 'string' ? asset.type.slice(0, 256) : null;
        if (typeof asset.uuid !== 'string') throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Graph clip metadata has no authoritative UUID.' });
        clips.push({ uuid, status: asset.uuid !== uuid ? 'identity-mismatch' : assetType === 'cc.AnimationClip' ? 'verified' : 'wrong-type', assetType });
    }
    return { clips, checkedClips: clips.length, directClipsValid: clips.length > 0 && clips.every(clip => clip.status === 'verified'),
        clipVerificationScope: 'Inspected serialized clip references queried through Asset DB. Empty set is not proof of motion coverage; consult motionTraversalComplete. Binding, import output and runtime loading are not verified.' };
}
