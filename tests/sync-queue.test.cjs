const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueue } = require('../sync-queue.js');

function memory() {
  const data = {};
  return {
    async get(keys) {
      const out = {};
      for (const key of keys) out[key] = data[key];
      return out;
    },
    async set(values) {
      Object.assign(data, JSON.parse(JSON.stringify(values)));
    },
  };
}

test('later orders are visited when the first ones are still unshipped', async () => {
  const queue = createQueue(memory());
  const now = 1_000_000;
  for (let n = 1; n <= 10; n += 1) {
    await queue.schedule({
      id: 'L-' + n,
      purchaseId: 'P-' + n,
      kind: 'logistics',
      nextAt: n <= 3 ? now + 10 * 60 * 1000 : now,
    });
  }
  const picked = await queue.pick(now, 2);
  assert.deepEqual(picked.map((task) => task.id), ['L-4', 'L-5']);
});

test('round robin does not keep reopening only the first three', async () => {
  const queue = createQueue(memory());
  const now = 5_000;
  for (let n = 1; n <= 4; n += 1) {
    await queue.schedule({ id: 'Q-' + n, purchaseId: 'P-' + n, kind: 'logistics', nextAt: now });
  }
  const first = await queue.pick(now, 2);
  await queue.defer(first.map((task) => task.id), now + 10 * 60 * 1000);
  const second = await queue.pick(now, 2);
  assert.deepEqual(second.map((task) => task.id), ['Q-3', 'Q-4']);
});

test('network failure backs off and a lost response is not marked confirmed', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'R-1', purchaseId: 'P-1', kind: 'logistics', nextAt: 0 });
  const failed = await queue.fail('R-1', { kind: 'network', message: 'timeout' }, 0);
  assert.equal(failed.status, 'retrying');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.nextAt, 60 * 1000);
  const uncertain = await queue.fail('R-1', { kind: 'uncertain', message: 'response lost' }, failed.nextAt);
  assert.notEqual(uncertain.status, 'confirmed');
});

test('the same tracking number is not submitted twice after confirmation', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'T-1', purchaseId: 'P-1', kind: 'logistics', trackingNo: 'YT123456789012', nextAt: 0 });
  await queue.confirm('T-1', 10);
  const again = await queue.schedule({ id: 'T-2', purchaseId: 'P-1', kind: 'logistics', trackingNo: 'YT123456789012', nextAt: 0 });
  assert.equal(again.skipped, true);
  const due = await queue.pick(20, 2);
  assert.equal(due.length, 0);
});

test('a finished identity task can be queued again only by an explicit retry', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', nextAt: 0 });
  await queue.confirm('order_identity:P-1');
  const ignored = await queue.schedule({ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', nextAt: 0 });
  assert.notEqual(ignored.status, 'pending');
  const again = await queue.requeue('order_identity:P-1', 30);
  assert.equal(again.status, 'pending');
  assert.equal(again.nextAt, 30);
});

test('a leased task is not picked twice until the lease expires', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'order_detail:P-1', purchaseId: 'P-1', kind: 'order_detail', nextAt: 0 });
  await queue.schedule({ id: 'logistics:P-2', purchaseId: 'P-2', kind: 'logistics', nextAt: 0 });
  const first = await queue.pick(10, 2);
  await queue.claim(first.map((task) => task.id), 10, 1000);
  const busy = await queue.pick(20, 2);
  assert.equal(busy.length, 0);
  await queue.releaseExpired(2000);
  const recovered = await queue.pick(2000, 2);
  assert.equal(recovered.length, 2);
});
