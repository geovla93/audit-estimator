import { link, mkdir, readFile, symlink } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { resolveConfig } from '../../src/config/load.ts';
import { DEFAULT_ANALYSIS_LIMITS, DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import type {
  AnalysisLimits,
  ManualAdjustment,
  ModelProfile,
  Remapping,
  ScopeSettings,
} from '../../src/domain/types.ts';
import { ScopeManifestSchema } from '../../src/domain/schemas.ts';
import { fileIdentity } from '../../src/domain/canonical.ts';
import { createDiscoveryBudget } from '../../src/discovery/budget.ts';
import { discoverScope as rawDiscoverScope } from '../../src/discovery/discover.ts';
import { IdentityRegistry } from '../../src/discovery/identity.ts';
import { readProjectMetadata } from '../../src/discovery/metadata.ts';
import { readSource, type SafeReadAdapter } from '../../src/discovery/safe-read.ts';
import {
  reevaluateIdentityOwnership,
  selectSourceRoots,
  type DiscoveryDirectoryAdapter,
  type DiscoveryDirectoryEntry,
  type DiscoveryResult,
  type DiscoveryInput,
} from '../../src/discovery/scope.ts';
import { resolveSafePath } from '../../src/discovery/safe-path.ts';
import {
  absoluteProjectPath,
  createProject,
  removeProject,
  safePathContext,
  testLimits,
  writeProjectFile,
} from '../helpers/filesystem.ts';

function trustedDefaults(limits: AnalysisLimits = { ...DEFAULT_ANALYSIS_LIMITS }) {
  const model: ModelProfile = {
    profile: 'heuristic-v1',
    modelVersion: '1.0.0',
    parameters: {
      projectHours: { low: 0.5, high: 1 },
      slocHours: { low: 0.001, high: 0.002 },
      controlPremium: { low: 0.1, high: 0.2 },
      storagePremium: { low: 0.1, high: 0.2 },
      evmPremium: { low: 0.1, high: 0.2 },
      interactionHours: { low: 0.25, high: 0.5 },
      boundaryHours: { low: 0.25, high: 0.5 },
      unknownReserveHigh: 0.5,
      hoursPerDay: 8,
    },
  };
  const scope: ScopeSettings = { ...DEFAULT_SCOPE_SETTINGS };
  const remappings: readonly Remapping[] = [];
  const manualAdjustments: readonly ManualAdjustment[] = [];
  return {
    scope,
    imports: { remappings },
    solidity: { version: '0.8.28' },
    analysis: { limits },
    model,
    manualAdjustments,
    coverage: { lcovPath: null },
  };
}

async function discoveryInput(
  root: string,
  targetPath = '.',
  limits: AnalysisLimits = { ...DEFAULT_ANALYSIS_LIMITS },
  directoryAdapter?: DiscoveryDirectoryAdapter,
  options: { readonly signal?: AbortSignal; readonly identities?: IdentityRegistry } = {},
): Promise<DiscoveryInput> {
  const operational = await resolveConfig({ root, defaults: trustedDefaults(limits) });
  const budget = createDiscoveryBudget(operational.config.analysis.limits, options.signal);
  const rootContext = await safePathContext(root);
  const metadata = await readProjectMetadata({ pathContext: rootContext, budget });
  const resolved = await resolveConfig({
    root,
    defaults: trustedDefaults(limits),
    metadata: metadata.hints,
  });
  budget.assertLimitsMatch(resolved.config.analysis.limits);
  const targetAbsolute = absoluteProjectPath(root, targetPath);
  const pathContext = await safePathContext(root, {
    target: targetAbsolute,
    followSymlinks: resolved.config.scope.followSymlinks,
  });
  const target = await resolveSafePath({ ...pathContext, budget }, targetAbsolute);
  return {
    root: pathContext.root,
    lexicalRoot: pathContext.lexicalRoot,
    target,
    lexicalTarget: targetAbsolute,
    config: resolved.config,
    metadata,
    budget,
    identities: options.identities ?? new IdentityRegistry(),
    ...(directoryAdapter === undefined ? {} : { directoryAdapter }),
  };
}

class ScheduledAbortIdentityRegistry extends IdentityRegistry {
  readonly #controller: AbortController;
  #scheduled = false;

  public constructor(controller: AbortController) {
    super();
    this.#controller = controller;
  }

  public override get(identityKey: string): ReturnType<IdentityRegistry['get']> {
    const observation = super.get(identityKey);
    if (!this.#scheduled && observation !== undefined && observation.lexicalAliases.length > 1) {
      this.#scheduled = true;
      void yieldImmediate().then(() => this.#controller.abort());
    }
    return observation;
  }
}

async function discoverScope(input: DiscoveryInput): Promise<DiscoveryResult> {
  const result = await rawDiscoverScope(input);
  expect(!result.complete || ScopeManifestSchema.safeParse(result.manifest).success).toBe(true);
  for (const entry of result.manifest.entries) {
    const shouldValidate = result.complete && entry.role === 'scoped';
    expect(!shouldValidate || entry.ownership === 'first-party').toBe(true);
    expect(!shouldValidate || entry.fileId === fileIdentity(entry.path)).toBe(true);

    const matchingSnapshots = result.snapshots.filter(
      (snapshot) => snapshot.canonicalPath === entry.path,
    );
    expect(!shouldValidate || matchingSnapshots.length === 1).toBe(true);
    expect(!shouldValidate || matchingSnapshots[0]?.byteHash === entry.byteHash).toBe(true);
    expect(!shouldValidate || matchingSnapshots[0]?.canonicalPath === entry.physicalIdentity).toBe(
      true,
    );

    const alias = result.observations.aliases.find(
      (observation) => observation.representativePath === entry.path,
    );
    expect(!shouldValidate || alias?.ownership === 'first-party').toBe(true);
    const hasSelectionAndOwnershipRule =
      alias?.pathDecisions.some(
        (decision) =>
          decision.selected &&
          decision.lexicalExclusionRule === null &&
          decision.physicalExclusionRule === null &&
          decision.ownership === 'first-party' &&
          decision.selectionRule.length > 0 &&
          decision.ownershipRule.length > 0,
      ) ?? false;
    expect(!shouldValidate || hasSelectionAndOwnershipRule).toBe(true);
  }
  return result;
}

async function writeScopeConfig(root: string, scope: Partial<ScopeSettings>): Promise<void> {
  await writeProjectFile(
    root,
    'audit-estimator.config.json',
    JSON.stringify({
      configVersion: '1.0.0',
      scope,
    }),
  );
}

function fakeFileEntry(name: string): DiscoveryDirectoryEntry {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

describe('metadata and roots', () => {
  it('normalizes Foundry hints, preserves missing custom paths, and applies config precedence', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/Local.sol', 'contract Local {}\n');
      await writeProjectFile(
        root,
        'foundry.toml',
        [
          '[profile.default]',
          'src = "contracts"',
          'test = "specs"',
          'script = "deploy"',
          'out = "custom-output"',
          'libs = ["lib", "vendor/custom"]',
          'remappings = ["@openzeppelin/=lib/openzeppelin/", "contracts/:@local/=contracts/local/"]',
          'solc = "0.8.28"',
          '',
        ].join('\n'),
      );
      const pathContext = await safePathContext(root);
      const budget = createDiscoveryBudget(testLimits());
      const metadata = await readProjectMetadata({ pathContext, budget });

      expect(metadata.valid).toBe(true);
      expect(metadata.observation.status).toBe('read');
      expect(metadata.hints.scope?.sourceRoots).toEqual(['contracts']);
      expect(metadata.paths).toEqual({
        libs: ['lib', 'vendor/custom'],
        test: 'specs',
        script: 'deploy',
        out: 'custom-output',
      });
      expect(metadata.hints.imports?.remappings).toEqual([
        { prefix: '@openzeppelin/', target: 'lib/openzeppelin' },
        { context: 'contracts', prefix: '@local/', target: 'contracts/local' },
      ]);
      expect(metadata.hints.solidity?.version).toBe('0.8.28');

      const resolved = await resolveConfig({
        root,
        noConfig: true,
        defaults: trustedDefaults(),
        metadata: metadata.hints,
      });
      expect(resolved.config.scope.sourceRoots).toEqual(['contracts']);
      expect(
        resolved.config.provenance.find((item) => item.field === 'scope.sourceRoots')?.source,
      ).toBe('metadata');
      const target = await resolveSafePath({ ...pathContext, budget }, root);
      const decision = await selectSourceRoots({
        pathContext,
        target,
        scope: resolved.config.scope,
        config: resolved.config,
        budget,
      });
      expect(decision.mode).toBe('configured-roots');
      expect(decision.candidateBasePaths).toEqual(['contracts']);

      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          scope: { sourceRoots: ['src'] },
          solidity: { version: '0.8.26' },
        }),
      );
      const overridden = await resolveConfig({
        root,
        defaults: trustedDefaults(),
        metadata: metadata.hints,
        cli: { solidityVersion: '0.8.30' },
      });
      expect(overridden.config.scope.sourceRoots).toEqual(['src']);
      expect(
        overridden.config.provenance.find((item) => item.field === 'scope.sourceRoots')?.source,
      ).toBe('config');
      expect(overridden.config.solidity.version).toBe('0.8.30');
      expect(
        overridden.config.provenance.find((item) => item.field === 'solidity.version')?.source,
      ).toBe('cli');
    } finally {
      await removeProject(root);
    }
  });

  it('keeps absent source, library, remapping, and output paths distinct from the project root', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(
        root,
        'foundry.toml',
        [
          '[profile.default]',
          'src = "missing-contracts"',
          'out = "custom-output"',
          'libs = ["missing-libs"]',
          'remappings = ["@missing/=missing-remapping/"]',
          '',
        ].join('\n'),
      );
      const pathContext = await safePathContext(root);
      const budget = createDiscoveryBudget(testLimits());
      const metadata = await readProjectMetadata({ pathContext, budget });
      expect(metadata.hints.scope?.sourceRoots).toEqual(['missing-contracts']);
      expect(metadata.paths).toEqual({
        libs: ['missing-libs'],
        test: null,
        script: null,
        out: 'custom-output',
      });
      expect(metadata.hints.imports?.remappings[0]?.target).toBe('missing-remapping');

      const resolved = await resolveConfig({
        root,
        noConfig: true,
        defaults: trustedDefaults(),
        metadata: metadata.hints,
      });
      const target = await resolveSafePath({ ...pathContext, budget }, root);
      const decision = await selectSourceRoots({
        pathContext,
        target,
        scope: resolved.config.scope,
        config: resolved.config,
        budget,
      });
      expect(decision.candidateBasePaths).toEqual([]);
      expect(decision.issues).toContainEqual({
        code: 'TARGET_UNREADABLE',
        path: 'missing-contracts',
        reason: 'missing',
      });
      expect(decision.mode).toBe('configured-roots');
    } finally {
      await removeProject(root);
    }
  });

  it('accepts confined regular files as remapping targets and contexts', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'Existing.sol', 'library Existing {}\n');
      await writeProjectFile(root, 'src/Context.sol', 'contract Context {}\n');
      await writeProjectFile(
        root,
        'foundry.toml',
        [
          '[profile.default]',
          'remappings = ["Alias.sol=Existing.sol", "src/Context.sol:Alias.sol=Existing.sol"]',
          '',
        ].join('\n'),
      );
      const metadata = await readProjectMetadata({
        pathContext: await safePathContext(root),
        budget: createDiscoveryBudget(testLimits()),
      });
      expect(metadata.valid).toBe(true);
      expect(metadata.hints.imports?.remappings).toEqual([
        { prefix: 'Alias.sol', target: 'Existing.sol' },
        { context: 'src/Context.sol', prefix: 'Alias.sol', target: 'Existing.sol' },
      ]);
    } finally {
      await removeProject(root);
    }
  });

  it('handles generic and Hardhat markers by path inspection without executing configuration', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/Local.sol', 'contract Local {}\n');
      const sentinel = 'throw new Error("project config must remain inert");\n';
      const marker = await writeProjectFile(root, 'hardhat.config.js', sentinel);
      const pathContext = await safePathContext(root);
      const budget = createDiscoveryBudget(testLimits());
      const metadata = await readProjectMetadata({ pathContext, budget });
      expect(metadata.valid).toBe(true);
      expect(metadata.observation.status).toBe('absent');
      expect(metadata.hints).toEqual({});
      expect(metadata.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'PARTIAL_ANALYSIS',
          details: expect.arrayContaining([
            expect.objectContaining({ key: 'path', value: 'hardhat.config.js' }),
          ]),
        }),
      );
      expect(await readFile(marker, 'utf8')).toBe(sentinel);
      expect(
        await readFile(absoluteProjectPath(root, 'project-config-executed'), 'utf8').catch(
          () => null,
        ),
      ).toBeNull();

      const resolved = await resolveConfig({ root, noConfig: true, defaults: trustedDefaults() });
      const target = await resolveSafePath({ ...pathContext, budget }, root);
      const decision = await selectSourceRoots({
        pathContext,
        target,
        scope: resolved.config.scope,
        config: resolved.config,
        budget,
      });
      expect(decision.mode).toBe('conventional-roots');
      expect(decision.candidateBasePaths).toEqual(['src']);
    } finally {
      await removeProject(root);
    }
  });

  it('ignores malformed, oversized, symlinked, and root-wide exclusion metadata safely', async () => {
    const malformedRoot = await createProject();
    const oversizedRoot = await createProject();
    const linkedRoot = await createProject();
    const wideRoot = await createProject();
    const externalRoot = await createProject('audit-estimator-external-');
    try {
      await writeProjectFile(
        malformedRoot,
        'foundry.toml',
        '[profile.default\nsrc = "secret-path"',
      );
      const malformed = await readProjectMetadata({
        pathContext: await safePathContext(malformedRoot),
        budget: createDiscoveryBudget(testLimits()),
      });
      expect(malformed.valid).toBe(false);
      expect(malformed.hints).toEqual({});
      expect(JSON.stringify(malformed.diagnostics)).not.toContain('secret-path');

      await writeProjectFile(oversizedRoot, 'foundry.toml', Buffer.alloc(128, 0x20));
      const oversized = await readProjectMetadata({
        pathContext: await safePathContext(oversizedRoot),
        budget: createDiscoveryBudget(testLimits({ maxMetadataBytes: 32 })),
      });
      expect(oversized.observation.status).toBe('oversized');
      expect(oversized.hints).toEqual({});

      const externalMetadata = await writeProjectFile(
        externalRoot,
        'foundry.toml',
        '[profile.default]\nsrc="outside"',
      );
      await import('node:fs/promises').then(({ symlink }) =>
        symlink(externalMetadata, absoluteProjectPath(linkedRoot, 'foundry.toml')),
      );
      const linked = await readProjectMetadata({
        pathContext: await safePathContext(linkedRoot),
        budget: createDiscoveryBudget(testLimits()),
      });
      expect(linked.observation.status).toBe('blocked');
      expect(linked.hints).toEqual({});

      await writeProjectFile(
        wideRoot,
        'foundry.toml',
        '[profile.default]\ntest="."\nscript="deploy"\nout="out"\n',
      );
      const wide = await readProjectMetadata({
        pathContext: await safePathContext(wideRoot),
        budget: createDiscoveryBudget(testLimits()),
      });
      expect(wide.valid).toBe(true);
      expect(wide.paths.test).toBeNull();
      expect(wide.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'PATH_BLOCKED',
          details: expect.arrayContaining([
            expect.objectContaining({ key: 'reason', value: 'root-wide-exclusion' }),
          ]),
        }),
      );
    } finally {
      await Promise.all([
        removeProject(malformedRoot),
        removeProject(oversizedRoot),
        removeProject(linkedRoot),
        removeProject(wideRoot),
        removeProject(externalRoot),
      ]);
    }
  });
});

describe('selection and ownership', () => {
  it('validates an ancestor source root before intersecting a subtree target', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/subtree/Included.sol', 'contract Included {}\n');
      await writeProjectFile(root, 'contracts/Elsewhere.sol', 'contract Elsewhere {}\n');
      await writeScopeConfig(root, { sourceRoots: ['contracts'] });
      const result = await discoverScope(await discoveryInput(root, 'contracts/subtree'));
      expect(result.observations.rootDecision.candidateBasePaths).toEqual(['contracts/subtree']);
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
        'contracts/subtree/Included.sol',
      ]);
      expect(ScopeManifestSchema.safeParse(result.manifest).success).toBe(true);
      expect(result.observations.aliases[0]?.pathDecisions).toContainEqual(
        expect.objectContaining({
          lexicalPath: 'contracts/subtree/Included.sol',
          physicalPath: 'contracts/subtree/Included.sol',
          selected: true,
          selectionRule: 'source-root:config:contracts/subtree',
          ownership: 'first-party',
        }),
      );
      expect(result.observations.rules).toContainEqual(
        expect.objectContaining({
          path: 'contracts/subtree/Included.sol',
          rule: 'source-root:config:contracts/subtree',
          source: 'config',
        }),
      );
      expect(result.complete).toBe(true);
    } finally {
      await removeProject(root);
    }
  });

  it('returns an empty mismatch instead of widening to a sibling source root', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/subtree/Included.sol', 'contract Included {}\n');
      await writeProjectFile(root, 'contracts/submarine/Sibling.sol', 'contract Sibling {}\n');
      await writeScopeConfig(root, { sourceRoots: ['contracts/submarine'] });
      const result = await discoverScope(await discoveryInput(root, 'contracts/subtree'));
      expect(result.observations.rootDecision.targetMismatch).toBe(true);
      expect(result.manifest.entries).toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'TARGET_UNREADABLE' }),
      );
    } finally {
      await removeProject(root);
    }
  });

  it('groups hardlink aliases before ownership and requires explicit promotion', async () => {
    const root = await createProject();
    try {
      const dependency = await writeProjectFile(root, 'lib/Local.sol', 'contract Local {}\n');
      await writeProjectFile(root, 'src/placeholder.sol', 'contract Placeholder {}\n');
      await link(dependency, absoluteProjectPath(root, 'src/Local.sol'));
      await writeScopeConfig(root, { include: ['**/*.sol'], defaultExcludes: false });
      const unpromoted = await discoverScope(await discoveryInput(root));
      expect(unpromoted.manifest.entries.map((entry) => entry.path)).toEqual([
        'src/placeholder.sol',
      ]);
      expect(unpromoted.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'lib/Local.sol',
          reason: 'unknown-ownership',
        }),
      );
      expect(unpromoted.complete).toBe(false);

      await writeScopeConfig(root, {
        include: ['**/*.sol'],
        defaultExcludes: false,
        firstPartyOverrides: ['lib'],
      });
      const promoted = await discoverScope(await discoveryInput(root));
      expect(promoted.manifest.entries.map((entry) => entry.path)).toContain('lib/Local.sol');
      expect(
        promoted.manifest.entries.filter((entry) => entry.path.includes('Local.sol')),
      ).toHaveLength(1);
      expect(promoted.observations.aliases).toContainEqual(
        expect.objectContaining({
          representativePath: 'lib/Local.sol',
          ownership: 'first-party',
          rule: 'first-party-override:lib',
        }),
      );
      expect(ScopeManifestSchema.safeParse(promoted.manifest).success).toBe(true);
    } finally {
      await removeProject(root);
    }
  });

  it('keeps dependency/first-party hardlink conflicts unknown regardless of representative order', async () => {
    const dependencyFirstRoot = await createProject();
    const firstPartyFirstRoot = await createProject();
    try {
      const dependencyFirst = await writeProjectFile(
        dependencyFirstRoot,
        'deps/Local.sol',
        'library Local {}\n',
      );
      await mkdir(absoluteProjectPath(dependencyFirstRoot, 'src'), { recursive: true });
      await link(dependencyFirst, absoluteProjectPath(dependencyFirstRoot, 'src/Local.sol'));
      await writeScopeConfig(dependencyFirstRoot, {
        include: ['**/*.sol'],
        defaultExcludes: false,
      });
      const firstResult = await discoverScope(await discoveryInput(dependencyFirstRoot));
      expect(
        firstResult.observations.aliases[0]?.pathDecisions.map((decision) => decision.physicalPath),
      ).toEqual(['deps/Local.sol', 'src/Local.sol']);
      expect(firstResult.observations.aliases[0]?.ownership).toBe('unknown');

      const firstParty = await writeProjectFile(
        firstPartyFirstRoot,
        'aaa/Local.sol',
        'library Local {}\n',
      );
      await mkdir(absoluteProjectPath(firstPartyFirstRoot, 'lib'), { recursive: true });
      await link(firstParty, absoluteProjectPath(firstPartyFirstRoot, 'lib/Local.sol'));
      await writeScopeConfig(firstPartyFirstRoot, {
        include: ['**/*.sol'],
        defaultExcludes: false,
      });
      const secondResult = await discoverScope(await discoveryInput(firstPartyFirstRoot));
      expect(
        secondResult.observations.aliases[0]?.pathDecisions.map((decision) => decision.lexicalPath),
      ).toEqual(['aaa/Local.sol', 'lib/Local.sol']);
      expect(secondResult.observations.aliases[0]?.ownership).toBe('unknown');
      expect(secondResult.manifest.entries.some((entry) => entry.path.includes('Local.sol'))).toBe(
        false,
      );
    } finally {
      await Promise.all([removeProject(dependencyFirstRoot), removeProject(firstPartyFirstRoot)]);
    }
  });

  it('lets an eligible first-party hardlink survive a plain excluded alias', async () => {
    const root = await createProject();
    try {
      const source = await writeProjectFile(root, 'src/Local.sol', 'contract Local {}\n');
      await mkdir(absoluteProjectPath(root, 'test'), { recursive: true });
      await link(source, absoluteProjectPath(root, 'test/Local.sol'));
      await writeScopeConfig(root, {
        include: ['**/*.sol'],
        exclude: ['test/Local.sol'],
        defaultExcludes: false,
      });
      const result = await discoverScope(await discoveryInput(root));
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/Local.sol']);
      expect(result.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'test/Local.sol',
          reason: 'excluded',
        }),
      );
      expect(result.observations.aliases[0]?.pathDecisions).toContainEqual(
        expect.objectContaining({
          lexicalPath: 'test/Local.sol',
          selected: true,
          selectionRule: expect.stringContaining('include[0]'),
          lexicalExclusionRule: 'config-exclude:test/Local.sol',
        }),
      );
      expect(result.complete).toBe(true);
    } finally {
      await removeProject(root);
    }
  });

  it('yields during bounded identity alias finalization so cancellation is observed', async () => {
    const root = await createProject();
    const controller = new AbortController();
    try {
      const source = await writeProjectFile(root, 'src/Shared.sol', 'library Shared {}\n');
      await mkdir(absoluteProjectPath(root, 'src/aliases'), { recursive: true });
      for (let index = 0; index < 300; index += 1) {
        const alias = `src/aliases/Alias${index.toString().padStart(3, '0')}.sol`;
        await link(source, absoluteProjectPath(root, alias));
      }
      await writeScopeConfig(root, { include: ['**/*.sol'], defaultExcludes: false });
      const identities = new ScheduledAbortIdentityRegistry(controller);
      const result = await discoverScope(
        await discoveryInput(root, '.', undefined, undefined, {
          signal: controller.signal,
          identities,
        }),
      );
      expect(result.complete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'LIMIT_EXCEEDED',
          details: expect.arrayContaining([
            expect.objectContaining({ key: 'reason', value: 'cancelled' }),
          ]),
        }),
      );
      expect(result.observations.counters.filesystemEntries).toBeGreaterThanOrEqual(300);
    } finally {
      controller.abort();
      await removeProject(root);
    }
  });

  it('lets includes replace source roots and literal Solidity targets bypass includes', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'contracts/Root.sol', 'contract Root {}\n');
      await writeProjectFile(root, 'misc/Chosen.sol', 'contract Chosen {}\n');
      await writeProjectFile(root, 'misc/Ignored.sol', 'contract Ignored {}\n');
      await writeScopeConfig(root, {
        sourceRoots: ['contracts'],
        include: ['misc/Chosen.sol'],
        exclude: ['**/Ignored.sol'],
      });
      const directory = await discoverScope(await discoveryInput(root));
      expect(directory.manifest.entries.map((entry) => entry.path)).toEqual(['misc/Chosen.sol']);
      const literal = await discoverScope(await discoveryInput(root, 'contracts/Root.sol'));
      expect(literal.manifest.entries.map((entry) => entry.path)).toEqual(['contracts/Root.sol']);
      const excludedLiteral = await discoverScope(await discoveryInput(root, 'misc/Ignored.sol'));
      expect(excludedLiteral.manifest.entries).toEqual([]);
      expect(excludedLiteral.observations.candidates).toContainEqual(
        expect.objectContaining({ reason: 'excluded' }),
      );
    } finally {
      await removeProject(root);
    }
  });

  it('honors default-exclusion opt-out for metadata test paths and reports known dependencies', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'foundry.toml', '[profile.default]\ntest = "custom-tests"\n');
      await writeProjectFile(root, 'custom-tests/Chosen.sol', 'contract Chosen {}\n');
      await writeProjectFile(root, 'lib/Dependency.sol', 'library Dependency {}\n');
      await writeScopeConfig(root, { include: ['**/*.sol'], defaultExcludes: false });
      const result = await discoverScope(await discoveryInput(root));
      expect(result.manifest.entries.map((entry) => entry.path)).toContain(
        'custom-tests/Chosen.sol',
      );
      expect(result.manifest.entries.map((entry) => entry.path)).not.toContain(
        'lib/Dependency.sol',
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'OWNERSHIP_UNKNOWN',
          message: expect.stringContaining('known dependency'),
        }),
      );
    } finally {
      await removeProject(root);
    }
  });
});

describe('patterns and manifest', () => {
  it('is independent of directory creation order and validates every completed manifest', async () => {
    const left = await createProject();
    const right = await createProject();
    try {
      await writeProjectFile(left, 'contracts/z/Last.sol', 'contract Last {}\n');
      await writeProjectFile(left, 'contracts/a/First.sol', 'contract First {}\n');
      await writeProjectFile(right, 'contracts/a/First.sol', 'contract First {}\n');
      await writeProjectFile(right, 'contracts/z/Last.sol', 'contract Last {}\n');
      const leftResult = await discoverScope(await discoveryInput(left));
      const rightResult = await discoverScope(await discoveryInput(right));
      expect(leftResult.manifest.entries.map(({ path, byteHash }) => [path, byteHash])).toEqual(
        rightResult.manifest.entries.map(({ path, byteHash }) => [path, byteHash]),
      );
      expect(ScopeManifestSchema.safeParse(leftResult.manifest).success).toBe(true);
      expect(ScopeManifestSchema.safeParse(rightResult.manifest).success).toBe(true);
      for (const result of [leftResult, rightResult]) {
        for (const entry of result.manifest.entries) {
          const snapshot = result.snapshots.find(
            (candidate) => candidate.canonicalPath === entry.path,
          );
          expect(snapshot?.byteHash).toBe(entry.byteHash);
          expect(
            result.observations.aliases.some(
              (alias) =>
                alias.representativePath === entry.path &&
                alias.pathDecisions.some(
                  (decision) => decision.selected && decision.ownership === 'first-party',
                ),
            ),
          ).toBe(true);
        }
      }
    } finally {
      await Promise.all([removeProject(left), removeProject(right)]);
    }
  });

  it('keeps built-in exclusions compiled when the configured pattern-list count is smaller', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/Included.sol', 'contract Included {}\n');
      const result = await discoverScope(
        await discoveryInput(root, '.', testLimits({ maxPatternsPerList: 1 })),
      );
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/Included.sol']);
      expect(result.complete).toBe(true);
    } finally {
      await removeProject(root);
    }
  });

  it('rejects POSIX backslash-name collisions without normalizing them into another source path', async (testContext) => {
    if (process.platform === 'win32')
      testContext.skip('POSIX filenames can contain literal backslashes; Windows names cannot.');
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/part/File.sol', 'contract File {}\n');
      await writeProjectFile(root, 'src/part\\File.sol', 'contract Collision {}\n');
      const result = await discoverScope(await discoveryInput(root));
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/part/File.sol']);
      expect(result.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'src/part\\File.sol',
          reason: 'unsafe',
          rule: 'unrepresentable-path-name',
        }),
      );
      expect(result.complete).toBe(false);
    } finally {
      await removeProject(root);
    }
  });

  it('blocks a followed link whose physical source is excluded and confines links to the target subtree', async () => {
    const excludedRoot = await createProject();
    const targetRoot = await createProject();
    try {
      await writeProjectFile(excludedRoot, 'test/Secret.sol', 'contract Secret {}\n');
      await mkdir(absoluteProjectPath(excludedRoot, 'contracts'), { recursive: true });
      await symlink(
        absoluteProjectPath(excludedRoot, 'test/Secret.sol'),
        absoluteProjectPath(excludedRoot, 'contracts/Linked.sol'),
      );
      await writeScopeConfig(excludedRoot, { include: ['**/*.sol'], followSymlinks: true });
      const excluded = await discoverScope(await discoveryInput(excludedRoot));
      expect(excluded.manifest.entries).toEqual([]);
      expect(excluded.observations.candidates).toContainEqual(
        expect.objectContaining({ reason: 'excluded' }),
      );

      await writeProjectFile(targetRoot, 'contracts/other/Outside.sol', 'contract Outside {}\n');
      await mkdir(absoluteProjectPath(targetRoot, 'contracts/subtree'), { recursive: true });
      await symlink(
        absoluteProjectPath(targetRoot, 'contracts/other/Outside.sol'),
        absoluteProjectPath(targetRoot, 'contracts/subtree/Escape.sol'),
      );
      await writeScopeConfig(targetRoot, { sourceRoots: ['contracts'], followSymlinks: true });
      const confined = await discoverScope(await discoveryInput(targetRoot, 'contracts/subtree'));
      expect(confined.manifest.entries).toEqual([]);
      expect(confined.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'PATH_BLOCKED',
          details: expect.arrayContaining([
            expect.objectContaining({ key: 'reason', value: 'outside-target' }),
          ]),
        }),
      );
      expect(confined.complete).toBe(false);
    } finally {
      await Promise.all([removeProject(excludedRoot), removeProject(targetRoot)]);
    }
  });

  it('reports non-Solidity literal targets as incomplete without decoding them', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/notes.txt', 'not Solidity');
      const result = await discoverScope(await discoveryInput(root, 'src/notes.txt'));
      expect(result.manifest.entries).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'TARGET_UNREADABLE' }),
      );
    } finally {
      await removeProject(root);
    }
  });
});

describe('traversal limits', () => {
  it('probes one entry beyond the filesystem allowance and closes without analyzing the prefix', async () => {
    const root = await createProject();
    let closed = false;
    let returned = 0;
    try {
      await writeProjectFile(root, 'contracts/A.sol', 'contract A {}\n');
      await writeProjectFile(root, 'contracts/B.sol', 'contract B {}\n');
      const directoryAdapter: DiscoveryDirectoryAdapter = {
        opendir: async () => ({
          read: async () => {
            returned += 1;
            return returned <= 2 ? fakeFileEntry(returned === 1 ? 'A.sol' : 'B.sol') : null;
          },
          close: async () => {
            closed = true;
          },
        }),
      };
      const input = await discoveryInput(
        root,
        '.',
        testLimits({ maxFsEntries: 1 }),
        directoryAdapter,
      );
      const result = await discoverScope(input);
      expect(returned).toBe(2);
      expect(closed).toBe(true);
      expect(result.observations.counters.filesystemEntries).toBe(2);
      expect(result.observations.counters.sourceBytes).toBe(0);
      expect(result.manifest.entries).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
      );
    } finally {
      await removeProject(root);
    }
  });

  it('stops before scheduling a child directory beyond the configured depth', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/nested/TooDeep.sol', 'contract TooDeep {}\n');
      const result = await discoverScope(
        await discoveryInput(root, '.', testLimits({ maxDirectoryDepth: 1 })),
      );
      expect(result.manifest.entries).toEqual([]);
      expect(result.observations.prunedDirectories).toContainEqual(
        expect.objectContaining({
          path: 'src/nested',
          rule: 'max-directory-depth',
        }),
      );
      expect(result.complete).toBe(false);
    } finally {
      await removeProject(root);
    }
  });
});

describe('reader handoff', () => {
  it('resolves authorized config limit increases before constructing the metadata budget', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'foundry.toml', '[profile.default]\nsrc = "src"\n');
      await writeProjectFile(root, 'src/Source.sol', 'contract Source {}\n');
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          analysis: { limits: { maxFiles: DEFAULT_ANALYSIS_LIMITS.maxFiles * 10 } },
        }),
      );

      const defaults = trustedDefaults();
      const operational = await resolveConfig({ root, defaults });
      const configuredMaxFiles = operational.config.analysis.limits.maxFiles;
      expect(configuredMaxFiles).toBe(DEFAULT_ANALYSIS_LIMITS.maxFiles * 10);
      const budget = createDiscoveryBudget(operational.config.analysis.limits);
      const rootContext = await safePathContext(root);
      const metadata = await readProjectMetadata({ pathContext: rootContext, budget });
      const resolved = await resolveConfig({ root, defaults, metadata: metadata.hints });
      expect(resolved.config.analysis.limits).toEqual(operational.config.analysis.limits);
      expect(() => budget.assertLimitsMatch(resolved.config.analysis.limits)).not.toThrow();
    } finally {
      await removeProject(root);
    }
  });

  it('tightens the metadata bootstrap budget to resolved config limits before discovery', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/Bounded.sol', 'AB');
      await writeProjectFile(root, 'foundry.toml', '[profile.default]\nsrc = "src"\n');
      await writeProjectFile(
        root,
        'audit-estimator.config.json',
        JSON.stringify({
          configVersion: '1.0.0',
          analysis: {
            limits: {
              maxFileBytes: 1,
              maxTotalSourceBytes: 1,
              analysisTimeoutMs: DEFAULT_ANALYSIS_LIMITS.analysisTimeoutMs / 2,
            },
          },
        }),
      );

      const bootstrapLimits = { ...DEFAULT_ANALYSIS_LIMITS };
      const budget = createDiscoveryBudget(bootstrapLimits);
      expect(() =>
        budget.tightenLimits(
          testLimits({ maxFileBytes: DEFAULT_ANALYSIS_LIMITS.maxFileBytes + 1 }),
        ),
      ).toThrow('Resolved analysis limits cannot widen the shared budget.');
      const rootContext = await safePathContext(root);
      const metadata = await readProjectMetadata({ pathContext: rootContext, budget });
      const metadataBytes = budget.counters.metadataBytes;
      expect(metadataBytes).toBeGreaterThan(0);

      const resolved = await resolveConfig({
        root,
        defaults: trustedDefaults(bootstrapLimits),
        metadata: metadata.hints,
      });
      expect(resolved.config.analysis.limits.maxFileBytes).toBe(1);
      expect(resolved.config.analysis.limits.maxTotalSourceBytes).toBe(1);
      const priorDeadline = budget.deadlineAt;
      budget.tightenLimits(resolved.config.analysis.limits);
      expect(budget.limits.maxFileBytes).toBe(1);
      expect(budget.deadlineAt).toBeLessThan(priorDeadline);
      expect(budget.counters.metadataBytes).toBe(metadataBytes);

      const pathContext = await safePathContext(root, {
        target: root,
        followSymlinks: resolved.config.scope.followSymlinks,
      });
      const target = await resolveSafePath({ ...pathContext, budget }, root);
      const result = await discoverScope({
        root: pathContext.root,
        lexicalRoot: pathContext.lexicalRoot,
        target,
        lexicalTarget: root,
        config: resolved.config,
        metadata,
        budget,
        identities: new IdentityRegistry(),
      });
      expect(result.complete).toBe(false);
      expect(result.manifest.entries).toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'LIMIT_EXCEEDED' }),
      );
      expect(budget.counters.sourceBytes).toBe(0);
    } finally {
      await removeProject(root);
    }
  });

  it('rejects discovery configuration that does not match its shared budget', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/Source.sol', 'contract Source {}\n');
      const input = await discoveryInput(root);
      const mismatchedBudget = createDiscoveryBudget(testLimits({ maxFileBytes: 1 }));
      await expect(discoverScope({ ...input, budget: mismatchedBudget })).rejects.toThrow(
        'Discovery configuration limits must match the shared analysis budget.',
      );
    } finally {
      await removeProject(root);
    }
  });

  it('invalidates scoped eligibility when a later context alias conflicts with dependency ownership', async () => {
    const root = await createProject();
    try {
      const source = await writeProjectFile(root, 'src/Shared.sol', 'library Shared {}\n');
      await writeScopeConfig(root, { sourceRoots: ['src'] });
      const input = await discoveryInput(root);
      const result = await discoverScope(input);
      expect(result.manifest.entries).toHaveLength(1);
      const entry = result.manifest.entries[0];
      const snapshot = result.snapshots[0];
      expect(entry).toBeDefined();
      expect(snapshot).toBeDefined();
      if (entry === undefined || snapshot === undefined)
        throw new Error('expected scoped snapshot');
      const identityKey = input.identities.identities()[0]?.identityKey;
      expect(identityKey).toBeDefined();
      if (identityKey === undefined) throw new Error('expected registered identity');

      await mkdir(absoluteProjectPath(root, 'lib'), { recursive: true });
      const dependencyAlias = absoluteProjectPath(root, 'lib/Shared.sol');
      await link(source, dependencyAlias);
      const countersBeforeContext = input.budget.counters;
      const contextSnapshot = await readSource(
        {
          pathContext: {
            root: input.root,
            lexicalRoot: input.lexicalRoot,
            target: input.target.physicalPath,
            lexicalTarget: input.lexicalTarget,
            followSymlinks: input.config.scope.followSymlinks,
          },
          budget: input.budget,
          identities: input.identities,
        },
        dependencyAlias,
      );
      expect(contextSnapshot).toBe(snapshot);
      expect(contextSnapshot.canonicalPath).toBe('src/Shared.sol');
      expect(input.budget.counters.sourceBytes).toBe(countersBeforeContext.sourceBytes);
      expect(input.budget.counters.sourceFiles).toBe(countersBeforeContext.sourceFiles);

      const reevaluation = await reevaluateIdentityOwnership({
        identities: input.identities,
        identityKey,
        scope: input.config.scope,
        metadataPaths: input.metadata.paths,
        scopedFileIds: result.manifest.scopedFileIds,
        budget: input.budget,
      });
      expect(reevaluation).toMatchObject({
        ownership: 'unknown',
        rule: 'conflicting-alias-ownership',
        representativePath: 'src/Shared.sol',
        invalidatedScopedFileIds: [entry.fileId],
        complete: false,
      });
      expect(result.complete && (reevaluation?.complete ?? true)).toBe(false);
    } finally {
      await removeProject(root);
    }
  });

  it('reuses discovery snapshots and cumulative unique-file/source-byte budgets for context reads', async () => {
    const root = await createProject();
    try {
      const scopedPath = await writeProjectFile(root, 'src/Scoped.sol', 'A');
      const contextPath = await writeProjectFile(root, 'src/Context.sol', 'B');
      const copyPath = await writeProjectFile(root, 'src/Copy.sol', 'C');
      await writeScopeConfig(root, {
        sourceRoots: ['src'],
        exclude: ['src/Context.sol', 'src/Copy.sol'],
      });
      const input = await discoveryInput(
        root,
        '.',
        testLimits({ maxFiles: 2, maxTotalSourceBytes: 20 }),
      );
      const result = await discoverScope(input);
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/Scoped.sol']);
      const countersAfterScope = input.budget.counters;
      const reader = {
        pathContext: {
          root: input.root,
          lexicalRoot: input.lexicalRoot,
          target: input.target.physicalPath,
          lexicalTarget: input.lexicalTarget,
          followSymlinks: input.config.scope.followSymlinks,
        },
        budget: input.budget,
        identities: input.identities,
      };
      const cachedScope = await readSource(reader, scopedPath);
      expect(cachedScope).toBe(result.snapshots[0]);
      expect(input.budget.counters.sourceBytes).toBe(countersAfterScope.sourceBytes);
      expect(input.budget.counters.sourceFiles).toBe(countersAfterScope.sourceFiles);

      const contextSnapshot = await readSource(reader, contextPath);
      expect(contextSnapshot.canonicalPath).toBe('src/Context.sol');
      expect(input.budget.counters.sourceFiles).toBe(2);
      await expect(readSource(reader, copyPath)).rejects.toMatchObject({ kind: 'limit' });
      expect(input.budget.counters.sourceFiles).toBe(2);
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['src/Scoped.sol']);

      const byteLimited = await discoveryInput(
        root,
        '.',
        testLimits({ maxFiles: 3, maxTotalSourceBytes: 2 }),
      );
      const byteLimitedResult = await discoverScope(byteLimited);
      const byteReader = {
        pathContext: {
          root: byteLimited.root,
          lexicalRoot: byteLimited.lexicalRoot,
          target: byteLimited.target.physicalPath,
          lexicalTarget: byteLimited.lexicalTarget,
          followSymlinks: byteLimited.config.scope.followSymlinks,
        },
        budget: byteLimited.budget,
        identities: byteLimited.identities,
      };
      await readSource(byteReader, contextPath);
      await expect(readSource(byteReader, copyPath)).rejects.toMatchObject({ kind: 'limit' });
      expect(byteLimited.budget.counters.sourceBytes).toBe(2);
      expect(byteLimitedResult.complete).toBe(true);
    } finally {
      await removeProject(root);
    }
  });

  it('preserves failed selected reads as incomplete observations', async () => {
    const root = await createProject();
    try {
      await writeProjectFile(root, 'src/Unreadable.sol', 'contract Unreadable {}\n');
      const input = await discoveryInput(root);
      const failingAdapter: SafeReadAdapter = {
        open: async () => {
          throw new Error('fixed test failure');
        },
        resolve: resolveSafePath,
      };
      const result = await discoverScope({ ...input, readAdapter: failingAdapter });
      expect(result.manifest.entries).toEqual([]);
      expect(result.complete).toBe(false);
      expect(result.observations.candidates).toContainEqual(
        expect.objectContaining({
          path: 'src/Unreadable.sol',
          reason: 'read-failed',
        }),
      );
      expect(result.observations.counters.failedSourceReads).toBe(1);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'TARGET_UNREADABLE' }),
      );
    } finally {
      await removeProject(root);
    }
  });
});
