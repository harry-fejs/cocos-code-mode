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
    for (const condition of graph.conditions) {
        const id = String(condition.id);
        variable(condition.trigger, id);
        for (const field of ['lhs', 'rhs', 'operand']) {
            const operand = condition[field];
            if (operand && typeof operand === 'object') variable((operand as Row).variable, id);
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
        verificationScope: 'Declared-variable references and conservative entry/any-state structural paths only. Conditions, clip assets, blend trees, engine implicit transitions and runtime playability are not verified. Diagnostics from incomplete input are provisional.' };
}
