const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../purchase-store.js');

function memory() {
  const data = {};
  return {
    data,
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

function item(n) {
  return {
    orderSn: 'SO-' + n,
    itemId: 'I-' + n,
    modelId: 'M-' + n,
    zhidaOrderId: 'Z-' + n,
    zhidaItemId: 'ZI-' + n,
    quantity: 1,
    platform: 'PINDUODUO',
    productUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=' + n,
  };
}

test('reverse completion of two purchases does not cross-link orders', async () => {
  const store = createStore(memory());
  const a = await store.create(item(1));
  const b = await store.create(item(2));
  const second = await store.attachPlatformOrder({ purchaseId: b.purchaseId, platform: 'PINDUODUO', platformOrderSn: 'P-2' });
  const first = await store.attachPlatformOrder({ purchaseId: a.purchaseId, platform: 'PINDUODUO', platformOrderSn: 'P-1' });
  assert.equal(second.ok, true);
  assert.equal(first.ok, true);
  assert.equal((await store.get(a.purchaseId)).platformOrderSn, 'P-1');
  assert.equal((await store.get(b.purchaseId)).platformOrderSn, 'P-2');
});

test('list position is never used to claim orders', async () => {
  const store = createStore(memory());
  await store.create(item(1));
  await store.create(item(2));
  const result = store.refuseListAssignment(['UNRELATED-OLD-ORDER', 'OTHER-ORDER']);
  assert.equal(result.assigned, 0);
  const all = await store.list();
  assert.equal(all[0].platformOrderSn, null);
  assert.equal(all[1].platformOrderSn, null);
});

test('unknown tab and a repeated purchase of the same item stay separate', async () => {
  const store = createStore(memory());
  const first = await store.create(item(1));
  const again = await store.create(item(1));
  assert.notEqual(first.purchaseId, again.purchaseId);
  const missing = await store.attachPlatformOrder({ purchaseId: 'missing', platform: 'PINDUODUO', platformOrderSn: 'P-X' });
  assert.equal(missing.ok, false);
  assert.equal((await store.get(first.purchaseId)).platformOrderSn, null);
});

test('unknown amount does not erase a saved paid amount, and zero stays zero', async () => {
  const store = createStore(memory());
  const row = await store.create(item(1));
  await store.setPaidAmount(row.purchaseId, { yuan: 19.8, currency: 'CNY', source: 'paid' });
  await store.setPaidAmount(row.purchaseId, null);
  await store.setPaidAmount(row.purchaseId, { yuan: null });
  assert.equal((await store.get(row.purchaseId)).amount.minor, 1980);
  const free = await store.create(item(2));
  await store.setPaidAmount(free.purchaseId, { yuan: 0, currency: 'CNY', source: 'paid' });
  assert.equal((await store.get(free.purchaseId)).amount.minor, 0);
});

test('legacy conflicts are kept for review and original keys are not deleted', async () => {
  const adapter = memory();
  adapter.data.pendingCollect = [
    { shopeeOrder: item(1), platform: 'PINDUODUO', platformOrderSn: 'P-SAME', productUrl: 'u' },
    { shopeeOrder: item(2), platform: 'PINDUODUO', platformOrderSn: 'P-SAME', productUrl: 'u' },
  ];
  adapter.data.purchaseRecords = { 'P-1': { shopeeOrder: item(3), platform: 'PINDUODUO', price: 19.8 } };
  const store = createStore(adapter);
  const report = await store.migrateLegacy();
  assert.equal(report.conflicts >= 1, true);
  assert.ok(adapter.data.pendingCollect);
  assert.ok(adapter.data.purchaseRecords);
  const flagged = (await store.list()).filter((row) => row.status === 'needs_review');
  assert.equal(flagged.length >= 1, true);
});

test('removing one line keeps the other order purchase', async () => {
  const store = createStore(memory());
  const first = await store.create(item(1));
  const second = await store.create(item(1));
  const other = await store.create(item(2));
  const removed = await store.removeForLine({
    zhidaOrderId: 'Z-1',
    zhidaItemId: 'ZI-1',
    orderSn: 'SO-1',
    itemId: 'I-1',
    modelId: 'M-1',
  });
  assert.deepEqual(removed.purchaseIds.sort(), [first.purchaseId, second.purchaseId].sort());
  const left = await store.list();
  assert.equal(left.length, 1);
  assert.equal(left[0].purchaseId, other.purchaseId);
});
