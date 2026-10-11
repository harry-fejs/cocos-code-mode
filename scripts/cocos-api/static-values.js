'use strict';
const { ts, compare, json } = require('./catalog-utils');
const UNKNOWN = Symbol('unresolved-static-value');
function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}
function evaluate(node, checker, bindings = new Map(), seen = new Set(), depth = 0) {
  node = unwrap(node);
  if (!node || depth > 24 || seen.has(node)) return UNKNOWN;
  const next = new Set([...seen, node]);
  const run = child => evaluate(child, checker, bindings, next, depth + 1);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) { const value = run(span.expression); if (value === UNKNOWN) return UNKNOWN; result += String(value) + span.literal.text; }
    return result;
  }
  if (ts.isIdentifier(node)) {
    if (bindings.has(node.text)) return bindings.get(node.text);
    if (node.text === 'undefined') return undefined;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration || symbol?.declarations?.[0];
    if (declaration?.initializer) return run(declaration.initializer);
    if (declaration && ts.isBindingElement(declaration) && declaration.parent.parent.initializer) {
      const parent = run(declaration.parent.parent.initializer);
      return parent && parent !== UNKNOWN && typeof parent === 'object' ? parent[declaration.propertyName?.text || declaration.name.text] : UNKNOWN;
    }
    return UNKNOWN;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const parent = run(node.expression);
    const key = ts.isPropertyAccessExpression(node) ? node.name.text : run(node.argumentExpression);
    return parent !== UNKNOWN && parent != null && key !== UNKNOWN && Object.hasOwn(parent, key) ? parent[key] : UNKNOWN;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const value = run(property.expression);
        if (value === UNKNOWN || !value || typeof value !== 'object') return UNKNOWN;
        Object.assign(object, value);
      } else if (ts.isPropertyAssignment(property)) {
        const key = ts.isComputedPropertyName(property.name) ? run(property.name.expression) : property.name.text;
        if (key === UNKNOWN) return UNKNOWN;
        object[key] = run(property.initializer);
      } else if (ts.isShorthandPropertyAssignment(property)) object[property.name.text] = run(property.name);
      else return UNKNOWN;
    }
    return object;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(run);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const receiver = run(node.expression.expression);
    const args = node.arguments.map(run);
    const method = node.expression.name.text;
    if (args.includes(UNKNOWN)) return UNKNOWN;
    if (Array.isArray(receiver) && method === 'includes') return receiver.includes(args[0]);
    if (typeof receiver === 'string' && method === 'replace' && typeof args[0] === 'string' && typeof args[1] === 'string') return receiver.replace(args[0], args[1]);
  }
  if (ts.isConditionalExpression(node)) {
    const test = run(node.condition);
    return test === UNKNOWN ? UNKNOWN : run(test ? node.whenTrue : node.whenFalse);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const value = run(node.operand);
    if (value === UNKNOWN) return UNKNOWN;
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
    if (node.operator === ts.SyntaxKind.MinusToken) return -value;
    if (node.operator === ts.SyntaxKind.PlusToken) return +value;
  }
  if (ts.isBinaryExpression(node)) {
    const left = run(node.left);
    const right = run(node.right);
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.QuestionQuestionToken) return left === UNKNOWN ? UNKNOWN : left == null ? right : left;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken && left !== UNKNOWN && !left) return left;
    if (operator === ts.SyntaxKind.BarBarToken && left !== UNKNOWN && left) return left;
    if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(operator)) return left === right;
    if ([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(operator)) return left !== right;
    if (operator === ts.SyntaxKind.PlusToken) return left + right;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return left && right;
    if (operator === ts.SyntaxKind.BarBarToken) return left || right;
  }
  return UNKNOWN;
}
function possibleStrings(node, checker, bindings = new Map()) {
  const value = evaluate(node, checker, bindings);
  if (typeof value === 'string') return [value];
  node = unwrap(node);
  if (!node) return [];
  if (ts.isConditionalExpression(node)) return [...new Set([...possibleStrings(node.whenTrue, checker, bindings), ...possibleStrings(node.whenFalse, checker, bindings)])].sort(compare);
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration?.initializer && declaration.initializer !== node) return possibleStrings(declaration.initializer, checker, bindings);
  }
  return [];
}
function safe(value) {
  if (value === UNKNOWN) return { resolution: 'unknown' };
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, safe(nested)]));
  return value;
}
module.exports = { UNKNOWN, unwrap, evaluate, possibleStrings, safe };
