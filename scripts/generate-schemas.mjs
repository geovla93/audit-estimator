import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsdown';
import { format } from 'oxfmt';
import { z } from 'zod';

const mode = process.argv[2];
if (mode !== 'generate' && mode !== 'check') {
  throw new Error('Usage: node scripts/generate-schemas.mjs generate|check');
}
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, '.vitest'), { recursive: true });
const temp = await mkdtemp(join(root, '.vitest', 'schemas-'));
try {
  await build({
    config: false,
    entry: {
      'domain-schemas': join(root, 'src/domain/schemas.ts'),
      'domain-canonical': join(root, 'src/domain/canonical.ts'),
    },
    outDir: temp,
    format: 'esm',
    platform: 'node',
    clean: false,
    dts: false,
    deps: { neverBundle: true },
  });
  const { ConfigInputSchema, ReportEnvelopeSchema, ModelProfileSchema } = await import(
    pathToFileURL(join(temp, 'domain-schemas.mjs')).href
  );
  const { canonicalJson } = await import(pathToFileURL(join(temp, 'domain-canonical.mjs')).href);
  const targets = [
    ['config-v1.schema.json', ConfigInputSchema],
    ['result-v1.schema.json', ReportEnvelopeSchema],
    ['model-v1.schema.json', ModelProfileSchema],
  ];
  if (mode === 'generate') await mkdir(join(root, 'schemas'), { recursive: true });
  for (const [name, schema] of targets) {
    const jsonSchema = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      unrepresentable: 'throw',
    });
    const canonical = JSON.parse(
      canonicalJson({ ...jsonSchema, $id: `urn:audit-estimator:${name}` }),
    );
    const preliminary = `${JSON.stringify(canonical, null, 2)}\n`;
    const formatted = await format(name, preliminary, {
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
    });
    if (formatted.errors.length > 0) throw new Error(`Cannot format generated schema: ${name}`);
    const contents = formatted.code;
    const destination = join(root, 'schemas', name);
    if (mode === 'generate') {
      await writeFile(destination, contents, 'utf8');
    } else {
      const committed = await readFile(destination, 'utf8');
      if (committed !== contents) throw new Error(`Schema drift: ${name}`);
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
