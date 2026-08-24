/**
 * Manifest contract fields are optional and preserved.
 * Run: pnpm tsx --test src/core/manifest-contract.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MethodDeclaration, RelationDeclaration, MethodEffect } from './types.js';

test('a legacy method declaration without contract fields is valid', () => {
  const m: MethodDeclaration = {
    name: 'listEvents', description: 'list', parameters: [],
  };
  assert.equal(m.effects, undefined);
});

test('contract fields round-trip', () => {
  const relations: RelationDeclaration[] = [
    { kind: 'subset-on-tighter-filter', field: 'from' },
    { kind: 'sorted-by', field: 'startsAt' },
    { kind: 'non-empty-for-known-entity' },
  ];
  const effects: MethodEffect = 'read';
  const m: MethodDeclaration = {
    name: 'listEvents', description: 'list', parameters: [],
    effects,
    outputSchema: { type: 'array', items: { type: 'object' } },
    relations,
    knownEntity: 'Weekly Standup',
  };
  assert.equal(m.effects, 'read');
  assert.equal(m.relations?.length, 3);
  assert.equal(m.knownEntity, 'Weekly Standup');
});
