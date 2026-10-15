import { inspectAnimationTimeline, timelineInspectBounds, timelineRecord, TimelineInspectOptions } from '../../animation-timeline-inspect';
import { utcpTool } from '../decorators';
import { IInstanceReference, InstanceReferenceSchema } from '../schemas';
import { ToolError } from '../tool-error';
import { AnimationTools } from './animation-tools';

function exactReference(value: IInstanceReference | undefined, name: string): IInstanceReference {
    if (!value || typeof value.id !== 'string' || value.id.length > 256 || !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{2}[A-Za-z0-9+/]{20})(?:@[A-Za-z0-9_-]{1,64})?$/i.test(value.id)) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must contain one exact bare UUID, not a node path, name or composite reference.` });
    }
    return { id: value.id };
}

export class AnimationTimelineTools {
    @utcpTool('animationTimelineInspect', 'Read bounded native Creator timeline property-track bindings, keyframe ranges and events for one exact node/clip pair. No scene selection, mutation, callback lookup or playback. Unknown native shapes are explicit diagnostics, never healthy empty timelines.', {
        type: 'object', additionalProperties: false,
        properties: {
            nodeReference: InstanceReferenceSchema, clipReference: InstanceReferenceSchema,
            expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Guard retrieved timeline metadata across pages, not opaque keyframe values or runtime state.' },
            trackOffset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
            trackLimit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            eventOffset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
            eventLimit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            keyframeOffset: { type: 'integer', minimum: 0, maximum: 100000, default: 0, description: 'Applied independently to each returned track.' },
            keyframeLimit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
            maxBytes: { type: 'integer', minimum: 1024, maximum: 262144, default: 65536, description: 'Exact UTF-8 JSON byte ceiling for the entire successful result. Oversized records/envelopes fail with typed bound errors.' },
        }, required: ['nodeReference', 'clipReference'],
    }, {
        type: 'object', properties: {
            nodeReference: InstanceReferenceSchema, clipReference: InstanceReferenceSchema,
            revision: { type: 'string' }, revisionScope: { type: 'string' },
            identity: { type: 'object', properties: { node: { type: 'string' }, clip: { type: 'string' }, dumpClipUuidExposed: { type: 'boolean' }, dumpNodeUuidExposed: { type: 'boolean' } }, required: ['node', 'clip', 'dumpClipUuidExposed', 'dumpNodeUuidExposed'] },
            clip: { type: 'object', properties: { name: { type: ['string', 'null'] }, sample: { type: ['number', 'null'] }, duration: { type: ['number', 'null'] }, speed: { type: ['number', 'null'] }, wrapMode: { type: ['number', 'null'] } }, required: ['name', 'sample', 'duration', 'speed', 'wrapMode'] },
            sourceScope: { type: 'string' }, timingUnit: { type: 'string' }, validityScope: { type: 'string' },
            valid: { type: 'boolean' }, sourceComplete: { type: 'boolean' }, complete: { type: 'boolean' }, truncated: { type: 'boolean' },
            totalTracks: { type: ['integer', 'null'] }, retrievedTracks: { type: ['integer', 'null'] }, totalEvents: { type: ['integer', 'null'] }, inspectedKeyframes: { type: 'integer' },
            trackOffset: { type: 'integer' }, trackLimit: { type: 'integer' }, eventOffset: { type: 'integer' }, eventLimit: { type: 'integer' },
            nextTrackOffset: { type: ['integer', 'null'] }, nextEventOffset: { type: ['integer', 'null'] },
            tracks: { type: 'array', maxItems: 200, items: { type: 'object', properties: {
                index: { type: 'integer' }, identity: { type: 'object', properties: { nodePath: { type: ['string', 'null'] }, property: { type: ['string', 'null'] } }, required: ['nodePath', 'property'] },
                component: { type: ['string', 'null'] }, parentProperty: { type: ['string', 'null'] }, displayName: { type: ['string', 'null'] }, keyframeCount: { type: ['integer', 'null'] },
                keyframeOffset: { type: 'integer' }, nextKeyframeOffset: { type: ['integer', 'null'] },
                keyframeLimit: { type: 'integer' }, keyframesComplete: { type: 'boolean' }, keyframesTruncated: { type: 'boolean' },
                keyframes: { type: 'array', maxItems: 200, items: { type: 'object', properties: { index: { type: 'integer' }, frame: { type: ['number', 'null'] }, frameOverSample: { type: ['number', 'null'] } }, required: ['index', 'frame', 'frameOverSample'] } },
                frameRange: { type: ['object', 'null'], properties: { first: { type: 'number' }, last: { type: 'number' } }, required: ['first', 'last'] },
                frameOverSampleRange: { type: ['object', 'null'], properties: { first: { type: 'number' }, last: { type: 'number' } }, required: ['first', 'last'] }, dataValid: { type: 'boolean' },
            }, required: ['index', 'identity', 'component', 'parentProperty', 'displayName', 'keyframeCount', 'keyframeOffset', 'nextKeyframeOffset', 'keyframeLimit', 'keyframesComplete', 'keyframesTruncated', 'keyframes', 'frameRange', 'frameOverSampleRange', 'dataValid'] } },
            events: { type: 'array', maxItems: 200, items: { type: 'object', properties: {
                index: { type: 'integer' }, frame: { type: ['number', 'null'] }, frameOverSample: { type: ['number', 'null'] }, callback: { type: ['string', 'null'] }, params: { type: ['array', 'null'], items: { type: 'string' } }, dataValid: { type: 'boolean' },
            }, required: ['index', 'frame', 'frameOverSample', 'callback', 'params', 'dataValid'] } },
            diagnostics: { type: 'array', maxItems: 64, items: { type: 'object', properties: { code: { type: 'string' }, location: { type: 'string' } }, required: ['code', 'location'] } },
            diagnosticCount: { type: 'integer' }, diagnosticsTruncated: { type: 'boolean' },
            runtimeVerified: { type: 'boolean', const: false }, sceneSaved: { type: 'boolean', const: false }, callbackExistenceVerified: { type: 'boolean', const: false },
        }, required: ['revision', 'revisionScope', 'nodeReference', 'clipReference', 'identity', 'clip', 'sourceScope', 'timingUnit', 'validityScope', 'valid', 'sourceComplete', 'complete', 'truncated', 'totalTracks', 'retrievedTracks', 'totalEvents', 'inspectedKeyframes', 'trackOffset', 'trackLimit', 'eventOffset', 'eventLimit', 'nextTrackOffset', 'nextEventOffset', 'tracks', 'events', 'diagnostics', 'diagnosticCount', 'diagnosticsTruncated', 'runtimeVerified', 'sceneSaved', 'callbackExistenceVerified'],
    }, 'GET', ['animation', 'timeline', 'inspect', 'read-only'])
    async animationTimelineInspect(args: TimelineInspectOptions) {
        const nodeReference = exactReference(args?.nodeReference, 'nodeReference');
        const clipReference = exactReference(args?.clipReference, 'clipReference');
        timelineInspectBounds(args);
        const [nodeValue, clipValue]: unknown[] = await Promise.all([
            Editor.Message.request('scene', 'query-node', nodeReference.id),
            Editor.Message.request('asset-db', 'query-asset-info', clipReference.id),
        ]);
        const node = timelineRecord(nodeValue), clip = timelineRecord(clipValue);
        if (!node || !clip) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'The exact node and AnimationClip must exist in the current Editor scope.' });
        const rawUuid = node.uuid, descriptor = timelineRecord(rawUuid);
        const nodeUuid = descriptor && 'value' in descriptor ? descriptor.value : rawUuid;
        if (nodeUuid !== nodeReference.id || clip.uuid !== clipReference.id) throw new ToolError({ code: 'TIMELINE_IDENTITY_MISMATCH', status: 502, message: 'Native node/Asset DB identities do not match the requested UUIDs.' });
        if (clip.type !== 'cc.AnimationClip' || clip.invalid === true) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'clipReference must identify an available native cc.AnimationClip asset.' });
        // includeCurves bypasses slimClipDump, retaining raw events/keyframes. Existing
        // animationQuery caps curves at 1000 and reports totalCurves/truncated.
        const response = await new AnimationTools().animationQuery({ operation: 'clip_dump', nodeReference, clipReference, includeCurves: true, maxCurves: 1000 });
        return inspectAnimationTimeline(response.result, { ...args, nodeReference, clipReference }, { nodeUuid: nodeReference.id, clipUuid: clipReference.id });
    }
}
