import { ToolError } from '../tool-error';

export interface NodeOrientationCondition { space: 'local' | 'world'; x: number; y: number; z: number; w: number; toleranceDegrees: number }

export function unitQuaternion(q: { x: number; y: number; z: number; w: number } | undefined, code: 'INVALID_ARGUMENT' | 'INVALID_RUNTIME_RESPONSE'): number[] {
    if (!q || [q.x, q.y, q.z, q.w].some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new ToolError({ code, status: code === 'INVALID_ARGUMENT' ? 400 : 502, message: 'Finite nonzero quaternion required.' });
    const max = Math.max(Math.abs(q.x), Math.abs(q.y), Math.abs(q.z), Math.abs(q.w));
    if (max === 0) throw new ToolError({ code, status: code === 'INVALID_ARGUMENT' ? 400 : 502, message: 'Zero quaternion has no orientation.' });
    const x = q.x / max, y = q.y / max, z = q.z / max, w = q.w / max;
    const norm = Math.hypot(x, y, z, w);
    return [x / norm, y / norm, z / norm, w / norm];
}

export function orientationMatches(observed: { x: number; y: number; z: number; w: number } | undefined, expectedUnit: number[], toleranceDegrees: number): boolean {
    const actual = unitQuaternion(observed, 'INVALID_RUNTIME_RESPONSE');
    const dot = Math.min(1, Math.abs(actual[0] * expectedUnit[0] + actual[1] * expectedUnit[1] + actual[2] * expectedUnit[2] + actual[3] * expectedUnit[3]));
    return toleranceDegrees === 180 || dot >= Math.cos(toleranceDegrees * Math.PI / 360);
}
