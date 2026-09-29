// 商品级共享绑定，订单商品行级排除。解绑只排除当前行，不删除共享链接。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2BindingStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  function rowKey(identity) {
    const row = identity || {};
    if (row.zhidaOrderId && row.zhidaItemId) {
      return JSON.stringify(['v1', 'zhida-line', String(row.zhidaOrderId), String(row.zhidaItemId)]);
    }
    if (row.orderSn && row.itemId != null && row.itemId !== '') {
      return JSON.stringify(['v1', 'legacy', String(row.orderSn), String(row.itemId), String(row.modelId == null ? '' : row.modelId)]);
    }
    throw new Error('无法确定当前商品行，请刷新订单后再试');
  }

  function asList(raw) {
    if (Array.isArray(raw)) return raw.slice();
    return raw ? [raw] : [];
  }

  function getEffectiveBindings(bindingMap, exclusions, identity) {
    const map = bindingMap || {};
    const list = asList(map[String(identity && identity.itemId)]);
    let key = '';
    try { key = rowKey(identity); } catch (e) { return list; }
    const excluded = ((exclusions || {})[key] && exclusions[key].excludedBindingIds) || [];
    const blocked = {};
    excluded.forEach(function (id) { blocked[id] = true; });
    return list.filter(function (binding) { return binding && !blocked[binding.id]; });
  }

  function createStore(storage) {
    let chain = Promise.resolve();
    function run(fn) {
      const next = chain.then(fn, fn);
      chain = next.then(function () {}, function () {});
      return next;
    }

    async function load() {
      const data = await storage.get(['bindingMap', 'm2BindingExclusions']);
      return {
        bindingMap: data.bindingMap || {},
        exclusions: data.m2BindingExclusions || {},
      };
    }

    async function save(state) {
      await storage.set({ bindingMap: state.bindingMap, m2BindingExclusions: state.exclusions });
    }

    function rejectAmbiguous(identity) {
      if (identity && identity.ambiguous && !(identity.zhidaOrderId && identity.zhidaItemId)) {
        return { ok: false, error: '当前订单里有多条相同商品，无法单独解绑。请刷新订单后再试' };
      }
      return null;
    }

    return {
      read: function () {
        return run(load);
      },

      exclude: function (input) {
        return run(async function () {
          const blocked = rejectAmbiguous(input && input.identity);
          if (blocked) return blocked;
          let key = '';
          try { key = rowKey(input.identity); } catch (error) {
            return { ok: false, error: error.message };
          }
          const state = await load();
          const current = state.exclusions[key] || { excludedBindingIds: [], updatedAt: 0 };
          if (current.excludedBindingIds.indexOf(input.bindingId) === -1) current.excludedBindingIds.push(input.bindingId);
          current.updatedAt = Date.now();
          state.exclusions[key] = current;
          await save(state);
          return { ok: true };
        });
      },

      restore: function (input) {
        return run(async function () {
          let key = '';
          try { key = rowKey(input.identity); } catch (error) {
            return { ok: false, error: error.message };
          }
          const state = await load();
          const current = state.exclusions[key];
          if (current) {
            current.excludedBindingIds = current.excludedBindingIds.filter(function (id) { return id !== input.bindingId; });
            current.updatedAt = Date.now();
          }
          await save(state);
          return { ok: true };
        });
      },

      bind: function (input) {
        return run(async function () {
          const blocked = rejectAmbiguous(input && input.identity);
          if (blocked) return blocked;
          const identity = input.identity || {};
          const incoming = input.binding || {};
          const url = String(incoming.productUrl || '').trim();
          if (!url) return { ok: false, error: '请输入商品链接' };
          let key = '';
          try { key = rowKey(identity); } catch (error) {
            return { ok: false, error: error.message };
          }
          const state = await load();
          const itemKey = String(identity.itemId);
          const list = asList(state.bindingMap[itemKey]);
          const platform = incoming.platform || 'PINDUODUO';
          const same = list.filter(function (binding) {
            return binding && binding.platform === platform && String(binding.productUrl || '').trim() === url;
          });
          if (same.length > 1 && !incoming.id) {
            return { ok: false, error: '有多条相同链接，请先指定要恢复的绑定' };
          }
          if (same.length === 1 || incoming.id) {
            const bindingId = incoming.id || same[0].id;
            const current = state.exclusions[key] || { excludedBindingIds: [], updatedAt: 0 };
            current.excludedBindingIds = current.excludedBindingIds.filter(function (id) { return id !== bindingId; });
            current.updatedAt = Date.now();
            state.exclusions[key] = current;
            state.bindingMap[itemKey] = list;
            await save(state);
            return { ok: true, bindingId: bindingId, restored: true };
          }
          const created = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            productUrl: url,
            platform: platform,
            productName: incoming.productName || '',
            price: incoming.price || 0,
          };
          list.push(created);
          state.bindingMap[itemKey] = list;
          await save(state);
          return { ok: true, bindingId: created.id, restored: false };
        });
      },
    };
  }

  function collectUnboundIdentities(purchases, bindingMap, exclusions) {
    const result = [];
    const seen = {};
    (purchases || []).forEach(function (purchase) {
      const identity = {
        zhidaOrderId: purchase.zhidaOrderId || '',
        zhidaItemId: purchase.zhidaItemId || '',
        orderSn: purchase.orderSn || '',
        itemId: purchase.itemId,
        modelId: purchase.modelId == null ? '' : purchase.modelId,
      };
      let key = purchase.purchaseId || '';
      try { key = rowKey(identity); } catch (e) {}
      if (seen[key]) return;
      seen[key] = true;
      if (!getEffectiveBindings(bindingMap, exclusions, identity).length) result.push(identity);
    });
    return result;
  }

  return { rowKey: rowKey, getEffectiveBindings: getEffectiveBindings, collectUnboundIdentities: collectUnboundIdentities, createStore: createStore };
});
