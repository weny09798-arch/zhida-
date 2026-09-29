// 先点待分享，再点待发货。页面控件按可见文字点击，不点免拼和邀请拼单。
// 登录后的卡片结构还没有采样，读不到字段时不会自动认领。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2Discovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  function pageKind(href) {
    let url;
    try { url = new URL(href); } catch (e) { return 'other'; }
    const path = url.pathname || '';
    if (/goods_express\.html$/.test(path)) return 'logistics';
    if (/orders\.html$/.test(path)) return 'order_list';
    if (/order\.html$/.test(path)) return url.searchParams.get('order_sn') ? 'order_detail' : 'order_list';
    if (/personal\.html$/.test(path)) return 'personal';
    if (path === '/' || /index\.html$/.test(path)) return 'home';
    if (/goods\.html$/.test(path)) return 'product';
    return 'other';
  }

  function listTargetOf(page) {
    return page && page.listTarget === '待发货' ? '待发货' : '待分享';
  }

  function listTabFromUrl(href) {
    try {
      if (new URL(href).searchParams.get('type') === '5') return '待分享';
    } catch (e) {}
    return '';
  }

  function nextStep(page) {
    const current = page || {};
    if (current.purpose !== 'collect_orders') return { action: 'stop', reason: '不是只读采集' };
    const target = listTargetOf(current);
    if (current.kind === 'home') return { action: 'click', text: '个人中心' };
    if (current.kind === 'personal') return { action: 'click', text: target };
    if (current.kind === 'order_list') {
      if (current.tab !== target) return { action: 'click', text: target };
      return { action: 'read_cards', listTarget: target };
    }
    if (current.kind === 'order_detail') return { action: 'read_detail' };
    if (current.kind === 'logistics') return { action: 'stop', reason: '物流页不作为实付金额来源' };
    return { action: 'stop', reason: '当前页面未识别，选择器尚未用登录页样本验证' };
  }

  function isPayableStatus(status) {
    return !status || status === 'unshipped' || status === 'paid' || status === '待发货' || status === '待分享';
  }

  function cardStatus(text) {
    const value = String(text || '');
    if (/待分享|差\d+人/.test(value)) return '待分享';
    if (/待付款/.test(value)) return 'unpaid';
    if (/待发货/.test(value)) return 'unshipped';
    return '';
  }

  function shouldOpenCard(text) {
    const value = String(text || '').replace(/\s+/g, '');
    if (!value || value.length > 500) return false;
    if (value === '直接免拼' || value === '邀请好友拼单') return false;
    return /待分享/.test(value) && /实付/.test(value);
  }

  function matchCandidates(intent, cards, options) {
    const wanted = intent || {};
    const opts = options || {};
    const claimed = {};
    (opts.claimedOrderSns || []).forEach(function (sn) { claimed[sn] = true; });
    const list = cards || [];
    if (!wanted.accountId) return { status: 'account_unknown', matches: [] };
    if (list.length && list.every(function (card) { return card.accountId && card.accountId !== wanted.accountId; })) {
      return { status: 'account_changed', matches: [] };
    }
    const eligible = list.filter(function (card) {
      if (!card || claimed[card.orderSn]) return false;
      if (card.accountId && card.accountId !== wanted.accountId) return false;
      if (wanted.mallId && card.mallId && wanted.mallId !== card.mallId) return false;
      if (!wanted.goodsId || card.goodsId !== wanted.goodsId) return false;
      if (!isPayableStatus(card.status)) return false;
      return true;
    });
    const strict = eligible.filter(function (card) {
      if (!card.accountId || card.accountId !== wanted.accountId) return false;
      if (!wanted.skuId || !card.skuId || wanted.skuId !== card.skuId) return false;
      if (wanted.quantity == null || card.quantity == null || Number(wanted.quantity) !== Number(card.quantity)) return false;
      if (card.createdAt == null || wanted.submittedAt == null) return false;
      if (card.createdAt < wanted.submittedAt - 120000) return false;
      const end = wanted.paidAt == null ? wanted.submittedAt : wanted.paidAt;
      if (card.createdAt > end + 10 * 60 * 1000) return false;
      return true;
    });
    if (!opts.searchComplete) return { status: 'incomplete', matches: strict.length ? strict : eligible };
    if (strict.length === 1) return { status: 'unique', matches: strict };
    if (strict.length > 1) return { status: 'choose', matches: strict };
    if (eligible.length) return { status: 'choose', matches: eligible };
    const shareCards = list.filter(function (card) {
      return card && card.orderSn && !claimed[card.orderSn] && card.status === '待分享';
    });
    if (shareCards.length && (opts.listTarget === '待分享' || shareCards.length)) {
      return opts.searchComplete ? { status: 'choose', matches: shareCards } : { status: 'incomplete', matches: shareCards };
    }
    return { status: 'none', matches: [] };
  }

  function findControl(text, root) {
    if (text === '直接免拼' || text === '邀请好友拼单') return null;
    const doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.querySelectorAll) return null;
    let best = null;
    const visit = function (node) {
      const value = (node.innerText || node.textContent || '').replace(/\s+/g, '');
      if (value !== text) return;
      const size = node.children ? node.children.length : 0;
      if (!best || size < best.size) best = { node: node, size: size };
    };
    const walk = function (current) {
      if (!current || !current.querySelectorAll) return;
      current.querySelectorAll('a, button, span, div, li').forEach(function (node) {
        visit(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      });
    };
    walk(doc);
    return best ? best.node : null;
  }

  function readCards(doc) {
    const root = doc || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return [];
    const cards = [];
    const seen = {};
    root.querySelectorAll('a[href*="order_sn="]').forEach(function (link) {
      let sn = '';
      let href = link.href || link.getAttribute('href') || '';
      try { sn = new URL(href, 'https://mobile.yangkeduo.com').searchParams.get('order_sn') || ''; } catch (e) {}
      if (!sn || seen[sn]) return;
      seen[sn] = true;
      const text = ((link.innerText || '') + ' ' + ((link.parentElement && link.parentElement.innerText) || '')).slice(0, 400);
      const goods = text.match(/goods_id[=：:](\d+)/);
      const qty = text.match(/[×xX]\s*(\d+)/);
      const paid = text.match(/实付\s*[¥￥]\s*(\d+(?:\.\d+)?)/);
      cards.push({
        orderSn: sn,
        goodsId: goods ? goods[1] : '',
        skuId: '',
        quantity: qty ? Number(qty[1]) : null,
        mallId: '',
        accountId: '',
        createdAt: null,
        payMinor: paid ? Math.round(Number(paid[1]) * 100) : null,
        status: cardStatus(text),
        detailHref: href,
      });
    });
    return cards;
  }

  function activeListTab(doc) {
    const root = doc || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return '';
    const names = ['待分享', '待发货', '待付款', '待收货', '全部'];
    let found = '';
    root.querySelectorAll('a, button, span, div, li').forEach(function (node) {
      const value = (node.innerText || '').replace(/\s+/g, '');
      if (names.indexOf(value) === -1) return;
      const selected = node.getAttribute && node.getAttribute('aria-selected');
      const className = (node.getAttribute && node.getAttribute('class')) || '';
      const marked = selected === 'true' || /(^|\s)(active|selected|current|on)(\s|$)/i.test(className);
      if (marked) found = value;
    });
    return found;
  }

  function absoluteOrderHref(href) {
    try {
      const url = new URL(href, 'https://mobile.yangkeduo.com');
      if (url.origin !== 'https://mobile.yangkeduo.com' || !/\/order\.html$/.test(url.pathname) || !url.searchParams.get('order_sn')) return '';
      return url.href;
    } catch (e) { return ''; }
  }

  function hrefFrom(node) {
    const own = (node.getAttribute && node.getAttribute('href')) || node.href || '';
    const direct = absoluteOrderHref(own);
    if (direct) return direct;
    if (!node.querySelectorAll) return '';
    let found = '';
    node.querySelectorAll('a').forEach(function (link) {
      if (found) return;
      found = absoluteOrderHref((link.getAttribute && link.getAttribute('href')) || link.href || '');
    });
    return found;
  }

  function orderEntry(doc, listTarget, context) {
    const root = doc || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return null;
    const cards = [];
    root.querySelectorAll('div, a, li').forEach(function (node) {
      const text = node.innerText || '';
      if (!/实付/.test(text)) return;
      if ((listTarget || '待分享') === '待分享' && !shouldOpenCard(text)) return;
      if ((listTarget || '待分享') !== '待分享' && !/待发货/.test(text)) return;
      const compact = text.replace(/\s+/g, '');
      if (!compact || compact.length > 1500) return;
      cards.push(node);
    });
    const leaves = cards.filter(function (node) {
      return !cards.some(function (other) {
        return other !== node && node.contains && node.contains(other);
      });
    });
    if (leaves.length !== 1) return null;
    const card = leaves[0];
    const href = hrefFrom(card);
    if (href) {
      let orderSn = '';
      try { orderSn = new URL(href).searchParams.get('order_sn') || ''; } catch (e) {}
      const claimed = context && Array.isArray(context.claimedOrderSns) ? context.claimedOrderSns : [];
      if (orderSn && claimed.indexOf(orderSn) !== -1) return null;
      return { href: href, node: null, orderSn: orderSn };
    }
    let title = null;
    if (card.querySelectorAll) {
      card.querySelectorAll('div, span, p, a').forEach(function (node) {
        const text = (node.innerText || '').replace(/\s+/g, '');
        if (!/[×xX]\d+/.test(text) || /直接免拼|邀请好友拼单/.test(text)) return;
        if (!text || text.length > 180) return;
        if (!title || text.length < title.length) title = { node: node, length: text.length };
      });
    }
    let image = null;
    let imageScore = -1;
    if (card.querySelectorAll) {
      card.querySelectorAll('img').forEach(function (node) {
        const parentText = (node.parentElement && node.parentElement.innerText) || '';
        const area = (node.naturalWidth || node.width || 0) * (node.naturalHeight || node.height || 0);
        const score = area + (/[×xX]\s*\d+/.test(parentText) ? 100000 : 0);
        if (score > imageScore) {
          image = node;
          imageScore = score;
        }
      });
    }
    if (image) return { href: '', node: image };
    return title ? { href: '', node: title.node } : null;
  }

  function shareListVisible(doc) {
    const text = doc && doc.body ? doc.body.innerText || '' : '';
    return /待分享[，,]|差\d+人/.test(text);
  }

  function press(node) {
    if (!node) return;
    if (typeof node.click === 'function') node.click();
    else if (typeof node.dispatchEvent === 'function') node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  function savedOpenState() {
    try { return JSON.parse(sessionStorage.getItem('m2_open_entry_state') || 'null'); } catch (e) { return null; }
  }

  function saveOpenState(state) {
    try { sessionStorage.setItem('m2_open_entry_state', JSON.stringify(state)); } catch (e) {}
  }

  function reportEntry(ctx, entry) {
    const href = entry.href || '';
    let orderSn = '';
    try { orderSn = new URL(href).searchParams.get('order_sn') || ''; } catch (e) {}
    return new Promise(function (resolve) {
      let settled = false;
      let timeout;
      const finish = function (resp) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(resp && resp.ok ? { ok: true } : { ok: false, reason: (resp && resp.error) || '进入详情前无法保存查单进度' });
      };
      timeout = setTimeout(function () { finish(null); }, 1200);
      chrome.runtime.sendMessage({
        type: 'm2_collectionProgress', purchaseId: ctx.purchaseId, stage: 'entering_detail',
        candidate: { orderSn: orderSn, detailHref: href },
      }, finish);
    });
  }

  async function runCollect(ctx) {
    const listTarget = (ctx && ctx.listTarget) || '待分享';
    const kind = pageKind(location.href);
    if (kind === 'order_detail') {
      try { sessionStorage.removeItem('m2_open_entry_state'); } catch (e) {}
      return;
    }
    const detected = activeListTab(document) || listTabFromUrl(location.href);
    const step = nextStep({
      kind: kind,
      purpose: 'collect_orders',
      tab: kind === 'order_list' ? detected : '',
      listTarget: listTarget,
    });
    if (step.action === 'click') {
      const control = findControl(step.text);
      if (!control) {
        const key = 'm2_missing_control_' + ctx.purchaseId + '_' + step.text;
        let tries = 0;
        try { tries = Number(sessionStorage.getItem(key) || '0'); } catch (e) {}
        if (tries < 3) {
          try { sessionStorage.setItem(key, String(tries + 1)); } catch (e) {}
          return;
        }
        chrome.runtime.sendMessage({ type: 'm2_collectionPaused', purchaseId: ctx.purchaseId, reason: '没有找到「' + step.text + '」。请确认订单页已经打开' });
        return;
      }
      try { sessionStorage.removeItem('m2_missing_control_' + ctx.purchaseId + '_' + step.text); } catch (e) {}
      press(control);
      return;
    }
    if (kind !== 'order_list') {
      if (step.action === 'stop') {
        chrome.runtime.sendMessage({ type: 'm2_collectionPaused', purchaseId: ctx.purchaseId, reason: step.reason || '采集已暂停' });
      }
      return;
    }
    if (listTarget === '待分享' && !shareListVisible(document)) {
      let tries = 0;
      try { tries = Number(sessionStorage.getItem('m2_share_tab_tries') || '0'); } catch (e) {}
      if (tries < 3) {
        try { sessionStorage.setItem('m2_share_tab_tries', String(tries + 1)); } catch (e) {}
        return;
      }
    } else {
      try { sessionStorage.removeItem('m2_share_tab_tries'); } catch (e) {}
    }
    const entry = orderEntry(document, listTarget, ctx);
    const state = savedOpenState();
    const now = Date.now();
    if (state && state.purchaseId === ctx.purchaseId && state.listTarget === listTarget) {
      if (now - state.lastAt < 2000) return;
      if (state.attempts >= 2) {
        chrome.runtime.sendMessage({ type: 'm2_collectionPaused', purchaseId: ctx.purchaseId, reason: '订单卡片已点击，但没有进入订单详情；请手动检查订单页' });
        return;
      }
    }
    if (entry) {
      const progress = await reportEntry(ctx, entry);
      if (!progress.ok) {
        chrome.runtime.sendMessage({ type: 'm2_collectionPaused', purchaseId: ctx.purchaseId, reason: progress.reason });
        return;
      }
      saveOpenState({ purchaseId: ctx.purchaseId, listTarget: listTarget, attempts: (state && state.purchaseId === ctx.purchaseId && state.listTarget === listTarget ? state.attempts : 0) + 1, lastAt: now });
      if (entry.href) location.href = entry.href;
      else press(entry.node);
      return;
    }
    const cards = readCards(document);
    const progress = ctx.progress || {};
    const limited = (progress.screens || 0) >= 3 || (progress.details || 0) >= 5 || (progress.rounds || 0) >= 3;
    chrome.runtime.sendMessage({
      type: 'm2_orderCandidates',
      purchaseId: ctx.purchaseId,
      cards: cards,
      reason: cards.length ? '订单列表有多张或无法可靠区分的卡片' : '订单列表未找到可读取的详情入口，可能还在加载',
      listTarget: listTarget,
      searchComplete: !limited && !/加载中/.test(document.body ? document.body.innerText : ''),
      limitReached: limited,
    }, function (resp) {
      if (!resp || !resp.ok) {
        chrome.runtime.sendMessage({ type: 'm2_collectionPaused', purchaseId: ctx.purchaseId,
          reason: (resp && resp.error) || '订单列表候选未能保存，请检查查单状态' });
        return;
      }
      if (resp && (resp.status === 'unique' || resp.status === 'choose')) {
        window.__m2CollectDone = true;
        return;
      }
      if (!resp || !resp.nextList) return;
      try { sessionStorage.removeItem('m2_share_tab_tries'); } catch (e) {}
      press(findControl(resp.nextList));
    });
  }

  return {
    pageKind: pageKind,
    nextStep: nextStep,
    matchCandidates: matchCandidates,
    readCards: readCards,
    shouldOpenCard: shouldOpenCard,
    listTabFromUrl: listTabFromUrl,
    orderEntry: orderEntry,
    findControl: findControl,
    runCollect: runCollect,
  };
});
