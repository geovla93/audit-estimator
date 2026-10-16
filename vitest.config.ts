import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'test/integration/**/*.test.ts',
            'test/e2e/**/*.test.ts',
            'test/research/**/*.test.ts',
          ],
          environment: 'node',
          // These suites spawn Node.js children (CLI runs, parser workers); a single spawn can take
          // seconds on shared Windows runners, so the default five-second limit is not a hang guard.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'package',
          include: ['test/package/**/*.test.ts'],
          environment: 'node',
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        autoUpdate: false,
        perFile: false,
        'src/estimation/**': { lines: 95, branches: 90, perFile: false },
        'src/metrics/**': { lines: 95, branches: 90, perFile: false },
        'src/config/**': { lines: 90, branches: 85, perFile: false },
        'src/discovery/**': { lines: 90, branches: 85, perFile: false },
      },
    },
  },
});

export default config;
