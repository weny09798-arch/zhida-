// 拼多多采集：只认本单实付和运单，不用整页最大金额，也不把订单号当成运单号。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2Collectors = api;
})(typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  function extractPaidAmount(text) {
    const source = String(text || '');
    const patterns = [
      /优惠后付款[:：]?\s*[¥￥]?\s*([\d]+(?:\.\d+)?)/,
      /实付金额[:：]?\s*[¥￥]?\s*([\d]+(?:\.\d+)?)/,
      /实付款[:：]?\s*[¥￥]?\s*([\d]+(?:\.\d+)?)/,
      /实付[:：]?\s*[¥￥]?\s*([\d]+(?:\.\d+)?)/,
    ];
    for (let i = 0; i < patterns.length; i += 1) {
      const matched = source.match(patterns[i]);
      if (!matched) continue;
      const yuan = Number(matched[1]);
      if (Number.isNaN(yuan)) return null;
      return { yuan: yuan, minor: Math.round(yuan * 100), currency: 'CNY', source: 'paid' };
    }
    return null;
  }

  function extractOrderSn(href, text) {
    const url = String(href || '');
    const urlPatterns = [/order_sn=([^&]+)/, /orderId=([^&]+)/, /order_id=([^&]+)/, /biz_order_id=([^&]+)/];
    for (let i = 0; i < urlPatterns.length; i += 1) {
      const matched = url.match(urlPatterns[i]);
      if (matched) {
        try { return decodeURIComponent(matched[1]); } catch (e) { return matched[1]; }
      }
    }
    const textMatch = String(text || '').match(/(?:订单编号|订单号)[:：]?\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/);
    if (textMatch && textMatch[1].replace(/-/g, '').length >= 10) return textMatch[1];
    return '';
  }

  function cleanTracking(value) {
    const cleaned = String(value || '').replace(/[^A-Za-z0-9]/g, '');
    const digits = (cleaned.match(/\d/g) || []).length;
    if (digits < 8) return '';
    const matched = cleaned.match(/[A-Za-z0-9]{10,}/);
    return matched ? matched[0] : '';
  }

  function extractTracking(href, text, orderSn) {
    const orderKey = String(orderSn || '').replace(/[^A-Za-z0-9]/g, '');
    const urlMatch = String(href || '').match(/tracking_number=([^&]+)/);
    if (urlMatch) {
      let decoded = urlMatch[1];
      try { decoded = decodeURIComponent(urlMatch[1]); } catch (e) {}
      const fromUrl = cleanTracking(decoded);
      if (fromUrl && fromUrl !== orderKey) return fromUrl;
    }
    const patterns = [
      /快递单号[:：]?\s*([A-Za-z0-9]{10,})/,
      /物流单号[:：]?\s*([A-Za-z0-9]{10,})/,
      /运单号[码]?[:：]?\s*([A-Za-z0-9]{10,})/,
    ];
    const source = String(text || '');
    for (let i = 0; i < patterns.length; i += 1) {
      const matched = source.match(patterns[i]);
      if (!matched) continue;
      const tracking = cleanTracking(matched[1]);
      if (tracking && tracking !== orderKey) return tracking;
    }
    return '';
  }

  function mergeAmount(existing, incoming) {
    if (!incoming || incoming.minor == null || Number.isNaN(Number(incoming.minor))) return existing || null;
    if (incoming.source && incoming.source !== 'paid') return existing || null;
    if (existing && existing.minor > 0 && Number(incoming.minor) === 0) return existing;
    return incoming;
  }

  return {
    extractPaidAmount: extractPaidAmount,
    extractOrderSn: extractOrderSn,
    extractTracking: extractTracking,
    mergeAmount: mergeAmount,
  };
});
