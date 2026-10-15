'use strict';
const { ts, fs, path, compare, json, source, slash, finalize } = require('./catalog-utils');
const { resolveAlias, moduleRoots, createProgram, declarationRoots, ambientModules, diagnosticRow } = require('./compiler-inputs');
const { signatures, metadata, constraints, compact, typeInfo } = require('./type-metadata');
function kind(node) {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isModuleDeclaration(node) || ts.isSourceFile(node)) return 'namespace';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isFunctionDeclaration(node)) return 'method';
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'accessor';
  return 'property';
}
function collectExports(input, version, roots, label = 'engine') {
  const records = new Map();
  const unknowns = [];
  const { checker, root } = input;
  function record(symbol, declaration, context, className, member, inheritedFrom = null) {
    const info = metadata(declaration);
    for (const part of symbol.declarations || []) {
      if (part === declaration) continue;
      const merged = metadata(part);
      info.internal = info.internal || merged.internal;
      info.deprecated = info.deprecated || merged.deprecated;
    }
    const ownerMetadata = member ? metadata(declaration.parent) : info;
    if (member && declaration.parent.name) {
      const ownerSymbol = checker.getSymbolAtLocation(declaration.parent.name);
      for (const part of ownerSymbol?.declarations || []) {
        const merged = metadata(part);
        ownerMetadata.internal = ownerMetadata.internal || merged.internal;
        ownerMetadata.deprecated = ownerMetadata.deprecated || merged.deprecated;
      }
    }
    info.internal = info.internal || ownerMetadata.internal || !context.publicExport;
    info.deprecated = info.deprecated || ownerMetadata.deprecated || !!context.deprecated;
    let sigs;
    if (['interface', 'type', 'enum'].includes(kind(declaration)) && !member) {
      const value = typeInfo(checker, checker.getDeclaredTypeOfSymbol(symbol), ts.isInterfaceDeclaration(declaration) ? declaration : declaration.type);
      sigs = [{ overload: 0, kind: 'value', type: value.type, declaredType: value.declaredType, references: value.references, unresolved: value.unresolved }];
    } else sigs = signatures(checker, symbol, declaration);
    const unresolved = [...new Map(sigs.flatMap(signature => signature.unresolved).map(item => [json(item), item])).values()].sort((a, b) => compare(json(a), json(b)));
    const inheritedName = inheritedFrom?.name?.getText() || null;
    const owner = member ? declaration.parent : declaration;
    const heritage = (owner.heritageClauses || []).flatMap(clause => clause.types.map(type => ({ relation: ts.tokenToString(clause.token), type: compact(type) })));
    for (const clause of owner.heritageClauses || []) for (const type of clause.types) {
      const resolved = typeInfo(checker, checker.getTypeAtLocation(type), type);
      unresolved.push(...resolved.unresolved);
    }
    const row = finalize({ version, namespace: context.namespace, module: context.module, className, member: member || null,
      name: member || className, kind: kind(declaration), signatures: sigs, ...info, inheritance: heritage, inheritedFrom: inheritedName,
      aliases: symbol.name !== className && !member ? [symbol.name, className] : [], declaredClassName: owner.name?.getText() || null,
      enumValues: ts.isEnumDeclaration(declaration) ? sigs[0].references.find(reference => reference.name === symbol.name && reference.kind === 'enum')?.enumValues ?? null : null,
      backingFields: ['accessor', 'property'].includes(kind(declaration)) ? [...new Set((compact(declaration) || '').match(/this\s*\.\s*_[A-Za-z0-9_$]+/g) || [])].map(value => value.replace(/\s/g, '').slice(5)) : [],
      source: source(declaration, root, label), exportedFrom: [context.exportPath], domain: context.domain,
      evidenceStatus: unresolved.length ? 'declared' : 'signatureResolved', contextConstraints: constraints(declaration, { ...context, config: input.config, path: slash(path.relative(root, declaration.getSourceFile().fileName)) }),
      unresolved, discovered: true, permitted: false, publicExport: context.publicExport && info.visibility === 'public' && !info.internal,
      evidence: [{ kind: label === 'engine' ? 'source-export' : 'declaration', path: context.exportPath, alias: className }] });
    const key = row.semanticKey;
    const existing = records.get(key);
    if (!existing) records.set(key, row);
    else {
      existing.exportedFrom = [...new Set([...existing.exportedFrom, ...row.exportedFrom])].sort(compare);
      existing.contextConstraints.features = [...new Set([...existing.contextConstraints.features, ...row.contextConstraints.features])].sort(compare);
      existing.evidence = [...new Map([...existing.evidence, ...row.evidence].map(item => [json(item), item])).values()];
      finalize(existing);
    }
  }
  function visit(exported, context, prefix = '', ancestors = new Set()) {
    const symbol = resolveAlias(checker, exported);
    const name = prefix ? `${prefix}.${exported.name}` : exported.name;
    if (!symbol?.declarations?.length) { unknowns.push({ namespace: context.namespace, module: context.module, name, kind: 'export', reference: exported.name, path: context.exportPath, reason: 'Unresolved export alias or declaration' }); return; }
    if (ancestors.has(symbol)) return;
    const declaration = symbol.valueDeclaration || symbol.declarations[0];
    const declaredKind = kind(declaration);
    const internal = symbol.declarations.some(part => metadata(part).internal);
    const deprecated = !!context.deprecated || symbol.declarations.some(part => metadata(part).deprecated);
    const local = { ...context, deprecated, publicExport: context.publicExport && !internal && !/^__private(?:\.|$)/.test(name) };
    record(symbol, declaration, local, name, null);
    if (declaredKind === 'namespace' || symbol.flags & ts.SymbolFlags.Module) {
      const next = new Set([...ancestors, symbol]);
      for (const child of checker.getExportsOfModule(symbol).sort((a, b) => compare(a.name, b.name))) visit(child, local, name, next);
    }
    if (declaredKind === 'class' || declaredKind === 'interface') {
      const instance = checker.getDeclaredTypeOfSymbol(symbol);
      const members = new Map(checker.getPropertiesOfType(instance).map(item => [item.name, item]));
      for (const declared of symbol.declarations) for (const member of declared.members || []) {
        const memberSymbol = member.name && checker.getSymbolAtLocation(member.name);
        if (memberSymbol && !(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static)) members.set(memberSymbol.name, memberSymbol);
      }
      for (const child of [...members.values()].sort((a, b) => compare(a.name, b.name))) {
        const decl = child.valueDeclaration || child.declarations?.[0];
        if (decl) record(child, decl, local, name, child.name, decl.parent !== declaration ? decl.parent : null);
      }
      if (symbol.valueDeclaration) {
        const constructor = checker.getTypeOfSymbolAtLocation(symbol, declaration);
        for (const child of checker.getPropertiesOfType(constructor).sort((a, b) => compare(a.name, b.name))) {
          const decl = child.valueDeclaration || child.declarations?.[0];
          if (decl && ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Static) record(child, decl, local, name, child.name);
        }
      }
      const baseTypes = checker.getBaseTypes(instance) || [];
      for (const base of baseTypes) {
        if (base.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) unknowns.push({ namespace: local.namespace, module: local.module, name, kind: 'inheritance', reference: checker.typeToString(base), reason: 'Base type resolution is unknown' });
      }
    }
  }
  for (const context of roots) {
    let symbol = context.symbol;
    if (!symbol) {
      const sf = input.program.getSourceFile(context.file);
      symbol = sf && checker.getSymbolAtLocation(sf);
    }
    if (!symbol) { unknowns.push({ kind: 'module', reference: context.file, reason: 'Export module symbol unavailable' }); continue; }
    const env = { ...context, exportPath: context.file ? slash(path.relative(root, context.file)) : context.module, publicExport: true };
    for (const exported of checker.getExportsOfModule(symbol).sort((a, b) => compare(a.name, b.name))) visit(exported, env);
  }
  return { records: [...records.values()].sort((a, b) => compare(a.id, b.id)), unknowns };
}
function extractEngine(input, version) { return collectExports(input, version, moduleRoots(input)); }
function extractDeclarations(root, version) {
  const roots = declarationRoots(root);
  const input = { ...createProgram(root, roots, { types: [], module: ts.ModuleKind.CommonJS }), root, config: {} };
  const modules = ambientModules(input.program, input.checker).map(symbol => {
    const module = symbol.name.slice(1, -1);
    return { symbol, module, namespace: module === 'cc' ? 'engine-runtime' : 'engine-authoring', domain: 'declarations', features: [] };
  });
  const result = collectExports(input, version, modules, 'declarations');
  result.diagnostics = [...input.diagnostics, ...input.program.getSyntacticDiagnostics()].map(item => diagnosticRow(item, root, 'declarations'));
  return result;
}
function attachDeclarations(records, declarations) {
  const matches = new Map(declarations.map(record => [record.semanticKey, record]));
  const used = new Set();
  for (const record of records) {
    const declared = matches.get(record.semanticKey);
    if (!declared) continue;
    used.add(record.semanticKey);
    record.declarationEvidence = { source: declared.source, signatures: declared.signatures, evidenceStatus: declared.evidenceStatus,
      agreement: record.signatureHash === declared.signatureHash ? 'matching' : 'different', provenance: 'explicit-input-not-stock-qualification' };
  }
  for (const declared of declarations) if (!used.has(declared.semanticKey)) {
    declared.contextConstraints.sourceAvailability = 'declaration-only';
    declared.domain = 'declarations';
    records.push(finalize(declared));
  }
  return records;
}
module.exports = { extractEngine, extractDeclarations, attachDeclarations, collectExports };
