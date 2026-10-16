#!/usr/bin/env node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { builtinModules, isBuiltin } from 'node:module';
import { API } from 'typescript/unstable/sync';
import {
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportExpression,
  isImportEqualsDeclaration,
  isMetaProperty,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
} from 'typescript/unstable/ast/is';
import { SyntaxKind } from 'typescript/unstable/ast';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(ROOT, 'src');
const TSCONFIG = resolve(ROOT, 'tsconfig.json');
const API_VERSION = '7.0.2';
const REVIEWED_WORKER_AST = Object.freeze({
  packageWorkerPaths: '49ccb32eec82a150fd9ff4e20027471db9013301836b554d64ad6c090234087c',
  trustedEnvironment: 'e1bafaa5693eab40777b90012c490f9a9e860261635c4d63ae70a19f3455d8a5',
  spawnWorker: '3882364368d8562744ed2c519188bb16dbf64698c58a639e713e2cfe430e02d3',
});
const NETWORK_MODULES = new Set([
  'http',
  'http2',
  'https',
  'net',
  'tls',
  'dns',
  'dgram',
  'undici',
  'node:undici',
]);
const BUILTIN_NAMES = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
const ALLOWED_BUILTINS = new Set([
  'node:crypto',
  'node:module',
  'node:path',
  'node:perf_hooks',
  'node:timers/promises',
  'node:url',
  'node:util',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
]);
const FS_MODULES = new Set(['node:fs', 'node:fs/promises']);
const IO_ROLES = [
  'src/application/',
  'src/cli/',
  'src/config/',
  'src/discovery/',
  'src/indicators/',
  'src/parser/worker.ts',
];
const PROCESS_ROLES = [...IO_ROLES, 'src/parser/adapter.ts', 'src/bin.ts'];
const CREATE_REQUIRE_OWNERS = new Set(['src/application/envelope.ts', 'src/parser/worker.ts']);
const EXTERNALS = new Set([
  'commander',
  'picomatch',
  'smol-toml',
  'zod',
  '@nomicfoundation/slang/cst',
  '@nomicfoundation/slang/compilation',
  '@nomicfoundation/slang/parser',
  '@nomicfoundation/slang/utils',
]);
const SLANG_OWNERS = new Set([
  'src/parser/bindings.ts',
  'src/parser/extract-syntax.ts',
  'src/parser/worker.ts',
]);
const PURE_ROOTS = ['src/domain/', 'src/estimation/', 'src/metrics/', 'src/reporting/'];
const PURE_DEPENDENCIES = Object.freeze({
  'src/domain/': ['src/domain/', 'src/version.ts'],
  'src/estimation/': ['src/estimation/', 'src/domain/', 'src/version.ts'],
  'src/metrics/': ['src/metrics/', 'src/domain/', 'src/parser/protocol.ts', 'src/version.ts'],
  'src/reporting/': ['src/reporting/', 'src/domain/', 'src/version.ts'],
});
const SAFE_GLOBALS = new Set(['eval', 'Function', 'fetch', 'WebSocket']);

function relativeName(path) {
  return relative(ROOT, path).split(sep).join('/');
}

function sourceName(path) {
  const parts = resolve(path).split(sep);
  const sourceIndex = parts.lastIndexOf('src');
  return sourceIndex < 0 ? relativeName(path) : parts.slice(sourceIndex).join('/');
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== '..');
}

function walk(node, callback) {
  callback(node);
  node.forEachChild((child) => walk(child, callback));
}

function fingerprintFunction(sourceFile, name) {
  let target;
  walk(sourceFile, (node) => {
    if (
      isFunctionLikeDeclaration(node) &&
      node.name !== undefined &&
      isIdentifier(node.name) &&
      node.name.text === name
    )
      target = node;
  });
  if (target === undefined) return undefined;
  const records = [];
  const collect = (node) => {
    const children = [];
    node.forEachChild((child) => children.push(child));
    records.push(children.length === 0 ? `${node.kind}:${node.getText()}` : String(node.kind));
    for (const child of children) collect(child);
  };
  collect(target);
  return createHash('sha256').update(records.join('\n'), 'utf8').digest('hex');
}

function workerAstFingerprints(sourceFile) {
  return Object.fromEntries(
    Object.keys(REVIEWED_WORKER_AST).map((name) => [name, fingerprintFunction(sourceFile, name)]),
  );
}

function matchesReviewedWorkerAst(sourceFile) {
  const actual = workerAstFingerprints(sourceFile);
  return Object.entries(REVIEWED_WORKER_AST).every(([name, expected]) => actual[name] === expected);
}

function literalText(node) {
  return node !== undefined && isStringLiteral(node) ? node.text : undefined;
}

function propertyName(node) {
  return isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
}

function parentIsName(node) {
  const parent = node.parent;
  return (
    (isPropertyAccessExpression(parent) && parent.name === node) ||
    (isPropertyAssignment(parent) && parent.name === node) ||
    (isVariableDeclaration(parent) && parent.name === node)
  );
}

function hasRuntimeImport(statement) {
  const clause = statement.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined || clause.namedBindings === undefined) return true;
  if (isIdentifier(clause.namedBindings)) return true;
  if (Array.isArray(clause.namedBindings.elements)) {
    return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

function hasRuntimeExport(statement) {
  if (statement.isTypeOnly) return false;
  const clause = statement.exportClause;
  if (clause === undefined) return true;
  if (Array.isArray(clause.elements)) return clause.elements.some((element) => !element.isTypeOnly);
  return true;
}

function importSpecifier(statement) {
  return literalText(statement.moduleSpecifier);
}

function normalizedBuiltin(moduleName) {
  const bareName = moduleName.replace(/^node:/u, '');
  if (!isBuiltin(moduleName) || !BUILTIN_NAMES.has(bareName)) return undefined;
  return `node:${bareName}`;
}

function isNetworkModule(moduleName) {
  if (NETWORK_MODULES.has(moduleName)) return true;
  const builtin = normalizedBuiltin(moduleName);
  return (
    builtin !== undefined &&
    NETWORK_MODULES.has(builtin.replace(/^node:/u, '').split('/')[0] ?? builtin)
  );
}

function resolveRelativeModule(from, specifier, files) {
  const candidate = resolve(dirname(from), specifier);
  const options =
    extname(candidate) === ''
      ? [candidate, `${candidate}.ts`, join(candidate, 'index.ts')]
      : [candidate];
  return options.find((path) => files.has(path));
}

function addDiagnostic(errors, code, file, node, message) {
  const line = node?.getSourceFile?.().getLineAndCharacterOfPosition?.(node.getStart())?.line;
  errors.add(
    `${code}: ${relativeName(file)}${line === undefined ? '' : `:${line + 1}`}: ${message}`,
  );
}

function importBindings(sourceFile, file, errors) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || !hasRuntimeImport(statement)) continue;
    const specifier = importSpecifier(statement);
    if (specifier === undefined) {
      addDiagnostic(
        errors,
        'unresolved-import',
        file,
        statement,
        'runtime import has no literal module',
      );
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined)
      bindings.set(clause.name.text, { module: specifier, imported: 'default' });
    const namedBindings = clause.namedBindings;
    if (namedBindings === undefined || isIdentifier(namedBindings)) continue;
    if (Array.isArray(namedBindings.elements)) {
      for (const element of namedBindings.elements) {
        if (element.isTypeOnly) continue;
        bindings.set(element.name.text, {
          module: specifier,
          imported: element.propertyName?.text ?? element.name.text,
        });
      }
    } else {
      bindings.set(namedBindings.name.text, { module: specifier, imported: '*' });
    }
  }
  return bindings;
}

function moduleOwnerAllowed(moduleName, path, bindings, errors, statement) {
  const owner = sourceName(path);
  if (isNetworkModule(moduleName)) {
    addDiagnostic(
      errors,
      'network-import',
      path,
      statement,
      `network module '${moduleName}' is forbidden`,
    );
    return;
  }
  const builtin = normalizedBuiltin(moduleName);
  if (
    builtin !== undefined &&
    FS_MODULES.has(builtin) &&
    !IO_ROLES.some((prefix) => owner.startsWith(prefix))
  ) {
    addDiagnostic(
      errors,
      'pure-io-import',
      path,
      statement,
      `filesystem import '${moduleName}' is outside an I/O role`,
    );
    return;
  }
  if (builtin === 'node:child_process') {
    const names = [...bindings.values()].filter(
      (item) => normalizedBuiltin(item.module) === builtin,
    );
    if (owner !== 'src/parser/adapter.ts' || names.length !== 1 || names[0]?.imported !== 'spawn') {
      addDiagnostic(
        errors,
        'child-process-import',
        path,
        statement,
        'child process access is allowed only for the fixed parser worker adapter',
      );
    }
    return;
  }
  if (builtin === 'node:module') {
    const names = [...bindings.values()].filter(
      (item) => normalizedBuiltin(item.module) === builtin,
    );
    if (
      !CREATE_REQUIRE_OWNERS.has(owner) ||
      names.length !== 1 ||
      names[0]?.imported !== 'createRequire'
    ) {
      addDiagnostic(
        errors,
        'module-loader-import',
        path,
        statement,
        'createRequire is restricted to package-owned metadata resolution',
      );
    }
    return;
  }
  if (moduleName.startsWith('node:') && builtin === undefined) {
    addDiagnostic(
      errors,
      'unknown-builtin',
      path,
      statement,
      `runtime builtin '${moduleName}' is not inventoried`,
    );
    return;
  }
  if (builtin !== undefined) {
    if (!ALLOWED_BUILTINS.has(builtin)) {
      addDiagnostic(
        errors,
        'unknown-builtin',
        path,
        statement,
        `runtime builtin '${moduleName}' is not inventoried`,
      );
      return;
    }
    const pureRoot = PURE_ROOTS.find((prefix) => owner.startsWith(prefix));
    if (pureRoot !== undefined && builtin !== 'node:crypto') {
      addDiagnostic(
        errors,
        'pure-builtin-boundary',
        path,
        statement,
        `builtin '${moduleName}' is outside the pure capability map`,
      );
    }
  }
  if (
    builtin === undefined &&
    !moduleName.startsWith('.') &&
    !moduleName.startsWith('node:') &&
    !EXTERNALS.has(moduleName)
  ) {
    addDiagnostic(
      errors,
      'unknown-package',
      path,
      statement,
      `external package '${moduleName}' is not inventoried`,
    );
  }
  if (moduleName.startsWith('@nomicfoundation/slang/') && !SLANG_OWNERS.has(owner)) {
    addDiagnostic(
      errors,
      'parser-package-boundary',
      path,
      statement,
      'Slang imports are confined to the reviewed parser worker implementation files',
    );
  }
  if (moduleName === 'commander' && !owner.startsWith('src/cli/')) {
    addDiagnostic(
      errors,
      'cli-package-boundary',
      path,
      statement,
      'CLI package imports are confined to CLI files',
    );
  }
  if (moduleName === 'zod' && !owner.startsWith('src/domain/')) {
    addDiagnostic(
      errors,
      'schema-package-boundary',
      path,
      statement,
      'Zod is confined to domain schema modules',
    );
  }
  if (['picomatch', 'smol-toml'].includes(moduleName) && !owner.startsWith('src/discovery/')) {
    addDiagnostic(
      errors,
      'discovery-package-boundary',
      path,
      statement,
      `package '${moduleName}' is confined to discovery`,
    );
  }
}

function metaUrl(node) {
  return (
    isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    isMetaProperty(node.expression) &&
    node.expression.keywordToken === SyntaxKind.ImportKeyword
  );
}

function functionScoped(node) {
  let parent = node.parent;
  while (parent !== undefined) {
    if (isFunctionLikeDeclaration(parent)) return true;
    parent = parent.parent;
  }
  return false;
}

function enclosingFunctionName(node) {
  let parent = node.parent;
  while (parent !== undefined) {
    if (isFunctionLikeDeclaration(parent)) {
      return parent.name !== undefined && isIdentifier(parent.name) ? parent.name.text : undefined;
    }
    parent = parent.parent;
  }
  return undefined;
}

function getObjectProperty(object, name) {
  if (object === undefined || !isObjectLiteralExpression(object)) return undefined;
  return object.properties.find(
    (property) => isPropertyAssignment(property) && propertyName(property.name) === name,
  );
}

function isFalseLiteral(node) {
  return node?.kind === SyntaxKind.FalseKeyword;
}

function isStringArray(node, expected) {
  return (
    node !== undefined &&
    isArrayLiteralExpression(node) &&
    node.elements.length === expected.length &&
    node.elements.every((element, index) => literalText(element) === expected[index])
  );
}

function hasFixedWorkerResolver(sourceFile) {
  let packageEntry = false;
  let workerPath = false;
  let packageRoot = false;
  walk(sourceFile, (node) => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isMetaProperty(node.expression.expression) &&
      node.expression.expression.keywordToken === SyntaxKind.ImportKeyword &&
      node.expression.name.text === 'resolve' &&
      node.arguments.length === 1 &&
      literalText(node.arguments[0]) === 'audit-estimator'
    ) {
      packageEntry = true;
    }
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.length === 2 &&
      isIdentifier(node.arguments[1]) &&
      node.arguments[1].text === 'packageEntry'
    ) {
      const relativePath = literalText(node.arguments[0]);
      if (relativePath === './parser/worker.js') workerPath = true;
      if (relativePath === '../') packageRoot = true;
    }
  });
  return packageEntry && workerPath && packageRoot;
}

function hasFixedWorkerHeap(sourceFile) {
  let fixed = false;
  walk(sourceFile, (node) => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === 'WORKER_HEAP_MIB' &&
      node.initializer?.kind === SyntaxKind.NumericLiteral &&
      node.initializer.text === '64'
    )
      fixed = true;
  });
  return fixed;
}

function hasTrustedEnvironment(sourceFile) {
  let foundFunction = false;
  let fixedEnvironment = false;
  let fixedWindowsKeys = false;
  let usesWindowsCondition = false;
  let indexedEnvironmentRead = false;
  let returnsEnvironment = false;
  let unsafeSpread = false;
  let unexpectedEnvironmentAccess = false;
  const windowsKeys = ['SystemRoot', 'WINDIR', 'PATH', 'ComSpec', 'PATHEXT'];

  walk(sourceFile, (node) => {
    if (
      isFunctionLikeDeclaration(node) &&
      node.name !== undefined &&
      isIdentifier(node.name) &&
      node.name.text === 'trustedEnvironment'
    ) {
      foundFunction = true;
      walk(node, (inner) => {
        if (node !== inner && inner.kind === SyntaxKind.SpreadAssignment) unsafeSpread = true;
        if (
          isVariableDeclaration(inner) &&
          isIdentifier(inner.name) &&
          inner.name.text === 'environment' &&
          inner.initializer !== undefined &&
          isObjectLiteralExpression(inner.initializer)
        ) {
          const properties = inner.initializer.properties;
          fixedEnvironment =
            properties.length === 3 &&
            literalText(getObjectProperty(inner.initializer, 'LANG')?.initializer) === 'C' &&
            literalText(getObjectProperty(inner.initializer, 'LC_ALL')?.initializer) === 'C' &&
            literalText(getObjectProperty(inner.initializer, 'TZ')?.initializer) === 'UTC';
        }
        if (isArrayLiteralExpression(inner) && isStringArray(inner, windowsKeys))
          fixedWindowsKeys = true;
        if (
          isPropertyAccessExpression(inner) &&
          isIdentifier(inner.expression) &&
          inner.expression.text === 'process' &&
          inner.name.text === 'platform'
        ) {
          let ancestor = inner.parent;
          while (
            ancestor !== undefined &&
            ancestor !== node &&
            ancestor.kind !== SyntaxKind.IfStatement
          )
            ancestor = ancestor.parent;
          if (ancestor !== undefined && ancestor !== node && ancestor.getText().includes("'win32'"))
            usesWindowsCondition = true;
        }
        if (
          isElementAccessExpression(inner) &&
          isPropertyAccessExpression(inner.expression) &&
          isIdentifier(inner.expression.expression) &&
          inner.expression.expression.text === 'process' &&
          inner.expression.name.text === 'env'
        ) {
          indexedEnvironmentRead =
            isIdentifier(inner.argumentExpression) && inner.argumentExpression.text === 'key';
          if (!indexedEnvironmentRead) unexpectedEnvironmentAccess = true;
        }
        if (
          isPropertyAccessExpression(inner) &&
          isIdentifier(inner.expression) &&
          inner.expression.text === 'process' &&
          inner.name.text === 'env' &&
          !(
            inner.parent &&
            isElementAccessExpression(inner.parent) &&
            inner.parent.expression === inner
          )
        ) {
          unexpectedEnvironmentAccess = true;
        }
        if (
          inner.kind === SyntaxKind.ReturnStatement &&
          isIdentifier(inner.expression) &&
          inner.expression.text === 'environment'
        ) {
          returnsEnvironment = true;
        }
      });
    }
  });
  return (
    foundFunction &&
    fixedEnvironment &&
    fixedWindowsKeys &&
    usesWindowsCondition &&
    indexedEnvironmentRead &&
    returnsEnvironment &&
    !unsafeSpread &&
    !unexpectedEnvironmentAccess
  );
}

function hasFixedSlangMetadata(sourceFile, imports) {
  let resolver = false;
  let metadataUrl = false;
  const requireNames = new Set();
  walk(sourceFile, (node) => {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCallExpression(node.initializer) &&
      isIdentifier(node.initializer.expression) &&
      normalizedBuiltin(imports.get(node.initializer.expression.text)?.module ?? '') ===
        'node:module' &&
      imports.get(node.initializer.expression.text)?.imported === 'createRequire' &&
      node.initializer.arguments.length === 1 &&
      metaUrl(node.initializer.arguments[0])
    ) {
      requireNames.add(node.name.text);
    }
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.name.text === 'resolve' &&
      node.arguments.length === 1 &&
      literalText(node.arguments[0]) === '@nomicfoundation/slang' &&
      requireNames.has(node.expression.expression.text)
    ) {
      resolver = true;
    }
    if (
      isNewExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.length === 2 &&
      literalText(node.arguments[0]) === '../package.json' &&
      isCallExpression(node.arguments[1]) &&
      isIdentifier(node.arguments[1].expression) &&
      normalizedBuiltin(imports.get(node.arguments[1].expression.text)?.module ?? '') ===
        'node:url' &&
      imports.get(node.arguments[1].expression.text)?.imported === 'pathToFileURL' &&
      node.arguments[1].arguments.length === 1 &&
      isIdentifier(node.arguments[1].arguments[0])
    ) {
      metadataUrl = true;
    }
  });
  return resolver && metadataUrl;
}

function rootIdentifier(node) {
  let current = node;
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current))
    current = current.expression;
  return isIdentifier(current) ? current.text : undefined;
}

function isExactPackageResolveReference(node) {
  const property = node.parent;
  if (
    !isPropertyAccessExpression(property) ||
    property.expression !== node ||
    property.name.text !== 'resolve'
  ) {
    return false;
  }
  const call = property.parent;
  return (
    isCallExpression(call) &&
    call.expression === property &&
    call.arguments.length === 1 &&
    literalText(call.arguments[0]) === '@nomicfoundation/slang'
  );
}

function sourceRootFor(files) {
  const first = files.keys().next().value;
  if (first === undefined) return SOURCE_ROOT;
  const parts = resolve(first).split(sep);
  const index = parts.lastIndexOf('src');
  return index < 0 ? SOURCE_ROOT : parts.slice(0, index + 1).join(sep) || sep;
}

function analyzeSource(sourceFile, file, files, sourceRoot, errors, edges) {
  const owner = sourceName(file);
  const imports = importBindings(sourceFile, file, errors);
  const createRequireAliases = new Set();
  const aliases = new Map();
  const importedRuntimeSymbols = [...imports.entries()];
  const fixedWorkerResolver =
    owner === 'src/parser/adapter.ts' &&
    hasFixedWorkerResolver(sourceFile) &&
    hasFixedWorkerHeap(sourceFile);
  const trustedEnv = owner === 'src/parser/adapter.ts' && hasTrustedEnvironment(sourceFile);
  const reviewedWorkerAst =
    owner === 'src/parser/adapter.ts' && matchesReviewedWorkerAst(sourceFile);
  if (owner === 'src/parser/adapter.ts' && !fixedWorkerResolver) {
    addDiagnostic(
      errors,
      'worker-path-resolution',
      file,
      sourceFile,
      'packageWorkerPaths must resolve the literal package-owned worker and package root',
    );
  }
  if (owner === 'src/parser/adapter.ts' && !trustedEnv) {
    addDiagnostic(
      errors,
      'worker-environment',
      file,
      sourceFile,
      'trustedEnvironment must construct the reviewed allowlisted child environment',
    );
  }
  if (owner === 'src/parser/adapter.ts' && !reviewedWorkerAst) {
    addDiagnostic(
      errors,
      'worker-ast-fingerprint',
      file,
      sourceFile,
      'packageWorkerPaths, trustedEnvironment and spawnWorker must match their reviewed TypeScript AST fingerprints',
    );
  }
  if (CREATE_REQUIRE_OWNERS.has(owner) && !hasFixedSlangMetadata(sourceFile, imports)) {
    addDiagnostic(
      errors,
      'package-metadata-resolution',
      file,
      sourceFile,
      'metadata reads must resolve the literal Slang package and its package.json',
    );
  }

  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement) && hasRuntimeImport(statement)) {
      const specifier = importSpecifier(statement);
      if (specifier !== undefined) {
        moduleOwnerAllowed(specifier, file, imports, errors, statement);
        if (specifier.startsWith('.')) {
          const target = resolveRelativeModule(file, specifier, files);
          if (target === undefined || !isWithin(sourceRoot, target)) {
            addDiagnostic(
              errors,
              'unresolved-relative-import',
              file,
              statement,
              `cannot resolve trusted relative import '${specifier}'`,
            );
          } else {
            edges.set(file, [...(edges.get(file) ?? []), target]);
          }
        }
      }
    } else if (
      isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      hasRuntimeExport(statement)
    ) {
      const specifier = importSpecifier(statement);
      if (specifier === undefined) {
        addDiagnostic(
          errors,
          'unresolved-reexport',
          file,
          statement,
          'runtime re-export has no literal module',
        );
      } else {
        moduleOwnerAllowed(specifier, file, imports, errors, statement);
        if (specifier.startsWith('.')) {
          const target = resolveRelativeModule(file, specifier, files);
          if (target === undefined || !isWithin(sourceRoot, target)) {
            addDiagnostic(
              errors,
              'unresolved-relative-import',
              file,
              statement,
              `cannot resolve trusted re-export '${specifier}'`,
            );
          } else {
            edges.set(file, [...(edges.get(file) ?? []), target]);
          }
        }
      }
    }
  }

  walk(sourceFile, (node) => {
    if (isCallExpression(node) && isImportExpression(node.expression)) {
      const argument = node.arguments[0];
      const code = isStringLiteral(argument) ? 'dynamic-import' : 'computed-import';
      addDiagnostic(errors, code, file, node, 'runtime dynamic module loading is unsupported');
    }

    if (isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      addDiagnostic(
        errors,
        'import-equals',
        file,
        node,
        'runtime import-equals loading is unsupported',
      );
    }

    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression;
      const imported = isIdentifier(callee) ? imports.get(callee.text) : undefined;
      if (
        normalizedBuiltin(imported?.module ?? '') === 'node:module' &&
        imported.imported === 'createRequire'
      ) {
        if (
          !CREATE_REQUIRE_OWNERS.has(owner) ||
          node.name.text !== 'require' ||
          node.initializer.arguments.length !== 1 ||
          !metaUrl(node.initializer.arguments[0])
        ) {
          addDiagnostic(
            errors,
            'create-require-call',
            file,
            node.initializer,
            'createRequire must bind the literal package resolver in its reviewed owner',
          );
        } else {
          createRequireAliases.add(node.name.text);
          aliases.set(node.name.text, 'package-require');
        }
      }
    }

    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer !== undefined) {
      const value = capability(node.initializer, aliases, imports);
      if (value === 'spawn') {
        addDiagnostic(
          errors,
          'spawn-alias',
          file,
          node,
          'the worker spawn capability cannot be aliased or escaped',
        );
      } else if (value === 'package-require' && node.name.text !== 'require') {
        addDiagnostic(
          errors,
          'computed-require',
          file,
          node,
          'the package resolver cannot be aliased or escaped',
        );
      } else if (value !== undefined) aliases.set(node.name.text, value);
    }

    if (isCallExpression(node)) {
      const call = node.expression;
      const local = isIdentifier(call) ? call.text : undefined;
      const imported = local === undefined ? undefined : imports.get(local);
      if (
        normalizedBuiltin(imported?.module ?? '') === 'node:child_process' &&
        imported.imported === 'spawn'
      ) {
        if (
          !validWorkerSpawn(
            node,
            owner,
            sourceFile,
            fixedWorkerResolver,
            trustedEnv,
            reviewedWorkerAst,
          )
        ) {
          addDiagnostic(
            errors,
            'unapproved-spawn',
            file,
            node,
            'spawn must use the fixed Node worker, fixed path, shell:false and sanitized environment',
          );
        }
      }
      if (
        imported !== undefined &&
        FS_MODULES.has(normalizedBuiltin(imported.module) ?? '') &&
        CREATE_REQUIRE_OWNERS.has(owner) &&
        (imported.imported !== 'readFile' ||
          node.arguments.length !== 2 ||
          !isIdentifier(node.arguments[0]) ||
          node.arguments[0].text !== 'packagePath' ||
          literalText(node.arguments[1]) !== 'utf8' ||
          !hasFixedSlangMetadata(sourceFile, imports) ||
          !functionScoped(node))
      ) {
        addDiagnostic(
          errors,
          'unapproved-file-read',
          file,
          node,
          'file reads are restricted to package-owned Slang metadata',
        );
      }
      const cap = capability(call, aliases, imports);
      if (cap === 'package-require' || createRequireAliases.has(local ?? '')) {
        if (
          isPropertyAccessExpression(call) &&
          call.name.text === 'resolve' &&
          isIdentifier(call.expression) &&
          createRequireAliases.has(call.expression.text) &&
          node.arguments.length === 1 &&
          literalText(node.arguments[0]) === '@nomicfoundation/slang' &&
          CREATE_REQUIRE_OWNERS.has(owner)
        ) {
          // Exact package-owned parser metadata lookup.
        } else {
          addDiagnostic(
            errors,
            'computed-require',
            file,
            node,
            'require is restricted to literal Slang package metadata resolution',
          );
        }
      }
      if (
        isPropertyAccessExpression(call) &&
        isMetaProperty(call.expression) &&
        call.expression.keywordToken === SyntaxKind.ImportKeyword &&
        call.name.text === 'resolve'
      ) {
        if (
          owner !== 'src/parser/adapter.ts' ||
          node.arguments.length !== 1 ||
          literalText(node.arguments[0]) !== 'audit-estimator'
        ) {
          addDiagnostic(
            errors,
            'unapproved-package-resolve',
            file,
            node,
            'import.meta.resolve is restricted to the literal package-owned worker resolver',
          );
        }
      }
      if (cap === 'eval' || cap === 'Function' || cap === 'fetch' || cap === 'WebSocket') {
        addDiagnostic(
          errors,
          'forbidden-global',
          file,
          node,
          `call through forbidden capability '${cap}'`,
        );
      }
      if (
        isPropertyAccessExpression(call) &&
        rootIdentifier(call) === 'process' &&
        ['getBuiltinModule', 'binding', 'dlopen'].includes(call.name.text)
      ) {
        addDiagnostic(
          errors,
          'process-indirection',
          file,
          node,
          `process.${call.name.text} capability indirection is unsupported`,
        );
      }
    }

    if (isNewExpression(node)) {
      const cap = capability(node.expression, aliases, imports);
      if (cap === 'Function')
        addDiagnostic(
          errors,
          'forbidden-global',
          file,
          node,
          'dynamic Function construction is forbidden',
        );
    }

    if (isElementAccessExpression(node)) {
      const base = rootIdentifier(node);
      const index = literalText(node.argumentExpression);
      const baseAlias = isIdentifier(node.expression)
        ? aliases.get(node.expression.text)
        : undefined;
      const namespaceAlias = isIdentifier(node.expression)
        ? imports.get(node.expression.text)
        : undefined;
      const trustedEnvLookup =
        owner === 'src/parser/adapter.ts' &&
        isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'env' &&
        isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'process' &&
        isIdentifier(node.argumentExpression) &&
        node.argumentExpression.text === 'key' &&
        enclosingFunctionName(node) === 'trustedEnvironment';
      if (
        !trustedEnvLookup &&
        (base === 'globalThis' ||
          base === 'process' ||
          baseAlias === 'package-require' ||
          namespaceAlias?.imported === '*') &&
        index === undefined
      ) {
        addDiagnostic(
          errors,
          'computed-capability-access',
          file,
          node,
          'computed property access on a runtime capability is unsupported',
        );
      }
      if (base === 'globalThis' && index !== undefined && SAFE_GLOBALS.has(index)) {
        addDiagnostic(
          errors,
          'forbidden-global',
          file,
          node,
          `globalThis.${index} capability is forbidden`,
        );
      }
    }

    if (
      isPropertyAccessExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      SAFE_GLOBALS.has(node.name.text)
    ) {
      addDiagnostic(
        errors,
        'forbidden-global',
        file,
        node,
        `globalThis.${node.name.text} capability is forbidden`,
      );
    }

    if (
      isPropertyAccessExpression(node) &&
      isMetaProperty(node.expression) &&
      node.expression.keywordToken === SyntaxKind.ImportKeyword &&
      node.name.text === 'resolve'
    ) {
      const call = node.parent;
      const exactResolve =
        isCallExpression(call) &&
        call.expression === node &&
        owner === 'src/parser/adapter.ts' &&
        call.arguments.length === 1 &&
        literalText(call.arguments[0]) === 'audit-estimator';
      if (!exactResolve) {
        addDiagnostic(
          errors,
          'unapproved-package-resolve',
          file,
          node,
          'import.meta.resolve may only call the literal owned worker resolver',
        );
      }
    }

    if (isIdentifier(node) && !parentIsName(node)) {
      if (SAFE_GLOBALS.has(node.text)) {
        addDiagnostic(
          errors,
          'forbidden-global',
          file,
          node,
          `global '${node.text}' capability is forbidden`,
        );
      }
      if (node.text === 'process') {
        if (!PROCESS_ROLES.some((prefix) => owner.startsWith(prefix))) {
          addDiagnostic(
            errors,
            'process-capability',
            file,
            node,
            'global process access is outside an approved runtime role',
          );
        }
        if (node.parent && isVariableDeclaration(node.parent)) {
          addDiagnostic(errors, 'process-alias', file, node, 'global process may not be aliased');
        }
      }
      if (
        node.text === 'require' &&
        !createRequireAliases.has(node.text) &&
        node.parent &&
        isCallExpression(node.parent) &&
        node.parent.expression === node
      ) {
        addDiagnostic(
          errors,
          'computed-require',
          file,
          node,
          'unreviewed global require call is forbidden',
        );
      }
      const importedCapability = imports.get(node.text);
      if (
        normalizedBuiltin(importedCapability?.module ?? '') === 'node:module' &&
        importedCapability.imported === 'createRequire' &&
        node.parent?.kind !== SyntaxKind.ImportSpecifier
      ) {
        const call = node.parent;
        const declaration =
          isCallExpression(call) && call.expression === node ? call.parent : undefined;
        const exactBinding =
          isCallExpression(call) &&
          call.expression === node &&
          isVariableDeclaration(declaration) &&
          declaration.initializer === call &&
          isIdentifier(declaration.name) &&
          declaration.name.text === 'require' &&
          CREATE_REQUIRE_OWNERS.has(owner) &&
          call.arguments.length === 1 &&
          metaUrl(call.arguments[0]);
        if (!exactBinding) {
          addDiagnostic(
            errors,
            'create-require-escape',
            file,
            node,
            'createRequire may only initialize the reviewed literal package resolver',
          );
        }
      }
      if (
        createRequireAliases.has(node.text) &&
        !(CREATE_REQUIRE_OWNERS.has(owner) && isExactPackageResolveReference(node))
      ) {
        addDiagnostic(
          errors,
          'computed-require',
          file,
          node,
          'the package resolver may only resolve the literal owned Slang package',
        );
      }
      if (
        normalizedBuiltin(imports.get(node.text)?.module ?? '') === 'node:child_process' &&
        imports.get(node.text)?.imported === 'spawn' &&
        node.parent?.kind !== SyntaxKind.ImportSpecifier &&
        !(isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        addDiagnostic(
          errors,
          'spawn-alias',
          file,
          node,
          'the worker spawn capability cannot be aliased or escaped',
        );
      }
    }
  });

  for (const [local, binding] of importedRuntimeSymbols) {
    if (
      binding.imported === '*' &&
      normalizedBuiltin(binding.module) === 'node:module' &&
      !CREATE_REQUIRE_OWNERS.has(owner)
    ) {
      addDiagnostic(
        errors,
        'module-loader-alias',
        file,
        sourceFile,
        `namespace module-loader alias '${local}' is unsupported`,
      );
    }
  }
}

function capability(node, aliases, imports) {
  if (isIdentifier(node)) {
    if (aliases.has(node.text)) return aliases.get(node.text);
    if (SAFE_GLOBALS.has(node.text)) return node.text;
    const imported = imports.get(node.text);
    if (
      normalizedBuiltin(imported?.module ?? '') === 'node:child_process' &&
      imported.imported === 'spawn'
    )
      return 'spawn';
    return undefined;
  }
  if (isPropertyAccessExpression(node)) {
    if (
      isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      SAFE_GLOBALS.has(node.name.text)
    )
      return node.name.text;
    if (isIdentifier(node.expression) && node.expression.text === 'process') return 'process';
    if (isIdentifier(node.expression) && aliases.has(node.expression.text))
      return aliases.get(node.expression.text);
    if (isIdentifier(node.expression) && imports.get(node.expression.text)?.imported === '*')
      return 'namespace-capability';
  }
  if (isElementAccessExpression(node)) {
    const name = literalText(node.argumentExpression);
    if (
      isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      name !== undefined &&
      SAFE_GLOBALS.has(name)
    )
      return name;
    if (isIdentifier(node.expression) && aliases.has(node.expression.text))
      return aliases.get(node.expression.text);
  }
  return undefined;
}

function validWorkerSpawn(
  node,
  owner,
  sourceFile,
  fixedWorkerResolver,
  trustedEnv,
  reviewedWorkerAst,
) {
  if (owner !== 'src/parser/adapter.ts' || node.arguments.length !== 3) return false;
  const [command, args, options] = node.arguments;
  if (
    !isPropertyAccessExpression(command) ||
    command.name.text !== 'execPath' ||
    !isIdentifier(command.expression) ||
    command.expression.text !== 'process'
  )
    return false;
  if (!isArrayLiteralExpression(args) || args.elements.length !== 2) return false;
  const optionProps = {
    cwd: getObjectProperty(options, 'cwd'),
    env: getObjectProperty(options, 'env'),
    shell: getObjectProperty(options, 'shell'),
    stdio: getObjectProperty(options, 'stdio'),
  };
  const cwdValue = optionProps.cwd?.initializer;
  const envValue = optionProps.env?.initializer;
  const shellValue = optionProps.shell?.initializer;
  const stdioValue = optionProps.stdio?.initializer;
  const workerPath = args.elements[1];
  const properties = isObjectLiteralExpression(options) ? options.properties : [];
  return (
    fixedWorkerResolver &&
    trustedEnv &&
    reviewedWorkerAst &&
    properties.length === 4 &&
    args.elements[0]?.getText(sourceFile) === '`--max-old-space-size=${WORKER_HEAP_MIB}`' &&
    isPropertyAccessExpression(workerPath) &&
    workerPath.name.text === 'workerPath' &&
    isIdentifier(workerPath.expression) &&
    workerPath.expression.text === 'paths' &&
    isPropertyAccessExpression(cwdValue) &&
    cwdValue.name.text === 'packageRoot' &&
    isIdentifier(cwdValue.expression) &&
    cwdValue.expression.text === 'paths' &&
    isCallExpression(envValue) &&
    isIdentifier(envValue.expression) &&
    envValue.expression.text === 'trustedEnvironment' &&
    isFalseLiteral(shellValue) &&
    isStringArray(stdioValue, ['pipe', 'pipe', 'pipe'])
  );
}

function scanSources(files, entryFile) {
  const errors = new Set();
  const edges = new Map();
  const sourceRoot = sourceRootFor(files);
  for (const [file, sourceFile] of files)
    analyzeSource(sourceFile, file, files, sourceRoot, errors, edges);

  const closure = (start) => {
    const seen = new Set();
    const pending = [start];
    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      pending.push(...(edges.get(file) ?? []));
    }
    return seen;
  };
  for (const file of files.keys()) {
    const owner = sourceName(file);
    if (owner.startsWith('src/metrics/')) {
      for (const imported of closure(file)) {
        const importedName = sourceName(imported);
        if (importedName === 'src/parser/adapter.ts' || importedName === 'src/parser/worker.ts') {
          errors.add(
            `metrics-parser-boundary: ${owner} imports ${importedName} instead of pure protocol data`,
          );
        }
      }
    }
    const pureRoot = PURE_ROOTS.find((prefix) => owner.startsWith(prefix));
    if (pureRoot !== undefined) {
      for (const imported of closure(file)) {
        const importedName = sourceName(imported);
        if (!PURE_DEPENDENCIES[pureRoot]?.some((prefix) => importedName.startsWith(prefix))) {
          errors.add(
            `pure-layer-boundary: ${owner} runtime closure reaches ${importedName}; it is outside the reviewed layer and domain closure`,
          );
        }
      }
    }
  }

  const library = closure(entryFile);
  if (library.has(resolve(SOURCE_ROOT, 'parser/worker.ts'))) {
    errors.add(
      'library-worker-import: src/index.ts runtime closure must not import parser/worker.ts',
    );
  }
  for (const file of library) {
    const sourceFile = files.get(file);
    if (sourceFile === undefined) continue;
    const imports = importBindings(sourceFile, file, errors);
    walk(sourceFile, (node) => {
      if (!isCallExpression(node) || functionScoped(node)) return;
      const call = node.expression;
      const local = isIdentifier(call) ? call.text : undefined;
      const imported = local === undefined ? undefined : imports.get(local);
      const processEffect =
        isPropertyAccessExpression(call) &&
        rootIdentifier(call) === 'process' &&
        !['cwd', 'platform'].includes(call.name.text);
      const fileEffect =
        imported !== undefined && FS_MODULES.has(normalizedBuiltin(imported.module) ?? '');
      const spawnEffect = normalizedBuiltin(imported?.module ?? '') === 'node:child_process';
      if (processEffect || fileEffect || spawnEffect) {
        addDiagnostic(
          errors,
          'library-import-effect',
          file,
          node,
          'library import closure cannot perform I/O or process effects at module load',
        );
      }
    });
  }
  return [...errors].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function parseProgramFiles(api, filePaths, snapshot) {
  const result = new Map();
  const projects = new Set();
  for (const path of filePaths) {
    const project = snapshot.getDefaultProjectForFile(path);
    if (project !== undefined) projects.add(project);
  }
  for (const project of projects) {
    for (const name of project.program.getSourceFileNames()) {
      const path = resolve(name);
      const sourceFile = project.program.getSourceFile(path);
      if (sourceFile !== undefined) result.set(path, sourceFile);
    }
  }
  return result;
}

async function reviewedWorkerDefinitions() {
  const api = new API({ cwd: ROOT });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openProjects: [TSCONFIG] });
    const project = snapshot.getProject(TSCONFIG);
    const adapter = project?.program.getSourceFile(resolve(SOURCE_ROOT, 'parser/adapter.ts'));
    if (adapter === undefined)
      throw new Error('could not read the trusted parser adapter AST for self-test positives');
    const result = {};
    walk(adapter, (node) => {
      if (
        isFunctionLikeDeclaration(node) &&
        node.name !== undefined &&
        isIdentifier(node.name) &&
        Object.hasOwn(REVIEWED_WORKER_AST, node.name.text)
      ) {
        result[node.name.text] = node.getText(adapter);
      }
    });
    if (Object.keys(result).length !== Object.keys(REVIEWED_WORKER_AST).length) {
      throw new Error('trusted parser adapter is missing a reviewed worker AST function');
    }
    return result;
  } finally {
    try {
      snapshot?.dispose();
    } finally {
      api.close();
    }
  }
}

async function scanRepository() {
  const api = new API({ cwd: ROOT });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openProjects: [TSCONFIG] });
    const project = snapshot.getProject(TSCONFIG);
    if (project === undefined)
      throw new Error('TypeScript 7 API did not open the trusted repository tsconfig');
    const paths = project.program
      .getSourceFileNames()
      .map((name) => resolve(name))
      .filter((path) => isWithin(SOURCE_ROOT, path) && extname(path) === '.ts')
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (paths.length === 0)
      throw new Error('TypeScript 7 API returned no trusted src/**/*.ts files');
    const sources = new Map();
    for (const path of paths) {
      const sourceFile = project.program.getSourceFile(path);
      if (sourceFile === undefined)
        throw new Error(`TypeScript 7 API could not retrieve ${relativeName(path)}`);
      sources.set(path, sourceFile);
    }
    const diagnostics = scanSources(sources, resolve(SOURCE_ROOT, 'index.ts'));
    const adapter = sources.get(resolve(SOURCE_ROOT, 'parser/adapter.ts'));
    const fingerprints = adapter === undefined ? {} : workerAstFingerprints(adapter);
    return { diagnostics, sourceCount: sources.size, fingerprints };
  } finally {
    try {
      snapshot?.dispose();
    } finally {
      api.close();
    }
  }
}

async function selfTest() {
  const trustedWorker = await reviewedWorkerDefinitions();
  const tempRoot = await mkdtemp(join(tmpdir(), 'audit-estimator-boundaries-'));
  const api = new API({ cwd: tempRoot });
  let snapshot;
  try {
    const cases = [
      {
        name: 'type-only imports, mixed type specifiers, comments, strings and crypto',
        expected: undefined,
        files: {
          'src/index.ts':
            "import type { Client } from 'node:http';\nimport { createHash, type Hash } from 'node:crypto';\nexport type { Client };\nexport type { IncomingMessage } from 'node:http';\nexport const text = 'fetch(\\\"x\\\")'; // eval('x')\nexport const digest = createHash('sha256').update(text).digest('hex');\n",
        },
      },
      {
        name: 'side-effect network import',
        expected: 'network-import',
        files: { 'src/index.ts': "import 'node:http2';\nexport const value = 1;\n" },
      },
      {
        name: 'named network import alias',
        expected: 'network-import',
        files: {
          'src/index.ts':
            "import { request as send } from 'node:https'; send('https://example.invalid');\n",
        },
      },
      {
        name: 'namespace network import alias',
        expected: 'network-import',
        files: {
          'src/index.ts':
            "import * as transport from 'node:http'; transport.get('http://example.invalid');\n",
        },
      },
      {
        name: 'transitive network re-export',
        expected: 'network-import',
        files: {
          'src/index.ts': "export { request } from './barrel.ts';\n",
          'src/barrel.ts': "export { request } from 'node:https';\n",
        },
      },
      {
        name: 'globalThis fetch alias',
        expected: 'forbidden-global',
        files: {
          'src/index.ts': "const request = globalThis.fetch; request('https://example.invalid');\n",
        },
      },
      {
        name: 'aliased eval',
        expected: 'forbidden-global',
        files: { 'src/index.ts': "const run = eval; run('1');\n" },
      },
      {
        name: 'aliased globalThis Function construction',
        expected: 'forbidden-global',
        files: { 'src/index.ts': "const Ctor = globalThis.Function; new Ctor('return 1');\n" },
      },
      {
        name: 'WebSocket global construction',
        expected: 'forbidden-global',
        files: { 'src/index.ts': "new WebSocket('ws://example.invalid');\n" },
      },
      {
        name: 'computed dynamic import',
        expected: 'computed-import',
        files: { 'src/index.ts': "const name = './' + process.env.MODULE; await import(name);\n" },
      },
      {
        name: 'computed package require',
        expected: 'computed-require',
        files: {
          'src/index.ts':
            'const require = createRequire(import.meta.url); require(process.env.MODULE);\n',
        },
      },
      {
        name: 'exact owned package metadata resolver',
        expected: undefined,
        files: {
          'src/application/envelope.ts': [
            "import { createRequire } from 'node:module';",
            "import { fileURLToPath, pathToFileURL } from 'node:url';",
            "import { readFile } from 'node:fs/promises';",
            'const require = createRequire(import.meta.url);',
            'async function packageMetadata() {',
            "  const entry = require.resolve('@nomicfoundation/slang');",
            "  const packagePath = fileURLToPath(new URL('../package.json', pathToFileURL(entry)));",
            "  return readFile(packagePath, 'utf8');",
            '}',
          ].join('\n'),
        },
      },
      {
        name: 'createRequire factory alias escape',
        expected: 'create-require-escape',
        files: {
          'src/application/envelope.ts':
            "import { createRequire } from 'node:module'; const loaderFactory = createRequire;\n",
        },
      },
      {
        name: 'import.meta.resolve method escape',
        expected: 'unapproved-package-resolve',
        files: {
          'src/parser/worker.ts':
            'const resolvePackage = import.meta.resolve; void resolvePackage;\n',
        },
      },
      {
        name: 'package resolver object escape',
        expected: 'computed-require',
        files: {
          'src/application/envelope.ts': [
            "import { createRequire } from 'node:module';",
            "import { fileURLToPath, pathToFileURL } from 'node:url';",
            "import { readFile } from 'node:fs/promises';",
            'const require = createRequire(import.meta.url);',
            'async function packageMetadata() {',
            "  const entry = require.resolve('@nomicfoundation/slang');",
            "  const packagePath = fileURLToPath(new URL('../package.json', pathToFileURL(entry)));",
            "  return readFile(packagePath, 'utf8');",
            '}',
            'const box = { load: require };',
            "void box.load('./untrusted.js');",
          ].join('\n'),
        },
      },
      {
        name: 'package resolver alias',
        expected: 'computed-require',
        files: {
          'src/application/envelope.ts': [
            "import { createRequire } from 'node:module';",
            "import { fileURLToPath, pathToFileURL } from 'node:url';",
            "import { readFile } from 'node:fs/promises';",
            'const require = createRequire(import.meta.url);',
            'async function packageMetadata() {',
            "  const entry = require.resolve('@nomicfoundation/slang');",
            "  const packagePath = fileURLToPath(new URL('../package.json', pathToFileURL(entry)));",
            "  return readFile(packagePath, 'utf8');",
            '}',
            'const loader = require;',
            "void loader.resolve('./untrusted.js');",
          ].join('\n'),
        },
      },
      {
        name: 'unapproved child spawn',
        expected: 'child-process-import',
        files: {
          'src/index.ts':
            "import { spawn as launch } from 'node:child_process'; launch(process.execPath, ['x'], { shell: false });\n",
        },
      },
      {
        name: 'pure source filesystem import',
        expected: 'pure-io-import',
        files: {
          'src/domain/index.ts':
            "import { readFile } from 'node:fs/promises'; export const load = readFile;\n",
        },
      },
      {
        name: 'pure source permits normalized crypto builtin',
        expected: undefined,
        files: {
          'src/estimation/hash.ts':
            "import { createHash } from 'crypto'; export const hash = createHash('sha256');\n",
        },
      },
      {
        name: 'pure source rejects runtime helper builtin',
        expected: 'pure-builtin-boundary',
        files: {
          'src/reporting/hash.ts':
            "import { performance } from 'node:perf_hooks'; export const now = performance.now();\n",
        },
      },
      {
        name: 'bare child process builtin is normalized and rejected',
        expected: 'child-process-import',
        files: { 'src/index.ts': "import { spawn } from 'child_process'; spawn('node', []);\n" },
      },
      {
        name: 'pure to CLI transitive filesystem closure',
        expected: 'pure-layer-boundary',
        entry: 'src/estimation/index.ts',
        files: {
          'src/estimation/index.ts': "export { run } from '../cli/run.ts';\n",
          'src/cli/run.ts':
            "import { readFile } from 'node:fs/promises'; export const run = readFile;\n",
        },
      },
      {
        name: 'estimation cannot depend on metrics layer',
        expected: 'pure-layer-boundary',
        entry: 'src/estimation/index.ts',
        files: {
          'src/estimation/index.ts': "export { summarize } from '../metrics/summary.ts';\n",
          'src/metrics/summary.ts': 'export function summarize() { return 1; }\n',
        },
      },
      {
        name: 'filesystem use in transitive pure helper',
        expected: 'pure-io-import',
        entry: 'src/estimation/index.ts',
        files: {
          'src/estimation/index.ts': "export { run } from './helper.ts';\n",
          'src/estimation/helper.ts':
            "import { readFile } from 'node:fs/promises'; export const run = readFile;\n",
        },
      },
      {
        name: 'unapproved fixed-worker spawn shape',
        expected: 'unapproved-spawn',
        files: {
          'src/parser/adapter.ts':
            "import { spawn } from 'node:child_process'; export function run() { return spawn(process.execPath, ['project-derived'], { shell: true, env: process.env }); }\n",
        },
      },
      {
        name: 'exact owned worker spawn',
        expected: undefined,
        files: {
          'src/parser/adapter.ts': [
            "import { spawn } from 'node:child_process';",
            "import { fileURLToPath } from 'node:url';",
            "import { resolve } from 'node:path';",
            'const WORKER_HEAP_MIB = 64;',
            trustedWorker.trustedEnvironment,
            trustedWorker.packageWorkerPaths,
            trustedWorker.spawnWorker,
          ].join('\n'),
        },
      },
      {
        name: 'worker environment mutation with spread',
        expected: 'worker-environment',
        files: {
          'src/parser/adapter.ts': [
            "import { spawn } from 'node:child_process';",
            "import { fileURLToPath } from 'node:url';",
            "import { resolve } from 'node:path';",
            'const WORKER_HEAP_MIB = 64;',
            trustedWorker.trustedEnvironment.replace(
              'return environment;',
              "return { ...environment, NODE_OPTIONS: 'unsafe' };",
            ),
            trustedWorker.packageWorkerPaths,
            trustedWorker.spawnWorker,
          ].join('\n'),
        },
      },
      {
        name: 'worker package path mutation',
        expected: 'worker-path-resolution',
        files: {
          'src/parser/adapter.ts': [
            "import { spawn } from 'node:child_process';",
            "import { fileURLToPath } from 'node:url';",
            "import { resolve } from 'node:path';",
            'const WORKER_HEAP_MIB = 64;',
            trustedWorker.trustedEnvironment,
            trustedWorker.packageWorkerPaths.replace(
              "'./parser/worker.js'",
              "'./target/worker.js'",
            ),
            trustedWorker.spawnWorker,
          ].join('\n'),
        },
      },
      {
        name: 'worker heap limit mutation',
        expected: 'unapproved-spawn',
        files: {
          'src/parser/adapter.ts': [
            "import { spawn } from 'node:child_process';",
            "import { fileURLToPath } from 'node:url';",
            "import { resolve } from 'node:path';",
            'const WORKER_HEAP_MIB = 65;',
            trustedWorker.trustedEnvironment,
            trustedWorker.packageWorkerPaths,
            trustedWorker.spawnWorker,
          ].join('\n'),
        },
      },
      {
        name: 'spawn alias escape',
        expected: 'spawn-alias',
        files: {
          'src/parser/adapter.ts': [
            "import { spawn } from 'node:child_process';",
            "import { fileURLToPath } from 'node:url';",
            "import { resolve } from 'node:path';",
            'const WORKER_HEAP_MIB = 64;',
            trustedWorker.trustedEnvironment,
            trustedWorker.packageWorkerPaths,
            trustedWorker.spawnWorker.replace(
              '  const child = spawn(',
              '  const launch = spawn;\n  const child = launch(',
            ),
          ].join('\n'),
        },
      },
      {
        name: 'unsupported process builtin indirection',
        expected: 'process-indirection',
        files: {
          'src/application/index.ts':
            "const loader = process.getBuiltinModule('node:child_process'); loader('node:fs');\n",
        },
      },
    ];
    const testPaths = [];
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const item = cases[caseIndex];
      for (const [relativePath, content] of Object.entries(item.files)) {
        const path = join(tempRoot, String(caseIndex), relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        testPaths.push(path);
      }
    }
    snapshot = api.updateSnapshot({ openFiles: testPaths });
    const parsed = await parseProgramFiles(api, testPaths, snapshot);
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const item = cases[caseIndex];
      const prefix = join(tempRoot, String(caseIndex));
      const graph = new Map([...parsed.entries()].filter(([path]) => isWithin(prefix, path)));
      const entry =
        item.entry === undefined
          ? [...graph.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0]
          : resolve(prefix, item.entry);
      if (entry === undefined) throw new Error(`self-test '${item.name}' was not parsed`);
      const diagnostics = scanSources(graph, entry);
      if (item.expected === undefined) {
        if (diagnostics.length !== 0)
          throw new Error(
            `self-test '${item.name}' unexpectedly rejected: ${diagnostics.join('; ')}`,
          );
      } else if (!diagnostics.some((diagnostic) => diagnostic.startsWith(`${item.expected}:`))) {
        throw new Error(
          `self-test '${item.name}' missed ${item.expected}; got: ${diagnostics.join('; ')}`,
        );
      }
    }
    process.stdout.write(
      `Boundary AST self-test passed (${cases.length} virtual source graphs; TypeScript ${API_VERSION}).\n`,
    );
  } finally {
    try {
      snapshot?.dispose();
    } finally {
      api.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    await selfTest();
    return;
  }
  if (args.length !== 0) throw new Error(`Unsupported arguments: ${args.join(' ')}`);
  const { diagnostics, sourceCount } = await scanRepository();
  if (diagnostics.length > 0) {
    process.stderr.write(
      `Boundary scan rejected ${diagnostics.length} issue(s):\n${diagnostics.map((item) => `  ${item}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Boundary scan passed: ${sourceCount} trusted src files using TypeScript ${API_VERSION}.\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Boundary scanner failed closed: ${message}\n`);
  process.exitCode = 1;
});
