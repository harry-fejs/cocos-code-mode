import { utcpTool } from '../decorators';
import fs from 'fs-extra';
import { InstanceReferenceSchema, IInstanceReference, ISuccessIndicator } from '../schemas';
import { ToolError } from '../tool-error';
import { ToolsUtils } from '../utils/tools-utils';
import { SetPropertyTool } from './set-properties-tool';

// Animation editing lives in the `scene` module (not only the animator panel).
// Messages are runtime-only (absent from typed message.d.ts); signatures mirror
// AnimationSceneFacade in @types/cce/3d/facade/animation-scene-facade.d.ts.

function requireRef(ref: IInstanceReference | undefined, what: string): string {
    if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string' || ref.id.trim().length === 0 || ref.id.length > 256) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${what} must be a non-empty reference id of at most 256 characters.` });
    }
    return ref.id;
}
function logAnimation(message: string): void {
    console.log(`[cx3][animation] ${message}`);
}


const MAX_CLIPS = 200;
const AnimationClipSchema = {
    type: 'object',
    additionalProperties: true,
    properties: {
        uuid: { type: 'string', maxLength: 256 },
        id: { type: 'string', maxLength: 256 },
        name: { type: 'string', maxLength: 256 },
        duration: { type: 'number' }
    }
};

// Clip-info is already a bounded summary route in Creator; retain only records
// and cap the returned list at the caller-selected limit.
type AnimationClipRecord = Record<string, unknown>;

function validateClipLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (!Number.isInteger(value) || !Number.isFinite(value) || Number(value) < 1 || Number(value) > MAX_CLIPS) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxClips must be an integer from 1 to ${MAX_CLIPS}.` });
    }
    return Number(value);
}

function clipList(info: unknown): AnimationClipRecord[] {
    if (Array.isArray(info)) {
        return info.filter((clip): clip is AnimationClipRecord => !!clip && typeof clip === 'object' && !Array.isArray(clip));
    }
    if (info && typeof info === 'object' && 'clips' in info && Array.isArray(info.clips)) {
        return info.clips.filter((clip): clip is AnimationClipRecord => !!clip && typeof clip === 'object' && !Array.isArray(clip));
    }
    return [];
}
const MAX_SPINE_SOURCE_BYTES = 8 * 1024 * 1024;

function spineNames(value: unknown, limit: number): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, limit);
}

function spineTimelineDuration(value: unknown): number {
    let duration = 0;
    const visit = (candidate: unknown): void => {
        if (Array.isArray(candidate)) {
            candidate.forEach(visit);
            return;
        }
        if (!candidate || typeof candidate !== 'object') return;
        for (const [key, child] of Object.entries(candidate)) {
            if (key === 'time' && typeof child === 'number' && Number.isFinite(child)) duration = Math.max(duration, child);
            else visit(child);
        }
    };
    visit(value);
    return duration;
}

function spineTimelineSummary(value: unknown, maxTracks: number): Record<string, unknown> {
    const counts: Record<string, number> = {};
    const tracks: Array<{ category: string, target: string, keyCount: number }> = [];
    const visit = (candidate: unknown, category = 'other'): void => {
        if (Array.isArray(candidate)) {
            candidate.forEach((item) => visit(item, category));
            return;
        }
        if (!candidate || typeof candidate !== 'object') return;
        const object = candidate as Record<string, unknown>;
        for (const [key, child] of Object.entries(object)) {
            const timelineCategory = ['bones', 'slots', 'deform', 'draworder', 'events', 'ik', 'transform', 'path', 'physics'].includes(key);
            if (timelineCategory && Array.isArray(child)) {
                counts[key] = (counts[key] ?? 0) + child.length;
                if (tracks.length < maxTracks) tracks.push({ category: key, target: '', keyCount: child.length });
                child.forEach((item) => visit(item, key));
            } else if (timelineCategory && child && typeof child === 'object') {
                const targetCount = Object.keys(child).length;
                counts[key] = (counts[key] ?? 0) + targetCount;
                if (tracks.length < maxTracks) tracks.push({ category: key, target: '', keyCount: targetCount });
                visit(child, key);
            } else if (Array.isArray(child)) {
                child.forEach((item) => visit(item, category));
            } else {
                visit(child, category);
            }
        }
    };
    visit(value);
    return { counts, tracks, truncatedTracks: tracks.length >= maxTracks };
}

function spineAttachmentSummary(skinsValue: unknown, maxItems: number): Record<string, unknown> {
    const skins: Array<Record<string, unknown>> = [];
    const source = skinsValue && typeof skinsValue === 'object' ? skinsValue as Record<string, unknown> : {};
    for (const [skinName, slotsValue] of Object.entries(source)) {
        const slots: Array<Record<string, unknown>> = [];
        const slotsObject = slotsValue && typeof slotsValue === 'object' ? slotsValue as Record<string, unknown> : {};
        for (const [slotName, attachmentsValue] of Object.entries(slotsObject)) {
            const attachmentsObject = attachmentsValue && typeof attachmentsValue === 'object' ? attachmentsValue as Record<string, unknown> : {};
            const attachments = Object.entries(attachmentsObject).slice(0, maxItems).map(([name, value]) => {
                const attachment = value && typeof value === 'object' ? value as Record<string, unknown> : {};
                const numeric = (key: string): number | null => typeof attachment[key] === 'number' && Number.isFinite(attachment[key]) ? attachment[key] as number : null;
                const arrayLength = (key: string): number | null => Array.isArray(attachment[key]) ? attachment[key].length : null;
                return {
                    name,
                    type: typeof attachment.type === 'string' ? attachment.type : 'region',
                    path: typeof attachment.path === 'string' ? attachment.path : null,
                    x: numeric('x'),
                    y: numeric('y'),
                    rotation: numeric('rotation'),
                    scaleX: numeric('scaleX'),
                    scaleY: numeric('scaleY'),
                    width: numeric('width'),
                    height: numeric('height'),
                    vertexCount: arrayLength('vertices'),
                    triangleCount: arrayLength('triangles') === null ? null : Math.floor((arrayLength('triangles') as number) / 3),
                };
            });
            slots.push({ name: slotName, attachmentCount: Object.keys(attachmentsObject).length, attachments, truncated: Object.keys(attachmentsObject).length > attachments.length });
            if (slots.length >= maxItems) break;
        }
        skins.push({ name: skinName, slotCount: Object.keys(slotsObject).length, slots, truncated: Object.keys(slotsObject).length > slots.length });
        if (skins.length >= maxItems) break;
    }
    return { skins, totalSkins: Object.keys(source).length, truncated: Object.keys(source).length > skins.length };
}

function spineAnimationSummary(name: string, value: unknown, maxEvents: number, maxTracks = 200): Record<string, unknown> {
    const animation = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const eventsValue = animation.events;
    const events = Array.isArray(eventsValue)
        ? eventsValue.filter((event): event is Record<string, unknown> => !!event && typeof event === 'object' && !Array.isArray(event)).slice(0, maxEvents)
        : eventsValue && typeof eventsValue === 'object'
            ? Object.entries(eventsValue).slice(0, maxEvents).map(([eventName, event]) => ({ name: eventName, ...(event && typeof event === 'object' ? event as Record<string, unknown> : {}) }))
            : [];
    return {
        name,
        duration: spineTimelineDuration(value),
        eventCount: events.length,
        events,
        truncatedEvents: Array.isArray(eventsValue)
            ? eventsValue.length > events.length

            : !!eventsValue && typeof eventsValue === 'object' && Object.keys(eventsValue).length > events.length,
        timelines: spineTimelineSummary(value, maxTracks),
    };
}
function parseSpineAtlas(text: string, maxItems: number): { pages: Record<string, unknown>[], regions: Record<string, unknown>[], truncated: boolean } {
    const lines = text.split(/\r?\n/).map((line) => line.trim());
    const pages: Record<string, unknown>[] = [];
    const regions: Record<string, unknown>[] = [];
    let currentPage: Record<string, unknown> | null = null;
    let currentRegion: Record<string, unknown> | null = null;
    let afterBlank = false;
    const flushRegion = () => {
        if (currentRegion && regions.length < maxItems) regions.push(currentRegion);
        currentRegion = null;
    };
    for (const line of lines) {
        if (!line) {
            afterBlank = true;
            continue;
        }
        const separator = line.indexOf(':');
        if (separator < 0) {
            if (!currentPage || (afterBlank && currentRegion)) {
                flushRegion();
                currentPage = { name: line };
                if (pages.length < maxItems) pages.push(currentPage);
            } else {
                currentRegion = { name: line };
            }
            afterBlank = false;
            continue;
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key === 'size' && currentRegion) {
            currentRegion[key] = value;
        } else if (key === 'size' || key === 'format' || key === 'filter' || key === 'repeat' || key === 'pma') {
            if (currentPage) currentPage[key] = value;
        } else if (key === 'xy' || key === 'bounds' || key === 'rotate' || key === 'orig' || key === 'offset' || key === 'index') {
            if (!currentRegion) currentRegion = { name: currentPage?.name ?? null };
            currentRegion[key] = value;
        } else if (currentRegion) {
            currentRegion[key] = value;
        }
        afterBlank = false;
    }
    flushRegion();
    return { pages, regions, truncated: pages.length >= maxItems || regions.length >= maxItems };
}


function slimClipDump(dump: any): any {
    if (!dump || typeof dump !== 'object') {
        return dump;
    }
    const curves = Array.isArray(dump.curves) ? dump.curves : [];
    return {
        name: dump.name,
        duration: dump.duration,
        sample: dump.sample,
        speed: dump.speed,
        wrapMode: dump.wrapMode,
        time: dump.time,
        isLock: dump.isLock,
        isSkeleton: dump.isSkeleton,
        useBakedAnimation: dump.useBakedAnimation,
        events: Array.isArray(dump.events) ? dump.events.slice(0, 200) : [],
        curveCount: curves.length,
        tracks: curves.slice(0, 200).map((c: any) => ({
            nodePath: c?.nodePath,
            key: c?.key,
            displayName: c?.displayName,
            keyframeCount: Array.isArray(c?.keyframes) ? c.keyframes.length : 0
        })),
        truncated: curves.length > 200
    };
}

type AnimationOperation = { funcName: string, args: unknown[] };
async function applyAnimationOperation(funcName: string, args: unknown[]): Promise<ISuccessIndicator & { result?: unknown }> {
    const response: any = await Editor.Message.request('scene', 'animation-operation', [{ funcName, args }], { recordUndo: true });
    if (response && response.state === 'failure') {
        logAnimation(`authoring ${funcName} failed`);
        return { success: false, error: response.reason || 'animation operation failed', result: response.result ?? null };
    }
    if (!response || response.state !== 'success') {
        throw new Error(`animation-operation returned an unexpected payload: ${JSON.stringify(response ?? null)}`);
    }
    logAnimation(`authoring ${funcName} succeeded`);
    return { success: true, result: 'result' in response ? response.result : null };
}

function requireText(value: unknown, name: string, maxLength = 512): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must be a non-empty string of at most ${maxLength} characters.` });
    }
    return value;
}

async function applyToClip(clipReference: IInstanceReference | undefined, funcName: string, args: unknown[]): Promise<ISuccessIndicator & { result?: unknown }> {
    const clipId = requireRef(clipReference, 'clipReference');
    const selected = await Editor.Message.request('scene', 'change-edit-clip', clipId);
    if (!selected) {
        throw new ToolError({ code: 'ANIMATION_CLIP_SELECTION_FAILED', status: 409, message: `Creator could not select animation clip ${clipId} for editing.` });
    }
    return applyAnimationOperation(funcName, args);
}

function requireFrame(value: unknown, name = 'frame'): number {
    if (!Number.isInteger(value) || !Number.isFinite(value) || Number(value) < 0 || Number(value) > 1_000_000) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must be an integer from 0 to 1000000.` });
    }
    return Number(value);
}

function requireFrames(value: unknown, name = 'frames'): number[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must contain 1 to 200 frame indices.` });
    }
    return value.map((frame, index) => requireFrame(frame, `${name}[${index}]`));
}

function requireOperations(value: unknown): AnimationOperation[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operations must contain 1 to 100 animation operations.' });
    }
    return value.map((operation, index) => {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `operations[${index}] must be an object.` });
        }
        const candidate = operation as Record<string, unknown>;
        return { funcName: requireText(candidate.funcName, `operations[${index}].funcName`, 128), args: Array.isArray(candidate.args) ? candidate.args : (() => { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `operations[${index}].args must be an array.` }); })() };
    });
}

export class AnimationTools {

    @utcpTool('animationCopyNode', 'Copy editor animation nodes through the native scene clipboard.', { type: 'object', properties: { references: { type: 'array', minItems: 1, maxItems: 100, items: InstanceReferenceSchema } }, required: ['references'] }, { type: 'object', properties: { success: { type: 'boolean' }, references: { type: 'array', items: InstanceReferenceSchema } }, required: ['success', 'references'] }, 'POST', ['animation', 'node', 'copy', 'clipboard'])
    async animationCopyNode(args: { references: IInstanceReference[] }): Promise<{ success: true, references: IInstanceReference[] }> {
        const ids = this.requireNodeIds(args.references);
        const copied = await Editor.Message.request('scene', 'copy-node', ids) as unknown;
        if (!Array.isArray(copied) || copied.some((id) => typeof id !== 'string' || id.length === 0)) throw new ToolError({ code: 'ANIMATION_COPY_UNCONFIRMED', status: 502, message: 'Creator did not return copied node identities.' });
        return { success: true, references: copied.map((id) => ({ id, type: 'cc.Node' })) };
    }

    @utcpTool('animationCutNode', 'Cut editor animation nodes through the native scene clipboard.', { type: 'object', properties: { references: { type: 'array', minItems: 1, maxItems: 100, items: InstanceReferenceSchema } }, required: ['references'] }, { type: 'object', properties: { success: { type: 'boolean' }, references: { type: 'array', items: InstanceReferenceSchema } }, required: ['success', 'references'] }, 'POST', ['animation', 'node', 'cut', 'clipboard'])
    async animationCutNode(args: { references: IInstanceReference[] }): Promise<{ success: true, references: IInstanceReference[] }> {
        const ids = this.requireNodeIds(args.references);
        const result = await Editor.Message.request('scene', 'cut-node', ids) as unknown;
        if (result === false) throw new ToolError({ code: 'ANIMATION_CUT_FAILED', status: 502, message: 'Creator rejected the node cut operation.' });
        await Editor.Message.request('scene', 'snapshot');
        return { success: true, references: ids.map((id) => ({ id, type: 'cc.Node' })) };
    }

    @utcpTool('animationPasteNode', 'Paste editor animation nodes through the native scene clipboard and return read-back identities.', { type: 'object', properties: { references: { type: 'array', minItems: 1, maxItems: 100, items: InstanceReferenceSchema }, targetReference: InstanceReferenceSchema, keepWorldTransform: { type: 'boolean' }, pasteAsChild: { type: 'boolean' } }, required: ['references', 'targetReference'] }, { type: 'object', properties: { success: { type: 'boolean' }, references: { type: 'array', items: InstanceReferenceSchema } }, required: ['success', 'references'] }, 'POST', ['animation', 'node', 'paste', 'clipboard'])
    async animationPasteNode(args: { references: IInstanceReference[], targetReference: IInstanceReference, keepWorldTransform?: boolean, pasteAsChild?: boolean }): Promise<{ success: true, references: IInstanceReference[] }> {
        const ids = this.requireNodeIds(args.references);
        const target = requireRef(args.targetReference, 'targetReference');
        const pasted = await Editor.Message.request('scene', 'paste-node', { target, uuids: ids, keepWorldTransform: args.keepWorldTransform ?? true, pasteAsChild: args.pasteAsChild ?? false }) as unknown;
        if (!Array.isArray(pasted) || pasted.length === 0 || pasted.some((id) => typeof id !== 'string' || id.length === 0)) throw new ToolError({ code: 'ANIMATION_PASTE_UNCONFIRMED', status: 502, message: 'Creator did not return pasted node identities.' });
        await Editor.Message.request('scene', 'snapshot');
        return { success: true, references: pasted.map((id) => ({ id, type: 'cc.Node' })) };
    }

    private requireNodeIds(references: IInstanceReference[] | undefined): string[] {
        if (!Array.isArray(references) || references.length < 1 || references.length > 100) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 100 node references.' });
        const ids = references.map((reference) => requireRef(reference, 'references[]'));
        return ids;
    }
    @utcpTool(
        'skeletalAnimationInspect',
        'Inspect animation clips exposed by a scene animation root.',
        {
            type: 'object',
            properties: { nodeReference: InstanceReferenceSchema, maxClips: { type: 'number', minimum: 1, maximum: 200, default: 50 } },
            required: ['nodeReference']
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema, clips: { type: 'array' }, totalClips: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['reference', 'clips', 'totalClips', 'truncated'] },
        'GET', ['skeletal', 'animation', 'inspect', 'clips']
    )
    async skeletalAnimationInspect(args: { nodeReference?: IInstanceReference, maxClips?: number }): Promise<{ reference: IInstanceReference, clips: AnimationClipRecord[], totalClips: number, truncated: boolean }> {
        const nodeId = requireRef(args?.nodeReference, 'nodeReference');
        const maxClips = args?.maxClips === undefined ? 50 : args.maxClips;
        if (!Number.isInteger(maxClips) || maxClips < 1 || maxClips > 200) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxClips must be an integer from 1 to 200.' });
        }
        const info = await Editor.Message.request('scene', 'query-animation-clips-info', nodeId);
        const clips: AnimationClipRecord[] = Array.isArray(info)
            ? info.filter((clip): clip is AnimationClipRecord => !!clip && typeof clip === 'object' && !Array.isArray(clip))
            : info && typeof info === 'object' && 'clips' in info && Array.isArray(info.clips)
                ? info.clips.filter((clip: unknown): clip is AnimationClipRecord => !!clip && typeof clip === 'object' && !Array.isArray(clip))
                : [];
        return { reference: { id: nodeId, type: args.nodeReference?.type ?? 'cc.Node' }, clips: clips.slice(0, maxClips), totalClips: clips.length, truncated: clips.length > maxClips };
    }
    @utcpTool(
        'spineAssetInspect',
        'Inspect bounded Spine JSON or Creator-imported binary asset metadata: animations, durations, events, bones, slots, skins, sockets, linked assets, and atlas declarations.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                maxAnimations: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
                maxEvents: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
                maxSlots: { type: 'integer', minimum: 1, maximum: 1000, default: 500 },
                maxTracks: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }
            },
            required: ['reference']
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema, importer: { type: 'string' }, source: { type: 'object', properties: { url: { type: ['string', 'null'] }, bytes: { type: 'integer', minimum: 0 }, format: { type: 'string' } }, required: ['url', 'bytes', 'format'] }, skeleton: { type: 'object' }, animations: { type: 'array' }, totalAnimations: { type: 'integer', minimum: 0 }, truncatedAnimations: { type: 'boolean' }, events: { type: 'array' }, totalEvents: { type: 'integer', minimum: 0 }, truncatedEvents: { type: 'boolean' }, bones: { type: 'array' }, slots: { type: 'array' }, skins: { type: 'array' }, attachments: { type: 'object' }, constraints: { type: 'object' }, sockets: { type: 'array' }, socketSupport: { type: 'string' }, linkedAssets: { type: 'array' }, atlases: { type: 'array' } }, required: ['reference', 'importer', 'source', 'animations', 'totalAnimations', 'truncatedAnimations', 'events', 'totalEvents', 'truncatedEvents', 'bones', 'slots', 'skins', 'attachments', 'constraints', 'sockets', 'socketSupport', 'linkedAssets', 'atlases'] },
        'GET', ['animation', 'spine', 'asset', 'inspect', 'events', 'socket', 'metadata']
    )
    async spineAssetInspect(args: { reference?: IInstanceReference, maxAnimations?: number, maxEvents?: number, maxSlots?: number, maxTracks?: number }): Promise<Record<string, unknown>> {
        const id = requireRef(args?.reference, 'reference');
        const maxAnimations = validateClipLimit(args?.maxAnimations);
        const maxEvents = args?.maxEvents ?? 200;
        const maxSlots = args?.maxSlots ?? 500;
        const maxTracks = args?.maxTracks ?? 200;
        if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 500) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxEvents must be an integer from 1 to 500.' });
        if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxSlots must be an integer from 1 to 1000.' });
        if (!Number.isInteger(maxTracks) || maxTracks < 1 || maxTracks > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxTracks must be an integer from 1 to 1000.' });
        const info: any = await Editor.Message.request('asset-db', 'query-asset-info', id);
        if (!info || typeof info !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Spine asset ${id} was not found.` });
        if (!['spine', 'spine-data'].includes(info.importer)) throw new ToolError({ code: 'UNSUPPORTED_ASSET', status: 422, message: `Asset ${id} is not a Spine import (importer: ${String(info.importer ?? 'unknown')}).` });
        if (typeof info.file !== 'string' || !(await fs.pathExists(info.file))) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: `Spine source is unavailable for ${id}.` });
        const stat = await fs.stat(info.file);
        if (stat.size > MAX_SPINE_SOURCE_BYTES) throw new ToolError({ code: 'SOURCE_TOO_LARGE', status: 413, message: `Spine source exceeds ${MAX_SPINE_SOURCE_BYTES} bytes.` });
        let source: any;
        let sourceFormat = 'spine-json';
        try {
            source = JSON.parse(await fs.readFile(info.file, 'utf8'));
        } catch (error) {
            if (!/\.skel$/i.test(info.file)) throw new ToolError({ code: 'SOURCE_INVALID', status: 422, message: `Spine source JSON could not be parsed for ${id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
            const metadata = await Editor.Message.request('asset-db', 'query-asset-meta', id).catch(() => null) as any;
            const assetData = await Editor.Message.request('asset-db', 'query-asset-data', id).catch(() => null) as any;
            const candidates = [assetData?.data, assetData?.userData, assetData, metadata?.userData, metadata, info.userData, info].filter((candidate) => candidate && typeof candidate === 'object');
            source = candidates.find((candidate) => (
                (candidate.animations && typeof candidate.animations === 'object')
                || Array.isArray(candidate.bones)
                || Array.isArray(candidate.slots)
            ));
            if (!source) throw new ToolError({ code: 'SOURCE_UNSUPPORTED', status: 422, message: `Binary Spine source requires importer metadata for ${id}.`, recovery: 'Retry after Creator has imported the asset, or use spineSceneInspect on a Skeleton node that references this SkeletonData asset.' });
            sourceFormat = 'spine-binary-import-metadata';
        }
        const animationsValue = source?.animations && typeof source.animations === 'object' ? source.animations : {};
        const animationEntries = Object.entries(animationsValue).slice(0, maxAnimations);
        const eventDefinitions = source?.events && typeof source.events === 'object'
            ? Object.entries(source.events).slice(0, maxEvents).map(([name, definition]) => ({ name, definition }))
            : [];
        const bones = Array.isArray(source?.bones) ? source.bones.slice(0, maxSlots).map((bone: any) => ({ name: bone?.name ?? null, parent: bone?.parent ?? null })) : [];
        const slots = Array.isArray(source?.slots) ? source.slots.slice(0, maxSlots).map((slot: any) => ({ name: slot?.name ?? null, bone: slot?.bone ?? null, attachment: slot?.attachment ?? null })) : [];
        const linkedAssets = Object.values(info.subAssets ?? {}).slice(0, maxSlots).map((asset: any) => ({ uuid: asset?.uuid ?? null, url: asset?.url ?? null, type: asset?.type ?? null, importer: asset?.importer ?? null }));
        const atlasFiles = Object.values(info.subAssets ?? {}).filter((asset: any) => typeof asset?.file === 'string' && /\.atlas$/i.test(asset.file)).slice(0, maxSlots) as any[];
        const atlases = [];
        for (const atlasAsset of atlasFiles) {
            const atlasStat = await fs.stat(atlasAsset.file);
            if (atlasStat.size > MAX_SPINE_SOURCE_BYTES) continue;
            const parsed = parseSpineAtlas(await fs.readFile(atlasAsset.file, 'utf8'), maxSlots);
            atlases.push({ reference: { id: atlasAsset.uuid ?? atlasAsset.url ?? atlasAsset.file, type: atlasAsset.type ?? 'sp.SpineAtlas' }, bytes: atlasStat.size, ...parsed });
        }
        const skinsValue = source?.skins;
        const attachmentSummary = spineAttachmentSummary(skinsValue, maxSlots);
        const skins = attachmentSummary.skins;
        const constraints = {
            ik: Array.isArray(source?.ik) ? source.ik.slice(0, maxSlots) : [],
            transform: Array.isArray(source?.transform) ? source.transform.slice(0, maxSlots) : [],
            path: Array.isArray(source?.path) ? source.path.slice(0, maxSlots) : [],
            physics: Array.isArray(source?.physics) ? source.physics.slice(0, maxSlots) : [],
        };
        const sockets = Array.isArray(source?.sockets)
            ? source.sockets.slice(0, maxSlots)
            : [];
        return {
            reference: { id, type: args.reference?.type ?? info.type ?? 'sp.SkeletonData' },
            importer: info.importer,
            source: { url: info.url ?? null, bytes: stat.size, format: sourceFormat },
            skeleton: source?.skeleton && typeof source.skeleton === 'object' ? source.skeleton : {},
            animations: animationEntries.map(([name, value]) => spineAnimationSummary(name, value, maxEvents, maxTracks)),
            totalAnimations: Object.keys(animationsValue).length,
            truncatedAnimations: Object.keys(animationsValue).length > animationEntries.length,
            events: eventDefinitions,
            totalEvents: source?.events && typeof source.events === 'object' ? Object.keys(source.events).length : 0,
            truncatedEvents: source?.events && typeof source.events === 'object' ? Object.keys(source.events).length > eventDefinitions.length : false,
            bones,
            slots,
            skins,
            attachments: attachmentSummary,
            constraints,
            sockets,
            socketSupport: sockets.length > 0 ? 'declared-in-source' : 'scene-component-dependent',
            linkedAssets,
            atlases,
        };
    }

    @utcpTool('spineAssetBatchInspect', 'Inspect a bounded batch of Spine assets with per-item bounded metadata and errors.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 16, items: InstanceReferenceSchema }, maxAnimations: { type: 'integer', minimum: 1, maximum: 200, default: 100 }, maxEvents: { type: 'integer', minimum: 1, maximum: 500, default: 200 }, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['animation', 'spine', 'asset', 'batch', 'inspect'])
    async spineAssetBatchInspect(args: { references: IInstanceReference[], maxAnimations?: number, maxEvents?: number, maxItems?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 16) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 16 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                items.push({ index, ok: true, result: await this.spineAssetInspect({ reference, maxAnimations: args.maxAnimations, maxEvents: args.maxEvents, maxSlots: args.maxItems, maxTracks: args.maxItems }) });
            } catch (error) {
                items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        const truncated = items.some((item) => item.ok === true && ((item.result as Record<string, unknown>)?.truncatedAnimations === true || (item.result as Record<string, unknown>)?.truncatedEvents === true));
        return { items, succeeded, failed: items.length - succeeded, truncated };
    }

    @utcpTool('spineSkeletonInspect', 'Inspect bounded Spine skeleton identity, bones, slots, constraints, linked assets, and atlas references.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, skeleton: { type: 'object' }, bones: { type: 'array' }, slots: { type: 'array' }, constraints: { type: 'object' }, linkedAssets: { type: 'array' }, atlases: { type: 'array' }, counts: { type: 'object' }, truncated: { type: 'boolean' } }, required: ['reference', 'skeleton', 'bones', 'slots', 'constraints', 'linkedAssets', 'atlases', 'counts', 'truncated'] }, 'GET', ['animation', 'spine', 'skeleton', 'bones', 'slots', 'inspect'])
    async spineSkeletonInspect(args: { reference: IInstanceReference, maxItems?: number }): Promise<Record<string, unknown>> {
        const maxItems = args.maxItems ?? 200;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxItems must be an integer from 1 to 1000.' });
        const report = await this.spineAssetInspect({ reference: args.reference, maxAnimations: 1, maxEvents: 1, maxSlots: maxItems, maxTracks: 1 });
        const bones = Array.isArray(report.bones) ? report.bones : [];
        const slots = Array.isArray(report.slots) ? report.slots : [];
        const linkedAssets = Array.isArray(report.linkedAssets) ? report.linkedAssets : [];
        const atlases = Array.isArray(report.atlases) ? report.atlases : [];
        const constraints = report.constraints && typeof report.constraints === 'object' ? report.constraints as Record<string, unknown> : {};
        const constraintCount = Object.values(constraints).reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
        const truncated = bones.length >= maxItems || slots.length >= maxItems || linkedAssets.length >= maxItems || atlases.length >= maxItems;
        return { reference: report.reference, skeleton: report.skeleton, bones, slots, constraints, linkedAssets, atlases, counts: { bones: bones.length, slots: slots.length, constraints: constraintCount, linkedAssets: linkedAssets.length, atlases: atlases.length }, truncated };
    }

    @utcpTool('spineAtlasInspect', 'Inspect bounded linked Spine atlas pages and regions for one SkeletonData asset.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, atlases: { type: 'array' }, totalPages: { type: 'integer' }, totalRegions: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'atlases', 'totalPages', 'totalRegions', 'truncated'] }, 'GET', ['animation', 'spine', 'atlas', 'inspect'])
    async spineAtlasInspect(args: { reference: IInstanceReference, maxItems?: number }): Promise<Record<string, unknown>> {
        const maxItems = args.maxItems ?? 200;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxItems must be an integer from 1 to 1000.' });
        const report = await this.spineAssetInspect({ reference: args.reference, maxAnimations: 1, maxEvents: 1, maxSlots: maxItems, maxTracks: 1 });
        const atlases = Array.isArray(report.atlases) ? report.atlases : [];
        const totalPages = atlases.reduce((total: number, atlas: any) => total + (Array.isArray(atlas?.pages) ? atlas.pages.length : 0), 0);
        const totalRegions = atlases.reduce((total: number, atlas: any) => total + (Array.isArray(atlas?.regions) ? atlas.regions.length : 0), 0);
        const truncated = atlases.some((atlas: any) => atlas?.truncated === true) || totalPages >= maxItems || totalRegions >= maxItems;
        return { reference: report.reference, atlases, totalPages, totalRegions, truncated };
    }

    @utcpTool('spineAttachmentInspect', 'Inspect bounded Spine skins, slots, and attachment metadata for one SkeletonData asset.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, skins: { type: 'array' }, totalSkins: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'skins', 'totalSkins', 'truncated'] }, 'GET', ['animation', 'spine', 'skin', 'slot', 'attachment', 'inspect'])
    async spineAttachmentInspect(args: { reference: IInstanceReference, maxItems?: number }): Promise<Record<string, unknown>> {
        const maxItems = args.maxItems ?? 200;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxItems must be an integer from 1 to 1000.' });
        const report = await this.spineAssetInspect({ reference: args.reference, maxAnimations: 1, maxEvents: 1, maxSlots: maxItems, maxTracks: 1 });
        const attachments = report.attachments && typeof report.attachments === 'object' ? report.attachments as Record<string, unknown> : {};
        return { reference: report.reference, skins: Array.isArray(attachments.skins) ? attachments.skins : [], totalSkins: typeof attachments.totalSkins === 'number' ? attachments.totalSkins : 0, truncated: attachments.truncated === true };
    }

    @utcpTool('spineSocketInspect', 'Inspect bounded Spine socket declarations and target bone paths for one SkeletonData asset.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, sockets: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'sockets', 'total', 'truncated'] }, 'GET', ['animation', 'spine', 'socket', 'inspect'])
    async spineSocketInspect(args: { reference: IInstanceReference, maxItems?: number }): Promise<Record<string, unknown>> {
        const maxItems = args.maxItems ?? 200;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxItems must be an integer from 1 to 1000.' });
        const report = await this.spineAssetInspect({ reference: args.reference, maxAnimations: 1, maxEvents: 1, maxSlots: maxItems, maxTracks: 1 });
        const sockets = Array.isArray(report.sockets) ? report.sockets.slice(0, maxItems) : [];
        const total = Array.isArray(report.sockets) ? report.sockets.length : 0;
        return { reference: report.reference, sockets, total, truncated: total > sockets.length };
    }

    @utcpTool('spineEventInspect', 'Inspect bounded Spine event definitions and animation event usages.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxItems: { type: 'integer', minimum: 1, maximum: 500, default: 200 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, definitions: { type: 'array' }, usages: { type: 'array' }, totalDefinitions: { type: 'integer' }, totalUsages: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'definitions', 'usages', 'totalDefinitions', 'totalUsages', 'truncated'] }, 'GET', ['animation', 'spine', 'event', 'inspect'])
    async spineEventInspect(args: { reference: IInstanceReference, maxItems?: number }): Promise<Record<string, unknown>> {
        const maxItems = args.maxItems ?? 200;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 500) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxItems must be an integer from 1 to 500.' });
        const report = await this.spineAssetInspect({ reference: args.reference, maxAnimations: 200, maxEvents: maxItems, maxSlots: 1, maxTracks: 200 });
        const definitions = Array.isArray(report.events) ? report.events.slice(0, maxItems) : [];
        const allUsages = (Array.isArray(report.animations) ? report.animations : []).flatMap((animation: any) => (Array.isArray(animation?.events) ? animation.events.map((event: any) => ({ animation: animation.name ?? null, ...event })) : []));
        const usages = allUsages.slice(0, maxItems);
        return { reference: report.reference, definitions, usages, totalDefinitions: typeof report.totalEvents === 'number' ? report.totalEvents : definitions.length, totalUsages: allUsages.length, truncated: report.truncatedEvents === true || allUsages.length > usages.length };
    }

    @utcpTool('spineEventValidate', 'Validate bounded Spine event definitions and animation event usages.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, definitions: { type: 'integer' }, usages: { type: 'integer' }, issues: { type: 'array' } }, required: ['valid', 'reference', 'definitions', 'usages', 'issues'] }, 'GET', ['animation', 'spine', 'event', 'validate'])
    async spineEventValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.spineEventInspect({ reference: args.reference, maxItems: 500 });
        const definitions = inspected.definitions as Array<Record<string, unknown>>;
        const usages = inspected.usages as Array<Record<string, unknown>>;
        const names = new Set(definitions.map((event) => event.name).filter((name): name is string => typeof name === 'string'));
        const issues = usages.filter((usage) => typeof usage.name === 'string' && !names.has(usage.name)).map((usage) => ({ code: 'ANIMATION_EVENT_UNDEFINED', animation: usage.animation ?? null, name: usage.name }));
        return { valid: issues.length === 0, reference: inspected.reference, definitions: definitions.length, usages: usages.length, issues };
    }

    @utcpTool('spineAssetBatchValidate', 'Validate a bounded batch of Spine assets with per-item relationship issues and errors.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, maxIssues: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, invalid: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'invalid', 'partial'] }, 'GET', ['animation', 'spine', 'asset', 'batch', 'validate'])
    async spineAssetBatchValidate(args: { references: IInstanceReference[], maxIssues?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 32 items.' });
        const maxIssues = args.maxIssues ?? 100;
        if (!Number.isInteger(maxIssues) || maxIssues < 1 || maxIssues > 500) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxIssues must be an integer from 1 to 500.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.spineAssetValidate({ reference, maxIssues }) });
            } catch (error) {
                outcomes.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        const invalid = outcomes.filter((outcome) => outcome.ok === true && (outcome.result as Record<string, unknown>)?.valid === false).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, invalid, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool(
        'spineAssetValidate',
        'Validate bounded Spine source relationships between bones, slots, attachments, events, sockets, constraints, and atlas regions.',
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, maxIssues: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
            required: ['reference']
        },
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                valid: { type: 'boolean' },
                issues: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'path', 'message'] } },
                checked: { type: 'object', properties: { bones: { type: 'integer' }, events: { type: 'integer' }, attachments: { type: 'integer' }, atlasRegions: { type: 'integer' }, sockets: { type: 'integer' }, slots: { type: 'integer' }, constraints: { type: 'integer' } }, required: ['bones', 'events', 'attachments', 'atlasRegions', 'sockets', 'slots', 'constraints'] },
                truncated: { type: 'boolean' }
            },
            required: ['reference', 'valid', 'issues', 'checked', 'truncated']
        },
        'GET', ['animation', 'spine', 'asset', 'validate', 'attachments', 'events', 'constraints']
    )
    async spineAssetValidate(args: { reference?: IInstanceReference, maxIssues?: number }): Promise<Record<string, unknown>> {
        const id = requireRef(args?.reference, 'reference');
        const maxIssues = args?.maxIssues ?? 100;
        if (!Number.isInteger(maxIssues) || maxIssues < 1 || maxIssues > 500) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxIssues must be an integer from 1 to 500.' });
        const report = await this.spineAssetInspect({ reference: args.reference, maxAnimations: 200, maxEvents: 500, maxSlots: 1000, maxTracks: 1000 });
        const issues: Record<string, unknown>[] = [];
        let truncated = false;
        const add = (code: string, path: string, message: string) => {
            if (issues.length < maxIssues) issues.push({ code, path, message });
            else truncated = true;
        };
        const bones = new Set((Array.isArray(report.bones) ? report.bones : []).map((bone: any) => bone?.name).filter((name): name is string => typeof name === 'string'));
        const eventNames = new Set((Array.isArray(report.events) ? report.events : []).map((event: any) => event?.name).filter((name): name is string => typeof name === 'string'));
        const seenBones = new Set<string>();
        for (const [index, bone] of (Array.isArray(report.bones) ? report.bones : []).entries()) {
            const name = (bone as any)?.name;
            if (typeof name === 'string') {
                if (seenBones.has(name)) add('DUPLICATE_BONE_NAME', `bones[${index}].name`, `Bone ${name} is declared more than once.`);
                seenBones.add(name);
                if (typeof (bone as any)?.parent === 'string' && !bones.has((bone as any).parent)) add('BONE_PARENT_MISSING', `bones[${index}].parent`, `Bone parent ${(bone as any).parent} is not declared.`);
            }
        }
        const boneParents = new Map<string, string>();
        for (const bone of Array.isArray(report.bones) ? report.bones : []) {
            if (typeof (bone as any)?.name === 'string' && typeof (bone as any)?.parent === 'string') boneParents.set((bone as any).name, (bone as any).parent);
        }
        const reportedCycles = new Set<string>();
        for (const boneName of boneParents.keys()) {
            const path = new Set<string>();
            let current: string | undefined = boneName;
            while (current && boneParents.has(current) && !path.has(current)) {
                path.add(current);
                current = boneParents.get(current);
            }
            if (current && path.has(current) && !reportedCycles.has(current)) {
                for (const node of path) reportedCycles.add(node);
                add('BONE_PARENT_CYCLE', `bones.${current}`, `Bone parent chain contains a cycle at ${current}.`);
            }
        }
        const seenEvents = new Set<string>();
        for (const [index, event] of (Array.isArray(report.events) ? report.events : []).entries()) {
            const name = (event as any)?.name;
            if (typeof name === 'string') {
                if (seenEvents.has(name)) add('DUPLICATE_EVENT_NAME', `events[${index}].name`, `Event ${name} is declared more than once.`);
                seenEvents.add(name);
            }
        }
        const seenSockets = new Set<string>();
        for (const [index, socket] of (Array.isArray(report.sockets) ? report.sockets : []).entries()) {
            const name = (socket as any)?.name;
            if (typeof name === 'string') {
                if (seenSockets.has(name)) add('DUPLICATE_SOCKET_NAME', `sockets[${index}].name`, `Socket ${name} is declared more than once.`);
                seenSockets.add(name);
            }
        }
        const seenSlots = new Set<string>();
        for (const [index, slot] of (Array.isArray(report.slots) ? report.slots : []).entries()) {
            const name = (slot as any)?.name;
            if (typeof name === 'string') {
                if (seenSlots.has(name)) add('DUPLICATE_SLOT_NAME', `slots[${index}].name`, `Slot ${name} is declared more than once.`);
                seenSlots.add(name);
            }
        }
        const constraints = report.constraints as Record<string, unknown> | undefined;
        for (const category of ['ik', 'transform', 'path', 'physics']) {
            for (const [index, constraint] of (Array.isArray(constraints?.[category]) ? constraints[category] as unknown[] : []).entries()) {
                const entry = constraint as Record<string, unknown>;
                for (const [boneIndex, bone] of (Array.isArray(entry?.bones) ? entry.bones : []).entries()) {
                    if (typeof bone === 'string' && !bones.has(bone)) add('CONSTRAINT_BONE_MISSING', `constraints.${category}[${index}].bones[${boneIndex}]`, `Constraint bone ${bone} is not declared.`);
                }
                if (typeof entry?.target === 'string' && !bones.has(entry.target)) add('CONSTRAINT_TARGET_BONE_MISSING', `constraints.${category}[${index}].target`, `Constraint target ${entry.target} is not declared.`);
            }
        }
        const attachmentNames = new Set<string>();
        const atlasRegions = new Set<string>();
        for (const atlas of Array.isArray(report.atlases) ? report.atlases : []) {
            for (const region of Array.isArray((atlas as any)?.regions) ? (atlas as any).regions : []) {
                if (typeof (region as any)?.name === 'string') atlasRegions.add((region as any).name);
            }
        }
        const attachmentPaths: Array<{ path: string, source: string }> = [];
        for (const skin of Array.isArray(report.skins) ? report.skins : []) {
            for (const slot of Array.isArray((skin as any)?.slots) ? (skin as any).slots : []) {
                for (const attachment of Array.isArray((slot as any)?.attachments) ? (slot as any).attachments : []) {
                    if (typeof (attachment as any)?.name === 'string') attachmentNames.add((attachment as any).name);
                    if (typeof (attachment as any)?.path === 'string') attachmentPaths.push({ path: (attachment as any).path, source: `${(skin as any)?.name ?? 'skin'}.${(slot as any)?.name ?? 'slot'}.${(attachment as any)?.name ?? 'attachment'}` });
                }
            }
        }
        if (atlasRegions.size > 0) {
            for (const attachment of attachmentPaths) {
                if (!atlasRegions.has(attachment.path)) add('ATTACHMENT_ATLAS_REGION_MISSING', attachment.source, `Attachment path ${attachment.path} is not present in linked atlas regions.`);
            }
        }
        for (const [index, socket] of (Array.isArray(report.sockets) ? report.sockets : []).entries()) {
            if (typeof (socket as any)?.bone === 'string' && !bones.has((socket as any).bone)) add('SOCKET_BONE_MISSING', `sockets[${index}].bone`, `Socket bone ${(socket as any).bone} is not declared.`);
        }
        for (const [index, slot] of (Array.isArray(report.slots) ? report.slots : []).entries()) {
            if (typeof (slot as any)?.bone === 'string' && !bones.has((slot as any).bone)) add('SLOT_BONE_MISSING', `slots[${index}].bone`, `Slot bone ${(slot as any).bone} is not declared.`);
            if (typeof (slot as any)?.attachment === 'string' && !attachmentNames.has((slot as any).attachment)) add('SLOT_ATTACHMENT_MISSING', `slots[${index}].attachment`, `Slot attachment ${(slot as any).attachment} is not declared in any skin.`);
        }
        for (const [animationIndex, animation] of (Array.isArray(report.animations) ? report.animations : []).entries()) {
            for (const [eventIndex, event] of (Array.isArray((animation as any)?.events) ? (animation as any).events : []).entries()) {
                if (typeof (event as any)?.name === 'string' && !eventNames.has((event as any).name)) add('ANIMATION_EVENT_MISSING', `animations[${animationIndex}].events[${eventIndex}].name`, `Animation event ${(event as any).name} has no event definition.`);
            }
        }
        return {
            reference: report.reference ?? { id, type: args.reference?.type ?? 'sp.SkeletonData' },
            valid: issues.length === 0,
            issues,
            checked: { bones: bones.size, events: eventNames.size, attachments: attachmentNames.size, atlasRegions: atlasRegions.size, sockets: Array.isArray(report.sockets) ? report.sockets.length : 0, slots: Array.isArray(report.slots) ? report.slots.length : 0, constraints: ['ik', 'transform', 'path', 'physics'].reduce((total, category) => total + (Array.isArray((report.constraints as any)?.[category]) ? (report.constraints as any)[category].length : 0), 0) },
            truncated,
        };
    }

    @utcpTool(
        'spineSceneInspect',
        'Inspect live Spine Skeleton components, bones, slots, attachments, sockets, animation tracks, and playback properties.',
        { type: 'object', properties: { nodeReference: InstanceReferenceSchema, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } } },
        {
            type: 'object', additionalProperties: false,
            properties: {
                nodeUuid: { type: ['string', 'null'] },
                findings: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, properties: {
                    node: { type: 'object', additionalProperties: false, properties: { id: { type: ['string', 'null'] }, name: { type: ['string', 'null'] } }, required: ['id', 'name'] },
                    component: { type: 'string' },
                    defaultAnimation: { type: ['string', 'null'] },
                    animation: { type: ['string', 'null'] },
                    timeScale: { type: ['number', 'null'] },
                    loop: { type: ['boolean', 'null'] },
                    animations: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, properties: { name: { type: ['string', 'null'] }, duration: { type: ['number', 'null'] } }, required: ['name', 'duration'] } },
                    tracks: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, properties: { index: { type: 'integer' }, animation: { type: ['string', 'null'] }, loop: { type: ['boolean', 'null'] }, trackTime: { type: ['number', 'null'] }, delay: { type: ['number', 'null'] }, alpha: { type: ['number', 'null'] } }, required: ['index', 'animation', 'loop', 'trackTime', 'delay', 'alpha'] } },
                    bones: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, properties: { name: { type: ['string', 'null'] }, parent: { type: ['string', 'null'] }, x: { type: ['number', 'null'] }, y: { type: ['number', 'null'] } }, required: ['name', 'parent', 'x', 'y'] } },
                    slots: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, properties: { name: { type: ['string', 'null'] }, bone: { type: ['string', 'null'] }, attachment: { type: ['string', 'null'] }, attachmentType: { type: ['string', 'null'] } }, required: ['name', 'bone', 'attachment', 'attachmentType'] } },
                    sockets: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, properties: { name: { type: ['string', 'null'] }, path: { type: ['string', 'null'] }, bone: { type: ['string', 'null'] } }, required: ['name', 'path', 'bone'] } },
                    hasSkeletonData: { type: 'boolean' },
                }, required: ['node', 'component', 'defaultAnimation', 'animation', 'timeScale', 'loop', 'animations', 'tracks', 'bones', 'slots', 'sockets', 'hasSkeletonData'] } },
                total: { type: 'integer', minimum: 0, maximum: 1000 },
                truncated: { type: 'boolean' }
            },
            required: ['nodeUuid', 'findings', 'total', 'truncated']
        },
        'GET', ['animation', 'spine', 'scene', 'inspect', 'socket', 'attachment', 'track']
    )
    async spineSceneInspect(args: { nodeReference?: IInstanceReference, maxItems?: number }): Promise<Record<string, unknown>> {
        if (args?.nodeReference) requireRef(args.nodeReference, 'nodeReference');
        if (args?.maxItems !== undefined && (!Number.isInteger(args.maxItems) || args.maxItems < 1 || args.maxItems > 1000)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxItems must be an integer from 1 to 1000.' });
        }
        const requestedMaxItems = args.maxItems ?? 200;
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x',
            method: 'spineSceneInspect',
            args: [{ nodeUuid: args.nodeReference?.id, maxItems: requestedMaxItems }],
        }) as Record<string, unknown> | null;
        const total = result?.total;
        const findings = result?.findings;
        const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
        const nullableFiniteNumber = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value));
        const hasOnlyKeys = (value: unknown, keys: string[]): boolean => (
            !!value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).every((key) => keys.includes(key))
        );
        const everyItem = (items: any[], predicate: (item: any) => boolean): boolean => {
            for (let index = 0; index < items.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(items, index) || !predicate(items[index])) return false;
            }
            return true;
        };
        const boundedItems = (items: any[]): boolean => items.length <= requestedMaxItems;
        const validAnimations = (items: any[]): boolean => boundedItems(items) && everyItem(items, (item) => hasOnlyKeys(item, ['name', 'duration']) && nullableString(item.name) && nullableFiniteNumber(item.duration));
        const validTracks = (items: any[]): boolean => boundedItems(items) && everyItem(items, (item) => hasOnlyKeys(item, ['index', 'animation', 'loop', 'trackTime', 'delay', 'alpha']) && Number.isInteger(item.index) && nullableString(item.animation) && (item.loop === null || typeof item.loop === 'boolean') && nullableFiniteNumber(item.trackTime) && nullableFiniteNumber(item.delay) && nullableFiniteNumber(item.alpha));
        const validBones = (items: any[]): boolean => boundedItems(items) && everyItem(items, (item) => hasOnlyKeys(item, ['name', 'parent', 'x', 'y']) && nullableString(item.name) && nullableString(item.parent) && nullableFiniteNumber(item.x) && nullableFiniteNumber(item.y));
        const validSlots = (items: any[]): boolean => boundedItems(items) && everyItem(items, (item) => hasOnlyKeys(item, ['name', 'bone', 'attachment', 'attachmentType']) && nullableString(item.name) && nullableString(item.bone) && nullableString(item.attachment) && nullableString(item.attachmentType));
        const validSockets = (items: any[]): boolean => boundedItems(items) && everyItem(items, (item) => hasOnlyKeys(item, ['name', 'path', 'bone']) && nullableString(item.name) && nullableString(item.path) && nullableString(item.bone));
        const validFindings = Array.isArray(findings) && boundedItems(findings) && everyItem(findings, (finding: any) => (
            hasOnlyKeys(finding, ['node', 'component', 'defaultAnimation', 'animation', 'timeScale', 'loop', 'animations', 'tracks', 'bones', 'slots', 'sockets', 'hasSkeletonData'])
            && hasOnlyKeys(finding.node, ['id', 'name'])
            && (typeof finding.node.id === 'string' || finding.node.id === null)
            && (typeof finding.node.name === 'string' || finding.node.name === null)
            && nullableString(finding.defaultAnimation)
            && nullableString(finding.animation)
            && nullableFiniteNumber(finding.timeScale)
            && typeof finding.component === 'string'
            && (finding.loop === null || typeof finding.loop === 'boolean')
            && Array.isArray(finding.animations) && validAnimations(finding.animations)
            && Array.isArray(finding.tracks) && validTracks(finding.tracks)
            && Array.isArray(finding.bones) && validBones(finding.bones)
            && Array.isArray(finding.slots) && validSlots(finding.slots)
            && Array.isArray(finding.sockets) && validSockets(finding.sockets)
            && typeof finding.hasSkeletonData === 'boolean'
        ));
        const validNodeUuid = result?.nodeUuid === null || typeof result?.nodeUuid === 'string';
        const validRoot = hasOnlyKeys(result, ['nodeUuid', 'findings', 'total', 'truncated']);
        if (!validRoot || !result || !validNodeUuid || !validFindings || typeof total !== 'number' || !Number.isInteger(total) || total < 0 || total > requestedMaxItems || total !== findings.length || typeof result.truncated !== 'boolean') {
            throw new ToolError({ code: 'SPINE_SCENE_INSPECTION_FAILED', status: 502, message: 'Creator returned malformed Spine scene inspection.' });
        }
        return result;
    }
    @utcpTool('spineAssetSceneUsageInspect', 'Inspect scene nodes referencing one Spine SkeletonData asset and return bounded live Skeleton read-back.', { type: 'object', additionalProperties: false, properties: { assetReference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: 32, default: 16 }, maxItemsPerNode: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, required: ['assetReference'] }, { type: 'object', additionalProperties: false, properties: { assetReference: InstanceReferenceSchema, nodes: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['assetReference', 'nodes', 'total', 'truncated'] }, 'GET', ['animation', 'spine', 'asset', 'scene', 'usage'])
    async spineAssetSceneUsageInspect(args: { assetReference: IInstanceReference, limit?: number, maxItemsPerNode?: number }): Promise<Record<string, unknown>> {
        const assetId = requireRef(args?.assetReference, 'assetReference');
        const limit = args.limit ?? 16;
        if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'limit must be an integer from 1 to 32.' });
        const nodeIds = await Editor.Message.request('scene', 'query-nodes-by-asset-uuid', assetId);
        if (!Array.isArray(nodeIds)) throw new ToolError({ code: 'SPINE_SCENE_INSPECTION_FAILED', status: 502, message: 'Creator did not return Spine asset scene usages.' });
        const nodes: Array<Record<string, unknown>> = [];
        for (const nodeId of nodeIds.slice(0, limit)) {
            if (typeof nodeId !== 'string' || !nodeId) continue;
            try {
                nodes.push({ nodeReference: { id: nodeId, type: 'cc.Node' }, ok: true, inspection: await this.spineSceneInspect({ nodeReference: { id: nodeId, type: 'cc.Node' }, maxItems: args.maxItemsPerNode }) });
            } catch (error) {
                nodes.push({ nodeReference: { id: nodeId, type: 'cc.Node' }, ok: false, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        return { assetReference: { id: assetId, type: args.assetReference.type ?? 'sp.SkeletonData' }, nodes, total: nodeIds.length, truncated: nodeIds.length > nodes.length || nodes.some((node) => (node.inspection as Record<string, unknown>)?.truncated === true) };
    }
    @utcpTool('spineAssetSceneUsageReport', 'Return a bounded per-node Spine asset scene usage report with explicit live/read-back status.', { type: 'object', additionalProperties: false, properties: { assetReference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: 32, default: 16 } }, required: ['assetReference'] }, { type: 'object', additionalProperties: false, properties: { assetReference: InstanceReferenceSchema, entries: { type: 'array' }, total: { type: 'integer' }, liveCount: { type: 'integer' }, failedCount: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['assetReference', 'entries', 'total', 'liveCount', 'failedCount', 'truncated'] }, 'GET', ['animation', 'spine', 'asset', 'scene', 'report'])
    async spineAssetSceneUsageReport(args: { assetReference: IInstanceReference, limit?: number }): Promise<Record<string, unknown>> {
        const inspected = await this.spineAssetSceneUsageInspect({ assetReference: args.assetReference, limit: args.limit });
        const entries = inspected.nodes as Array<Record<string, unknown>>;
        const liveCount = entries.filter((entry) => entry.ok === true).length;
        return { assetReference: inspected.assetReference, entries, total: inspected.total, liveCount, failedCount: entries.length - liveCount, truncated: inspected.truncated };
    }
    @utcpTool('spineAssetSceneUsageBatchReport', 'Return bounded scene usage reports for multiple Spine SkeletonData assets with per-asset failures.', { type: 'object', additionalProperties: false, properties: { assetReferences: { type: 'array', minItems: 1, maxItems: 16, items: InstanceReferenceSchema }, limitPerAsset: { type: 'integer', minimum: 1, maximum: 32, default: 16 } }, required: ['assetReferences'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, liveCount: { type: 'integer' }, truncated: { type: 'boolean' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'liveCount', 'truncated', 'partial'] }, 'GET', ['animation', 'spine', 'asset', 'scene', 'usage', 'batch', 'report'])
    async spineAssetSceneUsageBatchReport(args: { assetReferences: IInstanceReference[], limitPerAsset?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.assetReferences) || args.assetReferences.length < 1 || args.assetReferences.length > 16) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetReferences must contain 1 to 16 items.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, assetReference] of args.assetReferences.entries()) {
            try {
                outcomes.push({ index, assetReference, ok: true, report: await this.spineAssetSceneUsageReport({ assetReference, limit: args.limitPerAsset }) });
            } catch (error) {
                outcomes.push({ index, assetReference, ok: false, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        const liveCount = outcomes.reduce((total, outcome) => total + (outcome.ok === true && typeof (outcome.report as Record<string, unknown>)?.liveCount === 'number' ? (outcome.report as Record<string, unknown>).liveCount as number : 0), 0);
        const truncated = outcomes.some((outcome) => outcome.ok === true && (outcome.report as Record<string, unknown>)?.truncated === true);
        return { outcomes, succeeded, failed: outcomes.length - succeeded, liveCount, truncated, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('spineAssetSceneUsageValidate', 'Validate that all bounded scene usages of one Spine asset expose live Skeleton components.', { type: 'object', additionalProperties: false, properties: { assetReference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: 32, default: 16 } }, required: ['assetReference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, assetReference: InstanceReferenceSchema, checked: { type: 'integer' }, issues: { type: 'array' } }, required: ['valid', 'assetReference', 'checked', 'issues'] }, 'GET', ['animation', 'spine', 'asset', 'scene', 'validate'])
    async spineAssetSceneUsageValidate(args: { assetReference: IInstanceReference, limit?: number }): Promise<Record<string, unknown>> {
        const inspected = await this.spineAssetSceneUsageInspect({ assetReference: args.assetReference, limit: args.limit });
        const issues: Array<Record<string, unknown>> = [];
        for (const node of inspected.nodes as Array<Record<string, unknown>>) {
            if (node.ok !== true) issues.push({ code: 'SPINE_SCENE_USAGE_UNAVAILABLE', nodeReference: node.nodeReference });
            else if (!Array.isArray((node.inspection as Record<string, unknown>)?.findings) || ((node.inspection as Record<string, unknown>)?.findings as unknown[]).length === 0) issues.push({ code: 'SPINE_COMPONENT_NOT_FOUND', nodeReference: node.nodeReference });
        }
        return { valid: issues.length === 0, assetReference: inspected.assetReference, checked: (inspected.nodes as unknown[]).length, issues };
    }

    @utcpTool('spineSceneBatchInspect', 'Inspect live Spine components for a bounded set of scene roots with per-item errors.', { type: 'object', additionalProperties: false, properties: { nodeReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, required: ['nodeReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['animation', 'spine', 'scene', 'batch', 'inspect'])
    async spineSceneBatchInspect(args: { nodeReferences: IInstanceReference[], maxItems?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.nodeReferences) || args.nodeReferences.length < 1 || args.nodeReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReferences must contain 1 to 32 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, nodeReference] of args.nodeReferences.entries()) {
            try {
                items.push({ index, ok: true, result: await this.spineSceneInspect({ nodeReference, maxItems: args.maxItems }) });
            } catch (error) {
                items.push({ index, ok: false, nodeReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        const truncated = items.some((item) => item.ok === true && (item.result as Record<string, unknown>)?.truncated === true);
        return { items, succeeded, failed: items.length - succeeded, truncated };
    }


    @utcpTool(
        'skeletalAnimationValidate',
        'Validate that a scene animation root exposes a well-formed clip list.',
        {
            type: 'object',
            properties: { nodeReference: InstanceReferenceSchema, maxClips: { type: 'number', minimum: 1, maximum: 200, default: 50 } },
            required: ['nodeReference']
        },
        { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, clipCount: { type: 'number' } }, required: ['valid', 'issues', 'clipCount'] },
        'POST', ['skeletal', 'animation', 'validate', 'clips']
    )
    async skeletalAnimationValidate(args: { nodeReference?: IInstanceReference, maxClips?: number }): Promise<{ valid: boolean, issues: string[], clipCount: number }> {
        const inspected = await this.skeletalAnimationInspect(args);
        const issues: string[] = [];
        inspected.clips.forEach((clip, index) => {
            if (!clip || typeof clip !== 'object') issues.push(`clip[${index}] is not an object`);
            else if (typeof clip.uuid !== 'string' && typeof clip.id !== 'string' && typeof clip.name !== 'string') issues.push(`clip[${index}] has no stable identity`);
        });
        return { valid: issues.length === 0, issues, clipCount: inspected.totalClips };
    }

    @utcpTool(
        'animationQuery',
        'Query animation data: root_info, clips_info, clip_dump (slim by default), properties, state, value_at_frame.',
        {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['root_info', 'root', 'edit_info', 'clips_info', 'clip_dump', 'properties', 'state', 'current_info', 'clip_time', 'value_at_frame']
                },
                nodeReference: InstanceReferenceSchema,
                clipReference: InstanceReferenceSchema,
                includeCurves: { type: 'boolean', description: 'For clip_dump: return the full curve/keyframe data instead of a track summary. Can be very large.', default: false },
                maxCurves: { type: 'number', minimum: 1, maximum: 1000, default: 200, description: 'For clip_dump with includeCurves: maximum raw curves to return.' },
                nodePath: { type: 'string', description: 'For value_at_frame: path of the animated node relative to the animation root, e.g. "/Body/Arm"' },
                propKey: { type: 'string', description: 'For value_at_frame: animated property key, e.g. "position"' },
                frame: { type: 'number', description: 'For value_at_frame: frame index' }
            },
            required: ['operation']
        },
        { type: 'object', properties: { result: {} }, required: ['result'] }, "GET",
        ['animation', 'clip', 'keyframe', 'curve', 'query', 'timeline', 'anim', 'track']
    )
    async animationQuery(args: {
        operation: string, nodeReference?: IInstanceReference, clipReference?: IInstanceReference,
        includeCurves?: boolean, maxCurves?: number, nodePath?: string, propKey?: string, frame?: number
    }): Promise<{ result: any }> {
        let result: any;
        switch (args.operation) {
            case 'root_info':
                result = await Editor.Message.request('scene', 'query-animation-root-info', requireRef(args.nodeReference, 'nodeReference'));
                break;
            case 'root':
                result = await Editor.Message.request('scene', 'query-animation-root', requireRef(args.nodeReference, 'nodeReference'));
                break;
            case 'edit_info':
                result = await Editor.Message.request('scene', 'query-animation-edit-info', requireRef(args.nodeReference, 'nodeReference'));
                break;
            case 'clips_info':
                result = await Editor.Message.request('scene', 'query-animation-clips-info', requireRef(args.nodeReference, 'nodeReference'));
                break;
            case 'clip_dump': {
                const dump = await Editor.Message.request('scene', 'query-animation-clip',
                    requireRef(args.nodeReference, 'nodeReference'), requireRef(args.clipReference, 'clipReference'));
                if (!args.includeCurves || !dump || typeof dump !== 'object' || !Array.isArray(dump.curves)) {
                    result = args.includeCurves ? dump : slimClipDump(dump);
                    break;
                }
                const maxCurves = Math.min(Math.max(args.maxCurves ?? 200, 1), 1000);
                result = { ...dump, curves: dump.curves.slice(0, maxCurves), totalCurves: dump.curves.length, truncated: dump.curves.length > maxCurves };
                break;
            }
            case 'properties':
                result = await Editor.Message.request('scene', 'query-animation-properties', requireRef(args.nodeReference, 'nodeReference'));
                break;
            case 'state':
                result = await Editor.Message.request('scene', 'query-animation-state');
                break;
            case 'current_info':
                result = await Editor.Message.request('scene', 'query-current-animation-info');
                break;
            case 'clip_time':
                result = await Editor.Message.request('scene', 'query-animation-clips-time', requireRef(args.clipReference, 'clipReference'));
                break;
            case 'value_at_frame':
                if (!args.nodePath || !args.propKey || args.frame === undefined) {
                    throw new Error('value_at_frame requires nodePath, propKey and frame');
                }
                result = await Editor.Message.request('scene', 'query-property-value-at-frame',
                    requireRef(args.clipReference, 'clipReference'), args.nodePath, args.propKey, args.frame);
                break;
            default:
                throw new Error(`Unknown animation query operation: ${args.operation}`);
        }
        return { result: result === undefined ? null : result };
    }

    @utcpTool(
        'animationEdit',
        'Edit animation clips: record_start -> operate -> save_clip -> record_stop.',
        {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['record_start', 'record_stop', 'change_root', 'set_edit_clip', 'set_edit_time', 'clip_state', 'save_clip', 'operate']
                },
                nodeReference: InstanceReferenceSchema,
                clipReference: InstanceReferenceSchema,
                time: { type: 'number', description: 'For set_edit_time: playhead time in seconds' },
                clipState: { type: 'string', enum: ['play', 'pause', 'resume', 'stop'], description: 'For clip_state' },
                operations: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                        type: 'object',
                        properties: {
                            funcName: { type: 'string' },
                            args: { type: 'array', items: {} }
                        },
                        required: ['funcName', 'args']
                    }
                }
            },
            required: ['operation']
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                error: { type: 'string' },
                result: { description: 'For operate: the result payload of the animation operation' }
            },
            required: ['success']
        }, "POST",
        ['animation', 'clip', 'keyframe', 'curve', 'record', 'edit', 'timeline', 'anim', 'save']
    )
    async animationEdit(args: {
        operation: string, nodeReference?: IInstanceReference, clipReference?: IInstanceReference,
        time?: number, clipState?: string, operations?: { funcName: string, args: any[] }[]
    }): Promise<ISuccessIndicator & { result?: any }> {
        // Animation has its own undo stack (AnimationUndoManager) driven by recordUndo -
        // a scene snapshot() here would record into the wrong stack while in record mode.
        switch (args.operation) {
            case 'record_start':
            case 'record_stop': {
                const active = args.operation === 'record_start';
                const ok = await Editor.Message.request('scene', 'record-animation',
                    requireRef(args.nodeReference, 'nodeReference'), active, args.clipReference?.id);
                if (!ok) {
                    throw new Error(`Failed to ${active ? 'enter' : 'exit'} animation record mode`);
                }
                return { success: true };
            }
            case 'change_root': {
                const ok = await Editor.Message.request('scene', 'change-animation-root',
                    requireRef(args.nodeReference, 'nodeReference'), requireRef(args.clipReference, 'clipReference'));
                return { success: !!ok };
            }
            case 'set_edit_clip': {
                const ok = await Editor.Message.request('scene', 'change-edit-clip', requireRef(args.clipReference, 'clipReference'));
                return { success: !!ok };
            }
            case 'set_edit_time': {
                if (args.time === undefined) {
                    throw new Error('set_edit_time requires time');
                }
                const ok = await Editor.Message.request('scene', 'set-edit-time', args.time);
                return { success: !!ok };
            }
            case 'clip_state': {
                if (!args.clipState) {
                    throw new Error('clip_state requires clipState');
                }
                const ok = await Editor.Message.request('scene', 'change-clip-state',
                    args.clipState, requireRef(args.clipReference, 'clipReference'));
                return { success: !!ok };
            }
            case 'save_clip': {
                const ok = await Editor.Message.request('scene', 'save-clip');
                if (!ok) {
                    throw new Error('Failed to save the animation clip (is the editor in record mode?)');
                }
                return { success: true };
            }
            case 'operate': {
                if (!Array.isArray(args.operations) || args.operations.length === 0) {
                    throw new Error('operate requires a non-empty operations array');
                }
                if (args.operations.length > 100) {
                    throw new Error('operate supports at most 100 operations per request');
                }
                for (const op of args.operations) {
                    if (!op || !op.funcName || !Array.isArray(op.args)) {
                        throw new Error('each operation requires funcName and an args array');
                    }
                }
                const res: any = await Editor.Message.request('scene', 'animation-operation', args.operations, { recordUndo: true });
                // IAniResultBase: { state: 'success' | 'failure', result, reason? }.
                // Whitelist success — an absent or unknown state is a refused/lost write.
                if (res && res.state === 'failure') {
                    return { success: false, error: res.reason || 'animation operation failed', result: res.result ?? null };
                }
                if (!res || res.state !== 'success') {
                    throw new Error(`animation-operation returned an unexpected payload: ${JSON.stringify(res ?? null)}`);
                }
                return { success: true, result: 'result' in res ? res.result : null };
            }
            default:
                throw new Error(`Unknown animation edit operation: ${args.operation}`);
        }
    }
    @utcpTool(
        'animationClipConfigure',
        'Configure native animation clip sample rate, speed, or wrap mode through verified animation operations.',
        {
            type: 'object',
            properties: {
                clipReference: InstanceReferenceSchema,
                operation: { type: 'string', enum: ['sample', 'speed', 'wrap_mode'] },
                value: { type: 'number' }
            },
            required: ['clipReference', 'operation', 'value']
        },
        { type: 'object', properties: { success: { type: 'boolean' }, result: {} }, required: ['success'] },
        'POST', ['animation', 'clip', 'configure', 'sample', 'speed', 'wrap']
    )
    async animationClipConfigure(args: { clipReference?: IInstanceReference, operation?: string, value?: number }): Promise<ISuccessIndicator & { result?: unknown }> {
        requireRef(args?.clipReference, 'clipReference');
        if (!['sample', 'speed', 'wrap_mode'].includes(args?.operation ?? '')) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be sample, speed, or wrap_mode.' });
        }
        if (typeof args?.value !== 'number' || !Number.isFinite(args.value)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'value must be a finite number.' });
        }
        if (args.operation === 'sample' && (args.value < 1 || args.value > 240)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sample must be between 1 and 240.' });
        }
        if (args.operation === 'speed' && (args.value < 0 || args.value > 100)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'speed must be between 0 and 100.' });
        }
        const funcName = args.operation === 'wrap_mode' ? 'changeWrapMode' : args.operation === 'sample' ? 'changeSample' : 'changeSpeed';
        return applyToClip(args.clipReference, funcName, [args.value]);
    }

    @utcpTool(
        'animationTrackEdit',
        'Create, remove, move, or copy native animation property tracks with bounded typed arguments.',
        {
            type: 'object',
            properties: {
                clipReference: InstanceReferenceSchema,
                operation: { type: 'string', enum: ['create', 'remove', 'move_node', 'copy_to'] },
                nodePath: { type: 'string' },
                propKey: { type: 'string' },
                destinationNodePath: { type: 'string' },
                destinationPropKey: { type: 'string' }
            },
            required: ['clipReference', 'operation', 'nodePath', 'propKey']
        },
        { type: 'object', properties: { success: { type: 'boolean' }, result: {} }, required: ['success'] },
        'POST', ['animation', 'track', 'curve', 'edit']
    )
    async animationTrackEdit(args: { clipReference?: IInstanceReference, operation?: string, nodePath?: string, propKey?: string, destinationNodePath?: string, destinationPropKey?: string }): Promise<ISuccessIndicator & { result?: unknown }> {
        const operation = args?.operation;
        const nodePath = requireText(args?.nodePath, 'nodePath');
        const propKey = requireText(args?.propKey, 'propKey');
        if (operation === 'create') return applyToClip(args.clipReference, 'createProp', [nodePath, propKey]);
        if (operation === 'remove') return applyToClip(args.clipReference, 'removeProp', [nodePath, propKey]);
        const destinationNodePath = requireText(args?.destinationNodePath, 'destinationNodePath');
        const destinationPropKey = requireText(args?.destinationPropKey, 'destinationPropKey');
        if (operation === 'move_node') return applyToClip(args.clipReference, 'changeNodeDataPath', [nodePath, destinationNodePath]);
        if (operation === 'copy_to') return applyToClip(args.clipReference, 'copyPropTo', [nodePath, propKey, destinationNodePath, destinationPropKey]);
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be create, remove, move_node, or copy_to.' });
    }

    @utcpTool(
        'animationKeyframeEdit',
        'Create, move, remove, copy, space, clear, or retime native animation keyframes.',
        {
            type: 'object',
            properties: {
                clipReference: InstanceReferenceSchema,
                operation: { type: 'string', enum: ['create', 'move', 'remove', 'update', 'copy_to', 'spacing', 'clear', 'modify_curve'] },
                nodePath: { type: 'string' },
                propKey: { type: 'string' },
                frame: { type: 'integer', minimum: 0, maximum: 1000000 },
                frames: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'integer', minimum: 0, maximum: 1000000 } },
                offsets: { oneOf: [{ type: 'integer' }, { type: 'array', minItems: 1, maxItems: 200, items: { type: 'integer' } }] },
                destinationFrame: { type: 'integer', minimum: 0, maximum: 1000000 },
                spacingFrames: { type: 'integer', minimum: 0, maximum: 1000000 },
                customData: {}
            },
            required: ['clipReference', 'operation', 'nodePath', 'propKey']
        },
        { type: 'object', properties: { success: { type: 'boolean' }, result: {} }, required: ['success'] },
        'POST', ['animation', 'keyframe', 'curve', 'edit']
    )
    async animationKeyframeEdit(args: { clipReference?: IInstanceReference, operation?: string, nodePath?: string, propKey?: string, frame?: number, frames?: number[], offsets?: number | number[], destinationFrame?: number, spacingFrames?: number, customData?: unknown, curveData?: unknown }): Promise<ISuccessIndicator & { result?: unknown }> {
        const operation = args?.operation;
        const nodePath = requireText(args?.nodePath, 'nodePath');
        const propKey = requireText(args?.propKey, 'propKey');
        if (operation === 'create') return applyToClip(args.clipReference, 'createKey', [nodePath, propKey, requireFrame(args?.frame), args?.customData ?? null]);
        if (operation === 'move') return applyToClip(args.clipReference, 'moveKeys', [nodePath, propKey, requireFrames(args?.frames), args?.offsets ?? 0]);
        if (operation === 'remove') return applyToClip(args.clipReference, 'removeKey', [nodePath, propKey, requireFrames(args?.frames)]);
        if (operation === 'update') return applyToClip(args.clipReference, 'updateKey', [nodePath, propKey, requireFrames(args?.frames)]);
        if (operation === 'copy_to') return applyToClip(args.clipReference, 'copyKeysTo', [nodePath, propKey, requireFrames(args?.frames), requireFrame(args?.destinationFrame, 'destinationFrame')]);
        if (operation === 'spacing') return applyToClip(args.clipReference, 'spacingKeys', [nodePath, propKey, requireFrames(args?.frames), requireFrame(args?.spacingFrames, 'spacingFrames')]);
        if (operation === 'clear') return applyToClip(args.clipReference, 'clearKeys', [nodePath, propKey]);
        if (operation === 'modify_curve') return applyToClip(args.clipReference, 'modifyCurveOfKey', [nodePath, propKey, requireFrame(args?.frame), args?.curveData ?? args?.customData ?? null]);
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be create, move, remove, update, copy_to, spacing, clear, or modify_curve.' });
    }

    @utcpTool(
        'animationEventEdit',
        'Add, update, move, copy, or delete ordered animation event keyframes.',
        {
            type: 'object',
            properties: {
                clipReference: InstanceReferenceSchema,
                operation: { type: 'string', enum: ['add', 'update', 'move', 'copy_to', 'delete'] },
                frame: { type: 'integer', minimum: 0, maximum: 1000000 },
                frames: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'integer', minimum: 0, maximum: 1000000 } },
                destinationFrame: { type: 'integer', minimum: 0, maximum: 1000000 },
                offset: { type: 'integer', minimum: -1000000, maximum: 1000000 },
                functionName: { type: 'string', minLength: 1, maxLength: 256 },
                parameters: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 1024 } },
                events: { type: 'array', maxItems: 200, items: { type: 'object' } }
            },
            required: ['clipReference', 'operation']
        },
        { type: 'object', properties: { success: { type: 'boolean' }, result: {} }, required: ['success'] },
        'POST', ['animation', 'event', 'keyframe', 'edit']
    )
    async animationEventEdit(args: { clipReference?: IInstanceReference, operation?: string, frame?: number, frames?: number[], destinationFrame?: number, offset?: number, functionName?: string, parameters?: string[], events?: unknown[] }): Promise<ISuccessIndicator & { result?: unknown }> {
        const operation = args?.operation;
        if (operation === 'add') return applyToClip(args.clipReference, 'addEvent', [requireFrame(args?.frame), requireText(args?.functionName, 'functionName', 256), args?.parameters ?? []]);
        if (operation === 'delete') return applyToClip(args.clipReference, 'deleteEvent', [requireFrames(args?.frames)]);
        if (operation === 'update') return applyToClip(args.clipReference, 'updateEvent', [requireFrames(args?.frames), Array.isArray(args?.events) ? args.events : (() => { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'events must be an array.' }); })()]);
        if (operation === 'move') {
            if (!Number.isInteger(args?.offset) || !Number.isFinite(args.offset)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'offset must be an integer.' });
            return applyToClip(args.clipReference, 'moveEvents', [requireFrames(args?.frames), args.offset]);
        }
        if (operation === 'copy_to') return applyToClip(args.clipReference, 'copyEventsTo', [requireFrames(args?.frames), requireFrame(args?.destinationFrame, 'destinationFrame')]);
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be add, update, move, copy_to, or delete.' });
    }
    @utcpTool(
        'animationAuxCurveEdit',
        'Manage bounded auxiliary animation curves and keys through native editor operations.',
        {
            type: 'object',
            properties: {
                clipReference: InstanceReferenceSchema,
                name: { type: 'string', minLength: 1, maxLength: 256 },
                operation: { type: 'string', enum: ['add', 'rename', 'remove', 'create_key', 'remove_key', 'move_keys', 'copy_key', 'modify_curve'] },
                newName: { type: 'string', maxLength: 256 },
                frame: { type: 'integer', minimum: 0, maximum: 1000000 },
                frames: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'integer', minimum: 0, maximum: 1000000 } },
                offset: { oneOf: [{ type: 'integer' }, { type: 'array', minItems: 1, maxItems: 200, items: { type: 'integer' } }] },
                customData: {},
                curveData: {},
                source: {},
                destination: {}
            },
            required: ['clipReference', 'operation', 'name']
        },
        { type: 'object', properties: { success: { type: 'boolean' }, result: {} }, required: ['success'] },
        'POST', ['animation', 'auxiliary', 'curve', 'keyframe', 'edit']
    )
    async animationAuxCurveEdit(args: { clipReference?: IInstanceReference, operation?: string, name?: string, newName?: string, frame?: number, frames?: number[], offset?: number | number[], customData?: unknown, curveData?: unknown, source?: unknown, destination?: unknown }): Promise<ISuccessIndicator & { result?: unknown }> {
        const operation = args?.operation;
        const name = requireText(args?.name, 'name', 256);
        if (operation === 'add') return applyToClip(args.clipReference, 'addAuxiliaryCurve', [name]);
        if (operation === 'rename') return applyToClip(args.clipReference, 'renameAuxiliaryCurve', [name, requireText(args?.newName, 'newName', 256)]);
        if (operation === 'remove') return applyToClip(args.clipReference, 'removeAuxiliaryCurve', [name]);
        if (operation === 'create_key') return applyToClip(args.clipReference, 'createAuxKey', [name, requireFrame(args?.frame), args?.customData]);
        if (operation === 'remove_key') return applyToClip(args.clipReference, 'removeAuxKey', [name, requireFrame(args?.frame)]);
        if (operation === 'move_keys') return applyToClip(args.clipReference, 'moveAuxKeys', [name, requireFrames(args?.frames), args?.offset ?? 0]);
        if (operation === 'copy_key') {
            if (!args?.source || !args?.destination || typeof args.source !== 'object' || typeof args.destination !== 'object') {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'copy_key requires source and destination objects.' });
            }
            return applyToClip(args.clipReference, 'copyAuxKey', [args.source, args.destination]);
        }
        if (operation === 'modify_curve') return applyToClip(args.clipReference, 'modifyAuxCurveOfKey', [name, requireFrame(args?.frame), args?.curveData ?? args?.customData ?? null]);
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be add, rename, remove, create_key, remove_key, move_keys, copy_key, or modify_curve.' });
    }

    @utcpTool(
        'animationUsageAnalyze',
        'Inspect scene animation usage, active states, defaults, cache modes, and actionable setup recommendations.',
        {
            type: 'object',
            properties: {
                nodeReference: InstanceReferenceSchema,
                maxNodes: { type: 'integer', minimum: 1, maximum: 200, default: 100 }
            }
        },
        {
            type: 'object',
            properties: {
                nodeReference: InstanceReferenceSchema,
                visitedNodes: { type: 'integer' },
                truncated: { type: 'boolean' },
                componentCount: { type: 'integer' },
                findings: { type: 'array' }
            },
            required: ['nodeReference', 'visitedNodes', 'truncated', 'componentCount', 'findings']
        },
        'GET', ['animation', 'analyze', 'usage', 'setup', 'cache', 'recommend']
    )
    async animationUsageAnalyze(args: { nodeReference?: IInstanceReference, maxNodes?: number } = {}): Promise<Record<string, unknown>> {
        if (args.maxNodes !== undefined && (!Number.isInteger(args.maxNodes) || args.maxNodes < 1 || args.maxNodes > 200)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxNodes must be an integer from 1 to 200.' });
        }
        if (args.nodeReference) requireRef(args.nodeReference, 'nodeReference');
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x',
            method: 'animationUsageAnalyze',
            args: [{ nodeUuid: args.nodeReference?.id, maxNodes: args.maxNodes ?? 100 }],
        }) as Record<string, unknown> | null;
        if (!result || !Array.isArray(result.findings) || typeof result.componentCount !== 'number') {
            throw new ToolError({ code: 'ANIMATION_ANALYSIS_FAILED', status: 502, message: 'Creator returned malformed animation usage analysis.' });
        }
        logAnimation(`usage analysis completed node=${String(result.nodeUuid ?? args.nodeReference?.id ?? 'scene')} components=${result.componentCount}`);
        return { ...result, nodeReference: { id: String(result.nodeUuid ?? args.nodeReference?.id ?? ''), type: 'cc.Node' } };
    }

    @utcpTool(
        'animationCatalogInspect',
        'Inspect bounded animation catalogs for native Animation, Spine, and DragonBones components.',
        {
            type: 'object',
            properties: { nodeReference: InstanceReferenceSchema, maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
            required: ['nodeReference']
        },
        { type: 'object', properties: { nodeReference: InstanceReferenceSchema, findings: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['nodeReference', 'findings', 'total', 'truncated'] },
        'GET', ['animation', 'catalog', 'inspect', 'spine', 'dragonbones']
    )
    async animationCatalogInspect(args: { nodeReference?: IInstanceReference, maxItems?: number }): Promise<Record<string, unknown>> {
        const nodeId = requireRef(args?.nodeReference, 'nodeReference');
        const maxItems = args?.maxItems ?? 200;
        if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxItems must be an integer from 1 to 1000.' });
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x',
            method: 'animationCatalogInspect',
            args: [{ nodeUuid: nodeId, maxItems }],
        }) as Record<string, unknown> | null;
        if (!result || !Array.isArray(result.findings) || typeof result.total !== 'number' || typeof result.truncated !== 'boolean') {
            throw new ToolError({ code: 'ANIMATION_CATALOG_FAILED', status: 502, message: 'Creator returned malformed animation catalog.' });
        }
        return { ...result, nodeReference: { id: nodeId, type: 'cc.Node' } };
    }
    @utcpTool(
        'animationClipAssign',
        'Assign a verified AnimationClip asset to a cc.Animation component with scene persistence read-back.',
        { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, clipReference: InstanceReferenceSchema, clipName: { type: 'string', maxLength: 256 } }, required: ['nodeReference', 'clipReference'] },
        { type: 'object', properties: { success: { type: 'boolean' }, nodeReference: InstanceReferenceSchema, clipReference: InstanceReferenceSchema, clipName: { type: 'string' }, clips: { type: 'array' } }, required: ['success', 'nodeReference', 'clipReference', 'clipName', 'clips'] },
        'POST', ['animation', 'clip', 'assign', 'configure', 'scene']
    )
    async animationClipAssign(args: { nodeReference?: IInstanceReference, clipReference?: IInstanceReference, clipName?: string }): Promise<Record<string, unknown>> {
        const nodeId = requireRef(args?.nodeReference, 'nodeReference');
        const clipId = requireRef(args?.clipReference, 'clipReference');
        const info = await Editor.Message.request('asset-db', 'query-asset-info', clipId) as Record<string, unknown> | null;
        if (!info || (info.type !== 'cc.AnimationClip' && info.importer !== 'animation-clip')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Reference ${clipId} is not an AnimationClip asset.` });
        try {
            const result = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'animationClipAssign', args: [{ nodeUuid: nodeId, clipUuid: clipId, clipName: args?.clipName }] }) as Record<string, unknown> | null;
            if (!result || result.success !== true || typeof result.clipName !== 'string' || !Array.isArray(result.clips)) throw new Error('Creator returned no AnimationClip assignment read-back.');
            return { ...result, nodeReference: { id: nodeId, type: args.nodeReference?.type ?? 'cc.Node' }, clipReference: { id: clipId, type: args.clipReference?.type ?? 'cc.AnimationClip' } };
        } catch (error) {
            throw new ToolError({ code: 'ANIMATION_CLIP_ASSIGN_FAILED', status: 502, message: 'Creator could not persist AnimationClip assignment.', details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the target node and AnimationClip asset before retrying.' });
        }
    }

    @utcpTool(
        'animationComponentsList',
        'List cc.Animation components and assigned clip names in the open scene.',
        { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, recursive: { type: 'boolean', default: true } } },
        { type: 'object', properties: { animations: { type: 'array' } }, required: ['animations'] },
        'GET', ['animation', 'component', 'list', 'clips', 'scene']
    )
    async animationComponentsList(args: { nodeReference?: IInstanceReference, recursive?: boolean } = {}): Promise<Record<string, unknown>> {
        if (args.nodeReference) requireRef(args.nodeReference, 'nodeReference');
        try {
            const result = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'animationComponentsList', args: [{ nodeUuid: args.nodeReference?.id, recursive: args.recursive !== false }] }) as Record<string, unknown> | null;
            if (!result || !Array.isArray(result.animations)) throw new Error('Creator returned malformed animation component list.');
            return result;
        } catch (error) {
            throw new ToolError({ code: 'ANIMATION_COMPONENT_LIST_FAILED', status: 502, message: 'Creator could not list Animation components.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }

    @utcpTool(
        'animationCompatibilityAudit',
        'Audit the runtime animation capabilities available on a node before issuing playback or cache operations.',
        { type: 'object', properties: { nodeReference: InstanceReferenceSchema }, required: ['nodeReference'] },
        { type: 'object', properties: { nodeReference: InstanceReferenceSchema, component: {}, supports: { type: 'object' }, supportedCacheModes: { type: 'array' }, unsupportedOperations: { type: 'array' }, recommendations: { type: 'array' } }, required: ['nodeReference', 'component', 'supports', 'supportedCacheModes', 'unsupportedOperations', 'recommendations'] },
        'GET', ['animation', 'compatibility', 'audit', 'spine', 'dragonbones']
    )
    async animationCompatibilityAudit(args: { nodeReference?: IInstanceReference }): Promise<Record<string, unknown>> {
        const nodeId = requireRef(args?.nodeReference, 'nodeReference');
        let result: Record<string, unknown> | null;
        try {
            result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x',
                method: 'animationCompatibilityAudit',
                args: [{ nodeUuid: nodeId }],
            }) as Record<string, unknown> | null;
        } catch (error) {
            throw new ToolError({ code: 'ANIMATION_COMPATIBILITY_FAILED', status: 502, message: 'Creator could not audit animation compatibility.', details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the node and retry after its animation component is ready.' });
        }
        if (!result || !result.supports || !Array.isArray(result.supportedCacheModes) || !Array.isArray(result.unsupportedOperations) || !Array.isArray(result.recommendations)) {
            throw new ToolError({ code: 'ANIMATION_COMPATIBILITY_FAILED', status: 502, message: 'Creator returned malformed animation compatibility audit.' });
        }
        return { ...result, nodeReference: { id: nodeId, type: 'cc.Node' } };
    }

    @utcpTool(
        'spineRuntimeControl',
        'Control Spine skins, attachments, queued tracks, mixes, time scale, and track clearing with bounded live read-back.',
        {
            type: 'object',
            properties: {
                nodeReference: InstanceReferenceSchema,
                operation: { type: 'string', enum: ['inspect', 'set_skin', 'set_attachment', 'queue_animation', 'clear_track', 'clear_tracks', 'set_time_scale', 'set_mix'] },
                skinName: { type: 'string', maxLength: 256 },
                slotName: { type: 'string', maxLength: 256 },
                attachmentName: { type: ['string', 'null'], maxLength: 256 },
                clipName: { type: 'string', maxLength: 256 },
                trackIndex: { type: 'integer', minimum: 0, maximum: 31 },
                loop: { type: 'boolean' },
                delay: { type: 'number', minimum: 0, maximum: 86400 },
                timeScale: { type: 'number', minimum: 0, maximum: 100 },
                fromAnimation: { type: 'string', maxLength: 256 },
                toAnimation: { type: 'string', maxLength: 256 },
                duration: { type: 'number', minimum: 0, maximum: 60 }
            },
            required: ['nodeReference', 'operation']
        },
        { type: 'object', properties: { nodeReference: InstanceReferenceSchema, operation: { type: 'string' }, spine: { type: 'object' } }, required: ['nodeReference', 'operation', 'spine'] },
        'POST', ['animation', 'spine', 'runtime', 'skin', 'attachment', 'track', 'mix']
    )
    async spineRuntimeControl(args: {
        nodeReference?: IInstanceReference, operation?: string, skinName?: string, slotName?: string,
        attachmentName?: string | null, clipName?: string, trackIndex?: number, loop?: boolean,
        delay?: number, timeScale?: number, fromAnimation?: string, toAnimation?: string, duration?: number,
    }): Promise<Record<string, unknown>> {
        const nodeId = requireRef(args?.nodeReference, 'nodeReference');
        const operation = args.operation;
        const allowed = ['inspect', 'set_skin', 'set_attachment', 'queue_animation', 'clear_track', 'clear_tracks', 'set_time_scale', 'set_mix'];
        if (!allowed.includes(operation ?? '')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `operation must be one of: ${allowed.join(', ')}.` });
        if (operation === 'set_skin' && !args.skinName) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_skin requires skinName.' });
        if (operation === 'set_attachment' && !args.slotName) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_attachment requires slotName.' });
        if (operation === 'queue_animation' && !args.clipName) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'queue_animation requires clipName.' });
        if (args.trackIndex !== undefined && (!Number.isInteger(args.trackIndex) || args.trackIndex < 0 || args.trackIndex > 31)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'trackIndex must be an integer from 0 to 31.' });
        if (args.delay !== undefined && (!Number.isFinite(args.delay) || args.delay < 0 || args.delay > 86400)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'delay must be from 0 to 86400.' });
        if (args.timeScale !== undefined && (!Number.isFinite(args.timeScale) || args.timeScale < 0 || args.timeScale > 100)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'timeScale must be from 0 to 100.' });
        if (operation === 'set_mix' && (!args.fromAnimation || !args.toAnimation || args.duration === undefined || !Number.isFinite(args.duration) || args.duration < 0 || args.duration > 60)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_mix requires fromAnimation, toAnimation, and duration from 0 to 60.' });
        try {
            const result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x',
                method: 'spineRuntimeControl',
                args: [{ ...args, nodeUuid: nodeId, nodeReference: undefined }],
            }) as Record<string, unknown> | null;
            if (!result || typeof result !== 'object' || !result.spine) throw new Error('Creator returned no Spine read-back.');
            return { ...result, nodeReference: { id: nodeId, type: 'cc.Node' }, operation };
        } catch (error) {
            throw new ToolError({ code: 'SPINE_RUNTIME_CONTROL_FAILED', status: 502, message: `Creator could not complete Spine operation '${operation}'.`, details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Run animationCatalogInspect and animationCompatibilityAudit before retrying.' });
        }
    }
    @utcpTool('spineRuntimeBatchControl', 'Apply bounded Spine runtime controls across multiple scene nodes with per-node live read-back outcomes.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, operation: { type: 'string', enum: ['inspect', 'set_skin', 'set_attachment', 'queue_animation', 'clear_track', 'clear_tracks', 'set_time_scale', 'set_mix'] }, skinName: { type: 'string', maxLength: 256 }, slotName: { type: 'string', maxLength: 256 }, attachmentName: { type: ['string', 'null'], maxLength: 256 }, clipName: { type: 'string', maxLength: 256 }, trackIndex: { type: 'integer', minimum: 0, maximum: 31 }, loop: { type: 'boolean' }, delay: { type: 'number', minimum: 0, maximum: 86400 }, timeScale: { type: 'number', minimum: 0, maximum: 100 }, fromAnimation: { type: 'string', maxLength: 256 }, toAnimation: { type: 'string', maxLength: 256 }, duration: { type: 'number', minimum: 0, maximum: 60 } }, required: ['nodeReference', 'operation'] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['animation', 'spine', 'runtime', 'batch', 'control'])
    async spineRuntimeBatchControl(args: { items: Array<{ nodeReference: IInstanceReference, operation: string, skinName?: string, slotName?: string, attachmentName?: string | null, clipName?: string, trackIndex?: number, loop?: boolean, delay?: number, timeScale?: number, fromAnimation?: string, toAnimation?: string, duration?: number }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 Spine runtime requests.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.spineRuntimeControl(item) });
            } catch (error) {
                outcomes.push({ index, ok: false, nodeReference: item?.nodeReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }


    @utcpTool(
        'spineEditorConfigure',
        'Persist bounded Spine Skeleton editor properties with typed semantic field names and Creator read-back.',
        {
            type: 'object',
            properties: {
                componentReference: InstanceReferenceSchema,
                defaultAnimationIndex: { type: 'integer', minimum: 0, maximum: 200 },
                defaultSkinIndex: { type: 'integer', minimum: 0, maximum: 200 },
                defaultCacheMode: { type: 'integer', enum: [0, 1, 2] },
                loop: { type: 'boolean' },
                premultipliedAlpha: { type: 'boolean' },
                timeScale: { type: 'number', minimum: 0, maximum: 100 },
                debugSlots: { type: 'boolean' },
                debugBones: { type: 'boolean' },
                debugMesh: { type: 'boolean' },
                useTint: { type: 'boolean' },
                enableBatch: { type: 'boolean' },
                color: { type: 'object', additionalProperties: false, properties: { r: { type: 'integer', minimum: 0, maximum: 255 }, g: { type: 'integer', minimum: 0, maximum: 255 }, b: { type: 'integer', minimum: 0, maximum: 255 }, a: { type: 'integer', minimum: 0, maximum: 255 } }, required: ['r', 'g', 'b', 'a'] }
            },
            required: ['componentReference']
        },
        { type: 'object', properties: { success: { type: 'boolean' }, componentReference: InstanceReferenceSchema, changed: { type: 'array' } }, required: ['success', 'componentReference', 'changed'] },
        'POST', ['animation', 'spine', 'editor', 'configure', 'properties']
    )
    async spineEditorConfigure(args: {
        componentReference?: IInstanceReference, defaultAnimationIndex?: number, defaultSkinIndex?: number,
        defaultCacheMode?: number, loop?: boolean, premultipliedAlpha?: boolean, timeScale?: number,
        debugSlots?: boolean, debugBones?: boolean, debugMesh?: boolean, useTint?: boolean, enableBatch?: boolean,
        color?: { r: number, g: number, b: number, a: number },
    }): Promise<Record<string, unknown>> {
        const componentId = requireRef(args?.componentReference, 'componentReference');
        const fields: Array<[string, unknown]> = ([
            ['_animationIndex', args.defaultAnimationIndex], ['_defaultSkinIndex', args.defaultSkinIndex],
            ['defaultCacheMode', args.defaultCacheMode], ['loop', args.loop], ['premultipliedAlpha', args.premultipliedAlpha],
            ['timeScale', args.timeScale], ['debugSlots', args.debugSlots], ['debugBones', args.debugBones],
            ['debugMesh', args.debugMesh], ['useTint', args.useTint], ['enableBatch', args.enableBatch], ['color', args.color],
        ] as Array<[string, unknown]>).filter((entry) => entry[1] !== undefined);
        if (fields.length === 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'At least one Spine editor property is required.' });
        try {
            await new SetPropertyTool().setInstanceProperties({ reference: { id: componentId }, propertyPaths: fields.map(([path]) => path), values: fields.map(([, value]) => value) });
            const readBack = await ToolsUtils.inspectInstance(componentId, false);
            if (!readBack?.props) throw new Error('Spine property read-back was unavailable.');
            const values: Record<string, unknown> = {};
            for (const [path, expected] of fields) {
                const parts = path.split('.');
                let current: unknown = readBack.props;
                for (const part of parts) {
                    if (!current || typeof current !== 'object' || !(part in current)) throw new Error(`Spine property ${path} was missing in read-back.`);
                    current = (current as Record<string, unknown>)[part];
                    if (current && typeof current === 'object' && 'value' in current) current = (current as Record<string, unknown>).value;
                }
                if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error(`Spine property ${path} read-back mismatch.`);
                values[path] = current;
            }
            return { success: true, componentReference: { id: componentId, type: args.componentReference?.type ?? 'sp.Skeleton' }, changed: fields.map(([path]) => path), properties: values, verified: true };
        } catch (error) {
            throw new ToolError({ code: 'SPINE_EDITOR_CONFIGURE_FAILED', status: 502, message: 'Creator could not persist Spine editor properties.', details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Use inspectorGet on the Skeleton component, then retry with supported property values.' });
        }
    }

    @utcpTool(
        'spineSocketConfigure',
        'Persist bounded Spine socket attachment points with target node references and one undo snapshot.',
        {
            type: 'object',
            properties: {
                componentReference: InstanceReferenceSchema,
                sockets: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { path: { type: 'string', minLength: 1, maxLength: 512 }, targetReference: InstanceReferenceSchema },
                        required: ['path', 'targetReference']
                    }
                }
            },
            required: ['componentReference', 'sockets']
        },
        { type: 'object', properties: { success: { type: 'boolean' }, componentReference: InstanceReferenceSchema, socketCount: { type: 'integer' }, targetReferences: { type: 'array' } }, required: ['success', 'componentReference', 'socketCount', 'targetReferences'] },
        'POST', ['animation', 'spine', 'socket', 'attachment', 'editor', 'configure']
    )
    async spineSocketConfigure(args: { componentReference?: IInstanceReference, sockets?: Array<{ path?: string, targetReference?: IInstanceReference }> }): Promise<Record<string, unknown>> {
        const componentId = requireRef(args?.componentReference, 'componentReference');
        if (!Array.isArray(args.sockets) || args.sockets.length > 100) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sockets must contain 0 to 100 items.' });
        const sockets = args.sockets.map((socket, index) => {
            if (!socket || typeof socket.path !== 'string' || socket.path.trim().length === 0 || socket.path.length > 512) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `sockets[${index}].path must be 1 to 512 characters.` });
            return { path: socket.path, targetUuid: requireRef(socket.targetReference, `sockets[${index}].targetReference`) };
        });
        try {
            const info = await (await import('../utils/tools-utils')).ToolsUtils.inspectInstance(componentId, false);
            const nodeUuid = (info as any)?.props?.node?.value?.uuid;
            if (typeof nodeUuid !== 'string' || !nodeUuid) throw new Error('Skeleton component has no owning node reference');
            const result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x',
                method: 'spineSocketConfigure',
                args: [{ nodeUuid, sockets }],
            }) as Record<string, unknown> | null;
            if (!result || typeof result !== 'object' || !Array.isArray(result.sockets)) throw new Error('Creator returned no socket read-back');
            return {
                success: true,
                componentReference: { id: componentId, type: args.componentReference?.type ?? 'sp.Skeleton' },
                socketCount: result.socketCount,
                sockets: result.sockets,
                targetReferences: sockets.map((socket) => ({ id: socket.targetUuid, type: 'cc.Node' })),
            };
        } catch (error) {
            throw new ToolError({ code: 'SPINE_SOCKET_CONFIGURE_FAILED', status: 502, message: 'Creator could not persist Spine sockets.', details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Use spineSceneInspect to verify the Skeleton and target node, then retry with a valid bone path and target reference.' });
        }
    }

    @utcpTool(
        'animationBatchControl',
        'Apply one bounded runtime animation operation across multiple nodes and return per-node outcomes.',
        {
            type: 'object',
            properties: {
                nodeReferences: { type: 'array', minItems: 1, maxItems: 100, items: InstanceReferenceSchema },
                operation: { type: 'string', enum: ['inspect', 'play', 'pause', 'resume', 'stop', 'set_cache_mode', 'invalidate_cache'] },
                clipName: { type: 'string', maxLength: 256 },
                loop: { type: 'boolean' },
                cacheMode: { type: 'string', enum: ['REALTIME', 'SHARED_CACHE', 'PRIVATE_CACHE'] }
            },
            required: ['nodeReferences', 'operation']
        },
        { type: 'object', properties: { operation: { type: 'string' }, results: { type: 'array' }, failures: { type: 'array' }, total: { type: 'integer' } }, required: ['operation', 'results', 'failures', 'total'] },
        'POST', ['animation', 'batch', 'runtime', 'playback']
    )
    async animationBatchControl(args: { nodeReferences?: IInstanceReference[], operation?: string, clipName?: string, loop?: boolean, cacheMode?: string }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.nodeReferences) || args.nodeReferences.length < 1 || args.nodeReferences.length > 100) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReferences must contain 1 to 100 items.' });
        }
        const operation = args.operation;
        const allowed = ['inspect', 'play', 'pause', 'resume', 'stop', 'set_cache_mode', 'invalidate_cache'];
        if (!allowed.includes(operation ?? '')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `operation must be one of: ${allowed.join(', ')}.` });
        if (operation === 'play' && !args.clipName) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'play requires clipName.' });
        if (operation === 'set_cache_mode' && !args.cacheMode) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_cache_mode requires cacheMode.' });
        const results: unknown[] = [];
        const failures: unknown[] = [];
        for (const reference of args.nodeReferences) {
            const nodeUuid = requireRef(reference, 'nodeReferences[]');
            try {
                const result = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'ccp3x',
                    method: 'animationRuntimeControl',
                    args: [{ nodeUuid, operation, clipName: args.clipName, loop: args.loop, cacheMode: args.cacheMode }],
                });
                results.push({ nodeReference: { id: nodeUuid, type: 'cc.Node' }, result });
            } catch (error) {
                failures.push({ nodeReference: { id: nodeUuid, type: 'cc.Node' }, error: error instanceof Error ? error.message : String(error) });
            }
        }
        return { operation, results, failures, total: args.nodeReferences.length };
    }

    @utcpTool(
        'animationStop',
        'Stop the cc.Animation, SkeletalAnimation, Spine, or DragonBones component on one editor scene node and return authoritative component state read-back.',
        {
            type: 'object',
            additionalProperties: false,
            properties: { nodeReference: InstanceReferenceSchema },
            required: ['nodeReference']
        },
        {
            type: 'object',
            properties: { nodeReference: InstanceReferenceSchema, operation: { type: 'string' }, animation: {}, spine: {}, dragonBones: {} },
            required: ['nodeReference', 'operation']
        },
        'POST', ['animation', 'stop', 'editor', 'state']
    )
    async animationStop(args: { nodeReference?: IInstanceReference }): Promise<Record<string, unknown>> {
        return await this.animationRuntimeControl({ nodeReference: args.nodeReference, operation: 'stop' });
    }

    @utcpTool(
        'animationRuntimeControl',
        'Fully control Animation playback/state and Spine or DragonBones cache mode with live read-back.',
        {
            type: 'object',
            properties: {
                nodeReference: InstanceReferenceSchema,
                operation: { type: 'string', enum: ['inspect', 'play', 'cross_fade', 'pause', 'resume', 'stop', 'set_default', 'set_play_on_load', 'set_state', 'set_cache_mode', 'invalidate_cache'] },
                clipName: { type: 'string', maxLength: 256 },
                duration: { type: 'number', minimum: 0, maximum: 60 },
                playOnLoad: { type: 'boolean' },
                loop: { type: 'boolean' },
                speed: { type: 'number', minimum: 0, maximum: 100 },
                time: { type: 'number', minimum: 0, maximum: 86400 },
                repeatCount: { type: 'number', minimum: 0, maximum: 1000000 },
                wrapMode: { type: 'integer', minimum: 0, maximum: 100 },
                weight: { type: 'number', minimum: 0, maximum: 1 },
                delay: { type: 'number', minimum: 0, maximum: 86400 },
                playbackRange: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        min: { type: 'number', minimum: 0, maximum: 86400 },
                        max: { type: 'number', minimum: 0, maximum: 86400 }
                    },
                    required: ['min', 'max']
                },
                cacheMode: { type: 'string', enum: ['REALTIME', 'SHARED_CACHE', 'PRIVATE_CACHE'] }
            },
            required: ['nodeReference', 'operation']
        },
        {
            type: 'object',
            properties: {
                nodeReference: InstanceReferenceSchema,
                operation: { type: 'string' },
                animation: {},
                spine: {},
                dragonBones: {}
            },
            required: ['nodeReference', 'operation']
        },
        'POST', ['animation', 'runtime', 'playback', 'state', 'cache', 'spine', 'dragonbones']
    )
    async animationRuntimeControl(args: {
        nodeReference?: IInstanceReference,
        operation?: string,
        clipName?: string,
        duration?: number,
        playOnLoad?: boolean,
        loop?: boolean,
        speed?: number,
        time?: number,
        repeatCount?: number,
        wrapMode?: number,
        weight?: number,
        delay?: number,
        playbackRange?: { min?: number, max?: number },
        cacheMode?: string,
    }): Promise<Record<string, unknown>> {
        const nodeUuid = requireRef(args?.nodeReference, 'nodeReference');
        const ranges: Array<[keyof typeof args, number, number]> = [['duration', 0, 60], ['speed', 0, 100], ['time', 0, 86400], ['repeatCount', 0, 1_000_000], ['weight', 0, 1], ['delay', 0, 86400]];
        for (const [key, min, max] of ranges) {
            const value = args[key];
            if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${String(key)} must be a finite number from ${min} to ${max}.` });
            }
        }
        if (args.wrapMode !== undefined && (!Number.isInteger(args.wrapMode) || args.wrapMode < 0 || args.wrapMode > 100)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'wrapMode must be an integer from 0 to 100.' });
        }
        if (args.playbackRange !== undefined) {
            const range = args.playbackRange;
            if (!range || typeof range.min !== 'number' || !Number.isFinite(range.min) || typeof range.max !== 'number' || !Number.isFinite(range.max) || range.min < 0 || range.max > 86400 || range.min > range.max) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'playbackRange must contain finite min/max values from 0 to 86400 with min <= max.' });
            }
        }
        if (args.cacheMode !== undefined && !['REALTIME', 'SHARED_CACHE', 'PRIVATE_CACHE'].includes(args.cacheMode)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'cacheMode must be REALTIME, SHARED_CACHE, or PRIVATE_CACHE.' });
        }
        if (args.operation === 'cross_fade' && !args.clipName) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'cross_fade requires clipName.' });
        }
        if (args.operation === 'set_default' && !args.clipName) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_default requires clipName.' });
        }
        if (args.operation === 'set_play_on_load' && typeof args.playOnLoad !== 'boolean') {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_play_on_load requires playOnLoad.' });
        }
        if (args.operation === 'set_state' && (!args.clipName || [args.speed, args.time, args.repeatCount, args.wrapMode, args.weight, args.delay, args.playbackRange].every((value) => value === undefined))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_state requires clipName and at least one state field.' });
        }
        if (args.operation === 'set_cache_mode' && !args.cacheMode) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'set_cache_mode requires cacheMode.' });
        }
        let result: Record<string, unknown> | null;
        try {
            result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x',
                method: 'animationRuntimeControl',
                args: [{ ...args, nodeUuid, nodeReference: undefined }],
            }) as Record<string, unknown> | null;
        } catch (error) {
            throw new ToolError({
                code: 'ANIMATION_CONTROL_FAILED',
                status: 502,
                message: `Creator could not complete animation operation '${args.operation}'.`,
                details: { cause: error instanceof Error ? error.message : String(error) },
                recovery: args.operation === 'set_cache_mode'
                    ? 'Use REALTIME when the loaded Spine runtime does not support shared/private cache modes, or retry after the Skeleton asset is fully imported.'
                    : 'Retry after the scene animation component is ready and inspect the node state.',
            });
        }
        if (!result || typeof result !== 'object') throw new ToolError({ code: 'ANIMATION_CONTROL_FAILED', status: 502, message: 'Creator returned no animation control read-back.' });
        logAnimation(`runtime ${args.operation} completed node=${nodeUuid}${args.clipName ? ` clip=${args.clipName}` : ''}`);
        return { ...result, nodeReference: { id: nodeUuid, type: 'cc.Node' }, operation: args.operation };
    }
}
