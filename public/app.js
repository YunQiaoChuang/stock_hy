'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const E = v => (v === null || v === undefined) ? '—' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = (v, d) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(d === undefined ? 2 : d);
  const PC = (v, d) => {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '<span class="flat">—</span>';
    const n = Number(v), c = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
    return '<span class="' + c + '">' + (n > 0 ? '+' : '') + n.toFixed(d === undefined ? 2 : d) + '%</span>';
  };
  const AMT = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : (Number(v) >= 1e8 ? (Number(v) / 1e8).toFixed(2) + '亿' : (Number(v) / 1e4).toFixed(0) + '万');
  const CAP = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : Number(v).toFixed(1) + '亿';
  const YI = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : (Number(v) / 1e8).toFixed(2) + '亿';
  const tag = (t, cls) => '<span class="tag ' + (cls || '') + '">' + E(t) + '</span>';
  const src = s => '<span class="src">来源：' + E(s) + '</span>';
  /* 可点击股票名：统一带 data-stock-code，点击弹K线。cls 保留原样式类 */
  const sn = (code, name, cls) => '<span class="stock-link ' + (cls || '') + '" data-stock-code="' + E(code) + '" title="点击查看K线 / 周K / 筹码峰">' + E(name) + '</span>';
  const TICK = m => m.quoteTick || m.universeTick || (m.now ? m.now.slice(11, 16) : '—');
  const fmtDate = v => { const s = String(v || '').replace(/\D/g, ''); return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : (v || '—'); };

  /* ── K线涨跌停/炸板配色（可在弹窗内自定义，存 localStorage） ── */
  const KL_COLOR_KEY = 'stockhy_kline_colors_v1';
  const KL_COLOR_DEFAULT = { up: '#d92b2b', down: '#0f9960', limitUp: '#c2185b', limitDown: '#00695c', broken: '#f08c00' };
  const KL_COLOR_META = [
    { k: 'up', label: '阳线（收涨）' }, { k: 'down', label: '阴线（收跌）' },
    { k: 'limitUp', label: '涨停' }, { k: 'limitDown', label: '跌停' }, { k: 'broken', label: '炸板' }
  ];
  function klLoadColors() {
    try {
      const s = JSON.parse(localStorage.getItem(KL_COLOR_KEY) || 'null');
      const o = {};
      KL_COLOR_META.forEach(m => {
        const v = s && s[m.k];
        o[m.k] = /^#[0-9a-fA-F]{6}$/.test(v || '') ? v : KL_COLOR_DEFAULT[m.k];
      });
      return o;
    } catch (e) { return Object.assign({}, KL_COLOR_DEFAULT); }
  }
  function klSaveColors() {
    try { localStorage.setItem(KL_COLOR_KEY, JSON.stringify(S.klColors)); } catch (e) { /* 隐私模式下忽略 */ }
  }
  /* 涨跌幅上限：主板10% / 创业板+科创板20% / 北交所30% / ST 5% */
  function klLimitRate(code, name) {
    const c = String(code || ''), nm = String(name || '').toUpperCase();
    if (nm.indexOf('ST') >= 0) return 0.05;
    if (/^(30|688|689)/.test(c)) return 0.20;
    if (/^(4|8|920)/.test(c)) return 0.30;
    return 0.10;
  }
  /* 从 OHLC + 前收推算单根K线类型：limitUp / limitDown / broken / null
     封板按收盘价判定；炸板=盘中触及涨停(或跌停)价但收盘未封住。
     0.3% 容差覆盖前复权与四舍五入误差。仅日K使用（周K无涨跌停制度）。 */
  function klBarKind(rows, i, code, name) {
    if (i <= 0) return null;
    const b = rows[i], prev = rows[i - 1];
    if (!b || !prev || !prev.close || b.close === null || b.high === null || b.low === null) return null;
    const rate = klLimitRate(code, name), tol = 0.003;
    const upPct = b.close / prev.close - 1;
    const hiPct = b.high / prev.close - 1;
    const loPct = b.low / prev.close - 1;
    if (upPct >= rate - tol) return 'limitUp';
    if (upPct <= -(rate - tol)) return 'limitDown';
    if (hiPct >= rate - tol || loPct <= -(rate - tol)) return 'broken';
    return null;
  }

  /* 「连不上本地服务」与「上游数据源不可用」是两类完全不同的故障，提示不能混为一谈 */
  const SERVICE_HINT = '本地服务未响应：请确认 A股实时复盘系统已启动（双击项目目录 start.bat，或在项目目录运行 node server.js）；默认端口 8899，被占用时会自动顺延，请以控制台输出的「本机访问」地址为准。';
  function isConnError(e) {
    return e instanceof TypeError ||
      /Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET/i.test(String((e && e.message) || e));
  }

  const S = {
    data: null, prevPrices: {}, tab: 'review', boards: new Set(['全部']),
    freq: 15, tick: 0, timer: null, boardsList: null,
    collapsed: new Set(), expanded: new Set(), chartsReady: !!window.echarts,
    lastFilters: '', aiCfgOpen: false, aiText: '', aiTextTime: '',
    pull: null, pullLoading: false, pullAt: 0, pullSelected: null,
    pullFilters: '', pullError: null, pullMethodOpen: false, pullOfflineTimer: null, pullDays: 8,
    bt: null, btLoading: false, btError: null, btOpen: false,
    btDate: 'all', btWindow: 5, btMethodOpen: false,
    dg: null, dgLoading: false, dgError: null, dgAt: 0, dgSelected: null, dgFilters: '',
    dgMethodOpen: false, dgValidationOpen: false,
    dgHist: null, dgHistDate: null, dgHistOpen: false, dgHistLoading: false, dgHistError: null,
    dgHistSelected: null, dgHistMethodOpen: false,
    dgOpts: { days: 12, showAll: 0, sort: 'score', sortDir: 'desc', role: '全部', limit: 60 },
    dgOfflineTimer: null,
    auction: null, auctionLoading: false, auctionError: null, auctionAt: 0,
    auctionOpts: { days: 10 }, auctionMethodOpen: false,
    ladderDate: null, ladderData: null, ladderDates: [], ladderLoading: false,
    news: null, newsLoading: false, newsError: null, newsAt: 0, newsSince: null,
    newsInterval: 30, newsWindow: 72, newsPaused: false, newsFilter: 'all',
    newsKeyword: '', newsMethodOpen: false, newsShowAll: false,
    newsTimer: null, newsTickTimer: null, newsNextAt: 0, newsCodes: '',
    en: null, enLoading: false, enError: null, enOpts: { days: 8 },
    chart: { open: false, code: null, name: null, period: 'day', data: null, loading: false, error: null, view: null, geom: null, lockIdx: null },
    klColors: klLoadColors(), klPanelOpen: false
  };
  // 消息面三个源只在「明日龙头」模块启用后才调用，未调用前不计入主看板在线率分母
  const NEWS_KEYS = ['emAnn', 'sinaFlash', 'emFlash'];
  const activeHealth = m => (m.health || []).filter(h => !h.standby && (NEWS_KEYS.indexOf(h.key) < 0 || !!h.lastTry));

  /* ─────────────── 初始化与事件 ─────────────── */
  function init() {
    $('btnRefresh').onclick = () => refresh(true);
    $('btnApply').onclick = () => { refresh(true); S.tick = 0; };
    $('btnReset').onclick = resetFilters;
    $('btnToggleFilter').onclick = () => {
      const b = $('filterBody'), hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      $('btnToggleFilter').textContent = hidden ? '收起' : '展开';
    };
    $('freq').onchange = e => { S.freq = Number(e.target.value); S.tick = 0; startTimer(); };
    $('boardChips').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      const val = b.dataset.board;
      if (val === '全部') S.boards = new Set(['全部']);
      else {
        S.boards.delete('全部');
        if (S.boards.has(val)) { S.boards.delete(val); if (!S.boards.size) S.boards.add('全部'); }
        else S.boards.add(val);
      }
      [...$('boardChips').children].forEach(c => c.classList.toggle('active', S.boards.has(c.dataset.board)));
    };
    $('capQuick').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      $('capMin').value = b.dataset.min || ''; $('capMax').value = b.dataset.max || '';
      [...$('capQuick').children].forEach(c => c.classList.toggle('active', c === b));
    };
    $('tabs').onclick = e => {
      const t = e.target.closest('.tab'); if (!t) return;
      switchTab(t.dataset.tab);
    };
    ['sectorSelect', 'boardsMin', 'sortSel', 'excludeST'].forEach(id => {
      $(id).addEventListener('change', () => refresh(true));
    });
    ['capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'keyword'].forEach(id => {
      $(id).addEventListener('keydown', e => { if (e.key === 'Enter') refresh(true); });
    });
    // 全局股票名点击委托：打开个股K线弹窗
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-stock-code]');
      if (el) { e.preventDefault(); e.stopPropagation(); openStockChart(el.dataset.stockCode); return; }
      if (e.target.closest('#smClose') || e.target.id === 'stockModal') closeStockChart();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.chart.open) closeStockChart(); });
    if ($('smClose')) $('smClose').onclick = closeStockChart;
    initStockSearch();
    [...document.querySelectorAll('.sm-tab')].forEach(b => {
      b.onclick = () => { if (S.chart.data && b.dataset.period !== S.chart.period) { S.chart.period = b.dataset.period; S.chart.view = null; S.chart.lockIdx = null; if (S.chart.period !== 'minute') stopMinuteTimer(); renderStockChart(); } };
    });
    loadBoards();
    initLadderDates();
    const qs = new URLSearchParams(location.search);
    const initTab = qs.get('tab');
    if (initTab && ['review', 'picks', 'live', 'lowbuy', 'relay', 'ai', 'pullback', 'dragon', 'auction', 'enlighten'].indexOf(initTab) >= 0) switchTab(initTab);
    // 深链：?stock=000001&period=week 直接打开个股K线弹窗
    const initStock = qs.get('stock');
    if (/^\d{6}$/.test(initStock || '')) {
      openStockChart(initStock);
      const initPeriod = qs.get('period');
      if (initPeriod === 'week' || initPeriod === 'minute') S.chart.period = initPeriod;
      const z = Number(qs.get('zoom'));
      if (z >= 6 && z <= 1000) S.chart._initZoom = Math.round(z);
      const d = qs.get('day');
      if (/^\d{8}$/.test(d || '')) S.chart._initLock = d;
      if (qs.get('colors') === '1') S.klPanelOpen = true;
    }
    refresh(true);
    startTimer();
  }

  // 交易时段由后端按北京时间 + 周末判定（meta.state），比浏览器本地时间可靠。
  // 非交易时段自动暂停刷新，但「立即刷新」始终可用；从非交易切回交易时自动恢复一次。
  const TRADING_STATES = ['盘中', '集合竞价'];
  function isTradingNow() {
    const st = S.data && S.data.meta && S.data.meta.state;
    if (st) return TRADING_STATES.indexOf(st) >= 0;
    // 首屏尚无 meta.state 时，用北京时间（UTC+8）按交易日历机械兜底
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return false;
    const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
    return (hm >= 915 && hm <= 1130) || (hm >= 1300 && hm <= 1500);
  }
  function refreshCountdown() {
    const el = $('countdown');
    if (!el) return;
    if (S.freq <= 0) { el.textContent = '已暂停'; el.title = '自动刷新已手动关闭'; return; }
    if (!isTradingNow()) {
      const st = (S.data && S.data.meta && S.data.meta.state) || '非交易时段';
      el.textContent = '已暂停（' + st + '）';
      el.title = st + '，行情不再变动，自动刷新已暂停；可点「立即刷新」手动拉取。';
      return;
    }
    el.textContent = Math.max(0, S.freq - S.tick) + ' 秒';
    el.title = '每 ' + S.freq + ' 秒自动刷新；非交易时段自动暂停';
  }
  function startTimer() {
    if (S.timer) clearInterval(S.timer);
    S.timer = setInterval(() => {
      if (S.freq <= 0 || !isTradingNow()) { refreshCountdown(); return; }
      S.tick++;
      if (S.tick >= S.freq) { S.tick = 0; refresh(false); }
      refreshCountdown();
    }, 1000);
    S.tick = 0;
    refreshCountdown();
  }

  function resetFilters() {
    S.boards = new Set(['全部']);
    [...$('boardChips').children].forEach(c => c.classList.toggle('active', c.dataset.board === '全部'));
    ['capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'keyword'].forEach(id => $(id).value = '');
    $('sectorSelect').value = ''; $('boardsMin').value = ''; $('sortSel').value = 'score'; $('excludeST').checked = true;
    [...$('capQuick').children].forEach(c => c.classList.remove('active'));
    refresh(true);
  }

  async function loadBoards() {
    try {
      const j = await fetch('/api/boards').then(r => r.json());
      S.boardsList = j;
      const sel = $('sectorSelect');
      const groups = [
        ['行业板块', j.industry || []],
        ['概念板块', j.concept || []]
      ];
      let html = '<option value="">全板块</option>';
      groups.forEach(([label, list]) => {
        html += '<optgroup label="' + E(label) + '">';
        list.slice(0, 200).forEach(b => {
          html += '<option value="' + E(b.node) + '">' + E(b.name) + '（' + (b.pct > 0 ? '+' : '') + N(b.pct) + '%）</option>';
        });
        html += '</optgroup>';
      });
      sel.innerHTML = html;
    } catch (e) { /* 板块列表失败不阻塞主流程 */ }
  }

  function collectFilters() {
    const b = S.boards.has('全部') ? '全部' : [...S.boards].join(',');
    return {
      board: b,
      capMin: $('capMin').value, capMax: $('capMax').value,
      pctMin: $('pctMin').value, pctMax: $('pctMax').value,
      turnoverMin: $('turnoverMin').value, turnoverMax: $('turnoverMax').value,
      boardsMin: $('boardsMin').value,
      sector: $('sectorSelect').value,
      keyword: $('keyword').value.trim(),
      excludeST: $('excludeST').checked ? '1' : '0',
      sort: $('sortSel').value,
      limit: '80'
    };
  }

  function pricesOf(d) {
    const m = {};
    if (!d) return m;
    const scan = arr => (arr || []).forEach(x => { if (x && x.code && x.price !== null && x.price !== undefined) m[x.code] = Number(x.price); });
    scan(d.picks); scan(d.lowbuy);
    if (d.opportunities) { scan(d.opportunities.zt); scan(d.opportunities.qs); scan(d.opportunities.zb); scan(d.opportunities.dt); }
    return m;
  }
  function flashCls(code, price) {
    const p = S.prevPrices[code];
    if (p === undefined || price === null || price === undefined || !Number.isFinite(Number(price))) return '';
    const n = Number(price);
    return n > p ? 'flash-up' : (n < p ? 'flash-down' : '');
  }

  async function refresh(force) {
    const f = collectFilters();
    const q = new URLSearchParams();
    Object.keys(f).forEach(k => { if (f[k] !== '' && f[k] !== undefined) q.set(k, f[k]); });
    if (force) q.set('force', '1');
    $('btnRefresh').disabled = true;
    try {
      const r = await fetch('/api/dashboard?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      S.prevPrices = pricesOf(S.data);
      S.data = j;
      S.lastFilters = describeFilters(f);
      render();
      // 新模块走独立 API：仅在该 tab 可见、筛选变化或超过 60 秒时才重新扫描，避免拖累 15 秒主看板刷新
      if (S.tab === 'pullback' && Date.now() - S.pullAt > 12000 &&
        (S.pullFilters !== S.lastFilters || Date.now() - S.pullAt > 60000)) loadPullback(false);
      if (S.tab === 'dragon' && Date.now() - S.dgAt > 12000 &&
        (S.dgFilters !== S.lastFilters || Date.now() - S.dgAt > 60000)) loadDragon(false);
      $('loading').classList.add('hide');
      $('alertBox').style.display = 'none';
    } catch (e) {
      $('loading').classList.add('hide');
      $('alertBox').style.display = '';
      $('alertBox').textContent = '数据加载失败：' + e.message + '。' +
        (isConnError(e)
          ? SERVICE_HINT + ' 可点击「立即刷新」重试。'
          : '可点击「立即刷新」重试；若上游接口临时不可用，系统会在恢复后自动重新拉取。');
    } finally {
      $('btnRefresh').disabled = false;
      S.tick = 0;
      refreshCountdown(); // 交易状态变化后，立即同步「下次刷新」显示
    }
  }

  function describeFilters(f) {
    const out = [];
    out.push('市场=' + (f.board || '全部'));
    if (f.capMin || f.capMax) out.push('流通市值=' + (f.capMin || '0') + '~' + (f.capMax || '∞') + '亿');
    if (f.sector) out.push('板块=' + (S.data && S.data.meta ? S.data.meta.sectorLabel : f.sector));
    if (f.pctMin || f.pctMax) out.push('涨幅=' + (f.pctMin || '-∞') + '~' + (f.pctMax || '∞') + '%');
    if (f.turnoverMin || f.turnoverMax) out.push('换手=' + (f.turnoverMin || '0') + '~' + (f.turnoverMax || '∞') + '%');
    if (f.boardsMin) out.push('连板≥' + f.boardsMin);
    if (f.keyword) out.push('关键字=' + f.keyword);
    if (f.excludeST === '1') out.push('排除ST');
    return out.join(' · ');
  }

  function switchTab(t) {
    S.tab = t;
    [...$('tabs').children].forEach(c => c.classList.toggle('active', c.dataset.tab === t));
    ['review', 'picks', 'live', 'lowbuy', 'relay', 'ai', 'pullback', 'dragon', 'auction', 'enlighten'].forEach(k => $('pane-' + k).classList.toggle('active', k === t));
    if (t === 'pullback' && !S.pull && !S.pullLoading) loadPullback(false);
    if (t === 'dragon') {
      const histParam = new URLSearchParams(location.search).get('hist');
      if (histParam && /^\d{8}$/.test(histParam)) {
        S.dgHistOpen = true;
        loadDragonHistory(histParam, false);
      } else if (!S.dg && !S.dgLoading) loadDragon(false);
      if (!S.dgHistOpen) setTimeout(startNewsMonitor, 0);
    } else stopNewsMonitor();
    if (t === 'enlighten' && !S.en && !S.enLoading) loadEnlightenment(false);
    if (t === 'auction' && !S.auction && !S.auctionLoading) loadAuction(false);
    setTimeout(() => { Object.values(S.charts || {}).forEach(c => { try { c.resize(); } catch (e) { } }); }, 60);
  }

  /* ─────────────── 渲染入口 ─────────────── */
  function render() {
    const d = S.data, m = d.meta, ov = d.overview;
    renderMeta(m, ov);
    renderKPI(m, ov);
    renderConclusion(m, ov);
    renderReview(d);
    renderPicks(d);
    renderLive(d);
    renderLowBuy(d);
    renderRelay(d);
    renderAI(d);
    renderFooter(d);
    $('filterSummary').textContent = '当前：' + S.lastFilters;
    $('badgePicks').textContent = (d.picks || []).length;
    $('badgeLive').textContent = ov.limitUp + ' 涨停';
    $('badgeLow').textContent = (d.lowbuy || []).length;
    $('badgeRelay').textContent = ((d.relay && d.relay.list) || []).length;
    $('badgeAI').textContent = m.aiConfigured ? '已接模型' : '本地';
    if (S.pull) $('badgePull').textContent = (S.pull.list || []).length;
    if (S.en) $('badgeEn').textContent = (S.en.best ? String(S.en.best.name).slice(0, 6) : '已回测');
    if (S.auction) $('badgeAuction').textContent = (S.auction.list || []).length || '—';
  }

  function renderMeta(m, ov) {
    $('tradeState').textContent = m.state;
    $('tradeState').title = m.note + '；' + m.caveat;
    $('dataTime').textContent = (m.quoteTick || m.universeTick || m.now.slice(11, 19)) + ' / ' + (m.poolDate || '—');
    $('dataTime').title = '腾讯实时快照：' + (m.quoteTick || '—') + '；新浪全市场快照：' + (m.universeTick || '—') + '；涨停池交易日：' + (m.poolDate || '—') + '；服务端生成：' + m.generatedAt;
    const hs = activeHealth(m), ok = hs.filter(h => h.ok).length;
    const pill = $('healthPill');
    pill.textContent = ok + '/' + hs.length + ' 在线';
    pill.style.color = ok === hs.length ? 'var(--down)' : (ok === 0 ? 'var(--up)' : 'var(--warn)');
  }

  function renderKPI(m, ov) {
    const idx = ov.indices || [];
    const cells = idx.slice(0, 4).map(i => {
      const c = i.pct > 0 ? 'up' : i.pct < 0 ? 'down' : 'flat';
      return '<div class="kpi"><span class="lbl">' + E(i.name) + '</span><div class="big ' + c + ' num">' + N(i.price) + '</div><div class="sub ' + c + '">' + (i.pct > 0 ? '+' : '') + N(i.pct) + '%</div></div>';
    });
    const extra = [
      { lbl: '涨停 / 跌停', big: ov.limitUp + ' / ' + ov.limitDown, sub: '炸板 ' + ov.broken + ' 家 · 率 ' + N(ov.breakRate, 1) + '%', cls: 'up' },
      { lbl: '最高连板', big: ov.maxBoard + ' 板', sub: ov.gap ? '梯队有断层' : '梯队无断层', cls: 'up' },
      { lbl: '涨跌家数', big: ov.up + ' / ' + ov.down, sub: '广度 ' + N(ov.breadth, 1) + '%', cls: ov.up >= ov.down ? 'up' : 'down' },
      { lbl: '市场档位', big: ov.tier, sub: '情绪：' + ov.emotion, cls: ov.tier === '进攻' ? 'up' : (ov.tier === '防守' ? 'down' : '') }
    ];
    extra.forEach(x => cells.push('<div class="kpi"><span class="lbl">' + x.lbl + '</span><div class="big ' + x.cls + '">' + x.big + '</div><div class="sub">' + E(x.sub) + '</div></div>'));
    $('kpiStrip').innerHTML = cells.join('');
  }

  function renderConclusion(m, ov) {
    const lead = '当前市场判定为「' + ov.tier + '」档，情绪「' + ov.emotion + '」：' + ov.tierNote + '。' + ov.emotionNote + '。';
    const tags = [
      tag('数据时点 ' + TICK(m), 'blue'),
      tag('交易日 ' + (m.poolDate || '—'), 'blue'),
      tag(m.state, 'blue'),
      tag('全市场 ' + ov.universeCount + ' 只', ''),
      tag('强势股池 ' + (ov.strongStocks || 0) + ' 只', ''),
      tag('数据源 ' + activeHealth(m).filter(h => h.ok).length + '/' + activeHealth(m).length + ' 在线', activeHealth(m).every(h => h.ok) ? 'green' : 'warn')
    ];
    $('conclusionCard').style.display = '';
    $('conclusionCard').innerHTML = '<div class="lead">' + E(lead) + '<div class="small muted" style="font-weight:400;margin-top:5px">' + E(m.note) + '；本页所有数字为行情快照，盘中可能存在秒级延迟。</div></div><div class="tags">' + tags.join('') + '</div>';
  }

  /* ─────────────── 图表 ─────────────── */
  function fallbackBars(items) {
    const max = Math.max(1, ...items.map(x => Math.abs(x.value)));
    return '<div style="padding:8px">' + items.map(x =>
      '<div style="margin-bottom:9px"><div style="display:flex;justify-content:space-between;font-size:11.5px"><span>' + E(x.name) + '</span><b>' + E(x.label !== undefined ? x.label : x.value) + '</b></div>' +
      '<div class="bar-bg"><div class="bar-fill" style="width:' + (Math.abs(x.value) / max * 100).toFixed(1) + '%;background:' + (x.color || '#2f6fd0') + '"></div></div></div>'
    ).join('') + '</div>';
  }
  function safeChart(id, option, fbItems) {
    const el = $(id); if (!el) return;
    if (!window.echarts) { el.innerHTML = fbItems ? fallbackBars(fbItems) : '<div class="empty">图表库未加载（不影响数据表格）</div>'; return; }
    try {
      let inst = window.echarts.getInstanceByDom(el);
      if (!inst) inst = window.echarts.init(el);
      inst.setOption(option, true);
    } catch (e) { el.innerHTML = fbItems ? fallbackBars(fbItems) : '<div class="empty">图表渲染失败</div>'; }
  }
  const AXIS = { axisLine: { lineStyle: { color: '#dbe3ec' } }, axisLabel: { color: '#6b7a8c', fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } } };

  /* ─────────────── 复盘计划 ─────────────── */
  function renderReview(d) {
    const ov = d.overview, rv = d.review, m = d.meta;
    const facts = rv.facts.map(f => '<div class="fact"><div class="fl">' + E(f.label) + '</div><div class="fv">' + E(f.value) + '<div class="fn">' + E(f.note) + '</div></div></div>').join('');

    // 东方财富式「连板天梯」：按板级从高到低分层，每层列出该板个股卡片
    const ladderItems = Object.keys(ov.ladder).sort((a, b) => b - a).map(b => ({
      name: b + '板', value: ov.ladder[b], label: ov.ladder[b] + ' 家', color: '#d92b2b'
    }));
    const space = ov.spaceBoard.length ? ov.spaceBoard.map(x => E(x.name) + '(' + E(x.code) + ') ' + x.boards + '板 · ' + E(x.industry)).join('；') : '无';
    // 天梯数据源：若用户选了历史日期，用 /api/ladder 返回的该日涨停池；否则用当日实时池
    const ladderIsHistory = !!(S.ladderDate && S.ladderData && S.ladderData.date === S.ladderDate);
    const ztAll = ladderIsHistory ? (S.ladderData.zt || []) : ((d.opportunities && d.opportunities.zt) || []);
    const byBoard = new Map();
    ztAll.forEach(x => { const b = Number(x.boards) || 1; if (!byBoard.has(b)) byBoard.set(b, []); byBoard.get(b).push(x); });
    const boardOfCell = b => b >= 5 ? 'em-tier-5' : b === 4 ? 'em-tier-4' : b === 3 ? 'em-tier-3' : b === 2 ? 'em-tier-2' : 'em-tier-1';
    // 板块地位：同行业涨停股内，按「连板高度 + 封单强度 + 累计涨停次数 + 首封时间」机械判定
    const sectorMap = new Map();
    ztAll.forEach(x => { const k = x.industry || '未分类'; if (!sectorMap.has(k)) sectorMap.set(k, []); sectorMap.get(k).push(x); });
    const sectorRole = new Map();
    sectorMap.forEach((list, ind) => {
      const bOf = x => Number(x.boards) || 1, sOf = x => Number(x.sealFundRatio) || 0;
      const cOf = x => Number(x.statCount) || bOf(x);
      const maxB = Math.max(...list.map(bOf)), maxS = Math.max(...list.map(sOf)), maxC = Math.max(...list.map(cOf));
      list.forEach(x => {
        let role = '', reason = '';
        if (list.length === 1) { role = '独苗'; reason = '行业内当日仅此 1 只涨停，无板块效应'; }
        else if (bOf(x) === maxB && maxB >= 2 && sOf(x) === maxS) { role = '板块龙头'; reason = '行业内连板最高 ' + bOf(x) + ' 板且封单比最强 ' + N(maxS) + '%'; }
        else if (cOf(x) === maxC && maxC > bOf(x) && cOf(x) >= 3) { role = '反包核心'; reason = '累计 ' + x.statDays + ' 天 ' + cOf(x) + ' 板，为行业内累计涨停最多'; }
        else if (bOf(x) === maxB && maxB >= 2) { role = '题材龙'; reason = '行业内连板最高 ' + bOf(x) + ' 板，但封单比非最强'; }
        else if (sOf(x) === maxS && maxS > 0) { role = '封单核心'; reason = '行业内封单比最强 ' + N(maxS) + '%（' + bOf(x) + ' 板）'; }
        else if (bOf(x) >= 2) { role = '板块跟风'; reason = bOf(x) + ' 板，低于行业最高 ' + maxB + ' 板'; }
        else { role = '首板跟随'; reason = '首板，行业共 ' + list.length + ' 只涨停'; }
        sectorRole.set(x.code, { role, reason, count: list.length, maxB });
      });
    });
    const roleCls = r => r === '板块龙头' ? 'lead' : r === '反包核心' || r === '题材龙' || r === '封单核心' ? 'core' : r === '独苗' ? 'solo' : '';
    const stockCell = x => {
      const seal = Number(x.sealFundRatio) || 0, br = Number(x.brokenCount) || 0;
      const cls = seal >= 1 ? 'em-seal strong' : seal >= 0.3 ? 'em-seal mid' : 'em-seal weak';
      const sealCls = br === 0 ? 'em-br none' : br <= 2 ? 'em-br some' : 'em-br many';
      const sr = sectorRole.get(x.code) || { role: '', reason: '' };
      const edge = dgEdgeOf(x.dragonEdge);
      const ttl = x.name + '(' + x.code + ') · ' + (x.industry || '—') + '\n板块地位：' + sr.role + '（' + sr.reason + '）' +
        (edge ? '\n历史优势组合：' + dgEdgeTitle(edge) : '');
      return '<div class="em-stock' + (edge ? ' dg-edge edge-' + E(edge.key) + '" data-edge-corner="★ ' + E(edge.label) + ' ' + E(edge.rate) + '" style="' + dgEdgeStyle(edge) : '') + '" title="' + E(ttl) + '">' +
        '<div class="em-stock-head"><b>' + sn(x.code, x.name) + '</b><span class="em-code">' + E(x.code) + '</span></div>' +
        '<div class="em-stock-ind">' + E(x.industry || '—') +
        (sr.role ? '<span class="em-role ' + roleCls(sr.role) + '">' + E(sr.role) + '</span>' : '') + '</div>' +
        '<div class="em-stock-meta"><span>首封 ' + E(x.firstSeal || '—') + '</span>' +
        '<span class="' + cls + '">封 ' + N(seal) + '%</span></div>' +
        '<div class="em-stock-meta"><span class="' + sealCls + '">' + (br === 0 ? '零炸板' : '炸板 ' + br + ' 次') + '</span>' +
        '<span>换手 ' + N(x.turnover) + '%</span></div></div>';
    };
    const tiersHtml = [...byBoard.keys()].sort((a, b) => b - a).map(b => {
      const list = byBoard.get(b).slice().sort((a, c) =>
        (Number(c.sealFundRatio) || 0) - (Number(a.sealFundRatio) || 0) ||
        String(a.firstSeal || '').localeCompare(String(c.firstSeal || '')));
      return '<div class="em-tier ' + boardOfCell(b) + '"><div class="em-tier-head">' +
        '<span class="em-tier-badge">' + b + '板</span><span class="em-tier-count">' + list.length + ' 家</span>' +
        (b === Number(ov.maxBoard) && b >= 2 ? '<span class="em-tier-mark">空间板</span>' : '') +
        '</div><div class="em-stocks">' + list.map(stockCell).join('') + '</div></div>';
    }).join('');

    const themes = (rv.topThemes || []).map(t =>
      '<div class="info-card theme-card"><h4>' + E(t.name) + ' <span class="mini-tag">' + t.count + ' 只涨停</span></h4>' +
      '<div class="theme-meta">' + tag('最高 ' + t.maxBoard + ' 板', 'red') + tag(t.stage, 'purple') + tag('预期：' + t.outlook, t.outlookScore >= 3 ? 'red' : 'warn') + (t.gap ? tag('梯队断层', 'warn') : '') + '</div>' +
      '<p><b>阶段依据：</b>' + E(t.stageBasis) + '</p>' +
      '<p style="margin-top:5px"><b>持续性：</b>' + E(t.outlookBasis) + '</p>' +
      (t.boardRef ? '<p style="margin-top:5px"><b>板块参照：</b>' + E(t.boardRef.name) + ' ' + (t.boardRef.pct > 0 ? '+' : '') + N(t.boardRef.pct) + '%，领涨 ' + E(t.boardRef.leaderName) + '（新浪财经板块行情）</p>' : '') +
      '</div>'
    ).join('');

    const focus = (rv.focus || []).map((f, i) => '<div class="info-card"><h4>' + tag('焦点 ' + (i + 1), 'blue') + ' ' + E(f.title) + '</h4><p>' + E(f.text) + '</p></div>').join('');

    const planRows = (rv.playbook || []).map(p =>
      '<div class="plan-row"><div class="col"><span class="cl">触发条件</span>' + E(p.condition) + '</div>' +
      '<div class="col"><span class="cl">对应动作</span>' + E(p.action) + '</div>' +
      '<div class="col"><span class="cl">风险 / 反例</span>' + E(p.risk) + '</div></div>'
    ).join('');

    const risks = (rv.risks || []).map(r => '<li>' + E(r) + '</li>').join('');

    // 昨日连板天梯今日晋级情况（已发生事实）
    const pl = d.prevLadder || {};
    const plSummary = pl.summary || {};
    const plTiers = (pl.tiers || []).map(t =>
      '<div class="pl-tier"><div class="pl-tier-head"><span class="pl-badge">' + E(t.boards) + '板</span>' +
      '<span class="pl-cnt">昨 ' + E(t.total) + ' 家</span><span class="pl-rate">晋级 ' + E(t.promoted) + ' / ' + E(t.rate) + '%</span>' +
      '<span class="pl-avg ' + (t.avgPct > 0 ? 'up' : t.avgPct < 0 ? 'down' : '') + '">今日均涨 ' + (t.avgPct > 0 ? '+' : '') + N(t.avgPct) + '%</span>' +
      (t.limitDown ? tag('跌停 ' + t.limitDown, 'green') : '') + '</div>' +
      '<div class="pl-stocks">' + t.stocks.map(x =>
        '<span class="pl-stock ' + x.cls + '" title="' + E(x.code + ' · ' + (x.industry || '—') + ' · 昨' + x.prevBoards + '板 → 今' + (x.currBoards ? x.currBoards + '板' : x.status)) + '">' +
        E(x.name) + '<b>' + (x.pct === null ? '—' : (x.pct > 0 ? '+' : '') + N(x.pct) + '%') + '</b>' +
        '<i>' + E(x.status) + '</i></span>').join('') + '</div></div>').join('');
    // 资金方向 + 行业板块 / 概念板块分析（数据：新浪资金流 + 新浪板块行情）
    const ff = d.fundFlow || {}, ffBoards = ff.boards || [];
    const amtYi = v => (Number(v) / 1e8).toFixed(2);
    const fundTop = ffBoards.slice(0, 8), fundBottom = ffBoards.slice(-6).reverse();
    const fundRow = x => '<div class="ff-row"><span class="ff-name">' + E(x.name) + '</span>' +
      '<span class="ff-pct ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + (x.pct > 0 ? '+' : '') + N(x.pct) + '%</span>' +
      '<span class="ff-net ' + (x.net > 0 ? 'up' : 'down') + '">' + (x.net > 0 ? '+' : '') + amtYi(x.net) + ' 亿</span></div>';
    const bk = d.boards || {}, indBoards = bk.industry || [], conBoards = bk.concept || [];
    const boardRows = list => list.slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0)).slice(0, 8).map(x =>
      '<div class="bk-row"><span class="bk-name">' + E(x.name) + '</span>' +
      '<span class="bk-pct ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + (x.pct > 0 ? '+' : '') + N(x.pct) + '%</span>' +
      '<span class="bk-lead">' + (x.leaderName ? E(x.leaderName) + ' ' + (x.leaderPct > 0 ? '+' : '') + N(x.leaderPct) + '%' : '—') + '</span>' +
      '<span class="bk-mem">' + E(x.members || 0) + ' 只</span></div>').join('');
    const fundHtml = '<div class="sec"><div class="sec-head"><h3>二、资金方向 · 板块与概念分析</h3>' +
      src((ff.source || '资金流向') + ' / 新浪财经行业·概念板块行情，' + (m.poolDate || '—') + ' ' + TICK(m)) + '</div>' +
      '<div class="grid2">' +
      '<div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">主力资金方向（行业净流入 Top / 净流出 Top）</h4>' +
      (ffBoards.length
        ? '<div class="ff-grid"><div><div class="ff-col-head up">净流入前 8</div>' + fundTop.map(fundRow).join('') + '</div>' +
          '<div><div class="ff-col-head down">净流出前 6</div>' + fundBottom.map(fundRow).join('') + '</div></div>' +
          '<div class="note-box">行业净流入合计 <b class="' + (ff.totalNet > 0 ? 'up' : 'down') + '">' + (ff.totalNet === null ? '—' : amtYi(ff.totalNet) + ' 亿') +
          '</b>；净流入行业 ' + E(ff.upBoards) + ' 个 / 净流出 ' + E(ff.downBoards) + ' 个。' +
          '<br>口径：' + (ff.source && ff.source.indexOf('腾讯') >= 0
            ? '腾讯证券板块资金流（zljlr 主力净流入，盘中实时），正为净流入、负为净流出。'
            : '新浪按特大单/大单/中单/小单划分，netamount = 流入−流出；正为净买入、负为净流出。') +
          '仅代表当日成交单的方向统计，不等于资金长期意图。</div>'
        : '<div class="empty">' + E(ff.reason || '资金流数据暂不可用') + '</div>') + '</div>' +
      '<div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">板块涨幅与领涨股</h4>' +
      '<div class="ff-col-head">行业板块 Top 8</div><div class="bk-list">' + (boardRows(indBoards) || '<div class="empty">无行业板块数据</div>') + '</div>' +
      '<div class="ff-col-head" style="margin-top:10px">概念板块 Top 8</div><div class="bk-list">' + (boardRows(conBoards) || '<div class="empty">无概念板块数据</div>') + '</div>' +
      (ff.concept && ff.concept.length
        ? '<div class="ff-col-head" style="margin-top:10px">概念资金方向 Top 6</div>' +
          '<div class="ff-grid">' +
          '<div>' + ff.concept.slice().sort((a, b) => b.net - a.net).slice(0, 6).map(fundRow).join('') + '</div>' +
          '<div>' + ff.concept.slice().sort((a, b) => a.net - b.net).slice(0, 6).map(fundRow).join('') + '</div></div>'
        : '') +
      '</div></div>' +
      '<div class="note-box">板块涨跌幅与领涨股为新浪财经公开板块行情；资金流主源为腾讯证券、新浪为备用（新浪接口近期不稳定）。涨停题材分组见下一节「主线题材与生命周期」。资金流与板块行情均为公开接口的当日快照，<b>不构成投资建议</b>。</div></div>';

    const prevLadderHtml = '<div class="sec"><div class="sec-head"><h3>昨日连板天梯 · 今日晋级情况</h3>' +
      src('东方财富历史涨停池 ' + (pl.prevDate || '—') + ' → 今日涨停池 ' + (pl.currDate || '—') + ' + 腾讯证券实时快照') + '</div>' +
      (pl.available && (pl.tiers || []).length
        ? '<div class="card pad"><div class="pl-summary">' +
          tag('昨日连板 ' + (plSummary.total || 0), 'blue') +
          tag('晋级 ' + (plSummary.promoted || 0) + ' (' + (plSummary.rate === null ? '—' : plSummary.rate + '%') + ')', 'red') +
          tag('回封 ' + (plSummary.relimit || 0), 'warn') +
          tag('断板收红 ' + (plSummary.up || 0), 'red') +
          tag('断板收绿 ' + (plSummary.down || 0), 'green') +
          tag('跌停 ' + (plSummary.limitDown || 0), 'green') +
          tag('平均涨幅 ' + (plSummary.avgPct === null ? '—' : ((plSummary.avgPct > 0 ? '+' : '') + N(plSummary.avgPct) + '%')), plSummary.avgPct > 0 ? 'red' : 'green') +
          '</div><div class="pl-tiers">' + plTiers + '</div>' +
          '<div class="note-box">' + E(pl.note || '') +
          '<br>晋级＝今日仍在涨停池且连板数高于昨日；回封＝今日涨停但连板数未增加；断板＝今日未涨停（按实时涨跌幅分收红 / 收绿 / 跌停）。' +
          '<b>这是已经发生的市场事实统计，不是买入信号，也不预测明日表现。</b></div></div>'
        : '<div class="card empty">' + E(pl.reason || '昨日连板晋级数据暂不可用') + '</div>') + '</div>';

    $('pane-review').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>一、盘面结构与状态诊断</h3>' + src('新浪财经全市场快照 / 腾讯证券指数 / 东方财富涨停池，时点 ' + TICK(m)) + '</div>' +
      '<div class="grid2"><div class="card pad"><div class="fact-list">' + facts + '</div></div>' +
      '<div class="card pad"><div class="em-ladder-head"><h4 style="font-size:12.5px;margin-bottom:6px">连板天梯 <span class="small muted" style="font-weight:400">（东方财富式 · 按板级分层）</span></h4>' +
      '<select class="sel" id="ladderDate" title="切换交易日回看历史连板天梯">' +
      (S.ladderDates.length
        ? S.ladderDates.map(x => '<option value="' + E(x.date) + '"' + (x.date === (S.ladderDate || (m.poolDate || '')) ? ' selected' : '') + '>' +
          E(String(x.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) + '（' + x.count + ' 涨停）</option>').join('')
        : '<option value="' + E(m.poolDate || '') + '">' + E(m.poolDate || '当日') + '</option>') +
      '</select></div>' +
      (ladderIsHistory && S.ladderDate !== m.poolDate ? '<div class="note-box" style="margin:0 0 8px">历史回放：' +
        E(String(S.ladderDate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) + ' 的涨停池（来源：' + E(S.ladderData.source || '东方财富') +
        '），板块地位按当日涨停结构判定。<b>这是已发生的历史行情，不是今日机会。</b></div>' : '') +
      '<div class="em-ladder">' + (S.ladderLoading ? '<div class="empty">载入历史天梯…</div>' : (tiersHtml || '<div class="empty">当日无连板梯队数据</div>')) + '</div>' +
      dgEdgeLegendCard(true) +
      '<div class="note-box">空间板：' + space + '<br>梯队判读：' + E(ov.gap ? '存在断层，按 leader-game 框架属退潮前置信号，需次日 2/3 板补齐确认。' : '梯队连续无断层，情绪延续性优于断层结构。') +
      '<br>板块地位标注规则（按东财行业分组机械判定，非投资建议）：<b class="up">板块龙头</b>=同行业连板最高且封单最强；<b style="color:var(--warn)">反包核心 / 题材龙 / 封单核心</b>=累计板最高 / 连板最高 / 封单最强但不同时满足龙头条件；板块跟风=连板低于行业最高；独苗=行业仅 1 只涨停。<br>每层按封单比降序、首封时间升序排列；封单比 ≥1% 标红、0.3%~1% 标橙、&lt;0.3% 标灰，炸板次数越多风险越高。数据：东方财富涨停池 + 腾讯证券实时快照。' +
      '</div></div></div></div>' +
      fundHtml +
      prevLadderHtml +

      '<div class="sec"><div class="sec-head"><h3>三、主线题材与生命周期</h3>' + src('东方财富涨停池行业归属 + 新浪财经板块行情，交易日 ' + (m.poolDate || '—')) + '</div>' +
      '<div class="grid2">' + (themes || '<div class="empty">当前无涨停题材分组数据</div>') + '</div>' +
      '<div class="note-box">题材阶段完全由量价结构（涨停扩散数 / 连板高度 / 梯队完整度 / 炸板负反馈率 / 板块涨跌幅）机械推导，本页评分不纳入新闻与公告数据（消息面见「明日龙头」模块独立监控）；阶段判断为前瞻性推演，需次日盘面验证。</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>四、明日博弈焦点</h3><span class="src">依据：leader-game 涨停结构 + theme-lifecycle 阶段研判</span></div><div class="grid3">' + focus + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>五、条件化操作框架</h3><span class="src">条件 → 动作 → 风险，非买卖指令</span></div>' +
      '<div class="card pad"><div class="plan-row plan-head"><div class="col">触发条件</div><div class="col">对应动作</div><div class="col">风险 / 反例</div></div>' + planRows + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>六、风险提示与数据边界</h3></div><div class="card pad"><ul class="tight">' + risks + '</ul>' +
      '<div class="note-box">本模块为复盘与观察框架，不预测指数涨跌方向；所有仓位表述均为研究框架示例，需结合个人风险承受能力独立判断。</div></div></div>';

    const ladderOpt = {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 14, top: 18, bottom: 26 },
      xAxis: { type: 'category', data: ladderItems.map(x => x.name), ...AXIS },
      yAxis: { type: 'value', ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 38, data: ladderItems.map(x => ({ value: x.value, itemStyle: { color: '#d92b2b' } })), label: { show: true, position: 'top', color: '#4b5b6b', fontSize: 10 } }]
    };
    safeChart('chartLadder', ladderOpt, ladderItems);
    const lsel = $('ladderDate');
    if (lsel) lsel.onchange = e => loadLadderDate(e.target.value);
  }

  /** 切换连板天梯交易日：拉历史涨停池，只重渲染复盘区 */
  async function loadLadderDate(date) {
    const d = String(date || '');
    if (!/^\d{8}$/.test(d)) return;
    S.ladderDate = d;
    S.ladderLoading = true;
    renderReview(S.data); // 立刻显示载入态
    try {
      const r = await fetch('/api/ladder?date=' + encodeURIComponent(d), { cache: 'no-store' });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      S.ladderData = j;
      if (!S.ladderDates.length && j.dates) S.ladderDates = j.dates;
    } catch (e) {
      S.ladderData = null;
      $('alertBox').style.display = '';
      $('alertBox').textContent = '历史天梯加载失败：' + e.message;
    } finally {
      S.ladderLoading = false;
      renderReview(S.data);
    }
  }

  /** 首屏拉取可用交易日列表（轻量，只返回日期与家数） */
  async function initLadderDates() {
    try {
      const r = await fetch('/api/ladder', { cache: 'no-store' });
      const j = await r.json();
      if (!j.error && j.dates) S.ladderDates = j.dates;
    } catch (e) { /* 日期列表非关键，失败则下拉只有当日 */ }
  }

  /* ─────────────── 短线推荐 ─────────────── */
  function renderPicks(d) {
    const rows = d.picks || [], m = d.meta;
    const head = '<thead><tr><th class="left">代码 / 名称</th><th>板块</th><th>现价</th><th>涨跌幅</th><th>连板</th><th>流通市值</th><th>换手</th><th>成交额</th><th>封单/流通</th><th class="left">题材 / 阶段</th><th>评分</th><th class="left">结论</th></tr></thead>';
    const body = rows.map((x, i) => {
      const parts = (x.scoreParts || []).map(p =>
        '<div class="sp"><span class="spn">' + E(p.factor) + '</span><div class="spb"><div class="spf" style="width:' + (p.max ? Math.max(0, Math.min(100, p.got / p.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(p.got) + '/' + E(p.max) + '</span></div>'
      ).join('');
      const detail = '<div class="grid2" style="gap:18px"><div><h4 style="font-size:12px;margin-bottom:7px">评分拆解（总分 ' + E(x.score) + ' / 100）</h4><div class="score-parts">' + parts + '</div></div>' +
        '<div><h4 style="font-size:12px;margin-bottom:7px">风险标签与观察条件</h4>' +
        ((x.risks || []).length ? '<ul class="tight">' + x.risks.map(r => '<li>' + E(r) + '</li>').join('') + '</ul>' : '<div class="small muted">无触发式风险标签</div>') +
        '<div class="note-box">评分由动量、题材热度、封板质量、量能、市值位置、日内强弱六个可量化因子加总；仅为排序依据，不代表收益预期。需等待回踩企稳与板块支持确认。</div></div></div>';
      const vcls = x.verdict === '重点观察' ? 'red' : (x.verdict === '可跟踪' ? 'warn' : '');
      return '<tr class="clickable" data-pick="' + E(x.code) + '">' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') + (x.isST ? ' <span class="mini-tag">ST</span>' : '') + '</td>' +
        '<td><span class="mini-tag">' + E(x.board || '—') + '</span></td>' +
        '<td class="' + flashCls(x.code, x.price) + '">' + N(x.price) + '</td>' +
        '<td>' + PC(x.pct) + '</td><td>' + (x.boards || 1) + '</td>' +
        '<td>' + CAP(x.floatCap) + '</td><td>' + N(x.turnover, 1) + '%</td><td>' + AMT(x.amount) + '</td>' +
        '<td>' + (x.sealFundRatio === null || x.sealFundRatio === undefined ? '—' : N(x.sealFundRatio) + '%') + '</td>' +
        '<td class="left">' + E(x.themeName || x.industry || '—') + (x.themeStage ? ' <span class="mini-tag">' + E(x.themeStage) + '</span>' : '') + '</td>' +
        '<td><b class="' + (x.score >= 72 ? 'up' : '') + '">' + E(x.score) + '</b></td>' +
        '<td class="left">' + tag(x.verdict, vcls) + '</td></tr>' +
        '<tr class="detail-row" id="pickDetail_' + E(x.code) + '" style="display:' + (S.expanded.has(x.code) ? '' : 'none') + '"><td colspan="12">' + detail + '</td></tr>';
    }).join('');

    $('pane-picks').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>短线个股候选池</h3>' + src('候选来自东方财富涨停池 / 强势股池实时交集，字段由腾讯证券快照补全，时点 ' + TICK(m)) + '<span class="spacer"></span><span class="small muted">点击任意行展开评分拆解</span></div>' +
      '<div class="conclusion card" style="margin-bottom:12px;border-left-color:var(--blue2)"><div class="lead">打分口径：动量 20 + 题材热度 20 + 封板质量 20 + 量能 15 + 市值位置 15 + 日内强弱 10 = 100 分。所有因子均由实时行情字段计算，不含主观预设名单。</div><div class="tags">' + tag('共 ' + rows.length + ' 只入池', 'blue') + tag('已应用全局筛选', 'blue') + '</div></div>' +
      '<div class="tbl-wrap"><table>' + head + '<tbody>' + (body || '<tr><td colspan="12" class="empty">当前筛选条件下无匹配标的，请放宽流通市值 / 板块 / 连板条件</td></tr>') + '</tbody></table></div></div>';

    $('pane-picks').querySelectorAll('tr[data-pick]').forEach(tr => {
      tr.onclick = () => {
        const code = tr.dataset.pick, el = $('pickDetail_' + code);
        if (!el) return;
        if (el.style.display === 'none') { el.style.display = ''; S.expanded.add(code); }
        else { el.style.display = 'none'; S.expanded.delete(code); }
      };
    });
  }

  /* ─────────────── 实时机会 ─────────────── */
  function simpleTable(rows, cols, emptyText) {
    if (!rows || !rows.length) return '<div class="empty">' + E(emptyText) + '</div>';
    const head = '<thead><tr>' + cols.map(c => '<th class="' + (c.left ? 'left' : '') + '">' + E(c.t) + '</th>').join('') + '</tr></thead>';
    const body = rows.map(x => '<tr>' + cols.map(c => '<td class="' + (c.left ? 'left ' : '') + (c.flash ? flashCls(x.code, x.price) : '') + '">' + c.f(x) + '</td>').join('') + '</tr>').join('');
    return '<div class="tbl-wrap"><table>' + head + '<tbody>' + body + '</tbody></table></div>';
  }
  const nameCell = x => '<span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm');
  const baseCols = [
    { t: '代码 / 名称', left: true, f: nameCell },
    { t: '板块', f: x => '<span class="mini-tag">' + E(x.board || '—') + '</span>' },
    { t: '现价', flash: true, f: x => N(x.price) },
    { t: '涨跌幅', f: x => PC(x.pct) },
    { t: '流通市值', f: x => CAP(x.floatCap) },
    { t: '换手', f: x => N(x.turnover, 1) + '%' },
    { t: '成交额', f: x => AMT(x.amount) },
    { t: '行业', left: true, f: x => E(x.industry || '—') }
  ];

  function renderLive(d) {
    const o = d.opportunities, m = d.meta, ov = d.overview;
    const indTop = (o.industry || []).slice().sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 10);
    const conTop = (o.concept || []).slice().sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 10);
    const boardTable = list =>
      '<div class="tbl-wrap"><table><thead><tr><th class="left">板块</th><th>涨跌幅</th><th>成分</th><th>成交额</th><th class="left">领涨股</th></tr></thead><tbody>' +
      (list.length ? list.map(b => '<tr><td class="left"><b>' + E(b.name) + '</b></td><td>' + PC(b.pct) + '</td><td>' + E(b.members) + '</td><td>' + AMT(b.amount) + '</td><td class="left">' + E(b.leaderName || '—') + ' <span class="mini-tag">' + PC(b.leaderPct) + '</span></td></tr>').join('') : '<tr><td colspan="5" class="empty">板块数据暂不可用</td></tr>') + '</tbody></table></div>';

    const ztCols = baseCols.concat([
      { t: '连板', f: x => '<b class="up">' + (x.boards || 1) + '</b>' },
      { t: '首封', f: x => E(x.firstSeal || '—') },
      { t: '炸板', f: x => E(x.brokenCount === undefined ? '—' : x.brokenCount) },
      { t: '封单', f: x => YI(x.sealFund) },
      { t: '封单/流通', f: x => (x.sealFundRatio === null || x.sealFundRatio === undefined ? '—' : N(x.sealFundRatio) + '%') }
    ]);
    const qsCols = baseCols.concat([
      { t: '量比', f: x => N(x.volRatio) },
      { t: '涨速', f: x => N(x.zs !== undefined ? x.zs : x.speed) },
      { t: '信号', left: true, f: x => tag(x.signal, 'blue') }
    ]);
    const riskCols = [
      { t: '代码 / 名称', left: true, f: nameCell },
      { t: '现价', flash: true, f: x => N(x.price) },
      { t: '涨跌幅', f: x => PC(x.pct) },
      { t: '流通市值', f: x => CAP(x.floatCap) },
      { t: '换手', f: x => N(x.turnover, 1) + '%' },
      { t: '行业', left: true, f: x => E(x.industry || '—') },
      { t: '风险信号', left: true, f: x => tag(x.signal, 'warn') }
    ];

    $('pane-live').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>实时指数快照</h3>' + src('腾讯证券实时行情，时点 ' + TICK(m)) + '</div>' +
      '<div class="grid4">' + (ov.indices || []).map(i => '<div class="info-card"><h4>' + E(i.name) + '</h4><p><span class="big ' + (i.pct > 0 ? 'up' : i.pct < 0 ? 'down' : '') + '" style="font-size:19px;font-weight:700">' + N(i.price) + '</span> ' + PC(i.pct) + '<br><span class="small muted">振幅 ' + N(i.amplitude) + '% · 量比 ' + N(i.volRatio) + ' · 成交额 ' + (i.amountWan ? (i.amountWan / 10000).toFixed(0) + '亿' : '—') + '</span></p></div>').join('') + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>板块异动榜</h3>' + src('新浪财经行业 / 概念板块实时行情，时点 ' + TICK(m)) + '</div>' +
      '<div class="grid2"><div><div class="sec-head"><h3 style="font-size:12.5px">行业板块 · 涨幅 Top10</h3></div><div id="chartIndustry" class="chart-sm"></div>' + boardTable(indTop) + '</div>' +
      '<div><div class="sec-head"><h3 style="font-size:12.5px">概念板块 · 涨幅 Top10</h3></div><div id="chartConcept" class="chart-sm"></div>' + boardTable(conTop) + '</div></div></div>' +

      '<div class="sec"><div class="sec-head"><h3>涨停池（' + ov.limitUp + ' 家）</h3>' + src('东方财富涨停池，交易日 ' + (m.poolDate || '—') + '；连板数、封单、首封时间均来自该接口') + '</div>' + simpleTable(o.zt, ztCols, '当前筛选条件下无涨停标的') + '</div>' +

      '<div class="sec"><div class="sec-head"><h3>强势股池（' + (o.strongCount || 0) + ' 家）</h3>' + src('东方财富强势股池，交易日 ' + (m.poolDate || '—')) + '</div>' + simpleTable(o.qs, qsCols, '当前筛选条件下无强势股') + '</div>' +

      '<div class="sec"><div class="sec-head"><h3>负反馈监控</h3>' + src('东方财富炸板池 / 跌停池，交易日 ' + (m.poolDate || '—')) + '</div>' +
      '<div class="grid2"><div><div class="sec-head"><h3 style="font-size:12.5px;color:var(--warn)">炸板池 ' + (o.zb || []).length + ' 家</h3></div>' + simpleTable(o.zb, riskCols, '无炸板标的') + '</div>' +
      '<div><div class="sec-head"><h3 style="font-size:12.5px;color:var(--down)">跌停池 ' + (o.dt || []).length + ' 家</h3></div>' + simpleTable(o.dt, riskCols, '无跌停标的') + '</div></div></div>';

    const barOpt = (items, color) => ({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 90, right: 34, top: 8, bottom: 20 },
      xAxis: { type: 'value', ...AXIS },
      yAxis: { type: 'category', data: items.map(x => x.name).reverse(), ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 13, data: items.map(x => x.pct || 0).reverse().map(v => ({ value: v, itemStyle: { color: v >= 0 ? color : '#0f9960' } })), label: { show: true, position: 'right', formatter: '{c}%', fontSize: 10, color: '#4b5b6b' } }]
    });
    const indItems = indTop.map(b => ({ name: b.name, value: b.pct || 0, label: (b.pct > 0 ? '+' : '') + N(b.pct) + '%' }));
    const conItems = conTop.map(b => ({ name: b.name, value: b.pct || 0, label: (b.pct > 0 ? '+' : '') + N(b.pct) + '%' }));
    safeChart('chartIndustry', barOpt(indTop, '#d92b2b'), indItems);
    safeChart('chartConcept', barOpt(conTop, '#2f6fd0'), conItems);
  }

  /* ─────────────── 连板低吸（核心） ─────────────── */
  function verdictClass(level) {
    return level === '推荐低吸' ? 'recommend' : (level === '谨慎观察' ? 'watch' : 'no');
  }
  /* ───────── 实时可低吸排序：把「测算区间」与「当前实时价」对齐 ───────── */
  function lowBuyLiveRows(d) {
    const rows = d.lowbuy || [];
    const out = rows.map(x => {
      const lb = x.lowBuy, price = Number(x.price);
      const zone = lb && Array.isArray(lb.zone) ? lb.zone : null;
      const v = x.verdict || {}, th = x.theme || {};
      const veto = (v.veto || []).length;
      const vol = (x.volRatio === null || x.volRatio === undefined) ? null : Number(x.volRatio);
      const volNote = vol === null ? '量比缺失' : (vol < 0.8 ? '缩量回踩' : vol <= 2 ? '量能温和' : '放量·需辨承接');
      const volOK = vol === null || vol <= 3;
      const avg = (x.avgPrice === null || x.avgPrice === undefined || !Number.isFinite(Number(x.avgPrice))) ? null : Number(x.avgPrice);
      const avgGap = (avg && Number.isFinite(price)) ? +((price - avg) / avg * 100).toFixed(2) : null;
      if (!zone || !Number.isFinite(price) || price <= 0) {
        return { ...x, live: { status: '数据不足', rank: 5, gap: null, vol, volNote, avg, avgGap, canAct: false, liveScore: 0, note: '日K或实时价缺失', action: '数据缺失，按纪律宁可等确认' } };
      }
      const lo = Number(zone[0]), hi = Number(zone[1]);
      let status, rank, gap, note, action;
      if (price < lo) {
        gap = (lo - price) / price * 100;
        status = '已破位'; rank = 4;
        note = '跌破区间下沿 ' + N(gap, 1) + '%';
        action = '现价已跌破低吸区间下沿，触发「计划失效条件」，回避而非摊低成本';
      } else if (price > hi) {
        gap = (price - hi) / price * 100;
        status = gap <= 2 ? '接近低吸' : '等待回踩';
        rank = gap <= 2 ? 2 : 3;
        note = '距上沿还需回踩 ' + N(gap, 1) + '%';
        action = '尚未进入测算区间，观察是否缩量回踩至 ' + N(lo) + '—' + N(hi) + '，不提前埋伏';
      } else {
        gap = 0;
        const condOK = v.level === '推荐低吸' || v.level === '谨慎观察';
        const themeOK = th.outlook !== '弱';
        const vetoOK = veto === 0;
        if (condOK && themeOK && vetoOK) { status = '可低吸·条件满足'; rank = 0; }
        else { status = '区间内·条件不足'; rank = 1; }
        note = '现价位于测算区间内';
        action = rank === 0
          ? '价格到位且无一票否决；仍需等分时企稳、缩量不破位确认，不宜仅凭价格执行'
          : '价格到位，但' + (veto ? veto + ' 项一票否决；' : '') +
            (v.level === '不推荐' || v.level === '数据不足' ? '综合结论为「' + E(v.level) + '」；' : '') +
            (th.outlook === '弱' ? '题材预期为「弱」；' : '') + '不建议按区间执行';
      }
      const base = { 0: 70, 1: 50, 2: 40, 3: 20, 4: 0, 5: 0 }[rank] || 0;
      const liveScore = Math.round(Math.max(0, Math.min(100,
        base + Math.max(0, 20 - (gap || 0) * 2) + (Number(x.techScore) || 0) / 100 * 20
        + (v.level === '推荐低吸' ? 10 : v.level === '谨慎观察' ? 5 : 0)
        - (veto ? 10 : 0) - (rank === 4 ? 10 : 0)
      )));
      return {
        ...x,
        live: {
          status, rank, gap: gap === null ? null : +gap.toFixed(2), vol, volNote, avg, avgGap,
          canAct: rank === 0 && volOK, liveScore, note, action, lo, hi,
          cls: rank === 0 ? 'recommend' : (rank === 1 || rank === 2 ? 'watch' : 'no')
        }
      };
    });
    out.sort((a, b) => a.live.rank - b.live.rank || (a.live.gap || 0) - (b.live.gap || 0) || b.live.liveScore - a.live.liveScore);
    return out;
  }

  function lowBuyLiveHtml(d, list) {
    const m = d.meta || {};
    const c = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    list.forEach(x => { c[x.live.rank] = (c[x.live.rank] || 0) + 1; });
    const trading = m.state === '盘中' || m.state === '集合竞价';
    const noActionable = c[0] === 0 && c[1] === 0 && c[2] === 0;
    const head = '<thead><tr><th>#</th><th class="left">代码 / 名称</th><th>现价</th><th>涨跌幅</th><th>均价线</th><th>距均价</th><th>低吸区间</th><th>距上沿</th><th class="left">实时状态</th><th>量比</th><th>技术分</th><th>排序分</th><th class="left">可执行说明</th></tr></thead>';
    const body = list.map((x, i) => {
      const L = x.live;
      return '<tr class="clickable" data-jump="' + E(x.code) + '" title="点击查看该股完整研判卡片">' +
        '<td><span class="lb-live-rank' + (i < 3 && L.rank <= 2 ? ' top' : '') + '">' + (i + 1) + '</span></td>' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') +
        '<div class="small muted">' + E(x.boards) + ' 连板 · ' + E((x.theme && x.theme.name) || x.industry || '无题材') + '</div></td>' +
        '<td class="' + flashCls(x.code, x.price) + '">' + N(x.price) + '</td>' +
        '<td>' + PC(x.pct) + '</td>' +
        '<td>' + (L.avg === null ? '—' : N(L.avg)) + '</td>' +
        '<td class="' + (L.avgGap !== null && L.avgGap < 0 ? 'down' : '') + '">' + (L.avgGap === null ? '—' : (L.avgGap > 0 ? '+' : '') + N(L.avgGap, 1) + '%') + '</td>' +
        '<td class="lb-live-zone">' + (L.lo === undefined ? '—' : N(L.lo) + ' — ' + N(L.hi)) + '</td>' +
        '<td>' + (L.gap === null ? '—' : (L.rank === 4 ? '<span class="down">破位 ' : '') + N(L.gap, 1) + '%' + (L.rank === 4 ? '</span>' : '')) + '</td>' +
        '<td class="left"><span class="verdict ' + L.cls + '">' + E(L.status) + '</span></td>' +
        '<td>' + (L.vol === null ? '—' : N(L.vol)) + '<div class="small muted">' + E(L.volNote) + '</div></td>' +
        '<td>' + E(x.techScore === null ? '—' : x.techScore) + '</td>' +
        '<td><b class="' + (L.liveScore >= 70 ? 'up' : '') + '">' + E(L.liveScore) + '</b></td>' +
        '<td class="left small">' + L.action + '</td></tr>';
    }).join('');
    return '<div class="sec"><div class="sec-head"><h3>实时可低吸排序</h3>' +
      src('实时价：腾讯证券快照 ' + (m.quoteTick || m.universeTick || '—') + '；低吸区间：交易日 ' + (m.poolDate || '—') + ' 日线技术位') +
      '<span class="spacer"></span>' + tag(trading ? '盘中实时' : (m.state || '—'), trading ? 'red' : 'blue') + '</div>' +
      '<div class="card pad"><div class="lb-live-summary">' +
      tag('可低吸 ' + c[0], 'red') + tag('区间内·条件不足 ' + c[1], 'warn') + tag('接近低吸 ' + c[2], 'blue') +
      tag('等待回踩 ' + c[3], '') + tag('已破位 ' + c[4], 'green') + tag('数据不足 ' + c[5], '') +
      '<span class="small muted" style="margin-left:auto">共 ' + list.length + ' 只连板 · 随全局自动刷新（默认 15 秒）· 点击任意行跳转研判卡片</span></div>' +
      '<div class="tbl-wrap"><table>' + head + '<tbody>' +
      (body || '<tr><td colspan="13" class="empty">当前筛选条件下无连板标的</td></tr>') + '</tbody></table></div>' +
      '<div class="note-box">' +
      (noActionable ? '<b>当前提示：</b>没有标的进入或接近测算低吸区间（多为封板 / 高位尚未回踩），列表按「距区间上沿回踩幅度」由近到远排序，最上方即最接近低吸位的标的。这是盘面的客观状态，系统不会为了凑出「可低吸」而放宽条件。<br>' : '') +
      '<b>均价线：</b>腾讯实时快照的分时均价，仅作盘中承接强弱参考；封板时均价通常明显低于现价，贴近均价不等于回踩到波段低吸区间。<br>' +
      '<b>排序依据：</b>① 实时状态（可低吸 &gt; 区间内条件不足 &gt; 接近低吸 &gt; 等待回踩 &gt; 已破位）；② 距区间上沿的回踩幅度（越小越靠前）；③ 排序分 = 状态基分 + 接近度 + 技术评分 + 推荐等级 − 否决扣减。<b>排序分只用于排序，不是收益预测</b>。「可低吸」要求价格落在测算区间、无一票否决、题材预期不为「弱」、综合结论非「不推荐」；量比仅作参考标签（盘中量比波动大，不作硬门槛），仍需分时缩量企稳确认。<br>' +
      '<b>口径与时点：</b>低吸区间由交易日 ' + (m.poolDate || '—') + ' 的前复权日K技术位（斐波那契回撤 / MA5 / MA10）机械测算，<b>锚点固定为当日涨停价、不随实时价漂移</b>，否则每次刷新区间会跟着现价移动，永远无法判定「是否回踩到位」；现价取腾讯证券实时快照（' + (m.quoteTick || m.universeTick || '—') + '）。两者盘中比较正是「是否回踩到位」的观察依据，但除权、跳空、涨跌停制度变化会使区间失真。' +
      (trading ? '' : '<b>当前为' + E(m.state || '非交易时段') + '</b>，价格为最近收盘快照，「可低吸」仅是静态测算状态，不构成盘中实时信号。') +
      '</div></div></div>';
  }

  function renderLowBuy(d) {
    const rows = d.lowbuy || [], m = d.meta, ov = d.overview;
    const cnt = { '推荐低吸': 0, '谨慎观察': 0, '不推荐': 0, '数据不足': 0 };
    rows.forEach(x => { const k = x.verdict.level; if (cnt[k] !== undefined) cnt[k]++; });
    const noRec = cnt['推荐低吸'] === 0 ? '<div class="small muted" style="font-weight:400;margin-top:5px">当前没有标的达到「推荐低吸」阈值，属风控结果而非数据缺失：需技术评分 ≥70、题材地位为核心/龙头、题材预期 ≥较强 三项共振，弱市下宁可空仓等待确认。</div>' : '';
    const summary = '<div class="conclusion card" style="margin-bottom:14px;border-left-color:var(--purple)"><div class="lead">连板低吸模块：从实时涨停池中筛选 ' + rows.length + ' 只连板（≥2 板）标的，逐只做日线技术面交叉验证、题材地位判定与题材生命周期评估，输出「是否推荐 / 是否题材核心或龙头 / 题材是否还有预期」三项结论。' + noRec + '</div>' +
      '<div class="tags">' + tag('连板 ' + rows.length + ' 只', 'purple') + tag('推荐低吸 ' + cnt['推荐低吸'], 'red') + tag('谨慎观察 ' + cnt['谨慎观察'], 'warn') + tag('不推荐 ' + cnt['不推荐'], '') + '</div></div>';

    const cards = rows.map((x, i) => {
      const t = x.technical || {}, th = x.theme, lb = x.lowBuy, v = x.verdict;
      const collapsed = S.collapsed.has(x.code);
      const votes = t.available ? (t.votes || []).map(vt =>
        '<span class="' + (vt.signal === '多' || vt.signal === '偏多' || vt.signal === '显著放量' ? 'bull' : (vt.signal === '空' || vt.signal === '偏空' || vt.signal === '超买' ? 'bear' : '')) + '" title="' + E(vt.detail) + '">' + E(vt.dim) + '：' + E(vt.signal) + '</span>'
      ).join('') : '<span>日K数据缺失</span>';

      const techRows = t.available ? [
        ['均线', 'MA5 ' + N(t.ma && t.ma.ma5) + ' / MA10 ' + N(t.ma && t.ma.ma10) + ' / MA20 ' + N(t.ma && t.ma.ma20) + ' / MA60 ' + N(t.ma && t.ma.ma60)],
        ['排列', (t.bullAlign ? '多头排列（MA5>MA10>MA20）' : (t.aboveMA20 ? '站上 MA20，但未形成多头排列' : '位于 MA20 下方')) + '，偏离 MA5 ' + N(t.devMA5, 1) + '%'],
        ['MACD', t.macd ? 'DIF ' + N(t.macd.dif) + ' / DEA ' + N(t.macd.dea) + ' / 柱 ' + N(t.macd.hist) + (t.macd.goldenCross ? '（金叉）' : t.macd.deadCross ? '（死叉）' : '') : '数据不足'],
        ['RSI / KDJ', 'RSI14 ' + E(t.rsi14) + (t.kdj ? ' / K ' + E(t.kdj.k) + ' D ' + E(t.kdj.d) + ' J ' + E(t.kdj.j) : '')],
        ['布林 / ATR', t.boll ? 'BOLL 中轨 ' + N(t.boll.mid) + ' 上轨 ' + N(t.boll.upper) + ' 带宽 ' + N(t.boll.width) + '% / ATR14 ' + N(t.atr) : '—'],
        ['量能', '最新量 / 前5日均量 = ' + N(t.volSurge) + ' 倍'],
        ['位置', t.position + '；' + t.positionNote + '；距60日高 ' + N(t.fromHigh, 1) + '% / 距20日低 ' + N(t.fromLow, 1) + '%'],
        ['支撑位', (t.supports || []).slice(0, 6).map(s => N(s)).join(' / ') || '—'],
        ['斐波那契', t.fib ? '锚点（涨停价）' + N(t.fib.anchor) + ' / 起涨基准 ' + N(t.fib.base) + ' → 0.382 ' + N(t.fib.f382) + ' / 0.5 ' + N(t.fib.f500) + ' / 0.618 ' + N(t.fib.f618) : '—'],
        ['日K样本', (t.bars || 0) + ' 根，截至 ' + E(t.lastDate || '—') + '（' + E(m.klineSource || '腾讯证券日K') + '）']
      ].map(r => '<tr><td>' + E(r[0]) + '</td><td>' + E(r[1]) + '</td></tr>').join('') : '<tr><td colspan="2">' + E(t.reason || '日K数据缺失') + '</td></tr>';

      const parts = (x.techParts || []).map(p =>
        '<div class="sp"><span class="spn">' + E(p.factor) + '</span><div class="spb"><div class="spf" style="width:' + (p.max ? Math.max(0, Math.min(100, p.got / p.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(p.got) + '/' + E(p.max) + '</span></div>'
      ).join('');

      const themeHtml = th ?
        '<div class="kv"><span class="k">题材名称</span><span class="v">' + E(th.name) + '（' + th.count + ' 只涨停 / 最高 ' + th.maxBoard + ' 板）</span></div>' +
        '<div class="kv"><span class="k">生命周期阶段</span><span class="v">' + tag(th.stage, 'purple') + '</span></div>' +
        '<div class="kv"><span class="k">题材是否还有预期</span><span class="v">' + tag('预期：' + th.outlook, th.outlookScore >= 3 ? 'red' : 'warn') + '</span></div>' +
        '<div class="kv"><span class="k">梯队 / 负反馈</span><span class="v">' + E(Object.keys(th.ladder || {}).sort((a, b) => b - a).map(b => b + '板×' + th.ladder[b]).join(' ')) + (th.gap ? ' · 有断层' : ' · 无断层') + ' / 炸板率 ' + N(th.negRate, 1) + '%</span></div>' +
        '<div class="note-box"><b>阶段依据：</b>' + E(th.stageBasis) + '<br><b>预期依据：</b>' + E(th.basis || th.outlookBasis) + '</div>' +
        (th.boardRef ? '<div class="kv" style="margin-top:6px"><span class="k">板块行情参照</span><span class="v">' + E(th.boardRef.name) + ' ' + (th.boardRef.pct > 0 ? '+' : '') + N(th.boardRef.pct) + '%</span></div>' : '') +
        '<div style="margin-top:9px"><h5 style="font-size:11.5px;margin:0 0 4px;color:var(--purple)">后续需验证的观察点</h5><ul class="tight">' + (th.watchPoints || []).map(w => '<li>' + E(w) + '</li>').join('') + '</ul></div>'
        : '<div class="empty">该标的所属行业未形成涨停分组，无题材周期数据</div>';

      const roleHtml =
        '<div class="kv"><span class="k">是否题材核心 / 龙头</span><span class="v">' + tag(x.role.role, x.role.isCore ? 'red' : '') + '</span></div>' +
        '<div class="kv"><span class="k">判定依据</span><span class="v" style="max-width:75%">' + E(x.role.reason) + '</span></div>' +
        '<div class="kv"><span class="k">连板高度</span><span class="v">' + E(x.boards) + ' 板（全场最高 ' + E(ov.maxBoard) + ' 板）</span></div>' +
        '<div class="kv"><span class="k">封板质量</span><span class="v">封单 ' + YI(x.sealFund) + ' / 占流通 ' + N(x.sealFundRatio) + '% · 炸板 ' + E(x.brokenCount || 0) + ' 次 · 首封 ' + E(x.firstSeal || '—') + '</span></div>' +
        '<div class="kv"><span class="k">流通市值 / 换手</span><span class="v">' + CAP(x.floatCap) + ' / ' + N(x.turnover, 1) + '%</span></div>';

      const planHtml = lb ?
        '<div class="zone-box"><div class="zl">技术测算低吸区间（元）</div><div class="zv">' + N(lb.zone[0]) + ' — ' + N(lb.zone[1]) + '</div>' +
        '<div class="zone-row"><span class="small">止损参考 <b class="down">' + N(lb.stop) + '</b></span><span class="small">上方目标 <b class="up">' + N(lb.target) + '</b></span><span class="small">盈亏比 <b>' + N(lb.riskReward) + '</b></span></div></div>' +
        '<div class="note-box"><b>区间算法：</b>' + E(lb.zoneBasis) + '<br>' + E(lb.note) + '</div>'
        : '<div class="note-box">日K数据不足，无法测算技术位；按 trade-plan 纪律，理由不足时「宁可等确认」，不给低吸区间。</div>';

      return '<div class="lb-card' + (collapsed ? ' lb-collapsed' : '') + '" id="lbCard_' + E(x.code) + '" data-code="' + E(x.code) + '">' +
        '<div class="lb-head" data-toggle="' + E(x.code) + '">' +
        '<span class="lb-name">' + sn(x.code, x.name) + '</span><span class="lb-code">' + E(x.code) + '</span>' +
        '<span class="lb-boards">' + E(x.boards) + ' 连板</span>' +
        '<span class="mini-tag">' + E(x.board) + '</span>' +
        '<span class="lb-price ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + N(x.price) + '</span>' + PC(x.pct) +
        '<span class="lb-spacer"></span>' +
        tag(th ? th.name : (x.industry || '无题材分组'), 'purple') +
        '<span class="verdict ' + verdictClass(v.level) + '">' + E(v.level) + '</span>' +
        '<div class="lb-reason">结论：' + E(v.reason) + '　| 技术评分 <b>' + E(x.techScore === null ? '—' : x.techScore) + '</b> / 100　| 点击' + (collapsed ? '展开' : '收起') + '详情</div>' +
        '</div>' +
        '<div class="lb-body"><div class="lb-grid">' +
        '<div>' +
        '<div class="lb-sub"><h5>① 技术面分析（多系统交叉验证：趋势 &gt; 位置 &gt; 短期信号）</h5>' +
        '<div class="vote">' + votes + '</div>' +
        '<table class="tech-tbl">' + techRows + '</table></div>' +
        '<div class="lb-sub"><h5>技术评分拆解（' + E(x.techScore === null ? '—' : x.techScore) + ' / 100）</h5><div class="score-parts">' + parts + '</div>' +
        (v.veto && v.veto.length ? '<div class="veto"><b>一票否决项（' + v.veto.length + '）：</b><br>' + v.veto.map(z => '· ' + E(z)).join('<br>') + '</div>' : '') + '</div>' +
        '<div class="lb-sub purple"><h5>④ 低吸区间与执行框架（条件化，非买卖指令）</h5>' + planHtml +
        '<div style="margin-top:10px"><h5 style="font-size:11.5px;margin:0 0 4px;color:var(--blue)">分仓路径</h5><ul class="tight">' + (x.entryFramework.steps || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div>' +
        '<div style="margin-top:8px"><h5 style="font-size:11.5px;margin:0 0 4px;color:var(--up)">计划失效条件（触发即退出）</h5><ul class="tight">' + (x.entryFramework.invalid || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div></div>' +
        '</div>' +
        '<div>' +
        '<div class="lb-sub purple"><h5>② 是否题材核心 / 龙头</h5>' + roleHtml + '</div>' +
        '<div class="lb-sub warn"><h5>③ 题材是否还有预期</h5>' + themeHtml + '</div>' +
        '<div class="lb-sub"><h5>数据溯源</h5>' +
        '<div class="kv"><span class="k">连板 / 封单 / 行业</span><span class="v">东方财富涨停池 ' + E(m.poolDate || '—') + '</span></div>' +
        '<div class="kv"><span class="k">实时价 / 流通市值</span><span class="v">腾讯证券 ' + E(TICK(m)) + '</span></div>' +
        '<div class="kv"><span class="k">日K技术指标</span><span class="v">' + E(m.klineSource || '腾讯证券日K') + ' ' + E(t.lastDate || '—') + '</span></div>' +
        '<div class="kv"><span class="k">板块阶段参照</span><span class="v">新浪财经板块行情</span></div></div>' +
        '</div></div></div></div>';
    }).join('');

    const scoreItems = rows.slice(0, 12).map(x => ({ name: x.name + '(' + x.code + ')', value: x.techScore || 0, label: x.techScore === null ? '—' : x.techScore }));

    const liveRows = lowBuyLiveRows(d);
    $('pane-lowbuy').innerHTML = summary +
      lowBuyLiveHtml(d, liveRows) +
      '<div class="sec"><div class="sec-head"><h3>连板股技术评分对比</h3>' + src('本系统技术指标计算，输入为腾讯证券前复权日K') + '</div><div class="card pad"><div id="chartLowScore" class="chart"></div></div></div>' +
      '<div class="sec"><div class="sec-head"><h3>逐只研判（' + rows.length + ' 只）</h3>' + src('东方财富涨停池 + 腾讯证券行情/日K + 新浪财经板块，交易日 ' + (m.poolDate || '—')) + '</div>' +
      (cards || '<div class="card empty">当前筛选条件下无连板标的。可放宽「最低连板数 / 流通市值 / 板块」条件；若为非交易时段，涨停池展示最近一个交易日数据。</div>') + '</div>' +
      '<div class="disclaimer" style="margin-top:14px"><strong>风险提示</strong>：连板低吸属于高波动策略，高位股接力赔率最差；题材阶段为量价结构推导的前瞻判断，可能因消息面变化而失效。本模块评分不纳入新闻、公告与龙虎榜数据（消息面见「明日龙头」模块独立监控），所有结论仅供研究参考，不构成投资建议。</div>';

    $('pane-lowbuy').querySelectorAll('.lb-head[data-toggle]').forEach(el => {
      el.onclick = () => {
        const c = el.dataset.toggle, card = el.closest('.lb-card');
        if (S.collapsed.has(c)) { S.collapsed.delete(c); card.classList.remove('lb-collapsed'); }
        else { S.collapsed.add(c); card.classList.add('lb-collapsed'); }
      };
    });
    $('pane-lowbuy').querySelectorAll('tr[data-jump]').forEach(tr => {
      tr.onclick = () => {
        const c = tr.dataset.jump, card = $('lbCard_' + c);
        if (!card) return;
        S.collapsed.delete(c); card.classList.remove('lb-collapsed');
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    const scoreOpt = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 135, right: 40, top: 10, bottom: 24 },
      xAxis: { type: 'value', max: 100, ...AXIS },
      yAxis: { type: 'category', data: scoreItems.map(x => x.name).reverse(), ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 14, data: scoreItems.map(x => x.value).reverse().map(v => ({ value: v, itemStyle: { color: v >= 70 ? '#d92b2b' : (v >= 55 ? '#d97706' : '#94a3b8') } })), label: { show: true, position: 'right', fontSize: 10, color: '#4b5b6b' } }]
    };
    safeChart('chartLowScore', scoreOpt, scoreItems);
  }

  /* ─────────────── 明日接力推荐（连板 / 反包板） ─────────────── */
  function relayLevelCls(l) {
    return l === '重点接力' ? 'recommend' : (l === '条件接力' ? 'watch' : 'no');
  }

  function renderRelay(d) {
    const relay = d.relay || { list: [], summary: {} };
    const rows = relay.list || [], sm = relay.summary || {}, m = d.meta;
    const lv = sm.levels || {};
    const cats = [
      ['全部', rows.length],
      ['连板接力', rows.filter(x => x.category === '连板接力').length],
      ['反包接力', rows.filter(x => x.category === '反包接力').length]
    ];

    const head = '<thead><tr><th class="left">代码 / 名称</th><th class="left">类别</th><th>连板</th><th>现价</th><th>涨跌幅</th><th>流通市值</th><th class="left">题材 / 阶段</th><th class="left">板块地位</th><th>封单/流通</th><th>评分</th><th class="left">接力结论</th><th class="left">接力方式</th></tr></thead>';
    const body = rows.map((x, i) => {
      const parts = (x.scoreParts || []).map(p =>
        '<div class="sp"><span class="spn">' + E(p.factor) + '</span><div class="spb"><div class="spf" style="width:' + (p.max ? Math.max(0, Math.min(100, p.got / p.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(p.got) + '/' + E(p.max) + '</span></div>'
      ).join('');
      const ev = x.reverse && x.reverse.evidence ? x.reverse.evidence : null;
      const revHtml = x.reverse && x.reverse.isReverse
        ? '<div class="lb-sub"><h5>反包结构证据（' + E(m.klineSource || '腾讯证券日K') + ' + 东财涨停池统计）</h5>' +
          '<div class="kv"><span class="k">反包类型</span><span class="v">' + tag(x.reverse.type, 'purple') + ' ' + E(x.reverse.strength) + '</span></div>' +
          '<div class="kv"><span class="k">前一日 ' + E(ev && ev.prevDate) + '</span><span class="v">开 ' + N(ev && ev.prevOpen) + ' / 收 ' + N(ev && ev.prevClose) + ' / 高 ' + N(ev && ev.prevHigh) + '，涨跌 ' + N(ev && ev.prevPct, 1) + '%</span></div>' +
          '<div class="kv"><span class="k">形态数据</span><span class="v">收阴 ' + (ev && ev.prevYin ? '是' : '否') + ' · 上影 ' + N(ev && ev.prevUpperShadow, 1) + '% · 今日涨幅 ' + N(ev && ev.todayPct, 1) + '%</span></div>' +
          '<div class="kv"><span class="k">反包幅度 / 量能</span><span class="v">' + E(x.reverse.coverLabel) + ' ' + N(x.reverse.strengthPct, 1) + '% · 量能 ' + N(x.reverse.volConfirm) + ' 倍 · 近期涨停 ' + E(ev && ev.recentLimitStat) + '</span></div>' +
          '<div class="note-box">' + E(x.reverse.note) + '</div></div>'
        : '';
      const t = x.technical;
      const techHtml = t ? '<div class="lb-sub"><h5>技术位与量价</h5>' +
        '<div class="kv"><span class="k">交易位置</span><span class="v">' + E(t.position) + '，偏离MA5 ' + N(t.devMA5, 1) + '%</span></div>' +
        '<div class="kv"><span class="k">均线</span><span class="v">MA5 ' + N(t.ma5) + ' / MA10 ' + N(t.ma10) + ' / MA20 ' + N(t.ma20) + '</span></div>' +
        '<div class="kv"><span class="k">RSI14 / 量能</span><span class="v">' + E(t.rsi14) + ' / ' + N(t.volSurge) + ' 倍</span></div></div>' : '';
      const a = x.anchors || {};
      const anchorHtml = '<div class="lb-sub"><h5>次日关键观察锚点</h5>' +
        '<div class="kv"><span class="k">今日涨停价</span><span class="v">' + N(a.todayLimitUp) + '</span></div>' +
        '<div class="kv"><span class="k">今日均价 / MA5</span><span class="v">' + N(a.avgPrice) + ' / ' + N(a.ma5) + '</span></div>' +
        '<div class="kv"><span class="k">竞价观察区间</span><span class="v">' + (a.auctionZone ? a.auctionZone[0] + ' — ' + a.auctionZone[1] : '—') + '</span></div>' +
        '<div class="note-box">竞价区间为按今日收盘价 ±2% 的规则测算，不是价格预测；实际以次日集合竞价与交易所行情为准。</div></div>';
      const peers = (x.peers || []).length
        ? '<div class="lb-sub"><h5>同题材卡位竞争</h5>' + x.peers.map(p => '<div class="kv"><span class="k">' + E(p.name) + '(' + E(p.code) + ')</span><span class="v">' + E(p.boards) + ' 板</span></div>').join('') + '</div>'
        : '';
      const detail = '<div class="grid2" style="gap:14px"><div>' +
        '<div class="lb-sub"><h5>接力评分拆解（' + E(x.relayScore) + ' / 100）</h5><div class="score-parts">' + parts + '</div>' +
        (x.veto && x.veto.length ? '<div class="veto"><b>一票否决：</b>' + x.veto.map(E).join('；') + '</div>' : '') + '</div>' +
        revHtml + techHtml + '</div><div>' + anchorHtml + peers +
        '<div class="lb-sub purple"><h5>晋级条件与失效条件</h5>' +
        '<div class="note-box"><b>晋级：</b>' + E(x.ladderNote) + '</div>' +
        '<ul class="tight">' + (x.invalidate || []).map(z => '<li>' + E(z) + '</li>').join('') + '</ul></div></div></div>';

      return '<tr class="clickable" data-cat="' + E(x.category) + '" data-relay="' + E(x.code) + '">' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') + '</td>' +
        '<td class="left">' + tag(x.category, x.reverse && x.reverse.isReverse ? 'purple' : 'blue') + '</td>' +
        '<td><b class="up">' + E(x.boards) + '</b></td>' +
        '<td class="' + flashCls(x.code, x.price) + '">' + N(x.price) + '</td>' +
        '<td>' + PC(x.pct) + '</td><td>' + CAP(x.floatCap) + '</td>' +
        '<td class="left">' + E(x.theme ? x.theme.name : (x.industry || '—')) + (x.theme ? ' <span class="mini-tag">' + E(x.theme.stage) + '</span>' : '') + '</td>' +
        '<td class="left">' + E(x.role.role) + '</td>' +
        '<td>' + (x.sealFundRatio === null || x.sealFundRatio === undefined ? '—' : N(x.sealFundRatio) + '%') + '</td>' +
        '<td><b class="' + (x.relayScore >= 72 ? 'up' : '') + '">' + E(x.relayScore) + '</b></td>' +
        '<td class="left"><span class="verdict ' + relayLevelCls(x.level) + '">' + E(x.level) + '</span></td>' +
        '<td class="left">' + E(x.method.method) + '</td></tr>' +
        '<tr class="detail-row" data-cat-detail="' + E(x.category) + '" id="relayDetail_' + E(x.code) + '" style="display:' + (S.expanded.has('relay_' + x.code) ? '' : 'none') + '"><td colspan="12">' + detail + '</td></tr>';
    }).join('');

    $('pane-relay').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>连板 / 反包板 · 明日接力候选</h3>' + src('东方财富涨停池（连板数/封单/首封/行业）+ ' + E(m.klineSource || '腾讯证券日K') + '（反包识别），交易日 ' + (m.poolDate || '—')) + '</div>' +
      '<div class="conclusion card" style="margin-bottom:12px;border-left-color:var(--purple)"><div class="lead">从当日涨停池中筛出连板股与「前日走弱、今日涨停收复」的反包板，按梯队高度、题材阶段、板块地位、封板质量、量价与大盘环境六维打分，给出明日接力分层、接力方式与失效条件。反包判定完全基于日K真实 OHLCV，不使用资讯。</div>' +
      '<div class="tags">' + tag('候选 ' + (sm.total || 0) + ' 只', 'purple') + tag('连板 ' + (sm.connected || 0), 'blue') + tag('反包 ' + (sm.reverse || 0), 'purple') +
      tag('重点 ' + (lv['重点接力'] || 0), 'red') + tag('条件 ' + (lv['条件接力'] || 0), 'warn') + tag('观察 ' + (lv['观察'] || 0), '') + tag('回避 ' + (lv['回避'] || 0), 'green') + '</div>' +
      '<div class="small muted" style="margin-top:7px">' + ((lv['回避'] || 0) > rows.length / 2 ? '当前「回避」占比过半：主要由市场处于防守/退潮档、高位连板否决与题材预期偏弱触发，属风控结果而非数据缺失。' : '分层由六维评分与一票否决项共同决定，弱市下条件会显著收紧。') + '</div>' +
      ((sm.klineMissing || 0) > 0 ? '<div class="veto" style="margin-top:8px"><b>数据不完整提示</b>：' + E(sm.klineMissing) + ' 只首板股的日K数据缺失，无法判定是否反包，本次反包候选可能偏少。系统已自动尝试备用日K源，稍后刷新会重试；此处不把「数据缺失」伪装成「没有反包」。</div>' : '') +
      '</div>' +
      '<div class="card pad" style="margin-bottom:12px"><div class="sec-head"><h3 style="font-size:12.5px">接力评分对比 Top10</h3></div><div id="chartRelayScore" class="chart"></div></div>' +
      '<div class="relay-cats" id="relayCats">' + cats.map((c, i) => '<button class="chip' + (i === 0 ? ' active' : '') + '" data-cat="' + E(c[0]) + '">' + E(c[0]) + ' ' + c[1] + '</button>').join('') + '</div>' +
      '<div class="tbl-wrap"><table>' + head + '<tbody>' + (body || '<tr><td colspan="12" class="empty">当前筛选条件下无接力候选</td></tr>') + '</tbody></table></div></div>' +
      '<div class="disclaimer" style="margin-top:14px"><strong>风险提示</strong>：连板与反包接力属于高波动博弈，高位股次日开盘高度易被一致性压制；所有分层与「接力方式」为量化研究框架，不是买卖指令。竞价区间为规则测算，非价格预测。</div>';

    $('pane-relay').querySelectorAll('tr[data-relay]').forEach(tr => {
      tr.onclick = () => {
        const key = 'relay_' + tr.dataset.relay, el = $('relayDetail_' + tr.dataset.relay);
        if (!el) return;
        if (el.style.display === 'none') { el.style.display = ''; S.expanded.add(key); }
        else { el.style.display = 'none'; S.expanded.delete(key); }
      };
    });
    $('relayCats').onclick = e => {
      const b = e.target.closest('.chip'); if (!b) return;
      [...$('relayCats').children].forEach(c => c.classList.toggle('active', c === b));
      const cat = b.dataset.cat;
      $('pane-relay').querySelectorAll('tr[data-cat]').forEach(tr => {
        tr.style.display = (cat === '全部' || tr.dataset.cat === cat) ? '' : 'none';
      });
      $('pane-relay').querySelectorAll('tr[data-cat-detail]').forEach(tr => {
        const code = tr.id.replace('relayDetail_', '');
        const match = cat === '全部' || tr.dataset.catDetail === cat;
        tr.style.display = (match && S.expanded.has('relay_' + code)) ? '' : 'none';
      });
    };

    const top = rows.slice(0, 10).map(x => ({ name: x.name + '(' + x.code + ')', value: x.relayScore, label: x.relayScore }));
    const opt = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 130, right: 40, top: 10, bottom: 24 },
      xAxis: { type: 'value', max: 100, ...AXIS },
      yAxis: { type: 'category', data: top.map(x => x.name).reverse(), ...AXIS },
      series: [{ type: 'bar', barMaxWidth: 14, data: top.map(x => x.value).reverse().map(v => ({ value: v, itemStyle: { color: v >= 72 ? '#d92b2b' : (v >= 58 ? '#d97706' : '#94a3b8') } })), label: { show: true, position: 'right', fontSize: 10, color: '#4b5b6b' } }]
    };
    safeChart('chartRelayScore', opt, top);
  }

  /* ─────────────── AI 分析推荐 ─────────────── */
  function mdLite(t) {
    return String(t || '').split('\n').map(l => {
      const s = E(l);
      if (/^#{1,4}\s/.test(s)) return '<h4 class="md-h">' + s.replace(/^#{1,4}\s/, '') + '</h4>';
      if (/^[-*]\s/.test(s)) return '<div class="md-li">• ' + s.replace(/^[-*]\s/, '') + '</div>';
      if (!s.trim()) return '<div class="md-br"></div>';
      return '<div class="md-p">' + s + '</div>';
    }).join('').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  function renderAI(d) {
    const ai = d.ai || {}, m = d.meta;
    const configured = !!m.aiConfigured;
    const sections = (ai.sections || []).map(s =>
      '<div class="info-card"><h4>' + E(s.title) + '</h4><p>' + E(s.body) + '</p>' +
      '<div class="small muted" style="margin-top:7px">依据：' + E((s.basis || []).join('、')) + '</div></div>'
    ).join('');
    const topRows = (ai.topPicks || []).map((x, i) =>
      '<tr><td class="left"><b>' + (i + 1) + '</b></td><td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') + '</td>' +
      '<td>' + N(x.price) + '</td><td>' + PC(x.pct) + '</td><td>' + CAP(x.floatCap) + '</td>' +
      '<td>' + E(x.resonance) + '</td><td><b class="' + (x.composite >= 70 ? 'up' : '') + '">' + E(x.composite) + '</b></td>' +
      '<td class="left">' + (x.modules || []).map(z => tag(z, 'blue')).join(' ') + '</td>' +
      '<td class="left small">' + E((x.notes || []).slice(0, 2).join(' ')) + '</td>' +
      '<td>' + E((x.risks || []).length) + '</td></tr>'
    ).join('');

    $('pane-ai').innerHTML =
      '<div class="sec"><div class="sec-head"><h3>AI 分析推荐</h3><span class="src">默认：本地量化研判引擎 · 可选：OpenAI 兼容大模型</span></div>' +
      '<div class="ai-mode card"><div><div class="ai-mode-title">' + tag(configured ? '大模型增强已启用' : '本地量化研判引擎', configured ? 'purple' : 'blue') +
      ' <span class="muted small">' + E(ai.modeLabel || '规则生成，可追溯') + '</span></div>' +
      '<div class="small muted" style="margin-top:6px">本地模式：由确定性规则引擎基于实时行情生成，每个数字可追溯到具体字段，不假装是 AI 大模型输出。配置大模型后，可额外生成一段基于同一份真实数据摘要的深度研判文本。</div></div>' +
      '<div class="ai-mode-actions"><button id="btnAiCfg" class="btn">' + (S.aiCfgOpen ? '收起配置' : '配置大模型') + '</button>' +
      '<button id="btnAiGen" class="btn btn-primary"' + (configured ? '' : ' disabled title="请先配置大模型"') + '>生成大模型研判</button></div></div>' +

      '<div class="card pad ai-config" id="aiConfigPanel" style="display:' + (S.aiCfgOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:12.5px;margin-bottom:8px">OpenAI 兼容接口配置</h4>' +
      '<div class="ai-form"><label>接口地址 <input type="text" id="aiBase" placeholder="https://api.openai.com/v1" value="' + E(m.aiBase || 'https://api.openai.com/v1') + '"></label>' +
      '<label>API Key <input type="password" id="aiKey" placeholder="sk-...（仅存服务端内存）"></label>' +
      '<label>模型名 <input type="text" id="aiModel" placeholder="gpt-4o-mini" value="' + E(m.aiModel || 'gpt-4o-mini') + '"></label></div>' +
      '<div class="ai-form-actions"><button id="btnAiSave" class="btn btn-primary">保存配置</button><button id="btnAiClear" class="btn">清除并回到本地模式</button>' +
      '<span class="small muted">密钥只保存在本进程内存，不写入任何文件、不出现在日志与接口响应中；服务重启后需重新填写。</span></div></div>' +

      '<div id="aiGenHint" class="small muted" style="margin:10px 0">' + (configured ? '已配置模型 ' + E(m.aiModel || '—') + '，点击「生成大模型研判」调用。' : '未配置大模型，以下为本地量化研判引擎结果。') + '</div>' +
      '<div class="card pad" id="aiOutputBox" style="display:' + (S.aiText ? '' : 'none') + '"><div class="sec-head"><h3 style="font-size:12.5px">' + tag('大模型生成', 'purple') + ' 深度研判</h3><span class="src" id="aiOutputTime">' + E(S.aiTextTime || '') + '</span></div>' +
      '<div class="ai-output" id="aiOutput">' + (S.aiText ? mdLite(S.aiText) : '') + '</div>' +
      '<div class="note-box">以上为大模型基于本页真实行情摘要生成的文本，可能包含不准确内容，请以数据表格与交易所公告为准；不构成投资建议。</div></div>' +

      '<div class="conclusion card" style="margin:14px 0;border-left-color:var(--blue2)"><div class="lead">' + E(ai.headline || '—') + '</div>' +
      '<div class="tags">' + tag('跨模块 Top ' + (ai.topPicks || []).length, 'blue') + tag('共振 ' + (ai.topPicks || []).filter(x => x.resonance >= 2).length + ' 只', 'purple') + tag((m.poolDate || '—'), '') + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>结构化研判</h3>' + src('本地量化研判引擎，基于六模块真实数据') + '</div><div class="grid2">' + sections + '</div></div>' +

      '<div class="sec"><div class="sec-head"><h3>跨模块综合推荐榜</h3><span class="src">短线推荐 / 连板低吸 / 明日接力三池按代码合并；先按覆盖模块数（共振）降序、同档按综合分排序；综合分 = 各模块评分均值 + 共振加成（每多一模块 +4）</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">#</th><th class="left">代码 / 名称</th><th>现价</th><th>涨跌幅</th><th>流通市值</th><th>覆盖模块</th><th>综合分</th><th class="left">模块</th><th class="left">结论摘要</th><th>风险项</th></tr></thead><tbody>' +
      (topRows || '<tr><td colspan="10" class="empty">当前无跨模块候选</td></tr>') + '</tbody></table></div></div>' +

      '<div class="sec"><div class="grid2"><div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">风险清单</h4><ul class="tight">' + (ai.riskAlerts || []).map(E).map(z => '<li>' + z + '</li>').join('') + '</ul></div>' +
      '<div class="card pad"><h4 style="font-size:12.5px;margin-bottom:8px">明日观察清单</h4><ul class="tight">' + (ai.watchList || []).map(E).map(z => '<li>' + z + '</li>').join('') + '</ul></div></div></div>' +

      '<div class="note-box" style="margin-top:12px"><b>数据溯源：</b>' + E(ai.sourceNote || '—') + '<br><b>能力边界：</b>' + E(ai.caveat || '—') + '</div></div>';

    $('btnAiCfg').onclick = () => { S.aiCfgOpen = !S.aiCfgOpen; renderAI(d); };
    $('btnAiSave').onclick = async () => {
      const payload = {
        baseUrl: $('aiBase').value.trim(), apiKey: $('aiKey').value.trim(), model: $('aiModel').value.trim()
      };
      try {
        const j = await fetch('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json());
        if (j.error) { $('aiGenHint').textContent = '配置失败：' + j.error; return; }
        S.aiCfgOpen = false;
        await refresh(true);
      } catch (e) { $('aiGenHint').textContent = '配置失败：' + e.message; }
    };
    $('btnAiClear').onclick = async () => {
      await fetch('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) }).then(r => r.json()).catch(() => ({}));
      S.aiCfgOpen = false; S.aiText = ''; S.aiTextTime = '';
      await refresh(true);
    };
    $('btnAiGen').onclick = async () => {
      const btn = $('btnAiGen'), hint = $('aiGenHint');
      btn.disabled = true; btn.textContent = '生成中…'; hint.textContent = '正在调用大模型（最长 45 秒）…';
      try {
        const r = await fetch('/api/ai/analyze', { method: 'POST' });
        const j = await r.json();
        if (j.error) { hint.textContent = j.error + ' 已保留本地研判结果。'; }
        else {
          S.aiText = j.text; S.aiTextTime = '模型 ' + E(j.model) + ' · ' + E(j.generatedAt);
          $('aiOutputBox').style.display = '';
          $('aiOutputTime').textContent = S.aiTextTime;
          $('aiOutput').innerHTML = mdLite(S.aiText);
          hint.textContent = '生成完成（基于交易日 ' + E(j.basedOn && j.basedOn.poolDate) + ' 的真实行情摘要）。';
        }
      } catch (e) { hint.textContent = '调用失败：' + e.message + ' 已保留本地研判结果。'; }
      finally { btn.disabled = !m.aiConfigured; btn.textContent = '生成大模型研判'; }
    };
  }

  /* ─────────────── 涨停回踩支撑（K线图 + 划线解释） ─────────────── */
  function pbLevelClass(l) {
    return l === '重点观察' ? 'recommend' : l === '条件观察' ? 'watch' : l === '已失效' ? 'no' : 'plain';
  }
  function pbStatusTag(s) {
    return tag(s, s === '已回踩到位' ? 'red' : s === '接近支撑' ? 'warn' : s === '跌破支撑' ? 'green' : '');
  }
  const pbKv = (k, v) => '<div class="pb-kv"><span>' + E(k) + '</span><b>' + v + '</b></div>';

  /* ─────────── 历史回溯 · 成功率验证 ─────────── */
  const btDateLabel = d => String(d || '').length === 8 ? d.slice(4, 6) + '-' + d.slice(6, 8) : String(d || '—');
  const btPct = v => (v === null || v === undefined) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%';
  const btKpi = (label, value, sub, cls) =>
    '<div class="bt-kpi"><span class="lbl">' + E(label) + '</span><b class="' + (cls || '') + '">' + value + '</b>' +
    '<span class="small muted">' + E(sub || '') + '</span></div>';
  const btLevelCls = l => l === '重点观察' ? 'red' : l === '条件观察' ? 'warn' : l === '已失效' ? 'green' : '';
  const btResultTag = r => '<span class="bt-result ' +
    (r === '达标' ? 'up' : r === '止损' ? 'down' : r === '观察中' ? 'blue' : '') + '">' + E(r || '—') + '</span>';

  function btTrendSvg(days) {
    if (!days || !days.length) return '';
    const W = 700, H = 152, L = 26, R = 8, T = 18, B = 36;
    const n = days.length, gap = (W - L - R) / n, bw = Math.min(50, gap - 10);
    const hOf = v => (H - T - B) * (Number(v) || 0) / 100;
    const y50 = H - B - hOf(50);
    const bars = days.map((d, i) => {
      const x = L + i * gap + (gap - bw) / 2;
      const rate = d.winRate;
      const h = rate === null ? 5 : Math.max(2, hOf(rate));
      const y = H - B - h;
      const fill = rate === null ? '#cbd5e1' : rate >= 60 ? '#d92b2b' : rate >= 40 ? '#d97706' : '#0f9960';
      const tip = btDateLabel(d.date) + '：成功率 ' + (rate === null ? '观察中' : rate + '%') +
        '，已完结 ' + d.completed + ' / 样本 ' + d.total;
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="3" fill="' + fill + '" opacity="' + (rate === null ? '.5' : '.88') + '"><title>' + E(tip) + '</title></rect>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle" font-size="10" fill="#4b5b6b">' +
        (rate === null ? '—' : rate + '%') + '</text>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - B + 14) + '" text-anchor="middle" font-size="9.5" fill="#8593a3">' + E(btDateLabel(d.date)) + '</text>' +
        '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - B + 26) + '" text-anchor="middle" font-size="9" fill="#8593a3">n=' + E(d.completed) + '</text>';
    }).join('');
    return '<div class="bt-trend"><div class="bt-h5">近 ' + n + ' 个基准日成功率趋势（柱高为成功率，n 为已完结样本数）</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="152" role="img" aria-label="每日成功率柱状图">' +
      '<line x1="' + L + '" y1="' + y50.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y50.toFixed(1) +
      '" stroke="#e4e9f0" stroke-dasharray="4 4"/>' +
      '<text x="2" y="' + (y50 + 3).toFixed(1) + '" font-size="9" fill="#8593a3">50%</text>' + bars + '</svg></div>';
  }

  function btCardInner() {
    const head = '<div class="bt-head"><div><h4>历史回溯 · 成功率验证</h4>' +
      '<div class="small muted">选一个过去的交易日，用当时可见的日K重跑划线规则，再用之后 N 根真实K线检验「目标 / 止损」是否兑现。</div></div>' +
      '<button class="btn" id="btToggle">' + (S.btOpen ? '收起' : '展开回溯近 10 日') + '</button></div>';
    if (!S.btOpen) return head;

    const j = S.bt;
    const dates = (j && j.meta && j.meta.baseDates) || [];
    const dateOpts = ['<option value="all"' + (S.btDate === 'all' ? ' selected' : '') + '>近 ' + (dates.length || 10) + ' 日汇总</option>']
      .concat(dates.map(d => '<option value="' + E(d) + '"' + (S.btDate === d ? ' selected' : '') + '>' + E(btDateLabel(d)) + ' 基准日</option>')).join('');
    const winOpts = [3, 5, 10].map(w => '<option value="' + w + '"' + (S.btWindow === w ? ' selected' : '') + '>' + w + ' 个交易日</option>').join('');
    const controls = '<div class="bt-controls"><label>基准日 <select class="sel" id="btDate">' + dateOpts + '</select></label>' +
      '<label>观察窗口 <select class="sel" id="btWindow">' + winOpts + '</select></label>' +
      '<button class="btn" id="btReload">重新计算</button>' +
      '<button class="link-btn" id="btMethod">' + (S.btMethodOpen ? '收起' : '查看') + '口径说明</button></div>';

    if (S.btLoading) return head + controls + '<div class="bt-state">正在回溯近 10 个交易日、逐只核对真实日K并判定结果…（首次约需数秒）</div>';
    if (S.btError) return head + controls + '<div class="bt-state err">' +
      (isConnError(new Error(S.btError)) && /Failed to fetch|fetch failed|NetworkError/i.test(S.btError)
        ? '无法连接本地服务：' + E(SERVICE_HINT)
        : '历史回溯失败：' + E(S.btError)) +
      '<br><span class="small muted">系统不会用推测数据填充统计。</span></div>' +
      '<div style="margin-top:10px"><button class="btn btn-primary" id="btRetry">重新回溯</button></div>';
    if (!j) return head + controls + '<div class="bt-state">点击「重新计算」开始回溯。</div>';

    const m = j.meta || {};
    const sum = S.btDate === 'all' ? (j.summary || {}) : (j.days || []).find(d => d.date === S.btDate) || {};
    const rows = S.btDate === 'all' ? (j.rows || []) : (j.rows || []).filter(r => r.date === S.btDate);
    const done = sum.completed || 0;
    const warn = '<div class="bt-warn"><b>口径提醒</b>：这是「触及型」判定（目标通常仅 +2%~+8%，止损约 −3%），成功率天然偏高，' +
      '<b>不等于真实交易胜率</b>；请同时看平均收益与止损率。同一标的会在多个基准日重复出现，样本不独立。</div>';
    const fb = m.fallback ? '<div class="pb-warn">口径提示：腾讯前复权日K当前不可用，本轮回测已降级为「新浪财经日K（不复权）」；除权个股历史价位可能与前复权不一致。</div>' : '';
    const kpis = '<div class="bt-kpi-grid">' +
      btKpi('已完结样本', E(done), '总样本 ' + E(sum.total || 0) + ' 个') +
      btKpi('成功率', (sum.winRate === null || sum.winRate === undefined) ? '—' : sum.winRate + '%', '达标 ' + E(sum.success || 0) + ' 个', 'up') +
      btKpi('止损率', (sum.stopRate === null || sum.stopRate === undefined) ? '—' : sum.stopRate + '%', '止损 ' + E(sum.stopped || 0) + ' 个', 'down') +
      btKpi('平均收益', btPct(sum.avgReturn), '单笔最好 ' + btPct(sum.best) + ' / 最差 ' + btPct(sum.worst), (sum.avgReturn > 0 ? 'up' : sum.avgReturn < 0 ? 'down' : '')) +
      btKpi('观察中', E(sum.watching || 0), '窗口未走完，不计入分母') +
      btKpi('未触发', E(sum.timeout || 0), '窗口内未触及目标/止损') +
      '</div>';

    const levels = Object.keys(sum.byLevel || {}).map(k => {
      const v = sum.byLevel[k];
      return '<tr><td>' + tag(k, btLevelCls(k)) + '</td><td>' + E(v.total) + '</td><td>' + E(v.completed) + '</td>' +
        '<td><b>' + (v.winRate === null ? '—' : v.winRate + '%') + '</b></td><td>' + btPct(v.avgReturn) + '</td>' +
        '<td>' + E(v.stopped) + '</td></tr>';
    }).join('');
    const levelTbl = '<div class="bt-block"><div class="bt-h5">按结论档位分组（可检验评分档位是否真有区分度）</div>' +
      '<div class="tbl-wrap"><table class="tbl bt-tbl"><thead><tr><th>档位</th><th>样本</th><th>已完结</th><th>成功率</th><th>平均收益</th><th>止损数</th></tr></thead>' +
      '<tbody>' + (levels || '<tr><td colspan="6" class="muted">无样本</td></tr>') + '</tbody></table></div></div>';

    const detail = rows.slice(0, 100).map(r => {
      const o = r.outcome || {};
      return '<tr><td>' + E(btDateLabel(r.date)) + '</td>' +
        '<td><b>' + sn(r.code, r.name) + '</b><br><span class="code">' + E(r.code) + '</span></td>' +
        '<td>' + tag(r.level, btLevelCls(r.level)) + '</td><td>' + E(r.score) + '</td>' +
        '<td>' + N(o.entry) + '</td><td>' + N(o.target) + '</td><td>' + N(o.stop) + '</td>' +
        '<td class="small">' + (o.windowHigh === null || o.windowHigh === undefined ? '—' : N(o.windowHigh) + ' / ' + N(o.windowLow)) + '</td>' +
        '<td>' + btResultTag(o.result) + (o.hitDay ? '<span class="small muted"> 第' + E(o.hitDay) + '日</span>' : '') + '</td>' +
        '<td>' + PC(o.returnPct) + '</td><td class="small">' + E(r.klineSource || '—') + '</td></tr>';
    }).join('');
    const detailTbl = '<div class="bt-block"><div class="bt-h5">逐只明细（' + E(rows.length) + ' 条' +
      (rows.length > 100 ? '，仅显示前 100 条' : '') + '）</div>' +
      '<div class="tbl-wrap bt-detail"><table class="tbl bt-tbl"><thead><tr>' +
      '<th>基准日</th><th>标的</th><th>档位</th><th>评分</th><th>基准价</th><th>目标</th><th>止损</th>' +
      '<th>后续高/低</th><th>结果</th><th>收益</th><th>日K口径</th></tr></thead><tbody>' +
      (detail || '<tr><td colspan="11" class="muted">该基准日没有可判定的样本（上游数据不足或全部被规则过滤）</td></tr>') +
      '</tbody></table></div></div>';

    const meth = (j.methodology || {});
    const method = '<div class="bt-method" style="display:' + (S.btMethodOpen ? '' : 'none') + '">' +
      (meth.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(meth.caveat || '') + '</div></div>';
    const skips = Object.keys(m.skipped || {}).map(k => E(k) + ' ' + E(m.skipped[k])).join('；') || '无';
    const trace = '<div class="bt-trace small muted">' +
      '历史涨停池：' + E((m.historyRange || []).join(' ~ ')) + '（' + E(m.historyDays) + ' 个交易日，仅可回溯约 15 日）· ' +
      '计划组合 ' + E(m.plannedCount) + ' 个 → 去重 ' + E(m.codesRequested) + ' 只 → 日K成功 ' + E(m.klineOk) + ' 只 · ' +
      '日K口径：' + E((m.klineSources || []).join(' / ') || '未取得') + ' · 服务端耗时 ' + E(m.elapsedMs) + ' ms<br>' +
      '被规则跳过：' + skips + '<br>' + E(m.dataSourceNote || '') +
      '<br>以上为历史回放，不构成投资建议；市场有风险，投资需谨慎。</div>';

    return head + controls + warn + fb + kpis + btTrendSvg(j.days) + levelTbl + detailTbl +
      '<button class="link-btn" id="btMethod2" style="margin-top:8px">' + (S.btMethodOpen ? '收起' : '查看') + '口径说明</button>' +
      method + trace;
  }

  function refreshBtCard() {
    if ($('btCard')) $('btCard').innerHTML = btCardInner();
    if ($('btToggle')) $('btToggle').onclick = () => { S.btOpen = !S.btOpen; refreshBtCard(); };
    if ($('btDate')) $('btDate').onchange = e => { S.btDate = e.target.value; refreshBtCard(); };
    if ($('btWindow')) $('btWindow').onchange = e => { S.btWindow = Number(e.target.value); loadBacktest(false); };
    if ($('btReload')) $('btReload').onclick = () => loadBacktest(true);
    if ($('btRetry')) $('btRetry').onclick = () => loadBacktest(true);
    if ($('btMethod')) $('btMethod').onclick = () => { S.btMethodOpen = !S.btMethodOpen; refreshBtCard(); };
    if ($('btMethod2')) $('btMethod2').onclick = () => { S.btMethodOpen = !S.btMethodOpen; refreshBtCard(); };
    if (S.btOpen && !S.bt && !S.btLoading && !S.btError) loadBacktest(false);
  }

  async function loadBacktest(force) {
    if (S.btLoading) return;
    S.btLoading = true; S.btError = null;
    refreshBtCard();
    const q = new URLSearchParams({ window: String(S.btWindow), days: '10' });
    if (force) q.set('force', '1');
    let j = null, lastErr = null;
    try {
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch('/api/backtest?' + q.toString(), { cache: 'no-store' });
          let data;
          try { data = await r.json(); }
          catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）'); }
          if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
          j = data; break;
        } catch (e) {
          lastErr = e;
          if (!isConnError(e) || i === 2) break;
          await new Promise(res => setTimeout(res, 1000 + i * 1200));
        }
      }
      if (!j) throw lastErr || new Error('未知错误');
      S.bt = j;
      if (S.btDate !== 'all' && !(j.meta.baseDates || []).includes(S.btDate)) S.btDate = 'all';
    } catch (e) { S.btError = e.message; }
    finally { S.btLoading = false; refreshBtCard(); }
  }

  /* 连接级失败（例如服务正在重启）自动重试；服务端 / 上游错误立即返回，不重复打上游 */
  async function fetchPullbackJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/pullback?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '），请确认访问的是本系统地址'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        if (!S.pull) $('pane-pullback').innerHTML = '<div class="card empty">本地服务未响应，正在重连…（第 ' + (i + 1) + ' 次）</div>';
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  /* 服务离线期间每 3 秒探测健康接口，恢复后自动重新扫描，无需手动刷新页面 */
  function watchService(kind) {
    clearTimeout(S.pullOfflineTimer);
    const probe = async () => {
      try {
        const h = await fetch('/api/health?_=' + Date.now(), { cache: 'no-store' });
        if (h.ok) {
          S.pullOfflineTimer = null;
          if (kind === 'dragon') loadDragon(false); else loadPullback(false);
          return;
        }
      } catch (_) { /* 服务尚未就绪，继续探测 */ }
      S.pullOfflineTimer = setTimeout(probe, 3000);
    };
    S.pullOfflineTimer = setTimeout(probe, 3000);
  }

  async function loadPullback(force) {
    if (S.pullLoading) return;
    S.pullLoading = true;
    if (!S.pull) $('pane-pullback').innerHTML = '<div class="card empty">正在回溯近期涨停股、逐只核对真实日K并计算支撑压力位…</div>';
    const f = collectFilters();
    const q = new URLSearchParams();
    ['board', 'capMin', 'capMax', 'pctMin', 'pctMax', 'turnoverMin', 'turnoverMax', 'excludeST', 'keyword', 'sector', 'sort', 'limit']
      .forEach(k => { if (f[k] !== '' && f[k] !== undefined) q.set(k, f[k]); });
    q.set('days', String(S.pullDays));
    if (force) q.set('force', '1');
    try {
      const j = await fetchPullbackJson(q);
      clearTimeout(S.pullOfflineTimer); S.pullOfflineTimer = null;
      S.pull = j; S.pullAt = Date.now(); S.pullFilters = describeFilters(f); S.pullError = null;
      const list = j.list || [];
      if (!list.some(x => x.code === S.pullSelected)) S.pullSelected = list.length ? list[0].code : null;
      renderPullback();
      $('badgePull').textContent = list.length;
    } catch (e) {
      const conn = isConnError(e);
      S.pullError = e.message;
      S.pullAt = Date.now();   // 失败后防抖，避免自动刷新每 15 秒重复打上游
      $('pane-pullback').innerHTML =
        '<div class="card empty">' + (conn ? '无法连接本地服务' : '划线数据加载失败') + '：' + E(e.message) +
        '<br><span class="small muted">' + E(conn
          ? SERVICE_HINT + ' 服务恢复后页面会自动重新扫描，也可点击「重新扫描」立即重试；系统不会用推测数据填充列表。'
          : '可点击「重新扫描」重试；上游接口临时不可用时，系统不会填充任何推测数据。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="pbRetry">重新扫描</button></div>';
      if ($('pbRetry')) $('pbRetry').onclick = () => loadPullback(true);
      if (conn) watchService();
    } finally { S.pullLoading = false; }
  }

  function renderPullback() {
    const j = S.pull; if (!j) return;
    const m = j.meta || {}, s = j.summary || {}, list = j.list || [], meth = j.methodology || {};
    const lvl = s.levels || {};
    const dates = (s.historyDates || []).map(d => d.date).join('、');
    const warn = /降级|不复权/.test(m.klineNote || '')
      ? '<div class="pb-warn">口径提示：' + E(m.klineNote) + '</div>' : '';
    const head =
      '<div class="conclusion card pb-head"><div class="lead">扫描近 ' + (s.historyDates || []).length + ' 个交易日的 ' + E(s.historyCount) +
      ' 只涨停股，核对真实日K后得到 <b>' + E(s.analyzedCount) + '</b> 只回调结构标的，其中 <b>' + E(s.nearCount) + '</b> 只已回踩或接近支撑位。</div>' +
      '<div class="tags">' +
      tag('重点观察 ' + (lvl['重点观察'] || 0), 'red') + tag('条件观察 ' + (lvl['条件观察'] || 0), 'warn') +
      tag('仅跟踪 ' + (lvl['仅跟踪'] || 0), '') + tag('已失效 ' + (lvl['已失效'] || 0), 'green') +
      tag('市场档位：' + (m.marketTier || '—'), 'blue') + tag('情绪：' + (m.marketEmotion || '—'), 'blue') + '</div></div>';

    const source =
      '<div class="card pad pb-source">' +
      '<div>候选来源：东方财富涨停池（' + E(dates || '—') + '，共 ' + E(s.historyCount) + ' 只）· 实时快照：腾讯证券 ' + E(m.quoteTick || '—') +
      ' · 日K口径：<b>' + E((s.klineSources || []).join(' / ') || '未取得') + '</b></div>' +
      '<div>预筛 ' + E(s.preselectCount) + ' 只 → 取 ' + E(s.scannedCount) + ' 只拉日K（成功 ' + E(s.klineOk) + ' 只）→ 完成划线 ' + E(s.analyzedCount) +
      ' 只 · 服务端耗时 ' + E(m.elapsedMs) + ' ms · 生成时点 ' + E(m.generatedAt) + '</div>' +
      warn +
      '<div class="pb-actions"><button class="btn btn-primary" id="pbRescan">重新扫描</button> ' +
      '<label class="small muted">候选回溯 <select class="sel" id="pbDays">' +
      [8, 10, 15].map(n => '<option value="' + n + '"' + (S.pullDays === n ? ' selected' : '') + '>近 ' + n + ' 个交易日</option>').join('') +
      '</select></label> ' +
      '<button class="btn" id="pbMethod">' + (S.pullMethodOpen ? '收起' : '查看') + '划线口径说明</button> ' +
      '<span class="small muted">本模块应用：市场板块 / 流通市值 / 涨跌幅 / 换手 / 排除ST / 关键字 / 板块筛选；「最低连板数」不适用于回调结构。</span></div></div>';

    const method = '<div class="card pad pb-method" id="pbMethodBox" style="display:' + (S.pullMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">划线口径（先看规则，再看线）</h4>' +
      (meth.steps || []).map(st => '<div class="pb-step"><b>' + E(st.name) + '</b><span>' + E(st.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(meth.caveat || '') + '</div></div>';

    const items = list.map(x =>
      '<div class="pb-item' + (x.code === S.pullSelected ? ' active' : '') + '" data-code="' + E(x.code) + '">' +
      '<div class="pb-item-top"><b>' + sn(x.code, x.name) + '</b><span class="code">' + E(x.code) + '</span>' +
      '<span class="verdict ' + pbLevelClass(x.level) + '">' + E(x.level) + '</span></div>' +
      '<div class="pb-item-mid"><span>现价 <b>' + N(x.price) + '</b></span>' + PC(x.pct) + '<span>评分 <b>' + E(x.score) + '</b></span></div>' +
      '<div class="pb-item-bot"><span>涨停 ' + E(String(x.ztDate).slice(5)) + ' · 回调 ' + E(x.sinceZt) + ' 日</span>' + pbStatusTag(x.status) + '</div>' +
      '<div class="pb-item-sup">主支撑 ' + E(x.primarySupport.short) + ' ' + N(x.primarySupport.price) +
      ' · 距 ' + (x.nearPct > 0 ? '+' : '') + N(x.nearPct, 1) + '%</div></div>'
    ).join('');

    const why = s.analyzedCount
      ? '已完成划线的 ' + E(s.analyzedCount) + ' 只标的均被当前全局筛选条件过滤，请放宽市值 / 涨跌幅 / 换手 / 板块条件。'
      : '可能原因：近期涨停股大多仍在涨停当日或次日窗口内（本模块要求至少 2 根回调K线）、当日仍强势，或上游日K接口临时不可用。';
    const empty = '<div class="card empty pb-empty"><b>当前没有符合条件的回踩标的</b><br><span class="small muted">' + why +
      '系统不会用推测数据填充列表。</span><br><span class="small muted">扫描链路：候选 ' + E(s.historyCount) + ' 只 → 预筛 ' + E(s.preselectCount) +
      ' 只 → 日K成功 ' + E(s.klineOk) + '/' + E(s.scannedCount) + ' 只 → 完成划线 ' + E(s.analyzedCount) + ' 只。</span></div>';

    const body = list.length
      ? '<div class="pb-layout"><div class="pb-list" id="pbList">' + items + '</div><div class="pb-detail" id="pbDetail"></div></div>'
      : empty;
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';

    $('pane-pullback').innerHTML = head + source + '<div class="card pad bt-card" id="btCard"></div>' + method + body + disc;
    refreshBtCard();
    if ($('pbRescan')) $('pbRescan').onclick = () => loadPullback(true);
    if ($('pbDays')) $('pbDays').onchange = e => { S.pullDays = Number(e.target.value); loadPullback(true); };
    if ($('pbMethod')) $('pbMethod').onclick = () => {
      S.pullMethodOpen = !S.pullMethodOpen;
      $('pbMethodBox').style.display = S.pullMethodOpen ? '' : 'none';
      $('pbMethod').textContent = (S.pullMethodOpen ? '收起' : '查看') + '划线口径说明';
    };
    $('pane-pullback').querySelectorAll('.pb-item').forEach(el => {
      el.onclick = () => {
        S.pullSelected = el.dataset.code;
        $('pane-pullback').querySelectorAll('.pb-item').forEach(n => n.classList.toggle('active', n === el));
        renderPullDetail();
      };
    });
    renderPullDetail();
  }

  function renderPullDetail() {
    const j = S.pull; if (!j) return;
    const box = $('pbDetail'); if (!box) return;
    const x = (j.list || []).find(a => a.code === S.pullSelected);
    if (!x) { box.innerHTML = '<div class="card empty">请选择左侧标的查看 K 线图与划线解释</div>'; return; }
    box.innerHTML = detailHead(x) + klineCard(x) + lineExplanations(x) + tradePlanCard(x, j.meta || {});
  }

  function detailHead(x) {
    const ps = x.primarySupport || {}, pr = x.primaryResistance || {};
    return '<div class="card pb-detail-head">' +
      '<div class="pb-dh-top"><span class="lb-name">' + sn(x.code, x.name) + '</span><span class="lb-code">' + E(x.code) + '</span>' +
      tag(x.board || '—', '') + tag(x.industry || '无行业', 'purple') + pbStatusTag(x.status) +
      '<span class="lb-spacer"></span><span class="verdict ' + pbLevelClass(x.level) + '">' + E(x.level) + '</span></div>' +
      '<div class="pb-dh-reason">结论：' + E(x.reason) + '</div>' +
      '<div class="pb-kv-grid">' +
      pbKv('现价 / 涨跌幅', N(x.price) + ' 元　' + PC(x.pct)) +
      pbKv('涨停日 / 回调', E(x.ztDate) + ' · ' + E(x.sinceZt) + ' 个交易日') +
      pbKv('阶段高点 / 回撤', N(x.swingHigh) + '（' + E(String(x.swingHighDate).slice(5)) + '）· −' + N(x.drawdown, 1) + '%') +
      pbKv('起涨低点 / 回撤比例', N(x.swingLow) + ' · 回吐 ' + N(x.retrace, 1) + '%') +
      pbKv('主支撑 / 距现价', E(ps.short) + ' ' + N(ps.price) + ' · ' + (x.nearPct > 0 ? '+' : '') + N(x.nearPct, 1) + '%') +
      pbKv('主压力 / 上方空间', (pr.short ? E(pr.short) + ' ' + N(pr.price) : '—') + ' · +' + N(x.roomPct, 1) + '%') +
      pbKv('缩量比 / RSI14', (x.volRatio === null ? '—' : N(x.volRatio) + ' 倍') + ' · ' + E(x.rsi14 === null ? '—' : x.rsi14)) +
      pbKv('MA20 / 评分', N(x.ma && x.ma.ma20) + ' · ' + (x.aboveMA20 ? '站上' : '跌破') + ' · ' + E(x.score) + ' 分') +
      '</div>' +
      '<div class="pb-trace-line">' + E(x.sourceNote) + '　|　涨停日交叉校验：' + E(x.ztSourceNote) + '</div></div>';
  }

  /** 板块涨停阈值：与后端 limitUpCut 同一口径，用于K线状态着色 */
  function klineLimitCut(code) {
    const s = String(code || '');
    if (/^(300|301|688|689)/.test(s)) return 19.5;
    if (/^(8|4|920)/.test(s)) return 29.5;
    return 9.7;
  }
  /** 零依赖 SVG K 线图：蜡烛 + 成交量 + 均线 + 水平支撑/压力线 + 右侧标签 + 观察区 */
  function klineCard(x) {
    const c = x.chart || {}, bars = c.bars || [];
    if (bars.length < 10) return '<div class="card empty">该标的日K数据不足，无法绘制K线图（不生成示意图）</div>';
    // K线状态配色（默认规则）：涨停=黄、跌停=紫、炸板=蓝，其余保留红涨绿跌
    const KC = { zt: '#e3a800', dt: '#6d4bd6', zb: '#2f6fd0', up: '#d92b2b', down: '#0f9960' };
    const kth = klineLimitCut(x.code);
    // 逐根判定：涨停=收盘涨幅≥阈值；跌停=收盘跌幅≤-阈值；炸板=盘中最高触板但收盘未封住
    const states = bars.map((b, i) => {
      const prev = i > 0 ? bars[i - 1].close : null;
      const plain = b.close >= b.open ? 'up' : 'down';
      if (!prev) return plain;
      const chg = (b.close - prev) / prev * 100, hi = (b.high - prev) / prev * 100;
      if (chg >= kth) return 'zt';
      if (chg <= -kth) return 'dt';
      if (hi >= kth) return 'zb';
      return plain;
    });
    const barColor = i => KC[states[i]];
    const W = 940, H = 438, L = 58, R = 136, PW = W - L - R;
    const PT = 28, PB = 292, VT = 312, VB = 372, DY = 392;
    let minP = Math.min(...bars.map(b => b.low)), maxP = Math.max(...bars.map(b => b.high));
    const visible = (c.lines || []).filter(l => l.price >= minP * 0.97 && l.price <= maxP * 1.03);
    visible.forEach(l => { minP = Math.min(minP, l.price); maxP = Math.max(maxP, l.price); });
    if (c.zone) { minP = Math.min(minP, c.zone[0]); maxP = Math.max(maxP, c.zone[1]); }
    minP = Math.min(minP, c.price); maxP = Math.max(maxP, c.price);
    const pad = (maxP - minP) * 0.06 || maxP * 0.02;
    minP -= pad; maxP += pad;
    const Y = p => PB - (p - minP) / (maxP - minP) * (PB - PT);
    const maxV = Math.max(1, ...bars.map(b => b.volume || 0));
    const cw = PW / bars.length, bw = Math.max(2, Math.min(9, cw * 0.62));
    const CX = i => L + cw * (i + 0.5);
    const a = [];
    a.push('<svg class="pb-kline" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + E(x.name) + ' 日K线与支撑压力划线">');
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>');
    for (let i = 0; i <= 4; i++) {
      const p = minP + (maxP - minP) * i / 4, y = Y(p);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7" stroke-width="1"/>');
      a.push('<text x="' + (L - 7) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    if (c.zone) {
      const y1 = Y(c.zone[1]), y2 = Y(c.zone[0]);
      a.push('<rect x="' + L + '" y="' + y1.toFixed(1) + '" width="' + PW + '" height="' + Math.max(2, y2 - y1).toFixed(1) + '" fill="#eaf2fd" opacity="0.8"/>');
      a.push('<text x="' + (L + 5) + '" y="' + (y1 - 4).toFixed(1) + '" font-size="10" fill="#2f6fd0">回踩观察区 ' + N(c.zone[0]) + '–' + N(c.zone[1]) + '</text>');
    }
    bars.forEach((b, i) => {
      const cx = CX(i), col = barColor(i), st = states[i];
      const yo = Y(b.open), yc = Y(b.close), yh = Y(b.high), yl = Y(b.low);
      const stName = { zt: '涨停', dt: '跌停', zb: '炸板', up: '上涨', down: '下跌' }[st];
      const tip = E(b.date) + ' [' + stName + '] 开 ' + N(b.open) + ' 高 ' + N(b.high) + ' 低 ' + N(b.low) + ' 收 ' + N(b.close) + ' 量 ' + E(b.volume);
      a.push('<g><title>' + tip + '</title>');
      a.push('<line x1="' + cx.toFixed(1) + '" y1="' + yh.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + yl.toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>');
      a.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Math.min(yo, yc).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1.4, Math.abs(yo - yc)).toFixed(1) + '" fill="' + col + '"/></g>');
    });
    [['ma5', '#e8912a'], ['ma10', '#2f6fd0'], ['ma20', '#6d4bd6']].forEach(pair => {
      const arr = c[pair[0]] || [], pts = [];
      arr.forEach((v, i) => { if (v !== null && v !== undefined && Number.isFinite(v)) pts.push(CX(i).toFixed(1) + ',' + Y(v).toFixed(1)); });
      if (pts.length > 1) a.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + pair[1] + '" stroke-width="1.2" opacity="0.85"/>');
    });
    const labels = [];
    visible.forEach(l => {
      const y = Y(l.price), isMain = !!(x.primarySupport && l.id === x.primarySupport.id);
      const col = l.kind === 'support' ? (isMain ? '#0f7b6c' : '#2f6fd0') : '#d92b2b';
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) +
        '" stroke="' + col + '" stroke-width="' + (isMain ? 1.9 : 1.1) + '" stroke-dasharray="' + (isMain ? '7 3' : '4 4') +
        '" opacity="' + (isMain ? 0.95 : 0.7) + '"/>');
      labels.push({ y, col, text: l.id + ' ' + l.short + ' ' + N(l.price), isMain });
    });
    const py = Y(c.price);
    a.push('<line x1="' + L + '" y1="' + py.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + py.toFixed(1) + '" stroke="#1c2733" stroke-width="1" stroke-dasharray="2 3" opacity="0.55"/>');
    labels.push({ y: py, col: '#1c2733', text: '现价 ' + N(c.price), dark: true });
    labels.sort((p, q) => p.y - q.y);
    let lastY = -100;
    labels.forEach(lb => {
      let ly = Math.max(PT + 10, Math.min(PB + 20, lb.y));
      if (ly - lastY < 15) ly = lastY + 15;
      lastY = ly;
      const lx = L + PW + 6, txt = lb.text.length > 17 ? lb.text.slice(0, 16) + '…' : lb.text;
      if (Math.abs(ly - lb.y) > 2)
        a.push('<line x1="' + (L + PW) + '" y1="' + lb.y.toFixed(1) + '" x2="' + (lx - 2) + '" y2="' + ly.toFixed(1) + '" stroke="' + lb.col + '" stroke-width="0.8" opacity="0.5"/>');
      a.push('<rect x="' + lx + '" y="' + (ly - 8).toFixed(1) + '" width="' + (R - 12) + '" height="15" rx="3" fill="' + lb.col + '" opacity="' + (lb.dark ? 1 : 0.92) + '"/>');
      a.push('<text x="' + (lx + 5) + '" y="' + (ly + 3).toFixed(1) + '" font-size="10" fill="#ffffff" font-weight="600">' + E(txt) + '</text>');
    });
    const zi = bars.findIndex(b => b.date === c.ztDate);
    if (zi >= 0) {
      const cx = CX(zi), top = Y(bars[zi].high);
      a.push('<path d="M' + (cx - 5).toFixed(1) + ' ' + (top - 9).toFixed(1) + ' L' + (cx + 5).toFixed(1) + ' ' + (top - 9).toFixed(1) +
        ' L' + cx.toFixed(1) + ' ' + (top - 3).toFixed(1) + ' Z" fill="' + KC.zt + '"/>');
      a.push('<text x="' + cx.toFixed(1) + '" y="' + (top - 12).toFixed(1) + '" text-anchor="middle" font-size="9.5" fill="' + KC.zt + '" font-weight="700">涨停</text>');
    }
    const hi = bars.findIndex(b => b.date === c.highDate);
    if (hi >= 0) {
      const cx = CX(hi), top = Y(bars[hi].high);
      a.push('<circle cx="' + cx.toFixed(1) + '" cy="' + (top - 3).toFixed(1) + '" r="2.6" fill="#d97706"/>');
      a.push('<text x="' + cx.toFixed(1) + '" y="' + (top - 7).toFixed(1) + '" text-anchor="middle" font-size="9" fill="#d97706">阶段高</text>');
    }
    a.push('<line x1="' + L + '" y1="' + VT + '" x2="' + (L + PW) + '" y2="' + VT + '" stroke="#eef2f7"/>');
    a.push('<text x="' + (L - 7) + '" y="' + (VT + 10) + '" text-anchor="end" font-size="9" fill="#8593a3">量</text>');
    bars.forEach((b, i) => {
      const h = (b.volume || 0) / maxV * (VB - VT - 4), col = barColor(i);
      a.push('<rect x="' + (CX(i) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1, h).toFixed(1) + '" fill="' + col + '" opacity="0.55"><title>' + E(b.date) + ' 成交量 ' + E(b.volume) + '</title></rect>');
    });
    const step = Math.max(1, Math.ceil(bars.length / 6));
    bars.forEach((b, i) => {
      if (i % step === 0 || i === bars.length - 1)
        a.push('<text x="' + CX(i).toFixed(1) + '" y="' + DY + '" text-anchor="middle" font-size="9.5" fill="#8593a3">' + E(String(b.date).slice(5)) + '</text>');
    });
    const legend = [[KC.zt, '涨停'], [KC.dt, '跌停'], [KC.zb, '炸板'], [KC.up, '阳线'], [KC.down, '阴线'], ['#e8912a', 'MA5'], ['#2f6fd0', 'MA10'], ['#6d4bd6', 'MA20'], ['#0f7b6c', '主支撑'], ['#d92b2b', '压力位']];
    let lx = L;
    legend.forEach(pair => {
      a.push('<rect x="' + lx + '" y="8" width="8" height="8" rx="2" fill="' + pair[0] + '"/>');
      a.push('<text x="' + (lx + 12) + '" y="16" font-size="10" fill="#6b7a8c">' + pair[1] + '</text>');
      lx += 84;
    });
    a.push('<text x="' + L + '" y="420" font-size="10" fill="#8593a3">日K：' + E(c.source || '—') + '（截至 ' + E(c.asOf || '—') + '，' + bars.length +
      ' 根）；划线由本系统按规则从真实日K计算，非交易所数据；鼠标悬停K线可查看当日 OHLC。</text>');
    a.push('</svg>');
    return '<div class="card pb-chart-card"><div class="pb-chart-head"><h4>日K线图与支撑 / 压力划线</h4>' + src(x.sourceNote) + '</div>' +
      '<div class="pb-svg-wrap">' + a.join('') + '</div>' +
      '<div class="note-box"><b>K线默认着色</b>：<span style="color:' + KC.zt + ';font-weight:700">涨停=黄</span> / <span style="color:' + KC.dt + ';font-weight:700">跌停=紫</span> / <span style="color:' + KC.zb + ';font-weight:700">炸板=蓝</span>（盘中最高触及涨停但收盘未封住）；普通K线仍红涨绿跌。涨停 / 跌停按收盘较前收盘涨跌幅达板块阈值（主板 ' + kth + '%）判定，炸板按盘中最高触及阈值收盘未封判定，均为真实日K机械识别、非当日池标签。<br>图上只标注最重要的 4 条支撑 + 3 条压力（距现价过远的线不画，避免压缩K线），完整清单与每条线的生成依据见下方「划线解释」。蓝色 / 绿色虚线为支撑，红色虚线为压力，粗绿虚线为主支撑，浅蓝阴影为回踩观察区。</div></div>';
  }

  function lineExplanations(x) {
    const shown = x.chart.lines || [], ids = new Set(shown.map(l => l.id));
    const all = [...(x.supports || []), ...(x.resistances || [])];
    const cards = shown.map(l => {
      const main = !!(x.primarySupport && l.id === x.primarySupport.id);
      const col = l.kind === 'support' ? (main ? '#0f7b6c' : '#2f6fd0') : '#d92b2b';
      return '<div class="lv-card" style="border-left-color:' + col + '">' +
        '<div class="lv-top"><span class="lv-id" style="background:' + col + '">' + E(l.id) + '</span><b>' + E(l.name) + '</b>' +
        '<span class="lv-price">' + N(l.price) + ' 元</span>' + tag(l.kind === 'support' ? '支撑' : '压力', l.kind === 'support' ? 'blue' : 'red') +
        (main ? tag('主支撑', 'green') : '') +
        '<span class="lv-dist">距现价 ' + (l.distPct > 0 ? '+' : '') + N(l.distPct, 1) + '%</span></div>' +
        '<div class="lv-basis"><b>为什么画在这里：</b>' + E(l.basis) + '</div>' +
        '<div class="lv-foot">历史有效触碰 ' + E(l.touches) + ' 次' + (l.lastTouch ? '（末次 ' + E(String(l.lastTouch).slice(5)) + '）' : '') +
        ' · 强度 ' + E(l.strength) + '/3 · ' + E(l.source) + '</div></div>';
    }).join('');
    const rows = all.map(l =>
      '<tr' + (ids.has(l.id) ? ' class="lv-onchart"' : '') + '><td class="left">' + (ids.has(l.id) ? '<span class="dot-on">●</span> ' : '') + E(l.id) + '</td>' +
      '<td class="left">' + E(l.short) + '</td><td>' + N(l.price) + '</td><td>' + (l.distPct > 0 ? '+' : '') + N(l.distPct, 1) + '%</td>' +
      '<td>' + E(l.touches) + '</td><td class="left">' + tag(l.kind === 'support' ? '支撑' : '压力', l.kind === 'support' ? 'blue' : 'red') + '</td>' +
      '<td class="left small">' + E(l.basis) + '</td></tr>'
    ).join('');
    const ma = (x.maRefs || []).map(r =>
      '<div class="kv"><span class="k">' + E(r.name) + '</span><span class="v">' + N(r.price) + ' 元 · ' + E(r.note) + '</span></div>').join('');
    return '<div class="card pad pb-lines"><div class="sec-head"><h3>划线解释（逐条可追溯）</h3>' +
      src(x.chart.source + '，截至 ' + x.chart.asOf) + '</div>' +
      '<div class="pb-note">读图顺序：先看现价与主支撑的距离（是否回踩到位），再看上方压力决定空间，最后看缩量与收盘是否破位。支撑被收盘有效跌破即转为压力，这就是「支撑压力互换」。</div>' +
      '<div class="lv-grid">' + cards + '</div>' +
      '<div class="sec-head" style="margin-top:15px"><h3 style="font-size:12.5px">完整水平位清单</h3><span class="src">● 表示已画在图上</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">编号</th><th class="left">线名</th><th>价位</th><th>距现价</th><th>触碰</th><th class="left">类型</th><th class="left">生成依据</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="sec-head" style="margin-top:13px"><h3 style="font-size:12.5px">动态参考线（非水平划线）</h3></div><div class="pb-ma">' + ma + '</div>' +
      (x.klineNote ? '<div class="pb-warn">口径提示：' + E(x.klineNote) + '</div>' : '') + '</div>';
  }

  function tradePlanCard(x, m) {
    const p = x.plan || {};
    const parts = (x.scoreParts || []).map(z =>
      '<div class="sp"><span class="spn">' + E(z.factor) + '</span><div class="spb"><div class="spf" style="width:' +
      (z.max ? Math.max(0, Math.min(100, z.got / z.max * 100)) : 0) + '%"></div></div><span class="spv">' + E(z.got) + '/' + E(z.max) + '</span></div>'
    ).join('');
    const li = arr => (arr || []).map(t => '<li>' + E(t) + '</li>').join('');
    return '<div class="pb-plan-grid">' +
      '<div class="card pad"><div class="sec-head"><h3 style="font-size:12.5px">条件化观察框架（非买卖指令）</h3></div>' +
      '<div class="zone-box"><div class="zl">回踩观察区间（元）</div><div class="zv">' + N(p.zone && p.zone[0]) + ' — ' + N(p.zone && p.zone[1]) + '</div>' +
      '<div class="zone-row"><span class="small">止损参考 <b class="down">' + N(p.stop) + '</b></span>' +
      '<span class="small">上方目标 <b class="up">' + N(p.target) + '</b></span>' +
      '<span class="small">盈亏比 <b>' + N(p.rr) + '</b></span></div></div>' +
      '<div class="note-box"><b>区间算法：</b>' + E(p.basis) + '</div>' +
      '<div class="sec-head" style="margin-top:12px"><h3 style="font-size:12.5px">评分拆解（' + E(x.score) + ' / 100）</h3></div>' +
      '<div class="score-parts">' + parts + '</div>' +
      (x.veto && x.veto.length ? '<div class="veto"><b>一票否决项（' + x.veto.length + '）：</b><br>' + x.veto.map(z => '· ' + E(z)).join('<br>') + '</div>' : '') +
      '</div>' +
      '<div class="card pad"><div class="sec-head"><h3 style="font-size:12.5px">确认条件 / 分仓路径 / 失效条件</h3></div>' +
      '<h5 class="pb-h5">需同时确认（否则不进入观察）</h5><ul class="tight">' + li(p.conditions) + '</ul>' +
      '<h5 class="pb-h5">分仓路径（研究框架示例）</h5><ul class="tight">' + li(p.steps) + '</ul>' +
      '<h5 class="pb-h5" style="color:var(--up)">计划失效条件（触发即退出）</h5><ul class="tight">' + li(p.invalid) + '</ul>' +
      '<div class="pb-trace"><h5 class="pb-h5">数据溯源</h5>' +
      '<div class="kv"><span class="k">候选涨停标记</span><span class="v">东方财富涨停池 ' + E(x.poolDate || '—') + '</span></div>' +
      '<div class="kv"><span class="k">实时价 / 涨跌幅</span><span class="v">腾讯证券 ' + E(x.quoteTick || '—') + '</span></div>' +
      '<div class="kv"><span class="k">日K与划线</span><span class="v">' + E(x.klineSource || '—') + ' · 截至 ' + E(x.lastDate || '—') + '</span></div>' +
      '<div class="kv"><span class="k">涨停日校验</span><span class="v">' + E(x.ztSourceNote) + '</span></div>' +
      '<div class="kv"><span class="k">市场档位</span><span class="v">' + E(m.marketTier || '—') + ' / ' + E(m.marketEmotion || '—') + '</span></div>' +
      '</div></div></div>';
  }

  /* ═══════════ 明日龙头 · 只做龙头 / 买在分歧卖在一致 ═══════════ */
  const dgDtypeCls = d => ({ '良性分歧': 'red', '一致加速': 'warn', '恶性分歧': 'purple', '分歧偏弱': 'blue', '中性': '' }[d] || '');
  const dgToneCls = t => ({ primary: 'red', warn: 'warn', blue: 'blue', muted: '' }[t] || '');
  // 历史复盘中晋级率较高的「地位 + 一致」组合；颜色与右上角标记仅按回放日已知字段生成。
  const DG_EDGE_COMBOS = {
    '空间板|一致加速': { key: 'space', label: '空间板+一致', rate: '61.5%', n: 13, avg: '+6.77%', win: '84.6%', color: '#d92b2b', bg: '#fdecec' },
    '累计板龙|一致加速': { key: 'cum', label: '累计板龙+一致', rate: '50.0%', n: 16, avg: '+4.76%', win: '', color: '#6d4bd6', bg: '#f1edfd' },
    '题材龙|一致加速': { key: 'theme', label: '题材龙+一致', rate: '40.0%', n: 20, avg: '', win: '', color: '#2f6fd0', bg: '#eaf2fd' }
  };
  function dgEdgeOf(x) {
    if (!x || x.dtype !== '一致加速') return null;
    return DG_EDGE_COMBOS[String(x.role) + '|' + String(x.dtype)] || null;
  }
  function dgEdgeStyle(edge) {
    return '--edge:' + edge.color + ';--edge-bg:' + edge.bg;
  }
  function dgEdgeTitle(edge) {
    return '历史复盘：' + edge.label + ' 晋级率 ' + edge.rate + '（n=' + edge.n + '）' +
      (edge.avg ? '，均涨 ' + edge.avg : '') + (edge.win ? '，上涨占比 ' + edge.win : '') + '；仅为历史样本，不代表未来收益';
  }
  function dgEdgeBadge(x) {
    const edge = dgEdgeOf(x);
    if (!edge) return '';
    return '<span class="dg-edge-inline edge-' + E(edge.key) + '" style="' + dgEdgeStyle(edge) +
      '" title="' + E(dgEdgeTitle(edge)) + '">★ ' + E(edge.label) + ' ' + E(edge.rate) + '</span>';
  }
  function dgEdgeLegendCard(compact) {
    const items = Object.keys(DG_EDGE_COMBOS).map(k => {
      const e = DG_EDGE_COMBOS[k];
      const detail = '晋级率 <b>' + E(e.rate) + '</b>（n=' + E(e.n) + '）' +
        (e.avg ? ' · 均涨 <b>' + E(e.avg) + '</b>' : '') + (e.win ? ' · 上涨占比 <b>' + E(e.win) + '</b>' : '');
      return '<div class="dg-edge-legend-item edge-' + E(e.key) + '" style="' + dgEdgeStyle(e) + '">' +
        '<span class="dg-edge-swatch"></span><b>' + E(e.label) + '</b><span class="small muted">' + detail + '</span></div>';
    }).join('');
    const grid = '<div class="dg-edge-legend-grid' + (compact ? ' compact' : '') + '">' + items + '</div>';
    const note = '<div class="note-box">样本来自 ' + E('2026-10-28 ~ 2026-11-16') +
      ' 的历史回放，同一标的跨日重复出现、样本量小，且晋级率不等于收益率或可交易胜率；彩色边框只是复盘识别标记，不构成买卖信号。</div>';
    if (compact) return '<div class="dg-h5" style="margin-top:11px">历史优势组合 · 彩色边框标记</div>' + grid + note;
    return '<div class="card pad dg-card dg-edge-legend"><div class="dg-card-head"><h4>历史优势组合 · 彩色边框标记</h4>' +
      '<span class="small muted">仅按当日「地位 + 一致加速」标记，不使用次日数据</span></div>' + grid + note + '</div>';
  }
  const dgBar = (v, cls) => '<div class="dg-bar"><i class="' + (cls || 'blue') + '" style="width:'
    + Math.max(0, Math.min(100, Number(v) || 0)).toFixed(1) + '%"></i></div>';
  const dgNum = (v, suffix) => (v === null || v === undefined) ? '—' : E(v) + (suffix || '');

  function dgHead(j) {
    const s = j.sentiment, su = j.summary, rs = j.riskSummary || {};
    return '<div class="conclusion card dg-head"><div class="lead">「只做龙头」把 ' + E(su.poolCount) +
      ' 只涨停股收敛为 <b>' + E(su.leaderCount) + '</b> 只有明确定位的龙头 / 卡位标的；当前情绪 <b>' + E(s.phase) +
      '</b>（温度 ' + E(s.temperature) + ' / 100，姿态：' + E(s.stance) + '），空间板高度 ' + E(s.maxBoards) + ' 板。' +
      '候选范围已扩至「连续连板 + N天N板累计涨停」双口径，其中累计板龙 <b>' + E(su.cumLeaderCount || 0) + '</b> 只（近 N 日 M 次涨停的反包型龙头，不再因连续板数低被剔除）。' +
      '<div class="dg-head-sub">核心命题：<b>买在分歧</b>（放量换手后等次日弱转强确认）、<b>卖在一致</b>（缩量加速不追高）。下面是<b>明日盘前观察清单</b>，不是买入名单。</div></div>' +
      '<div class="tags">' + tag('涨停 ' + s.ztCount, 'red') +
      tag('炸板率 ' + dgNum(s.brokenRate, '%'), 'warn') + tag('跌停 ' + s.dtCount, 'green') +
      tag('最高 ' + s.maxBoards + ' 板', 'blue') +
      tag('累计最高 ' + (su.maxCumBoards || '—') + ' 板', 'blue') +
      tag('N天N板 ' + (su.cumPoolCount || 0) + ' 只', 'purple') +
      tag('累计板龙 ' + (su.cumLeaderCount || 0), 'purple') +
      tag('名称题材 ' + (su.nameThemeCount || 0), 'warn') +
      tag('昨日连板溢价 ' + (s.prevPremium === null ? '—' : (s.prevPremium > 0 ? '+' : '') + s.prevPremium + '%'), s.prevPremium < 0 ? 'green' : 'red') +
      tag('候选 ' + su.shown, 'purple') +
      (j.meta && j.meta.isReview
        ? tag('风险标记仅实时版提供', '')
        : tag('严重异动预警 ' + ((rs.triggered || 0) + (rs.imminent || 0)), 'red') +
          tag('交易风险高 ' + (rs.tradeHigh || 0), 'warn')) + '</div></div>';
  }

  function dgSource(j) {
    const m = j.meta, o = S.dgOpts;
    return '<div class="card pad dg-source">' +
      '<div>数据溯源：东方财富涨停 / 炸板 / 跌停池（交易日 <b>' + E(m.poolDate) + '</b>）· 历史池近 <b>' +
      E((m.historyDates || []).length) + '</b> 个交易日 · 昨日连板股今日溢价 = 腾讯证券实时快照（' +
      E(m.quotesOk) + '/' + E(m.prevCodesCount) + ' 只，时点 ' + E(m.quoteTick || '—') + '）· 指数：腾讯证券</div>' +
      '<div class="small muted">' + E(m.dataSourceNote) + ' · 生成 ' + E(m.generatedAt) + ' · 服务端耗时 ' + E(m.elapsedMs) + ' ms</div>' +
      (m.empty ? '<div class="pb-warn">' + E(m.emptyReason) + '</div>' : '') +
      (m.historyNote ? '<div class="small muted">口径：' + E(m.historyNote) + '</div>' : '') +
      '<div class="dg-actions">' +
      '<button class="btn btn-primary" id="dgReload">重新扫描</button> ' +
      '<label class="small muted">范围 <select class="sel" id="dgShowAll">' +
      '<option value="0"' + (Number(o.showAll) === 0 ? ' selected' : '') + '>仅龙头（只做龙头）</option>' +
      '<option value="1"' + (Number(o.showAll) === 1 ? ' selected' : '') + '>全池对照（含后排）</option></select></label> ' +
      '<label class="small muted">地位 <select class="sel" id="dgRole">' +
      ['全部', '空间板', '累计板龙', '题材龙', '卡位股', '容量中军', '后排/补涨', '孤立涨停'].map(r =>
        '<option value="' + E(r) + '"' + (o.role === r ? ' selected' : '') + '>' + E(r) + '</option>').join('') +
      '</select></label> ' +
      '<label class="small muted">回溯 <select class="sel" id="dgDays">' +
      [7, 10, 12, 15].map(n => '<option value="' + n + '"' + (Number(o.days) === n ? ' selected' : '') + '>近 ' + n + ' 日</option>').join('') +
      '</select></label> ' +
      '<label class="small muted">排序 <select class="sel" id="dgSort">' +
      [['score', '观察优先级'], ['boards', '连续连板'], ['cumBoards', '累计板数'], ['divergence', '分歧度'], ['consensus', '一致度'], ['amount', '成交额']]
        .map(p => '<option value="' + p[0] + '"' + (o.sort === p[0] ? ' selected' : '') + '>' + E(p[1]) + '</option>').join('') +
      '</select></label> ' +
      '<button class="btn" id="dgMethod">' + (S.dgMethodOpen ? '收起' : '查看') + '打法口径</button>' +
      '<button class="btn btn-accent" id="dgHistOpen">历史回放 · 看过去某日的分析</button>' +
      '<span class="small muted">全局筛选（市值 / 板块 / ST / 关键字）同样作用于本模块</span></div></div>';
  }

  function dgSentimentCard(j) {
    const s = j.sentiment;
    const kpis = [
      ['涨停家数', s.ztCount, '东财涨停池'], ['炸板家数', s.zbCount, '东财炸板池'],
      ['炸板率', dgNum(s.brokenRate, '%'), '炸板/(涨停+炸板)'], ['跌停家数', s.dtCount, '东财跌停池'],
      ['最高连板', s.maxBoards + ' 板', '空间板高度'],
      ['昨日连板溢价', s.prevPremium === null ? '—' : (s.prevPremium > 0 ? '+' : '') + s.prevPremium + '%', '腾讯实时快照'],
      ['昨日涨停晋级率', dgNum(s.promoteRate, '%'), '今日仍涨停占比']
    ];
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>情绪温度计与高位反馈</h4>' +
      src('东方财富涨停/炸板/跌停池 ' + s.date + ' · 腾讯实时快照 ' + (j.meta.quoteTick || '—')) + '</div>' +
      '<div class="dg-kpi-grid">' + kpis.map(k =>
        '<div class="dg-kpi"><span>' + E(k[0]) + '</span><b>' + E(k[1]) + '</b><em>' + E(k[2]) + '</em></div>').join('') + '</div>' +
      '<div class="dg-temp"><div class="dg-temp-top"><span>情绪温度 <b>' + E(s.temperature) + '</b> / 100</span>' +
      '<span>' + tag(s.phase, 'warn') + ' ' + tag('姿态：' + s.stance, 'blue') + '</span></div>' + dgBar(s.temperature, 'blue') +
      '<div class="small muted">分档：≥70 主升 · 55~70 修复/进攻 · 42~55 高位震荡 · 28~42 分歧退潮 · &lt;28 冰点；高位负反馈强制降档</div></div>' +
      (s.deteriorateNote ? '<div class="pb-warn">' + E(s.deteriorateNote) + '</div>' : '') +
      '<div class="tbl-wrap dg-factor-tbl"><table><thead><tr><th>因子</th><th>实测值</th><th>得分</th><th>权重</th><th>口径</th></tr></thead><tbody>' +
      (s.parts || []).map(p => '<tr><td>' + E(p.name) + '</td><td>' + E(p.value === null ? '—' : p.value) +
        '</td><td>' + E(p.score) + '</td><td>' + E(p.weight) + '%</td><td class="small muted">' + E(p.detail) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      (s.idxNote ? '<div class="small muted" style="margin-top:8px">指数：' + E(s.idxNote) + '</div>' : '') +
      '<div class="note-box">' + E(s.note) + '</div></div>';
  }

  function dgLadderCard(j) {
    const s = j.sentiment;
    const max = Math.max(1, ...j.ladder.map(l => l.count));
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>连板梯队与断层</h4>' +
      src('东方财富涨停池 ' + s.date + ' · 连板数 lbc') + '</div>' +
      (j.ladder || []).map(l =>
        '<div class="dg-ladder-row"><span class="dg-lb">' + E(l.boards) + ' 板</span>' +
        '<div class="dg-ladder-track"><i style="width:' + (l.count / max * 100).toFixed(1) + '%"></i></div>' +
        '<b>' + E(l.count) + ' 家</b><span class="small muted">' + E(l.names.join('、') || '—') +
        (l.codes.length < l.count ? ' 等' : '') + '</span></div>').join('') +
      '<div class="note-box">梯队' + (s.ladderComplete ? '目前无断层（1~' + E(s.maxBoards) + ' 板均有标的）'
        : '在 ' + E(s.gaps.join('/')) + ' 板出现断层，按龙头战法属于退潮信号') +
      '；断层是退潮信号，梯队完整度决定卡位股逻辑是否成立。代表股最多显示 6 只。</div></div>';
  }

  function dgThemesCard(j) {
    const rows = (j.themes || []).slice(0, 10);
    const spark = t => {
      const max = Math.max(1, ...t.series.map(s => s.count));
      return '<div class="dg-spark" title="' + E(t.series.map(s => String(s.date).slice(4) + ':' + s.count + '家').join(' / ')) + '">' +
        t.series.map(s => '<i style="height:' + Math.max(3, s.count / max * 22) + 'px"></i>').join('') + '</div>';
    };
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>题材强度与生命周期</h4>' +
      src('东财行业分类 hybk · 近 5 个交易日涨停家数（历史池）') + '</div>' +
      (rows.length ? '<div class="tbl-wrap"><table><thead><tr><th>行业</th><th>涨停</th><th>最高板</th><th>阶段</th><th>强度</th><th>近 5 日家数</th></tr></thead><tbody>' +
        rows.map(t => '<tr><td><b>' + E(t.industry) + '</b><div class="small muted">' + E(t.names.slice(0, 3).join('、')) + '</div></td>' +
          '<td>' + E(t.count) + '</td><td>' + E(t.maxBoards) + ' 板</td><td>' + tag(t.stage, t.stage === '退潮' ? 'green' : t.stage === '高潮' ? 'warn' : 'blue') + '</td>' +
          '<td><div class="dg-mini-bar">' + dgBar(t.strength, 'purple') + '<span>' + E(t.strength) + '</span></div></td>' +
          '<td>' + spark(t) + '<div class="small muted">' + t.series.map(s => s.count).join('/') + '</div></td></tr>').join('') +
        '</tbody></table></div>' : '<div class="card empty">当日无涨停行业数据</div>') +
      '<div class="note-box">阶段由近 5 日该行业涨停家数序列、最高板变化与今日一字占比判定；东财行业分类较细，「孤立涨停」偏多是分类口径的结果，可能与市场俗称题材不同。</div></div>';
  }

  function dgThemeUnderstandingCard(j) {
    const nt = j.nameThemes || [], cp = j.conceptThemes || [], info = j.themeUnderstanding || {};
    const ntHtml = nt.length
      ? '<div class="grid2">' + nt.slice(0, 8).map(t =>
        '<div class="info-card theme-card"><h4>' + E(t.label) + ' ' + tag(t.kind, t.kind === '玄学名字' ? 'purple' : 'blue') + '</h4>' +
        '<div class="theme-meta">' + tag(t.group, 'purple') + tag(t.count + ' 只涨停', 'red') +
        tag('最高 ' + t.maxBoards + ' 连板', '') + tag('累计最高 ' + t.maxCum + ' 板', 'blue') + '</div>' +
        '<p><b>成分股：</b>' + E(t.names.join('、')) + '</p>' +
        '<p style="margin-top:5px"><b>梯队：</b>' + (t.leaders || []).map(l => E(l.name) + '（' + E(l.label) + '）').join('、') + '</p>' +
        '<div class="note-box"><b>识别依据：</b>' + E(t.basis) + '<br><b>边界：</b>' + E(t.caveat) + '</div></div>'
      ).join('') + '</div>'
      : '<div class="card empty">当日涨停股名称未出现符合阈值的字面共振（玄学 / 名字主线未识别到，不代表市场没有，仅说明字面证据不足）</div>';
    const cpHtml = cp.length
      ? '<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th class="left">概念板块</th><th>涨停数</th><th>最高连板</th><th>累计最高</th><th class="left">成分股</th></tr></thead><tbody>' +
        cp.map(c => '<tr><td class="left"><b>' + E(c.name) + '</b></td><td>' + E(c.count) + '</td><td>' + E(c.maxBoards) + '</td><td>' + E(c.maxCum) + '</td><td class="left small">' + E(c.names.join('、')) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<div class="card empty" style="margin-top:10px">当日涨幅居前的概念板块中，未出现 ≥2 只成分股同时涨停</div>';
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>题材理解补充 · 名称 / 玄学共振与跨行业概念</h4>' +
      src('新浪财经概念板块成分映射（' + E(j.meta.conceptBoardCount || 0) + ' 个板块）＋ 涨停股名称字面聚类；交易日 ' + E(j.meta.poolDate || '—')) + '</div>' +
      '<div class="note-box" style="margin-bottom:12px">' + E(info.note || '') + '<br><b>能力边界：</b>' + E(info.caveat || '') + '</div>' +
      '<div class="dg-h5">① 名称 / 玄学字面共振（' + E(nt.length) + ' 组）</div>' + ntHtml +
      '<div class="dg-h5" style="margin-top:14px">② 跨行业概念板块归属（' + E(cp.length) + ' 组）</div>' + cpHtml +
      '</div>';
  }

  function dgValidationCard(j) {
    const v = j.validation || {};
    const emptyRate = () => ({ n: 0, promoted: 0, rate: null });
    const line = (label, o, cls) => '<div class="dg-val-row"><span>' + E(label) + '</span><b>' + E(o.n) + '</b>' +
      '<span class="small muted">晋级 ' + E(o.promoted) + '</span><b class="' + (cls || '') + '">' +
      (o.rate === null ? '—' : o.rate + '%') + '</b>' + dgBar(o.rate || 0, cls === 'down' ? 'green' : 'blue') + '</div>';
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>历史验证 · 次日晋级率</h4>' +
      src('东方财富历史涨停池近 ' + (j.meta.historyDates || []).length + ' 个交易日 · ' + (v.days || 0) + ' 组「基准日→次日」样本') + '</div>' +
      '<div class="dg-val-grid"><div><div class="dg-h5">按一致 / 分歧分类</div>' +
      line('全部龙头', v.overall || emptyRate()) + line('良性分歧', v.divergence || emptyRate()) + line('一致加速', v.consensus || emptyRate()) +
      '</div><div><div class="dg-h5">按分歧度分组</div>' +
      (v.byDivergenceBand || []).map(b => line(b.band, b)).join('') + '</div></div>' +
      (v.insufficient ? '<div class="pb-warn">样本不足：良性分歧组与一致加速组至少一组样本 &lt;20，本模块只展示计数，不据此下结论，更不能反推「分歧无效」或「追一致更好」。</div>' : '') +
      '<div class="note-box"><b>怎么读：</b>晋级率 = 次日再次涨停且连板数增加的比例，<b>不等于收益率或可交易胜率</b>。一字/秒板的一致加速股次日继续涨停概率天然更高，但往往买不进或只能涨停价成交；「卖在一致」讲的是赔率与兑现风险，不是「次日一定不涨」。</div>' +
      '<div class="note-box">' + E(v.note || '') + '</div></div>';
  }

  function dgMethodCard(j) {
    const m = j.methodology || {};
    return '<div class="card pad dg-method" id="dgMethodBox" style="display:' + (S.dgMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">' + E(m.title || '打法口径') + '（先看规则，再看结论）</h4>' +
      (m.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(m.caveat || '') + '</div></div>';
  }

  /* ── 严重异动预测 / 交易风险标记（真实日K + 个股公告，不参与评分） ── */
  function dgRiskBadges(x) {
    const r = x && x.risk;
    if (!r || !(r.badges || []).length) return '';
    return '<div class="dg-risk-badges">' + r.badges.map(b => {
      const cls = b.kind === 'severe'
        ? (b.level === 'triggered' || b.level === 'imminent' ? 'rk-sev-high' : 'rk-sev-mid')
        : (b.level === 'high' ? 'rk-trd-high' : 'rk-trd-mid');
      return '<span class="dg-risk-badge ' + cls + '" title="' + E(b.title) + '">' + E(b.label) + '</span>';
    }).join('') + '</div>';
  }

  function dgRiskMethodCard(j) {
    const m = j.riskMethodology, meta = j.riskMeta || {};
    if (!m) return '';
    return '<div class="card pad dg-risk-method"><div class="dg-card-head"><h4>严重异动预测 · 交易风险标记口径</h4>' +
      '<span class="small muted">规则化阈值推算，不是交易所认定，也不参与龙头评分</span></div>' +
      '<div class="dg-risk-method-rules">' +
      (m.rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '</div><div class="note-box">' + E(m.caveat || '') + '</div>' +
      '<div class="small muted">本次覆盖：' + E(meta.klineOk || 0) + '/' + E(meta.klineTotal || 0) +
      ' 只候选日K可用 · 关联公告 ' + E(meta.annItems || 0) + ' 条（时点 ' + E(meta.annAsOf || '—') + '）· 日K来源 ' +
      E((meta.klineSources || []).join(' / ') || '不可用') +
      (meta.error ? ' · <b>部分数据获取失败：' + E(meta.error) + '</b>' : '') + '</div></div>';
  }

  function dgRiskCard(x) {
    const r = x && x.risk;
    const head = '<div class="card pad dg-card dg-risk-card"><div class="dg-card-head"><h4>严重异动预测 · 交易风险</h4>' +
      '<span class="small muted">真实日K + 个股公告 · 不参与评分</span></div>';
    if (!r) return head + '<div class="empty">本次未获取到该股的风险数据，系统不会用推测数据填充。</div></div>';
    const v = r.severe || {}, t = r.trade || {};
    const cls = (v.level === 'triggered' || v.level === 'imminent') ? 'high'
      : (v.level === 'near' || v.level === 'watch' ? 'mid' : 'low');
    const status = '<div class="dg-risk-status ' + cls + '"><b>' + E(v.label || '异动数据不可用') + '</b>' +
      '<span>交易风险 · ' + E(t.levelLabel || '—') + '（' + E(t.flagCount || 0) + ' 项证据）</span>' +
      (v.need10 !== null && v.need10 !== undefined && v.need10 > 0
        ? '<span>距 +100% 阈值约 ' + E(v.need10) + ' 个涨停</span>' : '') + '</div>';
    const tbl = (v.evidence || []).length
      ? '<div class="tbl-wrap"><table><thead><tr><th>指标</th><th>数值</th><th>阈值 / 提示线</th><th>判读</th></tr></thead><tbody>' +
        v.evidence.map(e => '<tr><td>' + E(e.label) + '</td><td><b>' + E(e.value) + '</b></td><td>' + E(e.threshold) +
          '</td><td class="small muted">' + E(e.note) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<div class="empty">日K不可用，无法计算阈值距离。</div>';
    const srcNote = '<div class="small muted">日K来源：' + E(v.source || '不可用') + '（' +
      (v.adjusted === false ? '不复权' : (v.adjusted === true ? '前复权' : '口径未知')) + '，' +
      E(v.klineCount || 0) + ' 根，截至 ' + E(v.lastDate || '—') + '）· 关联公告 ' + E(r.annCount || 0) +
      ' 条 · 板块口径 ' + E(v.board || '—') + '</div>';
    const action = '<div class="dg-risk-action"><b>条件化提示：</b>' + E(v.action || '') + '</div>';
    const flags = '<div class="dg-h5">交易风险证据（' + E(t.flagCount || 0) + ' 项，按来源标注）</div>' +
      ((t.flags || []).length ? t.flags.map(f =>
        '<div class="dg-risk-flag ' + E(f.severity) + '"><div class="dg-risk-flag-top"><b>' + E(f.tag) + '</b>' +
        '<span class="mini-tag">' + (f.kind === 'announcement' ? '个股公告' : '量价 / 规则推算') + '</span>' +
        '<span class="mini-tag">' + (f.severity === 'high' ? '高危' : '一般') + '</span></div>' +
        '<div class="small muted">' + E(f.detail) + '</div>' +
        ((f.links || []).length ? '<div class="dg-risk-links">' + f.links.map(l =>
          (l.url ? '<a href="' + E(l.url) + '" target="_blank" rel="noopener noreferrer">' + E(l.title) + ' ↗</a>' : '') +
          (l.pdfUrl ? ' <a href="' + E(l.pdfUrl) + '" target="_blank" rel="noopener noreferrer">公告 PDF ↗</a>' : '')
        ).join('') + '</div>' : '') + '</div>').join('')
        : '<div class="small muted">未命中公告风险词，量价字段也未触发风险提示线。</div>');
    return head + status + tbl + srcNote + action + flags + '<div class="note-box">' + E(v.caveat || '') + '</div></div>';
  }

  function dgListItems(j) {
    return (j.list || []).map(x => {
      const edge = dgEdgeOf(x);
      return '<div class="dg-item' + (x.code === S.dgSelected ? ' active' : '') + (edge ? ' dg-edge edge-' + E(edge.key) : '') +
        '" data-code="' + E(x.code) + '"' + (edge ? ' data-edge-corner="★ ' + E(edge.label) + ' ' + E(edge.rate) + '" style="' + dgEdgeStyle(edge) + '" title="' + E(dgEdgeTitle(edge)) + '"' : '') + '>' +
      '<div class="dg-item-top"><b>' + sn(x.code, x.name) + '</b><span class="code muted">' + E(x.code) + '</span>' +
      '<span class="tag ' + dgDtypeCls(x.dtype) + '">' + E(x.dtype) + '</span>' +
      '<span class="dg-score">' + E(x.score) + '</span></div>' +
      '<div class="dg-item-mid"><span title="连续连板 / 近 N 日累计涨停">' + E(x.boardLabel || (x.boards + ' 板')) + '</span><span class="tag ' + (x.roleRank === 1 ? 'red' : 'blue') + '">' + E(x.role) + '</span>' +
      '<span class="muted">' + E(x.industry) + '</span></div>' +
      '<div class="dg-mini-meters"><span>一致 ' + E(x.consensus) + '</span>' + dgBar(x.consensus, 'blue') +
      '<span>分歧 ' + E(x.divergence) + '</span>' + dgBar(x.divergence, 'red') + '</div>' +
      '<div class="dg-item-bot">' + E(x.script.title) + '</div>' + dgRiskBadges(x) + '</div>';
    }).join('');
  }

  function dgDetailHead(x) {
    return '<div class="card pad dg-detail-head"><div class="dg-dh-top"><h3>' + sn(x.code, x.name) + ' <span class="muted" style="font-size:12px;font-weight:400">' + E(x.code) + '</span></h3>' +
      tag(x.boardLabel || (x.boards + ' 板'), 'red') + tag(x.role, 'blue') + tag(x.dtype, dgDtypeCls(x.dtype)) + dgEdgeBadge(x) +
      tag('观察优先级 ' + x.score, 'purple') + '<span class="muted small">' + E(x.industry) + ' · ' + E(x.board) + '</span></div>' +
      '<div class="dg-dh-reason"><b>地位依据：</b>' + E(x.roleReason) + '</div>' +
      '<div class="dg-kv-grid">' +
      dgKv('收盘价', N(x.price) + ' 元') + dgKv('当日涨幅', PC(x.pct)) +
      dgKv('首次封板', E(x.firstSeal)) + dgKv('最后封板', E(x.lastSeal)) +
      dgKv('炸板次数', E(x.brokenCount) + ' 次') + dgKv('封单/流通市值', N(x.sealFundRatio) + '%') +
      dgKv('换手率', N(x.turnover) + '%') + dgKv('成交额', AMT(x.amount)) +
      dgKv('流通市值', CAP(x.floatCap)) + dgKv('近期涨停', (x.statDays === null || x.statDays === undefined ? '—' : E(x.statDays) + ' 天 ' + E(x.statCount) + ' 板')) +
      dgKv('累计涨停密度', x.cumDensity === null || x.cumDensity === undefined ? '—' : N(x.cumDensity) + ' 板/日') +
      dgKv('封单额', AMT(x.sealFund)) + dgKv('所属题材阶段', x.theme ? E(x.theme.stage) + ' / 强度 ' + E(x.theme.strength) : '—') +
      dgKv('名称 / 玄学题材', (x.nameThemes || []).length ? E(x.nameThemes.join('、')) : '—') +
      dgKv('概念板块题材', (x.conceptThemes || []).length ? E(x.conceptThemes.join('、')) : '—') +
      '</div><div class="dg-trace">' + src(x.sourceNote) + '</div></div>';
  }
  function dgKv(k, v) { return '<div class="dg-kv"><span>' + E(k) + '</span><b>' + v + '</b></div>'; }

  function dgMeters(x) {
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>一致度 / 分歧度（0~100，全部由真实封板字段计算）</h4></div>' +
      '<div class="dg-meter-block"><div class="dg-meter-top"><b>一致度 ' + E(x.consensus) + '</b>' +
      '<span class="small muted">早封 + 零炸板 + 高封单比 + 低换手 = 筹码锁定</span></div>' + dgBar(x.consensus, 'blue') + '</div>' +
      '<div class="dg-meter-block"><div class="dg-meter-top"><b>分歧度 ' + E(x.divergence) + '</b>' +
      '<span class="small muted">炸板 + 换手 + 封板晚 + 封单弱 + 放量 = 筹码交换</span></div>' + dgBar(x.divergence, 'red') + '</div>' +
      '<div class="note-box">' + E(x.benignRule) + '；当前判定：<b>' + E(x.dtype) + '</b>。</div>' +
      '<div class="dg-factor-grid"><div><div class="dg-h5">一致度因子</div>' +
      (x.consensusParts || []).map(p => '<div class="dg-factor"><span>' + E(p.name) + ' <em>权重' + E(p.weight) + '%</em></span>' +
        '<b>' + E(p.got) + '</b>' + dgBar(p.got, 'blue') + '<small>' + E(p.detail) + '</small></div>').join('') +
      '</div><div><div class="dg-h5">分歧度因子</div>' +
      (x.divergenceParts || []).map(p => '<div class="dg-factor"><span>' + E(p.name) + ' <em>权重' + E(p.weight) + '%</em></span>' +
        '<b>' + E(p.got) + '</b>' + dgBar(p.got, 'red') + '<small>' + E(p.detail) + '</small></div>').join('') +
      '</div></div></div>';
  }

  function dgScriptCard(x) {
    const sc = x.script || {};
    return '<div class="card pad dg-card dg-script ' + (sc.tone || '') + '"><div class="dg-card-head">' +
      '<h4>' + E(sc.title) + '</h4>' + tag('明日条件化剧本', dgToneCls(sc.tone)) + '</div>' +
      '<div class="dg-thesis">' + E(sc.thesis) + '</div>' +
      '<div class="dg-h5">触发条件 → 观察结论</div>' +
      (sc.triggers || []).map((t, i) => '<div class="dg-trigger"><b>' + (i + 1) + '</b>' +
        '<div><span class="dg-cond">若 ' + E(t.condition) + '</span><span class="dg-action">→ ' + E(t.action) + '</span></div></div>').join('') +
      '<div class="dg-h5">失效条件 / 证伪信号</div><ul class="dg-list-plain">' +
      (sc.invalidation || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul>' +
      '<div class="dg-risk"><b>风险：</b>' + E(sc.risk) + '</div>' +
      '<div class="dg-h5">明日需同步观察</div><ul class="dg-list-plain">' +
      (x.watch || []).map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div>';
  }

  function dgScoreCard(x) {
    return '<div class="card pad dg-card"><div class="dg-card-head"><h4>观察优先级评分明细</h4>' +
      '<span class="small muted">满分 100 = 地位 30 + 分歧质量 25 + 题材 20 + 情绪 15 − 风险 10</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>因子</th><th>得分</th><th>上限</th><th>依据</th></tr></thead><tbody>' +
      (x.scoreParts || []).map(p => '<tr><td>' + E(p.name) + '</td><td><b>' + E(p.got) + '</b></td><td>' +
        (p.max === 0 ? '扣减项' : E(p.max)) + '</td><td class="small muted">' + E(p.detail) + '</td></tr>').join('') +
      '</tbody></table></div><div class="note-box">排序是「明日观察优先级」，不是收益预测，更不是买入建议；一致加速的一字板在此项会被扣分。</div></div>';
  }

  function renderDragonDetail() {
    const j = S.dg; if (!j) return;
    const box = $('dgDetail'); if (!box) return;
    const x = (j.list || []).find(a => a.code === S.dgSelected);
    if (!x) { box.innerHTML = '<div class="card empty">请选择左侧标的查看地位依据、一致/分歧拆解与明日剧本</div>'; return; }
    box.innerHTML = dgDetailHead(x) + dgRiskCard(x) + dgMeters(x) + dgScriptCard(x) + dgScoreCard(x) + nwDetailCard(x);
  }

  /* ─────────── 明日龙头 · 历史回放（逐日重放 + 事后晋级验证） ─────────── */
  async function fetchDragonHistoryJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/dragon/review?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  async function loadDragonHistory(date, force) {
    if (S.dgHistLoading) return;
    S.dgHistLoading = true;
    S.dgHistError = null;
    $('pane-dragon').innerHTML = '<div class="card empty">正在回放 ' + E(date || '历史交易日') + ' 的涨停池分析与次日兑现结果…</div>';
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    q.set('days', '15');
    q.set('showAll', '1');
    q.set('limit', '60');
    if (force) q.set('force', '1');
    try {
      const j = await fetchDragonHistoryJson(q);
      S.dgHist = j;
      S.dgHistDate = j.meta && j.meta.poolDate;
      const dates = (j.review && j.review.availableDates) || [];
      if (!dates.some(d => String(d.date) === String(S.dgHistDate))) S.dgHistSelected = dates.length ? String(dates[0].date) : null;
      else S.dgHistSelected = String(S.dgHistDate);
      renderDragonHistory();
    } catch (e) {
      S.dgHistError = e.message;
      const offline = isConnError(e);
      $('pane-dragon').innerHTML = '<div class="card empty"><b>历史回放加载失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (offline ? E(SERVICE_HINT) : '服务端或上游数据源异常；系统不会用推测数据填充，可稍后重试。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="dhRetry">重试</button> ' +
        '<button class="btn" id="dhBack">返回实时分析</button></div>';
      $('dhRetry').onclick = () => loadDragonHistory(S.dgHistDate, true);
      $('dhBack').onclick = () => { S.dgHistOpen = false; renderDragon(); };
      if (offline) watchService('dragon');
    } finally { S.dgHistLoading = false; }
  }

  function dgHistBar(j) {
    const r = j.review || {}, dates = r.availableDates || [], m = j.meta || {};
    const opts = dates.map(d => {
      const sel = String(d.date) === String(S.dgHistSelected) ? ' selected' : '';
      return '<option value="' + E(d.date) + '"' + sel + '>' + E(fmtDate(d.date)) + '（涨停 ' + E(d.zt) + ' / 炸板 ' + E(d.zb) + '）</option>';
    }).join('');
    const hasNext = r.summary && r.summary.hasNext;
    return '<div class="card pad dh-bar"><div class="dh-bar-top"><div><b>历史回放</b>' +
      '<span class="small muted"> · 用与实时版相同的规则，重放「站在那天收盘时」看到的明日龙头分析</span></div>' +
      '<button class="btn" id="dhBackTop">返回实时分析</button></div>' +
      '<div class="dh-bar-ctl"><label class="small muted">选择交易日 <select class="sel" id="dhDate">' + opts + '</select></label>' +
      '<button class="btn" id="dhPrev" title="更早一个交易日">← 更早</button>' +
      '<button class="btn" id="dhNext" title="更近一个交易日" ' + (dates.length && String(S.dgHistSelected) === String(dates[0].date) ? 'disabled' : '') + '>更近 →</button>' +
      '<button class="btn btn-primary" id="dhGo">回放该日</button>' +
      '<span class="small muted">回放日数据截至 ' + E(fmtDate(m.poolDate)) + ' · 次日兑现' + (hasNext ? '取 ' + E(fmtDate(r.nextDate)) : '：尚无后续数据') + '</span></div>' +
      '<div class="dh-bar-note">' + E('无未来函数：当日分析只用该日及之前数据；实时溢价快照 / 指数 / 概念映射在历史回放中不可用，「昨日连板今日溢价」按中性计，故回放温度与当日实时版不直接可比。次日兑现为事后验证，不改写当日评分。') + '</div>' +
      '</div>';
  }

  function dhPct(v, digits) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '<span class="muted">—</span>';
    const n = Number(v), d = digits === undefined ? 2 : digits;
    return '<b class="' + (n > 0 ? 'up' : n < 0 ? 'down' : 'flat') + '">' + (n > 0 ? '+' : '') + n.toFixed(d) + '%</b>';
  }
  function dhPctSmall(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const n = Number(v);
    return '<span class="' + (n > 0 ? 'up' : n < 0 ? 'down' : 'flat') + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }

  function dgHistOutcomeCard(j) {
    const r = j.review || {}, su = r.summary || {}, rows = r.outcome || [], pf = su.perf || {};
    const pct = su.promoteRate === null ? '—' : su.promoteRate + '%';
    const surv = su.surviveRate === null ? '—' : su.surviveRate + '%';
    const ksrc = (pf.sources || []).join(' / ') || '日K不可用';
    const kadj = (pf.adjustedModes || []).length === 0 ? '口径未知'
      : (pf.adjustedModes || []).every(Boolean) ? '前复权'
        : (pf.adjustedModes || []).some(Boolean) ? '复权口径混用' : '不复权';
    const head = '<div class="card pad dg-card"><div class="dg-card-head"><h4>次日兑现 · 事后验证</h4>' +
      src(r.nextDate ? '回放日 ' + fmtDate(r.date) + ' 的龙头 → 下一交易日 ' + fmtDate(r.nextDate) + ' 真实涨停 / 炸板池；次日涨跌幅取 ' + ksrc + '（' + kadj + '），可用 ' + E(pf.available || 0) + '/' + E(pf.total || 0) : '回放日为最新交易日，暂无下一交易日数据') + '</div>';
    if (!su.hasNext) {
      return head + '<div class="empty">' + E(fmtDate(r.date) + ' 是当前可回溯的最新交易日，尚无下一交易日的真实池数据，无法计算次日晋级与涨跌幅。稍后数据更新后再回放即可看到兑现结果。') + '</div></div>';
    }
    const kpis = '<div class="dg-kpi-grid">' +
      '<div class="dg-kpi"><span>当日龙头候选</span><b>' + E(su.candidates) + '</b><em>回放选出的观察清单</em></div>' +
      '<div class="dg-kpi"><span>次日晋级</span><b>' + E(su.promoted) + '</b><em>连板数继续增加</em></div>' +
      '<div class="dg-kpi"><span>晋级率</span><b>' + E(pct) + '</b><em>晋级 / 候选，非收益率</em></div>' +
      '<div class="dg-kpi"><span>次日仍涨停</span><b>' + E(surv) + '</b><em>含晋级 + 连板持平</em></div>' +
      '<div class="dg-kpi"><span>次日平均涨跌</span><b>' + dhPct(pf.avgClosePct) + '</b><em>收盘 / 回放日收盘 − 1</em></div>' +
      '<div class="dg-kpi"><span>收盘上涨占比</span><b>' + E(pf.winRate === null ? '—' : pf.winRate + '%') + '</b><em>收盘涨幅 &gt; 0</em></div>' +
      '<div class="dg-kpi"><span>平均最高涨幅</span><b>' + dhPct(pf.avgHighPct) + '</b><em>盘中最大上冲</em></div>' +
      '<div class="dg-kpi"><span>平均最低涨幅</span><b>' + dhPct(pf.avgLowPct) + '</b><em>盘中最大回撤</em></div></div>';
    const byDtype = (su.byDtype || []).map(b =>
      '<tr><td>' + E(b.dtype) + '</td><td>' + E(b.n) + '</td><td>' + E(b.promoted) + '</td><td>' + E(b.rate === null ? '—' : b.rate + '%') + '</td>' +
      '<td>' + dhPct(b.avgClosePct) + '</td><td>' + E(b.winRate === null ? '—' : b.winRate + '%') + '</td></tr>').join('');
    const tbl = rows.length
      ? '<div class="tbl-wrap"><table><thead><tr><th>标的</th><th>地位</th><th>分歧类型</th><th>回放日连板</th><th>次日连板</th><th>结果</th><th>次日涨跌幅（收盘）</th><th>观察优先级</th></tr></thead><tbody>' +
        rows.map(o => {
          const p = o.perf || {}, edge = dgEdgeOf(o);
          const pc = p.available
            ? dhPct(p.closePct) + '<div class="small muted">开 ' + dhPctSmall(p.openPct) + ' / 高 ' + dhPctSmall(p.highPct) + ' / 低 ' + dhPctSmall(p.lowPct) + '</div>'
            : '<span class="small muted">' + E(p.reason || '无数据') + '</span>';
          return '<tr' + (edge ? ' class="dg-edge-row edge-' + E(edge.key) + '" style="' + dgEdgeStyle(edge) + '" title="' + E(dgEdgeTitle(edge)) + '"' : '') + '><td><b>' + sn(o.code, o.name) + '</b>' + dgEdgeBadge(o) + '<div class="small muted">' + E(o.code) + (o.theme ? ' · ' + E(o.theme) : '') + '</div></td>' +
            '<td>' + E(o.role) + '</td><td>' + E(o.dtype) + '</td><td>' + E(o.boards) + ' 板</td><td>' + (o.nextBoards === null ? '—' : E(o.nextBoards) + ' 板') + '</td>' +
            '<td>' + tag(o.resultLabel, o.result === 'promoted' ? 'red' : o.result === 'broken' ? 'green' : o.result === 'pending' ? '' : 'blue') + '</td>' +
            '<td>' + pc + '</td><td>' + E(o.score) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="empty">当日回放没有可展示的龙头候选。</div>';
    const extremes = (pf.best || pf.worst)
      ? '<div class="small muted" style="margin-top:8px">涨幅最高：<b>' + E((pf.best || {}).name || '—') + '</b> ' + dhPct((pf.best || {}).closePct) +
        '　跌幅最大：<b>' + E((pf.worst || {}).name || '—') + '</b> ' + dhPct((pf.worst || {}).closePct) + '</div>' : '';
    return head + kpis +
      '<div class="dh-dtype"><div class="dg-h5">按分歧类型看晋级与次日涨跌（样本小，仅作对照）</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>分歧类型</th><th>候选</th><th>晋级</th><th>晋级率</th><th>平均次日涨跌</th><th>上涨占比</th></tr></thead><tbody>' +
      (byDtype || '<tr><td colspan="6" class="small muted">无样本</td></tr>') + '</tbody></table></div></div>' + tbl + extremes +
      '<div class="note-box">晋级率只衡量「回放日龙头在次日是否继续涨停且连板数增加」，<b>不等于收益率或可交易胜率</b>：一字 / 秒板天然更易连板但往往买不进。涨跌幅以<b>回放日收盘价</b>为基准，收盘 / 开盘 / 最高 / 最低分别计算，来自真实日K（' + E(ksrc) + ' · ' + E(kadj) + '）；它同样<b>不等于可交易收益</b>，因为买入价、滑点与能否成交都未计入。此表是事后验证，回放日的评分、情绪与候选均未使用次日数据，不可反推「该提前知道」。样本跨日重复、不独立，历史池约 15 日、样本量小。</div></div>';
  }

  function renderDragonHistory() {
    const j = S.dgHist; if (!j) return;
    const bar = dgHistBar(j);
    const focus = '<div class="card pad dg-card"><div class="dg-card-head"><h4>那天的「明日 3 个核心变量」</h4>' +
      '<span class="small muted">回放日收盘时按当时数据生成，不含次日结果</span></div>' +
      (j.focus || []).map((f, i) => '<div class="dg-focus"><b>' + (i + 1) + '</b><span>' + E(f) + '</span></div>').join('') + '</div>';
    const list = j.list || [];
    const perfMap = {};
    ((j.review || {}).outcome || []).forEach(o => { if (o && o.code) perfMap[o.code] = o.perf; });
    const body = list.length
      ? '<div class="dg-layout"><div class="dg-list" id="dhList">' + list.map(x => {
        const edge = dgEdgeOf(x);
        return '<div class="dg-item' + (x.code === S.dgHistSelected ? ' active' : '') + (edge ? ' dg-edge edge-' + E(edge.key) : '') +
          '" data-code="' + E(x.code) + '"' + (edge ? ' data-edge-corner="★ ' + E(edge.label) + ' ' + E(edge.rate) + '" style="' + dgEdgeStyle(edge) + '" title="' + E(dgEdgeTitle(edge)) + '"' : '') + '>' +
        '<div class="dg-item-top"><b>' + sn(x.code, x.name) + '</b><span class="code muted">' + E(x.code) + '</span>' +
        '<span class="tag ' + dgDtypeCls(x.dtype) + '">' + E(x.dtype) + '</span><span class="dg-score">' + E(x.score) + '</span></div>' +
        '<div class="dg-item-mid"><span>' + E(x.boardLabel || (x.boards + ' 板')) + '</span>' +
        '<span class="tag ' + (x.roleRank === 1 ? 'red' : 'blue') + '">' + E(x.role) + '</span><span class="muted">' + E(x.industry) + '</span></div>' +
        '<div class="dg-mini-meters"><span>一致 ' + E(x.consensus) + '</span>' + dgBar(x.consensus, 'blue') +
        '<span>分歧 ' + E(x.divergence) + '</span>' + dgBar(x.divergence, 'red') + '</div>' +
        '<div class="dg-item-bot">' + E(x.script && x.script.title || '') +
        (perfMap[x.code] && perfMap[x.code].available ? '<span style="float:right">次日 ' + dhPct(perfMap[x.code].closePct) + '</span>' : '') + '</div></div>';
      }).join('') + '</div>' +
        '<div class="dg-detail" id="dhDetail"></div></div>'
      : '<div class="card empty">该交易日回放没有符合条件的龙头候选（可切到「全池对照」口径的回放或换一天）。</div>';
    const method = '<div class="card pad dg-method" id="dhMethodBox" style="display:' + (S.dgHistMethodOpen ? '' : 'none') + '">' +
      '<h4 style="font-size:13px;margin-bottom:9px">' + E((j.methodology || {}).title || '回放口径') + '</h4>' +
      ((j.methodology || {}).rules || []).map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E((j.methodology || {}).note || '') + '</div></div>';
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：历史回放基于公开涨停池与量化规则，仅供研究复盘，不构成投资建议。过往表现不预示未来收益。</div>';
    $('pane-dragon').innerHTML = bar + dgHead(j) +
      '<div class="dh-method-toggle"><button class="btn" id="dhMethod">查看回放口径与边界</button></div>' + method +
      dgSentimentCard(j) + '<div class="dg-grid2">' + dgLadderCard(j) + dgThemesCard(j) + '</div>' +
      dgThemeUnderstandingCard(j) + focus + dgValidationCard(j) + dgEdgeLegendCard() +
      dgHistOutcomeCard(j) + body + disc;

    const setDate = d => { if (d) { S.dgHistSelected = String(d); loadDragonHistory(S.dgHistSelected, false); } };
    $('dhBackTop').onclick = () => { S.dgHistOpen = false; renderDragon(); };
    $('dhGo').onclick = () => setDate(($('dhDate') && $('dhDate').value));
    const dates = (j.review && j.review.availableDates) || [];
    const ci = dates.findIndex(d => String(d.date) === String(S.dgHistSelected));
    $('dhPrev').onclick = () => { if (ci >= 0 && ci < dates.length - 1) setDate(dates[ci + 1].date); };
    $('dhNext').onclick = () => { if (ci > 0) setDate(dates[ci - 1].date); };
    $('dhMethod').onclick = () => {
      S.dgHistMethodOpen = !S.dgHistMethodOpen;
      $('dhMethodBox').style.display = S.dgHistMethodOpen ? '' : 'none';
      $('dhMethod').textContent = S.dgHistMethodOpen ? '收起回放口径' : '查看回放口径与边界';
    };
    const renderHistDetail = () => {
      const box = $('dhDetail'); if (!box) return;
      const x = list.find(a => a.code === S.dgHistSelected);
      if (!x) { box.innerHTML = '<div class="card empty">选择左侧标的查看当日的地位依据与明日剧本</div>'; return; }
      const ot = (j.review.outcome || []).find(o => o.code === x.code);
      const outCard = ot ? '<div class="card pad dg-card"><div class="dg-card-head"><h4>该股次日兑现（事后验证）</h4></div>' +
        '<div class="dg-kv-grid">' + dgKv('回放日连板', E(ot.boards) + ' 板') + dgKv('次日连板', ot.nextBoards === null ? '—' : E(ot.nextBoards) + ' 板') +
        dgKv('次日结果', E(ot.resultLabel)) + dgKv('观察优先级', E(ot.score)) + '</div>' +
        '<div class="note-box">此项为事后验证，回放日的评分与剧本未使用次日数据。</div></div>' : '';
      box.innerHTML = dgDetailHead(x) + dgMeters(x) + dgScriptCard(x) + dgScoreCard(x) + outCard;
    };
    $('pane-dragon').querySelectorAll('#dhList .dg-item').forEach(el => {
      el.onclick = () => {
        S.dgHistSelected = el.dataset.code;
        $('pane-dragon').querySelectorAll('#dhList .dg-item').forEach(n => n.classList.toggle('active', n === el));
        renderHistDetail();
      };
    });
    renderHistDetail();
  }

  function renderDragon() {
    const j = S.dg; if (!j) return;
    if (S.dgHistOpen) { renderDragonHistory(); return; }
    const s = j.sentiment, list = j.list || [];
    const focus = '<div class="card pad dg-card"><div class="dg-card-head"><h4>明日 3 个核心变量</h4>' +
      '<span class="small muted">由今日真实梯队 / 情绪 / 题材数据生成，不是预测</span></div>' +
      (j.focus || []).map((f, i) => '<div class="dg-focus"><b>' + (i + 1) + '</b><span>' + E(f) + '</span></div>').join('') + '</div>';
    const empty = '<div class="card empty dg-empty"><b>当前没有符合条件的龙头候选</b><br>' +
      '<span class="small muted">' + (j.meta.empty ? E(j.meta.emptyReason)
        : '「只做龙头」纪律下已剔除 ' + E((j.excluded || []).length) + ' 只后排 / 孤立涨停。可切换「全池对照」查看被剔除标的，或放宽地位筛选。系统不会用推测数据填充。') +
      '</span></div>';
    const body = list.length
      ? '<div class="dg-layout"><div class="dg-list" id="dgList">' + dgListItems(j) + '</div>' +
      '<div class="dg-detail" id="dgDetail"></div></div>'
      : empty;
    const excl = (j.excluded || []).length && Number(S.dgOpts.showAll) === 0
      ? '<div class="card pad dg-card dg-excluded"><div class="dg-h5">「只做龙头」纪律剔除（' + E(j.excluded.length) + ' 只，仅作对照）</div>' +
      '<div class="dg-excl-tags">' + j.excluded.slice(0, 18).map(x =>
        '<span class="tag" title="' + E(x.roleReason) + '">' + E(x.name) + ' ' + E(x.boardLabel || (x.boards + '板')) + ' · ' + E(x.role) + '</span>').join('') +
      (j.excluded.length > 18 ? '<span class="small muted">等共 ' + E(j.excluded.length) + ' 只</span>' : '') + '</div></div>' : '';
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';
    $('pane-dragon').innerHTML = dgHead(j) + dgSource(j) + nwPanel() + dgSentimentCard(j) +
      '<div class="dg-grid2">' + dgLadderCard(j) + dgThemesCard(j) + '</div>' +
      dgThemeUnderstandingCard(j) +
      focus + dgValidationCard(j) + dgEdgeLegendCard() + dgMethodCard(j) + dgRiskMethodCard(j) + body + excl + disc;

    $('dgReload').onclick = () => loadDragon(true);
    $('dgShowAll').onchange = e => { S.dgOpts.showAll = Number(e.target.value); loadDragon(true); };
    $('dgRole').onchange = e => { S.dgOpts.role = e.target.value; loadDragon(true); };
    $('dgDays').onchange = e => { S.dgOpts.days = Number(e.target.value); loadDragon(true); };
    $('dgSort').onchange = e => { S.dgOpts.sort = e.target.value; loadDragon(true); };
    $('dgHistOpen').onclick = () => {
      S.dgHistOpen = true;
      const d = (j.meta && j.meta.historyDates || []).length ? j.meta.historyDates[0].date : null;
      loadDragonHistory(d, false);
    };
    $('dgMethod').onclick = () => {
      S.dgMethodOpen = !S.dgMethodOpen;
      $('dgMethodBox').style.display = S.dgMethodOpen ? '' : 'none';
      $('dgMethod').textContent = (S.dgMethodOpen ? '收起' : '查看') + '打法口径';
    };
    $('pane-dragon').querySelectorAll('.dg-item').forEach(el => {
      el.onclick = () => {
        S.dgSelected = el.dataset.code;
        $('pane-dragon').querySelectorAll('.dg-item').forEach(n => n.classList.toggle('active', n === el));
        renderDragonDetail();
      };
    });
    renderDragonDetail();
    renderNewsPanel();
  }

  async function fetchDragonJson(q) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch('/api/dragon?' + q.toString(), { cache: 'no-store' });
        let j;
        try { j = await r.json(); }
        catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '），请确认访问的是本系统地址'); }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      } catch (e) {
        lastErr = e;
        if (!isConnError(e) || i === 2) break;
        if (!S.dg) $('pane-dragon').innerHTML = '<div class="card empty">本地服务未响应，正在重连…（第 ' + (i + 1) + ' 次）</div>';
        await new Promise(res => setTimeout(res, 1000 + i * 1200));
      }
    }
    throw lastErr;
  }

  async function loadDragon(force) {
    if (S.dgLoading) return;
    S.dgLoading = true;
    if (!S.dg) $('pane-dragon').innerHTML = '<div class="card empty">正在回溯涨停/炸板池、核对连板梯队与封板质量，生成明日观察清单…</div>';
    const q = new URLSearchParams();
    const o = S.dgOpts;
    ['days', 'showAll', 'sort', 'sortDir', 'role', 'limit'].forEach(k => {
      if (o[k] !== '' && o[k] !== undefined && o[k] !== null) q.set(k, o[k]);
    });
    // 复用全局筛选（与本模块相关的字段）
    const f = collectFilters();
    ['board', 'capMin', 'capMax', 'excludeST', 'keyword'].forEach(k => {
      if (f[k] !== '' && f[k] !== undefined && f[k] !== null) q.set(k, f[k]);
    });
    if (force) q.set('force', '1');
    try {
      const j = await fetchDragonJson(q);
      S.dg = j; S.dgAt = Date.now(); S.dgError = null; S.dgFilters = S.lastFilters;
      const list = j.list || [];
      if (!list.some(x => x.code === S.dgSelected)) S.dgSelected = list.length ? list[0].code : null;
      renderDragon();
      $('badgeDragon').textContent = list.length;
      const codes = list.map(x => x.code).join(',');
      const changed = S.newsCodes !== codes;
      S.newsCodes = codes;
      if (S.tab === 'dragon') {
        if (!S.news) startNewsMonitor();
        else if (changed) loadNews(false);
        else scheduleNews(S.newsInterval);
      }
    } catch (e) {
      S.dgError = e.message;
      const offline = isConnError(e);
      $('badgeDragon').textContent = '—';
      $('pane-dragon').innerHTML = '<div class="card empty"><b>明日龙头数据加载失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (offline ? E(SERVICE_HINT)
          : '服务端或上游数据源返回异常；系统不会用推测数据填充，稍后可点下方按钮重试。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="dgRetry">重新扫描</button></div>';
      $('dgRetry').onclick = () => loadDragon(true);
      if (offline) watchService('dragon');
    } finally { S.dgLoading = false; }
  }

  /* ─────────────── 消息面实时监控（明日龙头） ─────────────── */
  const nwTime = t => { const s = String(t || ''); return s.length >= 16 ? s.slice(5, 16) : (s || '—'); };
  const nwToneCls = x => x.tone === 'bull' ? 'nw-bull' : (x.tone === 'bear' ? 'nw-bear' : 'nw-neutral');
  const nwToneLabel = x => (x.toneLabel || '中性') + (x.severity === 'high' && x.tone === 'bear' ? ' · 高危' : '');

  function nwPanel() {
    return '<div class="card pad nw-card" id="nwCard"><div id="nwBox"></div></div>';
  }

  function nwFilteredItems() {
    const items = (S.news && S.news.items) || [];
    const f = S.newsFilter, kw = String(S.newsKeyword || '').trim().toLowerCase();
    return items.filter(x => {
      if (f === 'linked' && !(x.matched || []).length) return false;
      if (f === 'bear' && x.tone !== 'bear') return false;
      if (f === 'bull' && x.tone !== 'bull') return false;
      if (f === 'high' && !(x.tone === 'bear' && x.severity === 'high')) return false;
      if (f === 'new' && !x.isNew) return false;
      if (kw) {
        const hay = [x.title, x.text, (x.matched || []).map(m => m.name).join(' ')].join(' ').toLowerCase();
        if (hay.indexOf(kw) < 0) return false;
      }
      return true;
    });
  }

  function nwItemHtml(x, compact) {
    const matched = (x.matched || []).length
      ? x.matched.map(m => '<span class="nw-code' + (m.confidence === '精确' ? ' exact' : '') + '" title="' + E(m.method) + '">' +
        E(m.name) + ' ' + E(m.code) + ' · ' + E(m.confidence) + '</span>').join('')
      : '<span class="small muted">未精确关联个股（市场 / 政策面）</span>';
    const hits = (x.hits || []).length ? x.hits.map(h => E(h.words.join('、'))).join(' / ') : '—';
    const links = (x.url ? '<a href="' + E(x.url) + '" target="_blank" rel="noopener noreferrer">原文 ↗</a>' : '') +
      (x.pdfUrl ? ' <a href="' + E(x.pdfUrl) + '" target="_blank" rel="noopener noreferrer">公告 PDF ↗</a>' : '');
    const impact = (x.isLeader && (x.impact || []).length)
      ? '<div class="nw-impact"><b>条件化提示</b>' + x.impact.slice(0, compact ? 1 : 2).map(p => '<div>· ' + E(p) + '</div>').join('') + '</div>'
      : '';
    return '<div class="nw-item' + (x.isNew ? ' nw-new' : '') + '">' +
      '<div class="nw-item-top"><span class="nw-time">' + E(nwTime(x.timeText)) + '</span>' +
      '<span class="nw-kind">' + E(x.kindLabel) + '</span>' +
      '<span class="nw-tone ' + nwToneCls(x) + '">' + E(nwToneLabel(x)) + '</span>' +
      '<span class="nw-scope">' + E(x.scope) + '</span>' +
      (x.isNew ? '<span class="nw-new-badge">NEW</span>' : '') + '</div>' +
      '<div class="nw-title">' + (x.url ? '<a href="' + E(x.url) + '" target="_blank" rel="noopener noreferrer">' + E(x.title) + '</a>' : E(x.title)) + '</div>' +
      '<div class="nw-meta">' + matched + '<span class="small muted">' + E(x.media || x.source) + ' · 命中词 ' + hits + '</span>' + links + '</div>' +
      (compact ? '' : '<div class="nw-basis small muted">' + E(x.basis) + '</div>') +
      impact + '</div>';
  }

  function nwListHtml() {
    const list = nwFilteredItems();
    const shown = S.newsShowAll ? list.slice(0, 80) : list.slice(0, 12);
    if (!list.length) return '<div class="nw-empty-line">当前筛选下没有消息。系统不会用推测数据填充；可调宽时间窗口或切换筛选。</div>';
    return shown.map(x => nwItemHtml(x, false)).join('') +
      (list.length > shown.length ? '<div class="small muted nw-more-note">仅显示最近 ' + shown.length + ' 条，共 ' + list.length + ' 条；点「显示全部」展开。</div>' : '');
  }

  function renderNewsPanel() {
    const box = $('nwBox'); if (!box) return;
    const j = S.news, m = j && j.meta, su = j && j.summary;
    const err = S.newsError;
    const status = err ? '暂不可用' : (S.newsPaused ? '已暂停' : (S.newsLoading ? '刷新中' : '监控中'));
    const statusCls = err ? 'off' : (S.newsPaused ? 'pause' : 'on');
    const intervalOpts = [15, 30, 60].map(n => '<option value="' + n + '"' + (S.newsInterval === n ? ' selected' : '') + '>' + n + ' 秒</option>').join('');
    const windowOpts = [[6, '近 6 小时'], [24, '近 24 小时'], [48, '近 48 小时'], [72, '近 3 天'], [168, '近 7 天']]
      .map(p => '<option value="' + p[0] + '"' + (S.newsWindow === p[0] ? ' selected' : '') + '>' + E(p[1]) + '</option>').join('');
    const filterOpts = [['all', '全部消息'], ['linked', '仅关联个股'], ['bear', '仅利空'], ['bull', '仅利多'], ['high', '仅高危风险'], ['new', '仅本轮新增']]
      .map(p => '<option value="' + p[0] + '"' + (S.newsFilter === p[0] ? ' selected' : '') + '>' + E(p[1]) + '</option>').join('');
    const srcDetail = m ? '（' + (m.sources || []).map(s => E(s.label) + (s.ok ? '✓' : '✗')).join(' ') + '）' : '';

    const head = '<div class="nw-head"><div class="nw-title-line"><h4>消息面 · 实时监控</h4>' +
      '<span class="nw-status ' + statusCls + '" id="nwStatus"><i></i>' + status + '</span>' +
      '<span class="small muted">公告 / 7×24 快讯 / 财经资讯 · 规则归类</span></div>' +
      '<div class="nw-ctl">' +
      '<label class="small muted">轮询 <select class="sel" id="nwInterval">' + intervalOpts + '</select></label>' +
      '<label class="small muted">窗口 <select class="sel" id="nwWindow">' + windowOpts + '</select></label>' +
      '<label class="small muted">筛选 <select class="sel" id="nwFilter">' + filterOpts + '</select></label>' +
      '<input class="nw-input" id="nwKeyword" placeholder="搜索标题 / 个股" value="' + E(S.newsKeyword) + '">' +
      '<button class="btn" id="nwPause">' + (S.newsPaused ? '继续监控' : '暂停') + '</button>' +
      '<button class="btn btn-primary" id="nwReload">立即刷新</button>' +
      '<button class="btn" id="nwMethod">' + (S.newsMethodOpen ? '收起' : '查看') + '监控口径</button>' +
      '</div></div>';

    const statusbar = '<div class="nw-statusbar">' +
      '<span class="small muted">上次刷新 <b>' + (S.newsAt ? E(new Date(S.newsAt).toTimeString().slice(0, 8)) : '—') + '</b></span>' +
      '<span class="small muted">下次 <b id="nwCountdown">' + (S.newsPaused ? '已暂停' : '—') + '</b></span>' +
      '<span class="small muted">数据源 <b>' + (m ? E(m.sourcesOnline) + '/' + E(m.sourcesTotal) : '—') + '</b> 在线' + srcDetail + '</span>' +
      (m ? '<span class="small muted">候选 ' + E(m.codesCount) + ' 只 · 公告 ' + E(m.annCount) + ' 条 / 快讯 ' + E(m.flashCount) + ' 条 · 服务端 ' + E(m.elapsedMs) + 'ms</span>' : '') +
      '<span class="small muted">口径：北京时间 · 公开接口轮询，非交易所官方推送</span></div>' +
      (err ? '<div class="nw-error"><b>消息源暂不可用：</b>' + E(err) + '（' + (isConnError({ message: err }) ? E(SERVICE_HINT) : '上游接口临时异常') + '）下次轮询会自动重试，已有消息保留展示。</div>' : '');

    const kpis = su ? [
      ['关联候选利多', su.byToneLeader.bull, 'nw-bull'], ['关联候选利空', su.byToneLeader.bear, 'nw-bear'],
      ['高危风险', su.highRisk, 'nw-warn'], ['关联候选', su.leaderCount, 'nw-purple'],
      ['本轮新增', m ? m.newCount : 0, 'nw-blue'], ['消息总数', su.total, '']
    ].map(p => '<div class="nw-kpi"><span>' + E(p[0]) + '</span><b class="' + p[2] + '">' + E(p[1]) + '</b></div>').join('') : '';

    const alerts = (j && j.alerts) || [];
    const alertHtml = '<div class="nw-alerts"><div class="nw-h5">个股预警 <span class="small muted">精确关联当前候选 · 高危优先 · 最多 6 条</span></div>' +
      (alerts.length ? alerts.slice(0, 6).map(x => nwItemHtml(x, true)).join('')
        : '<div class="nw-empty-line">' + (j ? '当前窗口内未监控到与候选精确关联的利空 / 利多消息；系统不会填充推测数据。' : '正在建立首轮消息基线…') + '</div>') + '</div>';

    const list = nwFilteredItems();
    const stream = j ? '<div class="nw-stream"><div class="nw-h5">实时消息流 <span class="small muted">共 ' + E(list.length) + ' 条 · 按时间倒序</span></div>' +
      '<div id="nwList">' + nwListHtml() + '</div>' +
      (list.length > 12 ? '<button class="btn" id="nwMore">' + (S.newsShowAll ? '收起' : '显示全部 ' + list.length + ' 条') + '</button>' : '') + '</div>' : '';

    const method = j && j.methodology ? '<div class="nw-method" id="nwMethodBox" style="display:' + (S.newsMethodOpen ? '' : 'none') + '">' +
      j.methodology.rules.map(r => '<div class="nw-rule"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') +
      '<div class="note-box">' + E(j.methodology.caveat) + '</div></div>' : '';

    const foot = '<div class="nw-foot small muted">' + (m ? E(m.note) : '首轮加载将建立消息基线，之后按轮询间隔标记新增。') +
      ' · 消息面不参与龙头评分，也不改写一致度 / 分歧度与明日剧本；不构成投资建议。</div>';

    box.innerHTML = head + statusbar + (kpis ? '<div class="nw-kpis">' + kpis + '</div>' : '') +
      (err ? '' : alertHtml + stream) + method + foot;

    const bind = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
    bind('nwInterval', 'onchange', e => { S.newsInterval = Number(e.target.value); scheduleNews(S.newsInterval); renderNewsPanel(); });
    bind('nwWindow', 'onchange', e => { S.newsWindow = Number(e.target.value); loadNews(true); });
    bind('nwFilter', 'onchange', e => { S.newsFilter = e.target.value; renderNewsPanel(); });
    bind('nwKeyword', 'oninput', e => {
      S.newsKeyword = e.target.value;
      const el = $('nwList'); if (el) el.innerHTML = nwListHtml();
    });
    bind('nwPause', 'onclick', () => {
      S.newsPaused = !S.newsPaused;
      if (S.newsPaused) { if (S.newsTimer) { clearTimeout(S.newsTimer); S.newsTimer = null; } S.newsNextAt = 0; }
      else { scheduleNews(S.newsInterval); loadNews(false); }
      renderNewsPanel();
    });
    bind('nwReload', 'onclick', () => loadNews(true));
    bind('nwMethod', 'onclick', () => {
      S.newsMethodOpen = !S.newsMethodOpen;
      const el = $('nwMethodBox'); if (el) el.style.display = S.newsMethodOpen ? '' : 'none';
      $('nwMethod').textContent = (S.newsMethodOpen ? '收起' : '查看') + '监控口径';
    });
    bind('nwMore', 'onclick', () => { S.newsShowAll = !S.newsShowAll; renderNewsPanel(); });
  }

  /** 龙头详情内的该股消息（精确 / 字面匹配都列，标注匹配方式） */
  function nwDetailCard(x) {
    const j = S.news;
    const head = '<div class="card pad nw-detail"><div class="dg-h5">消息面 · 该股关联（近 ' + E(j ? j.meta.windowHours : S.newsWindow) + ' 小时）</div>';
    if (!j) return head + '<div class="small muted">消息监控尚未加载或已暂停。</div></div>';
    const rows = (j.items || []).filter(it => (it.matched || []).some(m => m.code === x.code)).slice(0, 6);
    if (!rows.length) return head + '<div class="small muted">近 ' + E(j.meta.windowHours) +
      ' 小时未监控到与该股关联的公告 / 快讯；系统不会用推测数据填充，重大事项请点交易所公告原文核实。</div></div>';
    return head + rows.map(it => {
      const mm = (it.matched || []).find(m => m.code === x.code) || {};
      return '<div class="nw-detail-row"><span class="nw-tone ' + nwToneCls(it) + '">' + E(nwToneLabel(it)) + '</span>' +
        '<span class="nw-detail-time">' + E(nwTime(it.timeText)) + '</span>' +
        (it.isNew ? '<span class="nw-new-badge">NEW</span>' : '') +
        '<div class="nw-detail-title">' + (it.url ? '<a href="' + E(it.url) + '" target="_blank" rel="noopener noreferrer">' + E(it.title) + '</a>' : E(it.title)) + '</div>' +
        '<div class="small muted">' + E(it.kindLabel) + ' · ' + E(it.media || it.source) + ' · 关联方式 ' + E(mm.method || '—') + '</div>' +
        ((it.impact || []).length ? '<div class="nw-impact-mini">' + E(it.impact[0]) + '</div>' : '') + '</div>';
    }).join('') + '<div class="small muted">关键词规则归类，务必点开原文核实；消息面不参与本页评分。</div></div>';
  }

  /** 只更新状态徽标，避免每次轮询重绘整块面板打断关键字输入 */
  function updateNwStatus() {
    const el = $('nwStatus'); if (!el) return;
    const st = S.newsError ? '暂不可用' : (S.newsPaused ? '已暂停' : (S.newsLoading ? '刷新中' : '监控中'));
    const cls = S.newsError ? 'off' : (S.newsPaused ? 'pause' : 'on');
    el.className = 'nw-status ' + cls;
    el.innerHTML = '<i></i>' + st;
  }

  function scheduleNews(sec) {
    if (S.newsTimer) { clearTimeout(S.newsTimer); S.newsTimer = null; }
    if (S.newsPaused || S.tab !== 'dragon') { S.newsNextAt = 0; return; }
    const s = Math.max(5, Number(sec) || 30);
    S.newsNextAt = Date.now() + s * 1000;
    S.newsTimer = setTimeout(() => {
      S.newsTimer = null;
      if (!S.newsPaused && S.tab === 'dragon') loadNews(false);
    }, s * 1000);
  }

  function startNewsTicker() {
    if (S.newsTickTimer) clearInterval(S.newsTickTimer);
    S.newsTickTimer = setInterval(() => {
      const el = $('nwCountdown'); if (!el) return;
      if (S.newsPaused || !S.newsNextAt) { el.textContent = S.newsPaused ? '已暂停' : '—'; return; }
      el.textContent = Math.max(0, Math.ceil((S.newsNextAt - Date.now()) / 1000)) + ' 秒后';
    }, 1000);
  }

  function stopNewsMonitor() {
    if (S.newsTimer) { clearTimeout(S.newsTimer); S.newsTimer = null; }
    if (S.newsTickTimer) { clearInterval(S.newsTickTimer); S.newsTickTimer = null; }
    S.newsNextAt = 0;
  }

  function startNewsMonitor() {
    if (S.tab !== 'dragon') return;
    startNewsTicker();
    if (!S.news && !S.newsLoading) loadNews(false);
    else if (!S.newsPaused) scheduleNews(S.newsInterval);
  }

  async function loadNews(force) {
    if (S.newsLoading) return;
    S.newsLoading = true;
    updateNwStatus();
    const q = new URLSearchParams();
    q.set('window', String(S.newsWindow));
    q.set('scope', Number(S.dgOpts.showAll) === 1 ? 'pool' : 'leaders');
    q.set('limit', '60');
    const codes = ((S.dg && S.dg.list) || []).map(x => x.code).filter(Boolean).slice(0, 60);
    if (codes.length) q.set('codes', codes.join(','));
    if (S.newsSince) q.set('since', S.newsSince);
    if (force) q.set('force', '1');
    try {
      const r = await fetch('/api/news?' + q.toString(), { cache: 'no-store' });
      let j;
      try { j = await r.json(); }
      catch (_) { throw new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）'); }
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      S.news = j; S.newsAt = Date.now(); S.newsSince = j.meta.generatedAt; S.newsError = null;
      renderNewsPanel();
      if (S.dg) renderDragonDetail();
    } catch (e) {
      S.newsError = String(e && e.message || e);
      if ($('nwBox')) renderNewsPanel();
    } finally {
      S.newsLoading = false;
      updateNwStatus();
      if (S.tab === 'dragon' && !S.newsPaused) scheduleNews(S.newsInterval);
    }
  }

  /* ─────────────── 页脚 ─────────────── */
  function renderFooter(d) {
    const m = d.meta;
    $('sourceInfo').innerHTML =
      '本地服务：http://localhost:' + E(m.port || '8899') + '（端口被占用时自动顺延，以启动控制台输出为准）<br>' +
      '全市场广度：新浪财经行情中心（' + E(m.universeCount) + '/' + E(m.universeExpected) + ' 只，快照 ' + E(m.universeTick || '—') + '）<br>' +
      '实时快照 / 指数：腾讯证券行情（快照 ' + E(m.quoteCount) + ' 只，时点 ' + E(m.quoteTick || '—') + '）<br>' +
      '日K（多源自动降级）：' + E(m.klineSource || '全部不可用') + '，本轮成功 ' + E(m.klineCount) + ' 只；腾讯 web 域触发 WAF 时自动切 ifzq 域 / 新浪不复权日K<br>' +
      '涨停 / 炸板 / 强势 / 跌停池（含连板数、封单、行业）：东方财富涨停池，交易日 ' + E(m.poolDate || '—') + '<br>' +
      '行业 / 概念板块：新浪财经板块行情<br>' +
      '服务端生成时点：' + E(m.generatedAt) + '，耗时 ' + E(m.elapsedMs) + ' ms；北京时间口径 ' + E(m.now);
    $('healthList').innerHTML = (m.health || []).map(h =>
      '<div class="health-item"><span class="hdot' + (h.ok || (!h.lastTry && NEWS_KEYS.indexOf(h.key) >= 0) ? '' : (h.degraded ? ' warn' : ' bad')) + '"></span><b>' + E(h.label) + (h.sourceLabel ? ' · ' + E(h.sourceLabel) : '') + '</b>' +
      (h.standby || (!h.lastTry && NEWS_KEYS.indexOf(h.key) >= 0) ? '<span class="mini-tag">' + (h.standby ? '备用源' : '按需') + '</span>' : '') +
      (h.degraded ? '<span class="mini-tag" style="color:var(--warn)">已降级</span>' : '') +
      '<span class="muted">' + (h.ok ? '在线 · ' + E(h.rows) + ' 条 · ' + E(h.latency) + 'ms'
        : (h.degraded ? '降级 · ' + E(h.error || '备用源接管')
          : (h.standby ? '未启用（主源可用时不调用）'
            : (!h.lastTry && NEWS_KEYS.indexOf(h.key) >= 0 ? '待加载（「明日龙头」启用后调用）' : '异常 · ' + E(h.error || '未知'))))) + '</span></div>'
    ).join('') +
      ((m.health || []).some(h => h.key === 'qqKline' && (h.degraded || !h.ok)) && (m.health || []).some(h => h.standby && h.ok)
        ? '<div class="note-box" style="margin-top:8px"><b>日K口径提示：</b>腾讯前复权日K被 WAF 限流，系统已自动切换「新浪财经日K（不复权）」并进入 2 分钟冷却，冷却结束后自动探活恢复前复权口径。使用备用源期间，历史价位划线、支撑位与回撤测算可能与前复权口径不一致，相关模块已如实标注；请以交易所行情为准。</div>' : '');
  }

  /* ─────────────── 龙场悟道 · 多方法回测选优 ─────────────── */
  async function loadEnlightenment(force) {
    if (S.enLoading) return;
    S.enLoading = true;
    if (!S.en) $('pane-enlighten').innerHTML = '<div class="card empty">正在回放近 ' + S.enOpts.days +
      ' 个交易日涨停池、逐只核对次日真实日K，比较六种可量化短线方法…</div>';
    const q = new URLSearchParams({ days: S.enOpts.days });
    if (force) q.set('force', '1');
    try {
      const r = await fetch('/api/enlightenment?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      S.en = j; S.enError = null;
      renderEnlightenment();
      $('badgeEn').textContent = j.best ? String(j.best.name).slice(0, 6) : '已回测';
    } catch (e) {
      S.enError = e.message;
      $('pane-enlighten').innerHTML = '<div class="card empty"><b>回测未完成：' + E(e.message) +
        '</b><br><span class="small muted">系统不会用推测数据填充，可点下方按钮重试。</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="enRetry">重新回测</button></div>';
      $('enRetry').onclick = () => loadEnlightenment(true);
    } finally { S.enLoading = false; }
  }

  /* ═══════════ 集合竞价 · 多因子首板封板概率（选股视图） ═══════════ */
  function auctionProbCls(p) {
    return p === null || p === undefined ? '' : p >= 75 ? 'ap-high' : p >= 50 ? 'ap-mid' : 'ap-low';
  }
  function auctionTierCls(t) {
    return t === 'focus' ? 'red' : t === 'watch' ? 'warn' : '';
  }
  function auctionMethodCard() {
    const meth = (S.auction && S.auction.method) || {};
    const rules = meth.rules || [];
    const body = rules.map(r => '<div class="kv"><span class="k">' + E(r.name) + '</span><span class="v">' + E(r.text) + '</span></div>').join('');
    const open = S.auctionMethodOpen;
    return '<div class="card pad dg-card" style="margin-top:12px">' +
      '<div class="dg-card-head"><h4>回测口径与方法</h4>' +
      '<button class="btn btn-ghost btn-sm" id="apMethodToggle">' + (open ? '收起' : '查看') + '全部口径</button></div>' +
      '<div id="apMethodBody" style="display:' + (open ? '' : 'none') + '">' + body +
      '<div class="note-box" style="margin-top:10px">' + E(meth.caveat || '') + '</div></div></div>';
  }

  function renderAuction() {
    const j = S.auction;
    if (!j) return;
    if (!j.available) {
      $('pane-auction').innerHTML = '<div class="card empty"><b>无法回测：' + E(j.reason || j.emptyReason || '样本不足') + '</b><br>' +
        '<span class="small muted">系统不会用推测数据填充；可稍后重试。</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="apRetry">重新回测</button></div>';
      const rb = $('apRetry'); if (rb) rb.onclick = () => loadAuction(true);
      return;
    }
    const m = j.meta || {}, list = j.list || [], factors = j.factors || [], val = j.validation || {};
    const rolling = val.rolling || {}, sm = j.samples || {};
    const focus = list.filter(x => x.tier === 'focus'), watch = list.filter(x => x.tier === 'watch');
    const daysOpts = [5, 8, 10, 12, 15].map(d => '<option value="' + d + '"' + (Number(S.auctionOpts.days) === d ? ' selected' : '') + '>' + d + ' 日</option>').join('');
    const head = '<div class="sec-head"><h3>集合竞价 · 多因子首板概率选股</h3>' +
      src('东方财富涨停/炸板池 + 腾讯前复权日K') +
      '<span class="spacer"></span><label class="small muted">回测窗口 </label>' +
      '<select id="apDays" class="sel-sm">' + daysOpts + '</select>' +
      '<button class="btn btn-ghost btn-sm" id="apRefresh">重新回测</button></div>';

    // 核心横幅：讲清"怎么用"——分层逻辑 + 事实复盘定位
    const banner = '<div class="conclusion card" style="border-left-color:var(--up);margin-bottom:12px">' +
      '<div class="lead"><b>怎么用：</b>系统用近 ' + (sm.train || 0) + ' 个首板样本训练一个多因子评分卡，对最近交易日（' + E(fmtDate(j.holdoutDate)) +
      '）冲击首板的 ' + list.length + ' 只票按封板概率排序，分「重点关注 / 次选观察 / 回避」三档。' +
      '高分＝历史上具备「位置低、竞价温和、量能健康、不过热」的特征组合；点击任意票看K线。' +
      '<span class="up">这是历史回测的概率复盘，不是明日预测，也不是买入信号。</span></div></div>';

    // KPI：模型表现为主
    const kpi = '<div class="dg-kpi-grid">' +
      '<div class="dg-kpi"><span>滚动验证 AUC</span><b class="' + (rolling.avgAuc >= 0.55 ? 'up' : '') + '">' + E(rolling.avgAuc === null ? '—' : rolling.avgAuc) + '</b><em>' + E((rolling.days || []).length) + ' 日样本外均值 · 0.5=随机</em></div>' +
      '<div class="dg-kpi"><span>高分 vs 低分封板率</span><b>' + E(rolling.topAvg === null ? '—' : rolling.topAvg + '%') +
        ' <span class="small muted">vs</span> ' + E(rolling.botAvg === null ? '—' : rolling.botAvg + '%') + '</b><em>前30% vs 后30% 平均分档</em></div>' +
      '<div class="dg-kpi"><span>重点关注</span><b class="up">' + E(focus.length) + ' <span class="small muted">只</span></b><em>共 ' + E(list.length) + ' 只候选</em></div>' +
      '<div class="dg-kpi"><span>训练 / 验证样本</span><b>' + E(sm.train || 0) + ' / ' + E(sm.holdout || 0) + '</b><em>基准封板率 ' + E(j.baseRate === null ? '—' : j.baseRate + '%') + ' · 跳过 ' + E(sm.skipped || 0) + '</em></div>' +
      '</div>';

    // 因子分解 chip：每只票 4 个因子的落档 + WoE 方向
    const factorChip = (label, d) => {
      if (!d) return '';
      const positive = Number(d.woe) > 0;
      const cls = positive ? 'ap-high' : Number(d.woe) < 0 ? 'ap-low' : 'ap-mid';
      return '<span class="af-chip ' + cls + '" title="该档历史封板率 ' + (d.rate === null ? '—' : d.rate + '%') + ' · WoE ' + d.woe + '">' +
        E(label) + ' ' + E(d.label) + '<i>' + (positive ? '+' : '') + E(d.woe) + '</i></span>';
    };
    const probBar = p => {
      const w = p === null || p === undefined ? 0 : Math.max(2, Math.min(100, p));
      return '<div style="display:flex;align-items:center;gap:6px"><b class="' + auctionProbCls(p) + '">' + E(p === null ? '—' : p + '%') + '</b>' +
        '<div class="dg-bar" style="flex:1;min-width:40px"><i class="' + (p >= 75 ? 'red' : p >= 50 ? 'warn' : 'blue') + '" style="width:' + w.toFixed(0) + '%"></i></div></div>';
    };

    // 选股列表
    const tierOrder = { focus: 0, watch: 1, avoid: 2 };
    const sortedList = list.slice().sort((a, b) => (tierOrder[a.tier] - tierOrder[b.tier]) || (b.probability - a.probability));
    const listRows = sortedList.map(x => {
      const hitIco = x.hit === null || x.hit === undefined ? '<span class="muted">—</span>' : x.hit ? '<span class="up">✓</span>' : '<span class="down">✗</span>';
      const resultTag = x.sealed === 1 ? tag('封住', 'red') : tag('炸板', 'green');
      const chips = factorChip('竞价', x.detail && x.detail.gap) + factorChip('位置', x.detail && x.detail.loc) +
        factorChip('量能', x.detail && x.detail.vr) + factorChip('热度', x.detail && x.detail.hot);
      return '<tr class="ap-row ap-' + x.tier + '"><td style="text-align:center"><span class="ap-rank ' + auctionTierCls(x.tier) + '">' + E(x.rank) + '</span></td>' +
        '<td class="left">' + sn(x.code, x.name) + '<div class="small muted">' + E(x.code) + ' · ' + E(x.industry || '') + '</div></td>' +
        '<td>' + tag(x.tierLabel, auctionTierCls(x.tier)) + '</td>' +
        '<td style="min-width:92px">' + probBar(x.probability) + '</td>' +
        '<td class="left"><div class="ap-chips">' + chips + '</div></td>' +
        '<td>' + PC(x.gap, 2) + '</td>' +
        '<td>' + resultTag + '</td>' +
        '<td style="text-align:center">' + hitIco + '</td></tr>';
    }).join('');
    const listCard = '<div class="sec"><div class="sec-head"><h3>选股清单 · ' + E(fmtDate(j.holdoutDate)) + ' 冲击首板的股票</h3>' +
      '<span class="small muted">按综合封板概率分层排序 · 点击名称看K线</span></div>' +
      '<div class="card pad"><div class="ap-tier-legend"><span class="ap-rank red">重点</span> 前30% 优先研究　' +
      '<span class="ap-rank warn">次选</span> 中间40% 观察　<span class="ap-rank">回避</span> 后30% 概率低</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>排名</th><th class="left">个股</th><th>分层</th><th>综合概率</th><th class="left">因子分解(竞价/位置/量能/热度)</th><th>竞价高开</th><th>实际</th><th>命中</th></tr></thead>' +
      '<tbody>' + listRows + '</tbody></table></div>' +
      (list.length ? '' : '<div class="empty">该交易日无首板样本</div>') +
      '<div class="note-box">「因子分解」显示每只票在各因子上落入的档位与其历史贡献（WoE，<span class="up">正</span>=加分/<span class="down">负</span>=减分）。' +
      '综合概率由 4 因子加权合成；实际结果用于验证排序是否有效。<b>竞价高开≠可买，一字/近涨停开盘常买不进。</b></div></div></div>';

    // 因子有效性表
    const factorRows = factors.map(f => {
      const icCls = f.ic === null ? '' : f.ic > 0 ? 'ap-high' : f.ic < 0 ? 'ap-low' : '';
      const binCells = (f.bins || []).map(b => '<div class="af-bin"><span>' + E(b.label) + '</span><b>' + E(b.rate === null ? '—' : b.rate + '%') + '</b></div>').join('');
      return '<tr><td class="left"><b>' + E(f.label) + '</b><div class="small muted">' + E(f.desc) + '</div></td>' +
        '<td><b class="' + icCls + '">' + E(f.ic === null ? '—' : f.ic) + '</b></td>' +
        '<td>' + E(f.spread === null ? '—' : f.spread + 'pp') + '</td>' +
        '<td><div class="af-bins">' + binCells + '</div></td></tr>';
    }).join('');
    const factorCard = '<div class="card pad" style="margin-top:12px"><h4>为什么用这 4 个因子（训练样本实测）</h4>' +
      '<div class="note-box" style="margin-bottom:8px">IC＝因子值与是否封板的相关（负=因子越大越易炸板）；档位封板率从左到右按因子值由低到高排列。' +
      '「位置/涨幅」区分力最强，说明<b>涨太高、离均线远的票更容易炸板</b>；单一竞价高开区分力有限，所以才用多因子合成。</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">因子</th><th>IC</th><th>首尾档差</th><th class="left">各档实际封板率（低→高）</th></tr></thead>' +
      '<tbody>' + factorRows + '</tbody></table></div></div>';

    // 滚动验证表
    const rollRows = (rolling.days || []).map(d => {
      const aucCls = d.auc === null ? '' : d.auc >= 0.55 ? 'up' : d.auc < 0.5 ? 'down' : '';
      return '<tr><td>' + E(fmtDate(d.date)) + '</td><td>' + E(d.n) + '</td>' +
        '<td><b class="' + aucCls + '">' + E(d.auc === null ? '—' : d.auc) + '</b></td>' +
        '<td>' + E(d.topRate === null ? '—' : d.topRate + '%') + '</td>' +
        '<td>' + E(d.botRate === null ? '—' : d.botRate + '%') + '</td>' +
        '<td>' + E(d.actualRate === null ? '—' : d.actualRate + '%') + '</td></tr>';
    }).join('');
    const rollCard = '<div class="card pad" style="margin-top:12px"><h4>多日滚动验证（每个交易日用它之前的数据训练，在当日预测）</h4>' +
      '<div class="kv"><span class="k">结论</span><span class="v">' + E(rolling.note || '—') + '</span></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>交易日</th><th>候选数</th><th>AUC</th><th>高分前30%封板</th><th>低分后30%封板</th><th>当日实际封板率</th></tr></thead>' +
      '<tbody>' + rollRows + '</tbody></table></div>' +
      '<div class="note-box">AUC≥0.55 视为有区分力；可见模型<b>多数日期有效、个别市场情绪异常日失效</b>。' +
      '样本外单日（' + E(fmtDate(val.date)) + '）AUC ' + E(val.auc === null ? '—' : val.auc) + '、命中率 ' + E(val.hitRate === null ? '—' : val.hitRate + '%') +
      ' —— ' + E(val.note || '') + '</div></div>';

    const metaNote = '<div class="small muted" style="margin-top:8px">数据口径：' + E(m.dataSourceNote || '') + '</div>';
    $('pane-auction').innerHTML = head + banner + kpi + listCard + factorCard + rollCard + auctionMethodCard() +
      '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：' + E(m.disclaimer || '') + '</div>' + metaNote;

    $('apDays').onchange = e => { S.auctionOpts.days = Number(e.target.value) || 10; loadAuction(true); };
    $('apRefresh').onclick = () => loadAuction(true);
    const mt = $('apMethodToggle');
    if (mt) mt.onclick = () => { S.auctionMethodOpen = !S.auctionMethodOpen; renderAuction(); };
  }

  async function loadAuction(force) {
    if (S.auctionLoading) return;
    S.auctionLoading = true;
    if (!S.auction) $('pane-auction').innerHTML = '<div class="card empty">正在回溯近 ' + S.auctionOpts.days + ' 个交易日涨停/炸板池与真实日K，训练多因子评分卡并做样本外验证…</div>';
    const q = new URLSearchParams({ days: String(S.auctionOpts.days) });
    if (force) q.set('force', '1');
    try {
      const r = await fetch('/api/auction?' + q.toString(), { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
      S.auction = j; S.auctionAt = Date.now(); S.auctionError = null;
      renderAuction();
      const focusN = (j.list || []).filter(x => x.tier === 'focus').length;
      $('badgeAuction').textContent = focusN || '—';
    } catch (e) {
      S.auctionError = e.message;
      $('badgeAuction').textContent = '—';
      $('pane-auction').innerHTML = '<div class="card empty"><b>回测失败：' + E(e.message) + '</b><br>' +
        '<span class="small muted">' + (isConnError(e) ? E(SERVICE_HINT) : '服务端或上游数据源返回异常；系统不会用推测数据填充。') + '</span></div>' +
        '<div class="card pad" style="margin-top:12px"><button class="btn btn-primary" id="apRetry">重新回测</button></div>';
      const rb = $('apRetry'); if (rb) rb.onclick = () => loadAuction(true);
    } finally { S.auctionLoading = false; }
  }

  function renderEnlightenment() {
    const j = S.en; if (!j) return;
    const m = j.meta || {}, methods = j.methods || [], best = j.best, mk = j.market || {}, cands = j.candidates || [];
    const ksrc = (m.klineSources || []).join(' / ') || '—';
    const range = (m.historyRange || []).filter(Boolean).join(' — ') || '—';
    const totalN = methods.reduce((s, x) => s + (Number(x.n) || 0), 0);
    const verdictTag = j.verdict === 'edge' ? tag('区间内有超额', 'red')
      : j.verdict === 'no-edge' ? tag('无显著超额', 'warn')
        : j.verdict === 'illiquid' ? tag('流动性偏差', 'warn') : tag('样本不足', 'blue');

    const head = '<div class="conclusion card" style="margin-bottom:14px;border-left-color:var(--purple)"><div class="lead">' +
      '<b>龙场悟道 · 次日买入机会计划</b>：用 ' + E(m.days || 0) + ' 个交易日（' + E(range) + '）的真实涨停池，为 ' +
      methods.length + ' 种选股方法套用同一套计划 —— <b>T 日只选股、T+1 回踩触发才买、T+2 收盘卖出（A 股 T+1）</b>。' +
      '买入价不是 T 日涨停价，因此不含「次日溢价」偏差；按「每候选期望值＝成交后平均收益 × 触发率」选优，并对当前池输出明日的计划价位。' +
      '<div style="margin-top:7px;font-weight:600">' + E(j.bestReason || '') + '</div></div>' +
      '<div class="tags">' + verdictTag + tag('候选 ' + totalN + ' 次', 'blue') +
      tag(j.planRules ? j.planRules.label : '次日计划', 'purple') +
      tag('日K源 ' + ksrc, m.fallback ? 'warn' : 'green') +
      tag('交易日 ' + (m.poolDate || '—'), '') + tag('时点 ' + (m.quoteTick || '—'), 'blue') + '</div></div>';

    const controls = '<div class="card pad" style="margin-bottom:12px"><div class="small muted">' +
      '回测窗口 <b>' + E((m.baseDates || []).length) + '</b> 个基准日 · 每日候选上限 ' + E(m.perDay) +
      ' 只 · 日K去重请求 ' + E(m.codesRequested) + ' 只（成功 ' + E(m.klineOk) + '）· 成交样本门槛 ≥' + E(j.minSamples) +
      ' 笔 · 服务端耗时 ' + E(m.elapsedMs) + ' ms · 生成 ' + E(m.generatedAt) +
      '<br><b>统一计划模板</b>：' + E(j.planRules ? j.planRules.label : '—') + ' — ' + E(j.planRules ? j.planRules.desc : '—') +
      '（需要 T+1 与 T+2 两根日K，因此最新 2 个交易日只作「观察中」，不计入分母）' +
      (m.fallback ? '<br><b style="color:var(--warn)">当前使用新浪不复权日K</b>：腾讯前复权被限流降级，除权日价格跳变可能污染买入价与收益，数值可靠性低于前复权口径。' : '') +
      '</div><div class="dg-actions" style="margin-top:9px"><label class="small muted">回溯 <select class="sel" id="enDays">' +
      [5, 6, 8, 10, 12].map(n => '<option value="' + n + '"' + (Number(S.enOpts.days) === n ? ' selected' : '') + '>近 ' + n + ' 日</option>').join('') +
      '</select></label> <button class="btn btn-primary" id="enReload">重新回测</button>' +
      '<span class="small muted">回测按 10 分钟缓存；切换天数或点击按钮会强制重算</span></div></div>';

    const kpis = [
      ['涨停 / 跌停', E(mk.limitUp) + ' / ' + E(mk.limitDown), '炸板 ' + E(mk.broken) + ' 家 · 率 ' + N(mk.breakRate, 1) + '%'],
      ['涨跌家数', E(mk.up) + ' / ' + E(mk.down), '广度 ' + N(mk.breadth, 1) + '%'],
      ['最高连板', E(mk.maxBoard) + ' 板', '市场档位 ' + E(mk.tier) + ' / 情绪 ' + E(mk.emotion)],
      ['指数均值', (Number(mk.idxAvg) > 0 ? '+' : '') + N(mk.idxAvg) + '%', '6 大指数当日均值']
    ];
    const marketCard = '<div class="sec"><div class="sec-head"><h3>最近市场情况</h3>' +
      src('新浪财经全市场快照 / 腾讯证券指数 / 东方财富涨停池，交易日 ' + (mk.poolDate || m.poolDate || '—')) + '</div>' +
      '<div class="grid4">' + kpis.map(k => '<div class="info-card"><h4>' + k[0] + '</h4><p>' +
        '<span style="font-size:18px;font-weight:700">' + k[1] + '</span><br><span class="small muted">' + k[2] + '</span></p></div>').join('') +
      '</div></div>';

    const mRows = methods.map(x => {
      const skips = Object.entries(x.skipReasons || {}).sort((a, b) => b[1] - a[1]);
      return '<tr' + (best && x.id === best.id ? ' style="background:#fff8f8"' : '') + '>' +
        '<td class="left"><b>' + E(x.name) + '</b>' + (x.caveat ? '<div class="small" style="color:var(--warn)">' + E(x.caveat) + '</div>' : '') +
        '<div class="small muted" style="max-width:280px;white-space:normal">' + E(x.desc) + '</div></td>' +
        '<td>' + tag(x.kind, x.kind === '基准' ? '' : x.kind === '对照' ? 'warn' : 'blue') + '</td>' +
        '<td>' + E(x.n) + '</td>' +
        '<td>' + N(x.triggerRate, 1) + '%</td>' +
        '<td>' + E(x.triggered) + (x.sampleOK ? '' : ' <span class="mini-tag">样本不足</span>') + '</td>' +
        '<td class="' + (x.avgRet > 0 ? 'up' : x.avgRet < 0 ? 'down' : '') + '"><b>' + (x.avgRet > 0 ? '+' : '') + N(x.avgRet) + '%</b></td>' +
        '<td>' + N(x.winRate, 1) + '%</td>' +
        '<td class="down">' + N(x.avgMae, 1) + '%</td>' +
        '<td><b class="' + (x.expectancy > 0 ? 'up' : 'down') + '">' + (x.expectancy > 0 ? '+' : '') + N(x.expectancy) + '%</b></td>' +
        '<td class="' + (x.edge > 0 ? 'up' : x.edge < 0 ? 'down' : '') + '">' + (x.edge === null ? '—' : (x.edge > 0 ? '+' : '') + N(x.edge) + 'pp') + '</td>' +
        '<td class="left small">' + (skips.length ? E(skips[0][0]) + ' ×' + skips[0][1] : '—') + '</td></tr>';
    }).join('');
    const methodCard = '<div class="sec"><div class="sec-head"><h3>六种方法 · 次日买入计划回测榜</h3>' +
      src('东方财富历史涨停池 + 腾讯/新浪日K；T 日选股、T+1 触发买入、T+2 收盘卖出，无未来函数') + '</div>' +
      '<div class="card pad" style="margin-bottom:12px"><div id="enMethodChart" class="chart"></div></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th class="left">方法 / 选股条件</th><th>类型</th><th>候选 n</th><th>触发率</th><th>成交笔数</th><th>成交后平均收益</th><th>胜率</th><th>平均 MAE</th><th>每候选期望</th><th>超额 vs 基准</th><th class="left">主要放弃原因</th></tr></thead><tbody>' +
      (mRows || '<tr><td colspan="11" class="empty">回测区间内无可用样本</td></tr>') + '</tbody></table></div>' +
      '<div class="note-box" style="margin-top:10px"><b>怎么读：</b>所有方法共用同一套「次日回踩低吸」计划，差异只在 T 日选出哪些股。' +
      '<b>触发率</b>＝T+1 真正给出回踩买点的比例；未触发（高开过度 / 破位 / 没回踩）是「没机会就不做」，不计入收益但计入分母。' +
      '<b>成交后平均收益</b>＝以 C×0.98 买入、T+2 收盘卖出的平均收益；<b>每候选期望</b>＝成交后平均收益 × 触发率，是本次选优的唯一排序依据。' +
      'MAE 为成交后 T+1/T+2 最大浮亏。不计手续费、滑点、隔夜跳空与仓位。</div></div>';

    const insuff = j.insufficientStrong || [];
    const bestCard = '<div class="sec"><div class="sec-head"><h3>选优结论与待验证观察项</h3></div>' +
      '<div class="grid2"><div class="info-card"><h4>' + (best ? E(best.name) + ' ' + verdictTag : '未产出最佳方法') + '</h4>' +
      (best ? '<p>' + E(best.desc) + '</p><div class="kv"><span class="k">候选 / 实际成交</span><span class="v">' + E(best.n) + ' / ' + E(best.triggered) + ' 笔（触发率 ' + N(best.triggerRate, 1) + '%）</span></div>' +
        '<div class="kv"><span class="k">成交后平均收益 / 胜率</span><span class="v">' + N(best.avgRet) + '% / ' + N(best.winRate, 1) + '%</span></div>' +
        '<div class="kv"><span class="k">每候选期望值</span><span class="v"><b>' + N(best.expectancy) + '%</b></span></div>' +
        '<div class="kv"><span class="k">相对基准超额</span><span class="v">' + (best.edge === null ? '—' : (best.edge > 0 ? '+' : '') + N(best.edge) + ' pp') + '</span></div>' +
        '<div class="kv"><span class="k">平均最大浮亏 MAE</span><span class="v">' + N(best.avgMae, 1) + '%</span></div>'
        : '<p>' + E(j.bestReason || '') + '</p>') +
      '<div class="note-box">' + E(j.bestReason || '') + '</div></div>' +
      '<div class="info-card"><h4>期望更高但成交样本不足（待验证）</h4>' +
      (insuff.length ? insuff.map(x => '<div class="kv"><span class="k">' + E(x.name) + '</span><span class="v">期望 ' + N(x.expectancy) + '% · 成交 ' + E(x.triggered) + ' 笔 · 触发率 ' + N(x.triggerRate, 1) + '%</span></div>').join('') +
        '<div class="note-box">这些方法的每候选期望更高，但成交样本 &lt;' + E(j.minSamples) + ' 笔，按纪律不参与选优；需要更长回溯窗口才能判断，不能据此认定「更好」。</div>'
        : '<p class="small muted">本区间没有「样本不足但期望显著高于基准」的方法。</p>') +
      '</div></div></div>';

    const cRows = cands.map((x, i) => {
      const p = x.plan || {};
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td class="left"><span class="code">' + E(x.code) + '</span> ' + sn(x.code, x.name, 'nm') +
        '<div class="small muted">' + E(x.boardLabel || (x.boards + ' 板')) + ' · ' + E(x.industry || '—') +
        (x.theme ? ' · ' + E(x.theme.stage) : '') + '</div></td>' +
        '<td>' + N(p.base) + '</td>' +
        '<td><b class="up">' + N(p.entry) + '</b><div class="small muted">回踩 −2%</div></td>' +
        '<td class="down">' + N(p.stop) + '<div class="small muted">破位放弃</div></td>' +
        '<td>' + N(p.maxOpen) + '<div class="small muted">高开放弃</div></td>' +
        '<td><b class="' + (x.score >= 60 ? 'up' : '') + '">' + E(x.score) + '</b></td>' +
        '<td class="left small">' + (x.risks.length ? x.risks.map(r => tag(r, 'warn')).join(' ') : tag('无触发式风险', 'green')) + '</td></tr>';
    }).join('');
    const steps = (cands[0] && cands[0].planSteps) || [], invalids = (cands[0] && cands[0].invalidations) || [];
    const candCard = '<div class="sec"><div class="sec-head"><h3>明日买入机会计划 · ' +
      (j.planFallback ? '全池基准（无方法达标，不做优选）' : E(j.candidateMethod ? j.candidateMethod.name : '未选定方法')) +
      '（' + cands.length + ' 只）</h3>' +
      src('东方财富最新涨停池 ' + (m.poolDate || '—') + '；基准价 腾讯证券 ' + (m.quoteTick || '—')) + '</div>' +
      (cands.length ? '<div class="tbl-wrap"><table><thead><tr><th>#</th><th class="left">代码 / 名称</th><th>今日基准价 C</th><th>回踩买入价</th><th>破位放弃价</th><th>高开放弃价</th><th>排序分</th><th class="left">风险标签</th></tr></thead><tbody>' + cRows + '</tbody></table></div>'
        : '<div class="card empty">最新交易日涨停池中没有符合胜出方法选股条件的标的；系统不降低门槛凑数。</div>') +
      (cands.length ? '<div class="grid2" style="margin-top:12px">' +
        '<div class="info-card"><h4>计划执行步骤（T 日收盘后制定，T+1 才决定是否买）</h4><ul class="tight">' +
        steps.map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div>' +
        '<div class="info-card"><h4>未触发 / 失效条件（任一出现即放弃）</h4><ul class="tight">' +
        invalids.map(s => '<li>' + E(s) + '</li>').join('') + '</ul></div></div>' : '') +
      '<div class="note-box" style="margin-top:10px"><b>计划口径：</b>上表所有价位仅由「今日收盘价 C」机械推算（C×0.98 / C×0.95 / C×1.05），不含任何明日信息；' +
      '所有候选共用同一计划模板，差异只在是否符合「' + E(j.candidateMethod ? j.candidateMethod.name : '—') + '」的选股条件。' +
      '排序分只用于排序，不是收益预测。<b>这是条件化观察清单，不是买入指令</b>；未触发就是「没机会不做」，不追价。' +
      (j.verdict === 'no-edge' ? '<br><b>重要：</b>胜出方法在本区间并未跑赢「不筛选」的全池基准，下方计划<b>不具备方法优势</b>，应视作普通涨停股的条件观察，而非优选推荐。'
        : (j.verdict === 'insufficient' ? '<br><b>重要：</b>本区间成交样本不足，未选定最佳方法；下方计划按「全池基准」生成，<b>不做任何优选</b>，只是把同一套次日触发规则套到当日涨停股上，供条件观察。' : '')) + '</div></div>';

    const methodDoc = '<div class="sec"><div class="card pad"><div class="sec-head"><h3>回测口径与能力边界</h3></div>' +
      (m.methodology && m.methodology.rules ? m.methodology.rules.map(r => '<div class="pb-step"><b>' + E(r.name) + '</b><span>' + E(r.text) + '</span></div>').join('') : '') +
      '<div class="note-box">' + E((m.methodology && m.methodology.caveat) || '') + '</div>' +
      '<div class="small muted" style="margin-top:8px">数据溯源：' + E(m.dataSourceNote || j.metaNote || '—') +
      ' · 跳过样本：无日K ' + E((j.skipped || {}).noKline || 0) + ' / 缺 T+1 或 T+2 日K（观察中）' + E((j.skipped || {}).noT2Bar || 0) +
      ' / 计划参数异常 ' + E((j.skipped || {}).noPlan || 0) + ' / 无涨停池 ' + E((j.skipped || {}).noPool || 0) + '</div></div></div>';
    const disc = '<div class="disclaimer" style="margin-top:14px"><strong>免责声明</strong>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。</div>';

    $('pane-enlighten').innerHTML = head + controls + marketCard + methodCard + bestCard + candCard + methodDoc + disc;
    $('enDays').onchange = e => { S.enOpts.days = Number(e.target.value); loadEnlightenment(true); };
    $('enReload').onclick = () => loadEnlightenment(true);

    const items = methods.slice().sort((a, b) => (Number(a.expectancy) || 0) - (Number(b.expectancy) || 0))
      .map(x => ({ name: x.name, value: Number(x.expectancy) || 0, label: N(x.expectancy) + '%', kind: x.kind }));
    const opt = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 150, right: 48, top: 10, bottom: 24 },
      xAxis: { type: 'value', ...AXIS, axisLabel: { color: '#6b7a8c', fontSize: 10, formatter: '{value}%' } },
      yAxis: { type: 'category', data: items.map(x => x.name), ...AXIS },
      series: [{
        type: 'bar', barMaxWidth: 17,
        data: items.map(x => ({ value: x.value, itemStyle: { color: x.kind === '基准' ? '#94a3b8' : (x.kind === '对照' ? '#d97706' : '#2f6fd0') } })),
        label: { show: true, position: 'right', formatter: '{c}%', fontSize: 10, color: '#4b5b6b' }
      }]
    };
    safeChart('enMethodChart', opt, items);
  }

  /* ═══════════════ 个股搜索（代码 / 名称 → 打开K线弹窗） ═══════════════ */
  function initStockSearch() {
    const input = $('stockSearchInput'), panel = $('stockSearchPanel');
    if (!input || !panel) return;
    let timer = null, hits = [];
    const close = () => { panel.style.display = 'none'; panel.innerHTML = ''; };
    const pick = x => {
      close(); input.value = '';
      openStockChart(x.code);
      if (S.chart && x.name) { S.chart.name = x.name; $('smName').textContent = x.name; }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const kw = input.value.trim();
      if (!kw) { close(); return; }
      timer = setTimeout(async () => {
        try {
          const r = await fetch('/api/search?q=' + encodeURIComponent(kw), { cache: 'no-store' });
          const j = await r.json();
          hits = j.list || [];
          if (!hits.length) {
            panel.innerHTML = '<div class="ss-empty">未找到匹配股票（全市场约 5,500 只，按代码 / 名称匹配）</div>';
          } else {
            panel.innerHTML = hits.map((x, i) =>
              '<div class="ss-item" data-i="' + i + '"><b>' + E(x.name) + '</b><span class="ss-code">' + E(x.code) + '</span>' +
              '<span class="ss-px ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + N(x.price) + '</span>' +
              '<span class="ss-pct ' + (x.pct > 0 ? 'up' : x.pct < 0 ? 'down' : '') + '">' + (x.pct > 0 ? '+' : '') + N(x.pct) + '%</span>' +
              '<span class="ss-board">' + E(x.board || '') + '</span></div>').join('') +
              '<div class="ss-foot">新浪财经全市场行情 · 截至 ' + E(String(j.asOf || '').slice(0, 16).replace('T', ' ')) + ' · ↑↓ 选择 / Enter 打开</div>';
            [...panel.querySelectorAll('.ss-item')].forEach(el => { el.onclick = () => pick(hits[Number(el.dataset.i)]); });
          }
          panel.style.display = 'block';
        } catch (e) { panel.innerHTML = '<div class="ss-empty">搜索失败：' + E(e.message) + '</div>'; panel.style.display = 'block'; }
      }, 220);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); input.blur(); return; }
      if (!hits.length) return;
      let idx = [...panel.querySelectorAll('.ss-item')].findIndex(el => el.classList.contains('active'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        idx = e.key === 'ArrowDown' ? Math.min(hits.length - 1, idx + 1) : Math.max(0, idx - 1);
        [...panel.querySelectorAll('.ss-item')].forEach((el, i) => el.classList.toggle('active', i === idx));
      } else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); pick(hits[idx]); }
    });
    document.addEventListener('click', e => {
      if (!$('stockSearch').contains(e.target)) close();
    });
  }

  /* ═══════════════ 个股K线弹窗：分时 / 日K / 周K / 成交量 / 筹码峰 ═══════════════ */
  function openStockChart(code) {
    const c = String(code || '').replace(/\D/g, '').slice(0, 6);
    if (!/^\d{6}$/.test(c)) return;
    stopMinuteTimer();
    S.chart = { open: true, code: c, name: c, period: 'day', data: null, loading: true, error: null, view: null, geom: null, lockIdx: null };
    $('stockModal').style.display = 'flex';
    $('smName').textContent = c;
    $('smCode').textContent = '';
    $('smQuote').innerHTML = '';
    $('smSource').textContent = '载入中…';
    $('smBody').innerHTML = '<div class="empty">正在拉取 ' + E(c) + ' 的日K / 周K / 筹码分布…</div>';
    $('smFoot').innerHTML = '';
    document.body.style.overflow = 'hidden';
    fetch('/api/stock/chart?code=' + encodeURIComponent(c))
      .then(r => r.json())
      .then(j => {
        if (S.chart.code !== c) return; // 期间切换了标的
        if (j.error) throw new Error(j.error);
        S.chart.data = j;
        S.chart.name = j.name || c;
        S.chart.loading = false;
        $('smName').textContent = j.name || c;
        $('smCode').textContent = E(c);
        renderStockChart();
      })
      .catch(e => {
        S.chart.loading = false;
        S.chart.error = isConnError(e) ? SERVICE_HINT : String(e && e.message || e);
        $('smSource').textContent = '加载失败';
        $('smBody').innerHTML = '<div class="empty">' + E(S.chart.error) + '</div>';
      });
  }

  // 分时图自动刷新：只在「弹窗开着 + 分时 tab + 交易时段」时每 12 秒重拉，
  // 不复用主看板定时器，关闭弹窗或切到K线 tab 立即停掉。
  function stopMinuteTimer() {
    if (S.chart && S.chart.minuteTimer) { clearInterval(S.chart.minuteTimer); S.chart.minuteTimer = null; }
  }
  function syncMinuteTimer() {
    const c = S.chart;
    if (!c || !c.open || c.period !== 'minute' || !c.data || !isTradingNow()) { stopMinuteTimer(); return; }
    if (c.minuteTimer) return;
    c.minuteTimer = setInterval(() => {
      const cur = S.chart;
      if (!cur || !cur.open || cur.period !== 'minute') { stopMinuteTimer(); return; }
      if (!isTradingNow()) { stopMinuteTimer(); renderStockChart(); return; }
      refreshMinuteOnly(cur.code);
    }, 12000);
  }
  async function refreshMinuteOnly(code) {
    try {
      const r = await fetch('/api/stock/minute?code=' + encodeURIComponent(code), { cache: 'no-store' });
      const j = await r.json();
      if (!S.chart || S.chart.code !== code || S.chart.period !== 'minute') return;
      if (j.error) return;
      S.chart.data.minute = j.minute || {};
      S.chart.data.quote = j.quote || S.chart.data.quote;
      renderStockChart();
    } catch (e) { /* 分时刷新失败保留上一帧，不打断查看 */ }
  }

  function closeStockChart() {
    stopMinuteTimer();
    S.chart.open = false;
    const m = $('stockModal'); if (m) m.style.display = 'none';
    document.body.style.overflow = '';
  }

  /* K线配色设置面板：5 类颜色 + 恢复默认 + 口径说明 */
  function smColorPanelHtml() {
    const items = KL_COLOR_META.map(m =>
      '<label class="sm-clr-item"><span>' + E(m.label) + '</span>' +
      '<input type="color" data-klcolor="' + m.k + '" value="' + E(S.klColors[m.k]) + '" title="点击选择颜色"></label>'
    ).join('');
    const rateNote = '涨停/跌停按收盘价相对前收的涨跌幅判定：主板 ±10%、创业板/科创板 ±20%、北交所 ±30%、ST ±5%（容差 0.3%）；' +
      '炸板为盘中最高/最低触及涨跌停价但收盘未封住。周K无涨跌停制度，不标记。识别为近似推算，仅供复盘参考。';
    return '<div class="sm-color-panel" id="smColorPanel">' +
      '<div class="sm-clr-head"><b>🎨 K线配色设置</b><span class="small muted">改动即时生效并自动保存</span>' +
      '<button type="button" data-kact="colors" class="sm-clr-close" title="收起">收起</button></div>' +
      '<div class="sm-clr-grid">' + items + '</div>' +
      '<div class="sm-clr-foot"><button type="button" class="sm-clr-reset" id="smClrReset">恢复默认配色</button>' +
      '<span class="small muted">' + E(rateNote) + '</span></div></div>';
  }

  /** 分时图：价格线 + 均价线 + 昨收基准 + 成交量，纯 SVG 无额外依赖 */
  function smMinuteSvg(rows, quote, mdate) {
    if (!rows || rows.length < 2) return '<div class="empty">分时数据不足（需 ≥2 分钟），无法绘制</div>';
    const W = 1110, H = 520, L = 62, R = 68, PT = 22, PB = 388, VT = 406, VB = 498;
    const PW = W - L - R;
    const prev = Number(quote && quote.prevClose) > 0 ? Number(quote.prevClose) : rows[0].price;
    const prices = rows.map(x => x.price);
    const maxDev = Math.max(0.02, ...prices.map(p => Math.abs(p - prev) / prev));
    const hi = prev * (1 + maxDev * 1.12), lo = prev * (1 - maxDev * 1.12);
    const Y = p => PB - (p - lo) / (hi - lo) * (PB - PT);
    const X = i => L + i / Math.max(1, rows.length - 1) * PW;
    const a = [];
    a.push('<svg viewBox="0 0 ' + W + ' ' + H + '" class="sm-chart-svg" preserveAspectRatio="xMidYMid meet">');
    // 网格 + 涨跌幅刻度
    for (let k = 0; k <= 4; k++) {
      const p = lo + (hi - lo) * k / 4, y = Y(p);
      const dev = (p - prev) / prev * 100;
      const col = dev > 0.01 ? 'var(--up)' : dev < -0.01 ? 'var(--down)' : 'var(--ink2)';
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7"/>');
      a.push('<text x="' + (W - R + 6) + '" y="' + (y + 4).toFixed(1) + '" font-size="11" fill="' + col + '">' + (dev > 0 ? '+' : '') + dev.toFixed(2) + '%</text>');
      a.push('<text x="6" y="' + (y + 4).toFixed(1) + '" font-size="11" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    // 昨收虚线
    a.push('<line x1="' + L + '" y1="' + Y(prev).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(prev).toFixed(1) + '" stroke="#8593a3" stroke-dasharray="4 4"/>');
    // 集合竞价结果：开盘价即 9:25 竞价成交价，单独虚线标注
    const auction = Number(quote && quote.open) > 0 ? Number(quote.open) : null;
    if (auction && Math.abs(auction - prev) / prev > 0.0001) {
      a.push('<line x1="' + L + '" y1="' + Y(auction).toFixed(1) + '" x2="' + (W - R) + '" y2="' + Y(auction).toFixed(1) + '" stroke="#6d4bd6" stroke-dasharray="2 5"/>');
      a.push('<text x="' + L + '" y="' + (Y(auction) - 5).toFixed(1) + '" font-size="10" fill="#6d4bd6">竞价开盘 ' + auction.toFixed(2) + '（' + ((auction - prev) / prev * 100 > 0 ? '+' : '') + ((auction - prev) / prev * 100).toFixed(2) + '%）</text>');
    }
    // 成交量柱（每分钟）
    const maxV = Math.max(1, ...rows.map(x => x.volume || 0));
    const bw = Math.max(1, PW / rows.length * 0.62);
    rows.forEach((x, i) => {
      const h = (x.volume || 0) / maxV * (VB - VT);
      const chg = x.price >= prev;
      a.push('<rect x="' + (X(i) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (chg ? '#d92b2b' : '#0f9960') + '" opacity=".55"/>');
    });
    // 价格线
    const pts = rows.map((x, i) => X(i).toFixed(1) + ',' + Y(x.price).toFixed(1)).join(' ');
    a.push('<polyline points="' + pts + '" fill="none" stroke="#1f4e8c" stroke-width="1.8"/>');
    // 均价线（累计成交额 / 累计成交量 / 100，与腾讯口径一致）
    let amt = 0, vol = 0;
    const avgPts = rows.map((x, i) => {
      amt += Number(x.amount) || 0;
      vol += Number(x.volume) || 0;
      const avg = vol > 0 ? amt / (vol * 100) : x.price;
      return X(i).toFixed(1) + ',' + Y(avg).toFixed(1);
    }).join(' ');
    a.push('<polyline points="' + avgPts + '" fill="none" stroke="#d97706" stroke-width="1.5" stroke-dasharray="3 2"/>');
    // 时间轴
    [0, Math.floor(rows.length / 4), Math.floor(rows.length / 2), Math.floor(rows.length * 3 / 4), rows.length - 1].forEach(i => {
      a.push('<text x="' + X(i).toFixed(1) + '" y="' + (VB + 15) + '" font-size="10.5" fill="#6b7a8c" text-anchor="middle">' + E(rows[i].time) + '</text>');
    });
    a.push('<text x="' + L + '" y="14" font-size="10.5" fill="#8593a3">分时价格 / 均价 · ' + E(mdate || '最近交易日') + ' · 腾讯证券</text>');
    a.push('<text x="' + L + '" y="' + (VT - 6) + '" font-size="10.5" fill="#8593a3">成交量（手）</text>');
    a.push('</svg>');
    return a.join('');
  }

  function renderStockChart() {
    const j = S.chart.data; if (!j) return;
    const per = S.chart.period;
    if (per === 'minute') {
      const md = j.minute || {}, rows = md.rows || [];
      const q = j.quote || {};
      [...document.querySelectorAll('.sm-tab')].forEach(b => b.classList.toggle('active', b.dataset.period === per));
      const trading = isTradingNow();
      $('smSource').textContent = '分时 · ' + E(md.source || '来源不可用') + (md.date ? ' · 交易日 ' + E(String(md.date)) : '') +
        ' · 数据拉取 ' + E(String(md.asOf || '').slice(11, 19)) +
        (trading ? ' · 每 12 秒自动刷新' : ' · 已收盘（静态）');
      $('smBody').innerHTML = md.rows && md.rows.length
        ? '<div class="sm-minute-chart">' + smMinuteSvg(rows, q, md.date) + '</div>'
        : '<div class="empty">' + E(md.reason || '分时数据暂不可用') + '</div>';
      $('smFoot').innerHTML = '<div class="note-box">分时数据来自腾讯证券公开接口（每分钟价格 / 成交量 / 成交额，服务端缓存 60 秒）；均价线＝累计成交额 ÷ 累计成交量，与行情软件口径一致。' +
        (trading
          ? '<b>当前为交易时段，每 12 秒自动重拉分时</b>；盘后自动停止。'
          : '<b>当前为非交易时段，展示最近一个交易日的完整分时，不再变动</b>；开盘后自动恢复刷新。') +
        '<br><b>关于集合竞价：</b>腾讯分时接口从 09:30 开始返回分钟数据，<b>不含 9:15–9:25 的竞价过程</b>（竞价没有连续分钟成交）。' +
        '图中的紫色虚线是 9:25 竞价成交价（即开盘价' + (q.open > 0 ? ' ' + N(q.open) : '，当前快照未取得') + '），' +
        '竞价涨跌幅 ' + (q.open > 0 && q.prevClose > 0 ? (q.open > q.prevClose ? '+' : '') + N((q.open - q.prevClose) / q.prevClose * 100) + '%' : '—') +
        '；竞价期间的委托撤单过程不展示。' +
        '<b>分钟级数据，不是逐笔成交，不构成投资建议。</b></div>';
      syncMinuteTimer();
      return;
    }
    const series = j[per] || {};
    const chip = (j.chip || {})[per] || null;
    // 顶部快照
    const q = j.quote || {};
    const pc = q.pct;
    const qcls = pc > 0 ? 'up' : pc < 0 ? 'down' : '';
    $('smQuote').innerHTML =
      '<span class="sm-price ' + qcls + '">' + N(q.price) + '</span>' +
      '<span class="sm-pct ' + qcls + '">' + (pc === null || pc === undefined ? '—' : (pc > 0 ? '+' : '') + N(pc) + '%') + '</span>' +
      (q.floatCap ? '<span class="sm-meta">流通 ' + E(CAP(q.floatCap)) + '</span>' : '') +
      (q.turnover !== null && q.turnover !== undefined ? '<span class="sm-meta">换手 ' + N(q.turnover, 1) + '%</span>' : '');
    // tab 高亮
    [...document.querySelectorAll('.sm-tab')].forEach(b => b.classList.toggle('active', b.dataset.period === per));
    const adj = series.adjusted === false ? '不复权' : (series.adjusted ? '前复权' : '');
    $('smSource').textContent = (per === 'day' ? '日K' : '周K') + ' · ' + E(series.source || '来源不可用') + (adj ? ' · ' + adj : '') + (series.asOf ? ' · 截至 ' + E(String(series.asOf).slice(0, 10)) : '');
    // 主体：左K线 + 右筹码峰（共享同一价格Y轴，水平网格线对齐）
    const bars = series.rows || [];
    if (!S.chart.view || S.chart.view.total !== bars.length) {
      const def = Math.min(60, bars.length);
      S.chart.view = { total: bars.length, start: Math.max(0, bars.length - def), count: def };
    }
    // 深链 ?zoom=20&day=20261110：指定缩放根数并锁定到某一天
    if (S.chart._initZoom) {
      const z = Math.min(S.chart._initZoom, bars.length);
      S.chart.view.count = z;
      S.chart.view.start = Math.max(0, Math.min(S.chart.view.start, bars.length - z));
      S.chart._initZoom = 0;
    }
    if (S.chart._initLock) {
      const d = S.chart._initLock;
      const idx = bars.findIndex(b => String(b.date).replace(/\D/g, '') === d);
      if (idx >= 0) {
        S.chart.lockIdx = idx;
        if (idx < S.chart.view.start || idx >= S.chart.view.start + S.chart.view.count)
          S.chart.view.start = Math.max(0, Math.min(idx - Math.floor(S.chart.view.count / 2), bars.length - S.chart.view.count));
      }
      S.chart._initLock = null;
    }
    const range = smSharedRange(bars, chip, S.chart.view);
    S.chart.range = range;
    const ksvg = smKlineSvg(bars, per, range, S.chart.view);
    const csvg = chip ? smChipSvg(chip, range) : '<div class="empty">筹码峰数据不足</div>';
    $('smBody').innerHTML =
      '<div class="sm-hd-layout">' +
        '<div class="sm-chart-block sm-kline-block"><div class="sm-block-head"><h4>' + (per === 'day' ? '日K' : '周K') + '线图（蜡烛 + 成交量 + 均线）</h4>' +
        '<div class="sm-k-tools">' +
          '<button type="button" data-kact="out" title="缩小（显示更多K线）">−</button>' +
          '<button type="button" data-kact="in" title="放大（显示更少K线）">＋</button>' +
          '<button type="button" data-kact="left" title="向前平移">◀</button>' +
          '<button type="button" data-kact="right" title="向后平移">▶</button>' +
          '<button type="button" data-kact="reset" title="重置视图">重置</button>' +
          '<button type="button" data-kact="colors" class="sm-color-btn' + (S.klPanelOpen ? ' active' : '') + '" title="自定义涨跌停/炸板配色">🎨 配色</button>' +
          '<span class="sm-view-info" id="smViewInfo"></span>' +
        '</div></div>' +
        (S.klPanelOpen ? smColorPanelHtml() : '') +
        '<div class="sm-svg-wrap" id="smSvgWrap">' + ksvg +
          '<div class="sm-hover-panel" id="smHoverPanel" style="display:none"></div>' +
        '</div>' +
        '<div class="sm-k-hint">滚轮缩放 · 按住拖动平移 · 移动鼠标看某日数据 · 单击锁定 / 双击重置</div></div>' +
        '<div class="sm-chart-block sm-chip-block"><div class="sm-block-head"><h4>筹码峰分布</h4>' +
        '<span class="small muted">模型估算 · 与左图价格轴对齐</span></div>' +
        '<div class="sm-chip-body">' + csvg + (chip ? '<div class="sm-chip-stats">' + smChipStatsHtml(chip) + '</div>' : '') + '</div></div>' +
      '</div>';
    smUpdateViewInfo();
    // 底部方法论与免责
    const m = j.method || {};
    $('smFoot').innerHTML =
      '<div class="note-box">' + E(m.day || '') + ' ' + E(m.week || '') + ' ' + E(m.chip || '') + '</div>' +
      '<div class="small muted" style="margin-top:6px">' + E((j.meta || {}).disclaimer || '') + '</div>';
    if (chip) bindChipHover();
    if (bars.length >= 6) bindKlineInteractions();
    // 配色面板：取色器即时改色、恢复默认、收起
    const cp = $('smColorPanel');
    if (cp) {
      cp.querySelectorAll('[data-klcolor]').forEach(inp => {
        inp.addEventListener('input', e => {
          S.klColors[e.target.dataset.klcolor] = e.target.value;
          klSaveColors();
          smRedrawKline(); // 只重绘K线SVG，面板与状态保持不变
        });
      });
      const rst = $('smClrReset');
      if (rst) rst.onclick = () => {
        S.klColors = Object.assign({}, KL_COLOR_DEFAULT);
        klSaveColors();
        renderStockChart();
      };
      const cls = cp.querySelector('.sm-clr-close');
      if (cls) cls.onclick = () => { S.klPanelOpen = false; renderStockChart(); };
    }
    // 恢复深链/重绘后的锁定态十字光标与数据面板
    if (S.chart.lockIdx !== null && S.chart.geom) {
      const g = S.chart.geom, jj = S.chart.lockIdx - g.start;
      if (jj >= 0 && jj < g.n) smShowCross(jj, null, null, null, true);
      else S.chart.lockIdx = null;
    }
  }

  /* K线与筹码峰共享的价格范围：基于「可见区间」自适应，避免放大后K线被全量高价压扁。
     传入 view 时只取可见窗口的高低点；无 view 时用全量。两图共用同一结果，保证水平对齐。 */
  function smSharedRange(bars, chip, view) {
    let src = bars || [];
    if (view && src.length) {
      const start = Math.max(0, Math.min(view.start, src.length - 1));
      const count = Math.max(6, Math.min(view.count, src.length - start));
      src = src.slice(start, Math.min(src.length, start + count));
    }
    let lo = [], hi = [];
    if (src.length) { lo = src.map(b => b.low); hi = src.map(b => b.high); }
    // 无K线数据时才回退到筹码全量范围
    if (!lo.length && chip) {
      if (chip.range) { lo.push(chip.range[0]); hi.push(chip.range[1]); }
      if (chip.bins && chip.bins.length) { lo.push(...chip.bins.map(b => b.price)); hi.push(...chip.bins.map(b => b.price)); }
      if (chip.price !== null && chip.price !== undefined) { lo.push(chip.price); hi.push(chip.price); }
    }
    if (!lo.length) return { min: 0, max: 1 };
    let minP = Math.min(...lo), maxP = Math.max(...hi);
    const pad = (maxP - minP) * 0.06 || maxP * 0.02;
    return { min: minP - pad, max: maxP + pad };
  }

  /* 零依赖 SVG K线：蜡烛 + 成交量 + MA5/10/20 + 十字光标提示（title） */
  function smKlineSvg(bars, per, range, view) {
    if (!bars || bars.length < 6) return '<div class="empty">该周期K线数据不足（需 ≥6 根），无法绘制</div>';
    const W = 1110, H = 520, L = 62, R = 24;
    const PT = 24, PB = 430, VT = 448, VB = 500, DY = 516;
    const PW = W - L - R;
    const minP = range.min, maxP = range.max;
    const Y = p => PB - (p - minP) / (maxP - minP) * (PB - PT);
    const total = bars.length;
    const vv = view || { start: 0, count: total };
    const start = Math.max(0, Math.min(vv.start, total - 1));
    const count = Math.max(6, Math.min(vv.count, total - start));
    const end = Math.min(total, start + count);
    const vis = bars.slice(start, end);
    const n = vis.length;
    const cw = PW / n, bw = Math.max(1.6, Math.min(22, cw * 0.62));
    const CX = j => L + cw * (j + 0.5);
    const maxV = Math.max(1, ...vis.map(b => b.volume || 0));
    // 暴露几何信息供交互（缩放/平移/十字光标）做坐标换算
    S.chart.geom = { W, H, L, PT, PB, VT, VB, PW, cw, bw, n, start, count, total, minP, maxP };
    const a = [];
    a.push('<svg class="sm-kline" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + (per === 'day' ? '日' : '周') + 'K线图">');
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>');
    for (let i = 0; i <= 4; i++) {
      const p = minP + (maxP - minP) * i / 4, y = Y(p);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7"/>');
      a.push('<text x="' + (L - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="11" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    const KC = S.klColors;
    const kindLabel = { limitUp: '涨停', limitDown: '跌停', broken: '炸板' };
    const kindShown = { limitUp: 0, limitDown: 0, broken: 0 };
    vis.forEach((b, j) => {
      const gi = start + j, cx = CX(j);
      const kind = per === 'day' ? klBarKind(bars, gi, S.chart.code, S.chart.name) : null;
      if (kind) kindShown[kind]++;
      const col = kind ? KC[kind] : (b.close >= b.open ? KC.up : KC.down);
      const yo = Y(b.open), yc = Y(b.close), yh = Y(b.high), yl = Y(b.low);
      const tip = E(b.date) + (kind ? ' 【' + kindLabel[kind] + '】' : '') + ' 开 ' + N(b.open) + ' 高 ' + N(b.high) + ' 低 ' + N(b.low) + ' 收 ' + N(b.close) + ' 量 ' + AMT(b.volume);
      a.push('<g><title>' + tip + '</title>');
      a.push('<line x1="' + cx.toFixed(1) + '" y1="' + yh.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + yl.toFixed(1) + '" stroke="' + col + '" stroke-width="1"/>');
      a.push('<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + Math.min(yo, yc).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1.4, Math.abs(yo - yc)).toFixed(1) + '" fill="' + col + '"/>');
      // 涨停/跌停/炸板小圆点标记（收盘端），仅 K线足够宽时绘制避免糊成一团
      if (kind && bw >= 4) {
        const my = kind === 'limitDown' ? yc + 7 : yc - 7;
        a.push('<circle cx="' + cx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="2.4" fill="' + col + '" stroke="#fff" stroke-width="0.8"/>');
      }
      a.push('</g>');
    });
    [['ma5', 5, '#e8912a'], ['ma10', 10, '#2f6fd0'], ['ma20', 20, '#6d4bd6']].forEach(pair => {
      const pts = [];
      for (let j = 0; j < n; j++) {
        const gi = start + j;
        if (gi >= pair[1] - 1) {
          let s = 0; for (let k = 0; k < pair[1]; k++) s += bars[gi - k].close;
          pts.push(CX(j).toFixed(1) + ',' + Y(s / pair[1]).toFixed(1));
        }
      }
      if (pts.length > 1) a.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + pair[2] + '" stroke-width="1.3" opacity="0.85"/>');
    });
    // 成交量
    a.push('<line x1="' + L + '" y1="' + VT + '" x2="' + (L + PW) + '" y2="' + VT + '" stroke="#eef2f7"/>');
    a.push('<text x="' + (L - 8) + '" y="' + (VT + 12) + '" text-anchor="end" font-size="10" fill="#8593a3">量</text>');
    vis.forEach((b, j) => {
      const gi = start + j;
      const kind = per === 'day' ? klBarKind(bars, gi, S.chart.code, S.chart.name) : null;
      const h = (b.volume || 0) / maxV * (VB - VT - 4);
      const col = kind ? KC[kind] : (b.close >= b.open ? KC.up : KC.down);
      a.push('<rect x="' + (CX(j) - bw / 2).toFixed(1) + '" y="' + (VB - h).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(1, h).toFixed(1) + '" fill="' + col + '" opacity="0.5"><title>' + E(b.date) + ' 成交量 ' + AMT(b.volume) + '</title></rect>');
    });
    const step = Math.max(1, Math.ceil(n / 7));
    vis.forEach((b, j) => {
      if (j % step === 0 || j === n - 1)
        a.push('<text x="' + CX(j).toFixed(1) + '" y="' + DY + '" text-anchor="middle" font-size="10.5" fill="#8593a3">' + E(String(b.date).slice(5)) + '</text>');
    });
    const legend = [[KC.up, '阳线'], [KC.down, '阴线']];
    if (per === 'day') {
      if (kindShown.limitUp) legend.push([KC.limitUp, '涨停 ' + kindShown.limitUp]);
      if (kindShown.limitDown) legend.push([KC.limitDown, '跌停 ' + kindShown.limitDown]);
      if (kindShown.broken) legend.push([KC.broken, '炸板 ' + kindShown.broken]);
    }
    legend.push(['#e8912a', 'MA5'], ['#2f6fd0', 'MA10'], ['#6d4bd6', 'MA20']);
    let lx = L;
    legend.forEach(pair => {
      a.push('<rect x="' + lx + '" y="10" width="10" height="10" rx="2" fill="' + pair[0] + '"/>');
      a.push('<text x="' + (lx + 14) + '" y="20" font-size="11" fill="#6b7a8c">' + E(pair[1]) + '</text>');
      lx += 92;
    });
    // 十字光标（交互时由 JS 显示/定位），置于最上层
    a.push('<g id="smCross" style="display:none">');
    a.push('<line id="smCrossV" x1="0" y1="' + PT + '" x2="0" y2="' + VB + '" stroke="#7c8a9a" stroke-width="1" stroke-dasharray="4 3"/>');
    a.push('<line id="smCrossH" x1="' + L + '" y1="0" x2="' + (L + PW) + '" y2="0" stroke="#7c8a9a" stroke-width="1" stroke-dasharray="4 3"/>');
    a.push('<circle id="smCrossDot" r="4" fill="#fff" stroke="#1c2733" stroke-width="1.5"/>');
    a.push('</g>');
    a.push('</svg>');
    return a.join('');
  }

  /* 筹码峰：横向柱状，纵轴价格与K线对齐；获利(现价下方)红、套牢绿 */
  function smChipSvg(chip, range) {
    const bins = chip.bins || [];
    if (!bins.length) return '<div class="empty">无筹码分布数据</div>';
    // 与K线同Y轴：PT=24 PB=430，价格标签放右侧，筹码条自右向左延伸
    const W = 300, H = 520, L = 10, R = 54;
    const PT = 24, PB = 430;
    const PW = W - L - R;
    const minP = range.min, maxP = range.max;
    const Y = p => PB - (p - minP) / (maxP - minP) * (PB - PT);
    // 只显示落在可见价格区间的筹码；放大后按可见 bins 重新归一化，保持筹码峰饱满
    const visBins = bins.filter(b => b.price >= minP && b.price <= maxP);
    const maxPct = Math.max(1, ...(visBins.length ? visBins : bins).map(b => b.pct));
    // 每个 bin 的像素高度由价格跨度决定（与K线价格轴同步缩放）
    const step = bins.length > 1 ? Math.abs(bins[1].price - bins[0].price) : (maxP - minP) / bins.length;
    const bh = Math.max(1, (PB - PT) * step / (maxP - minP));
    const price = chip.price;
    const a = [];
    a.push('<svg class="sm-chip" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="筹码峰分布">');
    a.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>');
    for (let i = 0; i <= 4; i++) {
      const p = minP + (maxP - minP) * i / 4, y = Y(p);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7"/>');
      a.push('<text x="' + (L + PW + 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="start" font-size="10.5" fill="#8593a3">' + p.toFixed(2) + '</text>');
    }
    visBins.forEach((b, i) => {
      const y = Y(b.price) - bh / 2;
      if (y + bh < PT || y > PB) return; // 超出绘图区不画
      const w = b.pct / maxPct * PW;
      const col = (price !== null && b.price <= price) ? '#d92b2b' : '#0f9960';
      a.push('<rect class="sm-chip-bin" x="' + (L + PW - w).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(0.5, w).toFixed(1) + '" height="' + Math.max(1, bh - 0.4).toFixed(1) +
        '" fill="' + col + '" opacity="0.76"><title>' + N(b.price) + ' 元 · 筹码 ' + N(b.pct, 2) + '%</title></rect>');
    });
    // 获利/套牢分界：轻量红色虚线 + 右侧紧凑圆角价格胶囊（不贯穿全宽）
    if (price !== null && price >= minP && price <= maxP) {
      const yp = Y(price);
      a.push('<line x1="' + L + '" y1="' + yp.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + yp.toFixed(1) +
        '" stroke="#d92b2b" stroke-width="1.1" stroke-dasharray="5 4" opacity="0.72"/>');
      const capW = 64, capH = 18, capX = L + PW - capW, capY = yp - capH / 2;
      // 白色描边作分隔，避免胶囊与筹码条颜色粘连
      a.push('<rect x="' + capX.toFixed(1) + '" y="' + capY.toFixed(1) + '" width="' + capW + '" height="' + capH +
        '" rx="9" fill="#d92b2b" stroke="#fff" stroke-width="1.2"/>');
      a.push('<text x="' + (capX + capW / 2).toFixed(1) + '" y="' + (yp + 3.8).toFixed(1) +
        '" text-anchor="middle" font-size="10.5" fill="#fff" font-weight="700">现价 ' + N(price) + '</text>');
    }
    // 峰值标注（只标落在可见价格区间的峰）
    (chip.peaks || []).forEach((p, idx) => {
      if (p.price < minP || p.price > maxP) return;
      const y = Y(p.price);
      a.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (L + PW) + '" y2="' + y.toFixed(1) + '" stroke="#e8912a" stroke-width="1" stroke-dasharray="3 3" opacity="0.85"/>');
      if (idx < 2) a.push('<text x="' + (L + 2) + '" y="' + (y - 4).toFixed(1) + '" font-size="10" fill="#e8912a" font-weight="700">峰' + N(p.price) + '</text>');
    });
    a.push('<text x="' + L + '" y="478" font-size="11" fill="#d92b2b" font-weight="600">■ 获利盘 ' + N(chip.profitRatio, 1) + '%</text>');
    a.push('<text x="' + (L + 150) + '" y="478" font-size="11" fill="#0f9960" font-weight="600">■ 套牢 ' + N(chip.trappedRatio, 1) + '%</text>');
    a.push('</svg>');
    return a.join('');
  }

  function smChipStatsHtml(chip) {
    const c = chip.concentration || {};
    const dev = chip.costDeviation;
    const items = [
      ['获利比例', '<span class="up">' + N(chip.profitRatio, 1) + '%</span>'],
      ['套牢比例', '<span class="down">' + N(chip.trappedRatio, 1) + '%</span>'],
      ['90%集中度', N(c.c90) + '<small class="muted"> ' + E(c.label90 || '') + '</small>'],
      ['70%集中度', N(c.c70) + '<small class="muted"> ' + E(c.label70 || '') + '</small>'],
      ['平均成本', N(chip.costAvg) + ' 元'],
      ['成本偏离', (dev === null || dev === undefined ? '—' : (dev > 0 ? '+' : '') + N(dev, 1) + '%')],
      ['70%成本区', N(chip.cost70[0]) + '–' + N(chip.cost70[1])],
      ['90%成本区', N(chip.cost90[0]) + '–' + N(chip.cost90[1])],
      ['筹码峰', (chip.peaks || []).slice(0, 2).map(p => N(p.price)).join('/') || '—']
    ];
    return items.map(x => '<div class="sm-stat"><span class="k">' + x[0] + '</span><span class="v">' + x[1] + '</span></div>').join('');
  }

  function bindChipHover() {
    // title 原生提示已够用，这里预留：点击筹码区间不做跳转，避免误触
  }

  /* ─────────── K线交互：缩放 / 平移 / 十字光标 / 单日数据 ─────────── */
  const smClamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function smUpdateViewInfo() {
    const el = $('smViewInfo'), v = S.chart.view;
    if (!el || !v) return;
    el.textContent = '显示 ' + (v.start + 1) + '–' + Math.min(v.total, v.start + v.count) + ' / ' + v.total + ' 根';
  }

  function smViewReset() {
    const total = S.chart.geom ? S.chart.geom.total : 0;
    const def = Math.min(60, total || 60);
    S.chart.view = { total: total, start: Math.max(0, total - def), count: def };
    S.chart.lockIdx = null;
    smRedrawKline();
  }

  /* 重绘 K线 + 筹码峰：价格轴随可见区间自适应，两图共享同一 range 保持对齐 */
  function smRedrawKline() {
    const j = S.chart.data; if (!j) return;
    const per = S.chart.period, bars = j[per].rows || [];
    const chip = (j.chip || {})[per] || null;
    const range = smSharedRange(bars, chip, S.chart.view);
    S.chart.range = range;
    const svgHtml = smKlineSvg(bars, per, range, S.chart.view);
    const wrap = $('smSvgWrap'); if (!wrap) return;
    const old = wrap.querySelector('svg.sm-kline');
    if (old) old.outerHTML = svgHtml;
    else wrap.insertAdjacentHTML('afterbegin', svgHtml);
    // 筹码峰同步重绘（价格轴已随可见区间变化）
    if (chip) {
      const cbody = document.querySelector('.sm-chip-body');
      const oldChip = cbody && cbody.querySelector('svg.sm-chip');
      if (oldChip) oldChip.outerHTML = smChipSvg(chip, range);
    }
    smUpdateViewInfo();
    // 恢复锁定态
    const g = S.chart.geom;
    if (S.chart.lockIdx !== null && g) {
      const jj = S.chart.lockIdx - g.start;
      if (jj >= 0 && jj < g.n) smShowCross(jj, null, null, null, true);
      else { S.chart.lockIdx = null; smHideCross(); }
    } else smHideCross();
  }

  /* 缩放：factor<1 放大（更少K线），>1 缩小；anchorFrac 为鼠标在绘图区的横向比例 */
  function smZoom(factor, anchorFrac) {
    const v = S.chart.view, total = v.total;
    const aF = smClamp(anchorFrac === undefined ? 1 : anchorFrac, 0, 1);
    const newCount = Math.round(smClamp(v.count * factor, 6, total));
    if (newCount === v.count) return;
    const anchorGi = v.start + aF * v.count;
    v.start = Math.round(smClamp(anchorGi - aF * newCount, 0, total - newCount));
    v.count = newCount;
    smRedrawKline();
  }

  function smPan(delta) {
    const v = S.chart.view;
    const ns = Math.round(smClamp(v.start + delta, 0, v.total - v.count));
    if (ns === v.start) return;
    v.start = ns;
    smRedrawKline();
  }

  /* 鼠标/屏幕坐标 → SVG viewBox 坐标 + 相对 wrap 的像素坐标 */
  function smEvtPos(e) {
    const svg = document.querySelector('#smSvgWrap svg.sm-kline'), wrap = $('smSvgWrap');
    if (!svg || !wrap || !S.chart.geom) return null;
    const r = svg.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), g = S.chart.geom;
    if (!r.width || !r.height) return null;
    return {
      vx: (e.clientX - r.left) / r.width * g.W,
      vy: (e.clientY - r.top) / r.height * g.H,
      rx: e.clientX - wr.left, ry: e.clientY - wr.top,
      svgRect: r, wrapRect: wr
    };
  }

  /* 十字光标 + 单日数据面板。vy 为空时用该日收盘价定位水平线 */
  function smShowCross(j, vy, rx, ry, locked) {
    const g = S.chart.geom, wrap = $('smSvgWrap'), panel = $('smHoverPanel');
    if (!g || !wrap) return;
    const rows = (S.chart.data[S.chart.period] || {}).rows || [];
    const gi = g.start + j, bar = rows[gi];
    if (!bar) return;
    const cx = g.L + g.cw * (j + 0.5);
    const yy = vy === null || vy === undefined ? g.PB - (bar.close - g.minP) / (g.maxP - g.minP) * (g.PB - g.PT) : vy;
    const cross = document.getElementById('smCross');
    if (cross) {
      cross.style.display = 'inline';
      const vline = document.getElementById('smCrossV'), hline = document.getElementById('smCrossH'), dot = document.getElementById('smCrossDot');
      if (vline) { vline.setAttribute('x1', cx.toFixed(1)); vline.setAttribute('x2', cx.toFixed(1)); }
      if (hline) { hline.setAttribute('y1', smClamp(yy, g.PT, g.PB).toFixed(1)); hline.setAttribute('y2', smClamp(yy, g.PT, g.PB).toFixed(1)); }
      if (dot) { dot.setAttribute('cx', cx.toFixed(1)); dot.setAttribute('cy', smClamp(yy, g.PT, g.PB).toFixed(1)); }
    }
    if (!panel) return;
    panel.innerHTML = smHoverDataHtml(bar, gi, !!locked);
    panel.style.display = 'block';
    // 优先跟随鼠标；缩放恢复等无鼠标坐标时用十字交点定位
    let ax = rx, ay = ry;
    if (ax === null || ax === undefined || ay === null || ay === undefined) {
      const svgEl = wrap.querySelector('svg.sm-kline');
      if (svgEl) {
        const sr = svgEl.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
        ax = (sr.left - wr.left) + cx / g.W * sr.width;
        ay = (sr.top - wr.top) + smClamp(yy, g.PT, g.PB) / g.H * sr.height;
      } else { ax = 20; ay = 20; }
    }
    const pw = panel.offsetWidth || 210, ph = panel.offsetHeight || 120;
    let left = ax + 14; if (left + pw > wrap.clientWidth - 4) left = ax - pw - 14;
    if (left < 2) left = 2;
    let top = ay + 12; if (top + ph > wrap.clientHeight - 4) top = ay - ph - 12;
    if (top < 2) top = 2;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function smHideCross() {
    const cross = document.getElementById('smCross'), panel = $('smHoverPanel');
    if (cross) cross.style.display = 'none';
    if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
  }

  function smHoverDataHtml(bar, gi, locked) {
    const rows = (S.chart.data[S.chart.period] || {}).rows || [];
    const prev = gi > 0 ? rows[gi - 1] : null;
    const pct = prev && prev.close ? (bar.close / prev.close - 1) * 100 : null;
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    const ma = n => { if (gi < n - 1) return '—'; let s = 0; for (let k = 0; k < n; k++) s += rows[gi - k].close; return N(s / n); };
    const row = (k, v, c) => '<div class="sm-hover-row"><span>' + k + '</span><b class="' + (c || '') + '">' + v + '</b></div>';
    const kind = S.chart.period === 'day' ? klBarKind(rows, gi, S.chart.code, S.chart.name) : null;
    const kindChip = kind ? '<span class="sm-hover-kind kind-' + kind + '">' + { limitUp: '涨停', limitDown: '跌停', broken: '炸板' }[kind] + '</span>' : '';
    return '<div class="sm-hover-head"><b>' + E(bar.date) + '</b>' + kindChip + (locked ? '<span class="sm-lock-flag">已锁定 · 再点取消</span>' : '') + '</div>' +
      '<div class="sm-hover-grid">' +
        row('开盘', N(bar.open)) + row('最高', N(bar.high), 'up') +
        row('最低', N(bar.low), 'down') + row('收盘', N(bar.close), cls) +
        row('涨跌幅', pct === null ? '—' : (pct > 0 ? '+' : '') + N(pct) + '%', cls) + row('成交量', AMT(bar.volume)) +
        row('MA5', ma(5)) + row('MA10', ma(10)) + row('MA20', ma(20)) +
      '</div>';
  }

  function bindKlineInteractions() {
    const wrap = $('smSvgWrap'); if (!wrap) return;
    const block = wrap.closest('.sm-kline-block'), tools = block && block.querySelector('.sm-k-tools');
    if (tools) tools.onclick = e => {
      const b = e.target.closest('[data-kact]'); if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const step = Math.max(1, Math.round(S.chart.view.count * 0.3));
      if (b.dataset.kact === 'in') smZoom(0.8);
      else if (b.dataset.kact === 'out') smZoom(1.25);
      else if (b.dataset.kact === 'left') smPan(-step);
      else if (b.dataset.kact === 'right') smPan(step);
      else if (b.dataset.kact === 'reset') smViewReset();
      else if (b.dataset.kact === 'colors') { S.klPanelOpen = !S.klPanelOpen; renderStockChart(); }
    };
    if (S.chart.upHandler) document.removeEventListener('mouseup', S.chart.upHandler);
    let drag = null, raf = 0;
    S.chart.upHandler = () => {
      if (drag) { if (drag.moved) S.chart._justDragged = true; drag = null; wrap.classList.remove('dragging'); }
    };
    document.addEventListener('mouseup', S.chart.upHandler);

    wrap.addEventListener('wheel', e => {
      e.preventDefault();
      const p = smEvtPos(e); if (!p) return;
      const g = S.chart.geom, aF = (p.vx - g.L) / g.PW;
      smZoom(e.deltaY < 0 ? 0.82 : 1.22, aF);
      const pos = smEvtPos(e);
      if (pos) { const j = Math.floor((pos.vx - S.chart.geom.L) / S.chart.geom.cw); if (j >= 0 && j < S.chart.geom.n) smShowCross(j, pos.vy, pos.rx, pos.ry, S.chart.lockIdx !== null); }
    }, { passive: false });

    wrap.addEventListener('mousemove', e => {
      const p = smEvtPos(e); if (!p) return;
      if (drag) {
        const target = Math.round(smClamp(drag.start - Math.round((p.vx - drag.vx) / drag.g.cw), 0, drag.g.total - S.chart.view.count));
        if (Math.abs(p.vx - drag.vx) > 3) drag.moved = true;
        if (target !== S.chart.view.start) {
          S.chart.view.start = target;
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; smRedrawKline(); });
        }
        return;
      }
      if (S.chart.lockIdx !== null) return;
      const g = S.chart.geom, j = Math.floor((p.vx - g.L) / g.cw);
      if (j >= 0 && j < g.n) smShowCross(j, p.vy, p.rx, p.ry, false);
      else smHideCross();
    });
    wrap.addEventListener('mouseleave', () => { if (!drag && S.chart.lockIdx === null) smHideCross(); });
    wrap.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const p = smEvtPos(e); if (!p) return;
      drag = { vx: p.vx, start: S.chart.view.start, g: Object.assign({}, S.chart.geom), moved: false };
      wrap.classList.add('dragging');
    });
    wrap.addEventListener('click', e => {
      if (S.chart._justDragged) { S.chart._justDragged = false; return; }
      const p = smEvtPos(e); if (!p) return;
      const g = S.chart.geom, j = Math.floor((p.vx - g.L) / g.cw);
      if (j < 0 || j >= g.n) return;
      const gi = g.start + j;
      S.chart.lockIdx = (S.chart.lockIdx === gi) ? null : gi;
      smShowCross(j, p.vy, p.rx, p.ry, S.chart.lockIdx !== null);
    });
    wrap.addEventListener('dblclick', e => { e.preventDefault(); smViewReset(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
