import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';

const publishedAssets = new URL('https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/assets/');
const manifest = JSON.parse(await readFile(new URL('./vehicle-assets.json', import.meta.url), 'utf8'));
const directory = new URL('../public/assets/', import.meta.url);
await mkdir(directory, {recursive: true});

const matches = (bytes, expected) => createHash('sha256').update(bytes).digest('hex') === expected;
for (const [name, expected] of Object.entries(manifest)) {
  const output = new URL(name, directory);
  const existing = await readFile(output).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && matches(existing, expected)) continue;
  if (existing) throw new Error(name + ' already exists with a different hash. Back up your local version before replacing it.');

  const source = new URL(name, publishedAssets);
  const response = await fetch(source, {signal: AbortSignal.timeout(60_000)});
  if (!response.ok) throw new Error(source + ' returned HTTP ' + response.status + '. See THIRD_PARTY_NOTICES.md for local setup.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!matches(bytes, expected)) throw new Error(name + ' differs from the published SHA-256 manifest.');
  await writeFile(output, bytes, {flag: 'wx'});
  console.log('Verified ' + name);
}
