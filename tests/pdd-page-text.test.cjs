const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const collectors = require('../platform-collectors.js');

test('logistics text beside a copy button is included in the scanned page', () => {
  const tracking = 'JT5531151004081';
  const button = { tagName: 'BUTTON', children: [], textContent: '复制', childNodes: [{ nodeType: 3, textContent: '复制' }] };
  const row = {
    tagName: 'DIV', children: [button], textContent: '极兔速递: ' + tracking + '复制',
    childNodes: [{ nodeType: 3, textContent: '极兔速递: ' + tracking }, { nodeType: 1 }],
  };
  const document = { body: { querySelectorAll: () => [row, button] } };
  const window = { addEventListener() {} };
  const chrome = { storage: { local: {} } };
  const context = vm.createContext({ document, window, chrome, setTimeout() {}, setInterval() {} });
  const source = fs.readFileSync(path.join(__dirname, '..', 'pdd_order.js'), 'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.__readPageText = getAllTextDeep;\n})();'), context);
  const pageText = context.__readPageText();
  assert.equal(collectors.extractTracking('', pageText, '260929-619566907750351'), tracking);
});

test('a shipped Pinduoduo page sends the tracking number for the selected purchase', async () => {
  const orderSn = '260929-619566907750351';
  const tracking = 'JT5531151004081';
  const button = { tagName: 'BUTTON', children: [], textContent: '复制', childNodes: [{ nodeType: 3, textContent: '复制' }] };
  const row = {
    tagName: 'DIV', children: [button], textContent: '极兔速递: ' + tracking + '复制',
    childNodes: [{ nodeType: 3, textContent: '极兔速递: ' + tracking }, { nodeType: 1 }],
  };
  const document = {
    body: { textContent: '订单编号: ' + orderSn, querySelectorAll: () => [row, button] },
  };
  const intervals = [];
  const sent = [];
  const chrome = {
    storage: { local: {} },
    runtime: { sendMessage(message, callback) {
      sent.push(message);
      if (message.type === 'm2_getTabContext') callback({ ok: true, context: { purchaseId: 'P-1', platformOrderSn: orderSn } });
      else if (callback) callback({ ok: true });
    } },
  };
  const window = { location: new URL('https://mobile.yangkeduo.com/goods_express.html?order_sn=' + orderSn), addEventListener() {} };
  const context = vm.createContext({ document, window, chrome, M2Collectors: collectors, URL, setTimeout() {}, setInterval: fn => intervals.push(fn), console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'pdd_order.js'), 'utf8'), context);
  await intervals[2]();
  const collected = sent.find(message => message.type === 'm2_collectLogistics');
  assert.equal(collected.purchaseId, 'P-1');
  assert.equal(collected.orderSn, orderSn);
  assert.equal(collected.logisticsNumber, tracking);
});
