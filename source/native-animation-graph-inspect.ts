type Row = Record<string, unknown>;
type Issue = { code: string, path: string };
const PREFIX = 'cc.animation.';
const LIMITS = { layers: 32, stateMachines: 128, states: 256, transitions: 512, variables: 128, conditions: 512, issues: 128 };

function record(value: unknown): Row | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}

// Creator 3.7 serializes AnimationGraph._layers/_variables and object-table __id__
// links, not top-level synthetic nodes/transitions. This reader never deserializes
// executable engine objects or asserts playable/semantic/runtime validity.
export function inspectNativeAnimationGraph(value: unknown) {
    const table: unknown[] = Array.isArray(value) ? value : [];
    const root = record(Array.isArray(value) ? value[0] : value);
    const nativeShape = root?.__type__ === `${PREFIX}AnimationGraph`;
    const format = nativeShape ? 'native-creator-3.7' : root && (Array.isArray(root.nodes) || Array.isArray(root.transitions)) ? 'legacy-synthetic' : 'unsupported';
    const layers: Row[] = [], stateMachines: Row[] = [], states: Row[] = [], transitions: Row[] = [], variables: Row[] = [], conditions: Row[] = [];
    const issues: Issue[] = [];
    let truncated = false;
    const issue = (code: string, path: string) => { if (issues.length < LIMITS.issues) issues.push({ code, path: path.slice(0, 256) }); else truncated = true; };
    const text = (candidate: unknown): string | null => {
        if (typeof candidate !== 'string') return null;
        if (candidate.length > 256) truncated = true;
        return candidate.slice(0, 256);
    };
    const scalar = (candidate: unknown) => typeof candidate === 'number' || typeof candidate === 'boolean' ? candidate : text(candidate);
    const resolve = (candidate: unknown, path: string): Row | undefined => {
        const object = record(candidate);
        if (!object) { issue('INVALID_OBJECT', path); return undefined; }
        if (!('__id__' in object)) return object;
        const id = object.__id__;
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= table.length || !record(table[id])) { issue('INVALID_SERIALIZED_REFERENCE', path); return undefined; }
        return record(table[id]);
    };
    const identity = new Map<object, string>();
    for (let index = 0; index < Math.min(table.length, 20000); index++) {
        const object = record(table[index]);
        if (object) identity.set(object, `object:${index}`);
    }
    if (table.length > 20000) truncated = true;
    let inlineId = 0;
    const idOf = (object: Row, path: string): string => {
        let id = identity.get(object);
        if (!id) { id = `inline:${inlineId++}:${path.slice(0, 64)}`; identity.set(object, id); }
        return id;
    };
    const list = (object: Row, field: string, path: string): unknown[] => {
        if (!Array.isArray(object[field])) { issue('INVALID_COLLECTION', `${path}.${field}`); return []; }
        return object[field] as unknown[];
    };
    const operand = (candidate: unknown, path: string) => {
        const object = resolve(candidate, path);
        return { variable: text(object?.variable), value: scalar(object?.value) };
    };
    const pending: Array<{ value: unknown, path: string, layerId: string, parentStateId: string | null }> = [];
    if (!nativeShape || !root) issue('NON_NATIVE_GRAPH_FORMAT', '$');
    else {
        if ('nodes' in root || 'transitions' in root) issue('LEGACY_FIELDS_IN_NATIVE_GRAPH', '$');
        const entries = list(root, '_layers', '$');
        if (entries.length > LIMITS.layers) truncated = true;
        for (let index = 0; index < Math.min(entries.length, LIMITS.layers); index++) {
            const path = `$._layers[${index}]`, layer = resolve(entries[index], path);
            if (!layer || layer.__type__ !== `${PREFIX}Layer`) { issue('INVALID_LAYER_TYPE', path); continue; }
            const id = idOf(layer, path);
            layers.push({ id, name: text(layer.name), weight: scalar(layer.weight), maskUuid: text(record(layer.mask)?.__uuid__) });
            pending.push({ value: layer._stateMachine, path: `${path}._stateMachine`, layerId: id, parentStateId: null });
        }
        const declarations = resolve(root._variables, '$._variables');
        if (!declarations) issue('INVALID_VARIABLE_COLLECTION', '$._variables');
        else {
            for (const name in declarations) {
                if (!Object.prototype.hasOwnProperty.call(declarations, name)) continue;
                if (variables.length >= LIMITS.variables) { truncated = true; break; }
                const path = `$._variables.${name}`, variable = resolve(declarations[name], path);
                if (!variable) continue;
                if (variable.__type__ !== `${PREFIX}PlainVariable` && variable.__type__ !== `${PREFIX}TriggerVariable`) issue('UNSUPPORTED_VARIABLE_TYPE', path);
                variables.push({ name: text(name), serializedType: text(variable.__type__), type: scalar(variable._type), value: scalar(variable._value), flags: scalar(variable._flags) });
            }
        }
    }
    const visited = new Set<object>();
    while (pending.length) {
        if (stateMachines.length >= LIMITS.stateMachines) { truncated = true; break; }
        const item = pending.pop()!;
        const machine = resolve(item.value, item.path);
        if (!machine || machine.__type__ !== `${PREFIX}StateMachine`) { issue('INVALID_STATE_MACHINE_TYPE', item.path); continue; }
        if (visited.has(machine)) { issue('REUSED_STATE_MACHINE', item.path); continue; }
        visited.add(machine);
        const machineId = idOf(machine, item.path), members = new Set<object>();
        const machineStates = list(machine, '_states', item.path);
        for (let index = 0; index < machineStates.length; index++) {
            if (states.length >= LIMITS.states) { truncated = true; break; }
            const path = `${item.path}._states[${index}]`, state = resolve(machineStates[index], path);
            if (!state) continue;
            if (members.has(state)) { issue('DUPLICATE_STATE_REFERENCE', path); continue; }
            members.add(state);
            const type = state.__type__;
            if (type !== `${PREFIX}State` && type !== `${PREFIX}Motion` && type !== `${PREFIX}EmptyState` && type !== `${PREFIX}SubStateMachine`) issue('UNSUPPORTED_STATE_TYPE', path);
            const id = idOf(state, path);
            const motion = state.motion == null ? undefined : resolve(state.motion, `${path}.motion`);
            states.push({ id, stateMachineId: machineId, layerId: item.layerId, name: text(state.name), serializedType: text(type), motionType: text(motion?.__type__), clipUuid: text(record(motion?.clip)?.__uuid__), speed: scalar(state.speed), speedMultiplier: text(state.speedMultiplier), speedMultiplierEnabled: scalar(state.speedMultiplierEnabled) });
            if (type === `${PREFIX}SubStateMachine`) pending.push({ value: state._stateMachine, path: `${path}._stateMachine`, layerId: item.layerId, parentStateId: id });
        }
        const special: Row = {};
        for (const field of ['_entryState', '_exitState', '_anyState']) {
            const state = resolve(machine[field], `${item.path}.${field}`);
            if (state && !members.has(state) && !truncated) issue('SPECIAL_STATE_NOT_IN_MACHINE', `${item.path}.${field}`);
            special[field.slice(1)] = state ? idOf(state, `${item.path}.${field}`) : null;
        }
        stateMachines.push({ id: machineId, layerId: item.layerId, parentStateId: item.parentStateId, ...special });
        const edges = list(machine, '_transitions', item.path);
        for (let index = 0; index < edges.length; index++) {
            if (transitions.length >= LIMITS.transitions) { truncated = true; break; }
            const path = `${item.path}._transitions[${index}]`, edge = resolve(edges[index], path);
            if (!edge) continue;
            const type = edge.__type__;
            if (type !== `${PREFIX}Transition` && type !== `${PREFIX}AnimationTransition` && type !== `${PREFIX}EmptyStateTransition`) issue('UNSUPPORTED_TRANSITION_TYPE', path);
            const from = resolve(edge.from, `${path}.from`), to = resolve(edge.to, `${path}.to`);
            if ((!from || !to || !members.has(from) || !members.has(to)) && !truncated) issue('INVALID_TRANSITION_ENDPOINT', path);
            const id = idOf(edge, path), predicates = list(edge, 'conditions', path);
            transitions.push({ id, stateMachineId: machineId, serializedType: text(type), from: from ? idOf(from, `${path}.from`) : null, to: to ? idOf(to, `${path}.to`) : null, conditionCount: predicates.length, duration: scalar(edge.duration), relativeDuration: scalar(edge.relativeDuration), exitConditionEnabled: scalar(edge.exitConditionEnabled), exitCondition: scalar(edge._exitCondition), destinationStart: scalar(edge.destinationStart), relativeDestinationStart: scalar(edge.relativeDestinationStart), interruptionSource: scalar(edge.interruptionSource) });
            for (let conditionIndex = 0; conditionIndex < predicates.length; conditionIndex++) {
                if (conditions.length >= LIMITS.conditions) { truncated = true; break; }
                const conditionPath = `${path}.conditions[${conditionIndex}]`, condition = resolve(predicates[conditionIndex], conditionPath);
                if (!condition) continue;
                const conditionType = condition.__type__;
                const metadata: Row = { id: idOf(condition, conditionPath), transitionId: id, serializedType: text(conditionType) };
                if (conditionType === `${PREFIX}BinaryCondition`) { metadata.operator = scalar(condition.operator); metadata.lhs = operand(condition.lhs, `${conditionPath}.lhs`); metadata.rhs = operand(condition.rhs, `${conditionPath}.rhs`); }
                else if (conditionType === `${PREFIX}UnaryCondition`) { metadata.operator = scalar(condition.operator); metadata.operand = operand(condition.operand, `${conditionPath}.operand`); }
                else if (conditionType === `${PREFIX}TriggerCondition`) metadata.trigger = text(condition.trigger);
                else issue('UNSUPPORTED_CONDITION_TYPE', conditionPath);
                conditions.push(metadata);
            }
        }
    }
    return { format, nativeShape, structuralValid: nativeShape && issues.length === 0 && !truncated, semanticsVerified: false as const, runtimeVerified: false as const, layers, stateMachines, states, transitions, variables, conditions, layerCount: layers.length, stateMachineCount: stateMachines.length, stateCount: states.length, transitionCount: transitions.length, variableCount: variables.length, conditionCount: conditions.length, issues, truncated, limits: { ...LIMITS }, verificationScope: 'Bounded serialized structure only; counts are inspected items. Clip existence, bindings, reachability, condition semantics, playability and runtime behavior are not verified.' };
}
