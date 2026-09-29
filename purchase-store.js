// 一笔采购一条长期记录。未知金额不能覆盖已保存的实付，列表顺序不能用来认领订单。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2PurchaseStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  function yuanToMinor(yuan) {
    return Math.round(Number(yuan) * 100);
  }

  function amountIsKnown(amount) {
    return !!(amount && amount.minor != null && !Number.isNaN(Number(amount.minor)));
  }

  function describePurchase(record) {
    const row = record || {};
    const known = amountIsKnown(row.amount);
    const amountText = known ? '¥' + (Number(row.amount.minor) / 100).toFixed(2) : '';
    const amountState = known ? 'known' : 'unknown';
    let amountSyncText = '尚未采集';
    if (known && row.amountSync === 'confirmed') amountSyncText = '后台已确认';
    else if (known && row.amountSync === 'failed') amountSyncText = '同步失败';
    else if (known) amountSyncText = '本地已记录，后台待同步';
    let label = '等待付款确认';
    let detail = '';
    let paid = false;
    let paymentText = '';
    const stage = row.collection && row.collection.stage;
    if (row.paymentReceipt && row.paymentReceipt.status === 'succeeded' && row.paymentReceipt.amountMinor != null && (!known || stage === 'needs_review')) {
      paymentText = '支付宝支付金额：¥' + (Number(row.paymentReceipt.amountMinor) / 100).toFixed(2) + '，订单实付待核对';
    }
    if (row.logisticsSync === 'confirmed') {
      label = '后台已确认';
      paid = true;
      detail = row.amountSync === 'confirmed' ? '物流和金额已提交至达' : '物流已回传';
    } else if (stage === 'unlinked_payment') {
      label = '付款页未能关联';
      detail = (row.collection && row.collection.reason) || '支付页面没有对上本次采购';
    } else if (stage === 'awaiting_choice') {
      label = '采购订单待核对';
      detail = (row.collection && row.collection.reason) || '请在候选订单里选择对应的一笔';
    } else if (stage === 'paused') {
      label = '查单已暂停';
      detail = (row.collection && row.collection.reason) || '请检查拼多多订单页面后重试';
    } else if (stage === 'opening_list' || stage === 'entering_detail') {
      label = stage === 'opening_list' ? '正在查询订单' : '正在读取订单详情';
      detail = (row.collection && row.collection.reason) || '';
    } else if (stage === 'needs_review') {
      label = '订单详情待核对';
      detail = row.reviewReason || (row.collection && row.collection.reason) || '支付金额和订单实付需要核对';
    } else if (row.paymentReceipt && row.paymentReceipt.status === 'succeeded' && !row.platformOrderSn) {
      label = '已记录支付结果，采购订单待补全';
      detail = (row.collection && row.collection.reason) || '正在从待发货订单里查找';
    } else if (row.status === 'needs_review') {
      label = '待人工确认';
      detail = row.reviewReason || '订单归属需要核对';
    } else if (row.status === 'awaiting_login') {
      label = '等待重新登录';
      detail = row.reviewReason || '登录失效后已暂停回传';
    } else if (row.status === 'retrying' || row.logisticsSync === 'failed') {
      label = '等待重试';
      detail = row.reviewReason || '回传失败，将自动重试';
    } else if (row.platformOrderSn) {
      label = '已记录订单，等待发货';
      paid = true;
      detail = known ? '金额本地已记录，后台待物流同步；物流待发货' : '物流待发货';
    }
    return {
      label: label,
      detail: detail,
      paid: paid,
      amountText: amountText,
      amountState: amountState,
      amountSyncText: amountSyncText,
      paymentText: paymentText,
      platformOrderSn: row.platformOrderSn || '',
    };
  }

  function createStore(storage) {
    let chain = Promise.resolve();
    function run(fn) {
      const next = chain.then(fn, fn);
      chain = next.then(function () {}, function () {});
      return next;
    }

    async function load() {
      const data = await storage.get(['m2Purchases', 'm2PurchaseMeta']);
      return {
        purchases: data.m2Purchases || [],
        meta: data.m2PurchaseMeta || { version: 1, migrated: false },
      };
    }

    async function save(state) {
      await storage.set({ m2Purchases: state.purchases, m2PurchaseMeta: state.meta });
    }

    function blank(input) {
      const now = Date.now();
      return {
        purchaseId: 'p_' + now.toString(36) + Math.random().toString(36).slice(2, 8),
        orderSn: input.orderSn || '',
        itemId: input.itemId == null ? '' : input.itemId,
        modelId: input.modelId == null ? '' : input.modelId,
        zhidaOrderId: input.zhidaOrderId || '',
        zhidaItemId: input.zhidaItemId || '',
        quantity: input.quantity || 1,
        itemName: input.itemName || '',
        modelName: input.modelName || '',
        imageUrl: input.imageUrl || '',
        platform: input.platform || 'PINDUODUO',
        productUrl: input.productUrl || '',
        bindingId: input.bindingId || '',
        paymentReceipt: null,
        collection: { stage: 'idle', reason: '', updatedAt: now },
        purchaseIntent: null,
        candidates: [],
        skippedCardFingerprints: [],
        detailHref: '',
        platformOrderSn: null,
        amount: null,
        logistics: [],
        status: 'opened',
        amountSync: 'local',
        logisticsSync: 'none',
        reviewReason: '',
        createdAt: now,
        updatedAt: now,
      };
    }

    function belongsToLine(item, identity) {
      const sameOrderLine = String(item.orderSn || '') === String(identity.orderSn || '')
        && String(item.itemId || '') === String(identity.itemId || '')
        && String(item.modelId || '') === String(identity.modelId || '');
      if (identity.zhidaOrderId && identity.zhidaItemId && item.zhidaOrderId && item.zhidaItemId) {
        return String(item.zhidaOrderId) === String(identity.zhidaOrderId)
          && String(item.zhidaItemId) === String(identity.zhidaItemId);
      }
      if (item.zhidaOrderId && item.zhidaItemId) return false;
      return sameOrderLine;
    }

    function sameIdentity(a, b) {
      return String(a.orderSn || '') === String(b.orderSn || '')
        && String(a.itemId || '') === String(b.itemId || '')
        && String(a.modelId || '') === String(b.modelId || '');
    }

    return {
      refuseListAssignment: function () {
        return { assigned: 0, reason: '不按列表顺序配单' };
      },

      create: function (input) {
        return run(async function () {
          const state = await load();
          const row = blank(input || {});
          state.purchases.push(row);
          await save(state);
          return row;
        });
      },

      get: function (purchaseId) {
        return run(async function () {
          const state = await load();
          return state.purchases.find(function (row) { return row.purchaseId === purchaseId; }) || null;
        });
      },

      list: function () {
        return run(async function () {
          const state = await load();
          return state.purchases.slice();
        });
      },

      findByPlatformOrder: function (platform, platformOrderSn) {
        return run(async function () {
          const state = await load();
          return state.purchases.filter(function (row) {
            return row.platform === platform && row.platformOrderSn === platformOrderSn;
          });
        });
      },

      setPurchaseIntent: function (purchaseId, intent) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row) return null;
          const incoming = intent || {};
          row.purchaseIntent = {
            goodsId: incoming.goodsId || '',
            skuId: incoming.skuId || '',
            quantity: incoming.quantity == null ? null : incoming.quantity,
            mallId: incoming.mallId || '',
            accountId: incoming.accountId || '',
            submittedAt: incoming.submittedAt || Date.now(),
            paidAt: incoming.paidAt || null,
          };
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      markSubmitted: function (purchaseId) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row) return null;
          row.collection = { stage: 'submitted', reason: '', updatedAt: Date.now() };
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      recordPayment: function (purchaseId, result) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row) return { ok: false, error: 'missing' };
          const incoming = result || {};
          if (incoming.status !== 'succeeded') {
            row.collection = {
              stage: incoming.status === 'failed' ? 'payment_failed' : 'payment_pending',
              reason: '',
              updatedAt: Date.now(),
            };
            row.updatedAt = Date.now();
            await save(state);
            return { ok: true, purchase: row };
          }
          if (row.paymentReceipt && row.paymentReceipt.status === 'succeeded' && row.paymentReceipt.amountMinor === incoming.amountMinor) {
            return { ok: true, duplicate: true, purchase: row };
          }
          row.paymentReceipt = {
            status: 'succeeded',
            amountMinor: incoming.amountMinor == null ? null : Number(incoming.amountMinor),
            currency: incoming.currency || 'CNY',
            source: incoming.source || 'alipay-result',
            observedAt: Date.now(),
          };
          if (row.purchaseIntent) row.purchaseIntent.paidAt = Date.now();
          row.collection = { stage: 'awaiting_order_detail', reason: '', updatedAt: Date.now() };
          row.updatedAt = Date.now();
          await save(state);
          return { ok: true, purchase: row };
        });
      },

      reconcilePayment: function (purchaseId) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row) return null;
          const receiptMinor = row.paymentReceipt && row.paymentReceipt.amountMinor;
          const orderMinor = row.amount && row.amount.minor;
          if (receiptMinor == null || orderMinor == null) return row;
          if (Number(receiptMinor) === Number(orderMinor)) {
            row.collection = { stage: 'amount_confirmed', reason: '', updatedAt: Date.now() };
          } else {
            row.collection = { stage: 'needs_review', reason: '支付宝支付金额和订单实付不一致', updatedAt: Date.now() };
            row.reviewReason = row.collection.reason;
          }
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      claimCandidate: function (purchaseId, candidate) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          const sn = candidate && candidate.orderSn;
          if (!row || !sn) return { ok: false, reason: 'missing' };
          const owner = state.purchases.find(function (item) {
            return item.purchaseId !== row.purchaseId && item.platformOrderSn === sn;
          });
          if (owner || (row.platformOrderSn && row.platformOrderSn !== sn)) return { ok: false, reason: 'conflict' };
          row.platform = row.platform || 'PINDUODUO';
          row.platformOrderSn = sn;
          row.detailHref = candidate.detailHref || row.detailHref || '';
          if (row.status === 'opened') row.status = 'recorded';
          row.logisticsSync = row.logisticsSync === 'confirmed' ? 'confirmed' : 'not_shipped';
          row.collection = { stage: 'order_linked', reason: '', updatedAt: Date.now() };
          row.candidates = [];
          row.skippedCardFingerprints = [];
          row.updatedAt = Date.now();
          await save(state);
          return { ok: true, purchase: row };
        });
      },

      saveCandidates: function (purchaseId, candidates, stage, reason, listTarget) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row) return null;
          row.candidates = candidates || [];
          row.collection = {
            stage: stage || 'awaiting_choice',
            reason: reason || '',
            listTarget: listTarget || '',
            updatedAt: Date.now(),
          };
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      skipCard: function (purchaseId, fingerprint) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row || !fingerprint) return row || null;
          const previous = row.skippedCardFingerprints || [];
          row.skippedCardFingerprints = previous.concat([String(fingerprint)]).slice(-10);
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      removeForLine: function (identity) {
        return run(async function () {
          const row = identity || {};
          if (row.ambiguous && !(row.zhidaOrderId && row.zhidaItemId)) {
            return { ok: false, error: '当前订单里有多条相同商品，无法单独清除采购记录。请刷新订单后再试', purchaseIds: [] };
          }
          const state = await load();
          const removed = [];
          state.purchases = state.purchases.filter(function (item) {
            if (!belongsToLine(item, row)) return true;
            removed.push(item.purchaseId);
            return false;
          });
          await save(state);
          return { ok: true, purchaseIds: removed };
        });
      },

      findByShopee: function (current) {
        return run(async function () {
          const state = await load();
          return state.purchases.filter(function (row) { return sameIdentity(row, current || {}); });
        });
      },

      attachPlatformOrder: function (input) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === input.purchaseId; });
          if (!row) return { ok: false, reason: 'missing' };
          const sn = input.platformOrderSn || '';
          const platform = input.platform || row.platform || 'PINDUODUO';
          if (!sn) return { ok: false, reason: 'missing_order_sn' };
          if (row.platformOrderSn && row.platformOrderSn !== sn) {
            row.status = 'needs_review';
            row.reviewReason = '已有采购订单号，不能被另一单覆盖';
            row.updatedAt = Date.now();
            await save(state);
            return { ok: false, reason: 'conflict' };
          }
          const owner = state.purchases.find(function (item) {
            return item.purchaseId !== row.purchaseId && item.platform === platform && item.platformOrderSn === sn;
          });
          if (owner && !sameIdentity(owner, row)) {
            owner.status = 'needs_review';
            row.status = 'needs_review';
            owner.reviewReason = '采购订单号同时对应多笔至达商品，需人工确认';
            row.reviewReason = owner.reviewReason;
            row.updatedAt = Date.now();
            await save(state);
            return { ok: false, reason: 'conflict' };
          }
          row.platform = platform;
          row.platformOrderSn = sn;
          if (row.status === 'opened') row.status = 'recorded';
          row.logisticsSync = row.logisticsSync === 'confirmed' ? 'confirmed' : 'not_shipped';
          row.updatedAt = Date.now();
          await save(state);
          return { ok: true, purchase: row };
        });
      },

      setPaidAmount: function (purchaseId, incoming) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row) return null;
          if (!incoming || incoming.yuan == null || incoming.yuan === '' || Number.isNaN(Number(incoming.yuan))) return row;
          if (incoming.source && incoming.source !== 'paid') return row;
          const minor = yuanToMinor(incoming.yuan);
          if (row.amount && row.amount.minor > 0 && minor === 0) return row;
          row.amount = {
            minor: minor,
            currency: incoming.currency || 'CNY',
            source: 'paid',
            capturedAt: Date.now(),
          };
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      addLogistics: function (purchaseId, entry) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row || !entry || !entry.number) return null;
          const found = row.logistics.find(function (item) { return item.number === entry.number; });
          if (found) found.sync = entry.sync || found.sync;
          else row.logistics.push({ number: entry.number, sync: entry.sync || 'pending', at: Date.now() });
          if (entry.sync === 'confirmed') {
            row.logisticsSync = 'confirmed';
            if (row.amount) row.amountSync = 'confirmed';
            row.status = 'recorded';
          }
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      markSync: function (purchaseId, patch) {
        return run(async function () {
          const state = await load();
          const row = state.purchases.find(function (item) { return item.purchaseId === purchaseId; });
          if (!row) return null;
          ['logisticsSync', 'amountSync', 'status', 'reviewReason'].forEach(function (key) {
            if (patch && patch[key]) row[key] = patch[key];
          });
          row.updatedAt = Date.now();
          await save(state);
          return row;
        });
      },

      migrateLegacy: function () {
        return run(async function () {
          const state = await load();
          if (state.meta.migrated) return { conflicts: state.meta.conflicts || 0, migrated: true };
          const raw = await storage.get(['pendingCollect', 'purchaseRecords']);
          const pending = raw.pendingCollect || [];
          const records = raw.purchaseRecords || {};
          const seen = {};
          let conflicts = 0;

          function addRow(source, sn) {
            const shopee = source.shopeeOrder || source;
            const row = blank({
              orderSn: shopee.orderSn,
              itemId: shopee.itemId,
              modelId: shopee.modelId,
              zhidaOrderId: shopee.zhidaOrderId,
              zhidaItemId: shopee.zhidaItemId,
              quantity: shopee.quantity,
              platform: source.platform || 'PINDUODUO',
              productUrl: source.productUrl || '',
            });
            if (sn) {
              row.platformOrderSn = sn;
              row.status = 'recorded';
              row.logisticsSync = 'not_shipped';
              const key = row.platform + '|' + sn;
              const previous = seen[key];
              if (previous && !sameIdentity(previous, row)) {
                previous.status = 'needs_review';
                row.status = 'needs_review';
                previous.reviewReason = '历史采购订单号冲突，需人工核对';
                row.reviewReason = previous.reviewReason;
                conflicts += 1;
              }
              seen[key] = row;
            }
            const price = source.price;
            if (price != null && price !== '' && !Number.isNaN(Number(price))) {
              row.amount = { minor: yuanToMinor(price), currency: 'CNY', source: 'paid', capturedAt: Date.now() };
            }
            state.purchases.push(row);
          }

          pending.forEach(function (item) { addRow(item, item.platformOrderSn || ''); });
          Object.keys(records).forEach(function (sn) {
            if (seen['PINDUODUO|' + sn] || seen[(records[sn].platform || 'PINDUODUO') + '|' + sn]) return;
            addRow(records[sn], sn);
          });
          state.meta = { version: 1, migrated: true, conflicts: conflicts };
          await save(state);
          return { conflicts: conflicts, migrated: true };
        });
      },
    };
  }

  return { createStore: createStore, describePurchase: describePurchase };
});
