const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const alipay = require('../alipay-result.js');

const successText = fs.readFileSync(path.join(__dirname, 'fixtures/payment/alipay-success.txt'), 'utf8');

test('a success page keeps 1.21 yuan as 121 minor units and ignores other prices', () => {
  const result = alipay.parseResult(successText);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.amountMinor, 121);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.source, 'alipay-result');
  assert.equal(result.orderSn, undefined);
});

test('failure, cancel and waiting are not payment success', () => {
  assert.equal(alipay.parseResult('支付失败 ¥1.21').status, 'failed');
  assert.equal(alipay.parseResult('已取消').status, 'failed');
  assert.equal(alipay.parseResult('等待付款 ¥1.21').status, 'pending');
  assert.equal(alipay.parseResult('确认付款 ¥1.21').amountMinor, null);
});

test('several amounts without a success result are not scanned for the largest number', () => {
  const result = alipay.parseResult('订单金额 ¥88 优惠 ¥10 推荐 ¥999');
  assert.notEqual(result.status, 'succeeded');
  assert.equal(result.amountMinor, null);
});

test('an unrelated success page cannot attach itself to a purchase', () => {
  const resolved = alipay.resolvePaymentTarget({ id: 9 }, {});
  assert.equal(resolved.ok, false);
  assert.match(resolved.reason, /未能关联/);
});

test('a new payment tab can continue only through its opener purchase', () => {
  const map = { 3: { purchaseId: 'p-current' }, 8: { purchaseId: 'p-other' } };
  const resolved = alipay.resolvePaymentTarget({ id: 4, openerTabId: 3 }, map);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.purchaseId, 'p-current');
});
