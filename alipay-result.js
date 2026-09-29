// 只读取支付宝结果区的成功状态和金额。不从整页挑最大数字，也不把支付流水当成拼多多订单号。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2AlipayResult = api;
  if (typeof document !== 'undefined' && typeof location !== 'undefined' && /mclient\.alipay\.com$/i.test(location.hostname || '') && typeof chrome !== 'undefined' && chrome.runtime) {
    api.watchPayment();
  }
})(typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  function parseResult(text) {
    const source = String(text || '');
    if (/支付失败|付款失败|已取消|交易关闭/.test(source)) {
      return { status: 'failed', amountMinor: null, currency: 'CNY', source: 'alipay-result' };
    }
    if (!/支付成功/.test(source)) {
      return { status: /等待付款|待付款|确认付款|等待支付/.test(source) ? 'pending' : 'unknown', amountMinor: null, currency: 'CNY', source: 'alipay-result' };
    }
    const at = source.indexOf('支付成功');
    const region = source.slice(Math.max(0, at - 30), at + 80);
    const matched = region.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
    if (!matched) return { status: 'succeeded', amountMinor: null, currency: 'CNY', source: 'alipay-result' };
    const yuan = Number(matched[1]);
    if (Number.isNaN(yuan)) return { status: 'succeeded', amountMinor: null, currency: 'CNY', source: 'alipay-result' };
    return { status: 'succeeded', amountMinor: Math.round(yuan * 100), currency: 'CNY', source: 'alipay-result' };
  }

  function resolvePaymentTarget(tab, tabContextMap) {
    const map = tabContextMap || {};
    const current = tab || {};
    const own = map[current.id] || map[String(current.id)];
    if (own && own.purchaseId && own.purpose !== 'collect_orders') {
      return { ok: true, purchaseId: own.purchaseId, via: 'tab' };
    }
    const opener = current.openerTabId != null ? (map[current.openerTabId] || map[String(current.openerTabId)]) : null;
    if (opener && opener.purchaseId) return { ok: true, purchaseId: opener.purchaseId, via: 'opener' };
    return { ok: false, reason: '付款页未能关联到本次采购' };
  }

  function watchPayment(api) {
    function sender(buildMessage) {
      let inFlight = false;
      let retryTimer = null;
      let savedKey = '';
      let failures = 0;
      function send() {
        if (inFlight || retryTimer !== null) return;
        const item = buildMessage();
        if (!item || item.key === savedKey) return;
        inFlight = true;
        let finished = false;
        const timeout = setTimeout(function () { finish(false); }, 3000);
        function finish(ok) {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          inFlight = false;
          if (ok) {
            savedKey = item.key;
            failures = 0;
            send();
          } else {
            const delay = Math.min(30000, 500 * Math.pow(2, Math.min(failures++, 6)));
            retryTimer = setTimeout(function () {
              retryTimer = null;
              send();
            }, delay);
          }
        }
        try {
          chrome.runtime.sendMessage(item.message, function (response) {
            finish(!chrome.runtime.lastError && !!(response && response.ok));
          });
        } catch (e) {
          finish(false);
        }
      }
      return send;
    }
    const register = sender(function () {
      return { key: 'tab', message: { type: 'm2_watchPaymentTab' } };
    });
    const sendResult = sender(function () {
      const result = api.parseResult(document.body ? document.body.innerText : '');
      if (result.status !== 'succeeded' && result.status !== 'failed') return null;
      return {
        key: result.status + ':' + String(result.amountMinor),
        message: { type: 'm2_paymentResult', result: result }
      };
    });
    register();
    sendResult();
    if (document.body && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(function () { sendResult(); });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  return { parseResult: parseResult, resolvePaymentTarget: resolvePaymentTarget, watchPayment: function () { watchPayment(this); } };
});
