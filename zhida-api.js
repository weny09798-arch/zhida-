// 只使用已经在插件里调用过的 /order/addExpress。
// 没有核实过独立的金额保存接口，所以没有运单号时不调用它，金额先留在本地。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2ZhidaApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  function buildAddExpressBody(record, trackingNo) {
    const amount = record && record.amount;
    const price = amount && amount.minor != null ? (amount.minor / 100).toFixed(2) : '';
    return {
      id: '',
      trackingNo: trackingNo || '',
      expressCode: '',
      sendQuantity: (record && record.quantity) || 1,
      shoppingPrice: price,
      itemId: (record && record.zhidaItemId) || '',
      note: '',
      orderId: (record && record.zhidaOrderId) || '',
      shoppingNum: (record && record.platformOrderSn) || '',
    };
  }

  function classifyResult(result) {
    const httpStatus = result && result.httpStatus;
    const body = result && result.body;
    if (!httpStatus) return { ok: false, kind: 'network', message: '网络失败或没有响应' };
    if (httpStatus === 401 || httpStatus === 403) return { ok: false, kind: 'login', message: '登录已失效' };
    if (httpStatus === 200 && body && body.success === true) return { ok: true, kind: 'confirmed', message: '' };
    if (httpStatus === 200 && body && body.success === false) {
      return { ok: false, kind: 'rejected', message: body.message || '至达拒绝了这次回传' };
    }
    if (httpStatus === 200 && !body) return { ok: false, kind: 'uncertain', message: '响应不完整，不能当成已保存' };
    return { ok: false, kind: 'network', message: '请求失败（HTTP ' + httpStatus + '）' };
  }

  return { buildAddExpressBody: buildAddExpressBody, classifyResult: classifyResult };
});
