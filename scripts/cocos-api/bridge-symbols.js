'use strict';
const { ts, files, path, source, compare } = require('./catalog-utils');
const { createProgram, resolveAlias } = require('./compiler-inputs');
const { unwrap, evaluate, UNKNOWN } = require('./static-values');
function bridgeInput(root) {
  const sourceRoot = path.join(root, 'source');
  const roots = files(sourceRoot, file => /\.tsx?$/.test(file) && !/\.d\.ts$/.test(file));
  const input = { ...createProgram(root, roots), root, roots, functions: new Map(), names: new Map(), classes: new Map(), sceneMethods: new Map(), tools: [] };
  const { checker } = input;
  for (const file of roots) {
    const sf = input.program.getSourceFile(file);
    if (!sf) continue;
    const scan = node => {
      if (ts.isClassDeclaration(node) && node.name) input.classes.set(`${file}:${node.name.text}`, node);
      if (ts.isFunctionLike(node) && node.body) {
        input.functions.set(node, node);
        const name = node.name?.text;
        if (name) {
          const candidates = input.names.get(name) || [];
          candidates.push(node);
          input.names.set(name, candidates);
          if (path.basename(file) === 'scene.ts' && ts.isObjectLiteralExpression(node.parent)) input.sceneMethods.set(name, node);
        }
        const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
        for (const decorator of decorators) {
          const call = decorator.expression;
          if (!ts.isCallExpression(call) || !/^(?:utcpTool|.*\.utcpTool)$/.test(call.expression.getText())) continue;
          const nameValue = evaluate(call.arguments[0], checker);
          if (typeof nameValue !== 'string') throw new Error(`Unresolved tool registration at ${file}:${source(node, root, 'bridge').line}`);
          input.tools.push({ name: nameValue, node, registration: decorator,
            schema: evaluate(call.arguments[2], checker), httpMethod: evaluate(call.arguments[4], checker) });
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(sf);
  }
  input.tools.sort((a, b) => compare(a.name, b.name));
  return input;
}
function ownerFor(checker, expression) {
  expression = unwrap(expression);
  if (!expression) return null;
  if (ts.isNewExpression(expression)) return unwrap(expression.expression)?.getText();
  if (ts.isIdentifier(expression)) {
    const declared = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    return declared?.initializer ? ownerFor(checker, declared.initializer) : null;
  }
  return null;
}
function callee(input, call) {
  const expression = unwrap(call.expression);
  let symbol = input.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
  symbol = symbol && resolveAlias(input.checker, symbol);
  const declarations = symbol?.declarations || [];
  const direct = declarations.map(node => input.functions.has(node) ? node : node.initializer && input.functions.has(node.initializer) ? node.initializer : null).find(Boolean);
  if (direct) return direct;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = expression.expression.kind === ts.SyntaxKind.ThisKeyword ? call.parent : ownerFor(input.checker, expression.expression);
    if (typeof owner === 'string') {
      const candidates = (input.names.get(expression.name.text) || []).filter(node => node.parent.name?.text === owner);
      if (candidates.length === 1) return candidates[0];
    }
    if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
      let parent = call.parent;
      while (parent && !ts.isClassDeclaration(parent) && !ts.isObjectLiteralExpression(parent)) parent = parent.parent;
      const method = (parent?.members || parent?.properties || []).find(node => node.name?.getText() === expression.name.text && input.functions.has(node));
      if (method) return method;
    }
  }
  return null;
}
function operations(schema) {
  if (!schema || schema === UNKNOWN || typeof schema !== 'object') return [{ field: null, value: null }];
  for (const field of ['operation', 'category', 'action']) {
    const values = schema.properties?.[field]?.enum;
    if (Array.isArray(values) && values.every(value => typeof value === 'string')) return [...new Set(values)].sort(compare).map(value => ({ field, value }));
  }
  return [{ field: null, value: null }];
}
module.exports = { bridgeInput, callee, operations };
