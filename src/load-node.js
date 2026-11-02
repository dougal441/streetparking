// Node-only loader for the rules packs (browser code fetches the same JSON files).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (p) => JSON.parse(await readFile(path.join(root, p), 'utf8'));

export async function loadJurisdiction(id = 'au-vic') {
  const [rulesPack, holidays, councils] = await Promise.all([
    readJson(`rules/${id}/rules.json`),
    readJson(`rules/${id}/public-holidays.json`).catch(() => ({ holidays: [] })),
    readJson(`rules/${id}/councils.json`).catch(() => ({ councils: {}, default: {} })),
  ]);
  return { rulesPack, holidays, councils };
}
