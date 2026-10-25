/* YNAB 4 budget engine — reads a .ynab4 budget folder (snapshot + change files)
   and computes balances, category availability and registers.
   Works in the browser (window.YNAB4) and in Node (module.exports). Read-only for now. */
(function (root) {
  'use strict';

  // ---------- knowledge / versions ----------
  function parseKnowledge(s) {
    var k = {};
    if (!s) return k;
    String(s).split(',').forEach(function (p) {
      var m = /^\s*([A-Za-z]+)-(\d+)\s*$/.exec(p);
      if (m) k[m[1]] = Math.max(k[m[1]] || 0, +m[2]);
    });
    return k;
  }
  function knowledgeToString(k) {
    return Object.keys(k).sort().map(function (d) { return d + '-' + k[d]; }).join(',');
  }
  function parseVersion(v) {
    var m = /^([A-Za-z]+)-(\d+)$/.exec(v || '');
    return m ? { dev: m[1], n: +m[2] } : null;
  }
  function knows(k, v) { var p = parseVersion(v); return !!p && (k[p.dev] || 0) >= p.n; }
  function kSum(k) { var s = 0; for (var d in k) s += k[d]; return s; }

  // ---------- flatten / rebuild ----------
  // The snapshot nests children (subCategories, subTransactions, monthlySubCategoryBudgets).
  // Change files carry every entity flat, so we keep one flat map keyed by entityId.
  var CHILD_KEYS = {
    masterCategory: ['subCategories', 'masterCategoryId'],
    transaction: ['subTransactions', 'parentTransactionId'],
    monthlyBudget: ['monthlySubCategoryBudgets', 'parentMonthlyBudgetId'],
    payee: ['renameConditions', 'parentPayeeId']
  };
  var TOP_LISTS = ['masterCategories', 'transactions', 'accounts', 'payees', 'monthlyBudgets', 'scheduledTransactions', 'accountMappings'];

  function flatten(full) {
    var map = new Map();
    function put(e, parentId, parentKey) {
      var copy = Object.assign({}, e);
      var ck = CHILD_KEYS[e.entityType];
      if (ck) {
        var kids = e[ck[0]] || [];
        delete copy[ck[0]];
        kids.forEach(function (c) { put(c, e.entityId, ck[1]); });
      }
      if (parentId && !copy[parentKey]) copy[parentKey] = parentId;
      map.set(copy.entityId, copy);
    }
    TOP_LISTS.forEach(function (key) { (full[key] || []).forEach(function (e) { put(e); }); });
    if (full.budgetMetaData) map.set(full.budgetMetaData.entityId, Object.assign({}, full.budgetMetaData));
    return map;
  }

  function applyItem(map, item) {
    var cur = map.get(item.entityId);
    if (cur && cur.entityVersion && item.entityVersion) {
      var a = parseVersion(cur.entityVersion), b = parseVersion(item.entityVersion);
      // same device: only move forward. different device: later file wins (files are applied in order).
      if (a && b && a.dev === b.dev && b.n < a.n) return;
    }
    var copy = Object.assign({}, item);
    var ck = CHILD_KEYS[item.entityType];
    if (ck && Array.isArray(item[ck[0]])) {
      item[ck[0]].forEach(function (c) {
        var cc = Object.assign({}, c);
        if (!cc[ck[1]]) cc[ck[1]] = item.entityId;
        applyItem(map, cc);
      });
      delete copy[ck[0]];
    }
    map.set(item.entityId, copy);
  }

  // ---------- loading ----------
  // io: { readText(relPath) -> Promise<string>, list(relDir) -> Promise<string[]> }  (paths relative to the .ynab4 folder)
  async function load(io, opts) {
    opts = opts || {};
    var meta = JSON.parse(await io.readText('Budget.ymeta'));
    var dataDir = meta.relativeDataFolderName;
    var devFiles = (await io.list(dataDir + '/devices')).filter(function (n) { return /\.ydevice$/.test(n); });
    var devices = [];
    for (var i = 0; i < devFiles.length; i++) {
      var d = JSON.parse(await io.readText(dataDir + '/devices/' + devFiles[i]));
      d.knowledgeObj = parseKnowledge(d.knowledge);
      d.fullKnowledgeObj = parseKnowledge(d.knowledgeInFullBudgetFile);
      devices.push(d);
    }
    // newest snapshot = device whose full file knows the most
    var withFull = devices.filter(function (d) { return d.knowledgeInFullBudgetFile; });
    withFull.sort(function (a, b) { return kSum(b.fullKnowledgeObj) - kSum(a.fullKnowledgeObj); });
    var base = withFull[0];
    if (!base) throw new Error('No device in this budget has a full snapshot.');
    var full = JSON.parse(await io.readText(dataDir + '/' + base.deviceGUID + '/Budget.yfull'));
    var known = parseKnowledge((full.fileMetaData || {}).currentKnowledge || base.knowledgeInFullBudgetFile);
    var map = flatten(full);

    // collect change files not yet covered by the snapshot, from every device folder
    var diffs = [];
    for (var j = 0; j < devices.length; j++) {
      var dev = devices[j];
      var names;
      try { names = (await io.list(dataDir + '/' + dev.deviceGUID)) || []; } catch (e) { names = []; }
      names.forEach(function (n) {
        var m = /^(.*)_(.*)\.ydiff$/.exec(n);
        if (!m) return;
        var end = parseKnowledge(m[2]);
        var news = Object.keys(end).some(function (d) { return end[d] > (known[d] || 0); });
        if (news) diffs.push({ dir: dev.deviceGUID, name: n, start: parseKnowledge(m[1]), end: end });
      });
    }
    // apply in causal order: a file whose start knowledge is covered goes first
    diffs.sort(function (a, b) { return kSum(a.end) - kSum(b.end); });
    var applied = [];
    for (var x = 0; x < diffs.length; x++) {
      var df = diffs[x];
      var body = JSON.parse(await io.readText(dataDir + '/' + df.dir + '/' + df.name));
      (body.items || []).forEach(function (it) { applyItem(map, it); });
      Object.keys(df.end).forEach(function (d) { known[d] = Math.max(known[d] || 0, df.end[d]); });
      applied.push(df.name);
    }
    // extra local (phone) items, e.g. not-yet-synced entries
    (opts.extraItems || []).forEach(function (it) { applyItem(map, it); });

    return new Budget(map, { meta: meta, devices: devices, base: base.shortDeviceId, knowledge: known, appliedDiffs: applied });
  }

  // ---------- model ----------
  function Budget(map, info) {
    this.map = map;
    this.info = info;
    this._index();
  }
  Budget.prototype._index = function () {
    var acc = [], mcs = [], scs = [], tx = [], sub = [], pay = [], mbs = [], mcbs = [];
    this.map.forEach(function (e) {
      if (e.isTombstone) return;
      switch (e.entityType) {
        case 'account': acc.push(e); break;
        case 'masterCategory': mcs.push(e); break;
        case 'category': scs.push(e); break;
        case 'transaction': tx.push(e); break;
        case 'subTransaction': sub.push(e); break;
        case 'payee': pay.push(e); break;
        case 'monthlyBudget': mbs.push(e); break;
        case 'monthlyCategoryBudget': mcbs.push(e); break;
      }
    });
    var byId = function (arr) { var m = {}; arr.forEach(function (e) { m[e.entityId] = e; }); return m; };
    this.accounts = acc.sort(function (a, b) { return a.sortableIndex - b.sortableIndex; });
    this.accountById = byId(acc);
    this.payeeById = byId(pay);
    this.masterCategories = mcs.sort(function (a, b) { return a.sortableIndex - b.sortableIndex; });
    this.categoryById = byId(scs);
    var subsByParent = {};
    sub.forEach(function (s) { (subsByParent[s.parentTransactionId] = subsByParent[s.parentTransactionId] || []).push(s); });
    this.subsByParent = subsByParent;
    this.transactions = tx;
    this.categoriesByMaster = {};
    var self = this;
    scs.forEach(function (c) { (self.categoriesByMaster[c.masterCategoryId] = self.categoriesByMaster[c.masterCategoryId] || []).push(c); });
    Object.keys(this.categoriesByMaster).forEach(function (k) { self.categoriesByMaster[k].sort(function (a, b) { return a.sortableIndex - b.sortableIndex; }); });

    // budgeted amounts per month/category
    var mbMonth = {};
    mbs.forEach(function (mb) { mbMonth[mb.entityId] = mb.entityId.replace(/^MB\//, ''); });
    var budgeted = {}, handling = {};
    mcbs.forEach(function (c) {
      var month = mbMonth[c.parentMonthlyBudgetId] || (c.parentMonthlyBudgetId || '').replace(/^MB\//, '');
      if (!month) return;
      var key = month + '|' + c.categoryId;
      budgeted[key] = (budgeted[key] || 0) + (c.budgeted || 0);
      if (c.overspendingHandling) handling[key] = c.overspendingHandling;
    });
    this.budgeted = budgeted; this.handling = handling;

    // activity per month/category (on-budget accounts only)
    var activity = {}, income = {}, months = {};
    tx.forEach(function (t) {
      var a = self.accountById[t.accountId];
      if (!a || !a.onBudget) return;
      var month = (t.date || '').slice(0, 7);
      months[month] = 1;
      var parts = t.categoryId === 'Category/__Split__' ? (subsByParent[t.entityId] || []) : [t];
      parts.forEach(function (p) {
        var cid = p.categoryId;
        if (cid === 'Category/__ImmediateIncome__') { income[month] = (income[month] || 0) + p.amount; return; }
        if (cid === 'Category/__DeferredIncome__') { var nm = addMonths(month, 1); income[nm] = (income[nm] || 0) + p.amount; months[nm] = 1; return; }
        if (!cid || !self.categoryById[cid]) return;
        var key = month + '|' + cid;
        activity[key] = (activity[key] || 0) + p.amount;
      });
    });
    Object.keys(budgeted).forEach(function (k) { months[k.split('|')[0]] = 1; });
    this.activity = activity; this.income = income;
    this.months = Object.keys(months).filter(Boolean).sort();
    this._avail = null;
  };

  function addMonths(m, n) {
    var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + n;
    y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
    return y + '-' + String(mo + 1).padStart(2, '0');
  }

  Budget.prototype._computeAvailable = function () {
    if (this._avail) return this._avail;
    var self = this, avail = {}, overspent = {};
    Object.keys(this.categoryById).forEach(function (cid) {
      var prev = 0, confined = false;
      self.months.forEach(function (m) {
        var key = m + '|' + cid;
        if (self.handling[key]) confined = self.handling[key] === 'Confined';
        var start = prev;
        if (prev < 0 && !confined) { overspent[m] = (overspent[m] || 0) + prev; start = 0; }
        prev = start + (self.budgeted[key] || 0) + (self.activity[key] || 0);
        avail[key] = prev;
      });
    });
    this._avail = { avail: avail, overspentCarried: overspent };
    return this._avail;
  };

  // --- public queries ---
  Budget.prototype.accountBalances = function (asOf) {
    var self = this, res = {};
    this.accounts.forEach(function (a) { res[a.entityId] = { cleared: 0, uncleared: 0, working: 0 }; });
    this.transactions.forEach(function (t) {
      var r = res[t.accountId]; if (!r) return;
      if (asOf && t.date > asOf) { /* future-dated still counts in YNAB 4 working balance */ }
      r.working += t.amount;
      if (t.cleared === 'Uncleared') r.uncleared += t.amount; else r.cleared += t.amount;
    });
    return this.accounts.filter(function (a) { return !a.hidden; }).map(function (a) {
      return Object.assign({ id: a.entityId, name: a.accountName, type: a.accountType, onBudget: !!a.onBudget, hidden: !!a.hidden }, res[a.entityId]);
    });
  };

  Budget.prototype.totals = function () {
    var on = 0, off = 0;
    this.accountBalances().forEach(function (a) { if (a.onBudget) on += a.working; else off += a.working; });
    return { onBudget: on, offBudget: off, all: on + off };
  };

  Budget.prototype.month = function (m) {
    var self = this, A = this._computeAvailable().avail, groups = [];
    var totalAvail = 0, totalBudgeted = 0;
    this.masterCategories.forEach(function (mc) {
      if (mc.entityId === 'MasterCategory/__Hidden__') return;
      var cats = (self.categoriesByMaster[mc.entityId] || []).filter(function (c) { return !c.isTombstone; }).map(function (c) {
        var key = m + '|' + c.entityId;
        var row = { id: c.entityId, name: c.name, budgeted: self.budgeted[key] || 0, activity: self.activity[key] || 0, available: lastAvail(self, c.entityId, m, A) };
        totalAvail += row.available; totalBudgeted += row.budgeted;
        return row;
      });
      groups.push({ id: mc.entityId, name: mc.name, categories: cats });
    });
    // Available to Budget (current-month view): on-budget cash minus money held in categories and budgeted in future months
    var futureBudgeted = 0;
    Object.keys(this.budgeted).forEach(function (k) { if (k.split('|')[0] > m) futureBudgeted += self.budgeted[k]; });
    // hidden categories still hold money
    var hiddenAvail = 0;
    var hiddenMc = this.categoriesByMaster['MasterCategory/__Hidden__'] || [];
    hiddenMc.forEach(function (c) { hiddenAvail += lastAvail(self, c.entityId, m, A); });
    // cash = Available to Budget + money in categories (overspent ones count negative this month) + budgeted in future months
    var atb = this.totals().onBudget - totalAvail - hiddenAvail - futureBudgeted;
    return { month: m, groups: groups, budgeted: totalBudgeted, available: totalAvail, futureBudgeted: futureBudgeted, availableToBudget: atb };
  };
  function lastAvail(self, cid, m, A) {
    var key = m + '|' + cid;
    if (key in A) return A[key];
    // month after the last activity: carry the latest known balance forward
    var best = 0;
    for (var i = self.months.length - 1; i >= 0; i--) {
      if (self.months[i] <= m && (self.months[i] + '|' + cid) in A) { best = A[self.months[i] + '|' + cid]; break; }
    }
    return best < 0 ? 0 : best;
  }

  Budget.prototype.register = function (accountId, limit) {
    var self = this;
    var rows = this.transactions.filter(function (t) { return t.accountId === accountId; });
    rows.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    if (limit) rows = rows.slice(0, limit);
    return rows.map(function (t) {
      var p = self.payeeById[t.payeeId];
      var cat;
      if (t.categoryId === 'Category/__Split__') cat = 'Split (' + (self.subsByParent[t.entityId] || []).length + ')';
      else if (t.categoryId === 'Category/__ImmediateIncome__') cat = 'Income';
      else if (t.categoryId === 'Category/__DeferredIncome__') cat = 'Income next month';
      else if (self.categoryById[t.categoryId]) cat = self.categoryById[t.categoryId].name;
      else cat = t.transferTransactionId ? 'Transfer' : '';
      return { id: t.entityId, date: t.date, payee: p ? p.name : '', category: cat, memo: t.memo || '', amount: t.amount, cleared: t.cleared, flag: t.flag || null };
    });
  };

  Budget.prototype.currentMonth = function (today) {
    var d = today || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };

  var api = { load: load, parseKnowledge: parseKnowledge, knowledgeToString: knowledgeToString, knows: knows, flatten: flatten, Budget: Budget, addMonths: addMonths };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YNAB4 = api;
})(typeof window !== 'undefined' ? window : globalThis);
