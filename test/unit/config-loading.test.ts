import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_LIMITS, DEFAULT_SCOPE_SETTINGS } from '../../src/config/defaults.ts';
import {
  loadConfig,
  normalizeConfigPaths,
  resolveConfig,
  selectProjectRoot,
  toRootRelativePath,
} from '../../src/config/load.ts';
import { mergeConfig, type TrustedConfigDefaults } from '../../src/config/merge.ts';
import {
  ConfigError,
  parseConfigInput,
  parseResolvedConfig,
  validateConfigPatterns,
  validatePatternList,
} from '../../src/config/validate.ts';
import type { AnalysisLimits, ConfigInput, ModelProfile } from '../../src/domain/types.ts';

function trustedDefaults(
  limits: AnalysisLimits = { ...DEFAULT_ANALYSIS_LIMITS },
): TrustedConfigDefaults {
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
  return {
    scope: {
      ...DEFAULT_SCOPE_SETTINGS,
      sourceRoots: [],
      include: [],
      exclude: [],
      thirdPartyRoots: [],
      firstPartyOverrides: [],
    },
    imports: { remappings: [] },
    solidity: { version: '0.8.28' },
    analysis: { limits },
    model,
    manualAdjustments: [],
    coverage: { lcovPath: null },
  };
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'audit-estimator-config-unit-'));
}

describe('config validation and precedence', () => {
  it('validates normalized patterns and reports malformed input without echoing values', () => {
    expect(parseConfigInput({ configVersion: '1.0.0', solidity: { version: '0.8.28' } })).toEqual({
      configVersion: '1.0.0',
      solidity: { version: '0.8.28' },
    });
    expect(() =>
      parseConfigInput({ configVersion: '1.0.0', solidity: { version: '0.8' } }),
    ).toThrow(ConfigError);
    expect(() => parseResolvedConfig({ configVersion: '1.0.0' })).toThrow(
      'Resolved configuration is invalid.',
    );

    const config = parseConfigInput({
      configVersion: '1.0.0',
      scope: { include: ['src/**/*.sol', 'vendor/**'] },
    });
    expect(() =>
      validateConfigPatterns(config, { maxPatternsPerList: 1, maxPatternLength: 16 }),
    ).toThrow('A path pattern list exceeds its configured limit.');
    expect(() => validatePatternList(['src/*.sol'], 1, 8)).toThrow('A path pattern is invalid.');
    for (const pattern of [
      '/absolute.sol',
      'C:drive.sol',
      'a/',
      'a\\b',
      'a//b',
      './a',
      '../a',
      'a**b',
      'a{b}',
      'a\nb',
    ]) {
      expect(() => validatePatternList([pattern], 1, 512)).toThrow('A path pattern is invalid.');
    }
    expect(() => validatePatternList(['😀'], 1, 1)).toThrow('A path pattern is invalid.');
    expect(() => validatePatternList(['a.sol'], 1, 5)).not.toThrow();
    expect(() =>
      validateConfigPatterns(
        { configVersion: '1.0.0' },
        { maxPatternsPerList: 0, maxPatternLength: 0 },
      ),
    ).not.toThrow();
  });

  it('merges metadata, file and CLI values with field-level provenance and isolated defaults', () => {
    const defaults = trustedDefaults();
    const metadata = {
      scope: {
        sourceRoots: ['src'],
        include: ['src/**/*.sol'],
        exclude: ['src/generated/**'],
        defaultExcludes: false,
        thirdPartyRoots: ['vendor'],
        firstPartyOverrides: ['vendor/local'],
        followSymlinks: true,
      },
      imports: { remappings: [{ prefix: '@lib/', target: 'lib' }] },
      solidity: { version: '0.8.24' },
    } as const;
    const fileConfig: ConfigInput = {
      configVersion: '1.0.0',
      scope: { sourceRoots: ['contracts'], followSymlinks: false },
      imports: { remappings: [{ context: 'contracts', prefix: '@app/', target: 'src' }] },
      solidity: { version: '0.8.28' },
      analysis: { limits: { ...DEFAULT_ANALYSIS_LIMITS, maxFiles: 100, maxPatternLength: 200 } },
      model: {
        profile: 'heuristic-v1',
        modelVersion: '1.0.0',
        parameters: {
          projectHours: { low: 1, high: 2 },
          slocHours: { low: 0.002, high: 0.003 },
          controlPremium: { low: 0.2, high: 0.3 },
          storagePremium: { low: 0.3, high: 0.4 },
          evmPremium: { low: 0.4, high: 0.5 },
          interactionHours: { low: 0.5, high: 0.75 },
          boundaryHours: { low: 0.75, high: 1 },
          unknownReserveHigh: 0.75,
          hoursPerDay: 7,
        },
      },
      manualAdjustments: [
        { id: 'review', reason: 'bounded case', category: 'manual', lowHours: 1, highHours: 2 },
      ],
      coverage: { lcovPath: 'coverage/lcov.info' },
      report: { format: 'markdown' },
    };
    const result = mergeConfig({
      defaults,
      metadata,
      fileConfig,
      cli: {
        include: ['contracts/**/*.sol'],
        exclude: ['contracts/generated/**'],
        solidityVersion: '0.8.30',
        format: 'json',
      },
    });

    expect(result.config.scope.sourceRoots).toEqual(['contracts']);
    expect(result.config.scope.include).toEqual(['contracts/**/*.sol']);
    expect(result.config.scope.exclude).toEqual(['contracts/generated/**']);
    expect(result.config.scope.defaultExcludes).toBe(false);
    expect(result.config.scope.followSymlinks).toBe(false);
    expect(result.config.imports.remappings).toEqual(fileConfig.imports?.remappings);
    expect(result.config.solidity.version).toBe('0.8.30');
    expect(result.config.analysis.limits.maxFiles).toBe(100);
    expect(result.config.model.parameters).toEqual(fileConfig.model?.parameters);
    expect(result.config.manualAdjustments).toEqual(fileConfig.manualAdjustments);
    expect(result.config.coverage.lcovPath).toBe('coverage/lcov.info');
    expect(result.config.report.format).toBe('json');
    expect(
      result.config.provenance.find((item) => item.field === 'scope.sourceRoots')?.source,
    ).toBe('config');
    expect(result.config.provenance.find((item) => item.field === 'scope.include')?.source).toBe(
      'cli',
    );
    expect(
      result.config.provenance.find((item) => item.field === 'analysis.limits.maxFiles')?.source,
    ).toBe('config');
    expect(result.config.provenance.map((item) => item.field)).toEqual(
      result.config.provenance
        .map((item) => item.field)
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(result.semanticHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(defaults.scope.sourceRoots).toEqual([]);
    expect(defaults.model.parameters.projectHours).toEqual({ low: 0.5, high: 1 });
    const omittedOptions = mergeConfig({
      defaults,
      fileConfig: {
        configVersion: '1.0.0',
        analysis: { limits: {} },
        model: { profile: 'heuristic-v1', parameters: {} },
      },
      cli: {},
    });
    expect(omittedOptions.config.model.modelVersion).toBe('1.0.0');
    expect(omittedOptions.config.scope.defaultExcludes).toBe(true);
    expect(
      mergeConfig({ defaults, cli: { exclude: ['generated/**'] } }).config.scope.include,
    ).toEqual([]);
    const unsupportedCli = { include: ['**/*.sol'], unsupported: true };
    expect(() => mergeConfig({ defaults, cli: unsupportedCli })).toThrow(ConfigError);
  });
});

describe('config path and filesystem loading', () => {
  it.skipIf(process.platform === 'win32')(
    'loads bounded JSON, handles absent/no-config modes, and confines normalized paths',
    async () => {
      const root = await project();
      const outside = await project();
      try {
        await mkdir(join(root, 'contracts'), { recursive: true });
        await mkdir(join(root, 'vendor'), { recursive: true });
        await mkdir(join(root, 'overrides'), { recursive: true });
        await mkdir(join(root, 'lib'), { recursive: true });
        await mkdir(join(root, 'coverage'), { recursive: true });
        const physicalRoot = await realpath(root);
        expect(await loadConfig({ root, noConfig: true })).toEqual({
          input: null,
          directory: physicalRoot,
        });
        await expect(
          loadConfig({ root, noConfig: true, configPath: 'forced.json' }),
        ).rejects.toThrow('Explicit configuration cannot be combined with --no-config.');
        expect(await loadConfig({ root })).toEqual({ input: null, directory: physicalRoot });

        const config = '{"configVersion":"1.0.0","scope":{"sourceRoots":["contracts"]}}';
        await writeFile(
          join(root, 'audit-estimator.config.json'),
          config + ' '.repeat(256 * 1024 - Buffer.byteLength(config)),
        );
        expect((await loadConfig({ root })).input?.scope?.sourceRoots).toEqual(['contracts']);
        await writeFile(
          join(root, 'audit-estimator.config.json'),
          Buffer.alloc(256 * 1024 + 1, 0x20),
        );
        await expect(loadConfig({ root })).rejects.toThrow('256 KiB limit');
        await writeFile(join(root, 'audit-estimator.config.json'), Buffer.from([0xc3, 0x28]));
        await expect(loadConfig({ root })).rejects.toThrow('valid UTF-8');
        await writeFile(join(root, 'audit-estimator.config.json'), '{');
        await expect(loadConfig({ root })).rejects.toThrow('valid JSON');
        await writeFile(
          join(root, 'audit-estimator.config.json'),
          '{"configVersion":"1.0.0","unknown":true}',
        );
        await expect(loadConfig({ root })).rejects.toThrow('Configuration data is invalid.');

        await writeFile(join(outside, 'external.json'), '{"configVersion":"1.0.0"}');
        await rm(join(root, 'audit-estimator.config.json'));
        await symlink(join(outside, 'external.json'), join(root, 'audit-estimator.config.json'));
        await expect(loadConfig({ root })).rejects.toThrow('cannot be symbolic links');
        expect(
          (await loadConfig({ root, configPath: join(root, 'audit-estimator.config.json') })).input
            ?.configVersion,
        ).toBe('1.0.0');

        await symlink(outside, join(root, 'external'));
        await expect(
          toRootRelativePath(physicalRoot, physicalRoot, 'external/missing.sol'),
        ).rejects.toThrow('A configured path is outside the project root.');
        expect(
          await toRootRelativePath(physicalRoot, physicalRoot, 'contracts/not-created.sol'),
        ).toBe('contracts/not-created.sol');
        const normalized = await normalizeConfigPaths(
          parseConfigInput({
            configVersion: '1.0.0',
            scope: {
              sourceRoots: ['contracts'],
              thirdPartyRoots: ['vendor'],
              firstPartyOverrides: ['overrides'],
            },
            imports: { remappings: [{ context: 'contracts', prefix: '@lib/', target: 'lib' }] },
            coverage: { lcovPath: 'coverage/lcov.info' },
          }),
          physicalRoot,
          physicalRoot,
        );
        expect(normalized.scope?.sourceRoots).toEqual(['contracts']);
        expect(normalized.scope?.thirdPartyRoots).toEqual(['vendor']);
        expect(normalized.scope?.firstPartyOverrides).toEqual(['overrides']);
        expect(normalized.imports?.remappings).toEqual([
          { context: 'contracts', prefix: '@lib/', target: 'lib' },
        ]);
        expect(normalized.coverage?.lcovPath).toBe('coverage/lcov.info');

        await expect(loadConfig({ root: join(root, 'does-not-exist') })).rejects.toThrow(
          'could not be resolved',
        );
        await writeFile(join(root, 'regular-file'), 'data');
        await expect(loadConfig({ root: join(root, 'regular-file') })).rejects.toThrow(
          'not a directory',
        );
        await expect(
          loadConfig({ root, configPath: join(root, 'missing-explicit.json') }),
        ).rejects.toThrow('could not be opened');
        await mkdir(join(root, 'directory-config'));
        await expect(
          loadConfig({ root, configPath: join(root, 'directory-config') }),
        ).rejects.toThrow('not a regular file');
        await symlink(join(outside, 'missing-target.json'), join(root, 'broken-link.json'));
        await expect(
          loadConfig({ root, configPath: join(root, 'broken-link.json') }),
        ).rejects.toThrow('could not be resolved');
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('selects and validates explicit project roots and resolves config-relative paths', async () => {
    const root = await project();
    const outside = await project();
    try {
      await mkdir(join(root, 'nested'), { recursive: true });
      await writeFile(join(root, 'nested', 'input.sol'), 'contract A {}');
      await writeFile(
        join(root, 'audit-estimator.config.json'),
        JSON.stringify({
          configVersion: '1.0.0',
          coverage: { lcovPath: 'coverage/lcov.info' },
          report: { format: 'markdown' },
        }),
      );
      await mkdir(join(root, 'coverage'));
      const physicalRoot = await realpath(root);
      await expect(selectProjectRoot(join(root, 'nested', 'input.sol'))).resolves.toBe(
        join(physicalRoot, 'nested'),
      );
      await expect(selectProjectRoot(root)).resolves.toBe(physicalRoot);
      await expect(selectProjectRoot('nested', root, root)).resolves.toBe(physicalRoot);
      await expect(selectProjectRoot(join(root, 'nested', 'input.sol'), root, root)).resolves.toBe(
        physicalRoot,
      );
      await expect(selectProjectRoot('../outside', root, root)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
      });
      await expect(selectProjectRoot('missing.sol', root, root)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
      });
      await expect(selectProjectRoot(root, outside, root)).rejects.toMatchObject({
        code: 'TARGET_UNREADABLE',
      });

      const resolved = await resolveConfig({ root, defaults: trustedDefaults() });
      expect(resolved.root).toBe(physicalRoot);
      expect(resolved.configFileLoaded).toBe(true);
      expect(resolved.config.coverage.lcovPath).toBe('coverage/lcov.info');
      expect(resolved.config.report.format).toBe('markdown');
      const noConfig = await resolveConfig({ root, noConfig: true, defaults: trustedDefaults() });
      expect(noConfig.configFileLoaded).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
