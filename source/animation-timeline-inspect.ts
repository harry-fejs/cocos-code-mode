import { createHash } from 'crypto';
import { IInstanceReference } from './utcp/schemas';
import { ToolError } from './utcp/tool-error';

type Row = Record<string, unknown>;
export interface TimelineInspectOptions {
    nodeReference: IInstanceReference;
    clipReference: IInstanceReference;
    trackBinding?: { nodePath: string; component?: string; parentProperty?: string; property: string };
    invalidTracksOnly?: boolean;
    invalidEventsOnly?: boolean;
    invalidKeyframesOnly?: boolean;
    eventCallback?: string;
    eventFrameRange?: { min: number; max: number };
    keyframeFrameRange?: { min: number; max: number };
    trackOffset?: number;
    trackLimit?: number;
    eventOffset?: number;
    eventLimit?: number;
    maxBytes?: number;
    expectedRevision?: string;
    keyframeOffset?: number;
    keyframeLimit?: number;
    diagnosticOffset?: number;
    diagnosticLimit?: number;
    diagnosticCode?: string;
}
export function timelineRecord(value: unknown): Row | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function fail(code: string, message: string, details: Row = {}): never {
    throw new ToolError({ code, message, status: code === 'INVALID_ARGUMENT' ? 400 : 422, details });
}
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}.`);
    return value;
}
export function timelineInspectBounds(options: TimelineInspectOptions) {
    if (options.expectedRevision !== undefined && (typeof options.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedRevision))) fail('INVALID_ARGUMENT', 'expectedRevision must be a lowercase SHA-256 revision.');
    if (options.invalidTracksOnly !== undefined && typeof options.invalidTracksOnly !== 'boolean') fail('INVALID_ARGUMENT', 'invalidTracksOnly must be a boolean.');
    if (options.invalidEventsOnly !== undefined && typeof options.invalidEventsOnly !== 'boolean') fail('INVALID_ARGUMENT', 'invalidEventsOnly must be a boolean.');
    if (options.invalidKeyframesOnly !== undefined && typeof options.invalidKeyframesOnly !== 'boolean') fail('INVALID_ARGUMENT', 'invalidKeyframesOnly must be a boolean.');
    if (options.diagnosticCode !== undefined && (typeof options.diagnosticCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(options.diagnosticCode))) fail('INVALID_ARGUMENT', 'diagnosticCode must be an exact uppercase diagnostic code of at most 64 characters.');
    const binding = options.trackBinding;
    if (binding !== undefined && (!timelineRecord(binding) || Object.keys(binding).some(key => !['nodePath', 'property', 'component', 'parentProperty'].includes(key)) || typeof binding.nodePath !== 'string' || binding.nodePath.length > 1024 || binding.component !== undefined && (typeof binding.component !== 'string' || !binding.component || binding.component.length > 256) || binding.parentProperty !== undefined && (typeof binding.parentProperty !== 'string' || binding.parentProperty.length > 256) || typeof binding.property !== 'string' || !binding.property || binding.property.length > 256)) fail('INVALID_ARGUMENT', 'trackBinding requires exact nodePath (empty root allowed) and nonempty property.');
    if (options.eventCallback !== undefined && (typeof options.eventCallback !== 'string' || !options.eventCallback || options.eventCallback.length > 256)) fail('INVALID_ARGUMENT', 'eventCallback must be an exact nonempty callback name of at most 256 characters.');
    const range = options.eventFrameRange;
    if (range !== undefined && (!timelineRecord(range) || Object.keys(range).some(key => !['min', 'max'].includes(key)) || typeof range.min !== 'number' || !Number.isFinite(range.min) || range.min < 0 || typeof range.max !== 'number' || !Number.isFinite(range.max) || range.max < range.min)) fail('INVALID_ARGUMENT', 'eventFrameRange requires finite nonnegative inclusive min <= max native frames.');
    const keyframeRange = options.keyframeFrameRange;
    if (keyframeRange !== undefined && (!timelineRecord(keyframeRange) || Object.keys(keyframeRange).some(key => !['min', 'max'].includes(key)) || typeof keyframeRange.min !== 'number' || !Number.isFinite(keyframeRange.min) || keyframeRange.min < 0 || typeof keyframeRange.max !== 'number' || !Number.isFinite(keyframeRange.max) || keyframeRange.max < keyframeRange.min)) fail('INVALID_ARGUMENT', 'keyframeFrameRange requires finite nonnegative inclusive min <= max native frames.');
    return {
        trackOffset: integer(options.trackOffset, 0, 0, 1000000, 'trackOffset'),
        trackLimit: integer(options.trackLimit, 50, 1, 200, 'trackLimit'),
        eventOffset: integer(options.eventOffset, 0, 0, 1000000, 'eventOffset'),
        eventLimit: integer(options.eventLimit, 50, 1, 200, 'eventLimit'),
        keyframeOffset: integer(options.keyframeOffset, 0, 0, 100000, 'keyframeOffset'),
        keyframeLimit: integer(options.keyframeLimit, 20, 1, 200, 'keyframeLimit'),
        diagnosticOffset: integer(options.diagnosticOffset, 0, 0, 1000000, 'diagnosticOffset'),
        diagnosticLimit: integer(options.diagnosticLimit, 64, 1, 64, 'diagnosticLimit'),
        maxBytes: integer(options.maxBytes, 65536, 1024, 262144, 'maxBytes'),
    };
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Projects the Creator 3.7 EditorAnimationClipDump, not serialized .anim assets.
 * Native frame fields are retained verbatim; frame/sample is a labeled conversion, not runtime timing evidence.
 * Every retrieved track/event is checked, even when not included in the response page.
 */
export function inspectAnimationTimeline(value: unknown, options: TimelineInspectOptions, readback?: { nodeUuid: string; clipUuid: string }) {
    const bounds = timelineInspectBounds(options), dump = timelineRecord(value);
    const diagnostics: Array<{ code: string; location: string }> = [];
    let diagnosticCount = 0, supported = true;
    let matchedDiagnostics = 0;
    const diagnosticHash = createHash('sha256');
    const issue = (code: string, location: string, unsupported = false): void => {
        diagnosticHash.update(JSON.stringify([code, location]));
        if (options.diagnosticCode === undefined || options.diagnosticCode === code) {
            if (matchedDiagnostics >= bounds.diagnosticOffset && diagnostics.length < bounds.diagnosticLimit) diagnostics.push({ code, location });
            matchedDiagnostics++;
        }
        diagnosticCount++;
        if (unsupported) supported = false;
    };
    let metadataBytes = 0;
    const countMetadata = (value: unknown): void => {
        if (typeof value !== 'string') return;
        if (value.length > 1048576 - metadataBytes) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native timeline metadata exceeds 1 MiB UTF-8.');
        metadataBytes += Buffer.byteLength(value, 'utf8');
        if (metadataBytes > 1048576) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native timeline metadata exceeds 1 MiB UTF-8.');
    };
    countMetadata(dump?.name);
    if (!dump) issue('UNSUPPORTED_NATIVE_DUMP', 'clip', true);
    // These identities are not required by the 3.7 dump type, but cannot be ignored if exposed.
    for (const [field, expected] of [['uuid', options.clipReference.id], ['clipUuid', options.clipReference.id], ['nodeUuid', options.nodeReference.id]]) {
        if (dump && field in dump && dump[field] !== expected) fail('TIMELINE_IDENTITY_MISMATCH', `Native ${field} differs from the requested identity.`, { field });
    }
    const sample = dump && finite(dump.sample) && dump.sample > 0 ? dump.sample : null;
    const duration = dump && finite(dump.duration) && dump.duration >= 0 ? dump.duration : null;
    if (sample === null) issue('INVALID_SAMPLE', 'clip.sample');
    if (duration === null) issue('INVALID_DURATION', 'clip.duration');
    if (!dump || typeof dump.name !== 'string') issue('UNSUPPORTED_CLIP_NAME', 'clip.name', true);
    for (const field of ['speed', 'wrapMode']) if (dump && !finite(dump[field])) issue('INVALID_CLIP_NUMBER', `clip.${field}`);
    if (dump && 'time' in dump && !finite(dump.time)) issue('INVALID_CLIP_NUMBER', 'clip.time');
    const curves = dump && Array.isArray(dump.curves) ? dump.curves : null;
    const events = dump && Array.isArray(dump.events) ? dump.events : null;
    if (!curves) issue('UNSUPPORTED_CURVES', 'clip.curves', true);
    if (!events) issue('UNSUPPORTED_EVENTS', 'clip.events', true);
    if ((curves?.length ?? 0) > 1000 || (events?.length ?? 0) > 10000) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native dump exceeds 1000 retrieved tracks or 10000 events.');
    let sourceComplete = !!curves && !!events, totalTracks: number | null = curves?.length ?? null;
    if (dump && 'totalCurves' in dump) {
        if (!Number.isSafeInteger(dump.totalCurves) || typeof dump.totalCurves !== 'number' || dump.totalCurves < (curves?.length ?? 0)) {
            issue('INVALID_TRACK_TOTAL', 'clip.totalCurves', true); sourceComplete = false; totalTracks = null;
        } else { totalTracks = dump.totalCurves; sourceComplete = sourceComplete && dump.totalCurves === curves?.length; }
    }
    if (dump && 'truncated' in dump && typeof dump.truncated !== 'boolean') { issue('UNSUPPORTED_TRUNCATION', 'clip.truncated', true); sourceComplete = false; }
    if (dump?.truncated === true) sourceComplete = false;
    if (!sourceComplete && curves && events) issue('NATIVE_DUMP_TRUNCATED', 'clip.curves');
    let scannedValues = 0, keyframeCount = 0;
    let opaqueTextBytes = 0;
    let opaqueKeyBytes = 0;
    // Validate opaque property dumps for non-finite numeric values without interpreting their schema.
    const finiteTree = (root: unknown): boolean => {
        const pending: Array<{ value: unknown; depth: number; leaving?: boolean }> = [{ value: root, depth: 0 }];
        const active = new Set<object>();
        while (pending.length) {
            const entry = pending.pop()!;
            if (entry.leaving) { active.delete(entry.value as object); continue; }
            if (++scannedValues > 1000000 || entry.depth > 32) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native value scan exceeds 1000000 values or 32 levels.');
            if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) return false;
            if (typeof entry.value === 'string') {
                if (entry.value.length > 1048576 - opaqueTextBytes) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Opaque keyframe text exceeds 1 MiB UTF-8.');
                opaqueTextBytes += Buffer.byteLength(entry.value, 'utf8');
                if (opaqueTextBytes > 1048576) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Opaque keyframe text exceeds 1 MiB UTF-8.');
            }
            if (entry.value && typeof entry.value === 'object') {
                if (active.has(entry.value)) return false;
                active.add(entry.value);
                pending.push({ value: entry.value, depth: entry.depth, leaving: true });
                if (Array.isArray(entry.value)) {
                    if (entry.value.length + pending.length > 1000000) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native value array exceeds the scan bound.');
                    for (let index = 0; index < entry.value.length; index++) if (!Object.prototype.hasOwnProperty.call(entry.value, index)) return false;
                }
                for (const key in entry.value) {
                    if (!Object.prototype.hasOwnProperty.call(entry.value, key)) continue;
                    if (key.length > 1048576 - opaqueKeyBytes) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Opaque keyframe keys exceed 1 MiB UTF-8.');
                    opaqueKeyBytes += Buffer.byteLength(key, 'utf8');
                    if (opaqueKeyBytes > 1048576) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Opaque keyframe keys exceed 1 MiB UTF-8.');
                    if (scannedValues + pending.length >= 1000000) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native value container exceeds the scan bound.');
                    pending.push({ value: (entry.value as Row)[key], depth: entry.depth + 1 });
                }
            } else if (typeof entry.value === 'function' || typeof entry.value === 'symbol' || typeof entry.value === 'bigint' || entry.value === undefined) return false;
        }
        return true;
    };
    const frameValid = (frame: unknown): frame is number => finite(frame) && frame >= 0;
    const timingHash = createHash('sha256');
    let invalidTracks = 0;
    const tracks = Array.from(curves ?? [], (raw: unknown, index: number) => {
        const curve = timelineRecord(raw), location = `curves[${index}]`;
        const startIssues = diagnosticCount;
        for (const field of ['nodePath', 'key', 'comp', 'parentPropKey', 'displayName']) countMetadata(curve?.[field]);
        if (!curve || typeof curve.nodePath !== 'string' || typeof curve.key !== 'string' || !curve.key) issue('UNSUPPORTED_TRACK_BINDING', location, true);
        const keys: unknown[] | null = curve && Array.isArray(curve.keyframes) ? curve.keyframes : null;
        if (!keys) issue('UNSUPPORTED_KEYFRAMES', `${location}.keyframes`, true);
        keyframeCount += keys?.length ?? 0;
        if (keyframeCount > 100000) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native dump exceeds 100000 keyframes.');
        let first: number | null = null, last: number | null = null;
        let matchedKeyframes = 0;
        let invalidKeyframes = 0;
        let previousFrame: number | null = null;
        const keyframes: Array<{ index: number; frame: number | null; frameOverSample: number | null; dataValid: boolean }> = [];
        for (const [keyIndex, rawKey] of (keys ?? []).entries()) {
            const key = timelineRecord(rawKey), keyLocation = `${location}.keyframes[${keyIndex}]`;
            const keyIssues = diagnosticCount;
            const frame = key && frameValid(key.frame) ? key.frame : null;
            if (frame !== null) {
                if (previousFrame !== null && frame < previousFrame) issue('UNSORTED_KEYFRAME_TIME', keyLocation);
                previousFrame = frame;
            }
            const matchesFrame = options.keyframeFrameRange === undefined || frame !== null && frame >= options.keyframeFrameRange.min && frame <= options.keyframeFrameRange.max;
            if (!key || !frameValid(key.frame)) issue('INVALID_KEYFRAME_TIME', keyLocation);
            if (!key || !('dump' in key) || !finiteTree(key)) issue('INVALID_KEYFRAME_DATA', keyLocation);
            if (diagnosticCount !== keyIssues) invalidKeyframes++;
            timingHash.update(JSON.stringify([index, keyIndex, frame, diagnosticCount === keyIssues]));
            if (matchesFrame && (!options.invalidKeyframesOnly || diagnosticCount !== keyIssues)) {
                if (matchedKeyframes >= bounds.keyframeOffset && matchedKeyframes < bounds.keyframeOffset + bounds.keyframeLimit) keyframes.push({ index: keyIndex, frame, frameOverSample: frame !== null && sample !== null && finite(frame / sample) ? frame / sample : null, dataValid: diagnosticCount === keyIssues });
                matchedKeyframes++;
            }
            if (key && finite(key.frame) && key.frame >= 0) { first = first === null ? key.frame : Math.min(first, key.frame); last = last === null ? key.frame : Math.max(last, key.frame); }
        }
        for (const field of ['comp', 'parentPropKey', 'displayName']) if (curve && field in curve && typeof curve[field] !== 'string') issue('UNSUPPORTED_TRACK_METADATA', `${location}.${field}`, true);
        const row = { index, identity: { nodePath: text(curve?.nodePath), property: text(curve?.key) }, component: text(curve?.comp), parentProperty: text(curve?.parentPropKey), displayName: text(curve?.displayName), keyframeCount: keys?.length ?? null,
            matchedKeyframes: keys === null ? null : matchedKeyframes,
            invalidKeyframes: keys === null ? null : invalidKeyframes,
            keyframes, keyframeOffset: bounds.keyframeOffset, nextKeyframeOffset: keys && bounds.keyframeOffset + keyframes.length < matchedKeyframes ? bounds.keyframeOffset + keyframes.length : null,
            keyframeLimit: bounds.keyframeLimit, keyframesComplete: keys !== null && bounds.keyframeOffset === 0 && keyframes.length === matchedKeyframes,
            keyframesTruncated: keys === null || bounds.keyframeOffset > 0 || keyframes.length < matchedKeyframes,
            frameRange: first === null ? null : { first, last }, frameOverSampleRange: first === null || last === null || sample === null || !finite(first / sample) || !finite(last / sample) ? null : { first: first / sample, last: last / sample }, dataValid: diagnosticCount === startIssues };
        if (!row.dataValid) invalidTracks++;
        return row;
    });
    let eventParameterCount = 0;
    let eventTextBytes = 0;
    const countEventText = (value: string): void => {
        if (value.length > 1048576 - eventTextBytes) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native event text exceeds 1 MiB UTF-8.');
        eventTextBytes += Buffer.byteLength(value, 'utf8');
        if (eventTextBytes > 1048576) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native event text exceeds 1 MiB UTF-8.');
    };
    let invalidEvents = 0;
    const eventRows = Array.from(events ?? [], (raw: unknown, index: number) => {
        const event = timelineRecord(raw), location = `events[${index}]`, startIssues = diagnosticCount;
        if (!event || !frameValid(event.frame)) issue('INVALID_EVENT_TIME', location);
        const params = event && Array.isArray(event.params) ? event.params : null;
        eventParameterCount += params?.length ?? 0;
        if (eventParameterCount > 100000) fail('TIMELINE_SOURCE_BOUND_EXCEEDED', 'Native dump exceeds 100000 event parameters.');
        let paramsValid = params !== null;
        if (params) for (let i = 0; i < params.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(params, i) || typeof params[i] !== 'string') { paramsValid = false; break; }
            countEventText(params[i]);
        }
        if (typeof event?.func === 'string') countEventText(event.func);
        if (!event || typeof event.func !== 'string' || !event.func || !paramsValid) issue('UNSUPPORTED_EVENT_DATA', location, true);
        if (diagnosticCount !== startIssues) invalidEvents++;
        return { index, frame: event && finite(event.frame) ? event.frame : null, frameOverSample: event && frameValid(event.frame) && sample !== null && finite(event.frame / sample) ? event.frame / sample : null,
            callback: text(event?.func), params: paramsValid ? params as string[] : null, dataValid: diagnosticCount === startIssues };
    });
    // Revision covers the complete retrieved projection, not opaque keyframe values or unreturned native tracks.
    const hash = createHash('sha256');
    hash.update(JSON.stringify([options.nodeReference.id, options.clipReference.id, text(dump?.name), sample, duration, dump?.speed, dump?.wrapMode, totalTracks, sourceComplete]));
    hash.update(timingHash.digest('hex'));
    for (const { keyframes, matchedKeyframes, keyframeOffset, nextKeyframeOffset, keyframeLimit, keyframesComplete, keyframesTruncated, ...row } of tracks) hash.update(JSON.stringify(row));
    for (const row of eventRows) hash.update(JSON.stringify(row));
    hash.update(JSON.stringify([diagnosticHash.digest('hex'), diagnosticCount, supported]));
    const revision = hash.digest('hex');
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) throw new ToolError({ code: 'TIMELINE_REVISION_CHANGED', status: 409, message: 'Retrieved timeline metadata changed; restart paging. No mutation was dispatched.' });
    const selectedTracks = tracks.filter(track => (!options.invalidTracksOnly || !track.dataValid) && (!options.trackBinding || track.identity.nodePath === options.trackBinding!.nodePath && track.identity.property === options.trackBinding!.property && (options.trackBinding!.component === undefined || track.component === options.trackBinding!.component) && (options.trackBinding!.parentProperty === undefined || track.parentProperty === options.trackBinding!.parentProperty)));
    const selectedEvents = eventRows.filter(event => (!options.invalidEventsOnly || !event.dataValid) && (options.eventCallback === undefined || event.callback === options.eventCallback) && (options.eventFrameRange === undefined || event.frame !== null && event.frame >= options.eventFrameRange.min && event.frame <= options.eventFrameRange.max));
    const result = {
        nodeReference: options.nodeReference, clipReference: options.clipReference,
        revision, revisionScope: 'Retrieved timeline projection including all retrieved keyframe indices/times/dataValid, clip metadata, track bindings/counts/ranges, events and diagnostics. Excludes opaque keyframe values, unretrieved native tracks, callback binding and runtime state. Not an atomic scene snapshot.',
        identity: { node: readback?.nodeUuid === options.nodeReference.id ? 'query-node-verified' : 'requested-reference', clip: readback?.clipUuid === options.clipReference.id ? 'asset-db-verified' : 'requested-reference', dumpClipUuidExposed: !!dump && ('uuid' in dump || 'clipUuid' in dump), dumpNodeUuidExposed: !!dump && 'nodeUuid' in dump },
        clip: { name: text(dump?.name), sample, duration, speed: finite(dump?.speed) ? dump.speed : null, wrapMode: finite(dump?.wrapMode) ? dump.wrapMode : null },
        sourceScope: 'Creator scene query-animation-clip editor dump via animationQuery(includeCurves:true,maxCurves:1000). Node/clip readbacks establish identity only, not dump binding. Property curves/events only; auxiliary curves, embedded players, binding resolution and callback existence are outside scope.',
        timingUnit: 'Native frame fields retained. frameOverSample is arithmetic conversion only; native timing units and playback are not runtime-verified.',
        valid: supported && sourceComplete && diagnosticCount === 0, validityScope: 'Finite retrieved timeline data only; not scene binding or playable validation.',
        sourceComplete: sourceComplete && supported, complete: false, truncated: false,
        totalTracks, retrievedTracks: curves?.length ?? null, totalEvents: events?.length ?? null, inspectedKeyframes: keyframeCount,
        matchedTracks: curves ? selectedTracks.length : null, trackBinding: options.trackBinding ? { ...options.trackBinding } : null,
        matchedEvents: events ? selectedEvents.length : null, eventCallback: options.eventCallback ?? null,
        invalidEvents: events === null ? null : invalidEvents,
        invalidTracks: curves === null ? null : invalidTracks,
        invalidTracksOnly: options.invalidTracksOnly ?? false,
        invalidEventsOnly: options.invalidEventsOnly ?? false,
        invalidKeyframesOnly: options.invalidKeyframesOnly ?? false,
        eventFrameRange: options.eventFrameRange ? { ...options.eventFrameRange } : null,
        keyframeFrameRange: options.keyframeFrameRange ? { ...options.keyframeFrameRange } : null,
        trackOffset: bounds.trackOffset, trackLimit: bounds.trackLimit, eventOffset: bounds.eventOffset, eventLimit: bounds.eventLimit,
        nextTrackOffset: null as number | null, nextEventOffset: null as number | null,
        tracks: selectedTracks.slice(bounds.trackOffset, bounds.trackOffset + bounds.trackLimit), events: selectedEvents.slice(bounds.eventOffset, bounds.eventOffset + bounds.eventLimit),
        diagnostics, diagnosticCount,
        diagnosticCode: options.diagnosticCode ?? null, matchedDiagnostics,
        diagnosticOffset: bounds.diagnosticOffset, diagnosticLimit: bounds.diagnosticLimit,
        nextDiagnosticOffset: bounds.diagnosticOffset + diagnostics.length < matchedDiagnostics ? bounds.diagnosticOffset + diagnostics.length : null,
        diagnosticsTruncated: bounds.diagnosticOffset > 0 || matchedDiagnostics > diagnostics.length,
        runtimeVerified: false as const, sceneSaved: false as const, callbackExistenceVerified: false as const,
    };
    for (const [kind, rows] of [['track', result.tracks], ['event', result.events]] as const) for (const row of rows) {
        if (byteLength(row) > bounds.maxBytes) fail('TIMELINE_RECORD_TOO_LARGE', 'One timeline record exceeds maxBytes; it cannot be silently omitted.', { kind, index: row.index, maxBytes: bounds.maxBytes });
    }
    const pagination = (): void => {
        const trackEnd = bounds.trackOffset + result.tracks.length, eventEnd = bounds.eventOffset + result.events.length;
        result.nextTrackOffset = trackEnd < selectedTracks.length ? trackEnd : null;
        result.nextEventOffset = eventEnd < selectedEvents.length ? eventEnd : null;
        result.complete = result.sourceComplete && bounds.trackOffset === 0 && bounds.eventOffset === 0 && bounds.keyframeOffset === 0 && selectedTracks.every(track => track.nextKeyframeOffset === null) && result.nextTrackOffset === null && result.nextEventOffset === null && !result.diagnosticsTruncated;
        result.truncated = !result.sourceComplete || bounds.trackOffset > 0 || bounds.eventOffset > 0 || bounds.keyframeOffset > 0 || selectedTracks.some(track => track.nextKeyframeOffset !== null) || result.nextTrackOffset !== null || result.nextEventOffset !== null || result.diagnosticsTruncated;
    };
    pagination();
    while (byteLength(result) > bounds.maxBytes) {
        if (!result.tracks.length && !result.events.length) fail('TIMELINE_RESPONSE_TOO_LARGE', 'Timeline envelope and diagnostics exceed maxBytes.', { maxBytes: bounds.maxBytes });
        if (result.events.length && (!result.tracks.length || byteLength(result.events[result.events.length - 1]) >= byteLength(result.tracks[result.tracks.length - 1]))) result.events.pop();
        else result.tracks.pop();
        pagination();
    }
    if ((selectedTracks.length > bounds.trackOffset && !result.tracks.length) || (selectedEvents.length > bounds.eventOffset && !result.events.length)) fail('TIMELINE_RECORD_TOO_LARGE', 'The next timeline record cannot fit with the response envelope; increase maxBytes.', { maxBytes: bounds.maxBytes });
    return result;
}
