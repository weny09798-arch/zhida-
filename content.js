// ============================================================
// 至达国际 采购助手 —— content.js（zhida.shopeeok.com 侧）
//
// 状态：✅ 可用（订单面板/筛选/分页/绑定/下单入口 均已可用）
//
// 职责：在至达国际网页注入自建浮动面板
//   - 拉取订单列表（/order/list/v2，后端分页 + dgStatus/店铺/关键词筛选）
//   - 货源绑定（bindingMap，按商品 itemId_modelId 共享，绑一次永久记）
//   - 「下单」入口 → 调 background 启动拼多多采购
//   - 显示订单号 / 运输单号 / 撤销 / 解绑 / 查物流
// ============================================================

(function () {
  if (window.__m2ContentLoaded) return;
  window.__m2ContentLoaded = true;

  // ---------- 全局状态 ----------
  let currentPage = 1;
  let currentPageSize = 10;
  let totalElements = 0;
  let currentOrders = [];    // 当前页订单（后端分页返回）
  let allFetchedOrders = []; // 全量拉取的订单（前端分页用）

  // 缓存 storage 数据，避免每次渲染都读 disk（改由 onChanged 自动更新）
  let cachedBindingMap = null;
  let cachedOrderStatusMap = null;
  let cachedSyncedList = null;
  let cachedPcList = null;
  let cachedPurchases = null;
  let cachedExclusions = null;
  const collapsedPurchaseLines = new Set();
  async function loadStorageCache() {
    const r = await new Promise((resolve) =>
      chrome.storage.local.get(['bindingMap', 'orderStatusMap', 'syncedLogistics', 'pendingCollect', 'm2Purchases', 'm2BindingExclusions'], resolve)
    );
    cachedBindingMap = r.bindingMap || {};
    cachedOrderStatusMap = r.orderStatusMap || {};
    cachedSyncedList = r.syncedLogistics || [];
    cachedPcList = r.pendingCollect || [];
    cachedPurchases = r.m2Purchases || [];
    cachedExclusions = r.m2BindingExclusions || {};
  }

  // ---------- 发送通用请求（直接在当前页面 fetch + 自动带 token） ----------
  const BASE = 'https://zhida.shopeeok.com/agent-foreign';

  // 获取 token：优先从 hook 截获的最新 token（token_hook.js 在 MAIN world 写入），其次 Pro_Access-Token
  function getAccessToken() {
    try {
      const t = localStorage.getItem('__zhida_latest_token');
      if (t) return t;
    } catch (e) {}
    try {
      const raw = localStorage.getItem('Pro_Access-Token');
      if (raw) { const obj = JSON.parse(raw); return (obj && obj.value) || null; }
    } catch (e) {}
    return null;
  }

  async function request(path, method, body) {
    try {
      const headers = { accept: 'application/json, text/plain, */*' };
      if (body !== undefined && body !== null) {
        headers['content-type'] = 'application/json;charset=UTF-8';
      }
      const token = getAccessToken();
      if (token) headers['x-access-token'] = token;
      const res = await fetch(BASE + path, {
        method: method || 'GET',
        headers,
        credentials: 'include',
        body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = text; }
      return { ok: true, httpStatus: res.status, body: parsed };
    } catch (e) {
      return { ok: false, __error: e && e.message ? e.message : String(e) };
    }
  }

  // ---------- 样式 ----------
  function injectStyle() {
    const css = `
      #m2-panel-root { position: fixed; right: 16px; bottom: 80px; width: 560px; max-height: 85vh;
        background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.2);
        z-index: 2147483000; display: none; overflow: hidden; font-family: -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; font-size: 13px; color: #111827; }
      #m2-panel-root .m2-header { background: #1f2937; color: #fff; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; cursor: move; user-select: none; }
      #m2-panel-root .m2-header b { font-size: 14px; }
      #m2-panel-root .m2-close { cursor: pointer; color: #9ca3af; font-size: 16px; }
      #m2-panel-root .m2-filter { padding: 8px 14px; border-bottom: 1px solid #e5e7eb; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      #m2-panel-root .m2-filter select { flex: 1; min-width: 100px; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; }
      #m2-panel-root .m2-filter input { flex: 2; min-width: 160px; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; }
      #m2-panel-root .m2-body { max-height: calc(85vh - 150px); overflow-y: auto; padding: 10px; }
      #m2-panel-root .m2-order { border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
      #m2-panel-root .m2-order-head { font-weight: 600; margin-bottom: 6px; }
      #m2-panel-root .m2-order-status { font-size: 11px; color: #6b7280; font-weight: 400; margin-left: 6px; }
      #m2-panel-root .m2-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px dashed #f0f0f0; }
      #m2-panel-root .m2-item img { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
      #m2-panel-root .m2-item-info { flex: 1; min-width: 0; }
      #m2-panel-root .m2-item-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #m2-panel-root .m2-item-model { color: #6b7280; font-size: 11px; }
      #m2-panel-root .m2-buy { background: linear-gradient(135deg,#ff6b00,#ff4400); color: #fff; border: none;
        border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; white-space: nowrap; }
      #m2-panel-root .m2-bind { background: #fff; color: #ff6b00; border: 1px solid #ff6b00; border-radius: 6px;
        padding: 5px 10px; cursor: pointer; font-size: 12px; white-space: nowrap; margin-right: 4px; }
      #m2-panel-root .m2-binding { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 4px 0 4px 48px; font-size: 11px; }
      #m2-panel-root .m2-binding-url { flex: 1; min-width: 0; color: #2563eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #m2-panel-root .m2-binding-ordered { color: #16a34a; font-weight: 600; white-space: nowrap; }
      #m2-panel-root .m2-record-toggle { display: inline-flex; align-items: center; gap: 4px; margin: 6px 0 0 48px; background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
      #m2-panel-root .m2-purchase-stack.is-collapsed .m2-purchase-record { display: none; }
      #m2-panel-root .m2-purchase-record { display: grid; gap: 6px; min-width: 0; margin: 6px 0 8px 48px; padding: 8px; background: #f8fafc; border-radius: 8px; }
      #m2-panel-root .m2-record-field { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; align-items: start; }
      #m2-panel-root .m2-record-label { color: #6b7280; }
      #m2-panel-root .m2-record-value { min-width: 0; white-space: normal; overflow-wrap: anywhere; user-select: text; color: #111827; }
      #m2-panel-root .m2-record-actions { display: flex; flex-wrap: wrap; gap: 6px; }
      #m2-panel-root .m2-record-note { color: #b45309; overflow-wrap: anywhere; }
      #m2-panel-root .m2-undo { background: #fff; color: #6b7280; border: 1px solid #d1d5db; border-radius: 4px;
        padding: 2px 6px; cursor: pointer; font-size: 11px; white-space: nowrap; }
      #m2-panel-root .m2-empty { color: #9ca3af; text-align: center; padding: 20px 0; }
      #m2-panel-root .m2-footer { padding: 8px 14px; border-top: 1px solid #e5e7eb; display: flex; align-items: center; gap: 8px; }
      #m2-panel-root .m2-footer button { padding: 4px 10px; border: 1px solid #d1d5db; background: #fff; border-radius: 6px; cursor: pointer; font-size: 12px; }
      #m2-panel-root .m2-footer button:disabled { opacity: .4; cursor: not-allowed; }
      #m2-panel-root .m2-page-info { flex: 1; text-align: center; font-size: 12px; color: #6b7280; }
      #m2-panel-root .m2-footer select { padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; }
      #m2-fab { position: fixed; right: 16px; bottom: 24px; background: linear-gradient(135deg,#ff6b00,#ff4400); color: #fff;
        border: none; border-radius: 24px; padding: 12px 18px; cursor: pointer; font-size: 14px; font-weight: 600;
        box-shadow: 0 4px 12px rgba(255,68,0,.4); z-index: 2147483000; }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ---------- 拖拽 ----------
  function makeDraggable(root, handle) {
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.m2-close')) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = root.getBoundingClientRect();
      origLeft = rect.left; origTop = rect.top;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      root.style.left = origLeft + 'px';
      root.style.top = origTop + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      root.style.left = (origLeft + e.clientX - startX) + 'px';
      root.style.top = (origTop + e.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ---------- 调整大小 ----------
  function makeResizable(root, body) {
    const handle = document.createElement('div');
    handle.style.cssText = 'position:absolute; right:0; bottom:0; width:18px; height:18px; cursor:nwse-resize; z-index:10;';
    root.style.position = 'fixed';
    root.appendChild(handle);

    let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
    handle.addEventListener('mousedown', (e) => {
      resizing = true;
      sx = e.clientX; sy = e.clientY;
      sw = root.offsetWidth; sh = root.offsetHeight;
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const w = Math.max(420, sw + e.clientX - sx);
      const h = Math.max(320, sh + e.clientY - sy);
      root.style.width = w + 'px';
      root.style.height = h + 'px';
      root.style.maxHeight = 'none';
      body.style.maxHeight = (h - 150) + 'px';
    });
    document.addEventListener('mouseup', () => { resizing = false; });
  }

  // ---------- 构建面板 ----------
  function buildPanel() {
    const fab = document.createElement('button');
    fab.id = 'm2-fab';
    fab.textContent = '🛒 M2 采购';
    document.body.appendChild(fab);

    const root = document.createElement('div');
    root.id = 'm2-panel-root';
    root.innerHTML =
      '<div class="m2-header"><b>订单列表</b><span class="m2-close">✕</span></div>' +
      '<div id="m2-error-bar" style="display:none;background:#fef2f2;color:#dc2626;padding:8px 14px;font-size:12px;border-bottom:1px solid #fecaca;cursor:pointer;" title="点击关闭"></div>' +
      '<div class="m2-filter">' +
      '<input id="m2-search" placeholder="搜索订单号/商品名，回车搜索">' +
      '<select id="m2-status-filter">' +
      '<option value="all" selected>全部</option>' +
      '<option value="21">已取消</option>' +
      '<option value="2">待出货</option>' +
      '</select>' +
      '<select id="m2-shop-filter">' +
      '<option value="" selected>全部店铺</option>' +
      '</select>' +
      '<button id="m2-batch-check" style="padding:6px 10px;border:1px solid #ff6b00;background:#fff;color:#ff6b00;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">批量查物流</button>' +
      '<button id="m2-clear-data" style="padding:6px 10px;border:1px solid #dc2626;background:#fff;color:#dc2626;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">清空数据</button>' +
      '</div>' +
      '<div class="m2-body"><div class="m2-empty">加载中…</div></div>' +
      '<div class="m2-footer">' +
      '<button id="m2-prev">上一页</button>' +
      '<span class="m2-page-info" id="m2-page-info"></span>' +
      '<button id="m2-next">下一页</button>' +
      '<select id="m2-page-size"><option value="10" selected>10/页</option><option value="20">20/页</option><option value="50">50/页</option></select>' +
      '</div>';
    document.body.appendChild(root);

    // 错误提示条：点击关闭
    const errorBar = root.querySelector('#m2-error-bar');
    errorBar.addEventListener('click', () => { errorBar.style.display = 'none'; });

    makeDraggable(root, root.querySelector('.m2-header'));
    makeResizable(root, root.querySelector('.m2-body'));

    fab.addEventListener('click', () => {
      const showing = root.style.display === 'block';
      root.style.display = showing ? 'none' : 'block';
      if (!showing) loadOrders();
    });
    root.querySelector('.m2-close').addEventListener('click', () => { root.style.display = 'none'; });
    root.querySelector('#m2-status-filter').addEventListener('change', () => { currentPage = 1; loadOrders(); });
    root.querySelector('#m2-shop-filter').addEventListener('change', () => { currentPage = 1; loadOrders(); });
    root.querySelector('#m2-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { currentPage = 1; loadOrders(); } });
    root.querySelector('#m2-batch-check').addEventListener('click', onBatchCheckLogistics);
    root.querySelector('#m2-clear-data').addEventListener('click', onClearData);
    root.querySelector('#m2-page-size').addEventListener('change', (e) => { currentPageSize = parseInt(e.target.value, 10) || 10; currentPage = 1; loadOrders(); });
    root.querySelector('#m2-prev').addEventListener('click', () => { if (currentPage > 1) { currentPage--; loadOrders(); } });
    root.querySelector('#m2-next').addEventListener('click', () => { currentPage++; loadOrders(); });
  }

  // ---------- 取图片 ----------
  function getImageUrl(item) {
    if (item.extImageUrl) {
      try {
        const arr = JSON.parse(item.extImageUrl);
        if (Array.isArray(arr) && arr.length) return arr[0];
      } catch (e) {}
    }
    return item.imageUrl || '';
  }

  // ---------- 状态颜色与文本（zhida 订单状态 orderStatus） ----------
  function statusLabel(status) {
    const map = {
      READY_TO_SHIP: '待出货', PROCESSED: '待出货-已申请', SHIPPED: '运送中',
      COMPLETED: '已完成', CANCELLED: '已取消', IN_CANCEL: '取消中',
      TO_CONFIRM_RECEIVE: '已送达', TO_RETURN: '已退货', UNPAID: '未付款',
    };
    return map[status] || status || '';
  }
  function statusColor(status) {
    const colors = {
      READY_TO_SHIP: '#2563eb', PROCESSED: '#8b5cf6', SHIPPED: '#0891b2',
      COMPLETED: '#16a34a', CANCELLED: '#dc2626', IN_CANCEL: '#f59e0b',
      TO_CONFIRM_RECEIVE: '#16a34a', TO_RETURN: '#dc2626', UNPAID: '#9ca3af',
    };
    return colors[status] || '#6b7280';
  }

  // ---------- 平台识别 ----------
  function detectPlatformFromUrl(url) {
    try {
      const host = new URL(url).hostname || '';
      if (host.includes('pinduoduo') || host.includes('yangkeduo') || host.includes('pdd.com')) return 'PINDUODUO';
      if (host.includes('1688')) return 'ALIBABA';
      if (host.includes('taobao') || host.includes('tmall') || host.includes('tb.cn')) return 'TAOBAO';
    } catch (e) {}
    return 'PINDUODUO';
  }

  // ---------- 绑定映射缓存（按商品共享，绑一次永久记） ----------
  function bindingKey(item) {
    return String(item.itemId);    // 按商品级别，同一产品不同规格共享绑定
  }
  // 下单状态按订单区分
  function orderKey(order, item) {
    return order.orderSn + '_' + item.itemId + '_' + item.modelId;
  }
  function getBindingMap() {
    return new Promise((resolve) => {
      chrome.storage.local.get('bindingMap', (r) => {
        const map = r.bindingMap || {};
        // 迁移旧 key（itemId_modelId → itemId）
        let migrated = false;
        for (const key of Object.keys(map)) {
          if (key.includes('_')) {
            const newKey = key.split('_')[0];
            if (newKey !== key) {
              const existing = map[newKey] || [];
              const old = Array.isArray(map[key]) ? map[key] : [map[key]];
              // 去重合并
              const oldIds = new Set(old.map((b) => b.id));
              const merged = [...existing, ...old.filter((b) => !oldIds.has(b.id) || existing.every((e) => e.id !== b.id))];
              // 修复：filter 逻辑改为只保留 existing 中没有的
              const filtered = old.filter((b) => {
                for (const e of existing) { if (e.id === b.id) return false; }
                return true;
              });
              map[newKey] = [...existing, ...filtered];
              delete map[key];
              migrated = true;
            }
          }
        }
        resolve(map);
      });
    });
  }
  function lineIdentity(order, item) {
    const same = (order.orderItemList || []).filter((other) =>
      String(other.itemId) === String(item.itemId) &&
      String(other.modelId == null ? '' : other.modelId) === String(item.modelId == null ? '' : item.modelId)
    );
    return {
      zhidaOrderId: order.zhidaOrderId || '',
      zhidaItemId: item.zhidaItemId || '',
      orderSn: order.orderSn || '',
      itemId: item.itemId,
      modelId: item.modelId == null ? '' : item.modelId,
      ambiguous: same.length > 1 && !(order.zhidaOrderId && item.zhidaItemId),
    };
  }
  function sendRuntime(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp || { ok: false, error: '没有收到后台响应' });
      });
    });
  }
  function addBinding(order, item, data) {
    return sendRuntime({
      type: 'm2_bindShared',
      identity: lineIdentity(order, item),
      binding: data,
    });
  }
  function removeBinding(order, item, bindingId) {
    return sendRuntime({
      type: 'm2_unbindCurrent',
      identity: lineIdentity(order, item),
      bindingId: bindingId,
    });
  }
  function getOrderStatusMap() {
    return new Promise((resolve) => {
      chrome.storage.local.get('orderStatusMap', (r) => resolve(r.orderStatusMap || {}));
    });
  }
  function setOrderStatus(order, item, bindingId, status) {
    return new Promise((resolve) => {
      chrome.storage.local.get('orderStatusMap', (r) => {
        const map = r.orderStatusMap || {};
        const key = orderKey(order, item);
        if (status) {
          map[key] = { bindingId, status };
        } else {
          delete map[key];
        }
        chrome.storage.local.set({ orderStatusMap: map }, resolve);
      });
    });
  }

  // ---------- 拉取订单（zhida 后端分页） ----------
  function normalizeOrder(zhidaOrder) {
    return {
      orderSn: zhidaOrder.ordersn,
      zhidaOrderId: zhidaOrder.id,                 // 至达内部订单 DB ID（回传物流用）
      orderStatus: zhidaOrder.orderStatus,        // 订单状态（显示用）
      dgStatus: zhidaOrder.dgStatus,              // 系统状态（筛选用）
      shopName: zhidaOrder.shopName || '',
      shopId: zhidaOrder.shopId || '',
      orderItemList: (zhidaOrder.items || []).map((item) => ({
        itemId: item.itemId,
        modelId: item.variationId,
        zhidaItemId: item.id,                      // 至达内部商品行 DB ID（回传物流用）
        itemName: item.itemName || '',
        modelName: item.variationName || '',
        modelQuantityPurchased: parseInt(item.variationQuantityPurchased) || 1,
        imageUrl: item.image || '',
        extImageUrl: null,
        logisticsNumber: item.trackingNo || null,
      })),
    };
  }

  async function loadOrders() {
    // 即刻同步 token 到 storage（供 background 调用 addExpress 使用）
    const t = getAccessToken();
    if (t) { try { chrome.storage.local.set({ __zhidaToken: t }); } catch (e) {} }

    const bodyEl = document.querySelector('#m2-panel-root .m2-body');
    bodyEl.innerHTML = '<div class="m2-empty">加载中…</div>';

    try {
      // 首次打开并行加载：API 请求 + storage 缓存
      const statusFilter = document.getElementById('m2-status-filter').value;
      const shopFilter = document.getElementById('m2-shop-filter').value;

      const reqBody = {
        queryType: '1', orderBy: '0', column: 'createTime', order: 'desc',
        pageNo: 1, pageSize: 500,
      };
      if (statusFilter !== '') reqBody.dgStatus = statusFilter;
      if (shopFilter) reqBody.shopName = shopFilter;

      const [res] = await Promise.all([
        request('/order/list/v2', 'POST', reqBody),
        sendRuntime({ type: 'm2_purgeUnbound' }).then(function () { return loadStorageCache(); }),
      ]);

      if (!res || res.__error) { bodyEl.innerHTML = '<div class="m2-empty">请求失败' + (res && res.__error) + '</div>'; return; }
      if (!res.body) { bodyEl.innerHTML = '<div class="m2-empty">请求无返回（可能未登录）</div>'; return; }
      if (!res.body.success) {
        bodyEl.innerHTML = '<div class="m2-empty">接口错误：' + (res.body.message || res.body.code || '') + '</div>';
        return;
      }

      const data = res.body.result;
      allFetchedOrders = (data && data.records || []).map(normalizeOrder);
      totalElements = allFetchedOrders.length;

      // 无店铺筛选时顺便收集店铺名
      if (!shopFilter) collectShops(allFetchedOrders);

      renderOrders();
    } catch (e) {
      bodyEl.innerHTML = '<div class="m2-empty">异常：' + (e && e.message ? e.message : e) + '</div>';
    }
  }

  // ---------- 渲染（前端分页：从 allFetchedOrders 切片） ----------
  async function renderOrders() {
    const body = document.querySelector('#m2-panel-root .m2-body');

    // 分页信息
    const pageCount = Math.max(1, Math.ceil(totalElements / currentPageSize));
    if (currentPage > pageCount) currentPage = pageCount;
    document.getElementById('m2-page-info').textContent = currentPage + ' / ' + pageCount + '（共 ' + totalElements + ' 个订单）';
    document.getElementById('m2-prev').disabled = currentPage <= 1;
    document.getElementById('m2-next').disabled = currentPage >= pageCount;

    // 前端切片
    const pageOrders = allFetchedOrders.slice((currentPage - 1) * currentPageSize, currentPage * currentPageSize);

    if (!pageOrders.length) {
      body.innerHTML = '<div class="m2-empty">本页没有符合条件的订单</div>';
      return;
    }
    const bindingMap = cachedBindingMap || {};
    const orderStatusMap = cachedOrderStatusMap || {};
    const syncedMap = {};
    (cachedSyncedList || []).forEach((s) => { syncedMap[s.orderSn + '_' + s.itemId + '_' + s.modelId] = s; });
    const orderSnMap = {};
    const priceMap = {};
    (cachedPcList || []).forEach((p) => {
      const pso = p.shopeeOrder || {};
      const key = pso.orderSn + '_' + pso.itemId + '_' + pso.modelId;
      if (p.platformOrderSn) orderSnMap[key] = p.platformOrderSn;
      if (p.price) priceMap[key] = p.price;
    });

    body.innerHTML = '';
    pageOrders.forEach((order) => {
      const box = document.createElement('div');
      box.className = 'm2-order';
      const head = document.createElement('div');
      head.className = 'm2-order-head';
      head.textContent = order.orderSn + ' · ' + order.shopName;
      const status = document.createElement('span');
      status.className = 'm2-order-status';
      status.textContent = statusLabel(order.orderStatus);
      status.style.color = statusColor(order.orderStatus);
      status.style.fontWeight = '600';
      head.appendChild(status);
      box.appendChild(head);

      (order.orderItemList || []).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'm2-item';

      const img = document.createElement('img');
      img.src = getImageUrl(item);
      img.onerror = function () {
        const fallback = item.imageUrl || '';
        if (img.getAttribute('src') !== fallback && fallback) img.src = fallback;
      };
      row.appendChild(img);

      const info = document.createElement('div');
      info.className = 'm2-item-info';
      const name = document.createElement('div');
      name.className = 'm2-item-name';
      name.textContent = item.itemName || '';
      const model = document.createElement('div');
      model.className = 'm2-item-model';
      model.textContent = '规格：' + (item.modelName || '') + ' × ' + (item.modelQuantityPurchased || 1);
      info.appendChild(name);
      info.appendChild(model);
      if (item.logisticsNumber) {
        const logistics = document.createElement('div');
        logistics.className = 'm2-item-model';
        logistics.style.color = '#16a34a';
        logistics.style.fontWeight = '600';
        logistics.textContent = '🚚 物流单号：' + item.logisticsNumber;
        info.appendChild(logistics);
      }
      row.appendChild(info);

      const bindBtn = document.createElement('button');
      bindBtn.className = 'm2-bind';
      bindBtn.textContent = '绑定';
      bindBtn.addEventListener('click', () => onBindClick(order, item, bindBtn));
      row.appendChild(bindBtn);

      box.appendChild(row);

      const identity = lineIdentity(order, item);
      const bindings = typeof M2BindingStore !== 'undefined'
        ? M2BindingStore.getEffectiveBindings(bindingMap, cachedExclusions || {}, identity)
        : (Array.isArray(bindingMap[bindingKey(item)]) ? bindingMap[bindingKey(item)] : (bindingMap[bindingKey(item)] ? [bindingMap[bindingKey(item)]] : []));
      bindings.forEach((binding) => {
        const bRow = document.createElement('div');
        bRow.className = 'm2-binding';

        const url = document.createElement('span');
        url.className = 'm2-binding-url';
        url.textContent = binding.productUrl;
        url.title = binding.productUrl;
        bRow.appendChild(url);

        const unbindBtn = document.createElement('button');
        unbindBtn.className = 'm2-undo';
        unbindBtn.style.color = '#dc2626';
        unbindBtn.textContent = '解绑当前项';
        unbindBtn.addEventListener('click', async () => {
          if (!confirm('仅解除当前订单这一项的货源关联，其他相同商品保持绑定。当前项的采购订单、金额和物流会一并清除')) return;
          unbindBtn.disabled = true;
          const resp = await removeBinding(order, item, binding.id);
          unbindBtn.disabled = false;
          if (!resp || !resp.ok) {
            alert('解绑失败：' + ((resp && resp.error) || '未知错误'));
            return;
          }
          renderOrders();
        });
        bRow.appendChild(unbindBtn);

        const buyBtn = document.createElement('button');
        buyBtn.className = 'm2-buy';
        buyBtn.textContent = '下单';
        buyBtn.addEventListener('click', () => onBuyClick(order, item, binding));
        bRow.appendChild(buyBtn);
        box.appendChild(bRow);
      });

      if (bindings.length) {
        renderPurchaseRecords(box, order, item, bindings, {
          orderStatusMap: orderStatusMap,
          syncedMap: syncedMap,
          orderSnMap: orderSnMap,
          priceMap: priceMap,
        });
      }
      });

      body.appendChild(box);
    });
  }

  // ---------- 绑定货源 ----------
  function purchasesForLine(order, item) {
    const all = cachedPurchases || [];
    const strict = (order.zhidaOrderId && item.zhidaItemId)
      ? all.filter((row) => String(row.zhidaOrderId || '') === String(order.zhidaOrderId) && String(row.zhidaItemId || '') === String(item.zhidaItemId))
      : [];
    if (strict.length) return { rows: strict.slice().sort(byCreated), ambiguous: false };
    const legacy = all.filter((row) => !(row.zhidaOrderId && row.zhidaItemId) && matchShopeeItem(row, order, item));
    if (lineIdentity(order, item).ambiguous && legacy.length) return { rows: [], ambiguous: true };
    return { rows: legacy.slice().sort(byCreated), ambiguous: false };
  }
  function byCreated(a, b) {
    return (a.createdAt || 0) - (b.createdAt || 0);
  }
  function appendRecordField(parent, label, value) {
    const field = document.createElement('div');
    field.className = 'm2-record-field';
    const name = document.createElement('div');
    name.className = 'm2-record-label';
    name.textContent = label;
    const val = document.createElement('div');
    val.className = 'm2-record-value';
    val.textContent = value == null ? '' : String(value);
    field.appendChild(name);
    field.appendChild(val);
    parent.appendChild(field);
    return val;
  }
  function appendCopy(parent, raw) {
    const actions = document.createElement('div');
    actions.className = 'm2-record-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'm2-undo';
    btn.textContent = '复制';
    btn.addEventListener('click', () => copyRaw(raw, btn));
    actions.appendChild(btn);
    parent.appendChild(actions);
  }
  function copyRaw(raw, button) {
    const value = String(raw == null ? '' : raw);
    const done = (ok) => {
      if (!ok) {
        alert('复制失败，请直接选择编号');
        return;
      }
      const prev = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = prev; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => done(true), () => done(false));
      return;
    }
    done(false);
  }
  function purchaseLineKey(order, item) {
    if (order.zhidaOrderId && item.zhidaItemId) return 'z:' + order.zhidaOrderId + ':' + item.zhidaItemId;
    return 'l:' + order.orderSn + ':' + item.itemId + ':' + (item.modelId || '');
  }
  function attachPurchaseToggle(box, stack, order, item) {
    const records = stack.querySelectorAll('.m2-purchase-record');
    if (!records.length) return;
    const key = purchaseLineKey(order, item);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'm2-record-toggle';
    const paint = () => {
      const collapsed = collapsedPurchaseLines.has(key);
      stack.classList.toggle('is-collapsed', collapsed);
      toggle.textContent = (collapsed ? '▶ 展开采购记录' : '▼ 收起采购记录') + '（' + records.length + '）';
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    toggle.addEventListener('click', () => {
      if (collapsedPurchaseLines.has(key)) collapsedPurchaseLines.delete(key);
      else collapsedPurchaseLines.add(key);
      paint();
    });
    paint();
    stack.insertBefore(toggle, stack.firstChild);
    box.appendChild(stack);
  }
  function renderPurchaseRecords(box, order, item, bindings, maps) {
    const stack = document.createElement('div');
    stack.className = 'm2-purchase-stack';
    const matched = purchasesForLine(order, item);
    if (matched.ambiguous) {
      const note = document.createElement('div');
      note.className = 'm2-purchase-record m2-record-note';
      note.textContent = '当前订单里有多条相同商品，无法区分采购记录。请刷新订单后再试';
      stack.appendChild(note);
      attachPurchaseToggle(box, stack, order, item);
      return;
    }
    if (matched.rows.length && typeof M2PurchaseStore !== 'undefined') {
      matched.rows.forEach((purchase) => {
        const view = M2PurchaseStore.describePurchase(purchase);
        const card = document.createElement('div');
        card.className = 'm2-purchase-record';
        appendRecordField(card, '采购状态', view.label);
        if (view.platformOrderSn) {
          appendRecordField(card, '采购订单号', view.platformOrderSn);
          appendCopy(card, view.platformOrderSn);
        } else {
          appendRecordField(card, '采购订单号', '尚未采集');
        }
        appendRecordField(card, '实付金额', view.amountState === 'known' ? view.amountText : '尚未采集');
        appendRecordField(card, '金额同步', view.amountState === 'known' ? view.amountSyncText : '尚未采集');
        const tracks = purchase.logistics || [];
        if (!tracks.length) {
          appendRecordField(card, '快递单号', purchase.platformOrderSn ? '等待商家发货' : '尚未采集');
        } else {
          tracks.forEach((entry) => {
            const sync = entry.sync === 'confirmed' ? '后台已确认' : (entry.sync === 'failed' ? '同步失败' : '本地已记录，后台待同步');
            appendRecordField(card, '快递单号', entry.number + '（' + sync + '）');
            appendCopy(card, entry.number);
          });
        }
        if (view.detail) appendRecordField(card, '说明', view.detail);
        if (view.paymentText) appendRecordField(card, '支付结果', view.paymentText);
        (purchase.candidates || []).forEach((candidate) => {
          const pick = document.createElement('button');
          pick.type = 'button';
          pick.className = 'm2-undo';
          pick.textContent = '选择订单 ' + candidate.orderSn + (candidate.payMinor != null ? ' ¥' + (Number(candidate.payMinor) / 100).toFixed(2) : '');
          pick.addEventListener('click', () => {
            pick.disabled = true;
            chrome.runtime.sendMessage({
              type: 'm2_chooseCandidate',
              purchaseId: purchase.purchaseId,
              orderSn: candidate.orderSn,
              detailHref: candidate.detailHref || '',
            }, (resp) => {
              pick.disabled = false;
              if (!resp || !resp.ok) alert('选择失败：' + ((resp && resp.error) || '未知错误'));
            });
          });
          card.appendChild(pick);
        });
        const actions = document.createElement('div');
        actions.className = 'm2-record-actions';
        const source = {
          platform: purchase.platform || (bindings[0] && bindings[0].platform) || 'PINDUODUO',
          productUrl: purchase.productUrl || (bindings[0] && bindings[0].productUrl) || '',
        };
        if (purchase.platformOrderSn && purchase.logisticsSync !== 'confirmed') {
          const checkBtn = document.createElement('button');
          checkBtn.className = 'm2-undo';
          checkBtn.textContent = '查物流';
          checkBtn.addEventListener('click', () => onCheckLogistics(order, item, source, purchase));
          actions.appendChild(checkBtn);
        }
        if (!purchase.platformOrderSn || purchase.status === 'needs_review') {
          const confirmBtn = document.createElement('button');
          confirmBtn.className = 'm2-undo';
          confirmBtn.textContent = '人工确认';
          confirmBtn.addEventListener('click', () => onConfirmAssociation(purchase, source));
          actions.appendChild(confirmBtn);
        }
        if (!purchase.platformOrderSn || !(purchase.amount && purchase.amount.minor != null)) {
          const retryBtn = document.createElement('button');
          retryBtn.className = 'm2-undo';
          retryBtn.textContent = '重试补采';
          retryBtn.addEventListener('click', () => {
            retryBtn.disabled = true;
            chrome.runtime.sendMessage({ type: 'm2_retryCollection', purchaseId: purchase.purchaseId }, (resp) => {
              retryBtn.disabled = false;
              if (!resp || !resp.ok) alert('补采失败：' + ((resp && resp.error) || '未知错误'));
            });
          });
          actions.appendChild(retryBtn);
        }
        if (actions.childNodes.length) card.appendChild(actions);
        stack.appendChild(card);
      });
      attachPurchaseToggle(box, stack, order, item);
      return;
    }
    const key = orderKey(order, item);
    const synced = maps.syncedMap[key];
    const sn = (synced && synced.platformOrderSn) || maps.orderSnMap[key] || '';
    const price = maps.priceMap[key];
    const ordered = maps.orderStatusMap[key] && maps.orderStatusMap[key].status === 'ordered';
    if (!ordered && !sn && !price && !(synced && synced.logisticsNumber)) return;
    const card = document.createElement('div');
    card.className = 'm2-purchase-record';
    appendRecordField(card, '采购状态', synced && synced.logisticsNumber ? '已回传' : '已下单');
    if (sn) {
      appendRecordField(card, '采购订单号', sn);
      appendCopy(card, sn);
    }
    if (price) appendRecordField(card, '实付金额', '¥' + Number(price).toFixed(2));
    else appendRecordField(card, '实付金额', '尚未采集');
    if (synced && synced.logisticsNumber) {
      appendRecordField(card, '快递单号', synced.logisticsNumber);
      appendCopy(card, synced.logisticsNumber);
    } else {
      appendRecordField(card, '快递单号', '等待商家发货');
    }
    const source = bindings[0] || { platform: 'PINDUODUO', productUrl: '' };
    if (sn) {
      const actions = document.createElement('div');
      actions.className = 'm2-record-actions';
      const checkBtn = document.createElement('button');
      checkBtn.className = 'm2-undo';
      checkBtn.textContent = '查物流';
      checkBtn.addEventListener('click', () => onCheckLogistics(order, item, source));
      actions.appendChild(checkBtn);
      card.appendChild(actions);
    }
    stack.appendChild(card);
    attachPurchaseToggle(box, stack, order, item);
  }

  async function onBindClick(order, item, button) {
    const productUrl = window.prompt('请输入商品链接（拼多多/淘宝/1688 均可）：', '');
    if (!productUrl) return;
    const platform = detectPlatformFromUrl(productUrl);
    if (button) button.disabled = true;
    const resp = await addBinding(order, item, { productUrl: productUrl, platform: platform, productName: item.itemName || '', price: 0 });
    if (button) button.disabled = false;
    if (!resp || !resp.ok) {
      alert('绑定失败：' + ((resp && resp.error) || '未知错误'));
      return;
    }
    alert(resp.restored ? '已恢复当前项的货源关联' : '绑定成功！');
    renderOrders();
  }

  // ---------- 下单 ----------
  async function onBuyClick(order, item, binding) {
    const productUrl = binding.productUrl;
    const platform = binding.platform || detectPlatformFromUrl(productUrl);
    const quantity = item.modelQuantityPurchased || 1;

    chrome.runtime.sendMessage(
      {
        type: 'm2_startPurchase',
        productUrl,
        platform,
        quantity,
        bindingId: binding.id,
        shopeeOrder: {
          orderSn: order.orderSn,
          zhidaOrderId: order.zhidaOrderId,
          itemId: item.itemId,
          modelId: item.modelId,
          zhidaItemId: item.zhidaItemId,
          itemName: item.itemName,
          modelName: item.modelName,
          imageUrl: getImageUrl(item),
          quantity,
        },
      },
      async (resp) => {
        if (!resp || !resp.ok) {
          alert('启动采购失败：' + (resp && resp.error ? resp.error : '未知错误'));
          return;
        }
        await loadStorageCache();
        renderOrders();
      }
    );
  }

  // 本地记下的采购订单号。规格一边为空时仍按订单号+商品匹配，避免对不上就去打开订单列表
  function matchShopeeItem(stored, order, item) {
    if (!stored || !order) return false;
    if (String(stored.orderSn || '') !== String(order.orderSn || '')) return false;
    const storedItem = stored.itemId == null ? '' : String(stored.itemId);
    const currentItem = item && item.itemId == null ? '' : String(item.itemId);
    if (storedItem && currentItem && storedItem !== currentItem) return false;
    const storedModel = stored.modelId == null ? '' : String(stored.modelId);
    const currentModel = item && item.modelId == null ? '' : String(item.modelId);
    if (storedModel && currentModel && storedModel !== currentModel) return false;
    return true;
  }

  // ---------- 查物流 ----------
  function onConfirmAssociation(purchase, binding) {
    const platformOrderSn = window.prompt('填入这一单的拼多多订单号。填错不会自动改掉别的订单。', purchase.platformOrderSn || '');
    if (!platformOrderSn) return;
    chrome.runtime.sendMessage({
      type: 'm2_confirmAssociation',
      purchaseId: purchase.purchaseId,
      platformOrderSn: platformOrderSn.trim(),
      platform: binding.platform || 'PINDUODUO',
    }, (resp) => {
      if (!resp || !resp.ok) alert('确认失败：' + ((resp && resp.error) || '未知错误'));
    });
  }

  async function onCheckLogistics(order, item, binding, purchase) {
    const stored = await new Promise((resolve) => chrome.storage.local.get(['pendingCollect', 'purchaseRecords'], resolve));
    let platformOrderSn = '';
    for (const p of stored.pendingCollect || []) {
      if (p.platformOrderSn && matchShopeeItem(p.shopeeOrder, order, item)) {
        platformOrderSn = p.platformOrderSn;
        break;
      }
    }
    if (!platformOrderSn) {
      const map = stored.purchaseRecords || {};
      for (const sn of Object.keys(map)) {
        if (matchShopeeItem((map[sn] || {}).shopeeOrder, order, item)) {
          platformOrderSn = sn;
          break;
        }
      }
    }
    chrome.runtime.sendMessage(
      {
        type: 'm2_checkLogistics',
        purchaseId: purchase && purchase.purchaseId,
        platformOrderSn: (purchase && purchase.platformOrderSn) || platformOrderSn,
        shopeeOrder: {
          orderSn: order.orderSn, itemId: item.itemId, modelId: item.modelId,
          zhidaOrderId: order.zhidaOrderId, zhidaItemId: item.zhidaItemId,
          quantity: item.modelQuantityPurchased || 1,
        },
        platform: binding.platform,
        productUrl: binding.productUrl,
      },
      (resp) => {
        if (!resp || !resp.ok) {
          alert('查物流失败：' + (resp && resp.error ? resp.error : '未知错误'));
          return;
        }
        alert('已打开这个订单的物流页面。采集到运输单号后会自动回传，回传完成后重新打开面板即可看到「已回传」。');
      }
    );
  }

  // ---------- 批量查物流 ----------
  async function onBatchCheckLogistics() {
    chrome.runtime.sendMessage({ type: 'm2_triggerAutoCollect' }, (resp) => {
      if (resp && resp.ok) {
        if (resp.count === 0) alert('没有待采集运输单号的订单（可能还没下单、或还没记录到订单号）');
        else alert('已开始后台静默采集 ' + resp.count + ' 个订单的运输单号，采集到会自动回传');
      } else {
        alert('触发失败：' + (resp && resp.error ? resp.error : '未知错误'));
      }
    });
  }

  // ---------- 清空本地数据（测试/排查串单时用，不影响 shopee365 后端） ----------
  async function onClearData() {
    if (!confirm('确定清空本地数据吗？会清除绑定记录、订单状态、回传记录（不影响 shopee365 后端已写入的数据）。')) return;
    chrome.storage.local.clear(() => {
      alert('已清空本地数据。请刷新页面重新开始。');
      location.reload();
    });
  }

  // ---------- 加载店铺列表 ----------
  // zhida 没有独立店铺接口，从订单数据中收集店铺名
  function collectShops(orders) {
    const names = new Set();
    const select = document.getElementById('m2-shop-filter');
    // 保留已有选项
    for (let i = 1; i < select.options.length; i++) {
      names.add(select.options[i].value);
    }
    (orders || []).forEach((o) => {
      if (o.shopName) names.add(o.shopName);
    });
    const currentVal = select.value;
    select.innerHTML = '<option value="" selected>全部店铺</option>';
    Array.from(names).sort().forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
    select.value = currentVal || '';
  }

  // ---------- 初始化 ----------
  injectStyle();
  buildPanel();
  // 店铺列表从订单数据中动态收集（首次打开面板时触发 loadOrders → collectShops）

  // 显示最近错误
  async function showErrorFromStorage() {
    const r = await new Promise((resolve) => chrome.storage.local.get('errorLog', resolve));
    const errors = r.errorLog || [];
    const bar = document.getElementById('m2-error-bar');
    if (!bar || !errors.length) { if (bar) bar.style.display = 'none'; return; }
    bar.textContent = '⚠️ ' + errors[errors.length - 1].message;
    bar.style.display = '';
  }
  // 面板打开时也检查错误
  const origFabClick = document.getElementById('m2-fab').onclick;
  document.getElementById('m2-fab').addEventListener('click', () => {
    setTimeout(showErrorFromStorage, 500); // 等面板渲染完
  });

  // 监听 storage 变化：更新缓存 + 自动刷新面板
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needRefresh = false;
    if (changes.bindingMap) { cachedBindingMap = changes.bindingMap.newValue || {}; needRefresh = true; }
    if (changes.orderStatusMap) { cachedOrderStatusMap = changes.orderStatusMap.newValue || {}; needRefresh = true; }
    if (changes.syncedLogistics) { cachedSyncedList = changes.syncedLogistics.newValue || []; needRefresh = true; }
    if (changes.pendingCollect) { cachedPcList = changes.pendingCollect.newValue || []; needRefresh = true; }
    if (changes.m2Purchases) { cachedPurchases = changes.m2Purchases.newValue || []; needRefresh = true; }
    if (changes.m2BindingExclusions) { cachedExclusions = changes.m2BindingExclusions.newValue || {}; needRefresh = true; }
    if (changes.purchaseRecords) needRefresh = true;
    if (changes.errorLog) { showErrorFromStorage(); }
    if (needRefresh) {
      const root = document.getElementById('m2-panel-root');
      if (root && root.style.display === 'block') renderOrders();
    }
  });

  // 定期同步 token 到 chrome.storage.local，供 background.js 调用 addExpress 使用
  setInterval(() => {
    const token = getAccessToken();
    if (token) {
      try { chrome.storage.local.set({ __zhidaToken: token }); } catch (e) {}
    }
  }, 5000);
})();
