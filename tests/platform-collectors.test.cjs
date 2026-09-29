const test = require('node:test');
const assert = require('node:assert/strict');
const collectors = require('../platform-collectors.js');

test('paid amount 19.80 is kept when a recommended price 999 is also on the page', () => {
  const found = collectors.extractPaidAmount('优惠后付款 19.80 元，推荐商品 ￥999');
  assert.equal(found.yuan, 19.8);
  assert.equal(found.minor, 1980);
});

test('a page without a paid-amount label does not guess the largest price', () => {
  assert.equal(collectors.extractPaidAmount('推荐商品 ￥999 商品总价 ￥88'), null);
});

test('hyphenated order numbers in text are read', () => {
  const sn = collectors.extractOrderSn(
    'https://mobile.yangkeduo.com/order_detail.html',
    '订单编号：260929-123456789012345'
  );
  assert.equal(sn, '260929-123456789012345');
});

test('tracking number is not the purchase order number or a short mixed token', () => {
  const page = '订单编号：260929-123456789012345 快递单号：YT123456789012 推荐单号 grabTicket';
  const tracking = collectors.extractTracking('', page, '260929-123456789012345');
  assert.equal(tracking, 'YT123456789012');
  assert.equal(collectors.extractTracking('', '订单编号：260929-123456789012345', '260929-123456789012345'), '');
});

test('paid amount labels with currency signs are supported', () => {
  for (const text of [
    '实付金额：￥1.21',
    '实付款：￥1.21',
    '优惠后付款￥1.21',
  ]) {
    assert.equal(collectors.extractPaidAmount(text).minor, 121);
  }
  assert.equal(collectors.extractPaidAmount('推荐商品 ￥999'), null);
});

test('applying an unknown amount does not replace 19.80', () => {
  const kept = collectors.mergeAmount({ minor: 1980, currency: 'CNY', source: 'paid' }, null);
  assert.equal(kept.minor, 1980);
});
