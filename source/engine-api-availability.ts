export interface EngineClassRequest { className: string }
export interface EngineClassAvailability { available: boolean; className: string; engineVersion: string | null; context: 'edit-scene'; runtimeVerified: false; qualified: false }

export function inspectEngineClass(request: EngineClassRequest, engine: unknown): EngineClassAvailability {
    if (!request || typeof request.className !== 'string' || !/^(?:cc\.)?[A-Za-z_$][A-Za-z0-9_$]*$/.test(request.className)) throw new Error('Invalid engine class name.');
    const className = request.className.replace(/^cc\./, '');
    const object = engine && typeof engine === 'object' ? engine as Record<string, unknown> : null;
    let registered = object && Object.prototype.hasOwnProperty.call(object, className) ? object[className] : undefined;
    const registry = object?.js;
    if (registered === undefined && registry && typeof registry === 'object' && 'getClassByName' in registry && typeof registry.getClassByName === 'function') registered = registry.getClassByName(`cc.${className}`);
    const version = object?.ENGINE_VERSION ?? object?.VERSION;
    return { available: typeof registered === 'function', className: request.className, engineVersion: typeof version === 'string' ? version : null, context: 'edit-scene', runtimeVerified: false, qualified: false };
}
