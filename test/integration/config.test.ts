import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  AnalysisLimits,
  ManualAdjustment,
  ModelProfile,
  Remapping,
  ScopeSettings,
} from '../../src/domain/types.ts';
import { DEFAULT_ANALYSIS_LIMITS, DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import { loadConfig, resolveConfig, selectProjectRoot } from '../../src/config/load.ts';
import type { TrustedConfigDefaults } from '../../src/config/merge.ts';
import { ConfigError } from '../../src/config/validate.ts';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/config/', import.meta.url));

function trustedDefaults(): TrustedConfigDefaults {
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
  const limits: AnalysisLimits = { ...DEFAULT_ANALYSIS_LIMITS };
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

async function makeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'audit-estimator-config-'));
  await mkdir(join(root, 'contracts'), { recursive: true });
  await mkdir(join(root, 'lib', 'vendor'), { recursive: true });
  await mkdir(join(root, 'lib', 'custom'), { recursive: true });
  await mkdir(join(root, 'coverage'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  return root;
}

async function removeProject(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

async function copyFixture(
  root: string,
  name: string,
  destination = 'audit-estimator.config.json',
) {
  const content = await readFile(join(fixtureDirectory, name), 'utf8');
  const path = join(root, destination);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe('configuration safe load', () => {
  it('loads only the bounded automatic JSON file and permits an absent automatic file', async () => {
    const root = await makeProject();
    try {
      await writeFile(
        join(root, 'audit-estimator.config.js'),
        "throw new Error('must stay inert');\n",
      );
      expect(await loadConfig({ root })).toEqual({ input: null, directory: await realpath(root) });

      await copyFixture(root, 'valid.json');
      const loaded = await loadConfig({ root });
      expect(loaded.input?.configVersion).toBe('1.0.0');
      expect(loaded.input?.scope?.sourceRoots).toEqual(['contracts']);
    } finally {
      await removeProject(root);
    }
  });

  it('rejects symlinked automatic files, missing explicit files, malformed data, and unsafe encodings', async () => {
    const root = await makeProject();
    const elsewhere = await mkdtemp(join(tmpdir(), 'audit-estimator-config-link-'));
    try {
      const externalConfig = join(elsewhere, 'outside.json');
      await writeFile(externalConfig, '{"configVersion":"1.0.0"}');
      await symlink(externalConfig, join(root, 'audit-estimator.config.json'));
      await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

      await rm(join(root, 'audit-estimator.config.json'));
      await expect(
        loadConfig({ root, configPath: join(root, 'missing.json') }),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      await expect(
        loadConfig({ root, configPath: join(root, 'missing.json'), noConfig: true }),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

      await writeFile(join(root, 'audit-estimator.config.json'), '{"secretMarker":"do-not-echo"');
      await expect(loadConfig({ root })).rejects.toThrow('Configuration file is not valid JSON.');
      await expect(loadConfig({ root })).rejects.not.toThrow('do-not-echo');

      await writeFile(join(root, 'audit-estimator.config.json'), Buffer.from([0xc3, 0x28]));
      await expect(loadConfig({ root })).rejects.toThrow('Configuration file is not valid UTF-8.');
    } finally {
      await removeProject(root);
      await removeProject(elsewhere);
    }
  });

  it('rejects oversized, unknown, prototype-like, unsupported-version, and escaping path data', async () => {
    const root = await makeProject();
    try {
      await writeFile(
        join(root, 'audit-estimator.config.json'),
        Buffer.alloc(256 * 1024 + 1, 0x20),
      );
      await expect(loadConfig({ root })).rejects.toThrow('256 KiB limit');

      for (const fixture of ['unknown-field.json', 'unsupported-version.json']) {
        await copyFixture(root, fixture);
        await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      }

      await writeFile(
        join(root, 'audit-estimator.config.json'),
        '{"configVersion":"1.0.0","scope":{"sourceRoots":["../outside"]}}',
      );
      await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

      await writeFile(
        join(root, 'audit-estimator.config.json'),
        '{"configVersion":"1.0.0","__proto__":{"polluted":true}}',
      );
      await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

      for (const invalidConfig of [
        { configVersion: '1.0.0', scope: { include: null } },
        { configVersion: '1.0.0', analysis: { limits: { maxFiles: 20_001 } } },
        { configVersion: '1.0.0', analysis: { limits: { maxGlobStates: 100_000_001 } } },
        { configVersion: '1.0.0', solidity: { version: '0.8' } },
      ]) {
        await writeFile(join(root, 'audit-estimator.config.json'), JSON.stringify(invalidConfig));
        await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      }
    } finally {
      await removeProject(root);
    }
  });

  it('physically confines source, remapping, and coverage paths and keeps accepted paths root-relative', async () => {
    const root = await makeProject();
    const outside = await mkdtemp(join(tmpdir(), 'audit-estimator-config-outside-'));
    try {
      await symlink(outside, join(root, 'external-link'));
      const escapingConfigs = [
        { configVersion: '1.0.0', scope: { sourceRoots: ['external-link'] } },
        {
          configVersion: '1.0.0',
          imports: { remappings: [{ prefix: '@external/', target: 'external-link' }] },
        },
        { configVersion: '1.0.0', coverage: { lcovPath: 'external-link/lcov.info' } },
      ];
      for (const config of escapingConfigs) {
        await writeFile(join(root, 'audit-estimator.config.json'), JSON.stringify(config));
        await expect(resolveConfig({ root, defaults: trustedDefaults() })).rejects.toBeInstanceOf(
          ConfigError,
        );
      }

      await copyFixture(root, 'valid.json');
      const resolved = await resolveConfig({ root, defaults: trustedDefaults() });
      const canonicalRoot = await realpath(root);
      expect(resolved.root).toBe(canonicalRoot);
      expect(resolved.config.scope.sourceRoots).toEqual(['contracts']);
      expect(resolved.config.scope.firstPartyOverrides).toEqual(['lib/custom']);
      expect(resolved.config.imports.remappings[0]?.target).toBe('lib/vendor');
      expect(resolved.config.coverage.lcovPath).toBe('coverage/lcov.info');
      expect(relative(canonicalRoot, resolved.root)).toBe('');
    } finally {
      await removeProject(root);
      await removeProject(outside);
    }
  });

  it('uses only the selected root, resolves config paths from the config directory, and allows explicit external symlinks', async () => {
    const root = await makeProject();
    const outside = await mkdtemp(join(tmpdir(), 'audit-estimator-config-external-'));
    try {
      await writeFile(
        join(root, 'audit-estimator.config.json'),
        '{"configVersion":"1.0.0","report":{"format":"markdown"}}',
      );
      const nestedRoot = join(root, 'contracts');
      expect(await loadConfig({ root: nestedRoot })).toEqual({
        input: null,
        directory: await realpath(nestedRoot),
      });

      await mkdir(join(root, 'settings', 'contracts'), { recursive: true });
      await mkdir(join(root, 'settings', 'coverage'), { recursive: true });
      const explicitConfig = join(root, 'settings', 'audit.json');
      await writeFile(
        explicitConfig,
        JSON.stringify({
          configVersion: '1.0.0',
          scope: { sourceRoots: ['contracts'] },
          coverage: { lcovPath: 'coverage/lcov.info' },
        }),
      );
      const resolved = await resolveConfig({
        root,
        configPath: explicitConfig,
        defaults: trustedDefaults(),
      });
      expect(resolved.config.scope.sourceRoots).toEqual(['settings/contracts']);
      expect(resolved.config.coverage.lcovPath).toBe('settings/coverage/lcov.info');

      const externalConfig = join(outside, 'external.json');
      await writeFile(externalConfig, '{"configVersion":"1.0.0","report":{"format":"json"}}');
      const explicitLink = join(root, 'explicit-link.json');
      await symlink(externalConfig, explicitLink);
      const externalResolved = await resolveConfig({
        root,
        configPath: explicitLink,
        defaults: trustedDefaults(),
      });
      expect(externalResolved.config.report.format).toBe('json');

      await writeFile(
        externalConfig,
        '{"configVersion":"1.0.0","scope":{"sourceRoots":["contracts"]}}',
      );
      await expect(
        resolveConfig({ root, configPath: externalConfig, defaults: trustedDefaults() }),
      ).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await removeProject(root);
      await removeProject(outside);
    }
  });

  it('selects a file parent or directory root and rejects an override that excludes the input', async () => {
    const root = await makeProject();
    const outside = await mkdtemp(join(tmpdir(), 'audit-estimator-target-outside-'));
    try {
      const targetFile = join(root, 'contracts', 'Token.sol');
      await writeFile(targetFile, 'contract Token {}');
      const canonicalRoot = await realpath(root);
      const canonicalContracts = await realpath(join(root, 'contracts'));
      expect(await selectProjectRoot(join(root, 'contracts'), undefined, root)).toBe(
        canonicalContracts,
      );
      expect(await selectProjectRoot(targetFile, undefined, root)).toBe(canonicalContracts);
      expect(await selectProjectRoot(targetFile, root, root)).toBe(canonicalRoot);
      await expect(
        selectProjectRoot(join(outside, 'Missing.sol'), root, root),
      ).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
      });
    } finally {
      await removeProject(root);
      await removeProject(outside);
    }
  });
});

describe('configuration precedence', () => {
  it('applies defaults, metadata, file, and explicit CLI in order with field provenance', async () => {
    const root = await makeProject();
    try {
      await copyFixture(root, 'valid.json');
      const resolved = await resolveConfig({
        root,
        defaults: trustedDefaults(),
        metadata: {
          scope: {
            sourceRoots: ['src'],
            include: ['metadata/**/*.sol'],
            defaultExcludes: false,
          },
          solidity: { version: '0.8.20' },
        },
        cli: {
          include: ['cli/**/*.sol'],
          exclude: ['cli-exclude/**'],
          solidityVersion: '0.8.29',
          format: 'markdown',
        },
      });

      expect(resolved.config.scope.sourceRoots).toEqual(['contracts']);
      expect(resolved.config.scope.include).toEqual(['cli/**/*.sol']);
      expect(resolved.config.scope.exclude).toEqual(['cli-exclude/**']);
      expect(resolved.config.scope.defaultExcludes).toBe(true);
      expect(resolved.config.solidity.version).toBe('0.8.29');
      expect(resolved.config.analysis.limits.maxFiles).toBe(1_500);
      expect(resolved.config.analysis.limits.maxGlobStates).toBe(15_000_000);
      expect(resolved.config.model.parameters.unknownReserveHigh).toBe(0);
      expect(resolved.config.report.format).toBe('markdown');
      expect(resolved.config.provenance).toContainEqual({
        field: 'scope.sourceRoots',
        source: 'config',
      });
      expect(resolved.config.provenance).toContainEqual({ field: 'scope.include', source: 'cli' });
      expect(resolved.config.provenance).toContainEqual({
        field: 'scope.defaultExcludes',
        source: 'config',
      });
      expect(resolved.config.provenance).toContainEqual({
        field: 'solidity.version',
        source: 'cli',
      });
      expect(resolved.config.provenance).toContainEqual({
        field: 'model.parameters.unknownReserveHigh',
        source: 'config',
      });
    } finally {
      await removeProject(root);
    }
  });

  it('replaces arrays, preserves absent CLI values, and hashes only semantic settings', async () => {
    const root = await makeProject();
    try {
      await copyFixture(root, 'valid.json');
      const base = await resolveConfig({ root, defaults: trustedDefaults() });
      const formatOnly = await resolveConfig({
        root,
        defaults: trustedDefaults(),
        cli: { format: 'markdown' },
      });
      const includeOverride = await resolveConfig({
        root,
        defaults: trustedDefaults(),
        cli: { include: ['only-cli.sol'] },
      });

      expect(base.config.scope.include).toEqual(['src/**/*.sol']);
      expect(formatOnly.config.scope.include).toEqual(['src/**/*.sol']);
      expect(formatOnly.config.report.format).toBe('markdown');
      expect(formatOnly.semanticHash).toBe(base.semanticHash);
      expect(includeOverride.config.scope.include).toEqual(['only-cli.sol']);
      expect(includeOverride.semanticHash).not.toBe(base.semanticHash);
    } finally {
      await removeProject(root);
    }
  });

  it('rejects unsupported pattern syntax and invalid metadata even when later layers would replace it', async () => {
    const root = await makeProject();
    try {
      const defaults = trustedDefaults();
      for (const pattern of [
        '!secret.sol',
        '{src,lib}/**/*.sol',
        '[a-z].sol',
        'C:/contracts/*.sol',
        'a**b.sol',
      ]) {
        await writeFile(
          join(root, 'audit-estimator.config.json'),
          JSON.stringify({ configVersion: '1.0.0', scope: { include: [pattern] } }),
        );
        await expect(
          resolveConfig({ root, defaults, cli: { include: ['valid.sol'] } }),
        ).rejects.toBeInstanceOf(ConfigError);
      }

      await writeFile(
        join(root, 'audit-estimator.config.json'),
        '{"configVersion":"1.0.0","scope":{"include":["file-config.sol"]}}',
      );
      const invalidMetadata = {
        scope: Object.assign({ include: ['metadata.sol'] }, { unrecognizedField: true }),
      };
      await expect(
        resolveConfig({
          root,
          defaults,
          metadata: invalidMetadata,
          cli: { include: ['cli.sol'] },
        }),
      ).rejects.toBeInstanceOf(ConfigError);

      const invalidMetadataGlob = { scope: { include: ['bad/**a*'] } };
      await expect(
        resolveConfig({
          root,
          defaults,
          metadata: invalidMetadataGlob,
          cli: { include: ['cli.sol'] },
        }),
      ).rejects.toBeInstanceOf(ConfigError);

      const invalidCli = Object.assign({ include: ['cli.sol'] }, { unrecognizedField: true });
      await expect(resolveConfig({ root, defaults, cli: invalidCli })).rejects.toBeInstanceOf(
        ConfigError,
      );
    } finally {
      await removeProject(root);
    }
  });
});
