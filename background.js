importScripts('purchase-store.js', 'binding-store.js', 'sync-queue.js', 'zhida-api.js', 'alipay-result.js', 'pdd-order-discovery.js');

// ============================================================
// 至达国际 采购助手 —— background.js（service worker）
//
// 适配 zhida.shopeeok.com
// ✅ addExpress 回传运输单号接口已对接
// ============================================================

const BASE = 'https://zhida.shopeeok.com/agent-foreign';
const VERSION = chrome.runtime.getManifest().version;
const LOGISTICS_INTERVAL_MS = 30 * 60 * 1000;
const ORDER_LOOKUP_WINDOW_MS = 2 * 60 * 1000;

// 统一请求封装：cookie 认证 + token（token_hook.js 存到 storage）
async function apiRequest(path, { method = 'GET', params = {}, body } = {}) {
  let url = BASE + path;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
  }
  if ([...qs].length) url += '?' + qs.toString();

  const headers = {
    accept: 'application/json, text/plain, */*',
  };
  if (body !== undefined && body !== null) {
    headers['content-type'] = 'application/json;charset=UTF-8';
  }

  // 读取 token_hook.js 存入的 token
  try {
    const tk = await chrome.storage.local.get('__zhidaToken');
    if (tk && tk.__zhidaToken) headers['x-access-token'] = tk.__zhidaToken;
  } catch (e) {}

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }

  return { url, method, httpStatus: res.status, ok: res.ok, body: data };
}

// 接口封装（zhida.shopeeok.com）
const API = {
  // 订单列表：POST /order/list/v2
  findOrderList: (page = 1, pageSize = 100) =>
    apiRequest('/order/list/v2', {
      method: 'POST',
      body: { pageNo: page, pageSize, dgStatus: '2', queryType: 'orderByCollaborate', orderBy: '0' },
    }),

  // 回传运输单号：POST /order/addExpress
  addExpress: (body) =>
    apiRequest('/order/addExpress', { method: 'POST', body }),
};

const storageAdapter = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (values) => chrome.storage.local.set(values),
};
const purchaseStore = M2PurchaseStore.createStore(storageAdapter);
const bindingStore = M2BindingStore.createStore(storageAdapter);
const syncQueue = M2SyncQueue.createQueue(storageAdapter);

function sameLegacyLine(source, identity) {
  const row = source || {};
  if (identity.zhidaOrderId && identity.zhidaItemId && row.zhidaOrderId && row.zhidaItemId) {
    return String(row.zhidaOrderId) === String(identity.zhidaOrderId)
      && String(row.zhidaItemId) === String(identity.zhidaItemId);
  }
  if (row.zhidaOrderId && row.zhidaItemId) return false;
  return String(row.orderSn || '') === String(identity.orderSn || '')
    && String(row.itemId || '') === String(identity.itemId || '')
    && String(row.modelId || '') === String(identity.modelId || '');
}

async function clearLegacyLine(identity) {
  const data = await chrome.storage.local.get(['orderStatusMap', 'syncedLogistics', 'pendingCollect', 'purchaseRecords']);
  const status = Object.assign({}, data.orderStatusMap || {});
  delete status[String(identity.orderSn || '') + '_' + String(identity.itemId || '') + '_' + String(identity.modelId || '')];
  const synced = (data.syncedLogistics || []).filter(function (item) { return !sameLegacyLine(item, identity); });
  const pending = (data.pendingCollect || []).filter(function (item) { return !sameLegacyLine(item.shopeeOrder || item, identity); });
  const records = Object.assign({}, data.purchaseRecords || {});
  Object.keys(records).forEach(function (sn) {
    const source = records[sn] || {};
    if (sameLegacyLine(source.shopeeOrder || source, identity)) delete records[sn];
  });
  await chrome.storage.local.set({
    orderStatusMap: status,
    syncedLogistics: synced,
    pendingCollect: pending,
    purchaseRecords: records,
  });
}
purchaseStore.migrateLegacy().then(function () { return purgeUnboundPurchases(); }).catch(function () {});

async function purgeUnboundPurchases() {
  const state = await bindingStore.read();
  const purchases = await purchaseStore.list();
  const identities = M2BindingStore.collectUnboundIdentities(purchases, state.bindingMap, state.exclusions);
  const removedIds = [];
  for (const identity of identities) {
    const removed = await purchaseStore.removeForLine(identity);
    if (removed && removed.purchaseIds) removedIds.push.apply(removedIds, removed.purchaseIds);
    await clearLegacyLine(identity);
  }
  if (removedIds.length) await syncQueue.dropByPurchaseIds(removedIds);
  return { ok: true, removedPurchaseIds: removedIds };
}

async function readTabContext(tabId) {
  if (tabId == null) return null;
  const stored = await chrome.storage.local.get('tabContextMap');
  const map = stored.tabContextMap || {};
  return map[tabId] || map[String(tabId)] || null;
}

async function rememberTab(tabId, context) {
  const stored = await chrome.storage.local.get('tabContextMap');
  const map = stored.tabContextMap || {};
  const previous = map[tabId];
  map[tabId] = previous && previous.purchaseId === context.purchaseId && previous.collectionFinished
    ? Object.assign({}, context, { collectionFinished: true }) : context;
  for (const tid of Object.keys(map)) {
    try {
      const existing = await chrome.tabs.get(parseInt(tid, 10));
      if (!existing) delete map[tid];
    } catch (e) {
      delete map[tid];
    }
  }
  await chrome.storage.local.set({ tabContextMap: map });
}

let collectorFocusChain = Promise.resolve();
function orderCollectionComplete(row) {
  return !!(row && row.platformOrderSn && (row.logisticsSync === 'confirmed'
    || (row.amount && row.amount.minor != null && Number.isFinite(Number(row.amount.minor)))));
}
function orderLookupAllowed(row, now) {
  const session = row && row.lookupSession;
  return !!(session && session.id && session.startedAt <= now && session.expiresAt > now);
}
function collectorSessionStopped(ctx, row, now) {
  return !orderLookupAllowed(row, now) || (ctx.foregroundManaged
    && ctx.lookupSessionId !== row.lookupSession.id);
}
async function pauseExpiredLookup(row) {
  if (!row || orderCollectionComplete(row) || orderLookupAllowed(row, Date.now())) return;
  if (!orderCollectionPaused(row) && (row.paymentReceipt || row.platformOrderSn)) {
    await purchaseStore.saveCandidates(row.purchaseId, row.candidates || [], 'paused',
      '本轮自动查单已结束，已停止切换页面。需要继续查找时请点击重试补采', row.collection && row.collection.listTarget);
  }
  await syncQueue.pause('order_identity:' + row.purchaseId, '查单已过期，等待重试补采');
  await syncQueue.pause('order_detail:' + row.purchaseId, '查单已过期，等待重试补采');
}
function orderCollectionPaused(row) {
  const stage = row && row.collection && row.collection.stage;
  return !!(row && (row.status === 'awaiting_login'
    || ['paused', 'awaiting_choice', 'needs_review', 'not_found'].includes(stage)));
}
function collectorTask(ctx, row, tasks) {
  const id = ctx.taskId || (row && row.platformOrderSn ? 'order_detail:' : 'order_identity:') + ctx.purchaseId;
  return (tasks || []).find(function (task) { return task.id === id; });
}
function collectorQueueStopped(ctx, row, tasks) {
  if (!ctx.foregroundManaged) return false;
  const task = collectorTask(ctx, row, tasks);
  return !task || task.status === 'confirmed' || task.status === 'paused';
}
async function settleOrderCollection(row, purchaseId) {
  for (const kind of ['order_identity', 'order_detail']) {
    const id = kind + ':' + purchaseId;
    if (!row || orderCollectionComplete(row) || (kind === 'order_identity' && row.platformOrderSn)) {
      await syncQueue.confirm(id);
    } else if (orderCollectionPaused(row)) {
      await syncQueue.pause(id, row.collection && row.collection.reason || '这一轮查单已结束，等待重试');
    }
  }
}
function changeCollectorFocus(action) {
  const next = collectorFocusChain.then(action, action);
  collectorFocusChain = next.catch(function () {});
  return next;
}

function finishCollector(tabId) {
  return changeCollectorFocus(async function () {
    const ctx = await readTabContext(tabId);
    if (!ctx || !ctx.foregroundManaged || ctx.collectionFinished) return;
    await rememberTab(tabId, Object.assign({}, ctx, { collectionFinished: true }));
    if (ctx.parentCollectorTabId != null) {
      const parent = await readTabContext(ctx.parentCollectorTabId);
      if (parent && parent.purchaseId === ctx.purchaseId && parent.foregroundManaged) {
        await rememberTab(ctx.parentCollectorTabId, Object.assign({}, parent, { collectionFinished: true }));
      }
    }
    try {
      const collector = await chrome.tabs.get(tabId);
      // 用户已主动切到别的页面时，保留他的选择。
      if (collector.active && ctx.returnTabId != null && ctx.returnTabId !== tabId) {
        const previous = await chrome.tabs.get(ctx.returnTabId);
        if (previous.windowId === collector.windowId) await chrome.tabs.update(previous.id, { active: true });
      }
    } catch (e) {}
    const wake = setTimeout(function () { autoCollect(); }, 0);
    if (wake && typeof wake.unref === 'function') wake.unref();
  });
}

function activateCollector(tabId, purchaseId) {
  return changeCollectorFocus(async function () {
    const ctx = await readTabContext(tabId);
    if (!ctx || ctx.purpose !== 'collect_orders' || !ctx.foregroundManaged
      || ctx.collectionFinished || ctx.purchaseId !== purchaseId) {
      return { ok: false, error: '当前页面没有正在执行的查单任务' };
    }
    const row = await purchaseStore.get(purchaseId);
    const stored = await chrome.storage.local.get('m2SyncTasks');
    const task = collectorTask(ctx, row, stored.m2SyncTasks);
    if (!row || orderCollectionComplete(row) || orderCollectionPaused(row)
      || collectorSessionStopped(ctx, row, Date.now())
      || !task || task.status !== 'leased' || !task.leaseUntil || task.leaseUntil <= Date.now()) {
      await rememberTab(tabId, Object.assign({}, ctx, { collectionFinished: true }));
      await settleOrderCollection(row, purchaseId);
      await pauseExpiredLookup(row);
      return { ok: false, error: '这一轮查单已经结束，不再切换页面' };
    }
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active && Date.now() - (ctx.lastActivationAt || 0) >= 1000) {
      const visible = await chrome.tabs.query({ active: true, windowId: tab.windowId });
      await rememberTab(tabId, Object.assign({}, ctx, {
        returnTabId: visible[0] ? visible[0].id : ctx.returnTabId,
        lastActivationAt: Date.now(), lastProgressAt: Date.now(),
      }));
      await chrome.tabs.update(tabId, { active: true });
    }
    return { ok: true };
  });
}

// 从拼多多链接提取 goods_id
function extractGoodsId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('goods_id') || u.searchParams.get('goodsId') || '';
  } catch (e) {
    const m = url.match(/goods_id=(\d+)/);
    return m ? m[1] : '';
  }
}

function formatDateTime(d) {
  d = d || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  );
}

function platformName(platform) {
  if (platform === 'TAOBAO') return '淘宝';
  if (platform === 'ALIBABA') return '1688';
  return '拼多多';
}

// 同一笔虾皮订单商品：订单号必须一致；itemId / modelId 有值才比较。
// 避免数字和字符串、空规格对不上时，查物流退回到订单列表。
function sameShopeeItem(stored, current) {
  if (!stored || !current) return false;
  if (!stored.orderSn || !current.orderSn) return false;
  if (String(stored.orderSn) !== String(current.orderSn)) return false;
  const storedItem = stored.itemId == null ? '' : String(stored.itemId);
  const currentItem = current.itemId == null ? '' : String(current.itemId);
  if (storedItem && currentItem && storedItem !== currentItem) return false;
  const storedModel = stored.modelId == null ? '' : String(stored.modelId);
  const currentModel = current.modelId == null ? '' : String(current.modelId);
  if (storedModel && currentModel && storedModel !== currentModel) return false;
  return true;
}

// 根据平台 + 第三方订单号，构造「这一单」的页面（用于采集运输单号）
// 拼多多不用 order.html：那是订单列表，列表上看不到这一单的订单编号、运单号和价格
function buildDetailUrl(platform, orderSn) {
  const sn = encodeURIComponent(orderSn || '');
  if (platform === 'PINDUODUO') {
    return 'https://mobile.yangkeduo.com/goods_express.html?order_sn=' + sn + '&refer_page_name=order_detail';
  }
  if (platform === 'TAOBAO') {
    return 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=' + sn;
  }
  if (platform === 'ALIBABA') {
    return 'https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=' + sn;
  }
  return 'https://mobile.yangkeduo.com/goods_express.html?order_sn=' + sn + '&refer_page_name=order_detail';
}

function isVerifiedPaidDetail(purchase, tabCtx, msg, tabUrl) {
  if (!purchase || !tabCtx || tabCtx.lastStage !== 'entering_detail' || !tabCtx.candidate) return false;
  const receipt = purchase.paymentReceipt;
  if (!receipt || receipt.status !== 'succeeded' || receipt.amountMinor == null) return false;
  if (msg.price == null || msg.price === '' || !Number.isFinite(Number(msg.price))) return false;
  if (Math.round(Number(msg.price) * 100) !== Number(receipt.amountMinor)) return false;
  if (tabCtx.candidate.orderSn && tabCtx.candidate.orderSn !== msg.orderSn) return false;
  const match = String(msg.orderSn || '').match(/^(\d{6})-\d{15}$/);
  if (!match) return false;
  const dates = [purchase.purchaseIntent && purchase.purchaseIntent.submittedAt, receipt.observedAt]
    .filter(Boolean)
    .map(function (at) { return new Date(Number(at) + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, ''); });
  if (!dates.includes(match[1])) return false;
  try {
    const url = new URL(tabUrl);
    return url.origin === 'https://mobile.yangkeduo.com'
      && url.pathname === '/order.html'
      && url.searchParams.get('order_sn') === msg.orderSn;
  } catch (e) { return false; }
}

// 消息处理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 通用请求（诊断/调试用，popup 或 content 都可用）
  if (msg && msg.type === 'm2_request') {
    (async () => {
      try {
        const result = await apiRequest(msg.path, {
          method: msg.method,
          params: msg.params,
          body: msg.body,
        });
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 绑定货源：调 bind 接口
  if (msg && msg.type === 'm2_bind') {
    (async () => {
      try {
        const goodsId = msg.goodsId || extractGoodsId(msg.productUrl || '');
        if (!goodsId) {
          sendResponse({ ok: false, error: '无法从链接提取 goods_id，请手动填写商品ID' });
          return;
        }
        const bindBody = {
          shopeeItemId: msg.itemId,
          shopeeModelId: msg.modelId,
          thirdPartyPlatform: msg.platform || 'PINDUODUO',
          thirdPartyProductId: goodsId,
          thirdPartyProductName: msg.productName || msg.itemName || '',
          thirdPartyProductUrl: msg.productUrl,
          thirdPartyPrice: msg.price || 0,
          thirdPartySku: '',
        };
        const result = await API.bind(bindBody);
        sendResponse({ ok: true, result, goodsId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_purgeUnbound') {
    (async () => {
      try {
        sendResponse(await purgeUnboundPurchases());
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && (msg.type === 'm2_bindShared' || msg.type === 'm2_unbindCurrent' || msg.type === 'm2_restoreCurrentBinding')) {
    (async () => {
      try {
        const identity = msg.identity || {};
        let result;
        if (msg.type === 'm2_bindShared') result = await bindingStore.bind({ identity: identity, binding: msg.binding || {} });
        else if (msg.type === 'm2_unbindCurrent') {
          result = await bindingStore.exclude({ identity: identity, bindingId: msg.bindingId });
          if (!result || result.ok !== false) {
            const removed = await purchaseStore.removeForLine(identity);
            if (removed && removed.ok === false) {
              result = removed;
            } else {
              await syncQueue.dropByPurchaseIds(removed.purchaseIds);
              await clearLegacyLine(identity);
              result = Object.assign({}, result, { removedPurchaseIds: removed.purchaseIds });
            }
          }
        }
        else result = await bindingStore.restore({ identity: identity, bindingId: msg.bindingId });
        sendResponse(result && result.ok === false ? result : Object.assign({ ok: true }, result));
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 启动采购：打开拼多多商品页，并把采购上下文存入 storage 供 pdd_order.js 读取
  if (msg && msg.type === 'm2_startPurchase') {
    (async () => {
      try {
        const shopeeOrder = msg.shopeeOrder || {};
        const purchase = await purchaseStore.create({
          orderSn: shopeeOrder.orderSn,
          itemId: shopeeOrder.itemId,
          modelId: shopeeOrder.modelId,
          zhidaOrderId: shopeeOrder.zhidaOrderId,
          zhidaItemId: shopeeOrder.zhidaItemId,
          quantity: msg.quantity,
          itemName: shopeeOrder.itemName,
          modelName: shopeeOrder.modelName,
          imageUrl: shopeeOrder.imageUrl,
          platform: msg.platform || 'PINDUODUO',
          productUrl: msg.productUrl,
          bindingId: msg.bindingId || '',
        });
        const context = {
          purchaseId: purchase.purchaseId,
          productUrl: msg.productUrl,
          platform: purchase.platform,
          quantity: msg.quantity,
          shopeeOrder: shopeeOrder,
          selectedSpecs: msg.selectedSpecs || {},
          currentStep: 'product',
          platformOrderSn: '',
        };
        const tab = await chrome.tabs.create({ url: msg.productUrl, active: true });
        if (tab && tab.id) await rememberTab(tab.id, context);
        sendResponse({ ok: true, tabId: tab && tab.id, purchaseId: purchase.purchaseId, status: 'opened' });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // pdd_order.js 查询「当前 tab 对应的采购上下文」（解决多单并发串单）
  if (msg && msg.type === 'm2_getTabContext') {
    (async () => {
      try {
        const tabId = sender && sender.tab && sender.tab.id;
        const stored = await chrome.storage.local.get('tabContextMap');
        const map = stored.tabContextMap || {};
        const ctx = tabId != null ? map[tabId] : null;
        if (ctx && ctx.purpose === 'collect_orders' && !ctx.collectionFinished) {
          const row = await purchaseStore.get(ctx.purchaseId);
          const tasks = await chrome.storage.local.get('m2SyncTasks');
          if (!row || orderCollectionComplete(row) || orderCollectionPaused(row)
            || collectorSessionStopped(ctx, row, Date.now())
            || collectorQueueStopped(ctx, row, tasks.m2SyncTasks)) {
            await settleOrderCollection(row, ctx.purchaseId);
            await pauseExpiredLookup(row);
            await finishCollector(tabId);
            ctx.collectionFinished = true;
            await rememberTab(tabId, ctx);
          }
        }
        sendResponse({ ok: true, context: ctx || null });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 结账已提交，但还不能当成付款成功，也不能当成已经有采购订单号
  if (msg && msg.type === 'm2_purchaseSubmitted') {
    (async () => {
      try {
        const tabCtx = await readTabContext(sender && sender.tab && sender.tab.id);
        const purchaseId = tabCtx && tabCtx.purchaseId;
        if (!purchaseId || (msg.purchaseId && msg.purchaseId !== purchaseId)) {
          sendResponse({ ok: false, error: '无法确定是哪一次采购' });
          return;
        }
        await purchaseStore.markSubmitted(purchaseId);
        sendResponse({ ok: true, purchaseId: purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_savePurchaseIntent') {
    (async () => {
      try {
        const tabCtx = await readTabContext(sender && sender.tab && sender.tab.id);
        const purchaseId = tabCtx && tabCtx.purchaseId;
        if (!purchaseId || (msg.purchaseId && msg.purchaseId !== purchaseId)) {
          sendResponse({ ok: false, error: '无法确定是哪一次采购' });
          return;
        }
        const saved = await purchaseStore.setPurchaseIntent(purchaseId, msg.intent || {});
        sendResponse({ ok: !!saved, purchaseId: purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_paymentResult') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get('tabContextMap');
        const resolved = M2AlipayResult.resolvePaymentTarget(sender && sender.tab, stored.tabContextMap || {});
        if (!resolved.ok) {
          sendResponse({ ok: false, error: resolved.reason });
          return;
        }
        const saved = await purchaseStore.recordPayment(resolved.purchaseId, msg.result || {});
        if (!saved || saved.ok === false) {
          sendResponse({ ok: false, error: '支付结果没有保存' });
          return;
        }
        if (msg.result && msg.result.status === 'succeeded') {
          const purchase = await purchaseStore.get(resolved.purchaseId);
          if (purchase && !purchase.platformOrderSn) {
            if (!saved.duplicate) await purchaseStore.startLookupSession(resolved.purchaseId, 'payment', ORDER_LOOKUP_WINDOW_MS);
            await kickOrderLookup(resolved.purchaseId);
          }
        }
        sendResponse({ ok: true, purchaseId: resolved.purchaseId, duplicate: !!saved.duplicate });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_orderCandidates') {
    (async () => {
      try {
        const tabCtx = await readTabContext(sender && sender.tab && sender.tab.id);
        const purchaseId = tabCtx && tabCtx.purpose === 'collect_orders' && !tabCtx.collectionFinished ? tabCtx.purchaseId : '';
        if (!purchaseId || (msg.purchaseId && msg.purchaseId !== purchaseId)) {
          sendResponse({ ok: false, error: '采集页没有对上采购记录' });
          return;
        }
        const purchase = await purchaseStore.get(purchaseId);
        if (!purchase || collectorSessionStopped(tabCtx, purchase, Date.now())) {
          sendResponse({ ok: false, error: '这张页面属于已结束的查单，请点击重试补采' });
          return;
        }
        const claimed = (await purchaseStore.list()).map(function (row) { return row.platformOrderSn; }).filter(Boolean);
        const result = M2Discovery.matchCandidates(purchase.purchaseIntent || {}, msg.cards || [], {
          searchComplete: !!msg.searchComplete && !msg.limitReached,
          claimedOrderSns: claimed,
          paidMinor: purchase.paymentReceipt && purchase.paymentReceipt.amountMinor,
          listTarget: msg.listTarget || (tabCtx && tabCtx.listTarget) || '待分享',
        });
        if (result.status === 'inspect') {
          const candidate = result.matches[0];
          await purchaseStore.saveCandidates(purchaseId, [candidate], 'entering_detail', '正在打开订单详情核对支付金额', tabCtx.listTarget);
          await rememberTab(sender.tab.id, Object.assign({}, tabCtx, {
            candidate: candidate, lastStage: 'entering_detail', lastProgressAt: Date.now(),
          }));
          sendResponse({ ok: true, purchaseId: purchaseId, status: 'inspect', detailHref: candidate.detailHref });
          return;
        }
        if (result.status === 'unique') {
          const claim = await purchaseStore.claimCandidate(purchaseId, result.matches[0]);
          if (!claim.ok) {
            await purchaseStore.saveCandidates(purchaseId, result.matches, 'needs_review', '这张订单已经被另一笔采购记下');
            await finishCollector(sender && sender.tab && sender.tab.id);
            sendResponse({ ok: false, error: '订单归属冲突' });
            return;
          }
          await syncQueue.confirm('order_identity:' + purchaseId);
          await syncQueue.schedule({ id: 'order_detail:' + purchaseId, purchaseId: purchaseId, kind: 'order_detail', nextAt: Date.now() });
          await finishCollector(sender && sender.tab && sender.tab.id);
          sendResponse({ ok: true, purchaseId: purchaseId, status: 'unique' });
          return;
        }
        if (result.status === 'none' && msg.hasVisiblePaidCard) {
          const listTarget = msg.listTarget || (tabCtx && tabCtx.listTarget) || '待分享';
          const reason = listTarget + '里能看到符合实付金额的订单，但插件无法安全确定并打开对应详情。请手动点开对应订单，或稍后重试补采';
          await purchaseStore.saveCandidates(purchaseId, [], 'paused', reason, listTarget);
          await syncQueue.pause('order_identity:' + purchaseId, reason);
          await finishCollector(sender && sender.tab && sender.tab.id);
          sendResponse({ ok: true, purchaseId: purchaseId, status: 'unreadable' });
          return;
        }
        if (result.status === 'choose') {
          await purchaseStore.saveCandidates(purchaseId, result.matches, 'awaiting_choice', '有多笔相似订单，请选择对应的一笔');
        } else if (result.status === 'account_changed' || result.status === 'account_unknown') {
          await purchaseStore.saveCandidates(purchaseId, [], 'needs_review', '拼多多账号无法确认，已暂停自动认领');
        } else if (result.status === 'incomplete') {
          await purchaseStore.saveCandidates(purchaseId, result.matches, 'incomplete', '订单列表还没看完，不能把目前看到的一笔当成结果');
        } else if ((msg.listTarget || (tabCtx && tabCtx.listTarget) || '待分享') !== '待发货') {
          const checked = Math.max(0, Math.min(10, Number(msg.shareScanCount) || 0));
          if (checked < 4) {
            await purchaseStore.saveCandidates(purchaseId, [], 'incomplete', '待分享还在重复查找，暂不切换到待发货', '待分享');
            sendResponse({ ok: true, purchaseId: purchaseId, status: 'share_waiting' });
            return;
          }
          await purchaseStore.saveCandidates(purchaseId, [], 'share_pending',
            '待分享已查看' + checked + '次，暂未找到对应订单，接着查看待发货', '待发货');
          if (sender && sender.tab && sender.tab.id) {
            await rememberTab(sender.tab.id, Object.assign({}, tabCtx, { listTarget: '待发货', purpose: 'collect_orders' }));
          }
          sendResponse({ ok: true, purchaseId: purchaseId, status: 'share_pending', nextList: '待发货' });
          return;
        } else {
          await purchaseStore.saveCandidates(purchaseId, [], 'not_found', '这一轮在待分享和待发货里未找到对应订单，已暂停自动查单。请稍后点击重试补采');
          await syncQueue.pause('order_identity:' + purchaseId, '这一轮查单未找到对应订单，请点击重试补采');
          await syncQueue.pause('order_detail:' + purchaseId, '这一轮查单未找到对应订单，请点击重试补采');
        }
        if (result.status === 'choose' || result.status === 'account_changed' || result.status === 'account_unknown'
          || (result.status === 'none' && tabCtx.listTarget === '待发货')) {
          await finishCollector(sender && sender.tab && sender.tab.id);
        }
        sendResponse({ ok: true, purchaseId: purchaseId, status: result.status });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_collectorNeedsVisibility') {
    (async () => {
      try {
        const tabId = sender && sender.tab && sender.tab.id;
        sendResponse(await activateCollector(tabId, msg.purchaseId));
      } catch (err) { sendResponse({ ok: false, error: String(err) }); }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_collectionProgress') {
    (async () => {
      try {
        const tabId = sender && sender.tab && sender.tab.id;
        const tabCtx = await readTabContext(tabId);
        if (!tabCtx || tabCtx.purpose !== 'collect_orders' || tabCtx.collectionFinished || tabCtx.purchaseId !== msg.purchaseId) {
          sendResponse({ ok: false, error: '采集页没有对上采购记录' });
          return;
        }
        const purchase = await purchaseStore.get(msg.purchaseId);
        if (!purchase || orderCollectionComplete(purchase) || collectorSessionStopped(tabCtx, purchase, Date.now())) {
          sendResponse({ ok: false, error: '这张页面属于已结束的查单' });
          return;
        }
        if (msg.candidate && msg.candidate.orderSn) {
          const owners = await purchaseStore.findByPlatformOrder('PINDUODUO', msg.candidate.orderSn);
          if (owners.some(function (row) { return row.purchaseId !== msg.purchaseId; })) {
            sendResponse({ ok: false, error: '该订单号已关联到上一笔采购，已跳过此详情页' });
            return;
          }
        }
        const stage = msg.stage === 'entering_detail' ? 'entering_detail' : 'opening_list';
        const candidate = msg.candidate && msg.candidate.orderSn ? [{ orderSn: msg.candidate.orderSn, detailHref: msg.candidate.detailHref || '' }] : [];
        await purchaseStore.saveCandidates(msg.purchaseId, candidate, stage,
          stage === 'entering_detail' ? '正在进入订单详情，核对归属' : (msg.reason || '正在打开订单列表'), tabCtx.listTarget);
        await rememberTab(tabId, Object.assign({}, tabCtx, { lastStage: stage, lastProgressAt: Date.now(), candidate: msg.candidate || null }));
        sendResponse({ ok: true, purchaseId: msg.purchaseId });
      } catch (err) { sendResponse({ ok: false, error: String(err) }); }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_collectionPaused') {
    (async () => {
      try {
        const tabCtx = await readTabContext(sender && sender.tab && sender.tab.id);
        const purchaseId = tabCtx && tabCtx.purchaseId;
        const purchase = purchaseId ? await purchaseStore.get(purchaseId) : null;
        if (!purchaseId || tabCtx.collectionFinished || orderCollectionComplete(purchase)
          || collectorSessionStopped(tabCtx, purchase, Date.now())) {
          sendResponse({ ok: false, error: '没有对应的采购' });
          return;
        }
        await purchaseStore.saveCandidates(purchaseId, [], 'paused', msg.reason || '采集已暂停', tabCtx.listTarget);
        await syncQueue.pause('order_identity:' + purchaseId, msg.reason || '采集已暂停');
        await syncQueue.pause('order_detail:' + purchaseId, msg.reason || '采集已暂停');
        await finishCollector(sender && sender.tab && sender.tab.id);
        sendResponse({ ok: true, purchaseId: purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_chooseCandidate') {
    (async () => {
      try {
        const claim = await purchaseStore.claimCandidate(msg.purchaseId, { orderSn: msg.orderSn, detailHref: msg.detailHref || '' });
        if (!claim.ok) {
          const error = claim.reason === 'conflict'
            ? '该订单号已关联到另一笔采购，不能重复绑定；请重新查找本次订单'
            : '当前采购记录已变化或订单号无效，请刷新后重试';
          sendResponse({ ok: false, error: error });
          return;
        }
        await syncQueue.confirm('order_identity:' + msg.purchaseId);
        await purchaseStore.startLookupSession(msg.purchaseId, 'choose_order', ORDER_LOOKUP_WINDOW_MS);
        await syncQueue.schedule({ id: 'order_detail:' + msg.purchaseId, purchaseId: msg.purchaseId, kind: 'order_detail', nextAt: Date.now() });
        sendResponse({ ok: true, purchaseId: msg.purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'm2_retryCollection') {
    (async () => {
      try {
        const purchase = await purchaseStore.get(msg.purchaseId);
        if (!purchase) {
          sendResponse({ ok: false, error: '没有这笔记采购' });
          return;
        }
        const kind = purchase.platformOrderSn ? 'order_detail' : 'order_identity';
        const id = kind + ':' + purchase.purchaseId;
        const stored = await chrome.storage.local.get('tabContextMap');
        const map = stored.tabContextMap || {};
        const staleTabs = [];
        for (const tabId of Object.keys(map)) {
          const ctx = map[tabId];
          if (!ctx || ctx.purchaseId !== purchase.purchaseId || ctx.purpose !== 'collect_orders') continue;
          if (ctx.createdByExtension) staleTabs.push(Number(tabId));
          delete map[tabId];
        }
        await chrome.storage.local.set({ tabContextMap: map });
        for (const tabId of staleTabs) {
          try { await chrome.tabs.remove(tabId); } catch (e) {}
        }
        await purchaseStore.saveCandidates(purchase.purchaseId, [],
          purchase.platformOrderSn ? 'order_linked' : 'awaiting_order_detail', '正在重新查找采购订单', '待分享');
        await purchaseStore.startLookupSession(purchase.purchaseId, 'retry', ORDER_LOOKUP_WINDOW_MS);
        const again = await syncQueue.requeue(id, Date.now());
        if (!again) await syncQueue.schedule({ id: id, purchaseId: purchase.purchaseId, kind: kind, nextAt: Date.now() });
        await autoCollect();
        sendResponse({ ok: true, purchaseId: purchase.purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 采购下单完成：记下拼多多订单号，等待采集运输单号后再回传
  if (msg && msg.type === 'm2_purchaseComplete') {
    (async () => {
      try {
        const tabCtx = await readTabContext(sender && sender.tab && sender.tab.id);
        const purchaseId = (tabCtx && tabCtx.purchaseId) || '';
        if (!purchaseId || (msg.purchaseId && tabCtx.purchaseId !== msg.purchaseId)) {
          sendResponse({ ok: false, error: '无法确定是哪一次采购，已暂停，请在面板里人工确认订单号' });
          return;
        }
        const purchase = await purchaseStore.get(purchaseId);
        if (tabCtx.purpose === 'collect_orders' && (!purchase || purchase.platformOrderSn !== msg.orderSn)) {
          const platform = (tabCtx && tabCtx.platform) || msg.platform || 'PINDUODUO';
          const previousOwners = msg.orderSn ? await purchaseStore.findByPlatformOrder(platform, msg.orderSn) : [];
          if (previousOwners.some(function (row) { return row.purchaseId !== purchaseId; })) {
            const reason = '检测到的是上一笔采购订单，已跳过并继续查找本次订单';
            if (tabCtx.candidate && tabCtx.candidate.cardFingerprint) {
              await purchaseStore.skipCard(purchaseId, tabCtx.candidate.cardFingerprint);
            }
            await purchaseStore.saveCandidates(purchaseId, [], 'incomplete', reason, tabCtx.listTarget);
            const tabId = sender && sender.tab && sender.tab.id;
            const stored = await chrome.storage.local.get('tabContextMap');
            const map = stored.tabContextMap || {};
            delete map[String(tabId)];
            await chrome.storage.local.set({ tabContextMap: map });
            if (tabCtx.createdByExtension && tabId != null && chrome.tabs.remove) {
              try { await chrome.tabs.remove(tabId); } catch (e) {}
            }
            const taskId = 'order_identity:' + purchaseId;
            await syncQueue.schedule({ id: taskId, purchaseId: purchaseId, kind: 'order_identity', nextAt: Date.now() });
            await syncQueue.requeue(taskId, Date.now());
            await autoCollect();
            sendResponse({ ok: true, skipped: true, message: reason });
            return;
          }
          const candidate = { orderSn: msg.orderSn, detailHref: sender && sender.tab && sender.tab.url || (tabCtx.candidate && tabCtx.candidate.detailHref) || '' };
          if (isVerifiedPaidDetail(purchase, tabCtx, msg, sender && sender.tab && sender.tab.url)) {
            const claim = await purchaseStore.claimCandidate(purchaseId, candidate);
            if (!claim.ok) {
              sendResponse({ ok: false, error: '订单归属冲突，未自动记录' });
              return;
            }
          } else {
            if (purchase && !purchase.platformOrderSn && candidate.orderSn) {
              await purchaseStore.saveCandidates(purchaseId, [candidate], 'needs_review', '订单详情与本次支付未能核实，请手动选择对应订单', tabCtx.listTarget);
              await syncQueue.pause('order_detail:' + purchaseId, '订单详情与支付记录不一致');
            }
            await finishCollector(sender && sender.tab && sender.tab.id);
            sendResponse({ ok: false, error: '订单归属尚未核实，请在面板选择对应订单' });
            return;
          }
        }
        const attached = await purchaseStore.attachPlatformOrder({
          purchaseId: purchaseId,
          platform: (tabCtx && tabCtx.platform) || msg.platform || 'PINDUODUO',
          platformOrderSn: msg.orderSn,
        });
        if (!attached.ok) {
          sendResponse({ ok: false, error: '采购订单号没能对上这一单，已标成待人工确认' });
          return;
        }
        const hasPaidAmount = msg.price != null && msg.price !== '' && Number.isFinite(Number(msg.price)) && Number(msg.price) >= 0;
        const latestPurchase = hasPaidAmount ? purchase : await purchaseStore.get(purchaseId);
        if (hasPaidAmount) {
          await purchaseStore.setPaidAmount(purchaseId, { yuan: Number(msg.price), currency: 'CNY', source: 'paid' });
          await purchaseStore.reconcilePayment(purchaseId);
          await syncQueue.confirm('order_detail:' + purchaseId);
        } else if (latestPurchase && latestPurchase.amount && latestPurchase.paymentReceipt
          && Number(latestPurchase.amount.minor) === Number(latestPurchase.paymentReceipt.amountMinor)) {
          await syncQueue.confirm('order_detail:' + purchaseId);
        } else {
          const due = Date.now() + 15000;
          const detailId = 'order_detail:' + purchaseId;
          const task = await syncQueue.retry(detailId, due, '订单详情尚未显示实付金额');
          if (!task) await syncQueue.schedule({ id: detailId, purchaseId: purchaseId, kind: 'order_detail', nextAt: due });
          await scheduleLookupWake(due);
        }
        await syncQueue.confirm('order_identity:' + purchaseId);
        await syncQueue.schedule({
          id: 'logistics:' + purchaseId,
          purchaseId: purchaseId,
          kind: 'logistics',
          nextAt: Date.now() + LOGISTICS_INTERVAL_MS,
        });
        if (hasPaidAmount || (latestPurchase && latestPurchase.amount)) await finishCollector(sender && sender.tab && sender.tab.id);
        sendResponse({ ok: true, purchaseId: purchaseId, message: '已记录订单号，等待发货后再回传物流' });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 价格回传：pdd_order.js 在详情页提取到金额后更新
  if (msg && msg.type === 'm2_updatePrice') {
    (async () => {
      try {
        const tabCtx = await readTabContext(sender && sender.tab && sender.tab.id);
        const purchaseId = tabCtx && tabCtx.purchaseId;
        const price = Number(msg.price);
        const purchase = purchaseId ? await purchaseStore.get(purchaseId) : null;
        if (!purchase || !purchase.platformOrderSn || purchase.platformOrderSn !== msg.orderSn) {
          sendResponse({ ok: false, error: '订单归属尚未确认或与当前采购不一致' });
          return;
        }
        if (!purchaseId || (msg.purchaseId && msg.purchaseId !== purchaseId) || msg.price == null || msg.price === '' || Number.isNaN(price)) {
          sendResponse({ ok: false, error: '没有可保存的实付金额' });
          return;
        }
        await purchaseStore.setPaidAmount(purchaseId, { yuan: price, currency: 'CNY', source: 'paid' });
        await purchaseStore.reconcilePayment(purchaseId);
        await syncQueue.confirm('order_detail:' + purchaseId);
        await finishCollector(sender && sender.tab && sender.tab.id);
        sendResponse({ ok: true, purchaseId: purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 采集到运输单号后，只回传已经对上的那一笔采购
  if (msg && msg.type === 'm2_collectLogistics') {
    (async () => {
      try {
        const tabCtx = await readTabContext(sender && sender.tab && sender.tab.id);
        const purchaseId = (tabCtx && tabCtx.purchaseId) || msg.purchaseId || '';
        let purchase = purchaseId ? await purchaseStore.get(purchaseId) : null;
        if (!purchase && msg.orderSn) {
          const found = await purchaseStore.findByPlatformOrder(msg.platform || (tabCtx && tabCtx.platform) || 'PINDUODUO', msg.orderSn);
          if (found.length === 1) purchase = found[0];
        }
        if (!purchase) {
          sendResponse({ ok: false, error: '无法确定采购归属，已取消回传' });
          return;
        }
        if (purchase.platformOrderSn && msg.orderSn && purchase.platformOrderSn !== msg.orderSn) {
          await purchaseStore.markSync(purchase.purchaseId, { status: 'needs_review', reviewReason: '物流页订单号和采购记录不一致' });
          sendResponse({ ok: false, error: '物流页订单号和采购记录不一致' });
          return;
        }
        const tracking = msg.logisticsNumber || '';
        const orderKey = String(purchase.platformOrderSn || '').replace(/[^A-Za-z0-9]/g, '');
        if (!tracking || tracking.replace(/[^A-Za-z0-9]/g, '') === orderKey) {
          sendResponse({ ok: false, error: '没有可用的快递单号' });
          return;
        }
        const duplicated = (purchase.logistics || []).some((item) => item.number === tracking && item.sync === 'confirmed');
        if (duplicated) {
          sendResponse({ ok: true, skipped: true, message: '该运输单号已回传过，跳过' });
          return;
        }
        const queued = await syncQueue.schedule({
          id: 'submit:' + purchase.purchaseId + ':' + tracking,
          purchaseId: purchase.purchaseId,
          kind: 'logistics',
          trackingNo: tracking,
          nextAt: Date.now(),
        });
        if (queued && queued.skipped) {
          sendResponse({ ok: true, skipped: true, message: '该运输单号已回传过，跳过' });
          return;
        }
        const addBody = M2ZhidaApi.buildAddExpressBody(purchase, tracking);
        const result = await API.addExpress(addBody);
        const classified = M2ZhidaApi.classifyResult(result);
        if (!classified.ok) {
          const errLog = await chrome.storage.local.get('errorLog');
          const errors = errLog.errorLog || [];
          errors.push({ time: formatDateTime(), message: '回传失败：' + classified.message, orderSn: purchase.orderSn });
          await chrome.storage.local.set({ errorLog: errors.slice(-20) });
          await syncQueue.fail(queued.id, classified, Date.now());
          await purchaseStore.markSync(purchase.purchaseId, {
            logisticsSync: 'failed',
            status: classified.kind === 'login' ? 'awaiting_login' : 'retrying',
            reviewReason: classified.message,
          });
          sendResponse({ ok: false, error: classified.message, kind: classified.kind });
          return;
        }
        await syncQueue.confirm(queued.id);
        await purchaseStore.addLogistics(purchase.purchaseId, { number: tracking, sync: 'confirmed' });
        await syncQueue.confirm('logistics:' + purchase.purchaseId);
        sendResponse({ ok: true, result: result, purchaseId: purchase.purchaseId, soOrderSn: purchase.orderSn || '' });
        setTimeout(() => autoCollect(), 2000);
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 查物流：打开第三方订单详情页，采集运输单号
  if (msg && msg.type === 'm2_checkLogistics') {
    (async () => {
      try {
        const so = msg.shopeeOrder || {};
        let platformOrderSn = msg.platformOrderSn ? String(msg.platformOrderSn) : '';
        let effPlatform = msg.platform || 'PINDUODUO';
        let linked = null;
        const owned = await purchaseStore.findByShopee(so);
        const ready = owned.filter((row) => row.platformOrderSn && row.status !== 'needs_review');
        ready.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        if (msg.purchaseId) linked = owned.find((row) => row.purchaseId === msg.purchaseId) || null;
        if (!linked && ready.length) linked = ready[0];
        if (linked) {
          platformOrderSn = linked.platformOrderSn || platformOrderSn;
          effPlatform = linked.platform || effPlatform;
        }

        // 设置全局兜底上下文
        await chrome.storage.local.set({
          purchaseContext: {
            shopeeOrder: so,
            platform: effPlatform,
            productUrl: msg.productUrl || '',
            platformOrderSn: platformOrderSn || '',
          },
        });

        // 只打开这一单。没有采购订单号就不要打开订单列表：列表上看不到订单编号、运单号和价格
        let platform = effPlatform;
        // 兜底：productUrl 重新识别平台
        if (platform === 'PINDUODUO' && msg.productUrl) {
          try {
            const host = new URL(msg.productUrl).hostname || '';
            if (host.includes('taobao') || host.includes('tmall') || host.includes('tb.cn')) platform = 'TAOBAO';
            else if (host.includes('1688')) platform = 'ALIBABA';
          } catch (e) {}
        }
        if (!platformOrderSn) {
          sendResponse({ ok: false, error: '没有记下这个订单的采购订单号，无法打开具体订单。请先在采购页下单并记下订单号后再查物流。' });
          return;
        }
        const url = buildDetailUrl(platform, platformOrderSn);
        const tab = await chrome.tabs.create({ url, active: true });
        // 打开页面时存 tabContextMap，让该 tab 的详情页能精确关联这个 shopee 订单（避免串单）
        if (tab && tab.id) {
          const tabMapStored = await chrome.storage.local.get('tabContextMap');
          const tabMap = tabMapStored.tabContextMap || {};
          tabMap[tab.id] = {
            purchaseId: linked && linked.purchaseId,
            shopeeOrder: so,
            platform: platform,
            platformOrderSn: platformOrderSn,
            productUrl: msg.productUrl || '',
            quantity: (so && so.quantity) || 1,
            selectedSpecs: {},
          };
          await chrome.storage.local.set({ tabContextMap: tabMap });
        }
        sendResponse({ ok: true, url });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 记录第三方订单号（下单成功后，精确记到「当前正在采购的 shopee 订单」）
  if (msg && msg.type === 'm2_recordOrderSn') {
    (async () => {
      try {
        // 只用消息里带的 shopeeOrder（pdd_order.js 按 tab 精确查到的），不用全局 purchaseContext（会串单）
        const so = msg.shopeeOrder || {};
        if (!so.orderSn) {
          sendResponse({ ok: false, error: '缺少 shopeeOrder，取消记录订单号（避免串单）' });
          return;
        }
        const stored = await chrome.storage.local.get('pendingCollect');
        const list = stored.pendingCollect || [];
        const target = list.find((p) =>
          p.shopeeOrder.orderSn === so.orderSn && p.shopeeOrder.itemId === so.itemId && p.shopeeOrder.modelId === so.modelId
        );
        if (target && !target.platformOrderSn) {
          target.platformOrderSn = msg.orderSn;
          target.platform = msg.platform || target.platform;
        }
        await chrome.storage.local.set({ pendingCollect: list });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 订单列表里的订单号不再按出现顺序配给待采购记录
  if (msg && msg.type === 'm2_orderSnList') {
    const refused = purchaseStore.refuseListAssignment(msg.orderSnList || []);
    sendResponse({ ok: true, count: 0, ignored: true, reason: refused.reason });
    return true;
  }

  if (msg && msg.type === 'm2_confirmAssociation') {
    (async () => {
      try {
        const attached = await purchaseStore.attachPlatformOrder({
          purchaseId: msg.purchaseId,
          platform: msg.platform || 'PINDUODUO',
          platformOrderSn: msg.platformOrderSn,
        });
        if (!attached.ok) {
          sendResponse({ ok: false, error: '这个采购订单号对不上，或已经属于另一单' });
          return;
        }
        await purchaseStore.startLookupSession(msg.purchaseId, 'confirm_order', ORDER_LOOKUP_WINDOW_MS);
        await syncQueue.schedule({
          id: 'order_detail:' + msg.purchaseId,
          purchaseId: msg.purchaseId,
          kind: 'order_detail',
          nextAt: Date.now(),
        });
        await syncQueue.schedule({
          id: 'logistics:' + msg.purchaseId,
          purchaseId: msg.purchaseId,
          kind: 'logistics',
          nextAt: Date.now() + LOGISTICS_INTERVAL_MS,
        });
        sendResponse({ ok: true, purchaseId: msg.purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 支付宝页一打开就记下标签。页面被关掉时仍能继续去拼多多找订单号。
  if (msg && msg.type === 'm2_watchPaymentTab') {
    (async () => {
      try {
        const stored = await chrome.storage.local.get('tabContextMap');
        const resolved = M2AlipayResult.resolvePaymentTarget(sender && sender.tab, stored.tabContextMap || {});
        if (!resolved.ok || !sender || !sender.tab) {
          sendResponse({ ok: false });
          return;
        }
        await rememberPaymentTab(sender.tab.id, resolved.purchaseId);
        sendResponse({ ok: true, purchaseId: resolved.purchaseId });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 立即触发后台静默采集
  if (msg && msg.type === 'm2_triggerAutoCollect') {
    (async () => {
      try {
        const count = await autoCollect();
        sendResponse({ ok: true, count });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  return false;
});

async function rememberPaymentTab(tabId, purchaseId) {
  if (tabId == null || !purchaseId) return;
  const stored = await chrome.storage.local.get('m2PaymentTabs');
  const map = stored.m2PaymentTabs || {};
  map[String(tabId)] = purchaseId;
  await chrome.storage.local.set({ m2PaymentTabs: map });
}

async function takePaymentTab(tabId) {
  const stored = await chrome.storage.local.get('m2PaymentTabs');
  const map = stored.m2PaymentTabs || {};
  const purchaseId = map[String(tabId)] || '';
  if (!purchaseId) return '';
  delete map[String(tabId)];
  await chrome.storage.local.set({ m2PaymentTabs: map });
  return purchaseId;
}

async function kickOrderLookup(purchaseId) {
  const purchase = await purchaseStore.get(purchaseId);
  if (!purchase || purchase.platformOrderSn || orderCollectionPaused(purchase)
    || !orderLookupAllowed(purchase, Date.now())) return;
  if (purchase.platform && purchase.platform !== 'PINDUODUO') return;
  const stored = await chrome.storage.local.get('tabContextMap');
  const map = stored.tabContextMap || {};
  let already = false;
  const staleTabs = [];
  for (const id of Object.keys(map)) {
    const ctx = map[id];
    if (!ctx || ctx.purchaseId !== purchaseId || ctx.purpose !== 'collect_orders') continue;
    try {
      const tab = await chrome.tabs.get(Number(id));
      if (tab && !ctx.collectionFinished && !collectorSessionStopped(ctx, purchase, Date.now())
        && Date.now() - (ctx.lastProgressAt || ctx.createdAt || 0) < 45000) {
        already = true;
        continue;
      }
      if (tab && ctx.createdByExtension && chrome.tabs.remove) staleTabs.push(Number(id));
    } catch (e) {}
    delete map[id];
  }
  await chrome.storage.local.set({ tabContextMap: map });
  for (const id of staleTabs) {
    try { await chrome.tabs.remove(id); } catch (e) {}
  }
  if (already) return;
  const taskId = 'order_identity:' + purchaseId;
  await syncQueue.schedule({ id: taskId, purchaseId: purchaseId, kind: 'order_identity', nextAt: Date.now() });
  await syncQueue.requeue(taskId, Date.now());
  await autoCollect();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const ctx = await readTabContext(tabId);
    if (ctx && ctx.purpose === 'collect_orders' && ctx.purchaseId) {
      const stored = await chrome.storage.local.get('tabContextMap');
      const map = stored.tabContextMap || {};
      delete map[String(tabId)];
      await chrome.storage.local.set({ tabContextMap: map });
      const row = await purchaseStore.get(ctx.purchaseId);
      if (row && !ctx.collectionFinished && !row.platformOrderSn && !orderCollectionPaused(row)
        && orderLookupAllowed(row, Date.now())) {
        const due = Date.now() + 15000;
        await syncQueue.retry('order_identity:' + ctx.purchaseId, due, '采集页已关闭');
        await scheduleLookupWake(due);
      }
    }
    const purchaseId = await takePaymentTab(tabId);
    if (purchaseId) {
      const row = await purchaseStore.get(purchaseId);
      const submittedAt = row && row.purchaseIntent && row.purchaseIntent.submittedAt;
      if (row && !row.lookupSession && submittedAt && Date.now() - submittedAt < ORDER_LOOKUP_WINDOW_MS) {
        await purchaseStore.startLookupSession(purchaseId, 'payment_closed', ORDER_LOOKUP_WINDOW_MS);
      }
      await kickOrderLookup(purchaseId);
    }
  })().catch(function () {});
});

async function scheduleLookupWake(due) {
  const existing = chrome.alarms.get ? await chrome.alarms.get('lookupRetry') : null;
  if (!existing || !existing.scheduledTime || existing.scheduledTime > due) {
    chrome.alarms.create('lookupRetry', { when: due });
  }
  const wake = setTimeout(function () { autoCollect(); }, Math.max(0, due - Date.now()));
  if (wake && typeof wake.unref === 'function') wake.unref();
}

async function adoptOrderDetailTab(tab) {
  if (!tab || tab.id == null || tab.openerTabId == null || !tab.url) return;
  let url;
  try { url = new URL(tab.url); } catch (e) { return; }
  if (url.hostname !== 'mobile.yangkeduo.com' || url.pathname !== '/order.html') return;
  const orderSn = url.searchParams.get('order_sn');
  if (!orderSn) return;
  const parent = await readTabContext(tab.openerTabId);
  if (!parent || parent.purpose !== 'collect_orders' || parent.collectionFinished || !parent.purchaseId) return;
  if (parent.candidate && parent.candidate.orderSn && parent.candidate.orderSn !== orderSn) return;
  const row = await purchaseStore.get(parent.purchaseId);
  if (!row || (row.platformOrderSn && row.platformOrderSn !== orderSn)) return;
  await rememberTab(tab.id, Object.assign({}, parent, {
    candidate: Object.assign({}, parent.candidate, { orderSn: orderSn, detailHref: tab.url,
      cardFingerprint: parent.candidate && parent.candidate.cardFingerprint || '' }),
    parentCollectorTabId: tab.openerTabId,
    createdByExtension: false,
    lastStage: 'entering_detail', lastProgressAt: Date.now(),
  }));
  await captureClickedOrderNavigation(tab.id, tab.url);
}
async function captureClickedOrderNavigation(tabId, href) {
  let url;
  try { url = new URL(href); } catch (e) { return; }
  if (url.origin !== 'https://mobile.yangkeduo.com' || url.pathname !== '/order.html') return;
  const orderSn = url.searchParams.get('order_sn') || '';
  if (!/^\d{6}-\d{15}$/.test(orderSn)) return;
  const ctx = await readTabContext(tabId);
  if (!ctx || ctx.purpose !== 'collect_orders' || ctx.listTarget !== '待分享'
    || ctx.lastStage !== 'entering_detail' || !ctx.candidate
    || !ctx.candidate.uniquePaidCard || !ctx.candidate.cardFingerprint
    || !ctx.lastProgressAt || Date.now() - ctx.lastProgressAt > 30000) return;
  if (ctx.candidate.orderSn && ctx.candidate.orderSn !== orderSn) return;
  const row = await purchaseStore.get(ctx.purchaseId);
  const receipt = row && row.paymentReceipt;
  if (!row || row.platformOrderSn || !receipt || receipt.status !== 'succeeded'
    || receipt.amountMinor == null || ctx.candidate.payMinor == null
    || Number(ctx.candidate.payMinor) !== Number(receipt.amountMinor)) return;
  const dates = [receipt.observedAt, row.purchaseIntent && row.purchaseIntent.submittedAt].filter(Boolean)
    .map(function (at) { return new Date(Number(at) + 8 * 60 * 60 * 1000).toISOString().slice(2, 10).replace(/-/g, ''); });
  if (!dates.includes(orderSn.slice(0, 6))) return;
  const owners = await purchaseStore.findByPlatformOrder('PINDUODUO', orderSn);
  if (owners.some(function (owner) { return owner.purchaseId !== ctx.purchaseId; })) return;
  const claim = await purchaseStore.claimCandidate(ctx.purchaseId, { orderSn: orderSn, detailHref: url.href });
  if (!claim.ok) return;
  await purchaseStore.setPaidAmount(ctx.purchaseId, { yuan: Number(receipt.amountMinor) / 100, currency: 'CNY', source: 'paid' });
  await purchaseStore.reconcilePayment(ctx.purchaseId);
  await syncQueue.confirm('order_identity:' + ctx.purchaseId);
  await syncQueue.confirm('order_detail:' + ctx.purchaseId);
  await syncQueue.schedule({ id: 'logistics:' + ctx.purchaseId, purchaseId: ctx.purchaseId,
    kind: 'logistics', nextAt: Date.now() + LOGISTICS_INTERVAL_MS });
  await rememberTab(tabId, Object.assign({}, ctx, { candidate: Object.assign({}, ctx.candidate,
    { orderSn: orderSn, detailHref: url.href }), lastStage: 'order_linked', lastProgressAt: Date.now() }));
  await finishCollector(tabId);
}
chrome.tabs.onCreated.addListener(function (tab) { adoptOrderDetailTab(tab).catch(function () {}); });
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo && changeInfo.url) {
    adoptOrderDetailTab(Object.assign({}, tab, { id: tabId, url: changeInfo.url })).catch(function () {});
    captureClickedOrderNavigation(tabId, changeInfo.url).catch(function () {});
  }
});

// ---------- 定时自动采集运输单号 ----------
chrome.alarms.create('autoCollect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autoCollect' || alarm.name === 'lookupRetry') autoCollect();
});

let autoCollecting = false;
let autoCollectRequested = false;
async function reconcileCollectorTabs(now) {
  const stored = await chrome.storage.local.get(['tabContextMap', 'm2SyncTasks']);
  const map = stored.tabContextMap || {};
  const activeTasks = [];
  const staleTabs = [];
  const deletedIds = [];
  for (const id of Object.keys(map)) {
    const ctx = map[id];
    if (!ctx || ctx.purpose !== 'collect_orders' || !ctx.purchaseId) continue;
    if (ctx.collectionFinished) continue;
    const row = await purchaseStore.get(ctx.purchaseId);
    if (!row || orderCollectionComplete(row) || orderCollectionPaused(row)
      || collectorSessionStopped(ctx, row, now)
      || collectorQueueStopped(ctx, row, stored.m2SyncTasks)) {
      await settleOrderCollection(row, ctx.purchaseId);
      await pauseExpiredLookup(row);
      await finishCollector(Number(id));
      await rememberTab(Number(id), Object.assign({}, ctx, { collectionFinished: true }));
      continue;
    }
    let tab = null;
    try { tab = await chrome.tabs.get(Number(id)); } catch (e) {}
    if (row && tab && now - (ctx.lastProgressAt || ctx.createdAt || 0) < 45000) {
      const kind = row.platformOrderSn ? 'order_detail' : 'order_identity';
      activeTasks.push(kind + ':' + ctx.purchaseId);
      continue;
    }
    deletedIds.push(id);
    if (tab && ctx.createdByExtension && chrome.tabs.remove) staleTabs.push(Number(id));
    if (row && !row.platformOrderSn) {
      const stage = row.collection && row.collection.stage;
      if (stage !== 'awaiting_choice' && stage !== 'needs_review' && stage !== 'paused') {
        const taskId = 'order_identity:' + ctx.purchaseId;
        await syncQueue.schedule({ id: taskId, purchaseId: ctx.purchaseId, kind: 'order_identity', nextAt: now });
        await syncQueue.requeue(taskId, now);
      }
    }
  }
  if (deletedIds.length) {
    const latest = await chrome.storage.local.get('tabContextMap');
    const updated = latest.tabContextMap || {};
    for (const id of deletedIds) delete updated[id];
    await chrome.storage.local.set({ tabContextMap: updated });
  }
  for (const id of staleTabs) {
    try { await chrome.tabs.remove(id); } catch (e) {}
  }
  return activeTasks;
}
async function autoCollect() {
  if (autoCollecting) { autoCollectRequested = true; return 0; }
  autoCollecting = true;
  try {
    const now = Date.now();
    const logisticsSettings = await chrome.storage.local.get('m2LogisticsIntervalVersion');
    if (logisticsSettings.m2LogisticsIntervalVersion !== 3) {
      await syncQueue.shortenLogistics(now + LOGISTICS_INTERVAL_MS);
      await chrome.storage.local.set({ m2LogisticsIntervalVersion: 3 });
    }
    const activeTasks = await reconcileCollectorTabs(now);
    await syncQueue.releaseExpired(now);
    const rows = await purchaseStore.list();
    for (const row of rows) {
      if (row.platform && row.platform !== 'PINDUODUO') continue;
      const stage = row.collection && row.collection.stage;
      // 物流闹钟可以查询物流，但不能授权历史记录重新抢占前台。
      if (row.platformOrderSn && row.logisticsSync !== 'confirmed' && row.status !== 'needs_review' && row.status !== 'awaiting_login') {
        await syncQueue.schedule({ id: 'logistics:' + row.purchaseId, purchaseId: row.purchaseId, kind: 'logistics', nextAt: now + LOGISTICS_INTERVAL_MS });
      }
      if (!orderCollectionComplete(row) && !orderLookupAllowed(row, now)) {
        await pauseExpiredLookup(row);
        continue;
      }
      if (stage === 'awaiting_choice' && row.collection.reason === '订单详情已打开，请核对后点选对应订单'
          && !row.platformOrderSn && row.paymentReceipt
          && row.paymentReceipt.status === 'succeeded' && row.candidates && row.candidates.length === 1) {
        const candidate = row.candidates[0];
        let validDetail = false;
        try {
          const detail = new URL(candidate.detailHref);
          validDetail = detail.origin === 'https://mobile.yangkeduo.com'
            && detail.pathname === '/order.html' && detail.searchParams.get('order_sn') === candidate.orderSn;
        } catch (e) {}
        if (validDetail) {
          await purchaseStore.saveCandidates(row.purchaseId, row.candidates, 'rechecking_candidate', '正在重新核对订单详情');
          await syncQueue.confirm('order_identity:' + row.purchaseId);
          const taskId = 'order_detail:' + row.purchaseId;
          await syncQueue.schedule({ id: taskId, purchaseId: row.purchaseId, kind: 'order_detail', nextAt: now });
          await syncQueue.requeue(taskId, now);
        }
        continue;
      }
      await settleOrderCollection(row, row.purchaseId);
      if (orderCollectionPaused(row)) continue;
      if (!row.platformOrderSn && (row.paymentReceipt || stage === 'submitted' || stage === 'awaiting_order_detail' || stage === 'incomplete' || stage === 'not_found' || stage === 'share_pending')) {
        await syncQueue.schedule({ id: 'order_identity:' + row.purchaseId, purchaseId: row.purchaseId, kind: 'order_identity', nextAt: now });
        continue;
      }
      if (row.platformOrderSn && !orderCollectionComplete(row)) {
        await syncQueue.schedule({ id: 'order_detail:' + row.purchaseId, purchaseId: row.purchaseId, kind: 'order_detail', nextAt: now });
      }
    }
    if (activeTasks.length) await syncQueue.claim(activeTasks, now, 2 * 60 * 1000);
    const dueTasks = await syncQueue.pick(now, 100);
    const picked = [];
    let orderCollectorBusy = activeTasks.length > 0;
    for (const task of dueTasks) {
      if (task.kind !== 'logistics') {
        const row = await purchaseStore.get(task.purchaseId);
        if (!row || orderCollectionComplete(row) || (task.kind === 'order_identity' && row.platformOrderSn)) {
          await syncQueue.confirm(task.id);
          continue;
        }
        if (orderCollectionPaused(row)) {
          await syncQueue.pause(task.id, row.collection && row.collection.reason || '等待重试');
          continue;
        }
        if (!orderLookupAllowed(row, now)) {
          await pauseExpiredLookup(row);
          continue;
        }
      }
      if (task.kind !== 'logistics' && orderCollectorBusy) continue;
      picked.push(task);
      if (task.kind !== 'logistics') orderCollectorBusy = true;
      if (picked.length >= 2) break;
    }
    if (picked.length) await syncQueue.claim(picked.map((task) => task.id), now, 2 * 60 * 1000);
    for (const task of picked) {
      const row = await purchaseStore.get(task.purchaseId);
      if (!row || (task.kind === 'order_identity' && row.platformOrderSn)) {
        await syncQueue.confirm(task.id);
        continue;
      }
      if (task.kind === 'logistics' && String(task.id).startsWith('logistics:') && row.logisticsSync === 'confirmed') {
        await syncQueue.confirm(task.id);
        continue;
      }
      const rowStage = row.collection && row.collection.stage;
      if (task.kind === 'order_identity' && (rowStage === 'awaiting_choice' || rowStage === 'needs_review' || rowStage === 'paused')) {
        await syncQueue.pause(task.id, row.collection.reason || '等待人工核对');
        continue;
      }
      let url = '';
      let purpose = '';
      if (task.kind === 'logistics') {
        if (!row.platformOrderSn) continue;
        url = buildDetailUrl(row.platform || 'PINDUODUO', row.platformOrderSn);
      } else if (task.kind === 'order_detail' && (row.detailHref || (row.collection && row.collection.stage === 'rechecking_candidate' && row.candidates && row.candidates[0] && row.candidates[0].detailHref))) {
        url = row.detailHref || row.candidates[0].detailHref;
        purpose = 'collect_orders';
      } else if (task.kind === 'order_identity' || task.kind === 'order_detail') {
        const listTarget = (row.collection && row.collection.listTarget) || '待分享';
        url = listTarget === '待发货'
          ? 'https://mobile.yangkeduo.com/orders.html'
          : 'https://mobile.yangkeduo.com/orders.html?type=5';
        purpose = 'collect_orders';
      }
      if (!url) {
        await syncQueue.retry(task.id, now + 15000, '缺少查询地址');
        continue;
      }
      const foreground = purpose === 'collect_orders';
      const previousTabs = foreground ? await chrome.tabs.query({ active: true, lastFocusedWindow: true }) : [];
      const previousTab = previousTabs[0];
      const createOptions = { url: foreground ? 'about:blank' : url, active: false };
      if (previousTab && previousTab.windowId != null) createOptions.windowId = previousTab.windowId;
      const tab = await chrome.tabs.create(createOptions);
      if (tab && tab.id) {
        const claimedOrderSns = rows.filter(function (item) {
          return item.platform === 'PINDUODUO' && item.platformOrderSn;
        }).map(function (item) { return item.platformOrderSn; });
        await rememberTab(tab.id, {
          purchaseId: row.purchaseId,
          taskId: task.id,
          lookupSessionId: row.lookupSession && row.lookupSession.id,
          purpose: purpose,
          shopeeOrder: {
            orderSn: row.orderSn,
            itemId: row.itemId,
            modelId: row.modelId,
            zhidaOrderId: row.zhidaOrderId,
            zhidaItemId: row.zhidaItemId,
            quantity: row.quantity,
          },
          platform: row.platform || 'PINDUODUO',
          platformOrderSn: row.platformOrderSn || '',
          candidate: row.collection && row.collection.stage === 'rechecking_candidate' ? row.candidates[0] : null,
          paymentMinor: row.paymentReceipt && row.paymentReceipt.amountMinor,
          productUrl: row.productUrl || '',
          quantity: row.quantity || 1,
          listTarget: (row.collection && row.collection.listTarget) || '待分享',
          claimedOrderSns: claimedOrderSns,
          skippedCardFingerprints: row.skippedCardFingerprints || [],
          createdByExtension: true,
          foregroundManaged: foreground,
          returnTabId: previousTab ? previousTab.id : null,
          createdAt: now,
          lastStage: task.kind === 'order_identity' ? 'opening_list' : 'entering_detail',
          lastProgressAt: now,
          progress: { screens: 0, details: task.kind === 'order_detail' ? 1 : 0, rounds: (row.collection && row.collection.rounds) || 0 },
        });
        if (foreground) await chrome.tabs.update(tab.id, { url: url, active: true });
      }
    }
    if (picked.length) {
      const logisticsIds = picked.filter((task) => task.kind === 'logistics').map((task) => task.id);
      const orderIds = picked.filter((task) => task.kind !== 'logistics').map((task) => task.id);
      if (logisticsIds.length) await syncQueue.defer(logisticsIds, now + LOGISTICS_INTERVAL_MS);
      if (orderIds.length) await syncQueue.defer(orderIds, now + 15 * 1000);
    }
    return picked.length;
  } catch (e) {
    return 0;
  } finally {
    autoCollecting = false;
    if (autoCollectRequested) {
      autoCollectRequested = false;
      setTimeout(function () { autoCollect(); }, 0);
    }
  }
}
