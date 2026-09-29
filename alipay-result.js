// 只读取支付宝结果区的成功状态和金额。不从整页挑最大数字，也不把支付流水当成拼多多订单号。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2AlipayResult = api;
  if (typeof document !== 'undefined' && typeof location !== 'undefined' && /mclient\.alipay\.com$/i.test(location.hostname || '') && typeof chrome !== 'undefined' && chrome.runtime) {
    watchPayment(api);
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
    try { chrome.runtime.sendMessage({ type: 'm2_watchPaymentTab' }); } catch (e) {}
    let inflight = false;
    let savedKey = '';
    function send() {
      const result = api.parseResult(document.body ? document.body.innerText : '');
      if (result.status !== 'succeeded' && result.status !== 'failed') return;
      const key = result.status + ':' + String(result.amountMinor);
      if (inflight || savedKey === key) return;
      inflight = true;
      chrome.runtime.sendMessage({ type: 'm2_paymentResult', result: result }, function (resp) {
        inflight = false;
        if (resp && resp.ok) savedKey = key;
      });
    }
    send();
    if (document.body && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(function () { send(); });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  }

  return { parseResult: parseResult, resolvePaymentTarget: resolvePaymentTarget };
});
