import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  entry: {
    index: 'src/index.ts',
    bin: 'src/bin.ts',
  },
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  hash: false,
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  deps: {
    neverBundle: true,
  },
  dts: {
    entry: ['src/index.ts'],
    generator: 'oxc',
  },
});

export default config;
