const test = require('node:test');
const assert = require('node:assert/strict');
const { rowKey, getEffectiveBindings, collectUnboundIdentities, createStore } = require('../binding-store.js');

function memory(initial) {
  const data = Object.assign({ bindingMap: {}, m2BindingExclusions: {} }, initial || {});
  return {
    data,
    async get(keys) {
      const out = {};
      keys.forEach((key) => { out[key] = data[key]; });
      return out;
    },
    async set(values) {
      Object.assign(data, JSON.parse(JSON.stringify(values)));
    },
  };
}

test('excluding A preserves the shared binding for B', () => {
  const A = { zhidaOrderId: 'O1', zhidaItemId: 'R1', itemId: 'P1' };
  const B = { zhidaOrderId: 'O2', zhidaItemId: 'R2', itemId: 'P1' };
  const map = { P1: [{ id: 'L1', productUrl: 'https://example.invalid/product' }] };
  const exclusions = { [rowKey(A)]: { excludedBindingIds: ['L1'], updatedAt: 1 } };
  assert.deepEqual(getEffectiveBindings(map, exclusions, A), []);
  assert.equal(getEffectiveBindings(map, exclusions, B)[0].id, 'L1');
  assert.equal(map.P1.length, 1);
});

test('duplicate products within one order have distinct row identities', () => {
  const A = { zhidaOrderId: 'O1', zhidaItemId: 'R1', itemId: 'P1' };
  const B = { zhidaOrderId: 'O1', zhidaItemId: 'R2', itemId: 'P1' };
  assert.notEqual(rowKey(A), rowKey(B));
});

test('rebinding the same link restores only the current row', async () => {
  const adapter = memory({
    bindingMap: { P1: [{ id: 'L1', platform: 'PINDUODUO', productUrl: 'https://example.invalid/product' }] },
  });
  const store = createStore(adapter);
  const A = { zhidaOrderId: 'O1', zhidaItemId: 'R1', itemId: 'P1' };
  const B = { zhidaOrderId: 'O2', zhidaItemId: 'R2', itemId: 'P1' };
  await store.exclude({ identity: A, bindingId: 'L1' });
  const restored = await store.bind({
    identity: A,
    binding: { platform: 'PINDUODUO', productUrl: ' https://example.invalid/product ' },
  });
  assert.equal(restored.bindingId, 'L1');
  assert.equal(restored.restored, true);
  assert.equal(adapter.data.bindingMap.P1.length, 1);
  const again = createStore(adapter);
  const state = await again.read();
  assert.deepEqual(getEffectiveBindings(state.bindingMap, state.exclusions, A).map((row) => row.id), ['L1']);
  assert.deepEqual(getEffectiveBindings(state.bindingMap, state.exclusions, B).map((row) => row.id), ['L1']);
});

test('concurrent excludes on different rows both remain', async () => {
  const adapter = memory({
    bindingMap: { P1: [{ id: 'L1', platform: 'PINDUODUO', productUrl: 'https://example.invalid/product' }] },
  });
  const store = createStore(adapter);
  const A = { zhidaOrderId: 'O1', zhidaItemId: 'R1', itemId: 'P1' };
  const B = { zhidaOrderId: 'O2', zhidaItemId: 'R2', itemId: 'P1' };
  await Promise.all([
    store.exclude({ identity: A, bindingId: 'L1' }),
    store.exclude({ identity: B, bindingId: 'L1' }),
  ]);
  const again = createStore(adapter);
  const state = await again.read();
  assert.deepEqual(state.exclusions[rowKey(A)].excludedBindingIds, ['L1']);
  assert.deepEqual(state.exclusions[rowKey(B)].excludedBindingIds, ['L1']);
  assert.equal(state.bindingMap.P1.length, 1);
});

test('a purchase left after an older unbind is selected for removal', () => {
  const bound = { zhidaOrderId: 'O2', zhidaItemId: 'R2', orderSn: 'SO-2', itemId: 'P1', modelId: 'M1', purchaseId: 'keep' };
  const unbound = { zhidaOrderId: 'O1', zhidaItemId: 'R1', orderSn: 'SO-1', itemId: 'P9', modelId: 'M9', purchaseId: 'drop' };
  const identities = collectUnboundIdentities(
    [bound, unbound],
    { P1: [{ id: 'L1', productUrl: 'https://example.invalid/product' }] },
    {}
  );
  assert.equal(identities.length, 1);
  assert.equal(identities[0].zhidaItemId, 'R1');
  assert.equal(getEffectiveBindings({ P1: [{ id: 'L1' }] }, {}, bound).length, 1);
});

test('ambiguous legacy rows are rejected instead of deleting the shared binding', async () => {
  const store = createStore(memory());
  const result = await store.exclude({
    identity: { orderSn: 'SO-1', itemId: 'P1', modelId: '', ambiguous: true },
    bindingId: 'L1',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /刷新/);
});
