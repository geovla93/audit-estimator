import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAnalysisHandler } from '../../src/cli/run.ts';
import { EXIT_CODES } from '../../src/cli/exit-codes.ts';
import type { CliRequest } from '../../src/cli/options.ts';
import { ReportEnvelopeSchema } from '../../src/domain/schemas.ts';
import { createProject, removeProject, writeProjectFile } from '../helpers/filesystem.ts';

const hooks = vi.hoisted(() => ({ failNextRender: false }));

vi.mock('../../src/reporting/json.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/reporting/json.ts')>();
  return {
    ...actual,
    serializeJson: (...args: Parameters<typeof actual.serializeJson>) => {
      if (hooks.failNextRender) {
        hooks.failNextRender = false;
        throw new Error('render failure for test');
      }
      return actual.serializeJson(...args);
    },
  };
});

describe('CLI analysis handler', () => {
  it('keeps the selected model when the report cannot be rendered', async () => {
    const root = await createProject('audit-estimator-cli-run-');
    try {
      await writeProjectFile(
        root,
        'src/A.sol',
        '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract A {\n    uint256 public x;\n}\n',
      );
      await writeProjectFile(
        root,
        'legacy.json',
        JSON.stringify({
          configVersion: '1.0.0',
          model: { profile: 'heuristic-v1', modelVersion: '1.0.0' },
        }),
      );

      let stdout = '';
      let stderr = '';
      const io = {
        stdout: { write: (chunk: string) => (stdout += chunk) },
        stderr: { write: (chunk: string) => (stderr += chunk) },
        cwd: root,
      };
      const request: CliRequest = {
        command: 'estimate',
        input: root,
        configPath: join(root, 'legacy.json'),
        noConfig: false,
        format: 'json',
        force: false,
        allowPartial: false,
        strict: false,
        noColor: true,
        breakdown: false,
      };

      hooks.failNextRender = true;
      const code = await createAnalysisHandler(io)(request);
      expect(code).toBe(EXIT_CODES.internal);
      expect(stderr).toContain('INTERNAL_ERROR');
      const envelope = ReportEnvelopeSchema.parse(JSON.parse(stdout) as unknown);
      expect(envelope.status).toBe('error');
      expect(envelope.failureCategory).toBe('internal');
      expect(envelope.versions.model).toBe('1.0.0');
    } finally {
      hooks.failNextRender = false;
      await removeProject(root);
    }
  });
});
