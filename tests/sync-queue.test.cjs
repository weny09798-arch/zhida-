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

test('finishing a failed collection attempt releases its lease and respects retry time', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', nextAt: 0 });
  await queue.claim(['order_identity:P-1'], 1000, 120000);
  await queue.retry('order_identity:P-1', 16000, '采集页已关闭');
  assert.deepEqual((await queue.pick(15999, 2)).map((task) => task.id), []);
  assert.deepEqual((await queue.pick(16000, 2)).map((task) => task.id), ['order_identity:P-1']);
});

test('a live collection attempt remains leased when only its wakeup time changes', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', nextAt: 0 });
  await queue.claim(['order_identity:P-1'], 1000, 120000);
  await queue.defer(['order_identity:P-1'], 16000);
  assert.deepEqual(await queue.pick(16000, 2), []);
});

test('a task awaiting human choice cannot be picked until explicitly requeued', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', nextAt: 0 });
  await queue.pause('order_identity:P-1', '请核对候选');
  assert.deepEqual(await queue.pick(999999, 2), []);
  await queue.requeue('order_identity:P-1', 0);
  assert.equal((await queue.pick(0, 2)).length, 1);
});

test('refreshing a live collector lease cannot reactivate paused or confirmed work', async () => {
  const queue = createQueue(memory());
  await queue.schedule({ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', nextAt: 0 });
  await queue.schedule({ id: 'order_identity:P-2', purchaseId: 'P-2', kind: 'order_identity', nextAt: 0 });
  await queue.pause('order_identity:P-1', '等待核对');
  await queue.confirm('order_identity:P-2');
  await queue.claim(['order_identity:P-1', 'order_identity:P-2'], 1000, 120000);
  await queue.releaseExpired(122000);
  assert.deepEqual(await queue.pick(122000, 2), []);
});
