/**
 * A stopped CassetteRecorder must not keep re-arming its flush: on the
 * recorder as merged, a flush pending at stop() fails with "Object stopped",
 * re-arms, and keeps the process alive forever.
 *   pnpm tsx --test src/objects/cassette-recorder.flush.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Abject } from '../core/abject.js';
import { event } from '../core/message.js';
import type { AbjectMessage, TypeId } from '../core/types.js';
import { MessageBus } from '../runtime/message-bus.js';
import { Registry } from './registry.js';
import { CassetteRecorder } from './cassette-recorder.js';

class Endpoint extends Abject {
  constructor(name: string) {
    super({ manifest: { name, version: '1', description: 'fixture',
      interface: { id: `fixture:${name}`, name, description: 'fixture', methods: [] } } });
  }
  post(message: AbjectMessage): void { this.send(message); }
}

class MemoryStorage extends Endpoint {
  constructor() { super('Storage'); this.on('get', () => null); this.on('set', () => true); }
}

type Timer = ReturnType<typeof setTimeout>;
/** The recorder's armed flush timers: one map per type on the recorder as
 *  merged, one `flushTimer` per storage row once rows are generalised. */
type FlushInternals = { flushTimers?: Map<string, Timer>; rows?: Map<string, { flushTimer?: Timer }>; armFlush: (...a: unknown[]) => void };
const armed = (r: FlushInternals): Timer[] => r.flushTimers
  ? [...r.flushTimers.values()]
  : [...r.rows!.values()].flatMap(row => row.flushTimer ? [row.flushTimer] : []);

test('stop() with a flush pending leaves no flush timer behind, and none re-arms', async () => {
  const bus = new MessageBus(), registry = new Registry();
  await registry.init(bus);
  const add = async <T extends Abject>(o: T, typeId?: TypeId): Promise<T> => {
    o.setRegistryHint(registry.id); await o.init(bus);
    registry.registerObject(o.id, o.manifest, undefined, undefined, undefined, undefined, typeId); return o;
  };
  await add(new MemoryStorage());
  const recorder = await add(new CassetteRecorder({ flushMs: 20 }));
  const http = await add(new Endpoint('HttpClient'), 'peer1/system/HttpClient' as TypeId);
  const cal = await add(new Endpoint('Calendar'), 'peer1/ws1/user/Calendar' as TypeId);
  const internals = recorder as unknown as FlushInternals;
  try {
    http.post(event(http.id, recorder.id, 'httpExchange', { caller: cal.id,
      request: { method: 'GET', url: 'https://x.test/e' }, response: { status: 200, bodyText: '[1]' }, durationMs: 1, at: 5 }));
    await new Promise(r => setTimeout(r, 5)); // the exchange is recorded and its flush armed
    assert.equal(armed(internals).length, 1, 'a flush is pending when stop() is called');
    await recorder.stop();
    await new Promise(r => setTimeout(r, 150)); // several flush intervals
    assert.equal(armed(internals).length, 0, 'a stopped recorder still has a flush timer armed');
  } finally {
    // Without the fix the timer re-arms forever; disarm it so this process can exit.
    internals.armFlush = () => {};
    for (const t of armed(internals)) clearTimeout(t);
    await cal.stop(); await http.stop(); await registry.stop();
  }
});
