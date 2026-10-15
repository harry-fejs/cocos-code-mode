'use strict';
const { ts, text, tokens, json, compare } = require('./catalog-utils');
function compact(node) {
  if (!node) return null;
  return JSON.parse(tokens(text(node))).map(([, value]) => value).join(' ');
}
function canonicalType(value) {
  return value.replace(/import\("([^\"]+)"\)/g, (_, module) => {
    const normalized = module.replace(/\\/g, '/');
    const segment = normalized.match(/(?:^|\/)((?:cocos|editor|exports|pal|@types)\/.*)$/);
    return `import("${segment ? segment[1] : normalized.split('/').pop()}")`;
  });
}
function typeInfo(checker, type, node) {
  const unresolved = [];
  const seen = new Set();
  const active = new Set();
  const seenSymbols = new Set();
  const references = new Map();
  let count = 0;
  let budgetExceeded = false;
  const visit = current => {
    if (!current) return;
    if (active.has(current)) { unresolved.push({ kind: 'cycle', reference: current.aliasSymbol?.name || current.symbol?.name || 'recursive-type' }); return; }
    if (seen.has(current)) return;
    if (count >= 256) {
      if (!budgetExceeded) unresolved.push({ kind: 'type-budget', reference: 'Type expansion exceeds 256 nodes' });
      budgetExceeded = true;
      return;
    }
    count++;
    seen.add(current);
    active.add(current);
    try {
    if (current.flags & ts.TypeFlags.Any) unresolved.push({ kind: 'any', reference: current.aliasSymbol?.name || current.intrinsicName || 'any' });
    if (current.flags & ts.TypeFlags.Unknown) unresolved.push({ kind: 'unknown', reference: 'unknown' });
    if (current.flags & ts.TypeFlags.NonPrimitive) unresolved.push({ kind: 'opaque-object', reference: 'object' });
    if (current.flags & ts.TypeFlags.BigIntLike) unresolved.push({ kind: 'semantic-adapter-required', reference: 'bigint-type' });
    if (current.flags & ts.TypeFlags.ESSymbolLike) unresolved.push({ kind: 'semantic-adapter-required', reference: 'symbol-type' });
    if (current.flags & ts.TypeFlags.TypeParameter) {
      unresolved.push({ kind: 'type-parameter', reference: current.symbol?.name || checker.typeToString(current) });
      visit(checker.getBaseConstraintOfType(current));
    }
    if (current.flags & ts.TypeFlags.IndexedAccess) {
      unresolved.push({ kind: 'indexed-access', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.objectType);
      visit(current.indexType);
    }
    if (current.flags & ts.TypeFlags.Index) {
      unresolved.push({ kind: 'keyof', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.type);
    }
    if (current.flags & ts.TypeFlags.TemplateLiteral) {
      unresolved.push({ kind: 'template-literal', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      current.types.forEach(visit);
    }
    if (current.flags & ts.TypeFlags.StringMapping) {
      unresolved.push({ kind: 'string-mapping', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.type);
    }
    if (current.flags & ts.TypeFlags.Conditional) {
      unresolved.push({ kind: 'conditional', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      visit(current.checkType);
      visit(current.extendsType);
      // Branches describe declaration dependencies, not a selected or instantiated result.
      const conditional = current.root?.node;
      if (conditional && ts.isConditionalTypeNode(conditional)) {
        visit(checker.getTypeFromTypeNode(conditional.trueType));
        visit(checker.getTypeFromTypeNode(conditional.falseType));
      }
    }
    if (current.flags & ts.TypeFlags.Object && current.objectFlags & ts.ObjectFlags.Mapped) {
      unresolved.push({ kind: 'mapped-type', reference: canonicalType(checker.typeToString(current, node, ts.TypeFormatFlags.NoTruncation)) });
      // Declaration operands are provenance, not proof of instantiated mapped properties.
      const mapped = current.declaration;
      if (mapped && ts.isMappedTypeNode(mapped)) {
        for (const operand of [mapped.typeParameter.constraint, mapped.nameType, mapped.type]) {
          if (operand) visit(checker.getTypeFromTypeNode(operand));
        }
      }
    }
    if (current.isUnionOrIntersection?.()) current.types.forEach(visit);
    if (checker.isArrayType(current) || checker.isTupleType(current)) {
      checker.getTypeArguments(current).forEach(visit);
      return;
    }
    if (current.flags & ts.TypeFlags.Object && current.objectFlags & ts.ObjectFlags.Reference) checker.getTypeArguments(current).forEach(visit);
    if (current.aliasTypeArguments) current.aliasTypeArguments.forEach(visit);
    const symbol = current.aliasSymbol || current.symbol;
    if (current.flags & ts.TypeFlags.Object && (current.objectFlags & ts.ObjectFlags.Class || current.objectFlags & ts.ObjectFlags.Reference && current.target?.objectFlags & ts.ObjectFlags.Class)) {
      unresolved.push({ kind: 'semantic-adapter-required', reference: 'class-instance-type' });
    }
    const callSignatures = checker.getSignaturesOfType(current, ts.SignatureKind.Call);
    const constructSignatures = checker.getSignaturesOfType(current, ts.SignatureKind.Construct);
    if (callSignatures.length) unresolved.push({ kind: 'semantic-adapter-required', reference: 'callable-type' });
    if (constructSignatures.length) unresolved.push({ kind: 'semantic-adapter-required', reference: 'constructable-type' });
    const declaration = symbol?.declarations?.find(item => ts.isInterfaceDeclaration(item) || ts.isTypeAliasDeclaration(item));
    if (declaration && ts.isInterfaceDeclaration(declaration)) {
      for (const base of checker.getBaseTypes(current) || []) visit(base);
    }
    if (symbol && !symbol.name.startsWith('__') && !references.has(symbol.name)) {
      const enumDeclaration = symbol.declarations?.find(ts.isEnumDeclaration);
      references.set(symbol.name, { name: symbol.name, resolution: symbol.declarations?.length ? 'resolved' : 'unknown',
        kind: enumDeclaration ? 'enum' : declaration ? ts.isInterfaceDeclaration(declaration) ? 'interface' : 'type-alias' : 'type-reference',
        enumValues: enumDeclaration ? enumDeclaration.members.map(member => ({ name: member.name.getText(), value: checker.getConstantValue(member) ?? compact(member.initializer) })) : null });
    }
    if (symbol && declaration && !seenSymbols.has(symbol)) {
      seenSymbols.add(symbol);
      if (ts.isTypeAliasDeclaration(declaration) && !declaration.typeParameters?.length) { const underlying = checker.getTypeFromTypeNode(declaration.type); if (underlying !== current) visit(underlying); }
    }
    if (current.flags & ts.TypeFlags.Object && (current.objectFlags & ts.ObjectFlags.Anonymous || declaration)) {
      for (const index of checker.getIndexInfosOfType(current)) {
        visit(index.keyType);
        visit(index.type);
      }
      for (const property of checker.getPropertiesOfType(current)) {
        const propertyDeclaration = property.valueDeclaration || property.declarations?.[0];
        if (property.declarations?.some(item => ts.isGetAccessorDeclaration(item) || ts.isSetAccessorDeclaration(item))) {
          unresolved.push({ kind: 'semantic-adapter-required', reference: 'accessor-property' });
          for (const accessor of property.declarations) {
            if (!ts.isSetAccessorDeclaration(accessor)) continue;
            if (current.objectFlags & ts.ObjectFlags.Reference && current.target !== current && current.target?.typeParameters?.length) {
              unresolved.push({ kind: 'setter-write-type', reference: 'Instantiated setter input requires compiler write-type resolution' });
            } else {
              for (const parameter of accessor.parameters) visit(checker.getTypeAtLocation(parameter));
            }
          }
        }
        const key = propertyDeclaration?.name;
        if (key && ts.isComputedPropertyName(key) && checker.getTypeAtLocation(key.expression).flags & ts.TypeFlags.ESSymbolLike) {
          unresolved.push({ kind: 'semantic-adapter-required', reference: 'symbol-keyed-property' });
        }
        if (propertyDeclaration) visit(checker.getTypeOfSymbolAtLocation(property, propertyDeclaration));
      }
      for (const signature of [...callSignatures, ...constructSignatures]) {
        for (const parameter of signature.typeParameters || []) {
          visit(checker.getBaseConstraintOfType(parameter));
          const declared = parameter.symbol?.declarations?.[0];
          if (declared?.default) visit(checker.getTypeFromTypeNode(declared.default));
        }
        const receiver = signature.thisParameter;
        const receiverDeclaration = receiver?.valueDeclaration || receiver?.declarations?.[0];
        if (receiverDeclaration) visit(checker.getTypeOfSymbolAtLocation(receiver, receiverDeclaration));
        signature.parameters.forEach(parameter => { const parameterDeclaration = parameter.valueDeclaration || parameter.declarations?.[0]; if (parameterDeclaration) visit(checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration)); });
        visit(checker.getReturnTypeOfSignature(signature));
        visit(checker.getTypePredicateOfSignature(signature)?.type);
      }
    }
    } finally { active.delete(current); }
  };
  visit(type);
  if (node) {
    const scan = current => {
      if (ts.isTypeReferenceNode(current)) {
        let symbol = checker.getSymbolAtLocation(current.typeName);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (!symbol || symbol.name === 'unknown' || !symbol.declarations?.length) unresolved.push({ kind: 'reference', reference: compact(current.typeName) });
      }
      if (ts.isTypeNode(current) || current === node) ts.forEachChild(current, scan);
    };
    scan(node);
  }
  const rendered = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
  return { type: canonicalType(rendered), declaredType: node ? compact(node) : null, references: [...references.values()].sort((a, b) => compare(a.name, b.name)),
    unresolved: [...new Map(unresolved.map(item => [json(item), item])).values()].sort((a, b) => compare(json(a), json(b))) };
}
function signatureInfo(checker, signature, declaration, index) {
  const unresolved = [];
  const genericReferences = new Map();
  const receiverSymbol = signature.thisParameter;
  const receiverDeclaration = receiverSymbol?.valueDeclaration || receiverSymbol?.declarations?.[0];
  const receiver = receiverSymbol ? typeInfo(checker, checker.getTypeOfSymbolAtLocation(receiverSymbol, receiverDeclaration || declaration), receiverDeclaration?.type) : null;
  if (receiver) {
    unresolved.push(...receiver.unresolved);
    for (const reference of receiver.references) genericReferences.set(json(reference), reference);
  }
  const parameters = signature.parameters.map((symbol, position) => {
    const parameter = symbol.valueDeclaration || symbol.declarations?.[0] || declaration.parameters?.[position];
    const info = typeInfo(checker, checker.getTypeOfSymbolAtLocation(symbol, parameter || declaration), parameter?.type);
    unresolved.push(...info.unresolved);
    return { name: symbol.name, type: info.type, declaredType: info.declaredType, references: info.references, optional: !!(symbol.flags & ts.SymbolFlags.Optional) || !!parameter?.questionToken || !!parameter?.initializer,
      rest: !!parameter?.dotDotDotToken, defaultExpression: compact(parameter?.initializer), unresolved: info.unresolved };
  });
  const result = typeInfo(checker, checker.getReturnTypeOfSignature(signature), declaration.type);
  unresolved.push(...result.unresolved);
  const nativePredicate = checker.getTypePredicateOfSignature(signature);
  const predicateInfo = nativePredicate?.type ? typeInfo(checker, nativePredicate.type, declaration.type?.type) : null;
  const predicate = nativePredicate ? {
    kind: ts.TypePredicateKind[nativePredicate.kind],
    parameterName: nativePredicate.parameterName ?? null,
    parameterIndex: nativePredicate.parameterIndex ?? null,
    type: predicateInfo,
  } : null;
  if (predicateInfo) {
    unresolved.push(...predicateInfo.unresolved);
    for (const reference of predicateInfo.references) genericReferences.set(json(reference), reference);
  }
  const typeParameters = (signature.typeParameters || []).map(parameter => {
    const constraint = checker.getBaseConstraintOfType(parameter);
    const info = constraint ? typeInfo(checker, constraint) : null;
    const declared = parameter.symbol?.declarations?.[0];
    const defaultInfo = declared?.default ? typeInfo(checker, checker.getTypeFromTypeNode(declared.default), declared.default) : null;
    for (const value of [info, defaultInfo]) {
      if (!value) continue;
      unresolved.push(...value.unresolved);
      for (const reference of value.references) genericReferences.set(json(reference), reference);
    }
    return { name: parameter.symbol?.name || checker.typeToString(parameter), constraint: info?.type || null, default: compact(declared?.default) };
  });
  return { overload: index, kind: ts.isSetAccessorDeclaration(declaration) ? 'set' : ts.isGetAccessorDeclaration(declaration) ? 'get' : 'call',
    text: checker.signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation), typeParameters, parameters, receiver, predicate,
    returnType: result.type, declaredReturnType: result.declaredType, returnReferences: result.references,
    references: [...genericReferences.values()].sort((a, b) => compare(json(a), json(b))), unresolved };
}
function signatures(checker, symbol, declaration) {
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const constructs = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  if (calls.length || constructs.length) return [...calls, ...constructs].map((sig, i) => {
    const row = signatureInfo(checker, sig, sig.getDeclaration() || declaration, i);
    if (i >= calls.length) row.kind = 'construct';
    return row;
  });
  const accessors = (symbol.declarations || []).filter(d => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d));
  if (accessors.length) return accessors.map((decl, i) => signatureInfo(checker, checker.getSignatureFromDeclaration(decl), decl, i));
  const info = typeInfo(checker, type, declaration.type);
  return [{ overload: 0, kind: 'value', type: info.type, declaredType: info.declaredType, references: info.references,
    defaultExpression: compact(declaration.initializer), unresolved: info.unresolved }];
}
function metadata(node) {
  const tags = ts.getJSDocTags(node).map(tag => tag.tagName.text);
  const decorators = (ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : []).map(decorator => compact(decorator.expression));
  const modifiers = (ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : []).map(modifier => ts.tokenToString(modifier.kind)).filter(Boolean);
  const visibility = node.name && ts.isPrivateIdentifier(node.name) || modifiers.includes('private') ? 'private' : modifiers.includes('protected') ? 'protected' : 'public';
  return { decorators, visibility, static: modifiers.includes('static'), readonly: modifiers.includes('readonly') || ts.isGetAccessorDeclaration(node) && !node.symbol?.declarations?.some(ts.isSetAccessorDeclaration),
    internal: tags.includes('internal') || tags.includes('engineInternal') || tags.includes('private') || !!node.name?.getText().startsWith('__'), deprecated: tags.includes('deprecated'),
    abstract: modifiers.includes('abstract'), jsdoc: (node.jsDoc || []).map(doc => doc.getText()).join('\n') || null };
}
function constraints(node, context) {
  const sf = node.getSourceFile();
  const constants = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'internal:constants' && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      constants.push(...statement.importClause.namedBindings.elements.map(item => item.name.text));
    }
  }
  const guards = [];
  const scan = current => {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) {
      const condition = compact(current.condition || current.expression);
      if (constants.some(name => new RegExp(`\\b${name}\\b`).test(condition))) guards.push(condition);
    }
    ts.forEachChild(current, scan);
  };
  scan(node);
  const overrides = (context.config?.moduleOverrides || []).filter(item => Object.keys(item.overrides || {}).some(file => file === context.path)).map(item => ({ test: item.test, replacement: item.overrides[context.path] }));
  return { execution: context.namespace === 'engine-runtime' ? ['game-runtime'] : ['edit-scene'], targetAvailable: 'unknown',
    features: context.features || [], importedConstants: constants.sort(compare), guards: [...new Set(guards)].sort(compare), moduleOverrides: overrides,
    editModeDeclared: metadata(node).decorators.some(value => /executeInEditMode/.test(value)), jsonTransfer: 'named-reference-or-value-dto-required' };
}
module.exports = { compact, typeInfo, signatureInfo, signatures, metadata, constraints };
