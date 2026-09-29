const test = require('node:test');
const assert = require('node:assert/strict');
const discovery = require('../pdd-order-discovery.js');

const intent = {
  accountId: 'acc-1',
  goodsId: 'G1',
  skuId: 'S1',
  quantity: 1,
  mallId: 'M1',
  submittedAt: 1000,
  paidAt: 2000,
};

function card(extra) {
  return Object.assign({
    orderSn: '260929-111111111111111',
    goodsId: 'G1',
    skuId: 'S1',
    quantity: 1,
    mallId: 'M1',
    accountId: 'acc-1',
    createdAt: 1500,
    payMinor: 121,
    status: 'unshipped',
    detailHref: 'https://mobile.yangkeduo.com/order.html?order_sn=260929-111111111111111',
  }, extra);
}

test('one fully checked card can be claimed when the search is complete', () => {
  const result = discovery.matchCandidates(intent, [card({})], { searchComplete: true, claimedOrderSns: [] });
  assert.equal(result.status, 'unique');
  assert.equal(result.matches[0].orderSn, '260929-111111111111111');
});

test('two same-goods orders are left for the user to choose', () => {
  const result = discovery.matchCandidates(intent, [
    card({ orderSn: '260929-111111111111111' }),
    card({ orderSn: '260929-222222222222222', createdAt: 1600 }),
  ], { searchComplete: true, claimedOrderSns: [] });
  assert.equal(result.status, 'choose');
  assert.equal(result.matches.length, 2);
});

test('an unfinished list cannot be treated as the only match', () => {
  const result = discovery.matchCandidates(intent, [card({})], { searchComplete: false, claimedOrderSns: [] });
  assert.equal(result.status, 'incomplete');
});

test('missing detail fields and an account change do not auto-claim', () => {
  const missing = discovery.matchCandidates(intent, [card({ skuId: '' })], { searchComplete: true, claimedOrderSns: [] });
  assert.notEqual(missing.status, 'unique');
  const switched = discovery.matchCandidates(intent, [card({ accountId: 'acc-2' })], { searchComplete: true, claimedOrderSns: [] });
  assert.equal(switched.status, 'account_changed');
});

test('an order already claimed by another purchase is not taken', () => {
  const result = discovery.matchCandidates(intent, [card({})], {
    searchComplete: true,
    claimedOrderSns: ['260929-111111111111111'],
  });
  assert.equal(result.status, 'none');
});

test('a paid group order waiting to be shared can be chosen', () => {
  const result = discovery.matchCandidates(intent, [
    card({ status: '待分享', orderSn: '260929-333333333333333', goodsId: '', skuId: '', quantity: 1, createdAt: null }),
  ], { searchComplete: true, claimedOrderSns: [], listTarget: '待分享' });
  assert.equal(result.status, 'choose');
  assert.equal(result.matches[0].orderSn, '260929-333333333333333');
});

test('an unpaid card is not treated as this purchase', () => {
  const result = discovery.matchCandidates(intent, [
    card({ status: 'unpaid' }),
  ], { searchComplete: true, claimedOrderSns: [], listTarget: '待分享' });
  assert.equal(result.status, 'none');
});

test('the same amount alone does not choose the first card', () => {
  const result = discovery.matchCandidates(intent, [
    card({ orderSn: '260929-111111111111111', goodsId: 'OTHER', skuId: 'S1' }),
    card({ orderSn: '260929-222222222222222' }),
  ], { searchComplete: true, claimedOrderSns: [] });
  assert.equal(result.status, 'unique');
  assert.equal(result.matches[0].orderSn, '260929-222222222222222');
});

test('a missing account id can inspect one recent paid candidate without claiming it from the list', () => {
  const now = Date.now();
  const orderSn = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, '') + '-619566907750351';
  const result = discovery.matchCandidates({ goodsId: 'G1', submittedAt: now }, [card({
    orderSn, goodsId: '', accountId: '', skuId: '', createdAt: null, payMinor: 78,
    detailHref: 'https://mobile.yangkeduo.com/order.html?order_sn=' + orderSn,
  })], { searchComplete: true, paidMinor: 78, claimedOrderSns: [] });
  assert.equal(result.status, 'inspect');
  assert.equal(result.matches[0].orderSn, orderSn);
});

test('a missing account id with no matching order keeps searching instead of pausing', () => {
  const result = discovery.matchCandidates({ goodsId: 'G1' }, [], { searchComplete: true, paidMinor: 78, claimedOrderSns: [] });
  assert.equal(result.status, 'none');
});
