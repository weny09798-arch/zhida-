const test = require('node:test');
const assert = require('node:assert/strict');
const discovery = require('../pdd-order-discovery.js');

test('orders.html is the order list even when refer parameters differ', () => {
  const first = discovery.pageKind('https://mobile.yangkeduo.com/orders.html?type=3&refer_page_id=aaa');
  const second = discovery.pageKind('https://mobile.yangkeduo.com/orders.html?type=3&refer_page_id=bbb');
  assert.equal(first, 'order_list');
  assert.equal(second, 'order_list');
  assert.equal(discovery.pageKind('https://mobile.yangkeduo.com/order.html'), 'order_list');
  assert.equal(discovery.pageKind('https://mobile.yangkeduo.com/goods_express.html?order_sn=260929-1'), 'logistics');
});

test('collection starts from the home control and then the share-group list', () => {
  assert.deepEqual(discovery.nextStep({ kind: 'home', purpose: 'collect_orders' }), { action: 'click', text: '个人中心' });
  assert.deepEqual(discovery.nextStep({ kind: 'personal', purpose: 'collect_orders' }), { action: 'click', text: '待分享' });
  assert.deepEqual(
    discovery.nextStep({ kind: 'order_list', purpose: 'collect_orders', tab: '待发货' }),
    { action: 'click', text: '待分享' }
  );
  assert.equal(discovery.nextStep({ kind: 'product', purpose: 'collect_orders' }).action, 'stop');
});

test('after the share list has been checked, collection continues to unshipped orders', () => {
  assert.deepEqual(
    discovery.nextStep({ kind: 'order_list', purpose: 'collect_orders', tab: '待分享', listTarget: '待发货' }),
    { action: 'click', text: '待发货' }
  );
  assert.equal(
    discovery.nextStep({ kind: 'order_list', purpose: 'collect_orders', tab: '待分享' }).action,
    'read_cards'
  );
});

test('the share list address observed on the orders page is type 5', () => {
  assert.equal(discovery.listTabFromUrl('https://mobile.yangkeduo.com/orders.html?type=5&main_orders=1'), '待分享');
  assert.equal(discovery.listTabFromUrl('https://mobile.yangkeduo.com/orders.html'), '');
});

test('one share card is opened through its order link, not the group-buy button', () => {
  const button = { innerText: '直接免拼', children: [] };
  const image = { innerText: '', children: [], querySelectorAll: function () { return []; } };
  const card = {
    innerText: '待分享，差1人 牙签蛋糕 ×1 实付 ¥0.61 直接免拼 邀请好友拼单',
    href: 'https://mobile.yangkeduo.com/order.html?order_sn=260929-041041324390351',
    getAttribute: function (name) { return name === 'href' ? this.href : ''; },
    children: [image, button],
    contains: function (other) { return other === image || other === button; },
    querySelectorAll: function (selector) {
      if (selector === 'a') return [];
      if (selector === 'img') return [image];
      return [];
    },
  };
  const page = {
    innerText: card.innerText + '精选推荐',
    children: [card],
    contains: function (other) { return other === card; },
    querySelectorAll: function () { return []; },
  };
  const entry = discovery.orderEntry({
    querySelectorAll: function () { return [page, card, button]; },
  }, '待分享');
  assert.equal(entry.href, 'https://mobile.yangkeduo.com/order.html?order_sn=260929-041041324390351');
  assert.notEqual(entry.node, button);
});

test('one share card without a link is opened from the product image', () => {
  const button = { innerText: '邀请好友拼单', children: [], querySelectorAll: function () { return []; } };
  const image = { innerText: '', children: [], querySelectorAll: function () { return []; } };
  const card = {
    innerText: '待分享，差1人 牙签蛋糕 ×1 实付 ¥0.61 直接免拼 邀请好友拼单',
    children: [image, button],
    contains: function (other) { return other === image || other === button; },
    querySelectorAll: function (selector) { return selector === 'img' ? [image] : []; },
  };
  const entry = discovery.orderEntry({
    querySelectorAll: function () { return [card, button]; },
  }, '待分享');
  assert.equal(entry.href, '');
  assert.equal(entry.node, image);
});

test('the share tab is chosen instead of the bar that contains every tab name', () => {
  const parent = { innerText: '全部待付款待分享待发货待收货', children: [1, 2, 3, 4, 5] };
  const share = { innerText: '待分享', children: [] };
  const ship = { innerText: '待发货', children: [] };
  const found = discovery.findControl('待分享', {
    querySelectorAll: function () { return [parent, ship, share]; },
  });
  assert.equal(found, share);
});

test('collection never clicks the group-buy buttons', () => {
  ['home', 'personal', 'order_list', 'order_detail'].forEach((kind) => {
    const step = discovery.nextStep({ kind: kind, purpose: 'collect_orders', tab: '待分享', listTarget: '待分享' });
    assert.notEqual(step.text, '直接免拼');
    assert.notEqual(step.text, '邀请好友拼单');
  });
  assert.equal(discovery.shouldOpenCard('直接免拼'), false);
  assert.equal(discovery.shouldOpenCard('邀请好友拼单'), false);
  assert.equal(discovery.shouldOpenCard('待分享，差1人 掏耳勺 ×1 实付 ¥0.95'), true);
});

test('a collection page never returns a buy or pay action', () => {
  ['home', 'personal', 'order_list', 'order_detail', 'logistics'].forEach((kind) => {
    const step = discovery.nextStep({ kind: kind, purpose: 'collect_orders' });
    assert.equal(step.action === 'buy' || step.action === 'pay' || step.action === 'submit', false);
  });
});
