const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../zhida-api.js');

test('addExpress sends the saved paid amount instead of an empty price', () => {
  const body = api.buildAddExpressBody({
    zhidaOrderId: 'Z-1',
    zhidaItemId: 'ZI-1',
    quantity: 2,
    platformOrderSn: '260929-123456789012345',
    amount: { minor: 1980, currency: 'CNY', source: 'paid' },
  }, 'YT123456789012');
  assert.equal(body.shoppingPrice, '19.80');
  assert.equal(body.trackingNo, 'YT123456789012');
  assert.equal(body.shoppingNum, '260929-123456789012345');
  assert.equal(body.orderId, 'Z-1');
  assert.equal(body.itemId, 'ZI-1');
});

test('unknown amount is not sent as zero', () => {
  const body = api.buildAddExpressBody({
    zhidaOrderId: 'Z-1',
    zhidaItemId: 'ZI-1',
    quantity: 1,
    platformOrderSn: 'P-1',
    amount: null,
  }, 'YT123456789012');
  assert.equal(body.shoppingPrice, '');
});

test('results distinguish success, login loss, rejection and an uncertain response', () => {
  assert.equal(api.classifyResult({ httpStatus: 200, body: { success: true } }).kind, 'confirmed');
  assert.equal(api.classifyResult({ httpStatus: 401, body: {} }).kind, 'login');
  assert.equal(api.classifyResult({ httpStatus: 200, body: { success: false, message: '拒绝' } }).kind, 'rejected');
  assert.equal(api.classifyResult({ httpStatus: 0, body: null }).kind, 'network');
  assert.equal(api.classifyResult({ httpStatus: 200, body: null }).kind, 'uncertain');
});
