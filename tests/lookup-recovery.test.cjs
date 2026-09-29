const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..');
function harness(seed = {}) {
  const state = structuredClone(seed);
  const tabs = new Map([[9, { id: 9, url: 'https://mobile.yangkeduo.com/goods.html' }]]);
  const created = [];
  const removedWithContext = [];
  const handlers = {};
  const alarms = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener: fn => { handlers.message = fn; } } },
    storage: { local: {
      async get(keys) { const out = {}; for (const key of (Array.isArray(keys) ? keys : [keys])) out[key] = structuredClone(state[key]); return out; },
      async set(values) { Object.assign(state, structuredClone(values)); },
    } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw Error('No tab'); return tabs.get(id); },
      async create(input) { const tab = { id: 100 + created.length, ...input }; created.push(tab); tabs.set(tab.id, tab); return tab; },
      async remove(id) { removedWithContext.push(!!(state.tabContextMap && state.tabContextMap[id])); tabs.delete(id); },
      onRemoved: { addListener: fn => { handlers.removed = fn; } },
      onCreated: { addListener: fn => { handlers.created = fn; } },
      onUpdated: { addListener: fn => { handlers.updated = fn; } },
    },
    alarms: { create: (name, info) => alarms.push({ name, ...info }), onAlarm: { addListener: fn => { handlers.alarm = fn; } } },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, Date, Math, setTimeout, clearTimeout, fetch: async () => { throw Error('network not expected'); } });
  context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context, { filename: name }));
  vm.runInContext(fs.readFileSync(path.join(dir, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  async function message(msg, tab = { id: 9 }) {
    return new Promise(resolve => { handlers.message(msg, { tab }, resolve); });
  }
  return { state, tabs, created, removedWithContext, handlers, alarms, message };
}

function seedPurchase(overrides = {}) {
  return {
    purchaseId: 'P-1', orderSn: 'S-1', itemId: 'I-1', modelId: '', platform: 'PINDUODUO',
    status: 'opened', collection: { stage: 'submitted', updatedAt: 1 }, paymentReceipt: null,
    platformOrderSn: null, purchaseIntent: { goodsId: '123', quantity: 1 }, candidates: [],
    logisticsSync: 'none', amountSync: 'local', ...overrides,
  };
}
function seed(row = seedPurchase(), extra = {}) {
  return {
    m2Purchases: [row], m2PurchaseMeta: { version: 1, migrated: true },
    bindingMap: { 'I-1': [{ id: 'B-1' }] }, tabContextMap: { 9: { purchaseId: 'P-1', platform: 'PINDUODUO' } },
    m2SyncTasks: [], ...extra,
  };
}

test('payment success starts lookup despite a stale collection mapping', async () => {
  const app = harness(seed(seedPurchase(), { tabContextMap: { 9: { purchaseId: 'P-1' }, 77: { purchaseId: 'P-1', purpose: 'collect_orders' } } }));
  const reply = await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 61, currency: 'CNY' } });
  assert.equal(reply.ok, true);
  assert.equal(app.state.m2Purchases[0].paymentReceipt.amountMinor, 61);
  assert.equal(app.created.length, 1);
  assert.equal(app.state.tabContextMap[77], undefined);
});

test('replacing a stale collector clears its mapping before closing it', async () => {
  const app = harness(seed(seedPurchase(), { tabContextMap: {
    9: { purchaseId: 'P-1' },
    77: { purchaseId: 'P-1', purpose: 'collect_orders', createdByExtension: true, lastProgressAt: Date.now() - 60000 },
  } }));
  app.tabs.set(77, { id: 77, url: 'https://mobile.yangkeduo.com/orders.html' });
  const reply = await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 61 } });
  assert.equal(reply.ok, true);
  assert.deepEqual(app.removedWithContext, [false]);
  assert.equal(app.state.tabContextMap[77], undefined);
  app.handlers.removed(77);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.state.m2SyncTasks.find(task => task.id === 'order_identity:P-1').status, 'leased');
});

test('closing a collection tab schedules a persisted retry without marking payment successful', async () => {
  const app = harness(seed(seedPurchase(), { tabContextMap: { 9: { purchaseId: 'P-1' }, 77: { purchaseId: 'P-1', purpose: 'collect_orders' } }, m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'leased', leaseUntil: Date.now() + 120000, nextAt: Date.now() }] }));
  app.tabs.set(77, { id: 77, url: 'https://mobile.yangkeduo.com/orders.html' });
  app.tabs.delete(77);
  app.handlers.removed(77);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.state.m2Purchases[0].paymentReceipt, null);
  assert.equal(app.state.m2SyncTasks[0].status, 'retrying');
  assert.equal(app.state.tabContextMap[77], undefined);
  assert.ok(app.alarms.some(alarm => alarm.name === 'lookupRetry'));
});

test('provisional detail cannot silently attach an unverified order', async () => {
  const app = harness(seed(seedPurchase(), { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders' } } }));
  const reply = await app.message({ type: 'm2_purchaseComplete', orderSn: 'PDD-123', price: 0.61, purchaseId: 'P-1' });
  assert.equal(reply.ok, false);
  assert.equal(app.state.m2Purchases[0].platformOrderSn, null);
  assert.equal(app.state.m2Purchases[0].amount, undefined);
  assert.equal(app.state.m2Purchases[0].candidates[0].orderSn, 'PDD-123');
});

test('a paid order detail reached by this lookup is recorded without another click', async () => {
  const now = Date.now();
  const orderSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-619566907750351';
  const detailHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn;
  const purchase = seedPurchase({
    paymentReceipt: { status: 'succeeded', amountMinor: 199, observedAt: now },
    purchaseIntent: { goodsId: '123', quantity: 1, submittedAt: now },
  });
  const app = harness(seed(purchase, { tabContextMap: { 9: {
    purchaseId: 'P-1', purpose: 'collect_orders', platform: 'PINDUODUO',
    lastStage: 'entering_detail', candidate: { orderSn, detailHref },
  } } }));
  const reply = await app.message({ type: 'm2_purchaseComplete', purchaseId: 'P-1', orderSn, price: 1.99 }, { id: 9, url: detailHref });
  assert.equal(reply.ok, true);
  assert.equal(app.state.m2Purchases[0].platformOrderSn, orderSn);
  assert.equal(app.state.m2Purchases[0].amount.minor, 199);
  const logistics = app.state.m2SyncTasks.find(task => task.id === 'logistics:P-1');
  assert.ok(logistics.nextAt >= now + 2 * 60 * 60 * 1000);
});

test('same-day detail with a different paid amount stays unlinked', async () => {
  const now = Date.now();
  const orderSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-619566907750351';
  const detailHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn;
  const purchase = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 199, observedAt: now }, purchaseIntent: { submittedAt: now } });
  const app = harness(seed(purchase, { tabContextMap: { 9: {
    purchaseId: 'P-1', purpose: 'collect_orders', lastStage: 'entering_detail',
    candidate: { orderSn, detailHref },
  } } }));
  const reply = await app.message({ type: 'm2_purchaseComplete', purchaseId: 'P-1', orderSn, price: 0.70 }, { id: 9, url: detailHref });
  assert.equal(reply.ok, false);
  assert.equal(app.state.m2Purchases[0].platformOrderSn, null);
  assert.equal(app.state.m2Purchases[0].amount, undefined);
});

test('an existing single pending candidate is rechecked and then recorded automatically', async () => {
  const now = Date.now();
  const orderSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-619566907750351';
  const detailHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn;
  const purchase = seedPurchase({
    paymentReceipt: { status: 'succeeded', amountMinor: 199, observedAt: now },
    purchaseIntent: { submittedAt: now },
    collection: { stage: 'awaiting_choice', reason: '订单详情已打开，请核对后点选对应订单', updatedAt: now },
    candidates: [{ orderSn, detailHref }],
  });
  const app = harness(seed(purchase));
  app.handlers.alarm({ name: 'autoCollect' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(app.created[0].url, detailHref);
  assert.equal(app.state.m2Purchases[0].collection.stage, 'rechecking_candidate');
  const reply = await app.message({ type: 'm2_purchaseComplete', purchaseId: 'P-1', orderSn, price: 1.99 }, { id: app.created[0].id, url: detailHref });
  assert.equal(reply.ok, true);
  assert.equal(app.state.m2Purchases[0].platformOrderSn, orderSn);
});

test('an existing ten-minute logistics task is postponed to the new two-hour interval', async () => {
  const now = Date.now();
  const purchase = seedPurchase({ platformOrderSn: 'PDD-123', logisticsSync: 'not_shipped', amount: { minor: 199 }, collection: { stage: 'amount_confirmed' } });
  const app = harness(seed(purchase, { m2SyncTasks: [{
    id: 'logistics:P-1', purchaseId: 'P-1', kind: 'logistics', status: 'pending', nextAt: now + 10 * 60 * 1000,
  }] }));
  app.handlers.alarm({ name: 'autoCollect' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(app.state.m2SyncTasks[0].nextAt >= now + 2 * 60 * 60 * 1000);
  assert.equal(app.created.length, 0);
});

test('a confirmed tracking number stops the pending automatic logistics check', async () => {
  const purchase = seedPurchase({ platformOrderSn: 'PDD-123', logisticsSync: 'confirmed', amount: { minor: 199 }, collection: { stage: 'amount_confirmed' } });
  const app = harness(seed(purchase, {
    m2LogisticsIntervalVersion: 2,
    m2SyncTasks: [{ id: 'logistics:P-1', purchaseId: 'P-1', kind: 'logistics', status: 'pending', nextAt: 0 }],
  }));
  app.handlers.alarm({ name: 'autoCollect' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(app.created.length, 0);
  assert.equal(app.state.m2SyncTasks[0].status, 'confirmed');
});

test('a paused lookup is actually restarted by the retry button', async () => {
  const purchase = seedPurchase({ collection: { stage: 'needs_review', reason: '拼多多账号无法确认' } });
  const app = harness(seed(purchase, { m2SyncTasks: [{
    id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'paused', nextAt: 0,
  }] }));
  const reply = await app.message({ type: 'm2_retryCollection', purchaseId: 'P-1' });
  assert.equal(reply.ok, true);
  assert.equal(app.state.m2Purchases[0].collection.stage, 'awaiting_order_detail');
  assert.equal(app.created.length, 1);
  assert.match(app.created[0].url, /orders\.html/);
});

test('a list candidate with matching paid amount is opened for detail verification when account id is absent', async () => {
  const now = Date.now();
  const orderSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-619566907750351';
  const detailHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn;
  const purchase = seedPurchase({
    paymentReceipt: { status: 'succeeded', amountMinor: 78, observedAt: now },
    purchaseIntent: { goodsId: '123', quantity: 1, submittedAt: now },
  });
  const app = harness(seed(purchase, { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders', listTarget: '待分享' } } }));
  const reply = await app.message({ type: 'm2_orderCandidates', purchaseId: 'P-1', listTarget: '待分享', searchComplete: true,
    cards: [{ orderSn, goodsId: '', accountId: '', payMinor: 78, status: '待分享', detailHref }] });
  assert.equal(reply.status, 'inspect');
  assert.equal(app.state.m2Purchases[0].platformOrderSn, null);
  assert.equal(app.state.tabContextMap[9].candidate.orderSn, orderSn);
});

test('a non-collector detail cannot save an amount for a different order', async () => {
  const app = harness(seed(seedPurchase({ platformOrderSn: 'PDD-123' })));
  const reply = await app.message({ type: 'm2_updatePrice', purchaseId: 'P-1', orderSn: 'OTHER', price: 0.61 });
  assert.equal(reply.ok, false);
  assert.equal(app.state.m2Purchases[0].amount, undefined);
});

test('choosing an order already linked to a prior purchase explains the conflict', async () => {
  const previous = seedPurchase({ purchaseId: 'P-OLD', platformOrderSn: 'PDD-OLD' });
  const current = seedPurchase({ purchaseId: 'P-NEW', orderSn: 'S-NEW', platformOrderSn: null });
  const app = harness(seed(current, {
    m2Purchases: [previous, current],
    m2PurchaseMeta: { version: 1, migrated: true },
  }));
  const reply = await app.message({ type: 'm2_chooseCandidate', purchaseId: 'P-NEW', orderSn: 'PDD-OLD', detailHref: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-OLD' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /已关联.*采购/);
  assert.equal(app.state.m2Purchases[1].platformOrderSn, null);
});

test('a detail page from an earlier purchase is skipped and lookup returns to the order list', async () => {
  const previous = seedPurchase({ purchaseId: 'P-OLD', platformOrderSn: 'PDD-OLD' });
  const current = seedPurchase({ purchaseId: 'P-NEW', orderSn: 'S-NEW', platformOrderSn: null });
  const app = harness(seed(current, {
    m2Purchases: [previous, current],
    m2PurchaseMeta: { version: 1, migrated: true },
    tabContextMap: { 9: { purchaseId: 'P-NEW', purpose: 'collect_orders', createdByExtension: true, platform: 'PINDUODUO', candidate: { cardFingerprint: 'old-card' } } },
  }));
  const reply = await app.message({ type: 'm2_purchaseComplete', orderSn: 'PDD-OLD', price: 0.70, purchaseId: 'P-NEW' }, { id: 9, url: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-OLD' });
  assert.equal(reply.ok, true);
  assert.equal(reply.skipped, true);
  assert.match(reply.message, /上一笔采购/);
  assert.equal(app.state.m2Purchases[1].platformOrderSn, null);
  assert.equal(app.state.m2Purchases[1].amount, undefined);
  assert.equal(app.state.m2Purchases[1].candidates.length, 0);
  assert.deepEqual(app.state.m2Purchases[1].skippedCardFingerprints, ['old-card']);
  assert.equal(app.state.tabContextMap[9], undefined);
  assert.equal(app.created.some(tab => /orders\.html/.test(tab.url)), true);
});

test('choosing a provisional candidate lets its detail confirm the 0.61 paid amount', async () => {
  const app = harness(seed(seedPurchase(), { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders' } } }));
  const provisional = await app.message({ type: 'm2_purchaseComplete', orderSn: 'PDD-123', price: 0.61, purchaseId: 'P-1' }, { id: 9, url: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-123' });
  assert.equal(provisional.ok, false);
  const chosen = await app.message({ type: 'm2_chooseCandidate', purchaseId: 'P-1', orderSn: 'PDD-123', detailHref: app.state.m2Purchases[0].candidates[0].detailHref });
  assert.equal(chosen.ok, true);
  const confirmed = await app.message({ type: 'm2_purchaseComplete', orderSn: 'PDD-123', price: 0.61, purchaseId: 'P-1' });
  assert.equal(confirmed.ok, true);
  assert.equal(app.state.m2Purchases[0].platformOrderSn, 'PDD-123');
  assert.equal(app.state.m2Purchases[0].amount.minor, 61);
  assert.equal(app.state.m2SyncTasks.find(task => task.id === 'order_detail:P-1').status, 'confirmed');
});

test('a progress update preserves candidate and stage before list navigation', async () => {
  const app = harness(seed(seedPurchase(), { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders', listTarget: '待分享' } } }));
  const reply = await app.message({ type: 'm2_collectionProgress', purchaseId: 'P-1', stage: 'entering_detail', candidate: { orderSn: 'PDD-123', detailHref: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-123' } });
  assert.equal(reply.ok, true);
  assert.equal(app.state.m2Purchases[0].collection.stage, 'entering_detail');
  assert.equal(app.state.m2Purchases[0].candidates[0].orderSn, 'PDD-123');
});

test('an order detail without a paid amount remains due for a later detail check', async () => {
  const app = harness(seed(seedPurchase({ platformOrderSn: 'PDD-123' }), {
    m2SyncTasks: [{ id: 'order_detail:P-1', purchaseId: 'P-1', kind: 'order_detail', status: 'leased', leaseUntil: Date.now() + 120000, nextAt: 0 }],
  }));
  const reply = await app.message({ type: 'm2_purchaseComplete', orderSn: 'PDD-123', price: null, purchaseId: 'P-1' });
  assert.equal(reply.ok, true);
  assert.equal(app.state.m2SyncTasks[0].status, 'retrying');
  assert.ok(app.alarms.some(alarm => alarm.name === 'lookupRetry'));
});

test('an unresolved identity task does not reopen a page while awaiting a choice', async () => {
  const app = harness(seed(seedPurchase({ collection: { stage: 'awaiting_choice', updatedAt: 1 } }), { m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'pending', nextAt: 0 }] }));
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 0);
  assert.equal(app.state.m2SyncTasks[0].status, 'paused');
});

test('new order detail tab inherits only provisional collector context from its opener', async () => {
  const app = harness(seed(seedPurchase(), { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders', candidate: { orderSn: 'PDD-123', cardFingerprint: 'old-card' } } } }));
  app.tabs.set(20, { id: 20, openerTabId: 9, url: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-123' });
  app.handlers.created({ id: 20, openerTabId: 9, url: 'https://mobile.yangkeduo.com/order.html?order_sn=PDD-123' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.state.tabContextMap[20].purchaseId, 'P-1');
  assert.equal(app.state.tabContextMap[20].purpose, 'collect_orders');
  assert.equal(app.state.tabContextMap[20].candidate.cardFingerprint, 'old-card');
  assert.equal(app.state.tabContextMap[20].createdByExtension, false);
  app.tabs.set(21, { id: 21, openerTabId: 9, url: 'https://mobile.yangkeduo.com/order.html?order_sn=OTHER' });
  app.handlers.created({ id: 21, openerTabId: 9, url: 'https://mobile.yangkeduo.com/order.html?order_sn=OTHER' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.state.tabContextMap[21], undefined);
});

test('periodic recovery does not duplicate a live collector after its old lease expires', async () => {
  const now = Date.now();
  const app = harness(seed(seedPurchase(), { tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders', createdByExtension: true, lastProgressAt: now } }, m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'leased', leaseUntil: now - 1, nextAt: 0 }] }));
  app.tabs.set(77, { id: 77, url: 'https://mobile.yangkeduo.com/orders.html' });
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 0);
  assert.equal(app.state.tabContextMap[77].purchaseId, 'P-1');
});

test('periodic recovery replaces a stalled extension collector', async () => {
  const now = Date.now();
  const app = harness(seed(seedPurchase(), { tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders', createdByExtension: true, lastProgressAt: now - 60000 } }, m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'leased', leaseUntil: now + 60000, nextAt: 0 }] }));
  app.tabs.set(77, { id: 77, url: 'https://mobile.yangkeduo.com/orders.html' });
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.tabs.has(77), false);
  assert.equal(app.created.length, 1);
});

test('checkout waits for durable intent and submitted acknowledgments before clicking pay', async () => {
  const events = [];
  const intervals = [];
  const ctx = { purchaseId: 'P-1', quantity: 1, productUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=123', currentStep: 'checkout' };
  const button = { textContent: '立即支付', closest() { return this; }, click() { events.push('clicked'); } };
  const chrome = {
    storage: { local: { get(key, callback) { callback({ purchaseContext: ctx }); }, set(value, callback) { if (callback) callback(); } } },
    runtime: { sendMessage(message, callback) {
      if (message.type === 'm2_getTabContext') { callback({ ok: true, context: ctx }); return; }
      events.push(message.type);
      if (callback) callback({ ok: true });
    } },
  };
  const location = new URL('https://mobile.yangkeduo.com/order_checkout.html');
  const window = { location, addEventListener() {} };
  const document = { body: { id: 'order_checkout', textContent: '' }, querySelectorAll() { return [button]; }, querySelector() { return null; } };
  const context = vm.createContext({ chrome, window, document, console: { log() {}, warn() {}, error() {} }, setTimeout: fn => { queueMicrotask(fn); return 1; }, setInterval: fn => { intervals.push(fn); }, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pdd_order.js'), 'utf8'), context, { filename: 'pdd_order.js' });
  await intervals[0]();
  assert.deepEqual(events.slice(0, 3), ['m2_savePurchaseIntent', 'm2_purchaseSubmitted', 'clicked']);
});
