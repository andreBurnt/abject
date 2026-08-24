import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateMutants } from '../src/protocol/mutants.js';
import { GOALS } from './run_a1_corpus.js';

const CORPUS_DIR = path.resolve(process.cwd(), 'lab/corpus');

console.log('Uncapped mutation site analysis across 20 real model corpus sources:');
console.log('| ID | Name | Source Chars | Lines | Uncapped Sites | Sites by Type (flip / filter / array / prop) |');
console.log('| :--- | :--- | :---: | :---: | :---: | :--- |');

const allCounts: number[] = [];

for (const g of GOALS) {
  const p = path.join(CORPUS_DIR, `${g.id}.json`);
  if (!fs.existsSync(p)) continue;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const source = data.extracted;
  const mutants = generateMutants(source, 1000) || [];
  allCounts.push(mutants.length);

  const flips = mutants.filter(m => m.description.startsWith('flip')).length;
  const filters = mutants.filter(m => m.description.includes('filter')).length;
  const arrays = mutants.filter(m => m.description.includes('array')).length;
  const props = mutants.filter(m => m.description.startsWith('swap property')).length;

  const lines = source.split('\n').length;
  console.log(`| ${g.id} | ${g.name} | ${source.length} | ${lines} | ${mutants.length} | flips: ${flips}, filter: ${filters}, array: ${arrays}, prop: ${props} |`);
}

allCounts.sort((a, b) => a - b);
const min = allCounts[0];
const max = allCounts[allCounts.length - 1];
const median = allCounts[Math.floor(allCounts.length / 2)];
const mean = (allCounts.reduce((s, n) => s + n, 0) / allCounts.length).toFixed(1);

console.log(`\nUncapped Distribution: min=${min}, max=${max}, median=${median}, mean=${mean}`);
