'use strict';
const { ts, source, compare, json, finalize } = require('./catalog-utils');
const { bridgeInput, callee, operations } = require('./bridge-symbols');
const { UNKNOWN, unwrap, evaluate, possibleStrings, safe } = require('./static-values');

const terminal = status => new Set([status]);
const normal = () => new Set(['normal']);

function extractBridge(root, version, nativeRecords = []) {
  const input = bridgeInput(root);
  const native = new Map(nativeRecords.map(record => [`${record.module}:${record.member}`, record]));
  const routes = [];
  const records = [];
  const unresolved = [];

  for (const tool of input.tools) {
    const toolSource = source(tool.node, root, 'bridge');
    const toolRoutes = [];
    for (const operation of operations(tool.schema)) {
      const bindings = new Map();
      if (tool.node.parameters[0] && ts.isIdentifier(tool.node.parameters[0].name)) {
        const args = { ...(operation.field ? { [operation.field]: operation.value } : {}) };
        for (const field of Object.keys(tool.schema?.properties || {})) if (!Object.hasOwn(args, field)) args[field] = UNKNOWN;
        bindings.set(tool.node.parameters[0].name.text, args);
      }
      const routeUnknowns = [];
      let visits = 0;

      function trace(fn, env, chain, active = new Set()) {
        if (active.has(fn)) { routeUnknowns.push({ kind: 'recursive-handler', reference: fn.name?.getText() || 'anonymous' }); return; }
        if (chain.length > 16 || ++visits > 512) { routeUnknowns.push({ kind: 'trace-budget', reference: 'Handler traversal bound reached' }); return; }
        const next = new Set([...active, fn]);
        const local = new Map(env);
        const path = [...chain, { kind: 'handler', name: fn.name?.getText() || 'anonymous', source: source(fn, root, 'bridge') }];
        const conditions = [];
        const run = node => evaluate(node, input.checker, local);
        const evidence = (expression, branch) => ({ expression: expression.getText(), resolution: 'unknown', branch, source: source(expression, root, 'bridge') });
        const snapshot = () => new Map(local);
        const restore = state => { local.clear(); state.forEach((value, key) => local.set(key, value)); };
        const mergeStates = (states, before) => {
          const reachable = states.filter(state => state.completion.has('normal'));
          restore(before);
          for (const key of new Set(reachable.flatMap(state => [...state.values.keys()]))) {
            const value = reachable[0].values.get(key);
            local.set(key, reachable.every(state => state.values.get(key) === value) ? value : UNKNOWN);
          }
          return new Set(states.flatMap(state => [...state.completion]));
        };
        const sequence = statements => {
          const completion = new Set(['normal']);
          for (const statement of statements) {
            if (!completion.has('normal')) break;
            completion.delete('normal');
            for (const status of walk(statement)) completion.add(status);
          }
          return completion;
        };
        const runSwitchBranch = (node, start) => {
          const completion = new Set(['normal']);
          for (let index = start; index < node.caseBlock.clauses.length && completion.has('normal'); index++) {
            completion.delete('normal');
            for (const status of sequence(node.caseBlock.clauses[index].statements)) {
              if (status === 'break') completion.add('normal'); else completion.add(status);
            }
            if (completion.has('break')) { completion.delete('break'); break; }
          }
          return completion;
        };
        function walk(node) {
          if (!node) return normal();
          if (ts.isFunctionLike(node) && node !== fn) return normal();
          if (ts.isBlock(node)) return sequence(node.statements);
          if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
            if (node.expression) walk(node.expression);
            return terminal(ts.isReturnStatement(node) ? 'return' : 'throw');
          }
          if (ts.isBreakStatement(node)) return terminal('break');
          if (ts.isContinueStatement(node)) return terminal('continue');
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            if (node.initializer) walk(node.initializer);
            local.set(node.name.text, node.initializer ? run(node.initializer) : UNKNOWN);
            return normal();
          }
          if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
            if (node.initializer) walk(node.initializer);
            const value = node.initializer ? run(node.initializer) : UNKNOWN;
            for (const element of node.name.elements) if (ts.isIdentifier(element.name)) local.set(element.name.text, value !== UNKNOWN && value ? value[element.propertyName?.text || element.name.text] ?? UNKNOWN : UNKNOWN);
            return normal();
          }
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
            walk(node.right); local.set(node.left.text, run(node.right)); return normal();
          }
          if (ts.isIfStatement(node)) {
            walk(node.expression);
            const condition = run(node.expression);
            if (condition !== UNKNOWN) return walk(condition ? node.thenStatement : node.elseStatement);
            const before = snapshot();
            conditions.push(evidence(node.expression, true));
            const yesCompletion = walk(node.thenStatement);
            const yes = snapshot();
            conditions.pop(); restore(before);
            conditions.push(evidence(node.expression, false));
            const noCompletion = node.elseStatement ? walk(node.elseStatement) : normal();
            const no = snapshot();
            conditions.pop();
            return mergeStates([{ values: yes, completion: yesCompletion }, { values: no, completion: noCompletion }], before);
          }
          if (ts.isSwitchStatement(node)) {
            walk(node.expression);
            const value = run(node.expression);
            const clauses = node.caseBlock.clauses;
            const starts = value === UNKNOWN ? clauses.map((_, index) => index) : [clauses.findIndex(clause => ts.isCaseClause(clause) && run(clause.expression) === value)];
            const before = snapshot();
            const states = [];
            for (const start of starts) {
              if (start < 0) continue;
              restore(before);
              const clause = clauses[start];
              if (value === UNKNOWN) conditions.push(evidence(node.expression, ts.isCaseClause(clause) ? clause.expression.getText() : 'default'));
              const completion = runSwitchBranch(node, start);
              const values = snapshot();
              if (value === UNKNOWN) conditions.pop();
              states.push({ values, completion });
            }
            if (value === UNKNOWN && !clauses.some(ts.isDefaultClause)) states.push({ values: before, completion: normal() });
            if (!states.length) return normal();
            return mergeStates(states, before);
          }
          if (ts.isConditionalExpression(node)) {
            walk(node.condition);
            const value = run(node.condition);
            if (value !== UNKNOWN) return walk(value ? node.whenTrue : node.whenFalse);
            const before = snapshot();
            conditions.push(evidence(node.condition, true)); const yesCompletion = walk(node.whenTrue); const yes = snapshot(); conditions.pop();
            restore(before); conditions.push(evidence(node.condition, false)); const noCompletion = walk(node.whenFalse); const no = snapshot(); conditions.pop();
            return mergeStates([{ values: yes, completion: yesCompletion }, { values: no, completion: noCompletion }], before);
          }
          if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
            if (node.initializer) walk(node.initializer);
            if (node.expression && (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node))) walk(node.expression);
            const condition = ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : null;
            const value = condition ? run(condition) : UNKNOWN;
            if (condition) walk(condition);
            if (value !== false) walk(node.statement);
            if (node.incrementor) walk(node.incrementor);
            return normal();
          }
          if (ts.isCallExpression(node)) {
            const expression = unwrap(node.expression);
            const callName = expression.getText();
            const callSource = source(node, root, 'bridge');
            if (/^Editor\.Message\.(?:request|send)$/.test(callName)) {
              const module = run(node.arguments[0]);
              const message = run(node.arguments[1]);
              if (typeof module !== 'string' || typeof message !== 'string') routeUnknowns.push({ kind: 'computed-ipc', reference: callName, source: callSource, conditions: [...conditions], moduleCandidates: possibleStrings(node.arguments[0], input.checker, local), messageCandidates: possibleStrings(node.arguments[1], input.checker, local) });
              else {
                const target = native.get(`${module}:${message}`);
                const payload = run(node.arguments[2]);
                const row = { tool: tool.name, operation: operation.value, operationField: operation.field, conditions: [...conditions], evidenceStatus: 'sourceComposed', permitted: false,
                  steps: [...path, ...conditions.map(item => ({ kind: 'branch', ...item })), { kind: 'ipc', module, message, source: callSource }], target: { namespace: 'editor-ipc', module, member: message, recordId: target?.id || null, registryAvailable: !!target, facadeCandidates: target?.facadeMatches?.map(item => ({ className: item.className, member: item.member, source: item.source })) || [] } };
                if (message === 'execute-scene-script') {
                  const method = payload !== UNKNOWN && payload?.method;
                  const scene = typeof method === 'string' && input.sceneMethods.get(method);
                  row.target.sceneMethod = typeof method === 'string' ? method : null;
                  row.target.sceneHandlerResolved = !!scene;
                  if (scene) {
                    const args = Array.isArray(payload.args) ? payload.args : [];
                    trace(scene, bind(scene, args), row.steps, next);
                    row.steps.push({ kind: 'scene-method', name: method, source: source(scene, root, 'bridge') });
                  } else routeUnknowns.push({ kind: 'scene-handler', reference: typeof method === 'string' ? method : 'computed method', source: callSource, conditions: [...conditions] });
                }
                routes.push(row); toolRoutes.push(row);
              }
            } else {
              const target = callee(input, node);
              if (target) trace(target, bind(target, node.arguments.map(run)), [...path, { kind: 'call', name: callName, source: callSource }], next);
              else if (ts.isPropertyAccessExpression(expression)) {
                const receiver = expression.expression;
                const receiverType = input.checker.getTypeAtLocation(receiver);
                const className = receiverType.symbol?.name;
                const declaration = input.checker.getSymbolAtLocation(expression.name)?.declarations?.[0];
                const engineOrigin = declaration?.getSourceFile().fileName;
                if (/^(?:cc\.|cce\.|.*\['cc'\])/.test(receiver.getText()) || engineOrigin && /(?:cocos|cc\.d\.ts)/i.test(engineOrigin)) {
                  const row = { tool: tool.name, operation: operation.value, operationField: operation.field, conditions: [...conditions], evidenceStatus: 'sourceComposed', permitted: false,
                    steps: [...path, ...conditions.map(item => ({ kind: 'branch', ...item })), { kind: 'engine-call', receiver: receiver.getText(), className: className || null, member: expression.name.text, source: callSource }], target: { namespace: 'engine-runtime', module: 'cc', className: className || null, member: expression.name.text, resolution: className ? 'type-resolved' : 'unknown' } };
                  routes.push(row); toolRoutes.push(row);
                }
              }
            }
            for (const argument of node.arguments) if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) trace(argument, local, path, next); else walk(argument);
            return normal();
          }
          ts.forEachChild(node, walk);
          return normal();
        }
        function bind(fnToBind, values) {
          const bound = new Map();
          fnToBind.parameters.forEach((parameter, index) => {
            const value = index < values.length ? values[index] : parameter.initializer ? evaluate(parameter.initializer, input.checker, bound) : UNKNOWN;
            if (ts.isIdentifier(parameter.name)) bound.set(parameter.name.text, value);
            else if (ts.isObjectBindingPattern(parameter.name)) for (const element of parameter.name.elements) if (ts.isIdentifier(element.name)) bound.set(element.name.text, value !== UNKNOWN && value ? value[element.propertyName?.text || element.name.text] : UNKNOWN);
          });
          return bound;
        }
        walk(fn.body);
      }
      trace(tool.node, bindings, []);
      for (const unknown of routeUnknowns) unresolved.push({ tool: tool.name, operation: operation.value, ...unknown });
    }
    records.push(finalize({ version, namespace: 'bridge', module: 'ccp3x', className: tool.node.parent.name?.getText() || null, member: tool.name, name: tool.name, kind: 'tool', domain: 'tools', signatures: [], decorators: ['utcpTool'], source: toolSource, evidenceStatus: 'declared', contextConstraints: { execution: ['extension-main'], targetAvailable: 'unknown' }, visibility: 'public', internal: false, static: false, readonly: tool.httpMethod === 'GET', discovered: true, permitted: false, publicExport: true, schema: safe(tool.schema), operations: operations(tool.schema), unresolved: unresolved.filter(item => item.tool === tool.name), composedRouteCount: toolRoutes.length, composedRoutes: toolRoutes, evidence: [{ kind: 'tool-registration', source: source(tool.registration, root, 'bridge') }] }));
  }
  const unique = [...new Map(routes.map(route => [json(route), route])).values()].sort((a, b) => compare(json(a), json(b)));
  return { records, routes: unique, unresolved };
}
module.exports = { extractBridge };
