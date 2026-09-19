(function (exports) {
  var ALPHA = 1;
  var MIN_HIST = 20;
  var MIN_TRANS = 8;
  var MIN_HAZARD = 6;
  var HALF_LIFE = 80;
  var LAMBDA = Math.log(2) / HALF_LIFE;
  var RECENT_N = 24;

  var GROUPS = {
    white: "loaf", milk: "loaf", corn: "loaf", rye: "loaf", pullman: "loaf",
    buttertop: "loaf", chestnut: "loaf", rice: "loaf", ww: "loaf",
    redbean: "sweet", soboro: "sweet", cream: "sweet", twist: "sweet", mocha: "sweet",
    sweetroll: "roll", butterroll: "roll",
    donut: "fry", grissini: "special", bagel: "special", sausage: "special"
  };

  function daysBetween(a, b) {
    var pa = a.split("-").map(Number);
    var pb = b.split("-").map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }

  function yearOf(date) { return String(date || "").slice(0, 4); }

  function examItems(items) {
    return items.filter(function (item) { return !item.skip; });
  }

  function labeled(records, items) {
    var skip = {};
    items.forEach(function (item) { if (item.skip) skip[item.id] = true; });
    return records.filter(function (row) {
      return row.itemId && !skip[row.itemId];
    }).slice().sort(function (a, b) {
      if (a.date === b.date) return (a.session || 0) - (b.session || 0);
      return a.date < b.date ? -1 : 1;
    });
  }

  function priorByDate(records, date) {
    return records.filter(function (row) { return row.date < date; });
  }

  function softmax(scores, temp) {
    temp = temp || 1;
    var max = -Infinity;
    scores.forEach(function (s) { if (s > max) max = s; });
    var exps = scores.map(function (s) { return Math.exp((s - max) / temp); });
    var sum = exps.reduce(function (a, b) { return a + b; }, 0) || 1;
    return exps.map(function (e) { return e / sum; });
  }

  function level(value, cuts) {
    if (value >= cuts[0]) return "높음";
    if (value >= cuts[1]) return "보통";
    return "낮음";
  }

  function countBy(exams) {
    var map = {};
    exams.forEach(function (row) {
      map[row.itemId] = (map[row.itemId] || 0) + 1;
    });
    return map;
  }

  function decayedCount(exams, asOf) {
    var map = {};
    exams.forEach(function (row) {
      var w = Math.exp(-LAMBDA * Math.max(0, daysBetween(row.date, asOf)));
      map[row.itemId] = (map[row.itemId] || 0) + w;
    });
    return map;
  }

  function lastIndex(exams, itemId) {
    var i;
    for (i = exams.length - 1; i >= 0; i--) {
      if (exams[i].itemId === itemId) return i;
    }
    return -1;
  }

  function gapsFor(exams, itemId) {
    var gaps = [];
    var last = -1;
    exams.forEach(function (row, i) {
      if (row.itemId !== itemId) return;
      if (last >= 0) gaps.push(i - last);
      last = i;
    });
    return { gaps: gaps, last: last };
  }

  function hazardAt(exams, itemId, wait, base) {
    var info = gapsFor(exams, itemId);
    var atRisk = 0;
    var event = 0;
    info.gaps.forEach(function (gap) {
      if (gap >= wait) atRisk += 1;
      if (gap === wait) event += 1;
    });
    if (info.last >= 0) {
      var open = exams.length - info.last;
      if (open >= wait) atRisk += 1;
    }
    if (atRisk < MIN_HAZARD) return { p: base, used: false, atRisk: atRisk };
    return {
      p: (event + ALPHA * base) / (atRisk + ALPHA),
      used: true,
      atRisk: atRisk
    };
  }

  function repeatRate(exams) {
    var trials = 0;
    var hits = 0;
    var byRound = {};
    exams.forEach(function (row, i) {
      var key = yearOf(row.date) + ":" + row.session;
      if (!byRound[key]) byRound[key] = [];
      byRound[key].push({ i: i, id: row.itemId });
    });
    Object.keys(byRound).forEach(function (key) {
      var rows = byRound[key];
      var seen = {};
      rows.forEach(function (row, idx) {
        if (seen[row.id]) {
          hits += 1;
          trials += 1;
        } else {
          seen[row.id] = true;
          if (idx < rows.length - 1) trials += 1;
        }
      });
    });
    if (trials < 8) return 0.08;
    return hits / trials;
  }

  function transitions(exams, k) {
    var next = {};
    var from = {};
    var i;
    for (i = 0; i < exams.length - 1; i++) {
      var a = exams[i].itemId;
      var b = exams[i + 1].itemId;
      if (!from[a]) from[a] = 0;
      from[a] += 1;
      if (!next[a]) next[a] = {};
      next[a][b] = (next[a][b] || 0) + 1;
    }
    return { next: next, from: from };
  }

  function oldScore(itemId, exams, date, session) {
    var hits = exams.filter(function (row) { return row.itemId === itemId; });
    var last = hits.length ? hits[hits.length - 1] : null;
    var gap = last ? daysBetween(last.date, date) : null;
    var monthHits = hits.filter(function (row) { return row.date.slice(0, 7) === date.slice(0, 7); }).length;
    var recent30 = hits.filter(function (row) { return daysBetween(row.date, date) <= 30; }).length;
    var roundHits = hits.filter(function (row) {
      return yearOf(row.date) === yearOf(date) && Number(row.session) === Number(session);
    }).length;
    var score = 0;
    if (roundHits === 0) score += 28;
    else score -= roundHits * 12;
    if (gap == null) score += 80;
    else {
      score += Math.min(gap, 120) * 1.2;
      if (gap <= 7) score -= 40;
      else if (gap <= 14) score -= 18;
    }
    if (monthHits === 0) score += 22;
    else score -= monthHits * 10;
    score -= recent30 * 14;
    score += Math.max(0, 8 - hits.length) * 3;
    return score;
  }

  function featureRow(itemId, exams, date, session, ids) {
    var n = exams.length;
    var k = ids.length;
    var counts = countBy(exams);
    var dec = decayedCount(exams, date);
    var decSum = 0;
    ids.forEach(function (id) { decSum += dec[id] || 0; });
    var base = ((counts[itemId] || 0) + ALPHA) / (n + ALPHA * k);
    var decayed = ((dec[itemId] || 0) + ALPHA) / (decSum + ALPHA * k);
    var recent = exams.slice(Math.max(0, n - RECENT_N));
    var recentCounts = countBy(recent);
    var recentP = ((recentCounts[itemId] || 0) + ALPHA * base * k) / (recent.length + ALPHA * k);
    var wait = lastIndex(exams, itemId);
    wait = wait < 0 ? n + 1 : n - wait;
    var haz = hazardAt(exams, itemId, wait, base);
    var inRound = exams.filter(function (row) {
      return yearOf(row.date) === yearOf(date) && Number(row.session) === Number(session) && row.itemId === itemId;
    }).length;
    var rpt = repeatRate(exams);
    var roundP = inRound ? Math.max(0.004, rpt) : base;
    var prev = n ? exams[n - 1].itemId : null;
    var tr = transitions(exams);
    var transP = base;
    var transUsed = false;
    if (prev && (tr.from[prev] || 0) >= MIN_TRANS) {
      var raw = ((tr.next[prev] && tr.next[prev][itemId]) || 0);
      transP = (raw + ALPHA * base) / (tr.from[prev] + ALPHA);
      transUsed = true;
    }
    return {
      base: base,
      decayed: decayed,
      recent: recentP,
      hazard: haz.p,
      hazardUsed: haz.used,
      wait: wait,
      inRound: inRound,
      roundP: roundP,
      transP: transP,
      transUsed: transUsed,
      count: counts[itemId] || 0,
      group: GROUPS[itemId] || ""
    };
  }

  function hybridScore(feat) {
    var s = Math.log(Math.max(feat.decayed, 1e-8));
    s += 1.5 * Math.log(Math.min(feat.wait, 22));
    if (feat.wait <= 5) s += Math.log(0.18);
    if (feat.inRound) s += Math.log(0.28);
    if (feat.transUsed && feat.transP > feat.base * 1.15) {
      s += 0.15 * Math.log(feat.transP / feat.base);
    }
    return s;
  }

  function openerCounts(exams) {
    var firsts = {};
    var seen = {};
    exams.forEach(function (row) {
      var key = yearOf(row.date) + ":" + row.session;
      if (seen[key]) return;
      seen[key] = true;
      firsts[row.itemId] = (firsts[row.itemId] || 0) + 1;
    });
    return firsts;
  }

  function isRoundOpener(exams, date, session) {
    return !exams.some(function (row) {
      return yearOf(row.date) === yearOf(date) && Number(row.session) === Number(session);
    });
  }

  function remainScore(itemId, feat, ctx) {
    if (feat.inRound) return -1e6;
    var score = feat.wait;
    if (ctx.isOpener) score += (ctx.openers[itemId] || 0) * 30;
    return score;
  }

  function logMix(feat, w) {
    function lg(p) { return Math.log(Math.max(p, 1e-8)); }
    return w.base * lg(feat.decayed) +
      w.recent * lg(feat.recent) +
      w.round * lg(feat.roundP) +
      w.trans * lg(feat.transP) +
      w.hazard * lg(feat.hazard);
  }

  function rankBy(exams, date, session, items, mode, w) {
    var ids = examItems(items).map(function (item) { return item.id; });
    var ctx = {
      isOpener: isRoundOpener(exams, date, session),
      openers: openerCounts(exams)
    };
    var rows = examItems(items).map(function (item) {
      var feat = featureRow(item.id, exams, date, session, ids);
      feat.isOpenerDay = ctx.isOpener;
      feat.openerHits = ctx.openers[item.id] || 0;
      var score = mode === "old"
        ? oldScore(item.id, exams, date, session)
        : mode === "freq"
          ? Math.log(feat.base)
          : mode === "recent"
            ? Math.log(feat.recent)
            : mode === "hybrid"
              ? hybridScore(feat)
              : mode === "remain"
                ? remainScore(item.id, feat, ctx)
                : logMix(feat, w);
      return { id: item.id, item: item, score: score, feat: feat };
    });
    if (mode === "remain") {
      var unused = rows.filter(function (row) { return !row.feat.inRound; });
      if (unused.length) rows = unused;
    }
    if (mode !== "old") {
      var probs = softmax(rows.map(function (row) { return row.score; }), mode === "stat" ? 0.85 : 1);
      rows.forEach(function (row, i) { row.prob = probs[i]; });
    } else {
      var max = Math.max.apply(null, rows.map(function (row) { return row.score; }));
      var min = Math.min.apply(null, rows.map(function (row) { return row.score; }));
      rows.forEach(function (row) {
        var rel = max === min ? 1 : (row.score - min) / (max - min);
        row.prob = rel;
      });
      var sum = rows.reduce(function (a, b) { return a + b.prob; }, 0) || 1;
      rows.forEach(function (row) { row.prob = row.prob / sum; });
    }
    return rows.sort(function (a, b) { return b.prob - a.prob; });
  }

  function metricsFrom(ranks, actualId) {
    var idx = -1;
    ranks.forEach(function (row, i) {
      if (row.id === actualId) idx = i;
    });
    var rec = idx < 0 ? 0 : 1 / (idx + 1);
    var p = idx < 0 ? 1e-8 : Math.max(ranks[idx].prob, 1e-8);
    var brier = 0;
    ranks.forEach(function (row) {
      var y = row.id === actualId ? 1 : 0;
      brier += (row.prob - y) * (row.prob - y);
    });
    return {
      top1: idx === 0 ? 1 : 0,
      top3: idx >= 0 && idx < 3 ? 1 : 0,
      top5: idx >= 0 && idx < 5 ? 1 : 0,
      mrr: rec,
      logloss: -Math.log(p),
      brier: brier
    };
  }

  function walkForward(records, items, mode, w) {
    var exams = labeled(records, items);
    var acc = { n: 0, top1: 0, top3: 0, top5: 0, mrr: 0, logloss: 0, brier: 0 };
    var t;
    for (t = MIN_HIST; t < exams.length; t++) {
      var prior = exams.slice(0, t);
      var target = exams[t];
      var ranks = rankBy(prior, target.date, target.session, items, mode, w);
      var m = metricsFrom(ranks, target.itemId);
      acc.n += 1;
      acc.top1 += m.top1;
      acc.top3 += m.top3;
      acc.top5 += m.top5;
      acc.mrr += m.mrr;
      acc.logloss += m.logloss;
      acc.brier += m.brier;
    }
    if (!acc.n) return acc;
    acc.top1 /= acc.n;
    acc.top3 /= acc.n;
    acc.top5 /= acc.n;
    acc.mrr /= acc.n;
    acc.logloss /= acc.n;
    acc.brier /= acc.n;
    return acc;
  }

  var DEFAULT_W = { base: 1, recent: 0.5, round: 0.35, trans: 0.15, hazard: 0.1 };
  var fitted = null;

  function scoreKey(m) {
    return m.top3 * 2 + m.mrr + m.top1 * 0.5 - m.logloss * 0.02;
  }

  function fitWeights(records, items) {
    var exams = labeled(records, items);
    if (exams.length < MIN_HIST + 8) {
      fitted = { w: DEFAULT_W, metrics: null, compared: null, mode: "hybrid" };
      return fitted;
    }
    var hybridM = walkForward(records, items, "hybrid", DEFAULT_W);
    var compared = {
      freq: walkForward(records, items, "freq", DEFAULT_W),
      recent: walkForward(records, items, "recent", DEFAULT_W),
      old: walkForward(records, items, "old", DEFAULT_W),
      hybrid: hybridM,
      remain: walkForward(records, items, "remain", DEFAULT_W)
    };
    fitted = {
      w: { base: 1, recent: 0.3, round: 0.4, trans: 0.15, hazard: 0 },
      metrics: hybridM,
      compared: compared,
      mode: "hybrid"
    };
    return fitted;
  }

  function ensureFit(records, items) {
    if (!fitted) fitWeights(records, items);
    return fitted;
  }

  function reasons(feat, ids) {
    var bases = ids.map(function () { return 0; });
    return {
      base: level(feat.decayed, [0.07, 0.045]),
      recent: level(feat.recent, [0.08, 0.04]),
      site: "보통",
      round: feat.inRound ? "이번 회차 이미 출제" : "이번 회차 잔여",
      gap: "공백 " + feat.wait + "시험",
      opener: feat.isOpenerDay ? ("첫날 단골 " + (feat.openerHits || 0) + "회") : "해당 없음",
      trans: feat.transUsed ? (feat.transP > feat.base * 1.15 ? "약한 상승" : "없음") : "표본 부족"
    };
  }

  function predict(records, items, date, session) {
    var exams = labeled(priorByDate(records, date), items);
    var rows = rankBy(exams, date, session, items, "remain", DEFAULT_W);
    var ids = examItems(items).map(function (item) { return item.id; });
    return rows.map(function (row) {
      return {
        item: row.item,
        id: row.id,
        score: row.score,
        prob: row.prob,
        pct: Math.round(row.prob * 1000) / 10,
        feat: row.feat,
        why: reasons(row.feat, ids)
      };
    });
  }

  function evaluate(records, items) {
    return fitWeights(records, items);
  }

  function resetFit() { fitted = null; }

  exports.examItems = examItems;
  exports.labeled = labeled;
  exports.predict = predict;
  exports.evaluate = evaluate;
  exports.resetFit = resetFit;
  exports.walkForward = walkForward;
  exports.DEFAULT_W = DEFAULT_W;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.BakeryPredict = {}));
