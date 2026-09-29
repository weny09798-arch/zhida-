const test = require('node:test');
const assert = require('node:assert/strict');
const { describePurchase } = require('../purchase-store.js');

test('opening the purchase page is not shown as paid', () => {
  const text = describePurchase({
    status: 'opened',
    platformOrderSn: null,
    amount: null,
    logistics: [],
    logisticsSync: 'none',
    amountSync: 'local',
  });
  assert.match(text.label, /等待付款确认/);
  assert.equal(text.paid, false);
});

test('a confirmed tracking number does not hide the saved amount', () => {
  const text = describePurchase({
    status: 'recorded',
    platformOrderSn: 'P-1',
    amount: { minor: 1980, currency: 'CNY', source: 'paid' },
    logistics: [{ number: 'YT123456789012' }],
    logisticsSync: 'confirmed',
    amountSync: 'confirmed',
  });
  assert.equal(text.amountText, '¥19.80');
  assert.match(text.label, /已确认/);
  assert.equal(text.platformOrderSn, 'P-1');
});

test('local amount before shipping is visible and not claimed as saved by the backend', () => {
  const text = describePurchase({
    status: 'recorded',
    platformOrderSn: 'P-1',
    amount: { minor: 1980, currency: 'CNY', source: 'paid' },
    logistics: [],
    logisticsSync: 'not_shipped',
    amountSync: 'local',
  });
  assert.equal(text.amountText, '¥19.80');
  assert.equal(text.amountState, 'known');
  assert.match(text.detail, /本地已记录/);
  assert.match(text.detail, /待发货/);
});

test('missing amount is not claimed as recorded', () => {
  const view = describePurchase({
    status: 'recorded',
    platformOrderSn: '260929-123456789012345',
    amount: null,
    logisticsSync: 'not_shipped',
    amountSync: 'local',
  });
  assert.equal(view.amountState, 'unknown');
  assert.equal(view.amountText, '');
  assert.doesNotMatch(view.detail, /金额本地已记录/);
  assert.match(view.amountSyncText, /尚未采集/);
});

test('zero amount remains visible', () => {
  const view = describePurchase({
    status: 'recorded',
    amount: { minor: 0, currency: 'CNY' },
  });
  assert.equal(view.amountState, 'known');
  assert.equal(view.amountText, '¥0.00');
});

test('a saved alipay receipt stays visible before the order amount is confirmed', () => {
  const text = describePurchase({
    status: 'opened',
    platformOrderSn: null,
    amount: null,
    paymentReceipt: { status: 'succeeded', amountMinor: 121, currency: 'CNY', source: 'alipay-result' },
    collection: { stage: 'awaiting_order_detail', reason: '' },
  });
  assert.match(text.label, /采购订单待补全/);
  assert.match(text.paymentText, /支付宝支付金额：¥1\.21/);
  assert.match(text.paymentText, /待核对/);
  assert.equal(text.amountState, 'unknown');
});

test('an unlinked payment page is named instead of being saved as paid', () => {
  const text = describePurchase({
    collection: { stage: 'unlinked_payment', reason: '付款页未能关联到本次采购' },
  });
  assert.match(text.label, /付款页未能关联/);
});

test('a candidate awaiting confirmation is visible even if the payment page was closed', () => {
  const view = describePurchase({
    status: 'opened',
    collection: { stage: 'awaiting_choice', reason: '请核对这笔订单' },
    candidates: [{ orderSn: 'PDD-123' }],
  });
  assert.match(view.label, /订单.*核对/);
  assert.match(view.detail, /请核对/);
  assert.equal(view.paid, false);
});

test('a stalled collection explains that collection paused', () => {
  const view = describePurchase({ collection: { stage: 'paused', reason: '没有找到待分享标签' } });
  assert.match(view.label, /暂停/);
  assert.match(view.detail, /没有找到待分享标签/);
});
