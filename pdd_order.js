// ============================================================
// Shopee365 M2 采购助手 —— pdd_order.js（拼多多/淘宝/1688 侧）
//
// 状态：⚠️ 半成品，联调中，勿直接上线
//       ✅ 拼多多商品页选规格/设数量/立即购买 → 结账页 → 自动选支付宝+立即支付（半自动，付款由用户确认）
//       ⚠️ 订单号提取 + 运输单号采集：已实现但选择器可能随电商页面改版失效，需持续维护
//       ❌ 淘宝/1688 自动下单：未实现（当前只手动下单，仅采集运输单号）
//
// 机制：通过 chrome.storage 的 purchaseContext 做跨页面状态恢复；
//       拼多多是 SPA 无刷新跳转，用 setInterval 轮询检测页面状态变化
// ============================================================

(function () {
  if (window.__m2PddLoaded) return;
  window.__m2PddLoaded = true;

  // 扩展被重载后，旧页面的 chrome.storage 会失效（undefined），此时静默跳过，避免报错刷屏
  function storageAvailable() {
    try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (e) { return false; }
  }
  if (!storageAvailable()) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getContext() {
    return new Promise((resolve) => {
      if (!storageAvailable()) { resolve(null); return; }
      chrome.storage.local.get('purchaseContext', (r) => resolve(r.purchaseContext || null));
    });
  }
  function setContext(ctx) {
    return new Promise((resolve) => {
      if (!storageAvailable()) { resolve(); return; }
      chrome.storage.local.set({ purchaseContext: ctx }, resolve);
    });
  }
  function notify(type, payload) {
    if (!storageAvailable()) return;
    try { chrome.runtime.sendMessage({ type, ...payload }); } catch (e) {}
  }

  function sendConfirmed(type, payload) {
    return new Promise((resolve, reject) => {
      if (!storageAvailable()) { reject(new Error('插件存储不可用')); return; }
      let finished = false;
      const timeout = setTimeout(() => finish(false), 3000);
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (ok) resolve();
        else reject(new Error(type + ' 未保存，请重试'));
      }
      try { chrome.runtime.sendMessage({ type, ...payload }, (resp) => finish(!chrome.runtime.lastError && !!(resp && resp.ok))); }
      catch (e) { finish(false); }
    });
  }

  // 精确获取「当前 tab」的采购上下文（按 tab.id，避免多单并发时全局 purchaseContext 被覆盖串单）
  function getMyContext() {
    return new Promise((resolve) => {
      if (!storageAvailable()) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage({ type: 'm2_getTabContext' }, (resp) => {
          resolve(resp && resp.ok && resp.context ? resp.context : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 平台识别
  function detectPlatform() {
    const host = window.location.hostname || '';
    if (host.includes('pinduoduo') || host.includes('yangkeduo') || host.includes('pdd.com')) return 'PINDUODUO';
    if (host.includes('1688')) return 'ALIBABA';
    if (host.includes('taobao') || host.includes('tmall') || host.includes('tb.cn')) return 'TAOBAO';
    return '';
  }

  // 页面类型判断
  const isProductPage = () => !window.location.href.includes('order_checkout') && /goods/.test(window.location.href);
  const isCheckoutPage = () => window.location.href.includes('order_checkout') || document.body.id === 'order_checkout';
  const isSuccessPage = () => /order_success|order_detail/.test(window.location.href);

  // 穿透 shadow DOM 查找所有元素（1688 等站的 tab 在 shadow root 里，普通 querySelector 找不到）
  function queryAllDeep(selector) {
    const results = [];
    const walk = (root) => {
      try {
        root.querySelectorAll(selector).forEach((el) => results.push(el));
        root.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      } catch (e) {}
    };
    walk(document);
    return results;
  }

  function findButtonByText(...texts) {
    // 可点击元素范围：button/a/role=button 优先，再补 div/span（穿透 shadow DOM）
    const all = queryAllDeep('button, a, div[role="button"], span[role="button"], div, span');

    // 1) 精确匹配：textContent 完全等于目标文本（最可靠）
    for (const x of texts) {
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (t === x) {
          return el.closest('button, a, div[role="button"], span[role="button"]') || el;
        }
      }
    }

    // 2) 模糊匹配：找 textContent「最短」的包含目标文本的元素（最具体，避免命中整页容器）
    let best = null;
    for (const x of texts) {
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (!t || !t.includes(x)) continue;
        if (!best || t.length < (best.textContent || '').length) best = el;
      }
      if (best) break; // 按 texts 优先级，前面的词命中就不再试后面的
    }
    if (best) {
      return best.closest('button, a, div[role="button"], span[role="button"]') || best;
    }
    return null;
  }

  async function waitFor(fn, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = fn();
      if (r) return r;
      await sleep(250);
    }
    return null;
  }

  // 选规格（selectedSpecs 为空则跳过，交给拼多多默认）
  async function selectSpecs(specs) {
    if (!specs || !Object.keys(specs).length) return;
    for (const [keyId, valueId] of Object.entries(specs)) {
      const el = document.querySelector(
        `[data-spec-key-id="${keyId}"][data-spec-value-id="${valueId}"]`
      );
      if (el) { el.click(); await sleep(300); }
    }
  }

  // 设数量
  async function setQuantity(qty) {
    const sels = ['input[type="number"]', 'input[name="quantity"]', '.quantity-input', '[data-testid="quantity-input"]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        el.value = String(qty);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    console.warn('[M2] 未找到数量输入框，使用默认数量');
    return false;
  }

  // 点「立即购买」
  async function clickBuyNow() {
    const btn = await waitFor(() => findButtonByText('立即购买', '立即下单'));
    if (!btn) throw new Error('未找到「立即购买」按钮');
    btn.click();
  }

  // 填地址（无真实地址则跳过，用拼多多默认地址）
  async function fillAddress(addr) {
    if (!addr || !addr.recipientName) return;
    const fields = [
      ['name', addr.recipientName, ['input[name="name"]', 'input[placeholder*="姓名"]']],
      ['phone', addr.recipientPhone, ['input[name="phone"]', 'input[type="tel"]', 'input[placeholder*="电话"]']],
      ['address', addr.recipientAddress, ['input[name="address"]', 'textarea[name="address"]', 'input[placeholder*="地址"]']],
    ];
    for (const [, value, sels] of fields) {
      if (!value) continue;
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(200);
          break;
        }
      }
    }
  }

  // 选支付宝支付方式
  async function selectAlipay() {
    // 优先点可点击的容器（data-active / role）
    const clickables = Array.from(document.querySelectorAll('div,span,button,a,label,li'));
    // 1) 精确文本「支付宝」
    let el = clickables.find((x) => (x.textContent || '').trim() === '支付宝');
    // 2) 包含「支付宝」且是可点击容器
    if (!el) {
      el = clickables.find((x) => {
        const t = (x.textContent || '').trim();
        return t.includes('支付宝') && (x.hasAttribute('data-active') || x.getAttribute('role') === 'button' || x.closest('[data-active]'));
      });
    }
    if (el) {
      // 点击它的 data-active 容器（真正的可点击项）
      const active = el.closest('[data-active]') || el.closest('[role="button"]') || el;
      console.log('[M2] 选中支付宝:', active.className || active.tagName);
      active.click();
      await sleep(500);
      return;
    }
    console.warn('[M2] 未找到支付宝选项，跳过（可能需要手动选）');
  }

  // 点「立即支付」（提交订单并跳转支付）
  async function submitOrder() {
    const btn = await waitFor(() => findButtonByText('立即支付', '提交订单', '确认下单'));
    if (!btn) throw new Error('未找到「立即支付」按钮');
    btn.click();
  }

  function extractOrderSn() {
    const text = document.body ? document.body.textContent || '' : '';
    if (typeof M2Collectors !== 'undefined') {
      return M2Collectors.extractOrderSn(window.location.href, text) || null;
    }
    return null;
  }

  // 从页面提取实付金额
  function extractPrice() {
    try {
      const text = document.body ? document.body.textContent || '' : '';
      if (typeof M2Collectors === 'undefined') return null;
      const found = M2Collectors.extractPaidAmount(text);
      return found ? found.yuan : null;
    } catch (e) { return null; }
  }

  function cleanTracking(s) {
    if (!s) return '';
    const cleaned = s.replace(/[^A-Za-z0-9]/g, '');
    // 快递单号必须以数字为主（至少 8 位数字），拦截 grabTicket 这类纯英文变量名
    const digitCount = (cleaned.match(/\d/g) || []).length;
    if (digitCount < 8) return '';
    const m = cleaned.match(/[A-Za-z0-9]{10,}/);
    return m ? m[0] : '';
  }

  // 穿透 shadow DOM 读取全文文本（1688 等站的订单详情在 shadow root 里，普通读取读不到）
  function getAllTextDeep() {
    const texts = [];
    const collect = (root) => {
      try {
        const els = root.querySelectorAll('*');
        for (const el of els) {
          const tag = (el.tagName || '').toUpperCase();
          // 排除 script/style，避免把 JS 变量名（如 grabTicket）误当单号
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
          if (el.shadowRoot) {
            collect(el.shadowRoot);
          } else if (el.children.length === 0) {
            const t = (el.textContent || '').trim();
            if (t) texts.push(t);
          }
        }
      } catch (e) {}
    };
    collect(document.body);
    return texts.join(' ');
  }

  function extractTrackingNumber() {
    // 优先从 URL 提取（拼多多物流详情页 URL 带 tracking_number= 参数，最准确）
    try {
      const um = window.location.href.match(/tracking_number=([^&]+)/);
      if (um) {
        const t = cleanTracking(decodeURIComponent(um[1]));
        if (t) return t;
      }
    } catch (e) {}

    const text = getAllTextDeep();
    const patterns = [
      /快递单号[:：]?\s*([A-Za-z0-9]{10,})/,
      /物流单号[:：]?\s*([A-Za-z0-9]{10,})/,
      /运单号[码]?[:：]?\s*([A-Za-z0-9]{10,})/,
      // 单号（排除「订单号」，负向后行断言要求前面不是「订」）
      /(?<!订)单号[:：]?\s*([A-Za-z0-9]{10,})/,
      // 快递公司名 + 快递 + 单号（淘宝「中通快递 773434791019796」、圆通「YT8899...」带字母前缀）
      // 注意：分隔符用 [^A-Za-z0-9]（只匹配空格/冒号等），不能用 [^0-9]，否则会把 YT 等字母前缀误当分隔符吃掉
      /(?:中通|圆通|申通|韵达|顺丰|极兔|邮政|EMS|京东|德邦|百世|丰网|天天|安能|丹鸟|菜鸟)\s*快递[^A-Za-z0-9]{0,6}([A-Za-z0-9]{10,})/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return cleanTracking(m[1]);
    }
    const sels = ['.express-no', '.express-id', '.logistics-number', '.tracking-number', '.waybill-num', '[class*="express"]', '[class*="tracking"]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        const t = cleanTracking(el.textContent || '');
        if (t) return t;
      }
    }
    return '';
  }

  function isOrderDetailPage() {
    const platform = detectPlatform();
    const url = window.location.href;
    if (platform === 'PINDUODUO') {
      if (isCheckoutPage()) return false;
      // 物流页才是这一单；order.html 不带 order_sn 是订单列表
      if (/goods_express\.html/.test(url)) return true;
      return /order\.html/.test(url) && /order_sn=/.test(url);
    }
    if (platform === 'TAOBAO') return /trade_order_detail|biz_order_id=/.test(url);
    if (platform === 'ALIBABA') return /orderId=|order_id=/.test(url);
    return false;
  }

  // 判断是否为订单列表页（需要扫描订单号）
  function isListPage(platform) {
    const url = window.location.href;
    if (platform === 'PINDUODUO') {
      if (typeof M2Discovery !== 'undefined') return M2Discovery.pageKind(url) === 'order_list';
      try {
        const parsed = new URL(url);
        return /\/orders\.html$/.test(parsed.pathname) || (/\/order\.html$/.test(parsed.pathname) && !parsed.searchParams.get('order_sn'));
      } catch (e) {
        return false;
      }
    }
    if (platform === 'TAOBAO') return /buyertrade|list_bought_items/.test(url);
    if (platform === 'ALIBABA') return /buyer_order_list|trade\.1688/.test(url);
    return false;
  }

  // 从订单列表页扫描所有订单号
  function extractOrderSnList() {
    const sns = new Set();
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href || '';
      const patterns = [/order_sn=([^&]+)/, /orderId=([^&]+)/, /order_id=([^&]+)/, /biz_order_id=([^&]+)/];
      for (const p of patterns) {
        const m = href.match(p);
        if (m) { sns.add(m[1]); break; }
      }
    });
    document.querySelectorAll('[data-order-sn]').forEach((el) => {
      const v = el.getAttribute('data-order-sn');
      if (v) sns.add(v);
    });
    document.querySelectorAll('[data-order-id]').forEach((el) => {
      const v = el.getAttribute('data-order-id');
      if (v && /^\d+$/.test(v)) sns.add(v);
    });
    return Array.from(sns);
  }

  // 参考悬浮框：常驻显示客户下单的图片 + 规格 + 数量
  function showReferencePanel(shopeeOrder) {
    if (!shopeeOrder || document.getElementById('m2-ref-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'm2-ref-panel';
    panel.style.cssText =
      'position:fixed; right:16px; top:16px; width:230px; background:#fff; border:1px solid #ff6b00; ' +
      'border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,.2); z-index:2147483000; padding:12px; ' +
      'font-family:-apple-system,"Microsoft YaHei",sans-serif; font-size:12px; color:#111;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700; color:#ff6b00; margin-bottom:8px; font-size:13px;';
    title.textContent = '👤 客户下单商品';
    panel.appendChild(title);

    if (shopeeOrder.imageUrl) {
      const img = document.createElement('img');
      img.src = shopeeOrder.imageUrl;
      img.style.cssText = 'width:100%; border-radius:6px; margin-bottom:8px; object-fit:cover;';
      panel.appendChild(img);
    }

    const name = document.createElement('div');
    name.style.cssText = 'margin-bottom:4px; line-height:1.4;';
    name.textContent = shopeeOrder.itemName || '';
    panel.appendChild(name);

    if (shopeeOrder.modelName) {
      const model = document.createElement('div');
      model.style.cssText = 'margin-bottom:4px; color:#e65100; font-weight:600;';
      model.textContent = '规格：' + shopeeOrder.modelName;
      panel.appendChild(model);
    }

    const qty = document.createElement('div');
    qty.style.cssText = 'color:#666;';
    qty.textContent = '数量：' + (shopeeOrder.quantity || 1);
    panel.appendChild(qty);

    document.body.appendChild(panel);
  }

  // 查物流如果还是落到订单列表，改打开这一单的物流页（列表上看不到运单号和价格）
  function detailUrlFor(platform, orderSn) {
    const sn = encodeURIComponent(orderSn || '');
    if (platform === 'TAOBAO') return 'https://trade.taobao.com/trade/detail/trade_order_detail.htm?biz_order_id=' + sn;
    if (platform === 'ALIBABA') return 'https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=' + sn;
    return 'https://mobile.yangkeduo.com/goods_express.html?order_sn=' + sn + '&refer_page_name=order_detail';
  }

  async function main() {
    if (window.__m2MainDone) return;
    const platform = detectPlatform();
    const myCtxEarly = await getMyContext();
    if (myCtxEarly && myCtxEarly.purpose === 'collect_orders') {
      window.__m2MainDone = true;
      if (typeof M2Discovery !== 'undefined' && M2Discovery.runCollect) await M2Discovery.runCollect(myCtxEarly);
      if (isOrderDetailPage() || isSuccessPage()) await collectOrderResult(platform);
      return;
    }
    const targetSn = myCtxEarly && myCtxEarly.platformOrderSn;
    if (targetSn && isListPage(platform)) {
      const guard = 'm2_left_list_' + targetSn;
      let already = false;
      try { already = sessionStorage.getItem(guard) === '1'; } catch (e) {}
      if (!already) {
        try { sessionStorage.setItem(guard, '1'); } catch (e) {}
        window.location.href = detailUrlFor(platform, targetSn);
        return;
      }
    }
    window.__m2MainDone = true;

  // 订单列表页：扫描所有订单号，发给后台逐个静默采集
  if (isListPage(platform)) {
    const snList = extractOrderSnList();
    if (snList.length) {
      notify('m2_orderSnList', { orderSnList: snList, platform });
    }
  }

    // 订单详情页：记录订单号 + 采集快递单号
    await collectOrderResult(platform);

    // 所有平台：显示参考悬浮框（客户下单商品）
    const myCtx = await getMyContext();
    const ctx = myCtx || (await getContext()) || {};
    if (ctx && ctx.shopeeOrder) {
      // 记住当前这单的 shopee 订单（窗口变量，SPA 跳转不丢失，避免多单并发时串单）
      window.__m2ShopeeOrder = ctx.shopeeOrder;
      showReferencePanel(ctx.shopeeOrder);
    }

    // 拼多多专属：自动下单；淘宝/1688 手动下单，不自动
    if (platform !== 'PINDUODUO') return;

    try {
      if (isProductPage() && ctx.currentStep === 'product') {
        if (!ctx.purchaseId) {
          notify('m2_purchaseError', { error: '采购身份还没保存，已停止自动购买' });
          return;
        }
        console.log('[M2] 商品页：选规格 → 设数量 → 立即购买');
        await selectSpecs(ctx.selectedSpecs);
        await setQuantity(ctx.quantity);
        await rememberPurchaseIntent(ctx);
        await clickBuyNow();
        ctx.currentStep = 'checkout';
        await setContext(ctx);
      } else if (isCheckoutPage()) {
        await runCheckout(ctx);
      } else if (isSuccessPage() || ctx.currentStep === 'done') {
        // 订单号提取统一交给 collectOrderResult（防重复发送）
        await collectOrderResult(platform);
      }
    } catch (e) {
      console.error('[M2] 采购流程错误:', e);
      notify('m2_purchaseError', { error: e && e.message ? e.message : String(e) });
    }
  }

  function rememberPurchaseIntent(ctx) {
    if (!ctx || !ctx.purchaseId) return Promise.reject(new Error('缺少采购编号'));
    const source = (ctx.productUrl || window.location.href || '');
    const goods = source.match(/goods_id=(\d+)/);
    return sendConfirmed('m2_savePurchaseIntent', {
      purchaseId: ctx.purchaseId,
      intent: {
        goodsId: goods ? goods[1] : '',
        skuId: '',
        quantity: ctx.quantity || 1,
        submittedAt: Date.now(),
      },
    });
  }

  // 结账页支付流程：填地址 → 选支付宝 → 立即支付（停在支付宝确认，付款手动）
  async function runCheckout(ctx) {
    if (window.__m2CheckoutDone) return;
    window.__m2CheckoutDone = true;
    console.log('[M2] 结账页：填地址 → 选支付宝 → 立即支付');
    await sleep(400);
    await fillAddress(ctx && ctx.shopeeOrder);
    await selectAlipay();
    try {
      await rememberPurchaseIntent(ctx);
      await sendConfirmed('m2_purchaseSubmitted', { purchaseId: ctx.purchaseId, orderSn: null });
    } catch (e) {
      window.__m2CheckoutDone = false;
      throw e;
    }
    await submitOrder();
    if (ctx) {
      ctx.currentStep = 'done';
      await setContext(ctx);
    }
  }

  // 点「查看物流 / 物流信息」展开物流详情（拼多多、淘宝、1688 的运输单号默认折叠，不展开提取不到）
  async function clickViewLogistics() {
    const btn = await waitFor(
      () => findButtonByText('查看物流', '物流信息', '物流详情', '查看完整物流', '查看全部物流'),
      5000
    );
    if (!btn) return false;
    console.log('[M2] 点击「查看物流/物流信息」展开运输单号');
    btn.click();
    window.__m2LogisticsClicked = true;
    await sleep(2500);
    return true;
  }

  // 订单详情页 / 成功页：提取订单号发给后台（面板显示订单号）+ 采集运输单号
  async function collectOrderResult(platform) {
    if (!isOrderDetailPage() && !isSuccessPage()) return;
    let orderSn = extractOrderSn();
    const price = extractPrice();
    // 当前这单的 shopee 订单：窗口变量 > 按 tab.id 精确查 > 全局 purchaseContext 兜底
    const myCtx = await getMyContext();
    const purchaseId = (myCtx && myCtx.purchaseId) || '';
    const shopeeOrder = (myCtx && myCtx.shopeeOrder) || window.__m2ShopeeOrder || null;
    if (!orderSn) orderSn = (myCtx && myCtx.platformOrderSn) || '';
    if (!purchaseId) return;

    // 1) 记录订单号。归属只使用当前标签页的采购编号
    if (orderSn && window.__m2OrderSnSent !== orderSn && window.__m2OrderSnInflight !== orderSn) {
      window.__m2OrderSnInflight = orderSn;
      console.log('[M2] 提取到订单号：', orderSn, price > 0 ? '金额：¥' + price : '');
      chrome.runtime.sendMessage(
        { type: 'm2_purchaseComplete', orderSn: orderSn, platform: platform, shopeeOrder: shopeeOrder, price: price, purchaseId: purchaseId },
        (resp) => {
          window.__m2OrderSnInflight = '';
          if (resp && resp.ok) window.__m2OrderSnSent = orderSn;
        }
      );
    }

    if (orderSn && price != null && price !== '' && window.__m2PriceSent !== orderSn + '_' + price && window.__m2PriceInflight !== orderSn + '_' + price) {
      const priceKey = orderSn + '_' + price;
      window.__m2PriceInflight = priceKey;
      console.log('[M2] 提取到采购金额：', price);
      chrome.runtime.sendMessage(
        { type: 'm2_updatePrice', orderSn: orderSn, platform: platform, shopeeOrder: shopeeOrder, price: price, purchaseId: purchaseId },
        (resp) => {
          window.__m2PriceInflight = '';
          if (resp && resp.ok) window.__m2PriceSent = priceKey;
        }
      );
    }

    if (orderSn) {
      const pageText = (typeof getAllTextDeep === 'function' ? getAllTextDeep() : (document.body ? document.body.textContent || '' : ''));
      let tracking = (typeof M2Collectors !== 'undefined')
        ? M2Collectors.extractTracking(window.location.href, pageText, orderSn)
        : extractTrackingNumber();
      if (!tracking && !window.__m2LogisticsClicked) {
        await clickViewLogistics();
        const again = (typeof getAllTextDeep === 'function' ? getAllTextDeep() : (document.body ? document.body.textContent || '' : ''));
        tracking = (typeof M2Collectors !== 'undefined')
          ? M2Collectors.extractTracking(window.location.href, again, orderSn)
          : extractTrackingNumber();
      }
      if (tracking && window.__m2TrackingSent !== tracking && window.__m2TrackingInflight !== tracking) {
        window.__m2TrackingInflight = tracking;
        console.log('[M2] 提取到运输单号：', tracking);
        chrome.runtime.sendMessage(
          { type: 'm2_collectLogistics', orderSn, logisticsNumber: tracking, shippingCarrier: '', platform, shopeeOrder, purchaseId },
          (resp) => {
            window.__m2TrackingInflight = '';
            if (resp && resp.ok) window.__m2TrackingSent = tracking;
            console.log('[M2] 运输单号回传结果:', JSON.stringify(resp));
          }
        );
      }
    }
  }

  window.addEventListener('load', () => setTimeout(main, 400));
  setTimeout(main, 800);

  // 持续监控 1：SPA 无刷新跳转到结账页时，自动执行支付流程
  setInterval(async () => {
    if (window.__m2CheckoutDone) return;
    if (detectPlatform() !== 'PINDUODUO') return;
    if (!isCheckoutPage()) return;
    const ctx = (await getMyContext()) || (await getContext());
    try {
      await runCheckout(ctx);
    } catch (e) {
      console.error('[M2] 结账页支付流程错误:', e);
      notify('m2_purchaseError', { error: e && e.message ? e.message : String(e) });
    }
  }, 500);

  // 采集页会先停在待发货。点完待分享后页面不刷新，所以要继续点、继续读，并在订单详情里取出单号。
  setInterval(async () => {
    if (detectPlatform() !== 'PINDUODUO') return;
    if (window.__m2CollectDone || window.__m2CollectRunning) return;
    const ctx = await getMyContext();
    if (!ctx || ctx.purpose !== 'collect_orders') return;
    window.__m2CollectRunning = true;
    try {
      if (typeof M2Discovery !== 'undefined' && M2Discovery.runCollect) await M2Discovery.runCollect(ctx);
      if (isOrderDetailPage() || isSuccessPage()) await collectOrderResult('PINDUODUO');
    } catch (e) {
      console.error('[M2] 订单采集错误:', e);
    } finally {
      window.__m2CollectRunning = false;
    }
  }, 700);

  // 持续监控 2：付款成功后 SPA 跳到订单详情页/成功页，自动提取订单号 + 运输单号
  setInterval(async () => {
    if (!isOrderDetailPage() && !isSuccessPage()) return;
    try {
      await collectOrderResult(detectPlatform());
    } catch (e) {
      console.error('[M2] 订单号采集错误:', e);
    }
  }, 800);
})();
