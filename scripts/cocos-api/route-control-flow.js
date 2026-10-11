'use strict';
const { ts, source } = require('./catalog-utils');
const { UNKNOWN } = require('./static-values');
const normal = () => new Set(['normal']);
function routeControlFlow({ walk, evaluate, local, conditions, root }) {
  function sequence(statements) {
    const exits = new Set();
    let reachable = true;
    for (const statement of statements) {
      if (!reachable) break;
      const completion = walk(statement);
      for (const exit of completion) if (exit !== 'normal') exits.add(exit);
      reachable = completion.has('normal');
    }
    if (reachable) exits.add('normal');
    return exits;
  }
  function snapshot() { return { values: new Map(local), conditions: [...conditions] }; }
  function restore(state) {
    local.clear(); state.values.forEach((value, key) => local.set(key, value));
    conditions.splice(0, conditions.length, ...state.conditions);
  }
  function branch(node, condition) {
    if (condition) conditions.push(condition);
    const completion = node ? walk(node) : normal();
    return { ...snapshot(), completion };
  }
  function merge(states, before) {
    const reachable = states.filter(state => state.completion.has('normal'));
    restore(before);
    if (reachable.length) {
      for (const key of new Set(reachable.flatMap(state => [...state.values.keys()]))) {
        const value = reachable[0].values.get(key);
        local.set(key, reachable.every(state => state.values.get(key) === value) ? value : UNKNOWN);
      }
      if (reachable.length === 1) conditions.splice(0, conditions.length, ...reachable[0].conditions);
    }
    return new Set(states.flatMap(state => [...state.completion]));
  }
  function switchFrom(node, index, label) {
    const exits = new Set();
    let reachable = true;
    for (; index >= 0 && index < node.caseBlock.clauses.length && reachable; index++) {
      const completion = sequence(node.caseBlock.clauses[index].statements);
      reachable = completion.has('normal');
      for (const exit of completion) if (exit !== 'normal') exits.add(exit === 'break:' ? 'normal' : exit);
    }
    if (reachable) exits.add('normal');
    return exits;
  }
  function handle(node) {
    if (ts.isBlock(node)) return sequence(node.statements);
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      if (node.expression) walk(node.expression);
      return new Set([ts.isReturnStatement(node) ? 'return' : 'throw']);
    }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) return new Set([`${ts.isBreakStatement(node) ? 'break' : 'continue'}:${node.label?.text || ''}`]);
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const expression = ts.isIfStatement(node) ? node.expression : node.condition;
      walk(expression);
      const value = evaluate(expression);
      const yes = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
      const no = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
      if (value !== UNKNOWN) return value ? walk(yes) : no ? walk(no) : normal();
      const before = snapshot();
      const evidence = { expression: expression.getText(), resolution: 'unknown', source: source(expression, root, 'bridge') };
      const first = branch(yes, { ...evidence, branch: true });
      restore(before);
      const second = branch(no, { ...evidence, branch: false });
      return merge([first, second], before);
    }
    if (ts.isSwitchStatement(node)) {
      walk(node.expression);
      const value = evaluate(node.expression);
      if (value !== UNKNOWN) {
        let index = node.caseBlock.clauses.findIndex(clause => ts.isCaseClause(clause) && evaluate(clause.expression) === value);
        if (index < 0) index = node.caseBlock.clauses.findIndex(ts.isDefaultClause);
        return index < 0 ? normal() : switchFrom(node, index);
      }
      const before = snapshot();
      const states = [];
      node.caseBlock.clauses.forEach((clause, index) => {
        restore(before);
        conditions.push({ expression: node.expression.getText(), resolution: 'unknown', branch: ts.isCaseClause(clause) ? clause.expression.getText() : 'default', source: source(node.expression, root, 'bridge') });
        const completion = switchFrom(node, index);
        states.push({ ...snapshot(), completion });
      });
      if (!node.caseBlock.clauses.some(ts.isDefaultClause)) states.push({ ...before, completion: normal() });
      return merge(states, before);
    }
    if (ts.isLabeledStatement(node)) {
      const completion = walk(node.statement);
      if (completion.delete(`break:${node.label.text}`)) completion.add('normal');
      return completion;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      if (node.initializer) walk(node.initializer);
      if (node.expression) walk(node.expression);
      if (node.condition) walk(node.condition);
      const condition = node.condition || (ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : null);
      const value = condition ? evaluate(condition) : UNKNOWN;
      if (value !== UNKNOWN && !value && !ts.isDoStatement(node)) return normal();
      const before = snapshot();
      if (value === UNKNOWN) conditions.push({ expression: condition?.getText() || 'loop iteration', resolution: 'unknown', branch: 'loop-body', source: source(node, root, 'bridge') });
      const completion = walk(node.statement);
      if (completion.has('normal') || completion.has('continue:')) { if (node.incrementor) walk(node.incrementor); }
      const exits = new Set([...completion].filter(exit => !['break:', 'continue:', 'normal'].includes(exit)));
      if (completion.has('break:') || completion.has('normal') || completion.has('continue:') || !ts.isDoStatement(node) && value === UNKNOWN) exits.add('normal');
      if (value === UNKNOWN) restore(before);
      return exits;
    }
    if (ts.isTryStatement(node)) {
      let completion = walk(node.tryBlock);
      if (node.catchClause && completion.delete('throw')) for (const exit of walk(node.catchClause.block)) completion.add(exit);
      if (node.finallyBlock) {
        const final = walk(node.finallyBlock);
        if (!final.has('normal')) return final;
        for (const exit of final) if (exit !== 'normal') completion.add(exit);
      }
      return completion;
    }
    return null;
  }
  return handle;
}
module.exports = { routeControlFlow, normal };
