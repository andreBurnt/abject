/**
 * Mutants -- deliberately broken copies of a candidate, used to test the
 * tests. If the fitness evidence cannot tell a mutant from the real thing,
 * the evidence is too weak to certify a heal.
 */
import * as acorn from 'acorn';

export interface Mutant { source: string; description: string; }

interface Site { start: number; end: number; replacement: string; description: string; }

const FLIP: Record<string, string> = {
  '<': '>=', '>': '<=', '<=': '>', '>=': '<', '===': '!==', '!==': '===', '==': '!=', '!=': '==',
};

export function generateMutants(source: string, max: number): Mutant[] {
  if (max <= 0) return [];
  let ast: acorn.Node;
  try {
    // Handler sources are statement lists; wrap so 'return' parses.
    ast = acorn.parse(`async function __m__(args, http) {${source}\n}`,
      { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
  } catch {
    return [];
  }
  const offset = 'async function __m__(args, http) {'.length;
  const sites: Site[] = [];

  (function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    const n = node as acorn.Node & Record<string, unknown>;
    if (typeof n.type === 'string') {
      if (n.type === 'BinaryExpression' && FLIP[(n as { operator?: string }).operator ?? '']) {
        const op = (n as unknown as { operator: string; left: acorn.Node; right: acorn.Node });
        sites.push({
          start: op.left.end, end: op.right.start,
          replacement: ` ${FLIP[op.operator]} `,
          description: `flip '${op.operator}' to '${FLIP[op.operator]}'`,
        });
      }
      if (n.type === 'CallExpression') {
        const callee = n.callee as (acorn.Node & { type: string; property?: { name?: string }; object?: acorn.Node });
        if (callee?.type === 'MemberExpression' && callee.property?.name === 'filter' && callee.object) {
          sites.push({
            start: (n as acorn.Node).start, end: (n as acorn.Node).end,
            replacement: source.slice(callee.object.start - offset, callee.object.end - offset),
            description: 'drop a .filter(...)',
          });
        }
      }
      if (n.type === 'ReturnStatement') {
        const arg = n.argument as acorn.Node & { type?: string } | null;
        if (arg && arg.type === 'ArrayExpression' && arg.end > arg.start + 2) {
          sites.push({ start: arg.start, end: arg.end, replacement: '[]',
            description: 'return [] instead of the array literal' });
        }
      }
      if (n.type === 'Property') {
        const key = n.key as acorn.Node & { type?: string; value?: unknown };
        if (key?.type === 'Literal' && typeof key.value === 'string') {
          sites.push({ start: key.start, end: key.end, replacement: `'__mutated__'`,
            description: `swap property key '${key.value}'` });
        }
      }
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v);
    }
  })(ast);

  const seen = new Set<string>();
  const mutants: Mutant[] = [];
  for (const s of sites.sort((a, b) => a.start - b.start)) {
    const mutated = source.slice(0, s.start - offset) + s.replacement + source.slice(s.end - offset);
    if (mutated === source || seen.has(mutated)) continue;
    seen.add(mutated);
    mutants.push({ source: mutated, description: s.description });
    if (mutants.length >= max) break;
  }
  return mutants;
}
