// 物流查询按到期时间轮转。前几笔未发货不会一直占住后面的订单。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.M2SyncQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : {}, function () {
  const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

  function createQueue(storage) {
    let chain = Promise.resolve();
    function run(fn) {
      const next = chain.then(fn, fn);
      chain = next.then(function () {}, function () {});
      return next;
    }

    async function load() {
      const data = await storage.get(['m2SyncTasks']);
      return data.m2SyncTasks || [];
    }

    async function save(tasks) {
      await storage.set({ m2SyncTasks: tasks });
    }

    return {
      schedule: function (task) {
        return run(async function () {
          const tasks = await load();
          const confirmed = tasks.find(function (item) {
            return item.status === 'confirmed'
              && item.purchaseId === task.purchaseId
              && item.kind === task.kind
              && item.trackingNo
              && item.trackingNo === task.trackingNo;
          });
          if (confirmed) return { skipped: true, task: confirmed };
          const existing = tasks.find(function (item) { return item.id === task.id; });
          if (existing) return existing;
          const row = {
            id: task.id,
            purchaseId: task.purchaseId,
            kind: task.kind,
            trackingNo: task.trackingNo || '',
            nextAt: task.nextAt == null ? 0 : task.nextAt,
            attempts: 0,
            status: 'pending',
            lastError: '',
          };
          tasks.push(row);
          await save(tasks);
          return row;
        });
      },

      pick: function (now, limit) {
        return run(async function () {
          const tasks = await load();
          return tasks
            .filter(function (item) {
              return (item.status === 'pending' || item.status === 'retrying') && item.nextAt <= now;
            })
            .sort(function (a, b) {
              return (a.nextAt - b.nextAt) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
            })
            .slice(0, limit || 2);
        });
      },

      defer: function (ids, nextAt) {
        return run(async function () {
          const tasks = await load();
          const wanted = {};
          (ids || []).forEach(function (id) { wanted[id] = true; });
          tasks.forEach(function (item) {
            if (wanted[item.id]) item.nextAt = nextAt;
          });
          await save(tasks);
          return tasks;
        });
      },

      retry: function (id, nextAt, reason) {
        return run(async function () {
          const tasks = await load();
          const task = tasks.find(function (item) { return item.id === id; });
          if (!task || task.status === 'confirmed') return task || null;
          task.status = 'retrying';
          task.nextAt = nextAt;
          task.leaseUntil = 0;
          task.lastError = reason || '';
          await save(tasks);
          return task;
        });
      },

      pause: function (id, reason) {
        return run(async function () {
          const tasks = await load();
          const task = tasks.find(function (item) { return item.id === id; });
          if (!task || task.status === 'confirmed') return task || null;
          task.status = 'paused';
          task.leaseUntil = 0;
          task.lastError = reason || '';
          await save(tasks);
          return task;
        });
      },

      fail: function (id, result, now) {
        return run(async function () {
          const tasks = await load();
          const task = tasks.find(function (item) { return item.id === id; });
          if (!task) return null;
          task.attempts += 1;
          task.lastError = (result && (result.message || result.kind)) || '';
          if (result && result.kind === 'login') {
            task.status = 'paused';
          } else {
            task.status = 'retrying';
            const delay = BACKOFF_MS[Math.min(task.attempts - 1, BACKOFF_MS.length - 1)];
            task.nextAt = now + delay;
          }
          await save(tasks);
          return task;
        });
      },

      requeue: function (id, nextAt) {
        return run(async function () {
          const tasks = await load();
          const task = tasks.find(function (item) { return item.id === id; });
          if (!task) return null;
          task.status = 'pending';
          task.nextAt = nextAt == null ? Date.now() : nextAt;
          task.leaseUntil = 0;
          await save(tasks);
          return task;
        });
      },

      claim: function (ids, now, leaseMs) {
        return run(async function () {
          const tasks = await load();
          const wanted = {};
          (ids || []).forEach(function (id) { wanted[id] = true; });
          tasks.forEach(function (item) {
            if (!wanted[item.id] || (item.status !== 'pending' && item.status !== 'retrying' && item.status !== 'leased')) return;
            item.status = 'leased';
            item.leaseUntil = now + (leaseMs || 60000);
          });
          await save(tasks);
          return tasks;
        });
      },

      releaseExpired: function (now) {
        return run(async function () {
          const tasks = await load();
          tasks.forEach(function (item) {
            if (item.status === 'leased' && (!item.leaseUntil || item.leaseUntil <= now)) item.status = 'pending';
          });
          await save(tasks);
          return tasks;
        });
      },

      dropByPurchaseIds: function (purchaseIds) {
        return run(async function () {
          const wanted = {};
          (purchaseIds || []).forEach(function (id) { wanted[id] = true; });
          const tasks = await load();
          const kept = tasks.filter(function (item) { return !wanted[item.purchaseId]; });
          await save(kept);
          return { removed: tasks.length - kept.length };
        });
      },

      confirm: function (id) {
        return run(async function () {
          const tasks = await load();
          const task = tasks.find(function (item) { return item.id === id; });
          if (!task) return null;
          task.status = 'confirmed';
          await save(tasks);
          return task;
        });
      },
    };
  }

  return { createQueue: createQueue };
});
