'use strict';
/**
 * 数据接入层 —— 全部使用免费公开行情接口，无任何商业数据授权。
 *
 *  新浪财经行情中心  vip.stock.finance.sina.com.cn  全市场 A 股列表 / 行业 / 概念板块
 *  腾讯证券行情      qt.gtimg.cn                    实时快照（含流通市值、量比、涨跌停价）
 *  腾讯证券日K       web.ifzq.gtimg.cn              前复权日线（技术指标计算）
 *  东方财富涨停池    push2ex.eastmoney.com          涨停 / 强势 / 炸板 / 跌停池（含连板数、封单、行业）
 *
 * 所有对外返回的数据都带 source 与 asOf 字段，禁止在其它层伪造数字。
 */
const https = require('https');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10000;

const SOURCE_META = {
  sina:    { label: '新浪财经行情中心', host: 'vip.stock.finance.sina.com.cn', url: 'https://finance.sina.com.cn/' },
  qq:      { label: '腾讯证券实时行情', host: 'qt.gtimg.cn',                   url: 'https://gu.qq.com/' },
  qqKline: { label: '腾讯证券日K(前复权)', host: 'web.ifzq.gtimg.cn',         url: 'https://gu.qq.com/' },
  emPool:  { label: '东方财富涨停池',     host: 'push2ex.eastmoney.com',      url: 'https://quote.eastmoney.com/ztb/detail' },
  sinaKline: { label: '新浪财经日K(不复权·备用)', host: 'quotes.sina.cn', url: 'https://finance.sina.com.cn/', standby: true },
  emAnn:     { label: '东方财富交易所公告', host: 'np-anotice-stock.eastmoney.com', url: 'https://data.eastmoney.com/notices/' },
  sinaFlash: { label: '新浪财经 7×24 快讯', host: 'zhibo.sina.com.cn',      url: 'https://finance.sina.com.cn/7x24/' },
  qqMinute:  { label: '腾讯证券分时', host: 'web.ifzq.gtimg.cn', url: 'https://gu.qq.com/' },
  sinaFund:  { label: '新浪财经资金流向', host: 'vip.stock.finance.sina.com.cn', url: 'https://finance.sina.com.cn/' },
  qqFund:    { label: '腾讯证券板块资金流', host: 'proxy.finance.qq.com', url: 'https://gu.qq.com/' },
  emFlash:   { label: '东方财富财经快讯',   host: 'np-listapi.eastmoney.com',  url: 'https://finance.eastmoney.com/' }
};

const health = {};
for (const k of Object.keys(SOURCE_META)) {
  health[k] = { key: k, label: SOURCE_META[k].label, ok: false, lastOk: null, lastTry: null, error: null, latency: 0, rows: 0 };
}

const cache = new Map();
const inflight = new Map();

function mark(key, ok, extra) {
  const h = health[key];
  h.ok = ok;
  h.lastTry = new Date().toISOString();
  if (ok) { h.lastOk = h.lastTry; h.error = null; }
  if (extra && typeof extra === 'object') Object.assign(h, extra);
  else if (!ok) h.error = String(extra || 'unknown error');
}

async function cached(key, ttl, producer, validate) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < (hit.ttl || ttl) && hit.value !== undefined) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await producer();
      // validate 用于「空结果不缓存」：上游短时限流时不要把空数组锁住整个 TTL
      if (value !== undefined && value !== null && (!validate || validate(value)))
        cache.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      // 上游失败时允许吃旧缓存，避免整页空白；调用方仍能看到 health 里的失败状态
      if (hit && hit.value !== undefined) return hit.value;
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

function rawGet(url, { referer, ua, gbk = false, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      family: 4,
      method: 'GET',
      headers: {
        'User-Agent': ua || UA,
        'Referer': referer || 'https://finance.sina.com.cn/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'close'
      },
      timeout
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + ' @ ' + u.hostname));
        }
        let text;
        try { text = gbk ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8'); }
        catch (e) { text = buf.toString('utf8'); }
        resolve(text);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout @ ' + u.hostname)); });
    req.on('error', reject);
    req.end();
  });
}

async function timed(key, url, opts) {
  const t0 = Date.now();
  try {
    const text = await rawGet(url, opts);
    mark(key, true, { latency: Date.now() - t0 });
    return text;
  } catch (e) {
    mark(key, false, e.message);
    throw e;
  }
}

const SINA_BASE = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
const SINA_COUNT = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount';

function sinaNodeUrl(node, page, num, sort, asc) {
  return SINA_BASE + '?page=' + page + '&num=' + num + '&sort=' + (sort || 'changepercent') +
    '&asc=' + (asc === undefined ? 0 : asc) + '&node=' + encodeURIComponent(node) + '&_=' + Date.now();
}

function num(v) {
  if (v === undefined || v === null || v === '' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 新浪全市场快照标准化：流通市值统一换算为「亿元」 */
function normalizeSina(row) {
  const symbol = String(row.symbol || '');
  const code = String(row.code || '').padStart(6, '0');
  const nmc = num(row.nmc);       // 万元
  const mktcap = num(row.mktcap); // 万元
  return {
    code,
    symbol,
    name: String(row.name || '').replace(/\s+/g, ''),
    price: num(row.trade),
    prevClose: num(row.settlement),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    change: num(row.pricechange),
    pct: num(row.changepercent),
    volume: num(row.volume),          // 股
    amount: num(row.amount),          // 元
    turnover: num(row.turnoverratio), // %
    pe: num(row.per),
    pb: num(row.pb),
    floatCap: nmc === null ? null : +(nmc / 10000).toFixed(2),   // 亿元
    totalCap: mktcap === null ? null : +(mktcap / 10000).toFixed(2),
    ticktime: row.ticktime || null,
    board: boardOf(code),
    isST: /ST/i.test(String(row.name || ''))
  };
}

/** 板块归属：按证券代码规则判定（规则判定，不是行情数据） */
function boardOf(code) {
  const c = String(code || '');
  if (/^(600|601|603|605|000|001|002|003)/.test(c)) return '主板';
  if (/^(300|301)/.test(c)) return '创业板';
  if (/^(688|689)/.test(c)) return '科创板';
  if (/^(8|4|920)/.test(c)) return '北交所';
  return '其他';
}

async function nodeCount(node) {
  const txt = await timed('sina', SINA_COUNT + '?node=' + encodeURIComponent(node) + '&_=' + Date.now(),
    { referer: SOURCE_META.sina.url });
  try { return Number(String(txt).replace(/"/g, '')) || 0; } catch (e) { return 0; }
}

/** 拉取某个新浪节点（全市场 / 行业 / 概念）的成分股行情 */
async function fetchNode(node, { maxPages = 1, num: pageSize = 100, sort = 'changepercent', asc = 0, concurrency = 8 } = {}) {
  const firstTxt = await timed('sina', sinaNodeUrl(node, 1, pageSize, sort, asc), { referer: SOURCE_META.sina.url });
  let first;
  try { first = JSON.parse(firstTxt); } catch (e) { first = []; }
  if (!Array.isArray(first)) first = [];
  const rows = [...first];
  const totalPages = Math.max(1, Math.min(maxPages, 60));
  if (totalPages > 1) {
    const pages = [];
    for (let p = 2; p <= totalPages; p++) pages.push(p);
    for (let i = 0; i < pages.length; i += concurrency) {
      const batch = pages.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(async p => {
        try {
          const t = await timed('sina', sinaNodeUrl(node, p, pageSize, sort, asc), { referer: SOURCE_META.sina.url });
          const j = JSON.parse(t);
          return Array.isArray(j) ? j : [];
        } catch (e) { return []; }
      }));
      results.forEach(r => rows.push(...r));
    }
  }
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    const c = String(r.code || '').padStart(6, '0');
    if (!c || seen.has(c)) continue;
    seen.add(c);
    list.push(normalizeSina(r));
  }
  return { list, count: list.length, node };
}

/** 全市场 A 股（含北交所），缓存 45 秒 */
async function getUniverse(force) {
  const key = 'universe';
  if (force) cache.delete(key);
  return cached(key, 45000, async () => {
    const total = await nodeCount('hs_a');
    const pages = Math.min(60, Math.max(1, Math.ceil(total / 100)));
    const res = await fetchNode('hs_a', { maxPages: pages, num: 100, sort: 'symbol', asc: 1, concurrency: 10 });
    mark('sina', true, { rows: res.list.length });
    return {
      list: res.list,
      count: res.list.length,
      expected: total,
      asOf: new Date().toISOString(),
      source: SOURCE_META.sina.label,
      ticktime: res.list.length ? res.list[0].ticktime : null
    };
  });
}

/** 行业 / 概念板块列表（新浪） */
function parseSinaBoard(txt, kind) {
  const m = String(txt).match(/=\s*(\{[\s\S]*?\})\s*;?\s*$/);
  if (!m) return [];
  let obj;
  try { obj = JSON.parse(m[1]); } catch (e) { return []; }
  return Object.keys(obj).map(k => {
    const p = String(obj[k]).split(',');
    return {
      node: p[0] || k,
      name: p[1] || k,
      kind,
      members: num(p[2]),
      avgPrice: num(p[3]),
      avgChange: num(p[4]),
      pct: num(p[5]),
      volume: num(p[6]),
      amount: num(p[7]),
      leaderCode: String(p[8] || '').replace(/^(sh|sz|bj)/, ''),
      leaderPct: num(p[9]),
      leaderPrice: num(p[10]),
      leaderName: p[12] || ''
    };
  }).filter(x => x.name);
}

async function getSectorBoards() {
  return cached('boards', 60000, async () => {
    const out = { industry: [], concept: [] };
    const jobs = [
      ['industry', 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php'],
      ['concept', 'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class']
    ];
    await Promise.all(jobs.map(async ([kind, url]) => {
      try {
        const txt = await timed('sina', url, { referer: SOURCE_META.sina.url, gbk: true });
        out[kind] = parseSinaBoard(txt, kind).sort((a, b) => (b.pct || 0) - (a.pct || 0));
      } catch (e) { out[kind] = []; }
    }));
    return { ...out, asOf: new Date().toISOString(), source: SOURCE_META.sina.label };
  });
}

/** 板块成分股代码集合（用于板块筛选） */
async function getSectorMembers(node) {
  if (!node || !/^[A-Za-z0-9_]+$/.test(node)) return new Set();
  return cached('sector:' + node, 120000, async () => {
    try {
      const r = await fetchNode(node, { maxPages: 3, num: 100, sort: 'changepercent', asc: 0, concurrency: 6 });
      return new Set(r.list.map(x => x.code));
    } catch (e) { return new Set(); }
  });
}

/** 腾讯实时快照批量查询；codes 支持 6 位代码或 sh/sz/bj 前缀 */
function qqSymbol(code) {
  const c = String(code || '').replace(/^(sh|sz|bj)/, '');
  if (/^(6|9)/.test(c)) return 'sh' + c;
  if (/^(0|2|3)/.test(c)) return 'sz' + c;
  if (/^(8|4)/.test(c)) return 'bj' + c;
  return null;
}

function parseQQQuotes(text) {
  const out = {};
  const lines = String(text).split(';');
  for (const line of lines) {
    const m = line.match(/v_([a-z]{2}\d{6})\s*=\s*"([\s\S]*?)"/);
    if (!m) continue;
    const p = m[2].split('~');
    if (p.length < 50) continue;
    const code = p[2] || m[1].slice(2);
    out[code] = {
      code,
      name: p[1],
      price: num(p[3]),
      prevClose: num(p[4]),
      open: num(p[5]),
      change: num(p[31]),
      pct: num(p[32]),
      high: num(p[33]),
      low: num(p[34]),
      volume: num(p[36]),       // 手
      amountWan: num(p[37]),    // 万元
      turnover: num(p[38]),
      pe: num(p[39]),
      amplitude: num(p[43]),
      floatCap: num(p[44]),     // 亿元
      totalCap: num(p[45]),     // 亿元
      pb: num(p[46]),
      limitUp: num(p[47]),
      limitDown: num(p[48]),
      volRatio: num(p[49]),
      avgPrice: num(p[51]),
      ticktime: p[30] || null,
      source: SOURCE_META.qq.label
    };
  }
  return out;
}

async function getQQQuotes(codes, { ttl = 12000 } = {}) {
  const uniq = [...new Set((codes || []).map(qqSymbol).filter(Boolean))];
  if (!uniq.length) return {};
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 60) chunks.push(uniq.slice(i, i + 60));
  const key = 'qq:' + uniq.join(',');
  // 组合过多时不做长 key 缓存，直接走单次请求
  const cacheKey = key.length < 1500 ? key : null;
  const run = async () => {
    const results = await Promise.all(chunks.map(async part => {
      try {
        const txt = await timed('qq', 'https://qt.gtimg.cn/q=' + part.join(',') + '&_=' + Date.now(),
          { referer: SOURCE_META.qq.url, gbk: true });
        return parseQQQuotes(txt);
      } catch (e) { return {}; }
    }));
    const merged = Object.assign({}, ...results);
    mark('qq', true, { rows: Object.keys(merged).length });
    return merged;
  };
  return cacheKey ? cached(cacheKey, ttl, run) : run();
}

/** 腾讯前复权日K：web 域高频抓取会触发 WAF(501)，优先 ifzq 域，失败再退回 web 域 */
const TENCENT_KLINE_HOSTS = [
  { host: 'ifzq.gtimg.cn', label: '腾讯 ifzq 前复权日K' },
  { host: 'web.ifzq.gtimg.cn', label: '腾讯 web.ifzq 前复权日K' }
];
let lastKlineSource = null;
// 腾讯 WAF 会对短时间高频日K请求临时封禁（HTTP 501）。命中后进入冷却：
// 冷却期内直接走备用源、不再逐个请求撞墙；到期自动探活，恢复前复权口径。
const TENCENT_COOLDOWN_MS = 120000;
let tencentBlockedUntil = 0;
let klineRound = { at: 0, sources: {} };
function noteKlineSource(src) {
  const now = Date.now();
  if (now - klineRound.at > 60000) klineRound = { at: now, sources: {} };
  if (src) klineRound.sources[src] = (klineRound.sources[src] || 0) + 1;
}

async function tencentKline(sym, limit) {
  if (Date.now() < tencentBlockedUntil) {
    mark('qqKline', false, {
      degraded: true,
      error: '腾讯日K触发 WAF 限流，冷却中；已自动切换新浪不复权日K',
      sourceLabel: SOURCE_META.sinaKline.label,
      resumeAt: new Date(tencentBlockedUntil).toISOString()
    });
    return [];
  }
  for (const src of TENCENT_KLINE_HOSTS) {
    try {
      // 不加 _=timestamp：日K本身有服务端缓存，随机参数只会增加 WAF 穿透特征
      const url = 'https://' + src.host + '/appstock/app/fqkline/get?param=' + sym + ',day,,,' + limit + ',qfq';
      const txt = await timed('qqKline', url, { referer: SOURCE_META.qqKline.url });
      const j = JSON.parse(txt);
      const d = j && j.data && j.data[sym];
      const arr = (d && (d.qfqday || d.day)) || [];
      const rows = arr.map(r => ({
        date: r[0], open: num(r[1]), close: num(r[2]),
        high: num(r[3]), low: num(r[4]), volume: num(r[5])
      })).filter(x => x.close !== null);
      if (rows.length) {
        tencentBlockedUntil = 0;
        mark('qqKline', true, { rows: rows.length, sourceLabel: src.label, degraded: false, error: null, resumeAt: null });
        lastKlineSource = src.label;
        return rows;
      }
    } catch (e) { /* 换下一个 host */ }
  }
  tencentBlockedUntil = Date.now() + TENCENT_COOLDOWN_MS;
  mark('qqKline', false, {
    degraded: true,
    error: '腾讯日K两个域名均不可用（WAF 限流），已切换新浪不复权日K；冷却 2 分钟后自动探活',
    sourceLabel: SOURCE_META.sinaKline.label,
    resumeAt: new Date(tencentBlockedUntil).toISOString()
  });
  return [];
}

/** 新浪财经日K（备用源，不复权）：腾讯接口限流 / 故障时的降级口径 */
async function sinaKline(sym, limit) {
  try {
    const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=' + sym +
      '&scale=240&ma=no&datalen=' + Math.min(250, Math.max(30, limit));
    const txt = await timed('sinaKline', url, { referer: SOURCE_META.sinaKline.url });
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) { mark('sinaKline', false, '返回结构异常'); return []; }
    const rows = arr.map(r => ({
      date: String(r.day || '').slice(0, 10),
      open: num(r.open), close: num(r.close),
      high: num(r.high), low: num(r.low),
      volume: num(r.volume) === null ? null : +(num(r.volume) / 100).toFixed(0) // 股 → 手，与腾讯口径对齐
    })).filter(x => x.date && x.close !== null && x.high !== null && x.low !== null);
    mark('sinaKline', true, { rows: rows.length });
    if (rows.length) lastKlineSource = SOURCE_META.sinaKline.label;
    return rows;
  } catch (e) { return []; }
}

/**
 * 日K统一入口：腾讯前复权优先，失败自动降级新浪不复权，并如实返回口径。
 * 空结果不写入缓存（cached 的 validate），避免上游短时限流把空数据锁住 5 分钟。
 */
async function getKlineData(code, limit = 90) {
  const sym = qqSymbol(code);
  if (!sym) return { rows: [], source: null, adjusted: null, asOf: new Date().toISOString(), reason: '代码无法解析为行情符号' };
  // 各模块分别传 90 / 120 根，按原值建缓存键会对同一只股票重复拉两遍。
  // 归一化到固定档位（≤120 一律取 120 根），让 dashboard / pullback / backtest / dragon 共享缓存，
  // 单位时间内日K请求量减半，是避免再次触发腾讯 WAF 的关键。
  const L = limit <= 120 ? 120 : Math.min(250, limit);
  const result = await cached('klineData:' + sym + ':' + L, 600000, async () => {
    let rows = await tencentKline(sym, L);
    let source = rows.length ? (lastKlineSource || SOURCE_META.qqKline.label) : null;
    let adjusted = rows.length ? true : null;
    if (!rows.length) {
      rows = await sinaKline(sym, L);
      source = rows.length ? SOURCE_META.sinaKline.label : null;
      adjusted = rows.length ? false : null;
    }
    return {
      rows, source, adjusted, limit: L,
      asOf: new Date().toISOString(),
      reason: rows.length ? null : '腾讯与新浪日K接口均未返回数据（可能上游限流）'
    };
  }, v => v && Array.isArray(v.rows) && v.rows.length > 0);
  // 缓存命中也要更新来源：否则 meta 会停留在历史上最后一次成功的源，与实际口径不符
  if (result && result.source) {
    lastKlineSource = result.source;
    noteKlineSource(result.source);
  }
  return result;
}

/** 兼容既有调用：只返回日K数组 */
async function getKline(code, limit = 90) {
  return (await getKlineData(code, limit)).rows;
}

/**
 * 通用周期K线：day 复用 getKlineData（腾讯前复权+新浪降级），week/month 用腾讯 kline/kline 接口（不复权）。
 * kline/kline 与 fqkline 不同域路径，实测不受 fqkline 的 WAF 501 影响；周/月K本身无复权口径，如实标注 adjusted=false。
 */
const PERIOD_KLINE_HOSTS = [
  { host: 'web.ifzq.gtimg.cn', label: '腾讯证券周/月K(不复权)' },
  { host: 'ifzq.gtimg.cn', label: '腾讯证券周/月K(ifzq·不复权)' }
];
async function getPeriodKline(code, period = 'day', limit = 120) {
  const per = ['day', 'week', 'month'].includes(period) ? period : 'day';
  if (per === 'day') {
    const d = await getKlineData(code, limit);
    return { ...d, period: 'day' };
  }
  const sym = qqSymbol(code);
  if (!sym) return { rows: [], source: null, adjusted: null, asOf: new Date().toISOString(), period: per, reason: '代码无法解析为行情符号' };
  const L = Math.min(200, Math.max(20, limit));
  const result = await cached('periodKline:' + sym + ':' + per + ':' + L, 600000, async () => {
    for (const src of PERIOD_KLINE_HOSTS) {
      try {
        const url = 'https://' + src.host + '/appstock/app/kline/kline?param=' + sym + ',' + per + ',,,' + L;
        const txt = await timed('qqKline', url, { referer: SOURCE_META.qqKline.url });
        const j = JSON.parse(txt);
        if (j && j.code !== 0) continue;
        const d = j && j.data && j.data[sym];
        const arr = (d && (d[per] || d.day)) || [];
        const rows = arr.map(r => ({
          date: String(r[0]).slice(0, 10), open: num(r[1]), close: num(r[2]),
          high: num(r[3]), low: num(r[4]), volume: num(r[5])
        })).filter(x => x.date && x.close !== null && x.high !== null && x.low !== null);
        if (rows.length) return { rows, source: src.label, adjusted: false, period: per, asOf: new Date().toISOString(), reason: null };
      } catch (e) { /* 换下一个 host */ }
    }
    return { rows: [], source: null, adjusted: false, period: per, asOf: new Date().toISOString(), reason: '腾讯周/月K接口未返回数据（可能上游限流）' };
  }, v => v && Array.isArray(v.rows) && v.rows.length > 0);
  return result;
}

/** 近 1 分钟内实际使用的日K来源；混用多个源时如实列出，不再只报「最后一次」 */
function getKlineSource() {
  const es = Object.entries(klineRound.sources).sort((a, b) => b[1] - a[1]);
  if (!es.length) return lastKlineSource;
  if (es.length === 1) return es[0][0];
  return es[0][0] + '（混用 ' + es.slice(1).map(x => x[0] + '×' + x[1]).join('、') + '）';
}

/** 东财涨停/炸板/强势/跌停池 */
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
const EM_POOLS = {
  zt: { path: 'getTopicZTPool', sort: 'fbt%3Aasc', label: '涨停池' },
  zb: { path: 'getTopicZBPool', sort: 'fbt%3Aasc', label: '炸板池' },
  qs: { path: 'getTopicQSPool', sort: 'zdp%3Adesc', label: '强势股池' },
  dt: { path: 'getTopicDTPool', sort: 'fund%3Aasc', label: '跌停池' }
};

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function fmtSealTime(v) {
  if (v === undefined || v === null) return null;
  const s = String(Math.floor(Number(v))).padStart(6, '0');
  return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}

function normalizeEMPool(row, kind) {
  const code = String(row.c || '').padStart(6, '0');
  const price = num(row.p) === null ? null : +(num(row.p) / 1000).toFixed(2);
  const ztPrice = num(row.ztp) === null ? null : +(num(row.ztp) / 1000).toFixed(2);
  const ltsz = num(row.ltsz);
  const fund = num(row.fund);
  return {
    code,
    name: String(row.n || '').replace(/\s+/g, ''),
    price,
    limitUpPrice: ztPrice,
    pct: num(row.zdp),
    amount: num(row.amount),           // 元
    floatCap: ltsz === null ? null : +(ltsz / 1e8).toFixed(2),   // 亿元
    totalCap: num(row.tshare) === null ? null : +(num(row.tshare) / 1e8).toFixed(2),
    turnover: num(row.hs),
    boards: num(row.lbc) || 1,          // 连板数
    firstSeal: fmtSealTime(row.fbt),
    lastSeal: fmtSealTime(row.lbt),
    sealFund: fund,                     // 封单额（元）
    sealFundRatio: (fund && ltsz) ? +(fund / ltsz * 100).toFixed(2) : null, // 封单/流通市值 %
    brokenCount: num(row.zbc) || 0,     // 炸板次数
    volRatio: num(row.lb),
    speed: num(row.zs),
    industry: row.hybk || '',
    statDays: row.zttj ? num(row.zttj.days) : null,
    statCount: row.zttj ? num(row.zttj.ct) : null,
    board: boardOf(code),
    isST: /ST/i.test(String(row.n || '')),
    kind,
    source: SOURCE_META.emPool.label
  };
}

async function fetchEMPool(kind, date) {
  const cfg = EM_POOLS[kind];
  if (!cfg) return [];
  const url = 'https://push2ex.eastmoney.com/' + cfg.path + '?ut=' + EM_UT +
    '&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=' + cfg.sort + '&date=' + date + '&_=' + Date.now();
  try {
    const txt = await timed('emPool', url, { referer: SOURCE_META.emPool.url });
    const j = JSON.parse(txt);
    const pool = j && j.data && Array.isArray(j.data.pool) ? j.data.pool : [];
    return { rows: pool.map(r => normalizeEMPool(r, kind)), total: j.data.tc || pool.length, qdate: j.data.qdate || date };
  } catch (e) { return { rows: [], total: 0, qdate: date, error: e.message }; }
}

/** 自动回溯最近一个有数据的交易日（周末 / 节假日 / 盘前） */
async function resolveTradeDate() {
  return cached('tradedate', 300000, async () => {
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const date = ymd(new Date(d.getTime() - i * 86400000));
      const r = await fetchEMPool('zt', date);
      if (r.rows && r.rows.length) return { date, qdate: r.qdate, checked: i + 1 };
    }
    return { date: ymd(d), qdate: ymd(d), checked: 12 };
  });
}

async function getPools() {
  const td = await resolveTradeDate();
  const date = td.date;
  return cached('pools:' + date, 20000, async () => {
    const kinds = Object.keys(EM_POOLS);
    const results = await Promise.all(kinds.map(k => fetchEMPool(k, date)));
    const out = { date, qdate: results[0].qdate || date, asOf: new Date().toISOString(), source: SOURCE_META.emPool.label };
    kinds.forEach((k, i) => { out[k] = results[i].rows; out[k + 'Total'] = results[i].total; });
    mark('emPool', true, { rows: out.zt.length });
    return out;
    // 上游偶发返回空名单时不要锁住整个 TTL，否则页面会连续 20 秒误判「无涨停」
  }, v => v && Array.isArray(v.zt) && v.zt.length > 0);
}

/* ─────────── 近 N 个交易日涨停池回溯（涨停回调候选池） ─────────── */
/**
 * 用途：为「涨停回调到支撑位」模块收敛候选代码，避免对全市场 5,000+ 只逐个拉日K。
 * 口径与边界：
 *  - 逐一请求东方财富涨停池历史日期（date=YYYYMMDD），只采信返回非空池的交易日；
 *  - 上游返回的 qdate 常为最新交易日而非请求日，故交易日以请求 date 为准并在 UI 标注；
 *  - 本结果只作「候选代码来源」，最终涨停日必须由腾讯前复权日K的当日涨幅交叉验证（分析层处理），
 *    不把历史池字段直接当作行情结论；
 *  - 缓存 10 分钟，避免每次页面刷新都重复回溯。
 */
async function getRecentLimitUpPools(tradingDays = 8) {
  const days = Math.max(3, Math.min(15, Number(tradingDays) || 8));
  return cached('ztHistory:' + days, 600000, async () => {
    const now = new Date();
    const probeDates = [];
    for (let i = 0; i < 30 && probeDates.length < days + 8; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      probeDates.push(ymd(d));
    }
    const probes = [];
    for (let i = 0; i < probeDates.length; i += 5) {
      const batch = probeDates.slice(i, i + 5);
      const rs = await Promise.all(batch.map(date =>
        fetchEMPool('zt', date).then(r => ({ date, rows: r.rows || [] })).catch(() => ({ date, rows: [] }))
      ));
      probes.push(...rs);
      if (probes.filter(p => p.rows.length).length >= days) break;
    }
    const valid = probes.filter(p => p.rows.length).slice(0, days);
    const byCode = {};
    const dates = [];
    for (const p of valid) {
      dates.push({ date: p.date, count: p.rows.length });
      for (const r of p.rows) {
        const prev = byCode[r.code];
        if (!prev || p.date > prev.date) {
          byCode[r.code] = {
            code: r.code, name: r.name, industry: r.industry,
            date: p.date, boards: r.boards, floatCap: r.floatCap,
            poolPrice: r.price, source: SOURCE_META.emPool.label
          };
        }
      }
    }
    mark('emPool', true, { rows: Object.keys(byCode).length });
    return {
      dates, byCode, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label,
      note: '历史涨停池仅用于收敛候选代码；上游 qdate 常返回最新交易日，交易日以请求 date 为准；最终涨停日由腾讯前复权日K涨幅交叉验证。'
    };
  });
}

/* ─────────── 回测用：近 N 个交易日涨停池完整明细 ─────────── */
/**
 * 与 getRecentLimitUpPools 的区别：按交易日保留完整名单（不做 byCode 去重），
 * 供历史回测按「基准日之前的涨停日」重建当日候选，避免同一只股票多次涨停只留最近一次。
 * 交易日以请求 date 为准（上游 qdate 常返回最新交易日），缓存 10 分钟。
 */
async function getLimitUpHistory(tradingDays = 22) {
  const days = Math.max(8, Math.min(30, Number(tradingDays) || 22));
  return cached('ztHistoryFull:' + days, 600000, async () => {
    const now = new Date();
    const probeDates = [];
    for (let i = 0; i < 70 && probeDates.length < days + 12; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      probeDates.push(ymd(d));
    }
    const probes = [];
    for (let i = 0; i < probeDates.length; i += 5) {
      const batch = probeDates.slice(i, i + 5);
      const rs = await Promise.all(batch.map(date =>
        fetchEMPool('zt', date).then(r => ({ date, rows: r.rows || [] })).catch(() => ({ date, rows: [] }))
      ));
      probes.push(...rs);
      if (probes.filter(p => p.rows.length).length >= days) break;
    }
    const valid = probes.filter(p => p.rows.length).slice(0, days);
    const byDate = {}, dates = [];
    for (const p of valid) {
      dates.push({ date: p.date, count: p.rows.length });
      byDate[p.date] = p.rows.map(r => ({
        code: r.code, name: r.name, industry: r.industry,
        amount: r.amount, floatCap: r.floatCap, boards: r.boards
      }));
    }
    return {
      dates, byDate, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label,
      note: '按交易日保留完整涨停名单（未按代码去重）；仅作候选来源，最终涨停日与价位一律以真实日K为准。'
    };
  }, v => v && Array.isArray(v.dates) && v.dates.length > 0);
}

/* ─────────── 龙头博弈用：近 N 个交易日涨停/炸板池完整明细 ─────────── */
/**
 * 与 getLimitUpHistory（回测用精简名单）的区别：保留封板时间、炸板次数、封单比、
 * 换手、成交额、行业、连板数等完整字段，供连板梯队演变 / 题材扩散 / 一致分歧量化使用。
 * 交易日以请求 date 为准（上游 qdate 常返回最新交易日），缓存 10 分钟，空结果不缓存。
 */
async function getPoolFullHistory(tradingDays = 7) {
  const days = Math.max(3, Math.min(15, Number(tradingDays) || 7));
  return cached('poolFullHistory:' + days, 600000, async () => {
    const now = new Date();
    const probeDates = [];
    for (let i = 0; i < 60 && probeDates.length < days + 12; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      probeDates.push(ymd(d));
    }
    const probes = [];
    for (let i = 0; i < probeDates.length; i += 5) {
      const batch = probeDates.slice(i, i + 5);
      const rs = await Promise.all(batch.map(async date => {
        const [zt, zb] = await Promise.all([fetchEMPool('zt', date), fetchEMPool('zb', date)]);
        return { date, zt: zt.rows || [], zb: zb.rows || [], qdate: zt.qdate || date };
      }));
      probes.push(...rs);
      if (probes.filter(p => p.zt.length).length >= days) break;
    }
    const valid = probes.filter(p => p.zt.length).slice(0, days);
    const byDate = {}, dates = [];
    for (const p of valid) {
      dates.push({ date: p.date, zt: p.zt.length, zb: p.zb.length });
      byDate[p.date] = { zt: p.zt, zb: p.zb };
    }
    mark('emPool', true, { rows: dates.reduce((n, d) => n + d.zt, 0) });
    return {
      dates, byDate, asOf: new Date().toISOString(),
      source: SOURCE_META.emPool.label,
      note: '按交易日保留涨停/炸板池完整字段；交易日以请求 date 为准，上游 qdate 常返回最新交易日。封板时间为首次触板时间，非收盘封板状态。'
    };
  }, v => v && Array.isArray(v.dates) && v.dates.length > 0);
}

/* ─────────── 消息面：交易所公告 + 7×24 快讯 / 财经资讯 ─────────── */
/**
 * 三类来源，均为免费公开 HTTP 接口，非交易所官方推送：
 *   东方财富公告  np-anotice-stock.eastmoney.com  公告标题 / art_code / codes（精确关联个股）/ 披露时间
 *   新浪 7×24    zhibo.sina.com.cn              快讯正文 / ext.stocks（精确关联个股）/ 原文链接
 *   东财快讯     np-listapi.eastmoney.com       政策 / 宏观 / 行业资讯（无个股字段，按名称字面匹配）
 * 时间戳统一按北京时间解析为 ISO；所有条目保留 source / media / url 可追溯。
 */
const ANN_BASE = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const SINA_FLASH_BASE = 'https://zhibo.sina.com.cn/api/zhibo/feed';
const EM_FLASH_BASE = 'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns';

/** 上游时间多为北京时间字符串；东财 display_time 的毫秒用冒号分隔（19:10:16:320） */
function toBJTime(s) {
  if (!s) return null;
  const t = String(s).trim().replace(' ', 'T').replace(/:(\d{3})$/, '.$1');
  const d = new Date(/([+-]\d{2}:?\d{2}|Z)$/.test(t) ? t : t + '+08:00');
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function cleanCodes(codes) {
  return [...new Set((codes || []).map(c => String(c || '').replace(/\D/g, ''))
    .filter(c => /^\d{6}$/.test(c)))].slice(0, 80);
}

async function fetchAnnBatch(codes, pageSize) {
  const qs = new URLSearchParams({
    sr: '-1', page_size: String(pageSize), page_index: '1',
    ann_type: 'A', client_source: 'web'
  });
  if (codes && codes.length) qs.set('stock_list', codes.join(','));
  const txt = await timed('emAnn', ANN_BASE + '?' + qs.toString(), { referer: SOURCE_META.emAnn.url });
  const j = JSON.parse(txt);
  const rows = (j && j.data && j.data.list) || [];
  mark('emAnn', true, { rows: rows.length });
  return rows.map(r => {
    const cs = (r.codes || []).map(c => ({
      code: String(c.stock_code || '').padStart(6, '0'), name: c.short_name || ''
    })).filter(c => /^\d{6}$/.test(c.code));
    const art = String(r.art_code || '');
    return {
      id: 'ann:' + art,
      kind: 'announcement', kindLabel: '交易所公告',
      title: String(r.title_ch || r.title || ''),
      text: '',
      time: toBJTime(r.display_time) || toBJTime(r.notice_date),
      timeText: String(r.display_time || r.notice_date || '').slice(0, 19),
      noticeDate: String(r.notice_date || '').slice(0, 10),
      columns: (r.columns || []).map(c => c.column_name).filter(Boolean),
      codes: cs,
      url: art ? 'https://data.eastmoney.com/notices/detail/' + (cs[0] ? cs[0].code : '') + '/' + art + '.html' : '',
      pdfUrl: art ? 'https://pdf.dfcfw.com/pdf/H2_' + art + '_1.pdf' : '',
      source: SOURCE_META.emAnn.label, sourceKey: 'emAnn',
      media: '上市公司公告（东方财富转载）'
    };
  }).filter(x => x.id !== 'ann:' && x.title);
}

/** 按候选代码批量拉最新公告；codes 为空时拉全市场最新公告 */
async function getAnnouncements(codes = [], limit = 60) {
  const clean = cleanCodes(codes);
  const n = Math.max(10, Math.min(120, Number(limit) || 60));
  return cached('ann:' + clean.join(',') + ':' + n, 45000, async () => {
    const batches = clean.length ? [] : [[]];
    for (let i = 0; i < clean.length; i += 30) batches.push(clean.slice(i, i + 30));
    const rs = await Promise.all(batches.map(async b => {
      try { return await fetchAnnBatch(b, Math.min(100, Math.max(20, n))); }
      catch (e) { return []; }
    }));
    const items = rs.flat().filter(Boolean).sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    return {
      items: items.slice(0, n), codes: clean, asOf: new Date().toISOString(),
      source: SOURCE_META.emAnn.label, batches: batches.length
    };
  }, v => v && Array.isArray(v.items) && v.items.length > 0);
}

async function fetchSinaFlash(limit) {
  const u = SINA_FLASH_BASE + '?page=1&page_size=' + limit +
    '&zhibo_id=152&tag_id=0&dire=f&dpc=1&type=0&_=' + Date.now();
  const txt = await timed('sinaFlash', u, { referer: SOURCE_META.sinaFlash.url });
  const j = JSON.parse(txt);
  const list = (j && j.result && j.result.data && j.result.data.feed && j.result.data.feed.list) || [];
  mark('sinaFlash', true, { rows: list.length });
  return list.map(x => {
    let ext = {};
    try { ext = JSON.parse(x.ext || '{}'); } catch (_) { /* 无扩展字段时按纯文本处理 */ }
    const stocks = (ext.stocks || []).filter(s => s && s.market === 'cn').map(s => {
      const m = String(s.symbol || '').match(/(\d{6})$/);
      return m ? { code: m[1], name: String(s.key || '') } : null;
    }).filter(Boolean);
    const rich = String(x.rich_text || '');
    const head = rich.match(/^【([^】]+)】/);
    return {
      id: 'flash:' + x.id,
      kind: 'flash', kindLabel: '7×24 快讯',
      title: head ? head[1] : rich.slice(0, 42),
      text: rich,
      time: toBJTime(x.create_time),
      timeText: String(x.create_time || '').slice(0, 19),
      codes: stocks,
      tags: (x.tag || []).map(t => t.name).filter(Boolean),
      url: String(ext.docurl || x.docurl || 'https://finance.sina.com.cn/7x24/'),
      source: SOURCE_META.sinaFlash.label, sourceKey: 'sinaFlash', media: '新浪财经 7×24'
    };
  }).filter(x => x.title);
}

async function fetchEmFlash(limit) {
  const qs = new URLSearchParams({
    client: 'web', biz: 'web_news_col', column: '350', order: '1',
    needjump: 'false', pageindex: '1', pagesize: String(limit), req_trace: String(Date.now())
  });
  const txt = await timed('emFlash', EM_FLASH_BASE + '?' + qs.toString(), { referer: SOURCE_META.emFlash.url });
  const j = JSON.parse(txt);
  if (j && j.code === '0') throw new Error(j.message || '上游返回空');
  const list = (j && j.data && j.data.list) || [];
  mark('emFlash', true, { rows: list.length });
  return list.map(x => ({
    id: 'news:' + String(x.code || x.uniqueUrl || ''),
    kind: 'news', kindLabel: '财经资讯',
    title: String(x.title || ''),
    text: String(x.summary || ''),
    time: toBJTime(x.showTime),
    timeText: String(x.showTime || '').slice(0, 19),
    codes: [],
    url: String(x.uniqueUrl || x.url || '').replace(/^http:\/\//, 'https://'),
    source: SOURCE_META.emFlash.label, sourceKey: 'emFlash',
    media: String(x.mediaName || '东方财富')
  })).filter(x => x.id !== 'news:' && x.title);
}

/** 合并两类快讯；任一源失败时另一源照常返回，不编造数据 */
async function getFlashNews(limit = 40) {
  const n = Math.max(10, Math.min(80, Number(limit) || 40));
  return cached('flash:' + n, 30000, async () => {
    const [sina, em] = await Promise.all([
      fetchSinaFlash(Math.min(60, n)).catch(() => []),
      fetchEmFlash(Math.min(30, Math.max(10, Math.round(n / 2)))).catch(() => [])
    ]);
    const items = [...sina, ...em].filter(Boolean)
      .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    return {
      items, asOf: new Date().toISOString(),
      sinaCount: sina.length, emCount: em.length,
      source: SOURCE_META.sinaFlash.label + ' + ' + SOURCE_META.emFlash.label
    };
  }, v => v && Array.isArray(v.items) && v.items.length > 0);
}

/** 主要指数实时快照 */
const INDEX_CODES = [
  { code: '000001', sym: 'sh000001', name: '上证指数' },
  { code: '399001', sym: 'sz399001', name: '深证成指' },
  { code: '399006', sym: 'sz399006', name: '创业板指' },
  { code: '000688', sym: 'sh000688', name: '科创50' },
  { code: '000300', sym: 'sh000300', name: '沪深300' },
  { code: '000905', sym: 'sh000905', name: '中证500' }
];

async function getIndices() {
  return cached('indices', 12000, async () => {
    const syms = INDEX_CODES.map(x => x.sym);
    const txt = await timed('qq', 'https://qt.gtimg.cn/q=' + syms.join(',') + '&_=' + Date.now(),
      { referer: SOURCE_META.qq.url, gbk: true });
    const map = parseQQQuotes(txt);
    return INDEX_CODES.map(x => {
      const q = map[x.code];
      return q ? { ...q, name: x.name } : null;
    }).filter(Boolean);
  });
}

function getHealth() {
  // standby 源（新浪日K）只在主源失败时启用，不参与「在线数」统计，避免误报故障
  return Object.values(health).map(h => ({ ...h, standby: !!SOURCE_META[h.key].standby }));
}

/**
 * 腾讯证券分时：每分钟价格 / 成交量(手) / 成交额(元)。
 * 只返回上游真实分钟数据；非交易时段返回最近一个交易日的完整分时，并如实标注日期。
 * 缓存 60 秒，避免弹窗反复拖动时打爆上游。
 */
async function getMinute(code) {
  const sym = qqSymbol(code);
  if (!sym) return { rows: [], source: null, date: null, reason: '代码无法解析为行情符号' };
  // 分时是分钟级数据：交易时段 12 秒缓存（配合前端 12 秒轮询，尽快捕捉新的一分钟），
  // 非交易时段 5 分钟（行情不再变动，避免无意义请求）。
  const hm = (() => { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.getUTCDay() === 0 || d.getUTCDay() === 6 ? -1 : d.getUTCHours() * 100 + d.getUTCMinutes(); })();
  const trading = hm >= 915 && hm <= 1130 || hm >= 1300 && hm <= 1500;
  return cached('minute:' + sym, trading ? 12000 : 300000, async () => {
    try {
      const url = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + sym;
      const txt = await timed('qqMinute', url, { referer: SOURCE_META.qqMinute.url });
      const j = JSON.parse(txt);
      const node = j && j.data && j.data[sym];
      const md = node && node.data;
      const arr = (md && md.data) || [];
      const rows = arr.map(s => {
        const p = String(s).trim().split(/\s+/);
        return p.length >= 3 ? {
          time: String(p[0]).replace(/(\d{2})(\d{2})/, '$1:$2'),
          price: num(p[1]), volume: num(p[2]),
          amount: p.length >= 4 ? num(p[3]) : null
        } : null;
      }).filter(x => x && Number.isFinite(x.price) && x.price > 0);
      return {
        rows,
        source: rows.length ? SOURCE_META.qqMinute.label : null,
        date: (md && md.date) || (node && node.date) || null,
        asOf: new Date().toISOString(),
        reason: rows.length ? null : '腾讯分时接口未返回数据（可能非交易时段或上游临时不可用）'
      };
    } catch (e) {
      return { rows: [], source: null, date: null, asOf: new Date().toISOString(), reason: '腾讯分时接口请求失败：' + (e && e.message || e) };
    }
  });
}

/**
 * 新浪财经资金流向：
 *  - 行业板块净流入排行（ssl_bkzj_bk）
 *  - 全市场主力净流入汇总（由行业板块加总，避免额外请求）
 * 口径：新浪按特大单/大单/中单/小单拆分，netamount 为净流入额（元）。
 */
async function getFundFlow() {
  return cached('fundflow', 120000, async () => {
    const out = {
      boards: [], totalNet: null, upBoards: 0, downBoards: 0, concept: [],
      source: null, asOf: new Date().toISOString(), reason: null
    };
    // 主源：腾讯板块资金流排行（zljlr=主力净流入，单位万元；zdf=涨跌幅；lzg=领涨股）
    // 新浪 MoneyFlow 接口会因 UA/时段不稳定返回 {"__ERROR":1,"Input error"}，降级为备用。
    const fromQQ = async () => {
      const url = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&limit=200';
      const txt = await timed('qqFund', url, { referer: SOURCE_META.qq.url });
      const j = JSON.parse(txt);
      const list = (j && j.data && j.data.rank_list) || [];
      if (!list.length) throw new Error('腾讯板块资金流为空');
      const map = x => ({
        code: x.code || '', name: x.name || '',
        pct: num(x.zdf), net: num(x.zljlr) === null ? null : num(x.zljlr) * 10000, // 万元 → 元
        ratio: num(x.hsl), turnover: num(x.turnover),
        leader: (x.lzg && x.lzg.name) || null,
        leaderPct: (x.lzg && num(x.lzg.zdf)) || null,
        zljlr5: num(x.zljlr_d5), zljlr20: num(x.zljlr_d20)
      });
      out.boards = list.map(map).filter(x => x.name && Number.isFinite(x.net));
      // 概念板块资金流（同一接口 board_type=gn）
      try {
        const gurl = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=gn&sort_type=price&direct=down&offset=0&limit=200';
        const gtxt = await timed('qqFund', gurl, { referer: SOURCE_META.qq.url });
        const gj = JSON.parse(gtxt);
        out.concept = (((gj && gj.data && gj.data.rank_list) || []).map(map).filter(x => x.name && Number.isFinite(x.net)));
      } catch (e) { out.concept = []; }
      out.source = '腾讯证券板块资金流';
    };
    // 备用：新浪资金流（历史口径，可能因上游 Input error 不可用）
    const fromSina = async () => {
      const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=50&sort=netamount&asc=0&bankuai=&shichang=';
      const txt = await timed('sinaFund', url, { referer: 'https://vip.stock.finance.sina.com.cn/' });
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr) || !arr.length) throw new Error('新浪资金流为空');
      out.boards = arr.map(x => ({
        code: x.category || '', name: x.name || '',
        pct: num(x.avg_changeratio) === null ? null : +(num(x.avg_changeratio) * 100).toFixed(2),
        net: num(x.netamount),
        inAmount: num(x.inamount), outAmount: num(x.outamount),
        ratio: num(x.ratioamount) === null ? null : +(num(x.ratioamount) * 100).toFixed(2),
        leader: x.ts_name || null,
        leaderPct: num(x.ts_changeratio) === null ? null : +(num(x.ts_changeratio) * 100).toFixed(2)
      })).filter(x => x.name && Number.isFinite(x.net));
      out.source = SOURCE_META.sinaFund.label;
    };
    try {
      try { await fromQQ(); } catch (e1) {
        try { await fromSina(); } catch (e2) { throw new Error('腾讯:' + e1.message + ' / 新浪:' + e2.message); }
      }
      out.upBoards = out.boards.filter(x => x.net > 0).length;
      out.downBoards = out.boards.filter(x => x.net < 0).length;
      const nets = out.boards.map(x => x.net).filter(Number.isFinite);
      out.totalNet = nets.length ? Math.round(nets.reduce((s, v) => s + v, 0)) : null;
      if (!out.boards.length) out.reason = '资金流接口未返回板块数据';
    } catch (e) {
      out.reason = '资金流接口失败：' + (e && e.message || e);
    }
    return out;
  });
}

module.exports = {
  SOURCE_META, boardOf, qqSymbol,
  getMinute, getFundFlow,
  getUniverse, getSectorBoards, getSectorMembers,
  getQQQuotes, getKline, getKlineData, getPeriodKline, getKlineSource, getPools, getIndices, resolveTradeDate,
  getRecentLimitUpPools, getLimitUpHistory, getPoolFullHistory,
  getAnnouncements, getFlashNews, toBJTime,
  getHealth, cached
};
