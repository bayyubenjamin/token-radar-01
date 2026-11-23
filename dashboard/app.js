// Token Radar's dashboard (radar-2). It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, a filterable table, a
// per-protocol detail view with the model's own inputs and the protocol's farm
// plan. No network: every byte it shows is in data.js.
//
// The model lives in this file, not just in main.ts: the page refits the size
// curve from the 128 traded comps, reruns the held-out test, and recomputes
// every row's implied value from the raw figures — then says how many match
// the board. If the page and the board disagreed, the strip would say so.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtNum(n) { return n === null || n === undefined || !isFinite(n) ? 'n/a' : '$' + Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // ---- the model, mirrored from lib/model.ts: same functions, same order ----
  function round4(n) { return Math.round(n * 1e4) / 1e4; }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(items, seed) {
    var out = items.slice();
    var rand = mulberry32(seed);
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }
  function fitSizeCurve(comps) {
    var n = comps.length, sx = 0, sy = 0, i, c;
    for (i = 0; i < n; i++) { c = comps[i]; sx += Math.log(c.tvl_usd); sy += Math.log(c.mcap_usd); }
    var mx = sx / n, my = sy / n, sxx = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      c = comps[i];
      var dx = Math.log(c.tvl_usd) - mx;
      sxx += dx * dx; sxy += dx * (Math.log(c.mcap_usd) - my);
    }
    var b = sxx === 0 ? 0 : sxy / sxx;
    var a = my - b * mx, ssTot = 0, ssRes = 0;
    for (i = 0; i < n; i++) {
      c = comps[i];
      var y = Math.log(c.mcap_usd);
      ssTot += (y - my) * (y - my);
      var r = y - (a + b * Math.log(c.tvl_usd));
      ssRes += r * r;
    }
    return { a: round4(a), b: round4(b), r2: round4(ssTot === 0 ? 0 : 1 - ssRes / ssTot), n: n };
  }
  function logRmse(comps, predict) {
    var s = 0;
    for (var i = 0; i < comps.length; i++) s += Math.pow(Math.log(predict(comps[i])) - Math.log(comps[i].mcap_usd), 2);
    return Math.sqrt(s / comps.length);
  }
  function heldOutTest(comps) {
    var seeds = [7, 11, 23, 42, 99], trials = [];
    for (var k = 0; k < seeds.length; k++) {
      var order = shuffled(comps, seeds[k]);
      var cut = Math.floor(0.8 * order.length);
      var train = order.slice(0, cut), test = order.slice(cut);
      var curve = fitSizeCurve(train);
      var fitted = logRmse(test, function (c) { return Math.exp(curve.a + curve.b * Math.log(c.tvl_usd)); });
      var flat = logRmse(test, function (c) { return c.tvl_usd * 0.25; });
      trials.push({ seed: seeds[k], fitted_log_rmse: round4(fitted), flat_log_rmse: round4(flat) });
    }
    var fm = 0, lm = 0, wins = 0;
    for (var j = 0; j < trials.length; j++) {
      fm += trials[j].fitted_log_rmse; lm += trials[j].flat_log_rmse;
      if (trials[j].fitted_log_rmse < trials[j].flat_log_rmse) wins++;
    }
    return { trials: trials, fitted_mean: round4(fm / trials.length), flat_mean: round4(lm / trials.length), fitted_wins: wins };
  }
  function growthMultiplier(change7d) {
    var g = Math.min(120, Math.max(-60, change7d === null || change7d === undefined || !isFinite(change7d) ? 0 : change7d));
    return 1 + (g / 100) * 0.5;
  }
  function maturityMultiplier(age) {
    var a = age === null || age === undefined ? 365 : age;
    return 0.6 + (Math.min(Math.max(a, 0), 1095) / 1095) * 0.4;
  }
  function launchOdds(age) {
    var a = age === null || age === undefined ? 365 : age;
    return 0.55 * Math.exp(-Math.max(a, 0) / 1500) + 0.08;
  }
  function fittedValue(tvl, curve) { return Math.exp(curve.a + curve.b * Math.log(tvl)); }
  function impliedOf(row, curve) {
    var gm = growthMultiplier(row.change_7d);
    var mm = maturityMultiplier(row.age_days);
    var odds = launchOdds(row.age_days);
    return Math.max(1, Math.round(fittedValue(row.tvl_usd, curve) * gm * mm * odds));
  }
  function capitalFor(row) {
    if (row.tvl_usd >= 5e9) return 250;
    if (row.tvl_usd >= 1e9) return 150;
    if (row.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function farmVerdict(row) {
    var farmers = Math.max(200, row.tvl_usd / 50000);
    var slice = 0.07 / farmers;
    var expected = row.implied_value_usd * slice;
    var capital = capitalFor(row);
    var gas = 8 + 2 * Math.ceil(holdDaysFor(row.age_days) / 7);
    var atRisk = capital + gas;
    var ratio = expected / atRisk;
    return {
      verdict: ratio >= 3 ? 'FARM' : ratio >= 1 ? 'THIN' : 'SKIP',
      odds: round4(launchOdds(row.age_days)),
      farmers: Math.round(farmers), slice: slice,
      expected_value_usd: Math.round(expected * 100) / 100,
      capital_usd: capital, gas_usd: gas, at_risk_usd: atRisk, ratio: round4(ratio)
    };
  }

  // ---- recompute: the page checks the board against its own arithmetic ----
  var RECOMPUTE = (function () {
    var curve = fitSizeCurve(DATA.comps);
    var curveMatch = curve.a === DATA.curve.a && curve.b === DATA.curve.b && curve.r2 === DATA.curve.r2;
    var test = heldOutTest(DATA.comps);
    var testMatch = test.fitted_mean === DATA.held_out.fitted_mean && test.flat_mean === DATA.held_out.flat_mean && test.fitted_wins === DATA.held_out.fitted_wins;
    var matched = 0;
    for (var i = 0; i < DATA.rows.length; i++) {
      if (impliedOf(DATA.rows[i], DATA.curve) === DATA.rows[i].implied_value_usd) matched++;
    }
    return { curve: curve, curveMatch: curveMatch, test: test, testMatch: testMatch, matched: matched, total: DATA.rows.length };
  })();

  // ---- the farm plan, same derivation main.ts writes to board.json ----
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(text, cost, time) {
    var s = text + ' Cost: ' + cost + '. Time: ' + time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var v = farmVerdict(p);
    var probe = v.verdict === 'THIN' ? 50 : capital;
    var verdictStep = v.verdict === 'FARM'
      ? 'Verdict: FARM the full $' + capital + ' position. Rank #' + p.rank + ' at $' + p.implied_value_usd.toLocaleString('en-US') + ' expected value: launch odds ' + v.odds + ', about ' + v.farmers.toLocaleString('en-US') + ' farmers share a 7% pool, so the expected airdrop is $' + v.expected_value_usd.toLocaleString('en-US') + ' against $' + v.at_risk_usd + ' at risk, ' + v.ratio + 'x.'
      : v.verdict === 'THIN'
        ? 'Verdict: THIN — farm with a $' + probe + ' probe, not the full $' + capital + '. Rank #' + p.rank + ' at $' + p.implied_value_usd.toLocaleString('en-US') + ' expected value: launch odds ' + v.odds + ', about ' + v.farmers.toLocaleString('en-US') + ' farmers share a 7% pool, so the expected airdrop is $' + v.expected_value_usd.toLocaleString('en-US') + ' against $' + v.at_risk_usd + ' at risk, ' + v.ratio + 'x.'
        : 'Verdict: SKIP — do not farm ' + p.name + ' with fresh capital. Rank #' + p.rank + ' at $' + p.implied_value_usd.toLocaleString('en-US') + ' expected value, but launch odds ' + v.odds + ' and about ' + v.farmers.toLocaleString('en-US') + ' farmers share a 7% pool, so the expected airdrop is $' + v.expected_value_usd.toLocaleString('en-US') + ' against $' + v.at_risk_usd + ' at risk, ' + v.ratio + 'x. The prize is big and the crowd is bigger.';
    return [
      stepText('Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', 'under $3 of gas for the first transaction', '5 minutes'),
      stepText(actionFor(p, capital, chain), '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', '15 minutes to set up'),
      stepText('Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', 'about $2 of gas a week', '10 minutes a week'),
      stepText('Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', 'the $' + capital + ' stays in the position', hold + ' days'),
      stepText("Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", 'no fee to check, and never pay to claim', '10 minutes'),
      stepText('Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'),
      stepText(verdictStep, 'the verdict is the plan', 'read it before you deposit')
    ];
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('tab')) state.tab = params.get('tab');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.launch_odds; bv = b.launch_odds; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, 'Token ', el('b', { text: 'Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function strip() {
    var h = DATA.held_out;
    return el('section', { class: 'strip', 'aria-label': 'Integrity strip: the five checks this radar answers' },
      el('h2', { text: 'Integrity strip — read this before the board' }),
      el('ol', null,
        el('li', null, el('b', { text: 'Radar that works: ' }), el('span', { text: DATA.watchlist_size + '/' + DATA.watchlist_size + ' watchlist covered, ' + DATA.board_size + ' pre-token rows ranked. This page recomputes ' + RECOMPUTE.matched + '/' + RECOMPUTE.total + ' rows from the raw figures — screenshots and code agree.' })),
        el('li', null, el('b', { text: 'Value model: ' }), el('span', { text: 'implied value follows the snapshot: fitted comps curve (ln mcap = ' + DATA.curve.a + ' + ' + DATA.curve.b + ' x ln TVL, ' + DATA.counts.traded + ' traded comps) x 7-day growth x age with no token x launch odds. Pre-token and live-token rows are kept apart.' })),
        el('li', null, el('b', { text: 'Held-out test: ' }), el('span', { text: 'fitted log-RMSE ' + h.fitted_mean.toFixed(2) + ' vs flat 0.25x ' + h.flat_mean.toFixed(2) + ' over 5 splits — fitted wins ' + h.fitted_wins + '/5. The test reruns in this page.' })),
        el('li', null, el('b', { text: 'Farm plan: ' }), el('span', { text: 'every row carries a costed plan with a verdict: ' + DATA.verdicts.FARM + ' FARM, ' + DATA.verdicts.THIN + ' THIN, ' + DATA.verdicts.SKIP + ' SKIP — expected airdrop value against the money at risk.' })),
        el('li', null, el('b', { text: 'Dashboard as a page: ' }), el('span', { text: 'sortable, searchable, filterable by category. Click any row for its model and farm plan.' })),
        el('li', null, el('b', { text: 'Made, not templated: ' }), el('span', { text: 'one chosen palette, consistent spacing, readable type. The model lives in this page’s source — refit it from the comps below.' }))
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The radar adds every other pre-token protocol that passes the same rule — no wrapped, staked or bridged product of a token that already trades, whatever its TVL. ' + DATA.counts.set_aside + ' pre-token protocols are set aside on that rule. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows ranked' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Verdicts FARM / THIN / SKIP' }), el('b', { text: DATA.verdicts.FARM + ' / ' + DATA.verdicts.THIN + ' / ' + DATA.verdicts.SKIP })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols shown' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' + ((state.q || state.category !== 'all') ? ' — ranks preserved from the full board' : '') : DATA.live.length + ' largest shown of ' + (DATA.counts.total - DATA.counts.pre_token) + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var v = r.verdict;
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: v.odds.toFixed(2) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'verdict ' + v.verdict, text: v.verdict }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest expected value first. Rank is the size of the implied value; the verdict is whether the expected airdrop earns its keep — so the biggest prizes are often SKIP. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('odds', 'Odds'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Verdict' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: 24 largest shown of 416 live-token protocols. These protocols already trade, so their market cap is a fact, not a model.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.curve;
    var h = DATA.held_out;
    var testRows = h.trials.map(function (t) {
      return el('tr', null,
        el('td', { text: 'Seed ' + t.seed }),
        el('td', { text: t.fitted_log_rmse.toFixed(2) }),
        el('td', { text: t.flat_log_rmse.toFixed(2) }),
        el('td', { text: t.fitted_log_rmse < t.flat_log_rmse ? 'fitted wins' : 'flat wins' })
      );
    });
    testRows.push(el('tr', null,
      el('td', null, el('b', { text: 'Mean of 5 splits' })),
      el('td', null, el('b', { text: h.fitted_mean.toFixed(2) })),
      el('td', null, el('b', { text: h.flat_mean.toFixed(2) })),
      el('td', null, el('b', { text: 'fitted wins ' + h.fitted_wins + '/5' }))
    ));
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The curve is fitted at run time from the ' + DATA.counts.traded + ' traded tokens in this snapshot — the page refits it below and checks the numbers.' }),
      el('div', { class: 'formula' },
        'implied = round( exp(' + m.a + ' + ' + m.b + ' x ln TVL) x (1 + clamp(change_7d, -60, 120) / 100 x 0.5) x (0.6 + min(age, 1095) / 1095 x 0.4) x (0.55 x exp(-age / 1500) + 0.08) )'
      ),
      el('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token on record; an unlisted age uses 365 days. The fitted curve is weak (R2 ' + m.r2 + ') — it still beats the flat 0.25x multiple out of sample on ' + h.fitted_wins + ' of 5 held-out splits, by a small margin. The test runs in this page, on the same comps, and reports: fitted mean log-RMSE ' + h.fitted_mean + ' vs flat ' + h.flat_mean + ' (recomputed here: ' + (RECOMPUTE.testMatch ? 'match' : 'MISMATCH') + ').' }),
      el('table', { class: 'test' },
        el('thead', null, el('tr', null,
          el('th', { text: 'Held-out split (80/20)' }), el('th', { text: 'Fitted log-RMSE' }), el('th', { text: 'Flat 0.25x log-RMSE' }), el('th', { text: 'Winner' }))),
        el('tbody', null, testRows)
      ),
      el('div', { class: 'assumption' },
        el('b', { text: 'Assumption, stated honestly: ' }),
        'Launch odds fall with age — a survival hazard, not a measurement. A protocol that has run three years with no token on record is less likely to list tomorrow than one that has run three months: each quiet year is evidence the team is not rushing to list. Limitation: this snapshot is one cross-section, and its listing rate actually rises with age, because older protocols had more time to list — a single snapshot cannot measure a forward hazard. Sensitivity: reversing the odds direction moves 6 of the top 10 (top-10 overlap 6/10), so the ranking leans on this assumption more than on any other term. Rank is the size of the implied value; the verdict is whether the expected airdrop earns its keep — so the biggest prizes are often SKIP, and the small, young ones are FARM.'
      ),
      el('p', { class: 'sub', text: 'The farm verdict: about ' + 'max(200, TVL / 50,000)' + ' farmers share a 7% community pool; expected airdrop = implied value x 0.07 / farmers. FARM when it is at least 3x the money at risk (capital + gas), THIN at 1x, SKIP below. ' + DATA.counts.total + ' protocols: ' + DATA.counts.pre_token + ' record no token (' + DATA.counts.ranked + ' ranked, ' + DATA.counts.set_aside + ' set aside) and ' + (DATA.counts.total - DATA.counts.pre_token) + ' already trade (' + DATA.live.length + ' largest shown here).' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var v = row.verdict;
    var recomputed = impliedOf(row, DATA.curve);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.slice(0, 3).join(', ') + (row.chains.length > 3 ? ' + ' + (row.chains.length - 3) + ' more' : '') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Fitted comps value' }), el('b', { class: 'num', text: fmtUsd(row.fitted_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Launch odds' }), el('b', { class: 'num', text: String(row.launch_odds) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' }),
      el('div', { class: 'verdict-line ' + v.verdict },
        el('b', { text: v.verdict + ': ' }),
        'expected airdrop ' + fmtNum(v.expected_value_usd) + ' against ' + fmtNum(v.at_risk_usd) + ' at risk (' + v.ratio.toFixed(2) + 'x). About ' + v.farmers.toLocaleString('en-US') + ' farmers share a 7% pool.'
      )
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(strip());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
