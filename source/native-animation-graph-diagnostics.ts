import { inspectNativeAnimationGraph } from './native-animation-graph-inspect';

type Row = Record<string, unknown>;
export interface NativeGraphDiagnostic { code: string; id: string; variable?: string }
/** Conservative structural paths only: conditions are not evaluated. */
export function diagnoseNativeGraphReferences(graph: ReturnType<typeof inspectNativeAnimationGraph>) {
    const issues: NativeGraphDiagnostic[] = [];
    const declared = new Set(graph.variables.flatMap(row => typeof row.name === 'string' ? [row.name] : []));
    let truncated = graph.truncated;
    const add = (issue: NativeGraphDiagnostic) => { if (issues.length < 256) issues.push(issue); else truncated = true; };
    const variable = (name: unknown, id: string) => {
        if (typeof name === 'string' && name && !declared.has(name)) add({ code: 'UNDECLARED_VARIABLE', id, variable: name });
    };
    const types = new Map(graph.variables.map(row => [row.name, row.type]));
    for (const declaration of graph.variables) {
        const id = `variable:${String(declaration.name)}`;
        if (declaration.serializedType === 'cc.animation.PlainVariable') {
            if (![0, 1, 3].includes(declaration.type as number)) add({ code: 'INVALID_VARIABLE_TYPE', id });
            else if (declaration.type === 1 ? typeof declaration.value !== 'boolean'
                : typeof declaration.value !== 'number' || !Number.isFinite(declaration.value) || declaration.type === 3 && !Number.isInteger(declaration.value)) add({ code: 'INVALID_VARIABLE_DEFAULT', id });
        }
    }
    const operandType = (input: unknown, id: string, numeric: boolean) => {
        if (!input || typeof input !== 'object') { add({ code: 'INVALID_CONDITION_OPERAND', id }); return; }
        const operand = input as Row;
        if (typeof operand.variable !== 'string') { add({ code: 'INVALID_CONDITION_OPERAND', id }); return; }
        if (operand.variable) {
            if (!declared.has(operand.variable)) return;
            const type = types.get(operand.variable);
            if (numeric ? type !== 0 && type !== 3 : type !== 1) add({ code: 'CONDITION_VARIABLE_TYPE_MISMATCH', id, variable: operand.variable });
        } else if (numeric ? typeof operand.value !== 'number' || !Number.isFinite(operand.value) : typeof operand.value !== 'boolean') add({ code: 'INVALID_CONDITION_CONSTANT', id });
    };
    for (const condition of graph.conditions) {
        const id = String(condition.id);
        variable(condition.trigger, id);
        for (const field of ['lhs', 'rhs', 'operand']) {
            const operand = condition[field];
            if (operand && typeof operand === 'object') variable((operand as Row).variable, id);
        }
        if (condition.serializedType === 'cc.animation.BinaryCondition') {
            if (!Number.isInteger(condition.operator) || (condition.operator as number) < 0 || (condition.operator as number) > 5) add({ code: 'INVALID_CONDITION_OPERATOR', id });
            operandType(condition.lhs, id, true); operandType(condition.rhs, id, true);
        } else if (condition.serializedType === 'cc.animation.UnaryCondition') {
            if (condition.operator !== 0 && condition.operator !== 1) add({ code: 'INVALID_CONDITION_OPERATOR', id });
            operandType(condition.operand, id, false);
        } else if (condition.serializedType === 'cc.animation.TriggerCondition') {
            if (typeof condition.trigger !== 'string' || !condition.trigger) add({ code: 'INVALID_TRIGGER_REFERENCE', id });
            else if (declared.has(condition.trigger) && types.get(condition.trigger) !== 2) add({ code: 'CONDITION_VARIABLE_TYPE_MISMATCH', id, variable: condition.trigger });
        }
    }
    for (const state of graph.states) if (state.speedMultiplierEnabled === true) variable(state.speedMultiplier, String(state.id));
    const adjacency = new Map<string, string[]>();
    for (const transition of graph.transitions) {
        if (typeof transition.from !== 'string' || typeof transition.to !== 'string') continue;
        const destinations = adjacency.get(transition.from);
        if (destinations) destinations.push(transition.to); else adjacency.set(transition.from, [transition.to]);
    }
    const reachable = new Set<string>();
    const machines = new Map(graph.stateMachines.map(machine => [machine.id, machine]));
    const machinesSeen = new Set<unknown>();
    const pendingMachines = graph.stateMachines.filter(machine => machine.parentStateId === null);
    for (let cursor = 0; cursor < pendingMachines.length; cursor++) {
        const machine = pendingMachines[cursor];
        if (machinesSeen.has(machine.id)) continue;
        machinesSeen.add(machine.id);
        const queue = [machine.entryState, machine.anyState].filter((id): id is string => typeof id === 'string');
        const local = new Set<string>();
        for (let index = 0; index < queue.length; index++) {
            const id = queue[index];
            if (local.has(id)) continue;
            local.add(id); reachable.add(id);
            for (const target of adjacency.get(id) ?? []) if (!local.has(target)) queue.push(target);
        }
        for (const child of machines.values()) if (typeof child.parentStateId === 'string' && local.has(child.parentStateId)) pendingMachines.push(child);
    }
    // Incomplete structure cannot prove absence of paths or declarations.
    const complete = graph.nativeShape && graph.structuralValid && !graph.truncated;
    if (complete) {
        const special = new Set(graph.stateMachines.flatMap(machine => [machine.entryState, machine.exitState, machine.anyState]));
        for (const state of graph.states) if (typeof state.id === 'string' && !special.has(state.id) && !reachable.has(state.id)) add({ code: 'NO_STRUCTURAL_ENTRY_PATH', id: state.id });
    }
    return { complete: complete && !truncated, issues, truncated, checkedStates: graph.states.length, checkedConditions: graph.conditions.length,
        semanticsVerified: false as const, runtimeVerified: false as const,
        verificationScope: 'Declared-variable/type references, native condition operator/constants and conservative entry/any-state structural paths. Engine evaluation, implicit transitions and runtime playability are not verified. Diagnostics from incomplete input are provisional.' };
}
