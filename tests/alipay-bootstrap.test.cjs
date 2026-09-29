const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../alipay-result.js'), 'utf8');

function page({ host = 'mclient.alipay.com', text = '支付成功 ¥0.61' } = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const messages = [];
  const observers = [];
  const body = { innerText: text };
  const context = {
    document: { body },
    location: { hostname: host },
    chrome: { runtime: {
      lastError: undefined,
      sendMessage(message, callback) { messages.push({ message, callback, at: now }); }
    } },
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
    },
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  function advance(ms) {
    const end = now + ms;
    for (let steps = 0; steps < 1000; steps++) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { now = end; return; }
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    throw new Error('timer loop did not settle');
  }
  function ack(index, response, lastError) {
    const sent = messages[index];
    assert.ok(sent, `message ${index} was sent`);
    assert.equal(typeof sent.callback, 'function');
    context.chrome.runtime.lastError = lastError;
    sent.callback(response);
    context.chrome.runtime.lastError = undefined;
  }
  return {
    run() { vm.runInNewContext(source, context, { filename: 'alipay-result.js' }); },
    messages,
    advance,
    ack,
    mutate(text) { body.innerText = text; for (const callback of observers) callback(); },
    pendingTimers() { return timers.size; },
    api() { return context.M2AlipayResult; }
  };
}

test('payment page bootstrap registers its tab and submits a success result', () => {
  const browser = page();
  browser.run();
  assert.deepEqual(browser.messages.map(({ message }) => message.type), ['m2_watchPaymentTab', 'm2_paymentResult']);
  assert.equal(browser.messages[1].message.result.amountMinor, 61);
  assert.equal(browser.api().parseResult('支付失败').status, 'failed');
});

test('unacknowledged tab registration retries without a DOM change, then stops after ack', () => {
  const browser = page({ text: '等待付款' });
  browser.run();
  assert.equal(browser.messages.length, 1);
  browser.ack(0, { ok: false });
  browser.advance(500);
  assert.equal(browser.messages.filter(({ message }) => message.type === 'm2_watchPaymentTab').length, 2);
  browser.ack(1, { ok: true });
  browser.advance(120000);
  assert.equal(browser.messages.length, 2);
});

test('registration and result calls recover when the response callback never arrives', () => {
  const browser = page();
  browser.run();
  browser.advance(120000);
  assert.ok(browser.messages.filter(({ message }) => message.type === 'm2_watchPaymentTab').length >= 2);
  assert.ok(browser.messages.filter(({ message }) => message.type === 'm2_paymentResult').length >= 2);
  assert.ok(browser.messages.length < 30, 'retries remain bounded');
});

test('failed result delivery retries without a DOM change and ack prevents later duplicates', () => {
  const browser = page();
  browser.run();
  browser.ack(0, { ok: true });
  browser.ack(1, { ok: false });
  browser.advance(500);
  const results = browser.messages.filter(({ message }) => message.type === 'm2_paymentResult');
  assert.equal(results.length, 2);
  browser.ack(browser.messages.indexOf(results[1]), { ok: true });
  browser.mutate('支付成功 ¥0.61');
  browser.advance(120000);
  assert.equal(browser.messages.filter(({ message }) => message.type === 'm2_paymentResult').length, 2);
});

test('duplicate DOM notifications do not submit concurrent results', () => {
  const browser = page();
  browser.run();
  browser.mutate('支付成功 ¥0.61');
  browser.mutate('支付成功 ¥0.61');
  assert.equal(browser.messages.filter(({ message }) => message.type === 'm2_paymentResult').length, 1);
});

test('irrelevant host never registers or submits payment events', () => {
  const browser = page({ host: 'example.com' });
  browser.run();
  browser.advance(120000);
  assert.equal(browser.messages.length, 0);
});
