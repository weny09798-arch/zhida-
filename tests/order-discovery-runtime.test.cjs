const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const discovery = require('../pdd-order-discovery.js');

const LIST_URL = 'https://mobile.yangkeduo.com/orders.html?type=5';
const DETAIL_URL = 'https://mobile.yangkeduo.com/order.html?order_sn=260929-041041324390351';
const ORDER = '待分享，差1人 牙签蛋糕 ×1 实付 ¥0.61';

function page(cards) {
  return parseHTML('<html><body><div class="active">待分享</div>' + cards.join('') + '</body></html>').document;
}

function card(inner) {
  return '<div class="order-card"><div class="status">待分享，差1人</div><div class="product">' + inner + '</div><div class="paid">实付 ¥0.61</div><button>直接免拼</button><button>邀请好友拼单</button><button>取消订单</button></div>';
}

async function run(document, options = {}) {
  const old = {
    document: global.document, location: global.location, window: global.window,
    chrome: global.chrome, sessionStorage: global.sessionStorage, MouseEvent: global.MouseEvent,
    DateNow: Date.now,
  };
  const state = { href: options.initialHref || LIST_URL, messages: [], now: 1000,
    reloadCount: 0, reload() { this.reloadCount++; } };
  const map = new Map();
  Object.assign(global, {
    document,
    location: state,
    window: {},
    sessionStorage: {
      getItem(key) { return map.get(key) || null; },
      setItem(key, value) { map.set(key, value); },
      removeItem(key) { map.delete(key); },
    },
    chrome: { runtime: { sendMessage(message, done) {
      state.messages.push(message);
      if (done) done(message.type === 'm2_collectionProgress' && options.progressResponse ? options.progressResponse :
        message.type === 'm2_orderCandidates' && options.candidateResponse ? options.candidateResponse :
        { ok: true, purchaseId: 'purchase-1' });
    } } },
    MouseEvent: class { constructor(type, props) { this.type = type; Object.assign(this, props); } },
  });
  Date.now = () => state.now;
  try {
    await options.exercise(state);
  } finally {
    Date.now = old.DateNow;
    for (const key of ['document', 'location', 'window', 'chrome', 'sessionStorage', 'MouseEvent']) {
      if (old[key] === undefined) delete global[key]; else global[key] = old[key];
    }
  }
}

function collect(overrides = {}) {
  return discovery.runCollect(Object.assign({ purchaseId: 'purchase-1', listTarget: '待分享', progress: {} }, overrides));
}

async function finishShareScans(state, overrides = {}) {
  for (let i = 0; i < 4; i++) {
    state.now += 10000;
    await collect(overrides);
  }
}

test('runCollect follows the only safe order detail link and reports entry progress', async () => {
  const document = page([card('<a href="' + DETAIL_URL + '">牙签蛋糕 ×1</a>')]);
  await run(document, { exercise: async state => {
    await collect();
    assert.equal(state.href, DETAIL_URL);
    assert.equal(state.messages.filter(m => m.type === 'm2_collectionProgress').length, 1);
    assert.equal(state.messages.find(m => m.type === 'm2_collectionProgress').candidate.orderSn, '260929-041041324390351');
  } });
});

test('runCollect skips a sole card whose order number belongs to an earlier purchase', async () => {
  const previousOrderSn = '260929-041041324390351';
  const document = page([card('<a href="https://mobile.yangkeduo.com/order.html?order_sn=' + previousOrderSn + '">牙签蛋糕 ×1</a>')]);
  await run(document, { exercise: async state => {
    await collect({ claimedOrderSns: [previousOrderSn] });
    await finishShareScans(state, { claimedOrderSns: [previousOrderSn] });
    assert.equal(state.href, LIST_URL);
    assert.equal(state.messages.some(message => message.type === 'm2_collectionProgress' && message.stage === 'entering_detail'), false);
    assert.equal(state.messages.some(message => message.type === 'm2_orderCandidates'), true);
  } });
});

test('runCollect opens the current paid card after excluding the old claimed card', async () => {
  const currentUrl = 'https://mobile.yangkeduo.com/order.html?order_sn=260929-619566907750351';
  const oldCard = '<div class="order-card">待分享，差1人 <a href="' + DETAIL_URL + '">旧商品 ×1</a> 实付 ¥0.70</div>';
  const currentCard = '<div class="order-card">待分享，差1人 <a href="' + currentUrl + '">新商品 ×1</a> 实付 ¥0.78</div>';
  await run(page([oldCard, currentCard]), { exercise: async state => {
    await collect({ paymentMinor: 78, claimedOrderSns: ['260929-041041324390351'] });
    assert.equal(state.href, currentUrl);
  } });
});

test('runCollect does not reopen a linkless card already identified as an old order', async () => {
  const oldText = '待分享，差1人 旧商品 ×1 实付 ¥0.78';
  const currentText = '待分享，差1人 新商品 ×1 实付 ¥0.78';
  const document = page([
    '<div class="order-card">' + oldText + '<img alt="旧商品"></div>',
    '<div class="order-card">' + currentText + '<img alt="新商品"></div>',
  ]);
  let oldClicks = 0;
  let currentClicks = 0;
  document.querySelector('img[alt="旧商品"]').click = () => { oldClicks++; };
  document.querySelector('img[alt="新商品"]').click = () => { currentClicks++; };
  await run(document, { exercise: async () => {
    await collect({ paymentMinor: 78, skippedCardFingerprints: [oldText.replace(/\s+/g, '')] });
    assert.equal(oldClicks, 0);
    assert.equal(currentClicks, 1);
  } });
});

test('runCollect clicks a linkless product image once and waits for route progress', async () => {
  const document = page([card('牙签蛋糕 ×1 <img alt="牙签蛋糕">')]);
  let clicks = 0;
  document.querySelector('img').click = () => { clicks++; };
  await run(document, { exercise: async state => {
    await collect();
    await collect();
    assert.equal(clicks, 1);
    assert.equal(state.messages.filter(m => m.type === 'm2_collectionProgress').length, 1);
  } });
});

test('a linkless share card opens its product even when status and paid amount share an inner block', async () => {
  const document = page(['<div class="order-card"><div class="summary">待分享，差1人 实付 ¥0.7</div><div class="product"><img alt="牙签旗帜">牙签旗帜 ×1</div><button>邀请好友拼单</button></div>']);
  let clicks = 0;
  document.querySelector('img').click = () => { clicks++; };
  await run(document, { exercise: async state => {
    await collect({ paymentMinor: 70 });
    assert.equal(clicks, 1);
    assert.equal(state.messages.some(message => message.type === 'm2_orderCandidates'), false);
    const candidate = state.messages.find(message => message.type === 'm2_collectionProgress').candidate;
    assert.equal(candidate.payMinor, 70);
    assert.equal(candidate.uniquePaidCard, true);
  } });
});

test('two linkless share cards with the same paid amount are not guessed from the list', async () => {
  const document = page([
    '<div class="order-card"><div>待分享，差1人 实付 ¥0.7</div><img alt="商品甲"></div>',
    '<div class="order-card"><div>待分享，差1人 实付 ¥0.7</div><img alt="商品乙"></div>',
  ]);
  let clicks = 0;
  for (const image of document.querySelectorAll('img')) image.click = () => { clicks++; };
  await run(document, { exercise: async state => {
    await collect({ paymentMinor: 70 });
    await finishShareScans(state, { paymentMinor: 70 });
    assert.equal(clicks, 0);
    assert.equal(state.messages.some(message => message.type === 'm2_orderCandidates'), true);
  } });
});

test('an unreadable paid share card is reported instead of being treated as an empty list', async () => {
  const document = page(['<div class="order-card"><div>待分享，差1人 实付 ¥0.7</div><div>牙签旗帜</div></div>']);
  await run(document, { candidateResponse: { ok: true, status: 'unreadable' }, exercise: async state => {
    await collect({ paymentMinor: 70 });
    await finishShareScans(state, { paymentMinor: 70 });
    const report = state.messages.find(message => message.type === 'm2_orderCandidates');
    assert.equal(report.hasVisiblePaidCard, true);
    assert.equal(state.messages.some(message => message.type === 'm2_collectionPaused'), false);
  } });
});

test('an unrendered share list is refreshed three times before it can be declared empty', async () => {
  const document = page([]);
  await run(document, { exercise: async state => {
    await collect({ paymentMinor: 60 });
    assert.equal(state.messages.some(m => m.type === 'm2_orderCandidates'), false);
    for (let i = 1; i <= 3; i++) {
      state.now += 10000;
      await collect({ paymentMinor: 60 });
      assert.equal(state.reloadCount, i);
      assert.equal(state.messages.some(m => m.type === 'm2_orderCandidates'), false);
    }
    state.now += 10000;
    await collect({ paymentMinor: 60 });
    const reports = state.messages.filter(m => m.type === 'm2_orderCandidates');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].shareScanCount, 4);
  } });
});

test('a different paid share card does not trigger an immediate switch to unshipped orders', async () => {
  const document = page(['<div class="order-card"><div>待分享，差1人</div><img alt="旧商品"><div>实付 ￥0.7</div></div>']);
  await run(document, { candidateResponse: { ok: true, status: 'share_pending', nextList: '待发货' }, exercise: async state => {
    await collect({ paymentMinor: 60 });
    assert.equal(state.messages.some(m => m.type === 'm2_orderCandidates'), false);
    assert.equal(state.href, LIST_URL);
    state.now += 10000;
    await collect({ paymentMinor: 60 });
    assert.equal(state.reloadCount, 1);
    document.body.insertAdjacentHTML('beforeend', '<div class="order-card"><div>待分享，差1人</div><img alt="新商品"><div>菜品牙签小插旗 ×1</div><div>实付 ￥0.6</div></div>');
    let clicked = 0;
    document.querySelector('img[alt="新商品"]').click = () => { clicked++; };
    await collect({ paymentMinor: 60 });
    assert.equal(clicked, 1);
    assert.equal(state.messages.some(m => m.type === 'm2_orderCandidates'), false);
  } });
});

test('a share list still loading after repeated refreshes pauses instead of switching lists', async () => {
  const document = page(['<div>正在加载中</div>']);
  await run(document, { exercise: async state => {
    await collect({ paymentMinor: 60 });
    await finishShareScans(state, { paymentMinor: 60 });
    assert.equal(state.messages.some(m => m.type === 'm2_orderCandidates'), false);
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused' && /待分享.*加载/.test(m.reason)), true);
  } });
});

test('a delayed share card is opened instead of reporting an empty list during rendering', async () => {
  const document = page([]);
  await run(document, { exercise: async state => {
    for (let i = 0; i < 5; i++) {
      state.now += 700;
      await collect({ paymentMinor: 60 });
    }
    assert.equal(state.messages.some(message => message.type === 'm2_orderCandidates'), false);
    document.body.insertAdjacentHTML('beforeend', '<div class="order-card"><div class="summary">待分享，差1人</div><div class="product"><img alt="牙签旗帜">菜品牙签小插旗 ×1</div><div>实付 ￥0.6</div></div>');
    let clicks = 0;
    document.querySelector('img').click = () => { clicks++; };
    await collect({ paymentMinor: 60 });
    assert.equal(clicks, 1);
  } });
});

test('hidden time does not exhaust share scans or click a page that is not displayed', async () => {
  const document = page([card('牙签蛋糕 ×1 <img alt="牙签蛋糕">')]);
  Object.defineProperty(document, 'hidden', { value: true, writable: true });
  let clicks = 0;
  document.querySelector('img').click = () => { clicks++; };
  await run(document, { exercise: async state => {
    await collect({ paymentMinor: 61 });
    state.now += 60000;
    await collect({ paymentMinor: 61 });
    assert.equal(clicks, 0);
    assert.equal(state.reloadCount, 0);
    assert.equal(state.messages.some(m => m.type === 'm2_orderCandidates' || m.type === 'm2_collectionPaused'), false);
    assert.equal(state.messages.some(m => m.type === 'm2_collectorNeedsVisibility'), true);
    document.hidden = false;
    await collect({ paymentMinor: 61 });
    assert.equal(clicks, 1);
  } });
});

test('runCollect recognizes route progress after a product click', async () => {
  const document = page([card('牙签蛋糕 ×1 <img alt="牙签蛋糕">')]);
  await run(document, { exercise: async state => {
    document.querySelector('img').click = () => { state.href = DETAIL_URL; };
    await collect();
    state.now += 5000;
    await collect();
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused'), false);
  } });
});

test('runCollect does not choose the first of indistinguishable cards', async () => {
  const document = page([card('<a href="' + DETAIL_URL + '">牙签蛋糕 ×1</a>'), card('<a href="https://mobile.yangkeduo.com/order.html?order_sn=other">牙签蛋糕 ×1</a>')]);
  await run(document, { exercise: async state => {
    await collect();
    await finishShareScans(state);
    assert.equal(state.href, LIST_URL);
    assert.equal(state.messages.some(m => m.type === 'm2_orderCandidates' && m.cards.length === 2), true);
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused'), false);
  } });
});

test('runCollect bounds stale image clicks and reports failed navigation', async () => {
  const document = page([card('牙签蛋糕 ×1 <img alt="牙签蛋糕">')]);
  let clicks = 0;
  document.querySelector('img').click = () => { clicks++; };
  await run(document, { exercise: async state => {
    for (let i = 0; i < 8; i++) { state.now += 1200; await collect(); }
    assert.ok(clicks >= 1 && clicks <= 2);
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused' && /详情|跳转|进入/.test(m.reason)), true);
  } });
});

test('runCollect never touches group, cancel or pay buttons', async () => {
  const document = page([card('牙签蛋糕 ×1 <img alt="牙签蛋糕">')]);
  const touched = [];
  for (const button of document.querySelectorAll('button')) button.click = () => touched.push(button.textContent);
  document.querySelector('img').click = () => {};
  await run(document, { exercise: async () => {
    await collect();
    assert.deepEqual(touched, []);
  } });
});

test('runCollect waits for the requested list tab before opening a card', async () => {
  const document = page([card('<a href="' + DETAIL_URL + '">牙签蛋糕 ×1</a>')]);
  document.querySelector('.active').textContent = '待发货';
  const share = document.createElement('button');
  share.textContent = '待分享';
  document.body.appendChild(share);
  let tabClicks = 0;
  share.click = () => { tabClicks++; };
  await run(document, { exercise: async state => {
    await collect();
    assert.equal(tabClicks, 1);
    assert.equal(state.href, LIST_URL);
  } });
});

test('runCollect pauses if the background cannot save entry progress', async () => {
  const document = page([card('<a href="' + DETAIL_URL + '">牙签蛋糕 ×1</a>')]);
  await run(document, { progressResponse: { ok: false, error: '关联失效' }, exercise: async state => {
    await collect();
    assert.equal(state.href, LIST_URL);
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused' && /关联|保存/.test(m.reason)), true);
  } });
});

test('runCollect preserves an awaiting-choice candidate result', async () => {
  const document = page([card('<a href="' + DETAIL_URL + '">牙签蛋糕 ×1</a>'), card('<a href="https://mobile.yangkeduo.com/order.html?order_sn=other">牙签蛋糕 ×1</a>')]);
  await run(document, { candidateResponse: { ok: true, status: 'choose' }, exercise: async state => {
    await collect();
    await finishShareScans(state);
    assert.equal(state.messages.filter(m => m.type === 'm2_orderCandidates').length, 1);
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused'), false);
  } });
});

test('runCollect reports the background error when candidates cannot be saved', async () => {
  const document = page(['<div class="order-card">待分享，差1人 实付 ¥0.61</div>']);
  await run(document, { candidateResponse: { ok: false, error: '候选保存失败' }, exercise: async state => {
    await collect();
    await finishShareScans(state);
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused' && /候选保存失败/.test(m.reason)), true);
  } });
});

test('runCollect allows late tab controls to render before pausing', async () => {
  const document = parseHTML('<html><body>加载中</body></html>').document;
  await run(document, { initialHref: 'https://mobile.yangkeduo.com/personal.html', exercise: async state => {
    await collect();
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused'), false);
    for (let i = 0; i < 4; i++) await collect();
    assert.equal(state.messages.some(m => m.type === 'm2_collectionPaused' && /待分享/.test(m.reason)), true);
  } });
});
