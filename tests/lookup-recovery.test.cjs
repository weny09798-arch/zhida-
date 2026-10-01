const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..');
function harness(seed = {}) {
  const state = structuredClone(seed);
  const tabs = new Map([[9, { id: 9, windowId: 1, active: true, url: 'https://mobile.yangkeduo.com/goods.html' }]]);
  const created = [];
  const removedWithContext = [];
  const handlers = {};
  const alarms = [];
  const tabUpdates = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: 'test' }), onMessage: { addListener: fn => { handlers.message = fn; } } },
    storage: { local: {
      async get(keys) { const out = {}; for (const key of (Array.isArray(keys) ? keys : [keys])) out[key] = structuredClone(state[key]); return out; },
      async set(values) { Object.assign(state, structuredClone(values)); },
    } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw Error('No tab'); return tabs.get(id); },
      async query(input) { return Array.from(tabs.values()).filter(tab => (!input.active || tab.active) && (input.windowId == null || tab.windowId === input.windowId)); },
      async update(id, input) {
        if (!tabs.has(id)) throw Error('No tab');
        const tab = tabs.get(id);
        if (input.active) for (const item of tabs.values()) if (item.windowId === tab.windowId) item.active = false;
        Object.assign(tab, input);
        tabUpdates.push({ id, ...input, hasContext: !!(state.tabContextMap && state.tabContextMap[id]) });
        return tab;
      },
      async create(input) {
        const tab = { id: 100 + created.length, windowId: 1, ...input };
        if (tab.active) for (const item of tabs.values()) if (item.windowId === tab.windowId) item.active = false;
        created.push(tab); tabs.set(tab.id, tab); return tab;
      },
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
  return { state, tabs, created, removedWithContext, handlers, alarms, message, tabUpdates };
}

function seedPurchase(overrides = {}) {
  return {
    purchaseId: 'P-1', orderSn: 'S-1', itemId: 'I-1', modelId: '', platform: 'PINDUODUO',
    status: 'opened', collection: { stage: 'submitted', updatedAt: 1 }, paymentReceipt: null,
    platformOrderSn: null, purchaseIntent: { goodsId: '123', quantity: 1 }, candidates: [],
    // 默认夹具代表正在执行的新查单；历史记录测试显式移除或过期该会话。
    lookupSession: { id: 'LIVE', source: 'retry', startedAt: Date.now(), expiresAt: Date.now() + 120000 },
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

test('a periodic scan does not revive a historical purchase just because it lacks an order number', async () => {
  const row = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 60, observedAt: Date.now() - 86400000 },
    collection: { stage: 'incomplete', updatedAt: Date.now() - 86400000 }, lookupSession: null });
  const app = harness(seed(row, { m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'pending', nextAt: 0 }] }));
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 0);
  assert.equal(app.tabs.get(9).active, true);
  assert.equal(app.state.m2SyncTasks[0].status, 'paused');
});

test('an old order with a missing amount does not turn a logistics alarm into foreground order search', async () => {
  const row = seedPurchase({ platformOrderSn: 'PDD-123', lookupSession: null, amount: null });
  const app = harness(seed(row, { m2LogisticsIntervalVersion: 3, m2SyncTasks: [
    { id: 'order_detail:P-1', purchaseId: 'P-1', kind: 'order_detail', status: 'pending', nextAt: 0 },
    { id: 'logistics:P-1', purchaseId: 'P-1', kind: 'logistics', status: 'pending', nextAt: 0 },
  ] }));
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 1);
  assert.equal(app.created[0].active, false);
  assert.match(app.created[0].url, /goods_express/);
  assert.equal(app.tabs.get(9).active, true);
});

test('recent page activity cannot extend an expired foreground lookup', async () => {
  const row = seedPurchase({ lookupSession: { id: 'OLD', startedAt: Date.now() - 180000, expiresAt: Date.now() - 60000, source: 'payment' } });
  const app = harness(seed(row, { tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders', foregroundManaged: true,
    lookupSessionId: 'OLD', taskId: 'order_identity:P-1', lastProgressAt: Date.now(), returnTabId: 9 } },
    m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'leased', leaseUntil: Date.now() + 120000, nextAt: 0 }],
  }));
  app.tabs.set(77, { id: 77, windowId: 1, active: false, url: 'https://mobile.yangkeduo.com/orders.html?type=5' });
  const result = await app.message({ type: 'm2_collectorNeedsVisibility', purchaseId: 'P-1' }, { id: 77 });
  assert.equal(result.ok, false);
  assert.equal(app.tabs.get(9).active, true);
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 0);
  assert.equal(app.state.m2SyncTasks[0].status, 'paused');
});

test('a duplicate result from an old payment page cannot renew an expired lookup', async () => {
  const row = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 60, observedAt: Date.now() - 86400000 },
    lookupSession: { id: 'OLD', startedAt: Date.now() - 180000, expiresAt: Date.now() - 60000, source: 'payment' } });
  const app = harness(seed(row));
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  assert.equal(app.created.length, 0);
  assert.equal(app.state.m2Purchases[0].lookupSession.id, 'OLD');
});

test('a fresh payment replaces the old session even when its page reported recent progress', async () => {
  const app = harness(seed(seedPurchase({ lookupSession: { id: 'OLD', startedAt: Date.now() - 180000, expiresAt: Date.now() - 60000 } }), {
    tabContextMap: { 9: { purchaseId: 'P-1' }, 77: { purchaseId: 'P-1', purpose: 'collect_orders',
      foregroundManaged: true, lookupSessionId: 'OLD', createdByExtension: true, lastProgressAt: Date.now() } },
  }));
  app.tabs.set(77, { id: 77, windowId: 1, active: false, url: 'https://mobile.yangkeduo.com/orders.html?type=5' });
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  assert.equal(app.created.length, 1);
  assert.equal(app.state.tabContextMap[77], undefined);
});

test('a submitted checkout cannot start foreground lookup before payment or an explicit retry', async () => {
  const app = harness(seed(seedPurchase({ collection: { stage: 'idle' }, lookupSession: null })));
  await app.message({ type: 'm2_purchaseSubmitted', purchaseId: 'P-1' });
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 0);
  assert.equal(app.tabs.get(9).active, true);
});

test('explicit retry grants a fresh bounded session for an expired purchase', async () => {
  const row = seedPurchase({ lookupSession: { id: 'OLD', expiresAt: Date.now() - 60000 }, collection: { stage: 'paused' } });
  const app = harness(seed(row));
  const now = Date.now();
  await app.message({ type: 'm2_retryCollection', purchaseId: 'P-1' });
  assert.equal(app.created.length, 1);
  const session = app.state.m2Purchases[0].lookupSession;
  assert.notEqual(session.id, 'OLD');
  assert.ok(session.expiresAt >= now + 120000 && session.expiresAt < now + 121000);
  assert.equal(app.state.tabContextMap[app.created[0].id].lookupSessionId, session.id);
});

for (const type of ['m2_collectionProgress', 'm2_collectionPaused', 'm2_orderCandidates']) {
  test('a message from the previous lookup cannot alter the new lookup: ' + type, async () => {
    const row = seedPurchase({ collection: { stage: 'awaiting_order_detail' } });
    const app = harness(seed(row, { tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders',
      foregroundManaged: true, lookupSessionId: 'OLD', taskId: 'order_identity:P-1', listTarget: '待分享' } } }));
    app.tabs.set(77, { id: 77, windowId: 1, active: false });
    const reply = await app.message({ type, purchaseId: 'P-1', stage: 'opening_list', reason: '旧页面超时', cards: [] }, { id: 77 });
    assert.equal(reply.ok, false);
    assert.equal(app.state.m2Purchases[0].collection.stage, 'awaiting_order_detail');
  });
}

for (const recent of [true, false]) {
  test('closing a watched payment page ' + (recent ? 'starts a recent purchase lookup' : 'does not revive yesterday’s purchase'), async () => {
    const row = seedPurchase({ lookupSession: null, purchaseIntent: { submittedAt: Date.now() - (recent ? 10000 : 86400000) } });
    const app = harness(seed(row, { m2PaymentTabs: { 77: 'P-1' } }));
    app.handlers.removed(77);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(app.created.length, recent ? 1 : 0);
    assert.equal(app.tabs.get(9).active, !recent);
  });
}

test('order lookup saves its context before showing the query page automatically', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const collector = app.created[0];
  assert.equal(collector.active, true);
  assert.equal(app.state.tabContextMap[collector.id].returnTabId, 9);
  assert.equal(app.state.tabContextMap[collector.id].foregroundManaged, true);
  assert.equal(app.tabUpdates.find(update => update.url && /orders\.html/.test(update.url)).hasContext, true);
});

test('a paused foreground lookup returns to the page that was open before lookup', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const collector = app.created[0];
  await app.message({ type: 'm2_collectionPaused', purchaseId: 'P-1', reason: '列表加载失败' }, { id: collector.id });
  assert.equal(app.tabs.get(9).active, true);
  assert.equal(app.state.tabContextMap[collector.id].collectionFinished, true);
});

test('finishing lookup preserves the user choice if they switched to another tab', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const collector = app.created[0];
  collector.active = false;
  app.tabs.set(88, { id: 88, windowId: 1, active: true, url: 'https://example.com/' });
  await app.message({ type: 'm2_collectionPaused', purchaseId: 'P-1', reason: '列表加载失败' }, { id: collector.id });
  assert.equal(app.tabs.get(88).active, true);
  assert.equal(app.tabs.get(9).active, false);
});

test('two pending order lookups do not hide each other by opening two foreground tabs', async () => {
  const rows = [seedPurchase({ purchaseId: 'P-1', paymentReceipt: { status: 'succeeded', amountMinor: 60 } }),
    seedPurchase({ purchaseId: 'P-2', paymentReceipt: { status: 'succeeded', amountMinor: 70 } })];
  const app = harness(seed(rows[0], { m2Purchases: rows }));
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 1);
  const first = app.created[0];
  await app.message({ type: 'm2_collectionPaused', purchaseId: 'P-1', reason: '结束这一轮' }, { id: first.id });
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 2);
  assert.equal(app.state.tabContextMap[app.created[1].id].purchaseId, 'P-2');
});

test('a collector hidden before loading requests activation and remembers the latest return page', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const collector = app.created[0];
  collector.active = false;
  app.tabs.set(88, { id: 88, windowId: 1, active: true, url: 'https://example.com/' });
  const reply = await Promise.race([app.message({ type: 'm2_collectorNeedsVisibility', purchaseId: 'P-1' }, { id: collector.id }),
    new Promise(resolve => setTimeout(() => resolve({ ok: false }), 100))]);
  assert.equal(reply.ok, true);
  assert.equal(collector.active, true);
  assert.equal(app.state.tabContextMap[collector.id].returnTabId, 88);
  await app.message({ type: 'm2_collectionPaused', purchaseId: 'P-1', reason: '结束' }, { id: collector.id });
  assert.equal(app.tabs.get(88).active, true);
});

test('a successful automatic lookup saves the order and returns to the original tab', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const collector = app.created[0];
  await app.message({ type: 'm2_collectionProgress', purchaseId: 'P-1', stage: 'entering_detail',
    candidate: { cardFingerprint: 'paid-60', payMinor: 60, uniquePaidCard: true } }, { id: collector.id });
  const orderSn = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-070296605030351';
  const detailHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn;
  app.handlers.updated(collector.id, { url: detailHref }, { id: collector.id, url: detailHref });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.state.m2Purchases[0].platformOrderSn, orderSn);
  assert.equal(app.state.m2Purchases[0].amount.minor, 60);
  assert.equal(app.tabs.get(9).active, true);
  assert.equal(app.state.tabContextMap[collector.id].collectionFinished, true);
  const stale = await app.message({ type: 'm2_collectionProgress', purchaseId: 'P-1', stage: 'opening_list' }, { id: collector.id });
  assert.equal(stale.ok, false);
  assert.equal(app.state.m2Purchases[0].collection.stage, 'amount_confirmed');
});

test('a delayed visibility request cannot reactivate a collector that just finished', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const collector = app.created[0];
  collector.active = false;
  app.tabs.set(88, { id: 88, windowId: 1, active: true, url: 'https://example.com/' });
  await Promise.all([
    app.message({ type: 'm2_collectionPaused', purchaseId: 'P-1', reason: '结束' }, { id: collector.id }),
    app.message({ type: 'm2_collectorNeedsVisibility', purchaseId: 'P-1' }, { id: collector.id }),
  ]);
  assert.equal(app.state.tabContextMap[collector.id].collectionFinished, true);
  assert.equal(collector.active, false);
  assert.equal(app.tabs.get(88).active, true);
});

test('a detail opened in a new tab completes both collector contexts and returns focus', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const parent = app.created[0];
  await app.message({ type: 'm2_collectionProgress', purchaseId: 'P-1', stage: 'entering_detail',
    candidate: { cardFingerprint: 'paid-60', payMinor: 60, uniquePaidCard: true } }, { id: parent.id });
  const sn = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-070296605030351';
  const child = { id: 20, windowId: 1, active: true, openerTabId: parent.id,
    url: 'https://mobile.yangkeduo.com/order.html?order_sn=' + sn };
  parent.active = false;
  app.tabs.set(20, child);
  app.handlers.created(child);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.state.m2Purchases[0].platformOrderSn, sn);
  assert.equal(app.state.tabContextMap[parent.id].collectionFinished, true);
  assert.equal(app.state.tabContextMap[20].collectionFinished, true);
  assert.equal(app.tabs.get(9).active, true);
});

for (const sample of [
  { name: 'already recorded', row: seedPurchase({ platformOrderSn: 'PDD-123', amount: { minor: 60 }, collection: { stage: 'order_linked' } }) },
  { name: 'paused', row: seedPurchase({ collection: { stage: 'paused' } }) },
  { name: 'not found in the completed search', row: seedPurchase({ collection: { stage: 'not_found' } }) },
  { name: 'deleted', row: null },
  { name: 'queue task already confirmed', row: seedPurchase(), taskStatus: 'confirmed' },
]) {
  test('a stale collector cannot steal focus when its purchase is ' + sample.name, async () => {
    const app = harness(seed(sample.row, {
      m2Purchases: sample.row ? [sample.row] : [],
      tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders', foregroundManaged: true,
        taskId: 'order_identity:P-1', returnTabId: 9, lastProgressAt: Date.now() } },
      m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity',
        status: sample.taskStatus || 'leased', leaseUntil: Date.now() + 120000, nextAt: 0 }],
    }));
    app.tabs.set(77, { id: 77, windowId: 1, active: false, url: 'https://mobile.yangkeduo.com/orders.html' });
    const reply = await app.message({ type: 'm2_collectorNeedsVisibility', purchaseId: 'P-1' }, { id: 77 });
    assert.equal(reply.ok, false);
    assert.equal(app.tabs.get(9).active, true);
    assert.equal(app.tabs.get(77).active, false);
    assert.equal(app.state.tabContextMap[77].collectionFinished, true);
  });
}

test('obsolete detail tasks do not reopen a recorded order or block a new purchase', async () => {
  const done = seedPurchase({ platformOrderSn: 'PDD-123', amount: { minor: 0 }, collection: { stage: 'order_linked' } });
  const fresh = seedPurchase({ purchaseId: 'P-2' });
  const app = harness(seed(done, { m2Purchases: [done, fresh],
    tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders', foregroundManaged: true,
      returnTabId: 9, lastProgressAt: Date.now() } },
    m2SyncTasks: [
      { id: 'order_detail:P-1', purchaseId: 'P-1', kind: 'order_detail', status: 'pending', nextAt: 0 },
      { id: 'order_identity:P-2', purchaseId: 'P-2', kind: 'order_identity', status: 'pending', nextAt: 0 },
    ],
  }));
  app.tabs.set(77, { id: 77, windowId: 1, active: false, url: 'https://mobile.yangkeduo.com/orders.html' });
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 1);
  assert.equal(app.state.tabContextMap[app.created[0].id].purchaseId, 'P-2');
  assert.equal(app.state.m2SyncTasks.find(task => task.id === 'order_detail:P-1').status, 'confirmed');
  assert.equal(app.state.tabContextMap[77].collectionFinished, true);
});

for (const checkContext of [true, false]) test('a confirmed queue task frees the next purchase through ' + (checkContext ? 'page context' : 'periodic recovery'), async () => {
  const app = harness(seed(seedPurchase(), {
    m2Purchases: [seedPurchase(), seedPurchase({ purchaseId: 'P-2' })],
    tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders', foregroundManaged: true,
      taskId: 'order_identity:P-1', lastProgressAt: Date.now(), returnTabId: 9 } },
    m2SyncTasks: [
      { id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'confirmed', nextAt: 0 },
      { id: 'order_identity:P-2', purchaseId: 'P-2', kind: 'order_identity', status: 'pending', nextAt: 0 },
    ],
  }));
  app.tabs.set(77, { id: 77, windowId: 1, active: false, url: 'https://mobile.yangkeduo.com/orders.html' });
  if (checkContext) {
    const ctx = await app.message({ type: 'm2_getTabContext' }, { id: 77 });
    assert.equal(ctx.context.collectionFinished, true);
  }
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 1);
  assert.equal(app.state.tabContextMap[app.created[0].id].purchaseId, 'P-2');
  assert.equal(app.state.tabContextMap[77].collectionFinished, true);
});

test('an unsuccessful completed lookup stays paused across timer runs until an explicit retry', async () => {
  const app = harness(seed());
  await app.message({ type: 'm2_paymentResult', result: { status: 'succeeded', amountMinor: 60 } });
  const collector = app.created[0];
  app.state.tabContextMap[collector.id].listTarget = '待发货';
  await app.message({ type: 'm2_orderCandidates', purchaseId: 'P-1', listTarget: '待发货', searchComplete: true, cards: [] }, { id: collector.id });
  assert.equal(app.state.m2SyncTasks.find(task => task.kind === 'order_identity').status, 'paused');
  // Simulate the periodic alarm after the old lease has expired.
  for (const task of app.state.m2SyncTasks) { task.nextAt = 0; task.leaseUntil = 0; }
  await app.message({ type: 'm2_triggerAutoCollect' });
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 1);
  assert.equal(app.tabs.get(9).active, true);
  await app.message({ type: 'm2_retryCollection', purchaseId: 'P-1' });
  assert.equal(app.created.length, 2);
  assert.match(app.created[1].url, /orders\.html\?type=5/);
});

test('closing a finished paused collector does not revive its queue task', async () => {
  const app = harness(seed(seedPurchase({ collection: { stage: 'paused' } }), {
    tabContextMap: { 77: { purchaseId: 'P-1', purpose: 'collect_orders', collectionFinished: true } },
    m2SyncTasks: [{ id: 'order_identity:P-1', purchaseId: 'P-1', kind: 'order_identity', status: 'paused', nextAt: 0 }],
  }));
  app.handlers.removed(77);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.state.m2SyncTasks[0].status, 'paused');
  assert.equal(app.alarms.some(alarm => alarm.name === 'lookupRetry'), false);
});

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
  assert.ok(logistics.nextAt >= now + 30 * 60 * 1000);
  assert.ok(logistics.nextAt < now + 31 * 60 * 1000);
});

test('a unique paid share card can confirm its order number from the clicked navigation even if detail fails', async () => {
  const now = Date.now();
  const orderSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-070296605030351';
  const detailHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn;
  const purchase = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 60, observedAt: now }, purchaseIntent: { submittedAt: now } });
  const app = harness(seed(purchase, { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders', listTarget: '待分享', platform: 'PINDUODUO' } } }));
  const progress = await app.message({ type: 'm2_collectionProgress', purchaseId: 'P-1', stage: 'entering_detail', candidate: {
    orderSn: '', detailHref: '', cardFingerprint: 'card-60', payMinor: 60, uniquePaidCard: true,
  } });
  assert.equal(progress.ok, true);
  app.handlers.updated(9, { url: detailHref }, { id: 9, url: detailHref });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(app.state.m2Purchases[0].platformOrderSn, orderSn);
  assert.equal(app.state.m2Purchases[0].amount.minor, 60);
  assert.equal(app.state.m2SyncTasks.some(task => task.id === 'order_identity:P-1' && task.status !== 'confirmed'), false);
  assert.ok(app.state.m2SyncTasks.some(task => task.id === 'logistics:P-1'));
});

test('same-tab URL alone never attaches an order without exact paid-card evidence', async () => {
  const now = Date.now();
  const orderSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-070296605030351';
  const detailHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn;
  const purchase = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 60, observedAt: now }, purchaseIntent: { submittedAt: now } });
  for (const candidate of [
    { cardFingerprint: 'card', payMinor: 70, uniquePaidCard: true },
    { cardFingerprint: 'card', payMinor: 60, uniquePaidCard: false },
    { cardFingerprint: '', payMinor: 60, uniquePaidCard: true },
  ]) {
    const app = harness(seed(purchase, { tabContextMap: { 9: {
      purchaseId: 'P-1', purpose: 'collect_orders', listTarget: '待分享', platform: 'PINDUODUO',
      lastStage: 'entering_detail', lastProgressAt: now, candidate,
    } } }));
    app.handlers.updated(9, { url: detailHref }, { id: 9, url: detailHref });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(app.state.m2Purchases[0].platformOrderSn, null);
  }
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

test('an existing two-hour logistics task is brought forward to thirty minutes', async () => {
  const now = Date.now();
  const purchase = seedPurchase({ platformOrderSn: 'PDD-123', logisticsSync: 'not_shipped', amount: { minor: 199 }, collection: { stage: 'amount_confirmed' } });
  const app = harness(seed(purchase, { m2LogisticsIntervalVersion: 2, m2SyncTasks: [{
    id: 'logistics:P-1', purchaseId: 'P-1', kind: 'logistics', status: 'pending', nextAt: now + 120 * 60 * 1000,
  }] }));
  app.handlers.alarm({ name: 'autoCollect' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(app.state.m2SyncTasks[0].nextAt >= now + 30 * 60 * 1000);
  assert.ok(app.state.m2SyncTasks[0].nextAt < now + 31 * 60 * 1000);
  assert.equal(app.created.length, 0);
  const firstDue = app.state.m2SyncTasks[0].nextAt;
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.state.m2SyncTasks[0].nextAt, firstDue);
});

test('switching to thirty minutes keeps an earlier logistics check due sooner', async () => {
  const nextAt = Date.now() + 5 * 60 * 1000;
  const purchase = seedPurchase({ platformOrderSn: 'PDD-123', amount: { minor: 60 }, collection: { stage: 'amount_confirmed' } });
  const app = harness(seed(purchase, { m2LogisticsIntervalVersion: 2, m2SyncTasks: [{
    id: 'logistics:P-1', purchaseId: 'P-1', kind: 'logistics', status: 'pending', nextAt,
  }] }));
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.state.m2SyncTasks[0].nextAt, nextAt);
});

test('a due logistics check schedules its next automatic check thirty minutes later', async () => {
  const now = Date.now();
  const purchase = seedPurchase({ platformOrderSn: 'PDD-123', amount: { minor: 60 }, collection: { stage: 'amount_confirmed' } });
  const app = harness(seed(purchase, { m2LogisticsIntervalVersion: 3, m2SyncTasks: [{
    id: 'logistics:P-1', purchaseId: 'P-1', kind: 'logistics', status: 'pending', nextAt: 0,
  }] }));
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.equal(app.created.length, 1);
  assert.equal(app.created[0].active, false);
  assert.ok(app.state.m2SyncTasks[0].nextAt >= now + 30 * 60 * 1000);
  assert.ok(app.state.m2SyncTasks[0].nextAt < now + 31 * 60 * 1000);
});

test('changing the logistics interval leaves paused, confirmed and in-flight tasks alone', async () => {
  const now = Date.now();
  const tasks = ['paused', 'confirmed', 'leased'].map((status, index) => ({
    id: 'logistics:P-' + index, purchaseId: 'P-' + index, kind: 'logistics', status,
    nextAt: now + 120 * 60 * 1000, leaseUntil: status === 'leased' ? now + 120000 : 0,
  }));
  const app = harness(seed(seedPurchase({ collection: { stage: 'idle' } }), {
    m2LogisticsIntervalVersion: 2, m2SyncTasks: tasks,
  }));
  await app.message({ type: 'm2_triggerAutoCollect' });
  assert.deepEqual(app.state.m2SyncTasks, tasks);
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

test('a visible but unreadable paid share card does not become a false not-found result', async () => {
  const purchase = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 70 }, purchaseIntent: { goodsId: '123', submittedAt: Date.now() } });
  const app = harness(seed(purchase, { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders', listTarget: '待分享' } } }));
  const reply = await app.message({ type: 'm2_orderCandidates', purchaseId: 'P-1', listTarget: '待分享', searchComplete: true, cards: [], hasVisiblePaidCard: true });
  assert.equal(reply.status, 'unreadable');
  assert.equal(reply.nextList, undefined);
  assert.equal(app.state.m2Purchases[0].collection.listTarget, '待分享');
  assert.match(app.state.m2Purchases[0].collection.reason, /能看到|有订单/);
  const retried = await app.message({ type: 'm2_retryCollection', purchaseId: 'P-1' });
  assert.equal(retried.ok, true);
  assert.equal(app.state.m2Purchases[0].collection.listTarget, '待分享');
  assert.match(app.created.at(-1).url, /orders\.html\?type=5/);
});

test('an unreadable paid share card does not get hidden by unrelated order links', async () => {
  const now = Date.now();
  const oldSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-111111111111111';
  const oldHref = 'https://mobile.yangkeduo.com/order.html?order_sn=' + oldSn;
  const purchase = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 60, observedAt: now }, purchaseIntent: { submittedAt: now } });
  const app = harness(seed(purchase, { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders', listTarget: '待分享' } } }));
  const reply = await app.message({ type: 'm2_orderCandidates', purchaseId: 'P-1', listTarget: '待分享', searchComplete: true,
    cards: [{ orderSn: oldSn, accountId: '', payMinor: 70, status: '待分享', detailHref: oldHref }], hasVisiblePaidCard: true });
  assert.equal(reply.status, 'unreadable');
  assert.equal(app.state.m2Purchases[0].collection.listTarget, '待分享');
  assert.match(app.state.m2Purchases[0].collection.reason, /能看到/);
});

test('share lookup changes lists only after a completed repeated scan', async () => {
  const now = Date.now();
  const purchase = seedPurchase({ paymentReceipt: { status: 'succeeded', amountMinor: 60, observedAt: now }, purchaseIntent: { submittedAt: now } });
  const app = harness(seed(purchase, { tabContextMap: { 9: { purchaseId: 'P-1', purpose: 'collect_orders', listTarget: '待分享' } } }));
  const early = await app.message({ type: 'm2_orderCandidates', purchaseId: 'P-1', listTarget: '待分享', searchComplete: false,
    shareScanCount: 1, cards: [] });
  assert.equal(early.nextList, undefined);
  assert.equal(app.state.tabContextMap[9].listTarget, '待分享');
  const premature = await app.message({ type: 'm2_orderCandidates', purchaseId: 'P-1', listTarget: '待分享', searchComplete: true,
    shareScanCount: 1, cards: [] });
  assert.equal(premature.nextList, undefined);
  assert.equal(app.state.tabContextMap[9].listTarget, '待分享');
  const final = await app.message({ type: 'm2_orderCandidates', purchaseId: 'P-1', listTarget: '待分享', searchComplete: true,
    shareScanCount: 4, cards: [] });
  assert.equal(final.nextList, '待发货');
  assert.match(app.state.m2Purchases[0].collection.reason, /查看4次/);
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
