const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

function pageRuntime(finished = false) {
  const { document } = parseHTML('<html><body><div>待分享</div></body></html>');
  const observers = [];
  let scans = 0;
  const window = { location: new URL('https://mobile.yangkeduo.com/orders.html?type=5'), addEventListener() {} };
  const chrome = { storage: { local: {} }, runtime: { sendMessage(message, callback) {
    if (message.type === 'm2_getTabContext') callback({ ok: true, context: {
      purchaseId: 'P-1', purpose: 'collect_orders', collectionFinished: finished,
    } });
    else if (callback) callback({ ok: true });
  } } };
  const context = vm.createContext({ window, document, chrome, URL,
    M2Discovery: { runCollect: async () => { scans++; } },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'pdd_order.js'), 'utf8'), context);
  return { document, observers, get scans() { return scans; } };
}

test('a newly rendered order card triggers collection without a polling timer', async () => {
  const app = pageRuntime();
  assert.ok(app.observers.length > 0);
  app.document.body.insertAdjacentHTML('beforeend', '<div>待分享，差1人 实付 ￥0.60</div>');
  app.observers[0]([]);
  app.observers[0]([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.scans, 1);
});

test('returning to the collector triggers an immediate scan', async () => {
  const app = pageRuntime();
  app.document.dispatchEvent(new app.document.defaultView.Event('visibilitychange'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.scans, 1);
});

test('a finished collector does not start searching again after the focus was restored', async () => {
  const app = pageRuntime(true);
  assert.ok(app.observers.length > 0);
  app.observers[0]([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.scans, 0);
});
