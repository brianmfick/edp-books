'use strict';
(() => {
  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const cents = v => Math.round(Number(v || 0) * 100);
  const fmt = c => usd.format(c / 100);
  const fmtSigned = c => (c > 0 ? '+' : c < 0 ? '−' : '') + usd.format(Math.abs(c) / 100);
  const short = c => {
    const v = Math.abs(c) / 100;
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k';
    return '$' + Math.round(v);
  };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmtDate = (s, withYear) => {
    if (!s) return '';
    const [y, m, d] = s.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}${withYear ? ', ' + y : ''}`;
  };
  const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; };
  const normJob = s => {
    const v = String(s || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!v) return null;
    const m = v.match(/^(BB|IL)-?(\d+)$/);
    return m ? `${m[1]}-${m[2]}` : v;
  };
  const jobSort = j => { const m = String(j).match(/(\d+)/); return m ? Number(m[1]) : 0; };
  const parseAmount = s => {
    const n = Number(String(s || '').replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : NaN;
  };
  const payeeKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('edp-books:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('edp-books:' + k, JSON.stringify(v)); } catch { /* private window */ } }
  };
  const icon = id => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function friendly(err) {
    const m = (err && (err.message || err.error_description)) || String(err);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No connection. Check your internet and try again.';
    if (/JWT|expired|not authenticated/i.test(m)) return 'Your login ran out. Sign in again.';
    return m;
  }
  function fail(err) { console.error(err); toast(friendly(err)); }

  // ---------------------------------------------------------------- connection
  const cfg = window.EDP_CONFIG || {};
  const sb = (cfg.url && cfg.key && window.supabase)
    ? window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;

  async function q(req) { const { data, error } = await req; if (error) throw error; return data; }
  async function fetchAll(make) {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const rows = await q(make().range(from, from + size - 1));
      out.push(...rows);
      if (rows.length < size) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- state
  const thisYear = new Date().getFullYear();
  const S = {
    user: null,
    year: thisYear,
    accounts: [], acctById: new Map(), bal: new Map(),
    cats: [], catById: new Map(),
    payees: [], statements: [], stmtCheck: new Map(), flags: [],
    tx: [], loadedAt: 0, loading: false,
    f: { q: '', account: '', month: '', side: '', cat: '', look: false },
    sel: new Set(), showN: 200,
    report: 'pl', reportMonth: '', reportSide: 'business', showResolved: false,
  };

  async function loadBase() {
    const [accounts, bal, cats, payees, statements, check, flags] = await Promise.all([
      q(sb.from('accounts').select('*').order('name')),
      q(sb.from('account_balances').select('*')),
      q(sb.from('categories').select('*').order('sort').order('name')),
      q(sb.from('payees').select('*').order('name')),
      q(sb.from('statements').select('*').order('uploaded_at', { ascending: false })),
      q(sb.from('statement_check').select('*')),
      q(sb.from('flags').select('*').order('created_at', { ascending: false })),
    ]);
    S.accounts = accounts;
    S.acctById = new Map(accounts.map(a => [a.id, a]));
    S.bal = new Map(bal.map(b => [b.account_id, b]));
    S.cats = cats;
    S.catById = new Map(cats.map(c => [c.id, c]));
    S.payees = payees;
    S.statements = statements;
    S.stmtCheck = new Map(check.map(c => [c.statement_id, c]));
    S.flags = flags;
  }
  async function loadYear() {
    const y = S.year;
    S.tx = await fetchAll(() => sb.from('transactions').select('*')
      .gte('date', `${y}-01-01`).lte('date', `${y}-12-31`)
      .order('date', { ascending: false }).order('created_at', { ascending: false }));
    S.tx.sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
  }
  async function reload(quiet) {
    if (S.loading) return;
    S.loading = true;
    if (!quiet) $('#view').innerHTML = '<div class="loading">Loading your books…</div>';
    try {
      await Promise.all([loadBase(), loadYear()]);
      S.loadedAt = Date.now();
      render();
    } catch (err) {
      console.error(err);
      $('#view').innerHTML = `<section class="sheet"><div class="empty"><h3>Couldn't load your books</h3><p>${esc(friendly(err))}</p><button class="btn primary" type="button" data-act="refresh">Try again</button></div></section>`;
    } finally {
      S.loading = false;
    }
  }

  // ---------------------------------------------------------------- money rules
  const acct = id => S.acctById.get(id);
  const cat = id => S.catById.get(id);
  const isTransfer = t => cat(t.category_id)?.kind === 'transfer';
  const effSide = t => {
    if (t.side) return t.side;
    const c = cat(t.category_id);
    if (c && c.side !== 'both') return c.side;
    return acct(t.account_id)?.side || 'business';
  };
  const needsLook = t => !t.category_id || t.flagged;
  const whoOf = t => t.payee || t.description || '(no description)';
  const isCashKind = k => k === 'checking' || k === 'savings' || k === 'cash';
  const isDebtKind = k => k === 'credit card' || k === 'loan';
  const bigLimit = () => prefs.get('bigLimit', 2500) * 100;

  function catOptions(selected, { blank = '— Not sorted yet —', withNone = false } = {}) {
    const groups = [
      ['Business money in', c => c.kind === 'income' && c.side === 'business'],
      ['Business costs', c => c.kind === 'expense' && c.side === 'business'],
      ['Personal money in', c => c.kind === 'income' && c.side === 'personal'],
      ['Personal spending', c => c.kind === 'expense' && c.side === 'personal'],
      ['Transfers (not income or cost)', c => c.kind === 'transfer'],
    ];
    let html = blank !== null ? `<option value="">${esc(blank)}</option>` : '';
    if (withNone) html += `<option value="none"${selected === 'none' ? ' selected' : ''}>Not sorted yet</option>`;
    for (const [label, test] of groups) {
      const list = S.cats.filter(c => test(c) && (c.active || c.id === selected));
      if (!list.length) continue;
      html += `<optgroup label="${esc(label)}">` + list.map(c =>
        `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('') + '</optgroup>';
    }
    return html;
  }
  const acctOptions = (selected, blank) =>
    (blank ? `<option value="">${esc(blank)}</option>` : '') +
    S.accounts.filter(a => a.active || a.id === selected).map(a =>
      `<option value="${a.id}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`).join('');

  // Red flags worked out from the year's lines. "Looks fine" marks a line as checked.
  function autoFlags() {
    const tx = S.tx;
    const dup = [];
    const groups = new Map();
    for (const t of tx) {
      const c = cents(t.amount);
      if (c >= 0 || isTransfer(t)) continue;
      const k = t.account_id + '|' + c;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date.localeCompare(b.date));
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        if (a.reviewed && b.reviewed) continue;
        if (a.check_no && b.check_no && a.check_no !== b.check_no) continue;
        if (dayNum(b.date) - dayNum(a.date) > 3) continue;
        if (payeeKey(whoOf(a)).slice(0, 10) !== payeeKey(whoOf(b)).slice(0, 10)) continue;
        dup.push([a, b]);
      }
    }
    const limit = bigLimit();
    const big = tx.filter(t => cents(t.amount) <= -limit && !t.job && !t.reviewed && !isTransfer(t) && effSide(t) === 'business');
    const checks = tx.filter(t => t.check_no && cents(t.amount) < 0 && !t.job && !t.category_id && !t.reviewed);
    const deposits = tx.filter(t => {
      if (cents(t.amount) <= 0 || t.job || t.reviewed || effSide(t) !== 'business') return false;
      const c = cat(t.category_id);
      return !c || c.name.startsWith('Job income');
    });
    const unsorted = tx.filter(t => !t.category_id).length;
    return { dup, big, checks, deposits, unsorted, count: dup.length + big.length + checks.length + deposits.length };
  }
  const openFlags = () => S.flags.filter(f => f.status === 'open');

  // ---------------------------------------------------------------- router
  const ROUTES = {
    home: ['Home', () => viewHome()],
    money: ['Money in and out', () => viewMoney()],
    statements: ['Statements', () => viewStatements()],
    reports: ['Reports', () => viewReports()],
    flags: ['Red flags', () => viewFlags()],
    accounts: ['Accounts', () => viewAccounts()],
    settings: ['Settings', () => viewSettings()],
    more: ['More', () => viewMore()],
  };
  const route = () => { const r = location.hash.slice(1); return ROUTES[r] ? r : 'home'; };

  function render() {
    const r = route();
    const [title, view] = ROUTES[r];
    $('#top-h1').textContent = title;
    $('#top-eyebrow').textContent = r === 'home' ? new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'EDP Books · ' + S.year;
    document.title = r === 'home' ? 'EDP Books' : `${title} · EDP Books`;
    document.querySelectorAll('.side a, .tabs a').forEach(a => {
      const target = a.getAttribute('href').slice(1);
      const on = target === r || (target === 'more' && ['flags', 'accounts', 'settings', 'more'].includes(r));
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('#view').innerHTML = view();
    afterRender(r);
    const n = autoFlags().count + openFlags().length;
    $('#side-flags').textContent = n ? String(n) : '';
    $('#tab-dot').hidden = !n;
  }
  function afterRender(r) {
    if (r === 'home') drawCharts();
    if (r === 'money') renderRegister();
  }

  // ---------------------------------------------------------------- home
  function viewHome() {
    const steps = startSteps();
    if (!S.accounts.length) return steps;
    let cash = 0, owed = 0;
    for (const a of S.accounts) {
      if (!a.active) continue;
      const b = cents(S.bal.get(a.id)?.balance);
      if (isCashKind(a.kind)) cash += b; else if (isDebtKind(a.kind)) owed += b;
    }
    let bin = 0, bout = 0;
    for (const t of S.tx) {
      if (isTransfer(t) || effSide(t) !== 'business') continue;
      const c = cents(t.amount);
      if (c > 0) bin += c; else bout -= c;
    }
    const look = S.tx.filter(needsLook).length;
    const fl = autoFlags().count + openFlags().length;
    const waiting = S.statements.filter(s => s.status === 'uploaded').length;
    const yearWord = S.year === thisYear ? 'so far this year' : 'in ' + S.year;

    const tiles = `<section class="tiles" aria-label="Summary">
      <a class="tile" href="#accounts"><span class="label">In the bank</span><span class="num">${fmt(cash)}</span><span class="sub">Checking, savings and cash</span></a>
      <a class="tile" href="#accounts"><span class="label">Owed on cards and loans</span><span class="num">${fmt(Math.max(0, -owed))}</span><span class="sub">${owed > 0 ? fmt(owed) + ' credit' : 'Balances right now'}</span></a>
      <a class="tile" href="#reports"><span class="label">Business profit</span><span class="num${bin - bout > 0 ? ' in' : ''}">${fmtSigned(bin - bout)}</span><span class="sub">${fmt(bin)} in, ${fmt(bout)} out, ${yearWord}</span></a>
      <a class="tile${fl ? ' alert' : ''}" href="#flags"><span class="label">Red flags</span><span class="num">${fl}</span><span class="sub">${look} line${look === 1 ? '' : 's'} not sorted or flagged</span></a>
    </section>`;

    const chart = `<section class="sheet">
      <div class="sheet-head"><h2>Business money by month</h2>
        <div class="legend" aria-hidden="true"><span><i class="k-in"></i>Money in</span><span><i class="k-out"></i>Money out</span></div></div>
      <div class="sheet-body"><div class="chart" data-chart="months" role="img" aria-label="Business money in and out for each month of ${S.year}"></div>
      <a class="small" href="#reports" data-act="report" data-report="months">See these numbers as a table</a></div>
    </section>`;

    const accounts = `<section class="sheet">
      <div class="sheet-head"><h2>Accounts</h2><a class="btn small" href="#accounts">All accounts</a></div>
      ${S.accounts.filter(a => a.active).map(a => acctRow(a)).join('')}
    </section>`;

    const recent = S.tx.slice(0, 8);
    const recentHtml = `<section class="sheet">
      <div class="sheet-head"><h2>Latest lines</h2><a class="btn small" href="#money">See all</a></div>
      ${recent.length ? `<ul class="register">${recent.map(t => regRow(t, false)).join('')}</ul>`
        : `<div class="empty"><p>No lines for ${S.year} yet. Upload a statement and tell Claude it's there.</p></div>`}
    </section>`;

    const waitingHtml = waiting ? `<div class="note">${waiting} statement${waiting === 1 ? ' is' : 's are'} waiting. Tell Claude “statements are in” and it will load every line.</div>` : '';
    const showSteps = !S.tx.length && !S.statements.some(s => s.status === 'loaded');
    return `${waitingHtml}${tiles}${showSteps ? steps : ''}
      <div class="grid-2">${chart}${accounts}</div>${recentHtml}`;
  }

  function startSteps() {
    const hasAcct = S.accounts.length > 0;
    const hasStmt = S.statements.length > 0;
    const loaded = S.statements.some(s => s.status === 'loaded');
    const li = (done, n, title, text, action) =>
      `<li class="${done ? 'done' : ''}"><span class="step-n">${done ? '✓' : n}</span><div><h3>${title}</h3><p class="small muted">${text}</p></div>${action || ''}</li>`;
    return `<section class="sheet"><div class="sheet-head"><h2>Getting started</h2></div><ol class="steps">
      ${li(hasAcct, 1, 'Add your accounts', 'Each bank account and card, by nickname. Never the account number.', hasAcct ? '' : '<button class="btn primary small" type="button" data-act="acct-new">Add</button>')}
      ${li(hasStmt, 2, 'Upload statements', 'PDF or the bank’s download file, from your phone or computer.', hasStmt ? '' : '<a class="btn small" href="#statements">Upload</a>')}
      ${li(loaded, 3, 'Tell Claude “statements are in”', 'Claude reads them and fills in every line, sorted into categories.')}
      ${li(false, 4, 'Check the red flags', 'Look over anything Claude couldn’t sort or that looks wrong.', '<a class="btn small" href="#flags">Open</a>')}
    </ol></section>`;
  }

  function acctRow(a, clickable) {
    const b = S.bal.get(a.id);
    const bal = cents(b?.balance);
    const shown = isDebtKind(a.kind) ? -bal : bal;
    return `<div class="acct${clickable ? ' click' : ''}"${clickable ? ` data-act="acct-edit" data-id="${a.id}" role="button" tabindex="0"` : ''}>
      <div><div class="acct-name">${esc(a.name)}</div>
        <div class="acct-meta"><span class="chip ${a.side === 'business' ? 'biz' : 'per'}">${a.side === 'business' ? 'Business' : 'Personal'}</span>
        <span>${esc(a.kind[0].toUpperCase() + a.kind.slice(1))}${a.bank ? ' · ' + esc(a.bank) : ''}</span>${b?.last_date ? `<span>Lines through ${fmtDate(b.last_date, true)}</span>` : ''}</div></div>
      <div class="num">${fmt(shown)}${isDebtKind(a.kind) ? '<div class="small muted">owed</div>' : ''}</div>
    </div>`;
  }

  function monthTotals(side) {
    const m = Array.from({ length: 12 }, () => ({ in: 0, out: 0 }));
    for (const t of S.tx) {
      if (isTransfer(t) || (side && effSide(t) !== side)) continue;
      const c = cents(t.amount);
      const i = Number(t.date.slice(5, 7)) - 1;
      if (c > 0) m[i].in += c; else m[i].out -= c;
    }
    return m;
  }

  // Grouped bars, one pair per month, drawn to the container's real width.
  function drawCharts() {
    document.querySelectorAll('.chart[data-chart="months"]').forEach(el => {
      const data = monthTotals('business');
      const W = Math.max(280, el.clientWidth);
      const H = 220, L = 52, R = 6, T = 10, B = 26;
      const pw = W - L - R, ph = H - T - B;
      const max = Math.max(1, ...data.map(d => Math.max(d.in, d.out)));
      const step = niceStep(max / 4);
      const top = Math.ceil(max / step) * step;
      const y = v => T + ph - (v / top) * ph;
      const band = pw / 12;
      const gap = 2;
      const bw = Math.max(3, Math.min(22, (band - 8) / 2 - gap / 2));
      const narrow = W < 480;
      let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><g class="grid">`;
      for (let v = 0; v <= top + 1; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      s += '</g><g class="axis">';
      for (let v = 0; v <= top + 1; v += step) s += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v ? short(v) : '$0'}</text>`;
      data.forEach((_, i) => { s += `<text x="${L + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${narrow ? MONTHS[i][0] : MONTHS[i]}</text>`; });
      s += '</g>';
      data.forEach((d, i) => {
        const cx = L + band * i + band / 2;
        s += `<rect class="hit" data-m="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ph}"/>`;
        s += bar(cx - gap / 2 - bw, bw, y(d.in), T + ph, 'bar-in');
        s += bar(cx + gap / 2, bw, y(d.out), T + ph, 'bar-out');
      });
      s += '</svg><div class="tip" hidden></div>';
      el.innerHTML = s;
      el._data = data;
    });
  }
  function bar(x, w, yTop, base, cls) {
    const h = base - yTop;
    if (h <= 0.5) return '';
    const r = Math.min(4, h, w / 2);
    return `<path class="${cls}" pointer-events="none" d="M${x},${base} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${base} Z"/>`;
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  function showTip(hit) {
    const chart = hit.closest('.chart');
    const tip = chart.querySelector('.tip');
    const i = Number(hit.dataset.m);
    const d = chart._data[i];
    chart.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
    hit.classList.add('on');
    tip.innerHTML = `<b>${MONTHS_LONG[i]} ${S.year}</b><br>In ${fmt(d.in)}<br>Out ${fmt(d.out)}<br>Profit ${fmtSigned(d.in - d.out)}`;
    tip.hidden = false;
    const cr = chart.getBoundingClientRect(), hr = hit.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let left = hr.left - cr.left + hr.width / 2 - tw / 2;
    left = Math.max(0, Math.min(cr.width - tw, left));
    tip.style.left = left + 'px';
    tip.style.top = '0px';
  }
  function hideTip(chart) {
    chart.querySelector('.tip').hidden = true;
    chart.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
  }

  // ---------------------------------------------------------------- money in and out
  function viewMoney() {
    if (!S.accounts.length) return startSteps();
    const f = S.f;
    const monthOpts = '<option value="">All of ' + S.year + '</option>' + MONTHS_LONG.map((m, i) =>
      `<option value="${pad(i + 1)}"${f.month === pad(i + 1) ? ' selected' : ''}>${m}</option>`).join('');
    return `<section class="sheet">
      <div class="sheet-body">
        <div class="filters">
          <label class="field wide"><span>Search</span><input type="search" id="f-q" value="${esc(f.q)}" placeholder="Payee, job (BB-152), check #, amount" autocomplete="off"></label>
          <label class="field"><span>Account</span><select id="f-account">${acctOptions(f.account, 'All accounts')}</select></label>
          <label class="field"><span>Month</span><select id="f-month">${monthOpts}</select></label>
          <label class="field"><span>Side</span><select id="f-side">
            <option value="">Both</option>
            <option value="business"${f.side === 'business' ? ' selected' : ''}>Business</option>
            <option value="personal"${f.side === 'personal' ? ' selected' : ''}>Personal</option></select></label>
          <label class="field"><span>Category</span><select id="f-cat">${catOptions(f.cat, { blank: 'All categories', withNone: true })}</select></label>
          <label class="check"><input type="checkbox" id="f-look"${f.look ? ' checked' : ''}>Needs a look</label>
        </div>
        <div class="row">
          <button class="btn primary" type="button" data-act="tx-new">${icon('plus')}Add a line</button>
          <button class="btn" type="button" data-act="tx-csv">${icon('down')}Download list</button>
          <button class="btn ghost" type="button" data-act="f-clear">Clear filters</button>
        </div>
      </div>
    </section>
    <section class="sheet" id="reg"></section>`;
  }

  function filtered() {
    const f = S.f;
    const qq = f.q.trim().toLowerCase();
    const qJob = normJob(f.q);
    return S.tx.filter(t => {
      if (f.account && t.account_id !== f.account) return false;
      if (f.month && t.date.slice(5, 7) !== f.month) return false;
      if (f.side && effSide(t) !== f.side) return false;
      if (f.cat === 'none' ? !!t.category_id : (f.cat && t.category_id !== f.cat)) return false;
      if (f.look && !needsLook(t)) return false;
      if (!qq) return true;
      if (qJob && t.job === qJob) return true;
      const amt = Math.abs(Number(t.amount));
      const hay = [t.payee, t.description, t.job, t.check_no, t.memo, cat(t.category_id)?.name, acct(t.account_id)?.name,
        amt.toFixed(2), usd.format(amt)].join(' ').toLowerCase();
      return hay.includes(qq);
    });
  }

  function regRow(t, pick) {
    const c = cents(t.amount);
    const k = cat(t.category_id);
    const side = effSide(t);
    return `<li class="reg-row" data-act="tx-edit" data-id="${t.id}">
      ${pick ? `<span class="reg-pick"><input type="checkbox" data-act="pick" data-id="${t.id}" aria-label="Select this line"${S.sel.has(t.id) ? ' checked' : ''}></span>` : '<span class="reg-pick"></span>'}
      <span class="reg-date">${fmtDate(t.date)}</span>
      <span class="reg-who">${esc(whoOf(t))}</span>
      <span class="reg-meta"><span class="reg-mdate">${fmtDate(t.date)} ·</span>
        ${k ? `<span class="chip">${esc(k.name)}</span>` : '<span class="chip warn">Not sorted</span>'}
        <span class="chip ${side === 'business' ? 'biz' : 'per'}">${side === 'business' ? 'Business' : 'Personal'}</span>
        ${t.job ? `<span class="chip job">${esc(t.job)}</span>` : ''}
        ${t.check_no ? `<span>Check ${esc(t.check_no)}</span>` : ''}
        ${t.flagged ? '<span class="chip bad">Flagged</span>' : ''}
        <span class="reg-desc">${esc(acct(t.account_id)?.name || '')}</span></span>
      <span class="reg-amt num${c > 0 ? ' in' : ''}">${fmtSigned(c)}</span>
    </li>`;
  }

  function renderRegister() {
    const box = $('#reg');
    if (!box) return;
    const rows = filtered();
    let tin = 0, tout = 0;
    for (const t of rows) { const c = cents(t.amount); if (c > 0) tin += c; else tout -= c; }
    for (const id of [...S.sel]) if (!rows.some(t => t.id === id)) S.sel.delete(id);
    const shown = rows.slice(0, S.showN);
    const bulk = S.sel.size ? `<div class="bulk">
        <strong>${S.sel.size} selected</strong>
        <select id="b-cat" aria-label="Category for selected lines">${catOptions('', { blank: 'Category: leave as is' })}</select>
        <select id="b-side" aria-label="Business or personal for selected lines"><option value="">Side: leave as is</option><option value="business">Business</option><option value="personal">Personal</option></select>
        <input type="text" id="b-job" placeholder="Job #" aria-label="Job number for selected lines" autocomplete="off">
        <label class="check small"><input type="checkbox" id="b-rev">Mark checked</label>
        <button class="btn primary small" type="button" data-act="bulk-apply">Apply</button>
        <button class="btn ghost small" type="button" data-act="bulk-clear">Clear</button>
      </div>` : '';
    box.innerHTML = `<div class="sheet-head"><div class="totals">
        <span>${rows.length} line${rows.length === 1 ? '' : 's'}</span>
        <span>In <b class="in">${fmt(tin)}</b></span><span>Out <b>${fmt(tout)}</b></span><span>Net <b>${fmtSigned(tin - tout)}</b></span></div>
        ${shown.length ? '<button class="btn small ghost" type="button" data-act="pick-all">Select all shown</button>' : ''}</div>
      ${bulk}
      ${shown.length ? `<div class="reg-head label"><span></span><span>Date</span><span>Paid to or from</span><span>Sorted as</span><span class="r">Amount</span></div>
        <ul class="register">${shown.map(t => regRow(t, true)).join('')}</ul>`
        : `<div class="empty"><h3>Nothing matches</h3><p>${S.tx.length ? 'Try clearing the filters or picking another year.' : 'No lines for ' + S.year + ' yet. Upload a statement and tell Claude it’s there.'}</p></div>`}
      ${rows.length > shown.length ? `<div class="sheet-foot"><button class="btn" type="button" data-act="more-rows">Show ${Math.min(200, rows.length - shown.length)} more</button><span class="muted small">${rows.length - shown.length} not shown</span></div>` : ''}`;
  }

  // ---------------------------------------------------------------- line editor
  const dlg = () => $('#dlg');
  function openDialog(html, onSubmit) {
    const d = dlg();
    d.innerHTML = html;
    const form = d.querySelector('form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (e.submitter && e.submitter.value === 'cancel') { d.close(); return; }
      const btn = form.querySelector('button[type="submit"]:not([value="cancel"])');
      if (btn) btn.disabled = true;
      try { await onSubmit(form, e.submitter); } catch (err) { fail(err); } finally { if (btn) btn.disabled = false; }
    });
    d.showModal();
    const first = d.querySelector('[autofocus]');
    if (first) first.focus();
  }
  const closeDialog = () => dlg().close();

  function datalists() {
    const payees = new Set(S.payees.map(p => p.name));
    S.tx.forEach(t => { if (t.payee) payees.add(t.payee); });
    const jobs = new Set();
    S.tx.forEach(t => { if (t.job) jobs.add(t.job); });
    return `<datalist id="dl-payee">${[...payees].sort().slice(0, 500).map(p => `<option value="${esc(p)}"></option>`).join('')}</datalist>
      <datalist id="dl-job">${[...jobs].sort((a, b) => jobSort(b) - jobSort(a)).map(j => `<option value="${esc(j)}"></option>`).join('')}</datalist>`;
  }

  function openTx(id) {
    const t = id ? S.tx.find(x => x.id === id) : null;
    const isNew = !t;
    const editable = isNew || t.source === 'manual';
    const c = t ? cents(t.amount) : 0;
    const side = t ? effSide(t) : (acct(S.f.account)?.side || 'business');
    const sameCount = t ? S.tx.filter(x => x.id !== t.id && !x.category_id && payeeKey(whoOf(x)) === payeeKey(whoOf(t))).length : 0;
    const bankBox = editable ? `
        <label class="field"><span>Account</span><select id="tx-account" required>${acctOptions(t?.account_id || S.f.account || '', S.accounts.length > 1 ? 'Pick an account' : null)}</select></label>
        <div class="row">
          <label class="field"><span>Date</span><input type="date" id="tx-date" required value="${esc(t?.date || today())}"></label>
          <label class="field"><span>Amount</span><input type="text" id="tx-amount" inputmode="decimal" required placeholder="0.00" value="${t ? (Math.abs(c) / 100).toFixed(2) : ''}"></label>
        </div>
        <div class="seg" role="radiogroup" aria-label="Money in or out">
          <label><input type="radio" name="tx-dir" value="out"${c <= 0 ? ' checked' : ''}><span>Money out</span></label>
          <label><input type="radio" name="tx-dir" value="in"${c > 0 ? ' checked' : ''}><span>Money in</span></label>
        </div>`
      : `<div class="readonly"><strong>From the bank:</strong> ${fmtDate(t.date, true)} · ${esc(acct(t.account_id)?.name || '')} · <span class="num">${fmtSigned(c)}</span><br>${esc(t.description || '')}</div>`;
    openDialog(`<form id="tx-form" novalidate>
      <div class="dlg-head"><h2>${isNew ? 'Add a line' : 'Line details'}</h2><button class="btn ghost small" type="submit" value="cancel" formnovalidate>Close</button></div>
      <div class="dlg-body">
        ${bankBox}
        <label class="field"><span>Paid to or from</span><input type="text" id="tx-payee" list="dl-payee" autocomplete="off" value="${esc(t?.payee || '')}" placeholder="${esc(t?.description || 'Who got the money, or who paid you')}"></label>
        <label class="field"><span>Category</span><select id="tx-cat">${catOptions(t?.category_id || '')}</select></label>
        ${sameCount ? `<label class="check small"><input type="checkbox" id="tx-same">Also sort the ${sameCount} other unsorted line${sameCount === 1 ? '' : 's'} from this payee the same way</label>` : ''}
        <div class="field"><span>Business or personal</span><div class="seg" role="radiogroup" aria-label="Business or personal">
          <label><input type="radio" name="tx-side" value="business"${side === 'business' ? ' checked' : ''}><span>Business</span></label>
          <label><input type="radio" name="tx-side" value="personal"${side === 'personal' ? ' checked' : ''}><span>Personal</span></label></div></div>
        <div class="row">
          <label class="field"><span>Job #</span><input type="text" id="tx-job" list="dl-job" autocomplete="off" placeholder="BB-152" value="${esc(t?.job || '')}"></label>
          <label class="field"><span>Check #</span><input type="text" id="tx-check" inputmode="numeric" autocomplete="off" value="${esc(t?.check_no || '')}"></label>
        </div>
        <label class="field"><span>Note</span><textarea id="tx-memo" rows="2">${esc(t?.memo || '')}</textarea></label>
        <label class="check"><input type="checkbox" id="tx-reviewed"${t?.reviewed ? ' checked' : ''}>I checked this line</label>
        <label class="check"><input type="checkbox" id="tx-flagged"${t?.flagged ? ' checked' : ''}>Flag it to look into</label>
        <label class="field" id="tx-flagnote-wrap"${t?.flagged ? '' : ' hidden'}><span>What's wrong?</span><input type="text" id="tx-flagnote" value="${esc(t?.flag_note || '')}"></label>
        <p class="note bad" id="tx-err" hidden></p>
        <div id="tx-confirm" class="confirm" hidden><span>Delete this line for good?</span>
          <div class="row"><button class="btn danger small" type="button" data-act="tx-delete-yes" data-id="${t?.id || ''}">Yes, delete it</button><button class="btn small" type="button" data-act="tx-delete-no">Keep it</button></div></div>
      </div>
      <div class="dlg-foot">
        ${!isNew && editable ? '<button class="btn danger left" type="button" data-act="tx-delete">Delete</button>' : ''}
        <button class="btn" type="submit" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" type="submit" value="save">Save</button>
      </div>
      ${datalists()}
    </form>`, form => saveTx(form, t, editable));
  }

  async function saveTx(form, t, editable) {
    const err = form.querySelector('#tx-err');
    const show = m => { err.textContent = m; err.hidden = false; };
    const patch = {
      payee: form.querySelector('#tx-payee').value.trim() || null,
      category_id: form.querySelector('#tx-cat').value || null,
      side: form.querySelector('input[name="tx-side"]:checked')?.value || null,
      job: normJob(form.querySelector('#tx-job').value),
      check_no: form.querySelector('#tx-check').value.trim() || null,
      memo: form.querySelector('#tx-memo').value.trim() || null,
      reviewed: form.querySelector('#tx-reviewed').checked,
      flagged: form.querySelector('#tx-flagged').checked,
      flag_note: form.querySelector('#tx-flagged').checked ? (form.querySelector('#tx-flagnote').value.trim() || null) : null,
    };
    if (editable) {
      const account_id = form.querySelector('#tx-account').value;
      const date = form.querySelector('#tx-date').value;
      const amt = parseAmount(form.querySelector('#tx-amount').value);
      const dir = form.querySelector('input[name="tx-dir"]:checked')?.value;
      if (!account_id) return show('Pick the account this money went through.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return show('Put in the date.');
      if (!amt) return show('Put in the amount, like 1250.00');
      Object.assign(patch, { account_id, date, amount: (dir === 'in' ? amt : -amt) / 100 });
      if (!t) patch.source = 'manual';
    }
    let saved;
    if (t) saved = await q(sb.from('transactions').update(patch).eq('id', t.id).select().single());
    else saved = await q(sb.from('transactions').insert(patch).select().single());
    const same = form.querySelector('#tx-same');
    let extra = 0;
    if (t && same && same.checked && patch.category_id) {
      const ids = S.tx.filter(x => x.id !== t.id && !x.category_id && payeeKey(whoOf(x)) === payeeKey(whoOf(t))).map(x => x.id);
      if (ids.length) {
        const rows = await q(sb.from('transactions').update({ category_id: patch.category_id, side: patch.side, payee: patch.payee }).in('id', ids).select());
        rows.forEach(upsertLocal);
        extra = rows.length;
      }
    }
    upsertLocal(saved);
    closeDialog();
    await refreshBalances();
    render();
    toast(extra ? `Saved, plus ${extra} more` : 'Saved');
  }
  function upsertLocal(row) {
    const inYear = row.date.slice(0, 4) === String(S.year);
    const i = S.tx.findIndex(x => x.id === row.id);
    if (i >= 0) { if (inYear) S.tx[i] = row; else S.tx.splice(i, 1); }
    else if (inYear) S.tx.unshift(row);
    S.tx.sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
  }
  async function refreshBalances() {
    try {
      const bal = await q(sb.from('account_balances').select('*'));
      S.bal = new Map(bal.map(b => [b.account_id, b]));
    } catch (err) { console.error(err); }
  }

  async function bulkApply() {
    const patch = {};
    const c = $('#b-cat').value, s = $('#b-side').value, j = normJob($('#b-job').value);
    if (c) patch.category_id = c;
    if (s) patch.side = s;
    if (j) patch.job = j;
    if ($('#b-rev').checked) patch.reviewed = true;
    if (!Object.keys(patch).length) { toast('Pick what to change first.'); return; }
    const ids = [...S.sel];
    const rows = [];
    for (let i = 0; i < ids.length; i += 100) {
      rows.push(...await q(sb.from('transactions').update(patch).in('id', ids.slice(i, i + 100)).select()));
    }
    rows.forEach(upsertLocal);
    S.sel.clear();
    render();
    toast(`Changed ${rows.length} line${rows.length === 1 ? '' : 's'}`);
  }

  // ---------------------------------------------------------------- downloads
  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(name, rows) {
    const text = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function downloadLines() {
    const rows = [['Date', 'Account', 'Paid to or from', 'Bank description', 'Category', 'Business or personal', 'Job', 'Check #', 'Note', 'Amount', 'Checked', 'Flagged']];
    for (const t of filtered()) {
      rows.push([t.date, acct(t.account_id)?.name || '', t.payee || '', t.description || '', cat(t.category_id)?.name || '', effSide(t),
        t.job || '', t.check_no || '', t.memo || '', Number(t.amount).toFixed(2), t.reviewed ? 'yes' : '', t.flagged ? (t.flag_note || 'yes') : '']);
    }
    download(`EDP Books lines ${S.year}${S.f.month ? '-' + S.f.month : ''}.csv`, rows);
  }

  // ---------------------------------------------------------------- statements
  function viewStatements() {
    const prev = new Date(); prev.setDate(1); prev.setMonth(prev.getMonth() - 1);
    const defMonth = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`;
    const upload = S.accounts.length ? `<section class="sheet">
      <div class="sheet-head"><h2>Upload statements</h2></div>
      <form id="up-form" class="sheet-body" novalidate>
        <div class="row">
          <label class="field"><span>Account</span><select id="up-account" required>${acctOptions('', S.accounts.length > 1 ? 'Pick an account' : null)}</select></label>
          <label class="field"><span>Statement month</span><input type="month" id="up-month" value="${defMonth}" required></label>
        </div>
        <label class="field"><span>Files</span><input type="file" id="up-files" multiple accept=".pdf,.csv,.xlsx,.xls,.qfx,.ofx,.qbo,.txt,.jpg,.jpeg,.png,.heic,application/pdf,text/csv,image/*">
          <small>PDF statements or the bank’s download file. Photos of paper statements work too.</small></label>
        <p class="note bad" id="up-err" hidden></p>
        <div class="row"><button class="btn primary" type="submit">${icon('upload')}Upload</button><span class="muted small" id="up-status"></span></div>
      </form>
    </section>` : `<section class="sheet"><div class="empty"><h3>Add an account first</h3><p>Statements are filed under an account, like “Chase Business”.</p><button class="btn primary" type="button" data-act="acct-new">Add an account</button></div></section>`;

    const rows = S.statements.map(s => {
      const chk = S.stmtCheck.get(s.id);
      let status;
      if (s.status === 'uploaded') status = '<span class="chip warn">Waiting for Claude</span>';
      else if (s.status === 'problem') status = '<span class="chip bad">Problem</span>';
      else if (s.end_balance == null || s.start_balance == null || !s.period_start) status = '<span class="chip">Loaded</span>';
      else {
        const diff = cents(s.end_balance) - cents(chk?.computed_end);
        status = diff === 0 ? '<span class="chip good">Balances ✓</span>' : `<span class="chip bad">Off by ${fmt(Math.abs(diff))}</span>`;
      }
      const period = s.period_start && s.period_end ? `${fmtDate(s.period_start, true)} to ${fmtDate(s.period_end, true)}` : `Uploaded ${fmtDate(s.uploaded_at.slice(0, 10), true)}`;
      return `<div class="acct">
        <div><div class="acct-name">${esc(s.label || 'Statement')}</div>
          <div class="acct-meta">${status}<span>${period}</span>${chk && s.status === 'loaded' ? `<span>${chk.lines} lines</span>` : ''}</div>
          ${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ''}</div>
        <div class="stmt-side">${s.end_balance != null ? `<div class="num">${fmt(cents(s.end_balance))}</div><div class="small muted">ending</div>` : ''}
          ${s.file_path ? `<button class="btn small" type="button" data-act="stmt-open" data-id="${s.id}">Open</button>` : ''}</div>
      </div>`;
    }).join('');
    const list = `<section class="sheet">
      <div class="sheet-head"><h2>Your statements</h2></div>
      ${S.statements.length ? rows : '<div class="empty"><p>Nothing uploaded yet.</p></div>'}
    </section>`;
    const tip = '<div class="note good">After you upload, tell Claude “statements are in”. Claude reads each one, enters every line, and checks that the ending balance matches.</div>';
    return upload + tip + list;
  }

  async function uploadStatements(form) {
    const err = form.querySelector('#up-err');
    const status = form.querySelector('#up-status');
    err.hidden = true;
    const account_id = form.querySelector('#up-account').value;
    const month = form.querySelector('#up-month').value;
    const files = [...form.querySelector('#up-files').files];
    const show = m => { err.textContent = m; err.hidden = false; };
    if (!account_id) return show('Pick which account these statements are for.');
    if (!/^\d{4}-\d{2}$/.test(month)) return show('Pick the statement month.');
    if (!files.length) return show('Choose at least one file.');
    const big = files.find(f => f.size > 25 * 1024 * 1024);
    if (big) return show(`${big.name} is over 25 MB. Ask Claude for help with that one.`);
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    let done = 0;
    try {
      for (const file of files) {
        status.textContent = `Uploading ${done + 1} of ${files.length}…`;
        const ext = ((file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)) || 'file';
        const path = `${S.user.id}/${crypto.randomUUID()}.${ext}`;
        const up = await sb.storage.from('statements').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (up.error) throw up.error;
        const label = `${acct(account_id)?.name || 'Account'} · ${monthLabel(month)}${files.length > 1 ? ` (${done + 1} of ${files.length})` : ''}`;
        const row = await q(sb.from('statements').insert({ account_id, label, file_path: path, file_type: ext, status: 'uploaded' }).select().single());
        S.statements.unshift(row);
        done++;
      }
      render();
      toast(`Uploaded ${done}. Tell Claude “statements are in”.`);
    } catch (e) {
      status.textContent = done ? `${done} uploaded before the problem.` : '';
      show(friendly(e));
      btn.disabled = false;
    }
  }

  async function openStatement(id) {
    const s = S.statements.find(x => x.id === id);
    if (!s) return;
    const w = window.open('', '_blank');
    try {
      const { data, error } = await sb.storage.from('statements').createSignedUrl(s.file_path, 600);
      if (error) throw error;
      if (w) { w.opener = null; w.location.href = data.signedUrl; } else location.href = data.signedUrl;
    } catch (err) { if (w) w.close(); fail(err); }
  }

  // ---------------------------------------------------------------- reports
  const REPORTS = [['pl', 'Profit and loss'], ['cats', 'Categories'], ['jobs', 'Jobs'], ['contractors', 'Contractors'], ['months', 'Months']];
  function reportLines() {
    const m = S.reportMonth;
    return m ? S.tx.filter(t => t.date.slice(5, 7) === m) : S.tx;
  }
  const periodName = () => S.reportMonth ? `${MONTHS_LONG[Number(S.reportMonth) - 1]} ${S.year}` : String(S.year);

  function viewReports() {
    const tabs = `<div class="subtabs" role="group" aria-label="Report">${REPORTS.map(([k, n]) =>
      `<button type="button" data-act="report" data-report="${k}" aria-pressed="${S.report === k}">${n}</button>`).join('')}</div>`;
    const monthSel = S.report === 'months' ? '' : `<label class="field"><span>Period</span><select id="r-month">
      <option value="">All of ${S.year}</option>${MONTHS_LONG.map((mm, i) => `<option value="${pad(i + 1)}"${S.reportMonth === pad(i + 1) ? ' selected' : ''}>${mm} ${S.year}</option>`).join('')}</select></label>`;
    const sideSel = S.report === 'cats' ? `<label class="field"><span>Side</span><select id="r-side">
      <option value="business"${S.reportSide === 'business' ? ' selected' : ''}>Business</option>
      <option value="personal"${S.reportSide === 'personal' ? ' selected' : ''}>Personal</option>
      <option value="all"${S.reportSide === 'all' ? ' selected' : ''}>Both</option></select></label>` : '';
    const body = { pl: reportPL, cats: reportCats, jobs: reportJobs, contractors: reportContractors, months: reportMonths }[S.report]();
    return `<section class="sheet"><div class="sheet-body">${tabs}
      <div class="row">${monthSel}${sideSel}</div>
      <div class="row"><button class="btn" type="button" data-act="report-csv">${icon('down')}Download this report</button></div></div></section>
      <section class="sheet">${body.html}</section>`;
  }
  let lastReportRows = [];
  const tableRow = (cells, cls = '', attrs = '') => `<tr class="${cls}" ${attrs}>${cells.map(([v, c]) => `<td class="${c || ''}">${v}</td>`).join('')}</tr>`;

  function reportPL() {
    const lines = reportLines().filter(t => effSide(t) === 'business' && !isTransfer(t));
    const byCat = new Map();
    let unIn = 0, unOut = 0, unN = 0;
    for (const t of lines) {
      const c = cents(t.amount);
      if (!t.category_id) { unN++; if (c > 0) unIn += c; else unOut -= c; continue; }
      byCat.set(t.category_id, (byCat.get(t.category_id) || 0) + c);
    }
    const inc = [], exp = [];
    for (const [id, sum] of byCat) {
      const k = cat(id);
      if (k.kind === 'income') inc.push([k, sum]); else exp.push([k, -sum]);
    }
    inc.sort((a, b) => a[0].sort - b[0].sort);
    exp.sort((a, b) => b[1] - a[1]);
    const totIn = inc.reduce((s, x) => s + x[1], 0) + unIn;
    const totOut = exp.reduce((s, x) => s + x[1], 0) + unOut;
    const csv = [['Section', 'Category', 'Tax group', 'Amount']];
    const r = (name, amt, act) => tableRow([[esc(name)], [`<span class="num">${fmt(amt)}</span>`, 'r']], act ? 'click' : '', act || '');
    let html = '';
    html += tableRow([['Money in'], ['']], 'section');
    inc.forEach(([k, v]) => { html += r(k.name, v, `data-act="go-cat" data-id="${k.id}"`); csv.push(['Money in', k.name, k.tax_group || '', (v / 100).toFixed(2)]); });
    if (unIn) { html += r(`Not sorted yet (money in)`, unIn, 'data-act="go-unsorted"'); csv.push(['Money in', 'Not sorted yet', '', (unIn / 100).toFixed(2)]); }
    html += tableRow([['Total money in'], [`<span class="num">${fmt(totIn)}</span>`, 'r']], 'total');
    html += tableRow([['Costs'], ['']], 'section');
    exp.forEach(([k, v]) => { html += r(k.name, v, `data-act="go-cat" data-id="${k.id}"`); csv.push(['Costs', k.name, k.tax_group || '', (v / 100).toFixed(2)]); });
    if (unOut) { html += r(`Not sorted yet (money out)`, unOut, 'data-act="go-unsorted"'); csv.push(['Costs', 'Not sorted yet', '', (unOut / 100).toFixed(2)]); }
    html += tableRow([['Total costs'], [`<span class="num">${fmt(totOut)}</span>`, 'r']], 'total');
    html += tableRow([['<strong>Profit</strong>'], [`<span class="num${totIn - totOut > 0 ? ' in' : ''}">${fmtSigned(totIn - totOut)}</span>`, 'r']], 'total');
    csv.push(['Profit', '', '', ((totIn - totOut) / 100).toFixed(2)]);
    lastReportRows = csv;
    return {
      html: `<div class="sheet-head"><h2>Business profit and loss, ${periodName()}</h2></div>
        ${unN ? `<div class="sheet-body"><div class="note">${unN} business line${unN === 1 ? ' is' : 's are'} not sorted yet, so these totals may shift. <a href="#money" data-act="go-unsorted">Sort them</a></div></div>` : ''}
        ${lines.length ? `<div class="table-wrap"><table><tbody>${html}</tbody></table></div>` : '<div class="empty"><p>No business lines in this period yet.</p></div>'}
        <div class="sheet-foot small muted">Transfers, card payments and owner draws are left out, since they aren’t income or costs.</div>`
    };
  }

  function reportCats() {
    const side = S.reportSide;
    const lines = reportLines().filter(t => side === 'all' || effSide(t) === side);
    const by = new Map();
    for (const t of lines) {
      const k = t.category_id || 'none';
      const e = by.get(k) || { in: 0, out: 0, n: 0 };
      const c = cents(t.amount);
      if (c > 0) e.in += c; else e.out -= c;
      e.n++;
      by.set(k, e);
    }
    const rows = [...by.entries()].map(([id, e]) => ({ id, k: cat(id), ...e }))
      .sort((a, b) => (b.in + b.out) - (a.in + a.out));
    const csv = [['Category', 'Kind', 'Money in', 'Money out', 'Lines']];
    const html = rows.map(r => {
      const name = r.k ? r.k.name : 'Not sorted yet';
      csv.push([name, r.k ? r.k.kind : '', (r.in / 100).toFixed(2), (r.out / 100).toFixed(2), r.n]);
      return tableRow([[esc(name) + (r.k?.kind === 'transfer' ? ' <span class="chip">transfer</span>' : '')],
        [`<span class="num in">${r.in ? fmt(r.in) : ''}</span>`, 'r'], [`<span class="num">${r.out ? fmt(r.out) : ''}</span>`, 'r'], [String(r.n), 'r']],
        'click', r.k ? `data-act="go-cat" data-id="${r.id}"` : 'data-act="go-unsorted"');
    }).join('');
    lastReportRows = csv;
    const sideName = side === 'all' ? 'Business and personal' : side === 'business' ? 'Business' : 'Personal';
    return {
      html: `<div class="sheet-head"><h2>${sideName} by category, ${periodName()}</h2></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Category</th><th class="r">Money in</th><th class="r">Money out</th><th class="r">Lines</th></tr></thead><tbody>${html}</tbody></table></div>`
          : '<div class="empty"><p>No lines in this period yet.</p></div>'}`
    };
  }

  function reportJobs() {
    const by = new Map();
    for (const t of reportLines()) {
      if (!t.job) continue;
      const e = by.get(t.job) || { in: 0, out: 0, n: 0, last: '' };
      const c = cents(t.amount);
      if (c > 0) e.in += c; else e.out -= c;
      e.n++;
      if (t.date > e.last) e.last = t.date;
      by.set(t.job, e);
    }
    const rows = [...by.entries()].sort((a, b) => a[0].slice(0, 2).localeCompare(b[0].slice(0, 2)) || jobSort(b[0]) - jobSort(a[0]));
    const csv = [['Job', 'Money in', 'Money out', 'Difference', 'Lines', 'Last line']];
    const html = rows.map(([job, e]) => {
      csv.push([job, (e.in / 100).toFixed(2), (e.out / 100).toFixed(2), ((e.in - e.out) / 100).toFixed(2), e.n, e.last]);
      return tableRow([[`<span class="chip job">${esc(job)}</span>`], [`<span class="num in">${e.in ? fmt(e.in) : ''}</span>`, 'r'],
        [`<span class="num">${e.out ? fmt(e.out) : ''}</span>`, 'r'], [`<span class="num">${fmtSigned(e.in - e.out)}</span>`, 'r'], [fmtDate(e.last, true), 'r']],
        'click', `data-act="go-job" data-job="${esc(job)}"`);
    }).join('');
    lastReportRows = csv;
    return {
      html: `<div class="sheet-head"><h2>Money by job, ${periodName()}</h2></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Job</th><th class="r">Money in</th><th class="r">Money out</th><th class="r">Difference</th><th class="r">Last line</th></tr></thead><tbody>${html}</tbody></table></div>`
          : '<div class="empty"><p>No lines have a job number yet. Add a job # to deposits and job costs to see them here.</p></div>'}
        <div class="sheet-foot small muted">Bank money only. What a customer still owes lives in JobNimbus. “+ supplement” jobs have no final price yet.</div>`
    };
  }

  function contractorRows() {
    const recs = new Map(S.payees.map(p => [payeeKey(p.name), p]));
    const sub = S.cats.find(c => c.name === 'Subcontractors and labor');
    const by = new Map();
    for (const t of S.tx) {
      const c = cents(t.amount);
      if (c >= 0 || isTransfer(t) || effSide(t) !== 'business') continue;
      const key = payeeKey(t.payee);
      if (!key) continue;
      const rec = recs.get(key);
      const isSub = sub && t.category_id === sub.id;
      if (!(rec && rec.is_contractor) && !isSub) continue;
      const e = by.get(key) || { name: t.payee, rec, paid: 0, n: 0 };
      e.paid -= c;
      e.n++;
      by.set(key, e);
    }
    for (const p of S.payees) if (p.is_contractor && !by.has(payeeKey(p.name))) by.set(payeeKey(p.name), { name: p.name, rec: p, paid: 0, n: 0 });
    return [...by.values()].sort((a, b) => b.paid - a.paid);
  }
  function reportContractors() {
    const cutoff = prefs.get('cutoff-' + S.year, S.year >= 2026 ? 2000 : 600) * 100;
    const rows = contractorRows();
    const csv = [['Contractor', 'Paid in ' + S.year, 'Lines', 'Marked contractor', 'W-9 on file']];
    const html = rows.map(r => {
      const on = !!r.rec?.is_contractor, w9 = !!r.rec?.w9_on_file;
      csv.push([r.name, (r.paid / 100).toFixed(2), r.n, on ? 'yes' : '', w9 ? 'yes' : '']);
      return `<tr><td><strong>${esc(r.name)}</strong>${r.paid >= cutoff ? ' <span class="chip warn">Over cutoff</span>' : ''}${!w9 && r.paid >= cutoff ? ' <span class="chip bad">Needs W-9</span>' : ''}</td>
        <td class="r"><span class="num">${fmt(r.paid)}</span></td><td class="r">${r.n}</td>
        <td><label class="check small"><input type="checkbox" data-act="payee-flag" data-field="is_contractor" data-name="${esc(r.name)}"${on ? ' checked' : ''}>Contractor</label></td>
        <td><label class="check small"><input type="checkbox" data-act="payee-flag" data-field="w9_on_file" data-name="${esc(r.name)}"${w9 ? ' checked' : ''}>W-9</label></td></tr>`;
    }).join('');
    lastReportRows = csv;
    return {
      html: `<div class="sheet-head"><h2>Contractors paid in ${S.year}</h2></div>
        <div class="sheet-body"><div class="row"><label class="field"><span>1099 cutoff for ${S.year}</span><input type="number" id="r-cutoff" min="0" step="1" value="${cutoff / 100}"></label></div>
        <p class="small muted">The IRS cutoff for sending a 1099 changed starting with 2026. Check the right amount with your tax preparer. Anyone paid under “Subcontractors and labor” shows up here. Tick “Contractor” to add others.</p></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Contractor</th><th class="r">Paid</th><th class="r">Lines</th><th>Contractor</th><th>W-9 on file</th></tr></thead><tbody>${html}</tbody></table></div>`
          : '<div class="empty"><p>No contractor payments yet. Sort a payment as “Subcontractors and labor” and it shows up here.</p></div>'}`
    };
  }

  function reportMonths() {
    const b = monthTotals('business'), p = monthTotals('personal');
    const csv = [['Month', 'Business in', 'Business out', 'Business profit', 'Personal in', 'Personal out']];
    let tot = [0, 0, 0, 0];
    const html = b.map((m, i) => {
      tot = [tot[0] + m.in, tot[1] + m.out, tot[2] + p[i].in, tot[3] + p[i].out];
      csv.push([MONTHS_LONG[i], (m.in / 100).toFixed(2), (m.out / 100).toFixed(2), ((m.in - m.out) / 100).toFixed(2), (p[i].in / 100).toFixed(2), (p[i].out / 100).toFixed(2)]);
      return tableRow([[MONTHS_LONG[i]], [`<span class="num in">${fmt(m.in)}</span>`, 'r'], [`<span class="num">${fmt(m.out)}</span>`, 'r'],
        [`<span class="num">${fmtSigned(m.in - m.out)}</span>`, 'r'], [`<span class="num">${fmt(p[i].in)}</span>`, 'r'], [`<span class="num">${fmt(p[i].out)}</span>`, 'r']]);
    }).join('') + tableRow([['Total'], [`<span class="num in">${fmt(tot[0])}</span>`, 'r'], [`<span class="num">${fmt(tot[1])}</span>`, 'r'],
      [`<span class="num">${fmtSigned(tot[0] - tot[1])}</span>`, 'r'], [`<span class="num">${fmt(tot[2])}</span>`, 'r'], [`<span class="num">${fmt(tot[3])}</span>`, 'r']], 'total');
    lastReportRows = csv;
    return {
      html: `<div class="sheet-head"><h2>Month by month, ${S.year}</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Month</th><th class="r">Business in</th><th class="r">Business out</th><th class="r">Business profit</th><th class="r">Personal in</th><th class="r">Personal out</th></tr></thead><tbody>${html}</tbody></table></div>
        <div class="sheet-foot small muted">Transfers between accounts and card payments are left out.</div>`
    };
  }

  // ---------------------------------------------------------------- red flags
  function viewFlags() {
    const a = autoFlags();
    const open = openFlags();
    const resolved = S.flags.filter(f => f.status !== 'open');
    const lineLink = t => `<div class="small">${fmtDate(t.date, true)} · ${esc(acct(t.account_id)?.name || '')} · <strong>${esc(whoOf(t))}</strong> · <span class="num">${fmtSigned(cents(t.amount))}</span></div>`;
    const fromClaude = `<section class="sheet"><div class="sheet-head"><h2>From Claude</h2><span class="muted small">Checks against JobNimbus and the paperwork</span></div>
      ${open.length ? open.map(f => {
        const t = f.transaction_id && S.tx.find(x => x.id === f.transaction_id);
        return `<div class="flag bad"><div class="flag-bar"></div><div class="flag-body"><div>${f.job ? `<span class="chip job">${esc(f.job)}</span> ` : ''}${esc(f.message)}</div>
          ${t ? lineLink(t) : ''}
          <div class="flag-actions">${t ? `<button class="btn small" type="button" data-act="tx-edit" data-id="${t.id}">Open the line</button>` : ''}
          <button class="btn small" type="button" data-act="flag-set" data-id="${f.id}" data-status="ok">Looks fine</button>
          <button class="btn small" type="button" data-act="flag-set" data-id="${f.id}" data-status="fixed">Fixed it</button></div></div></div>`;
      }).join('') : '<div class="empty"><p>Nothing from Claude right now.</p></div>'}
      ${resolved.length ? `<div class="sheet-foot"><button class="btn ghost small" type="button" data-act="flags-resolved">${S.showResolved ? 'Hide' : 'Show'} ${resolved.length} already handled</button></div>` : ''}
      ${S.showResolved ? resolved.map(f => `<div class="flag"><div class="flag-bar"></div><div class="flag-body"><div class="muted">${f.job ? esc(f.job) + ' · ' : ''}${esc(f.message)}</div><div class="small muted">${f.status === 'ok' ? 'Looked fine' : 'Fixed'}</div></div></div>`).join('') : ''}
    </section>`;

    const group = (title, why, items, renderItem) => `<section class="sheet"><div class="sheet-head"><h2>${title}</h2><span class="chip ${items.length ? 'bad' : 'good'}">${items.length || 'None'}</span></div>
      ${items.length ? `<div class="sheet-body small muted">${why}</div>` + items.slice(0, 25).map(renderItem).join('') +
        (items.length > 25 ? `<div class="sheet-foot small muted">Showing 25 of ${items.length}.</div>` : '') : ''}</section>`;
    const lineItem = t => `<div class="flag"><div class="flag-bar"></div><div class="flag-body">${lineLink(t)}
      <div class="flag-actions"><button class="btn small" type="button" data-act="tx-edit" data-id="${t.id}">Open</button>
      <button class="btn small" type="button" data-act="tx-ok" data-ids="${t.id}">Looks fine</button></div></div></div>`;

    return `${a.unsorted ? `<div class="note">${a.unsorted} line${a.unsorted === 1 ? ' is' : 's are'} not sorted into a category yet. <a href="#money" data-act="go-unsorted">Sort them</a></div>` : ''}
      ${fromClaude}
      ${group('Possible double charges', 'Same account, same amount, same payee, within 3 days.', a.dup, ([x, y]) => `<div class="flag bad"><div class="flag-bar"></div><div class="flag-body">${lineLink(x)}${lineLink(y)}
        <div class="flag-actions"><button class="btn small" type="button" data-act="tx-edit" data-id="${x.id}">Open first</button><button class="btn small" type="button" data-act="tx-edit" data-id="${y.id}">Open second</button>
        <button class="btn small" type="button" data-act="tx-ok" data-ids="${x.id},${y.id}">Both are real</button></div></div></div>`)}
      ${group('Big payments with no job', `Business money out of ${fmt(bigLimit())} or more that isn’t tied to a job. Add the job #, or mark it fine. Change the amount in Settings.`, a.big, lineItem)}
      ${group('Checks with no job or category', 'Every check out should match a job or a bill.', a.checks, lineItem)}
      ${group('Customer money with no job number', 'Business deposits that aren’t tied to a BB job yet.', a.deposits, lineItem)}`;
  }

  // ---------------------------------------------------------------- accounts
  function viewAccounts() {
    const part = side => {
      const list = S.accounts.filter(a => a.side === side);
      return list.length ? `<section class="sheet"><div class="sheet-head"><h2>${side === 'business' ? 'Business' : 'Personal'}</h2></div>
        ${list.map(a => acctRow(a, true)).join('')}</section>` : '';
    };
    return `<div class="row"><button class="btn primary" type="button" data-act="acct-new">${icon('plus')}Add an account</button></div>
      ${S.accounts.length ? part('business') + part('personal') : '<section class="sheet"><div class="empty"><h3>No accounts yet</h3><p>Add each bank account and card by a nickname, like “Chase Business” or “Amex personal”. Never type the account number.</p></div></section>'}`;
  }

  function openAccount(id) {
    const a = id ? S.accounts.find(x => x.id === id) : null;
    const debt = a && isDebtKind(a.kind);
    const ob = a ? (debt ? -cents(a.opening_balance) : cents(a.opening_balance)) : 0;
    const kinds = ['checking', 'savings', 'credit card', 'loan', 'cash', 'other'];
    openDialog(`<form id="acct-form" novalidate>
      <div class="dlg-head"><h2>${a ? 'Edit account' : 'Add an account'}</h2><button class="btn ghost small" type="submit" value="cancel" formnovalidate>Close</button></div>
      <div class="dlg-body">
        <label class="field"><span>Nickname</span><input type="text" id="ac-name" required autofocus autocomplete="off" value="${esc(a?.name || '')}" placeholder="Chase Business"><small>Never the account number.</small></label>
        <div class="row">
          <label class="field"><span>Bank</span><input type="text" id="ac-bank" autocomplete="off" value="${esc(a?.bank || '')}" placeholder="Chase"></label>
          <label class="field"><span>Type</span><select id="ac-kind">${kinds.map(k => `<option value="${k}"${(a?.kind || 'checking') === k ? ' selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select></label>
        </div>
        <div class="field"><span>Business or personal</span><div class="seg" role="radiogroup" aria-label="Business or personal">
          <label><input type="radio" name="ac-side" value="business"${(a?.side || 'business') === 'business' ? ' checked' : ''}><span>Business</span></label>
          <label><input type="radio" name="ac-side" value="personal"${a?.side === 'personal' ? ' checked' : ''}><span>Personal</span></label></div></div>
        <div class="row">
          <label class="field"><span id="ac-ob-label">${debt ? 'Owed at the start' : 'Starting balance'}</span><input type="text" id="ac-ob" inputmode="decimal" value="${a ? (ob / 100).toFixed(2) : ''}" placeholder="0.00"></label>
          <label class="field"><span>As of</span><input type="date" id="ac-od" value="${esc(a?.opening_date || '')}"></label>
        </div>
        <p class="small muted">The balance on the first statement you’ll upload. Claude can fill this in for you.</p>
        ${a ? `<label class="check"><input type="checkbox" id="ac-active"${a.active ? ' checked' : ''}>Still in use</label>` : ''}
        <label class="field"><span>Note</span><input type="text" id="ac-notes" value="${esc(a?.notes || '')}"></label>
        <p class="note bad" id="ac-err" hidden></p>
      </div>
      <div class="dlg-foot"><button class="btn" type="submit" value="cancel" formnovalidate>Cancel</button><button class="btn primary" type="submit" value="save">Save</button></div>
    </form>`, async form => {
      const err = form.querySelector('#ac-err');
      const name = form.querySelector('#ac-name').value.trim();
      const kind = form.querySelector('#ac-kind').value;
      const obRaw = form.querySelector('#ac-ob').value.trim();
      const neg = /^\s*[-−(]/.test(obRaw);
      let obc = obRaw ? parseAmount(obRaw) : 0;
      if (Number.isNaN(obc)) { err.textContent = 'The starting balance should be a number, like 4250.00'; err.hidden = false; return; }
      if (neg) obc = -obc;
      if (!name) { err.textContent = 'Give the account a nickname.'; err.hidden = false; return; }
      if (/\d{5,}/.test(name.replace(/[\s-]/g, ''))) { err.textContent = 'That looks like an account number. Use a nickname, like “Chase Business”.'; err.hidden = false; return; }
      const row = {
        name, kind,
        bank: form.querySelector('#ac-bank').value.trim() || null,
        side: form.querySelector('input[name="ac-side"]:checked').value,
        opening_balance: (isDebtKind(kind) ? -obc : obc) / 100,
        opening_date: form.querySelector('#ac-od').value || null,
        notes: form.querySelector('#ac-notes').value.trim() || null,
      };
      const act = form.querySelector('#ac-active');
      if (act) row.active = act.checked;
      if (a) await q(sb.from('accounts').update(row).eq('id', a.id));
      else await q(sb.from('accounts').insert(row));
      closeDialog();
      await loadBase();
      render();
      toast('Account saved');
    });
    const kindSel = dlg().querySelector('#ac-kind');
    kindSel.addEventListener('change', () => {
      dlg().querySelector('#ac-ob-label').textContent = isDebtKind(kindSel.value) ? 'Owed at the start' : 'Starting balance';
    });
  }

  // ---------------------------------------------------------------- settings and more
  function viewSettings() {
    const groups = [['income', 'business', 'Business money in'], ['expense', 'business', 'Business costs'], ['income', 'personal', 'Personal money in'], ['expense', 'personal', 'Personal spending'], ['transfer', 'both', 'Transfers']];
    const used = new Map();
    S.tx.forEach(t => { if (t.category_id) used.set(t.category_id, (used.get(t.category_id) || 0) + 1); });
    const cats = groups.map(([kind, side, title]) => {
      const list = S.cats.filter(c => c.kind === kind && (c.side === side || (kind === 'transfer')));
      if (!list.length) return '';
      return tableRow([[title], [''], ['']], 'section') + list.map(c => tableRow([
        [`${esc(c.name)}${c.active ? '' : ' <span class="chip">hidden</span>'}${c.tax_group ? `<div class="small muted">Tax: ${esc(c.tax_group)}</div>` : ''}`],
        [String(used.get(c.id) || ''), 'r'],
        [`<button class="btn small" type="button" data-act="cat-edit" data-id="${c.id}">Edit</button>`, 'r']])).join('');
    }).join('');
    return `<section class="sheet"><div class="sheet-head"><h2>Categories</h2><button class="btn small primary" type="button" data-act="cat-new">${icon('plus')}Add</button></div>
        <div class="table-wrap"><table><thead><tr><th>Category</th><th class="r">Lines in ${S.year}</th><th></th></tr></thead><tbody>${cats}</tbody></table></div></section>
      <section class="sheet"><div class="sheet-head"><h2>Alerts</h2></div><div class="sheet-body">
        <label class="field"><span>Flag business payments with no job number from this amount up</span><input type="number" id="s-big" min="0" step="50" value="${bigLimit() / 100}"></label></div></section>
      <section class="sheet"><div class="sheet-head"><h2>Your login</h2></div>
        <form id="pw-form" class="sheet-body" novalidate>
          <p>Signed in as <strong>${esc(S.user?.email || '')}</strong></p>
          <div class="row"><label class="field"><span>New password</span><input type="password" id="pw-1" autocomplete="new-password" minlength="10"></label>
          <label class="field"><span>Same password again</span><input type="password" id="pw-2" autocomplete="new-password"></label></div>
          <p class="note bad" id="pw-err" hidden></p>
          <div class="row"><button class="btn" type="submit">Change password</button><button class="btn danger" type="button" data-act="signout">Sign out</button></div>
        </form></section>
      <section class="sheet"><div class="sheet-head"><h2>Put it on your phone</h2></div><div class="sheet-body small">
        <p><strong>iPhone:</strong> open this page in Safari, tap the Share button, then “Add to Home Screen”.</p>
        <p><strong>Android:</strong> open it in Chrome, tap the ⋮ menu, then “Add to Home screen”.</p></div></section>`;
  }

  function openCategory(id) {
    const c = id ? S.cats.find(x => x.id === id) : null;
    openDialog(`<form id="cat-form" novalidate>
      <div class="dlg-head"><h2>${c ? 'Edit category' : 'Add a category'}</h2><button class="btn ghost small" type="submit" value="cancel" formnovalidate>Close</button></div>
      <div class="dlg-body">
        <label class="field"><span>Name</span><input type="text" id="c-name" required autofocus value="${esc(c?.name || '')}"></label>
        <div class="row">
          <label class="field"><span>Kind</span><select id="c-kind">
            <option value="expense"${c?.kind === 'expense' ? ' selected' : ''}>Cost or spending</option>
            <option value="income"${c?.kind === 'income' ? ' selected' : ''}>Money in</option>
            <option value="transfer"${c?.kind === 'transfer' ? ' selected' : ''}>Transfer (not income or cost)</option></select></label>
          <label class="field"><span>Side</span><select id="c-side">
            <option value="business"${c?.side === 'business' ? ' selected' : ''}>Business</option>
            <option value="personal"${c?.side === 'personal' ? ' selected' : ''}>Personal</option>
            <option value="both"${c?.side === 'both' ? ' selected' : ''}>Both</option></select></label>
        </div>
        <label class="field"><span>Tax group</span><input type="text" id="c-tax" value="${esc(c?.tax_group || '')}" placeholder="Optional, for your tax preparer"></label>
        ${c ? `<label class="check"><input type="checkbox" id="c-active"${c.active ? ' checked' : ''}>Show in the category lists</label>` : ''}
        <p class="note bad" id="c-err" hidden></p>
      </div>
      <div class="dlg-foot"><button class="btn" type="submit" value="cancel" formnovalidate>Cancel</button><button class="btn primary" type="submit" value="save">Save</button></div>
    </form>`, async form => {
      const name = form.querySelector('#c-name').value.trim();
      const err = form.querySelector('#c-err');
      if (!name) { err.textContent = 'Give the category a name.'; err.hidden = false; return; }
      const row = { name, kind: form.querySelector('#c-kind').value, side: form.querySelector('#c-side').value, tax_group: form.querySelector('#c-tax').value.trim() || null };
      const act = form.querySelector('#c-active');
      if (act) row.active = act.checked;
      const res = c ? await sb.from('categories').update(row).eq('id', c.id) : await sb.from('categories').insert(row);
      if (res.error) { err.textContent = /duplicate|unique/i.test(res.error.message) ? 'There is already a category with that name.' : friendly(res.error); err.hidden = false; return; }
      closeDialog();
      await loadBase();
      render();
      toast('Category saved');
    });
  }

  function viewMore() {
    const n = autoFlags().count + openFlags().length;
    return `<section class="sheet more-list">
      <a href="#flags">${icon('flag')}Red flags${n ? `<span class="badge">${n}</span>` : ''}</a>
      <a href="#accounts">${icon('bank')}Accounts</a>
      <a href="#statements">${icon('upload')}Statements</a>
      <a href="#settings">${icon('gear')}Settings</a>
      <a href="#signout" data-act="signout">${icon('out')}Sign out</a>
    </section>`;
  }

  async function setPayeeFlag(name, field, value) {
    const existing = S.payees.find(p => payeeKey(p.name) === payeeKey(name));
    let row;
    if (existing) row = await q(sb.from('payees').update({ [field]: value }).eq('id', existing.id).select().single());
    else row = await q(sb.from('payees').insert({ name, [field]: value }).select().single());
    S.payees = S.payees.filter(p => p.id !== row.id).concat(row);
    render();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    try {
      switch (act) {
        case 'pick': {
          e.stopPropagation();
          if (el.checked) S.sel.add(el.dataset.id); else S.sel.delete(el.dataset.id);
          renderRegister();
          return;
        }
        case 'pick-all': filtered().slice(0, S.showN).forEach(t => S.sel.add(t.id)); renderRegister(); return;
        case 'bulk-clear': S.sel.clear(); renderRegister(); return;
        case 'bulk-apply': await bulkApply(); return;
        case 'more-rows': S.showN += 200; renderRegister(); return;
        case 'tx-edit': openTx(el.dataset.id); return;
        case 'tx-new': openTx(null); return;
        case 'tx-csv': downloadLines(); return;
        case 'tx-delete': $('#tx-confirm').hidden = false; return;
        case 'tx-delete-no': $('#tx-confirm').hidden = true; return;
        case 'tx-delete-yes': {
          const id = el.dataset.id;
          await q(sb.from('transactions').delete().eq('id', id));
          S.tx = S.tx.filter(t => t.id !== id);
          closeDialog();
          await refreshBalances();
          render();
          toast('Deleted');
          return;
        }
        case 'tx-ok': {
          const ids = el.dataset.ids.split(',');
          const rows = await q(sb.from('transactions').update({ reviewed: true }).in('id', ids).select());
          rows.forEach(upsertLocal);
          render();
          toast('Marked as checked');
          return;
        }
        case 'f-clear': S.f = { q: '', account: '', month: '', side: '', cat: '', look: false }; S.showN = 200; render(); return;
        case 'refresh': await reload(); return;
        case 'signout': e.preventDefault(); await sb.auth.signOut(); return;
        case 'acct-new': openAccount(null); return;
        case 'acct-edit': openAccount(el.dataset.id); return;
        case 'cat-new': openCategory(null); return;
        case 'cat-edit': openCategory(el.dataset.id); return;
        case 'stmt-open': await openStatement(el.dataset.id); return;
        case 'report': S.report = el.dataset.report; if (route() === 'reports') render(); return;
        case 'report-csv': download(`EDP Books ${REPORTS.find(r => r[0] === S.report)[1]} ${periodName()}.csv`, lastReportRows); return;
        case 'go-cat': e.preventDefault(); S.f = { q: '', account: '', month: S.report === 'months' ? '' : S.reportMonth, side: '', cat: el.dataset.id, look: false }; location.hash = 'money'; return;
        case 'go-unsorted': e.preventDefault(); S.f = { q: '', account: '', month: route() === 'reports' ? S.reportMonth : '', side: '', cat: 'none', look: false }; location.hash = 'money'; if (route() === 'money') render(); return;
        case 'go-job': S.f = { q: el.dataset.job, account: '', month: '', side: '', cat: '', look: false }; location.hash = 'money'; return;
        case 'flag-set': {
          const row = await q(sb.from('flags').update({ status: el.dataset.status, resolved_at: new Date().toISOString() }).eq('id', el.dataset.id).select().single());
          S.flags = S.flags.map(f => f.id === row.id ? row : f);
          render();
          return;
        }
        case 'flags-resolved': S.showResolved = !S.showResolved; render(); return;
        case 'payee-flag': await setPayeeFlag(el.dataset.name, el.dataset.field, el.checked); return;
      }
    } catch (err) { fail(err); }
  });

  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-act]')) { e.preventDefault(); e.target.click(); }
  });

  let qTimer;
  document.addEventListener('input', e => {
    const id = e.target.id;
    if (id === 'f-q') { clearTimeout(qTimer); qTimer = setTimeout(() => { S.f.q = e.target.value; S.showN = 200; renderRegister(); }, 150); }
    if (id === 'tx-flagged' || id === 'tx-cat') {
      if (id === 'tx-flagged') $('#tx-flagnote-wrap').hidden = !e.target.checked;
    }
  });
  document.addEventListener('change', async e => {
    const id = e.target.id;
    const v = e.target.value;
    try {
      switch (id) {
        case 'year': S.year = Number(v); S.sel.clear(); $('#view').innerHTML = '<div class="loading">Loading ' + S.year + '…</div>'; await loadYear(); render(); return;
        case 'f-account': S.f.account = v; break;
        case 'f-month': S.f.month = v; break;
        case 'f-side': S.f.side = v; break;
        case 'f-cat': S.f.cat = v; break;
        case 'f-look': S.f.look = e.target.checked; break;
        case 'r-month': S.reportMonth = v; render(); return;
        case 'r-side': S.reportSide = v; render(); return;
        case 'r-cutoff': prefs.set('cutoff-' + S.year, Math.max(0, Number(v) || 0)); render(); return;
        case 's-big': prefs.set('bigLimit', Math.max(0, Number(v) || 0)); toast('Saved'); render(); return;
        case 'tx-cat': {
          const c = cat(v);
          if (c && c.side !== 'both') { const r = dlg().querySelector(`input[name="tx-side"][value="${c.side}"]`); if (r) r.checked = true; }
          return;
        }
        default: return;
      }
      S.showN = 200;
      renderRegister();
    } catch (err) { fail(err); }
  });
  document.addEventListener('submit', async e => {
    if (e.target.id === 'up-form') { e.preventDefault(); await uploadStatements(e.target); }
    if (e.target.id === 'pw-form') {
      e.preventDefault();
      const err = $('#pw-err');
      const a = $('#pw-1').value, b = $('#pw-2').value;
      err.hidden = true;
      if (a.length < 10) { err.textContent = 'Use at least 10 characters.'; err.hidden = false; return; }
      if (a !== b) { err.textContent = 'The two passwords don’t match.'; err.hidden = false; return; }
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) { err.textContent = friendly(error); err.hidden = false; return; }
      $('#pw-1').value = $('#pw-2').value = '';
      toast('Password changed');
    }
  });

  document.addEventListener('pointerover', e => { const h = e.target.closest('.chart .hit'); if (h) showTip(h); });
  document.addEventListener('pointerout', e => {
    const c = e.target.closest('.chart');
    if (c && !c.contains(e.relatedTarget)) hideTip(c);
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (route() === 'home' && S.user) drawCharts(); }, 150); });
  window.addEventListener('hashchange', () => {
    if (!S.user) return;
    if (location.hash === '#signout') return;
    S.sel.clear();
    S.showN = 200;
    if (dlg().open) closeDialog();
    render();
    window.scrollTo(0, 0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.user && Date.now() - S.loadedAt > 5 * 60 * 1000 && !dlg().open) reload(true);
  });

  // ---------------------------------------------------------------- sign in
  function showAuth(html) {
    $('#app').hidden = true;
    const box = $('#auth');
    box.hidden = false;
    box.innerHTML = `<div class="auth-card">
      <div class="brand"><div class="brand-mark">EDP</div><div><div class="brand-name">EDP Books</div><div class="brand-sub">Exterior Design Plus</div></div></div>
      ${html}</div>`;
    const f = box.querySelector('input');
    if (f) f.focus();
  }
  function signInForm(msg) {
    showAuth(`<form class="sheet" id="signin-form" novalidate><div class="sheet-body">
      <h2>Sign in</h2>
      ${msg ? `<p class="note ${msg.kind || ''}">${esc(msg.text)}</p>` : ''}
      <label class="field"><span>Email</span><input type="email" id="si-email" autocomplete="username" required value="${esc(prefs.get('email', ''))}"></label>
      <label class="field"><span>Password</span><input type="password" id="si-pass" autocomplete="current-password" required></label>
      <p class="note bad" id="si-err" hidden></p>
      <button class="btn primary" type="submit">Sign in</button>
      <button class="btn ghost" type="button" id="si-forgot">Forgot password?</button>
    </div></form>`);
    $('#signin-form').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#si-err');
      const email = $('#si-email').value.trim(), password = $('#si-pass').value;
      err.hidden = true;
      if (!email || !password) { err.textContent = 'Put in your email and password.'; err.hidden = false; return; }
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      if (error) { err.textContent = /invalid/i.test(error.message) ? 'That email and password don’t match. Try again, or tap “Forgot password?”.' : friendly(error); err.hidden = false; return; }
      prefs.set('email', email);
      start(data.user);
    });
    $('#si-forgot').addEventListener('click', async () => {
      const email = $('#si-email').value.trim();
      const err = $('#si-err');
      if (!email) { err.textContent = 'Type your email first, then tap “Forgot password?” again.'; err.hidden = false; return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) { err.textContent = friendly(error); err.hidden = false; return; }
      signInForm({ kind: 'good', text: 'Check your email for a link to set a new password.' });
    });
  }
  function newPasswordForm() {
    showAuth(`<form class="sheet" id="np-form" novalidate><div class="sheet-body">
      <h2>Set a new password</h2>
      <label class="field"><span>New password</span><input type="password" id="np-1" autocomplete="new-password" minlength="10"></label>
      <label class="field"><span>Same password again</span><input type="password" id="np-2" autocomplete="new-password"></label>
      <p class="note bad" id="np-err" hidden></p>
      <button class="btn primary" type="submit">Save and sign in</button>
    </div></form>`);
    $('#np-form').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#np-err');
      const a = $('#np-1').value, b = $('#np-2').value;
      if (a.length < 10) { err.textContent = 'Use at least 10 characters.'; err.hidden = false; return; }
      if (a !== b) { err.textContent = 'The two passwords don’t match.'; err.hidden = false; return; }
      const { data, error } = await sb.auth.updateUser({ password: a });
      if (error) { err.textContent = friendly(error); err.hidden = false; return; }
      S.recovery = false;
      start(data.user);
    });
  }

  function start(user) {
    S.user = user;
    $('#auth').hidden = true;
    $('#app').hidden = false;
    const ys = $('#year');
    let opts = '';
    for (let y = thisYear; y >= thisYear - 7; y--) opts += `<option value="${y}"${y === S.year ? ' selected' : ''}>${y}</option>`;
    ys.innerHTML = opts;
    if (location.hash === '#signout' || !ROUTES[location.hash.slice(1)]) history.replaceState(null, '', '#home');
    reload();
  }

  async function boot() {
    if (!sb) {
      showAuth('<section class="sheet"><div class="sheet-body"><h2>Almost ready</h2><p>This app isn’t connected to its database yet. Claude finishes this step once Supabase is set up.</p></div></section>');
      return;
    }
    const recoveryLink = /type=recovery/.test(location.hash);
    sb.auth.onAuthStateChange((event, session) => {
      setTimeout(() => {
        if (event === 'PASSWORD_RECOVERY') { S.recovery = true; newPasswordForm(); }
        else if (event === 'SIGNED_OUT') { S.user = null; S.tx = []; signInForm(); }
        else if (event === 'TOKEN_REFRESHED' && session) S.user = session.user;
      }, 0);
    });
    const { data } = await sb.auth.getSession();
    if (S.recovery || recoveryLink) { S.recovery = true; newPasswordForm(); return; }
    if (data.session) start(data.session.user); else signInForm();
  }
  boot();
})();
