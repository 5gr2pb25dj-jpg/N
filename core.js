"use strict";
/* ============================================================
   計算の中核

   画面に触らない部分だけをここに置いてある。selftest.html から
   同じものを読み込んで検算できるようにするのが目的。
   モジュールにはしていない（ビルド工程を増やさないため）。
   index.html より先に読み込むこと。
   ============================================================ */

const STATUS = {
  running:    { label: "稼働中",   color: "var(--st-running)" },
  changeover: { label: "段取り中", color: "var(--st-changeover)" },
  stopped:    { label: "停止",     color: "var(--st-stopped)" },
  idle:       { label: "計画停止", color: "var(--st-idle)" },
};

// 表・中・裏の糸。key はデータ上のフィールド名
const YARNS = [
  { key: "f", label: "表", color: "var(--yarn-f)" },
  { key: "m", label: "中", color: "var(--yarn-m)" },
  { key: "b", label: "裏", color: "var(--yarn-b)" },
];

const DEFAULT_LOSS = 3;

// 日平均を出すときの重みの半減期（稼働日数）。
// 直近ほど重く見る。7なら「7稼働日前の実績は半分の重み」。
const PACE_HALFLIFE = 7;
// 何稼働日ぶんまでさかのぼるか
const PACE_WINDOW = 30;

/* ============================================================
   ユーティリティ
   ============================================================ */
function uid() {
  return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmt(n, digits = 2) {
  return num(n).toFixed(digits);
}

function todayStr() {
  const d = new Date();
  const p = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// "YYYY-MM-DD" を Date に。無効なら null
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  const d = new Date(y, mo - 1, day);
  if (isNaN(d)) return null;
  // 13月や2月30日を Date は黙って繰り上げる。打ち間違いが
  // 別の日として通ってしまうので、入力と一致するか確かめる。
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return d;
}

function toDateStr(d) {
  const p = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  if (!d) return "";
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

// a から b までの日数（b − a）
function diffDays(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return null;
  return Math.round((db - da) / 86400000);
}

function mdLabel(dateStr) {
  const d = parseDate(dateStr);
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : "";
}

// 号機番号の自然順ソート（"2" < "10"）
function compareNo(a, b) {
  return String(a.no).localeCompare(String(b.no), "ja", { numeric: true });
}

// 次回予定日までの日数（今日=0）。無効な日付は null
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = parseDate(dateStr);
  if (!target) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function dueText(days) {
  if (days === null) return "";
  if (days < 0) return `予定 ${-days}日超過`;
  if (days === 0) return "予定 今日";
  return `予定 あと${days}日`;
}

/* ============================================================
   番手

   在庫台帳のキーになる。全角で打っても半角と同じ山を指すように
   そろえる。そろえないと「３０／１」と「30/1」が別の糸になる。
   ============================================================ */
function countKey(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[／]/g, "/")
    .replace(/[－ー―]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
}

/* ============================================================
   永続化（旧スキーマのデータも読めるように正規化する）
   ============================================================ */
// 1件のオーダー（品番・反数・重量・期間・糸の設定）を整える
function normalizeOrder(o) {
  o = o || {};
  const r = o.ratio || {};
  const c = o.counts || {};
  const oh = o.onHand || {};
  const pu = o.purchased || {};
  const rolls = Math.max(0, Math.round(num(o.rolls)));
  const weightPerRoll = Math.max(0, num(o.weightPerRoll));
  return {
    sku: o.sku || "",
    rolls,
    weightPerRoll,
    totalKg: rolls * weightPerRoll,
    startDate: o.startDate || "",
    endDate: o.endDate || "",
    lossPct: o.lossPct == null ? DEFAULT_LOSS : Math.max(0, num(o.lossPct)),
    ratio: { f: Math.max(0, num(r.f)), m: Math.max(0, num(r.m)), b: Math.max(0, num(r.b)) },
    counts: { f: String(c.f ?? ""), m: String(c.m ?? ""), b: String(c.b ?? "") },
    // onHand は在庫台帳に移した。読み込んだ値は移行のためだけに残す。
    onHand: { f: Math.max(0, num(oh.f)), m: Math.max(0, num(oh.m)), b: Math.max(0, num(oh.b)) },
    purchased: { f: Math.max(0, num(pu.f)), m: Math.max(0, num(pu.m)), b: Math.max(0, num(pu.b)) },
  };
}

function normalize(m) {
  const r = m.ratio || {};
  const c = m.counts || {};
  const h = m.onHand || {};
  const pc = m.purchased || {};

  // 合計生産量は「1反あたりの重量 × 反数」で決まる。
  // 重量を持たない旧データは、合計生産量から重量を逆算して移行する。
  const rolls = Math.max(0, Math.round(num(m.rolls)));
  let weightPerRoll = Math.max(0, num(m.weightPerRoll));
  let totalKg = Math.max(0, num(m.totalKg));
  if (weightPerRoll > 0) {
    totalKg = rolls * weightPerRoll;
  } else if (totalKg > 0 && rolls > 0) {
    weightPerRoll = totalKg / rolls;
  }

  // 水揚げは反数で管理し、kg は重量から導く。
  // 反数を持たない旧データは、水揚げkgから反数を逆算する。
  let producedRolls = 0;
  let producedKg = Math.max(0, num(m.producedKg));
  if (weightPerRoll > 0) {
    producedRolls = m.producedRolls != null
      ? num(m.producedRolls)
      : producedKg / weightPerRoll;
    producedRolls = Math.max(0, Math.min(rolls, producedRolls));
    producedKg = producedRolls * weightPerRoll;
  }

  // 履歴も反数に統一する
  const log = (Array.isArray(m.log) ? m.log : [])
    .filter(e => e && e.d)
    .map(e => ({
      d: String(e.d),
      rolls: e.rolls != null
        ? Math.max(0, num(e.rolls))
        : (weightPerRoll > 0 ? Math.max(0, num(e.kg)) / weightPerRoll : 0),
    }));

  return {
    id: m.id || uid(),
    no: String(m.no ?? ""),
    model: m.model || "",
    status: STATUS[m.status] ? m.status : "idle",
    sku: m.sku || "",
    group: String(m.group ?? "").trim(),
    uptime: Math.max(0, Math.min(100, Math.round(num(m.uptime)))),
    startDate: m.startDate || "",
    nextChange: m.nextChange || "",
    note: m.note || "",
    rolls,
    weightPerRoll,
    totalKg,
    producedRolls,
    producedKg,
    lossPct: m.lossPct == null ? DEFAULT_LOSS : Math.max(0, num(m.lossPct)),
    ratio: { f: Math.max(0, num(r.f)), m: Math.max(0, num(r.m)), b: Math.max(0, num(r.b)) },
    // onHand は在庫台帳に移した。読み込んだ値は移行のためだけに残す。
    onHand: { f: Math.max(0, num(h.f)), m: Math.max(0, num(h.m)), b: Math.max(0, num(h.b)) },
    purchased: { f: Math.max(0, num(pc.f)), m: Math.max(0, num(pc.m)), b: Math.max(0, num(pc.b)) },
    counts: { f: String(c.f ?? ""), m: String(c.m ?? ""), b: String(c.b ?? "") },
    next: normalizeOrder(m.next),
    history: Array.isArray(m.history) ? m.history : [],
    log,
  };
}

/* ============================================================
   在庫台帳

   糸は倉庫にあるものであって号機のものではない。だから在庫は
   号機ではなく「番手」に紐づける。同じ番手を何台で使っていても
   引き算の相手は1つ。
   ============================================================ */
function normalizeStock(s) {
  const out = {};
  if (!s || typeof s !== "object") return out;
  for (const [k, v] of Object.entries(s)) {
    const key = countKey(k);
    if (!key) continue;
    const kg = Math.max(0, num(v && typeof v === "object" ? v.kg : v));
    const label = (v && typeof v === "object" && v.label) ? String(v.label) : String(k);
    const updatedAt = (v && typeof v === "object" && v.updatedAt) ? String(v.updatedAt) : "";
    // 同じキーに落ちる表記ゆれがあれば多いほうを採る
    if (out[key] && out[key].kg >= kg) continue;
    out[key] = { label, kg, updatedAt };
  }
  return out;
}

// 号機ごとに散っていた現在の糸量を、番手ごとの1つの台帳にまとめる。
// 同じ番手に複数の値があるとき、足すと二重に数えることになるので
// 最大値を採る。食い違っていた番手は conflicts に入れて画面で知らせる。
function stockFromMachines(machines) {
  const seen = new Map();   // key -> { label, values:[{no, kg}] }
  const take = (o, no, label) => {
    for (const y of YARNS) {
      const key = countKey(o.counts[y.key]);
      if (!key) continue;
      const kg = Math.max(0, num(o.onHand[y.key]));
      if (kg <= 0) continue;
      let e = seen.get(key);
      if (!e) { e = { label: String(o.counts[y.key]).trim(), values: [] }; seen.set(key, e); }
      e.values.push({ no: `${no}${label}`, kg });
    }
  };
  for (const m of machines) {
    take(m, m.no, "");
    take(m.next, m.no, "（次）");
  }

  const stock = {};
  const conflicts = [];
  const today = todayStr();
  for (const [key, e] of seen) {
    const kgs = e.values.map(v => v.kg);
    const max = Math.max(...kgs);
    const min = Math.min(...kgs);
    stock[key] = { label: e.label, kg: max, updatedAt: today };
    if (e.values.length > 1 && max - min > 0.005) {
      conflicts.push({ key, label: e.label, adopted: max, values: e.values.slice() });
    }
  }
  return { stock, conflicts };
}

function stockKg(stock, count) {
  const key = countKey(count);
  if (!key) return 0;
  const e = stock ? stock[key] : null;
  return e ? Math.max(0, num(e.kg)) : 0;
}

function stockHas(stock, count) {
  const key = countKey(count);
  return !!(key && stock && Object.prototype.hasOwnProperty.call(stock, key));
}

/* ============================================================
   計算
   原糸必要量 = 対象生産量(kg) × 交編率(%) × (1 + ロス率(%))
   「残り必要量」は編残（合計生産量 − 水揚げ累計）を基準にする
   在庫は号機ではなく番手ごとの台帳から引く
   ============================================================ */
function yarnNeed(totalKg, remainKg, ratio, lossPct) {
  const lossFactor = 1 + num(lossPct) / 100;
  const need = {};
  for (const y of YARNS) {
    const r = num(ratio[y.key]) / 100;
    need[y.key] = {
      all: totalKg * r * lossFactor,
      rest: remainKg * r * lossFactor,
    };
  }
  return need;
}

// 直近ほど重く見た1日あたりの反数。
// 単純平均だと立ち上がりの遅さをいつまでも引きずるため。
function paceFrom(log) {
  const byDay = new Map();
  for (const e of log || []) {
    if (!e || !e.d) continue;
    byDay.set(e.d, num(byDay.get(e.d)) + Math.max(0, num(e.rolls)));
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  if (days.length === 0) return { perDay: 0, workedDays: 0, basisDays: 0 };

  let wsum = 0, vsum = 0, used = 0;
  for (let i = 0; i < days.length && i < PACE_WINDOW; i++) {
    const w = Math.pow(0.5, i / PACE_HALFLIFE);
    wsum += w;
    vsum += w * days[i][1];
    used++;
  }
  return {
    perDay: wsum > 0 ? vsum / wsum : 0,
    workedDays: days.length,
    basisDays: used,
  };
}

function calcFor(m, stock) {
  const total = Math.max(0, num(m.totalKg));
  const produced = Math.max(0, Math.min(total, num(m.producedKg)));
  const remaining = Math.max(0, total - produced);

  const need = yarnNeed(total, remaining, m.ratio, m.lossPct);

  const rolls = Math.max(0, num(m.rolls));
  const producedRolls = Math.max(0, Math.min(rolls, num(m.producedRolls)));
  const remainRolls = Math.max(0, rolls - producedRolls);

  const pace = paceFrom(m.log);
  const perDay = pace.perDay;

  // 現在のペースで残りを消化しきる日
  let projected = "";
  let daysLeft = null;
  if (perDay > 0 && remainRolls > 0) {
    daysLeft = Math.ceil(remainRolls / perDay);
    projected = addDays(todayStr(), daysLeft);
  } else if (remainRolls === 0 && rolls > 0) {
    daysLeft = 0;
    projected = todayStr();
  }

  // 予定日に対する遅れ（＋なら遅れ、−なら前倒し）
  const delay = (projected && m.nextChange)
    ? diffDays(m.nextChange, projected)
    : null;

  // 今ある糸で何反編めるか。1反あたりの消費量から逆算する。
  // 在庫は番手ごとの台帳から引くので、同じ糸を使う号機とは同じ山を見る。
  const perRoll = {};
  const knitBy = {};
  const unbound = [];        // 交編率はあるのに番手が未設定の糸
  let knittable = null;
  const lossF = 1 + num(m.lossPct) / 100;
  for (const y of YARNS) {
    const r = num(m.ratio[y.key]) / 100;
    const use = num(m.weightPerRoll) * r * lossF; // 1反あたりの消費量
    perRoll[y.key] = use;
    if (use <= 0) { knitBy[y.key] = null; continue; }
    const cnt = m.counts[y.key];
    if (!countKey(cnt)) { knitBy[y.key] = null; unbound.push(y.label); continue; }
    const n2 = stockKg(stock, cnt) / use;
    knitBy[y.key] = n2;
    knittable = knittable === null ? n2 : Math.min(knittable, n2);
  }

  return {
    total,
    produced,
    remaining,
    rolls,
    producedRolls,
    remainRolls,
    perDay,
    workedDays: pace.workedDays,
    paceBasisDays: pace.basisDays,
    perRoll,
    knitBy,
    knittable: knittable === null ? null : Math.floor(knittable),
    unbound,
    projected,
    daysLeft,
    delay,
    progress: rolls > 0 ? (producedRolls / rolls) * 100 : 0,
    need,
    ratioSum: YARNS.reduce((s, y) => s + num(m.ratio[y.key]), 0),
  };
}

/* ============================================================
   番手ごとの集計（実際に糸を手配する単位）
   ============================================================ */
function aggregateByCount(machines, stock) {
  const map = new Map();

  const add = (o, no, totalKg, restKg, label) => {
    const nd = yarnNeed(totalKg, restKg, o.ratio, o.lossPct);
    for (const y of YARNS) {
      const raw = (o.counts[y.key] || "").trim();
      const key = countKey(raw);
      if (!key) continue;
      if (num(o.ratio[y.key]) <= 0) continue; // 使っていない糸は数えない
      let e = map.get(key);
      if (!e) {
        e = { key, count: raw, all: 0, rest: 0,
              users: new Set(), positions: new Set(), orders: 0 };
        map.set(key, e);
      }
      e.all += nd[y.key].all;
      e.rest += nd[y.key].rest;
      e.orders++;
      e.positions.add(y.label);
      e.users.add(`${no}${label} ${o.sku || "品番未設定"}`);
    }
  };

  for (const m of machines) {
    const c = calcFor(m, stock);
    add(m, m.no, c.total, c.remaining, "");
    add(m.next, m.no, m.next.totalKg, m.next.totalKg, "（次）");
  }

  // 台帳にあるのに今どこでも使っていない番手も、残として見せる
  for (const [key, e] of Object.entries(stock || {})) {
    if (map.has(key)) continue;
    if (num(e.kg) <= 0) continue;
    map.set(key, { key, count: e.label || key, all: 0, rest: 0,
                   users: new Set(), positions: new Set(), orders: 0 });
  }

  const list = [...map.values()].map(e => {
    const onHand = stockKg(stock, e.key);
    return { ...e, onHand, known: stockHas(stock, e.key), gap: onHand - e.rest };
  });

  // 不足の大きい番手を先に出す
  return list.sort((a, b) => {
    if (a.gap !== b.gap) return a.gap - b.gap;
    return a.count.localeCompare(b.count, "ja", { numeric: true });
  });
}

/* ============================================================
   品番・案件ごとの集計（必要量だけ。在庫は番手が持つ）
   ============================================================ */
function aggregateBySku(machines, stock) {
  const map = new Map();

  const entry = (key, isGroup) => {
    let e = map.get(key);
    if (!e) {
      e = {
        name: key, isGroup,
        skus: new Set(),
        current: [], next: [],
        rolls: 0, doneRolls: 0, totalKg: 0, restKg: 0,
        need: {}, counts: {}, ratioWarn: [],
      };
      for (const y of YARNS) {
        e.need[y.key] = { all: 0, rest: 0 };
        e.counts[y.key] = new Set();
      }
      map.set(key, e);
    }
    return e;
  };

  // 案件が付いていればそれを単位にする。同じ品番のサイズ違い（口径違い）を
  // 案件でまとめておけば、糸はまとめて計算される。
  const add = (sku, o, kind, no, rolls, doneRolls, totalKg, restKg, group) => {
    const g = (group || "").trim();
    // 品番も反数も無いオーダー（未入力の「次」など）は数えない
    if (!sku && !(rolls > 0)) return;
    if (!sku && !g) return;
    const e = entry(g || sku, !!g);
    if (sku) e.skus.add(sku);
    e[kind].push(no);
    e.rolls += rolls;
    e.doneRolls += doneRolls;
    e.totalKg += totalKg;
    e.restKg += restKg;
    const nd = yarnNeed(totalKg, restKg, o.ratio, o.lossPct);
    const sum = YARNS.reduce((s, y) => s + num(o.ratio[y.key]), 0);
    if (sum > 0 && Math.abs(sum - 100) > 0.05) {
      e.ratioWarn.push({ no: `${no}${kind === "next" ? "（次）" : ""}`, sum });
    }
    for (const y of YARNS) {
      e.need[y.key].all += nd[y.key].all;
      e.need[y.key].rest += nd[y.key].rest;
      const c = (o.counts[y.key] || "").trim();
      if (c) e.counts[y.key].add(c);
    }
  };

  for (const m of machines) {
    const c = calcFor(m, stock);
    // 進行中のオーダー
    add(m.sku, m, "current", m.no, m.rolls, c.producedRolls, c.total, c.remaining, m.group);
    // 次のオーダー（未着手なので残り＝全体）
    const n = m.next;
    add(n.sku, n, "next", m.no, n.rolls, 0, n.totalKg, n.totalKg, m.group);
  }

  // 必要量の大きい品番を先に出す
  return [...map.values()].sort((a, b) => {
    const ra = YARNS.reduce((s, y) => s + a.need[y.key].rest, 0);
    const rb = YARNS.reduce((s, y) => s + b.need[y.key].rest, 0);
    if (ra !== rb) return rb - ra;
    return a.name.localeCompare(b.name, "ja", { numeric: true });
  });
}

/* ============================================================
   点検（画面に出す注意書きのもと）
   ============================================================ */
function auditMachines(machines, stock) {
  const ratio = [];    // 交編率の合計が100%でない
  const unbound = [];  // 交編率はあるのに番手が未設定
  const check = (o, no, label) => {
    const sum = YARNS.reduce((s, y) => s + num(o.ratio[y.key]), 0);
    const used = o.rolls > 0 || o.sku;
    if (!used) return;
    if (sum > 0 && Math.abs(sum - 100) > 0.05) ratio.push({ no: `${no}${label}`, sku: o.sku, sum });
    for (const y of YARNS) {
      if (num(o.ratio[y.key]) > 0 && !countKey(o.counts[y.key])) {
        unbound.push({ no: `${no}${label}`, sku: o.sku, pos: y.label });
      }
    }
  };
  for (const m of machines) {
    check(m, m.no, "");
    check(m.next, m.no, "（次）");
  }
  return { ratio, unbound };
}
