import * as acorn from 'acorn';
import { generateMutants } from '../src/protocol/mutants.js';

const cases = [
  { name: 'Canonical ({ ... })', code: '({\n  async get(msg) { return 1; }\n})' },
  { name: 'Parenthesized with trailing semicolon ({ ... });', code: '({\n  async get(msg) { return 1; }\n});' },
  { name: 'Bare braces { ... }', code: '{\n  async get(msg) { return 1; }\n}' },
  { name: 'Bare braces with trailing semicolon { ... };', code: '{\n  async get(msg) { return 1; }\n};' },
  { name: 'export default ({ ... })', code: 'export default ({\n  async get(msg) { return 1; }\n});' },
  { name: 'module.exports = ({ ... })', code: 'module.exports = ({\n  async get(msg) { return 1; }\n});' },
  { name: 'Leading comment /* ... */ ({ ... })', code: '/* A weather fetcher */\n({\n  async get(msg) { return 1; }\n})' },
];

console.log('Testing dialect variations:');
for (const c of cases) {
  const mutants = generateMutants(c.code, 12);
  const isNull = mutants === null;
  console.log(`- ${c.name}: ${isNull ? '❌ NULL (FAILED)' : `✅ Parsed (${mutants?.length} mutants)`}`);
}
