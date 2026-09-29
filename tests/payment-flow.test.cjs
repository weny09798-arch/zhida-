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
  };
}

test('submitting checkout records the stage without calling it paid', async () => {
  const store = createStore(memory());
  const row = await store.create(item(1));
  await store.setPurchaseIntent(row.purchaseId, {
    goodsId: 'G1',
    skuId: 'S1',
    quantity: 1,
    submittedAt: 1000,
  });
  const submitted = await store.markSubmitted(row.purchaseId);
  assert.equal(submitted.collection.stage, 'submitted');
  assert.equal(submitted.paymentReceipt, null);
  assert.equal(submitted.platformOrderSn, null);
  assert.equal(submitted.purchaseIntent.goodsId, 'G1');
  assert.equal(submitted.purchaseIntent.skuId, 'S1');
});

test('an alipay receipt does not replace the order amount, and a mismatch waits for review', async () => {
  const store = createStore(memory());
  const row = await store.create(item(1));
  await store.recordPayment(row.purchaseId, {
    status: 'succeeded',
    amountMinor: 121,
    currency: 'CNY',
    source: 'alipay-result',
  });
  const saved = await store.get(row.purchaseId);
  assert.equal(saved.amount, null);
  assert.equal(saved.paymentReceipt.amountMinor, 121);
  await store.setPaidAmount(row.purchaseId, { yuan: 0.91, currency: 'CNY', source: 'paid' });
  const reviewed = await store.reconcilePayment(row.purchaseId);
  assert.equal(reviewed.collection.stage, 'needs_review');
  assert.equal((await store.get(row.purchaseId)).amount.minor, 91);
});

test('matching receipt and detail amount confirms the local paid amount', async () => {
  const store = createStore(memory());
  const row = await store.create(item(1));
  await store.recordPayment(row.purchaseId, { status: 'succeeded', amountMinor: 121, currency: 'CNY', source: 'alipay-result' });
  await store.setPaidAmount(row.purchaseId, { yuan: 1.21, currency: 'CNY', source: 'paid' });
  const reviewed = await store.reconcilePayment(row.purchaseId);
  assert.equal(reviewed.collection.stage, 'amount_confirmed');
  assert.equal((await store.get(row.purchaseId)).amount.minor, 121);
});

test('two tasks cannot claim the same candidate order', async () => {
  const store = createStore(memory());
  const a = await store.create(item(1));
  const b = await store.create(item(2));
  const candidate = { orderSn: '260929-111111111111111', detailHref: 'https://mobile.yangkeduo.com/order.html?order_sn=260929-111111111111111' };
  const [first, second] = await Promise.all([
    store.claimCandidate(a.purchaseId, candidate),
    store.claimCandidate(b.purchaseId, candidate),
  ]);
  const oks = [first, second].filter((item) => item.ok);
  assert.equal(oks.length, 1);
  const rows = await store.list();
  const owners = rows.filter((item) => item.platformOrderSn === candidate.orderSn);
  assert.equal(owners.length, 1);
});

test('a repeated success receipt does not create another purchase', async () => {
  const store = createStore(memory());
  const row = await store.create(item(1));
  const receipt = { status: 'succeeded', amountMinor: 121, currency: 'CNY', source: 'alipay-result' };
  await store.recordPayment(row.purchaseId, receipt);
  const again = await store.recordPayment(row.purchaseId, receipt);
  assert.equal(again.duplicate, true);
  assert.equal((await store.list()).length, 1);
});
