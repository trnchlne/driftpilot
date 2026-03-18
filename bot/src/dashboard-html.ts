export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0e17;
    color: #c5c8d4;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px;
    line-height: 1.5;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    background: #0f1420;
    border-bottom: 1px solid #1e2536;
  }
  .header h1 { font-size: 16px; color: #e2e5ed; font-weight: 600; }
  .header-right { display: flex; gap: 16px; align-items: center; }
  .uptime { color: #7a8099; }
  .connection {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px;
  }
  .connection .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #34d399;
  }
  .connection.disconnected .dot { background: #ef4444; }
  .connection.reconnecting .dot {
    background: #f59e0b;
    animation: pulse 1s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .main {
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: auto auto auto auto auto;
  }

  /* Account bar */
  .account-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 20px;
    background: #0f1420;
    border-bottom: 1px solid #1e2536;
    gap: 20px;
  }
  .acct-item { text-align: center; }
  .acct-label { color: #5a5f73; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .acct-value { color: #e2e5ed; font-weight: 700; font-size: 16px; }
  .acct-value.green { color: #34d399; }
  .acct-value.red { color: #ef4444; }
  .acct-value.neutral { color: #7a8099; }

  /* Chart */
  .chart-container {
    padding: 16px;
    border-bottom: 1px solid #1e2536;
    position: relative;
  }
  .chart-container h2 {
    font-size: 13px; color: #7a8099; text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 8px;
  }
  .chart-info {
    position: absolute; top: 16px; right: 20px;
    display: flex; gap: 16px; font-size: 11px;
  }
  .chart-legend {
    display: flex; align-items: center; gap: 4px;
  }
  .legend-line {
    width: 16px; height: 2px; display: inline-block;
  }
  .legend-dash {
    width: 16px; height: 0; display: inline-block;
    border-top: 2px dashed;
  }
  canvas#chart {
    width: 100%;
    height: 280px;
    display: block;
  }

  /* Strategy panel */
  .strategy-panel {
    padding: 16px;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 12px;
  }

  .strat-card {
    background: #0f1420;
    border: 1px solid #1e2536;
    border-radius: 6px;
    padding: 10px 14px;
  }
  .strat-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 6px;
  }
  .strat-name { color: #e2e5ed; font-weight: 600; font-size: 13px; }
  .strat-status { font-weight: 600; font-size: 11px; }
  .strat-status.scanning { color: #60a5fa; }
  .strat-status.holding { color: #fbbf24; }
  .strat-status.cooldown { color: #7a8099; }
  .strat-status.warmup { color: #5a5f73; }

  .strat-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    margin-bottom: 8px;
  }
  .metric { text-align: center; }
  .metric-label { color: #5a5f73; font-size: 9px; text-transform: uppercase; }
  .metric-value { color: #e2e5ed; font-weight: 600; font-size: 13px; }

  .strat-thinking {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 10px;
    font-size: 11px;
  }
  .think-item {
    display: flex;
    justify-content: space-between;
    gap: 4px;
  }
  .think-key { color: #5a5f73; font-size: 10px; }
  .think-val { color: #a5aac0; font-weight: 500; text-align: right; font-size: 10px; }
  .pnl-pos { color: #34d399; }
  .pnl-neg { color: #ef4444; }
  .pnl-zero { color: #5a5f73; }
  .think-full { grid-column: 1 / -1; }
  .think-warn { color: #f59e0b; font-weight: 600; }
  .think-last { color: #c5c8d4; }
  .think-last-detail { color: #7a8099; font-style: italic; }

  /* Trades feed */
  .trades {
    border-top: 1px solid #1e2536;
    padding: 12px 16px;
    max-height: 180px;
    overflow-y: auto;
  }
  .trades h2 {
    font-size: 13px; color: #7a8099; text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 8px;
  }
  .trade-line {
    padding: 2px 0;
    font-size: 12px;
    display: flex;
    gap: 10px;
  }
  .trade-time { color: #5a5f73; min-width: 120px; }
  .trade-name { color: #e2e5ed; min-width: 100px; font-weight: 500; }
  .trade-dir { min-width: 50px; font-weight: 600; }
  .trade-dir.long { color: #34d399; }
  .trade-dir.short { color: #ef4444; }
  .trade-detail { color: #7a8099; }
  .trade-pnl { min-width: 100px; font-weight: 600; }
  .trade-action { font-weight: 600; min-width: 50px; }
  .trade-action.open { color: #38bdf8; }
  .trade-action.close { color: #a78bfa; }
  .trade-size { color: #5a5f73; }
  .empty-msg { color: #3a3f53; font-style: italic; padding: 10px 0; }

  /* Market insight panel */
  .market-panel {
    border-top: 1px solid #1e2536;
    padding: 12px 16px;
  }
  .market-panel h2 {
    font-size: 13px; color: #7a8099; text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 10px;
  }
  .market-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
  }
  .market-item {
    background: #0f1420;
    border: 1px solid #1e2536;
    border-radius: 6px;
    padding: 8px 12px;
  }
  .market-label {
    color: #5a5f73;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 2px;
  }
  .market-value {
    color: #e2e5ed;
    font-weight: 600;
    font-size: 14px;
  }
  .market-sub {
    color: #5a5f73;
    font-size: 11px;
    margin-top: 1px;
  }
  .market-bar {
    height: 8px;
    border-radius: 4px;
    background: #1e2536;
    margin-top: 4px;
    overflow: hidden;
  }
  .market-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s;
  }
  .funding-pos { color: #34d399; }
  .funding-neg { color: #ef4444; }

  /* Tab bar */
  .tab-bar {
    display: flex;
    gap: 6px;
    padding: 8px 20px;
    background: #0f1420;
    border-bottom: 1px solid #1e2536;
  }
  .tab {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 14px;
    border-radius: 14px;
    background: #141825;
    border: 1px solid #1e2536;
    color: #7a8099;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .tab:hover { background: #1a1f30; color: #a5aac0; }
  .tab.active {
    background: #1a2744;
    border-color: #2e5a9e;
    color: #60a5fa;
    font-weight: 600;
  }
  .tab .tab-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #3a3f53;
    flex-shrink: 0;
  }
  .tab .tab-dot.scanning { background: #60a5fa; }
  .tab .tab-dot.holding { background: #34d399; }
  .tab .tab-dot.cooldown { background: #7a8099; }
  .tab .tab-dot.warmup { background: #5a5f73; }
</style>
</head>
<body>

<div class="header">
  <h1>Trading Dashboard</h1>
  <div class="header-right">
    <span class="uptime" id="uptime"></span>
    <div class="connection" id="connection">
      <span class="dot"></span>
      <span class="conn-text">Connected</span>
    </div>
  </div>
</div>

<div class="account-bar" id="account-bar">
  <div class="acct-item"><div class="acct-label">Balance</div><div class="acct-value" id="acct-balance">--</div></div>
  <div class="acct-item"><div class="acct-label">Start</div><div class="acct-value neutral" id="acct-start">--</div></div>
  <div class="acct-item"><div class="acct-label" id="acct-realized-label">Realized P&L</div><div class="acct-value" id="acct-realized">--</div></div>
  <div class="acct-item"><div class="acct-label" id="acct-unrealized-label">Unrealized P&L</div><div class="acct-value" id="acct-unrealized">--</div></div>
  <div class="acct-item"><div class="acct-label" id="acct-total-label">Total P&L</div><div class="acct-value" id="acct-total">--</div></div>
  <div class="acct-item"><div class="acct-label" id="acct-roi-label">ROI (total)</div><div class="acct-value" id="acct-roi">--</div></div>
  <div class="acct-item"><div class="acct-label" id="acct-trading-roi-label">ROI (trading)</div><div class="acct-value" id="acct-trading-roi">--</div></div>
</div>

<div class="tab-bar" id="tab-bar"></div>

<div class="main">
  <div class="chart-container">
    <h2><span id="chart-market">SOL</span>/USD <span id="chart-price" style="color:#e2e5ed;font-size:16px;font-weight:700;margin-left:8px">--</span></h2>
    <div class="chart-info" id="chart-legend"></div>
    <canvas id="chart"></canvas>
  </div>

  <div class="strategy-panel" id="strat-panel">
    <div class="empty-msg">Waiting for strategy data...</div>
  </div>

  <div class="trades">
    <h2>Activity Feed</h2>
    <div id="trades-feed">
      <div class="empty-msg">No trades yet...</div>
    </div>
  </div>

  <div class="market-panel" id="market-panel">
    <h2>SOL-PERP Market</h2>
    <div id="market-content">
      <div class="empty-msg">Waiting for market data...</div>
    </div>
  </div>
</div>

<script>
(function() {
  var MAX_CHART_POINTS = 600; // ~10 minutes at 1/sec
  var MAX_TRADES = 50;
  var priceHistory = [];
  var marketPriceHistories = {}; // { SOL: [...], HYPE: [...] }
  var trades = [];
  var currentLevels = null;
  var currentRegime = '';
  var prevSol = 0;
  var activeTab = 'all';
  var activeMarket = 'SOL';
  var strategyStates = {};
  var strategyMarkets = {}; // name → market symbol
  var lastLeaderboard = null;
  var lastAccount = null;

  function fmt(n, d) {
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /* ─── Chart ────────────────────────────────── */

  var canvas = document.getElementById('chart');
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;

  function resizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', function() { resizeCanvas(); drawChart(); });

  function drawChart() {
    var w = canvas.width / dpr;
    var h = canvas.height / dpr;
    var pad = { top: 10, right: 70, bottom: 30, left: 10 };
    var cw = w - pad.left - pad.right;
    var ch = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    // Use the active market's price history (fallback to SOL/legacy)
    var chartPrices = marketPriceHistories[activeMarket] || priceHistory;
    if (chartPrices.length < 2) {
      ctx.fillStyle = '#3a3f53';
      ctx.font = '12px monospace';
      ctx.fillText('Waiting for price data...', w / 2 - 80, h / 2);
      return;
    }

    // Determine Y range from prices + levels
    var prices = chartPrices.map(function(p) { return p.price; });
    var allValues = prices.slice();
    if (currentLevels) {
      var lvlKeys = ['mean', 'entryLong', 'entryShort', 'sl', 'tp', 'trail', 'entry', 'best'];
      for (var k = 0; k < lvlKeys.length; k++) {
        var v = currentLevels[lvlKeys[k]];
        if (v && v > 0) allValues.push(v);
      }
    }

    var minP = Math.min.apply(null, allValues);
    var maxP = Math.max.apply(null, allValues);
    var range = maxP - minP;
    if (range < 0.01) range = 0.5;
    minP -= range * 0.08;
    maxP += range * 0.08;
    range = maxP - minP;

    // Time range
    var firstTime = chartPrices[0].time;
    var lastTime = chartPrices[chartPrices.length - 1].time;
    var timeSpanMs = lastTime - firstTime;

    function yPos(price) { return pad.top + ch - ((price - minP) / range * ch); }
    function xPos(i) {
      if (timeSpanMs <= 0) return pad.left;
      return pad.left + ((chartPrices[i].time - firstTime) / timeSpanMs) * cw;
    }

    // Grid lines
    var gridSteps = 5;
    ctx.strokeStyle = '#141825';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#5a5f73';
    ctx.textAlign = 'right';
    for (var g = 0; g <= gridSteps; g++) {
      var gp = minP + (range * g / gridSteps);
      var gy = yPos(gp);
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + cw, gy);
      ctx.stroke();
      ctx.fillText('$' + gp.toFixed(2), w - 4, gy + 3);
    }

    // Time axis labels
    // Pick a nice interval: aim for ~6-8 labels
    var intervals = [10000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    var timeInterval = 60000;
    for (var ti = 0; ti < intervals.length; ti++) {
      if (timeSpanMs / intervals[ti] <= 10) { timeInterval = intervals[ti]; break; }
    }
    ctx.fillStyle = '#5a5f73';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    // Find first tick aligned to interval
    var firstAligned = Math.ceil(firstTime / timeInterval) * timeInterval;
    for (var t = firstAligned; t <= lastTime; t += timeInterval) {
      var tx = pad.left + ((t - firstTime) / timeSpanMs) * cw;
      if (tx < pad.left + 20 || tx > pad.left + cw - 20) continue;
      // Tick mark
      ctx.strokeStyle = '#1e2536';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, pad.top);
      ctx.lineTo(tx, pad.top + ch);
      ctx.stroke();
      // Label
      var d = new Date(t);
      var label = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
      if (timeInterval < 60000) label += ':' + d.getSeconds().toString().padStart(2, '0');
      ctx.fillStyle = '#5a5f73';
      ctx.fillText(label, tx, pad.top + ch + 14);
    }

    // Level lines (drawn BEFORE price so price is on top)
    var legendHtml = '';
    if (currentLevels) {
      function drawLevel(price, color, label, dashed, thick) {
        if (!price || price <= 0) return;
        var y = yPos(price);
        if (y < pad.top - 5 || y > pad.top + ch + 5) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = thick ? 2.5 : 1.5;
        if (dashed) ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + cw, y);
        ctx.stroke();
        ctx.restore();
        // Label on right
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.font = '10px monospace';
        ctx.fillText(label + ' $' + price.toFixed(2), pad.left + cw + 4, y + 3);
      }

      var meanLbl = currentLevels.meanLabel || 'MEAN';
      var entryLbl = currentLevels.entryLabel || '';
      var blocked = currentLevels.blockedDir || '';
      drawLevel(currentLevels.mean, '#60a5fa', meanLbl, false, true);
      drawLevel(currentLevels.entryLong, blocked === 'long' ? '#1a5c3a' : '#34d399', 'LONG' + (blocked === 'long' ? ' (blocked)' : '') + (entryLbl ? ' (' + entryLbl + ')' : ''), true, false);
      drawLevel(currentLevels.entryShort, blocked === 'short' ? '#5c1a1a' : '#ef4444', 'SHORT' + (blocked === 'short' ? ' (blocked)' : '') + (entryLbl ? ' (' + entryLbl + ')' : ''), true, false);
      drawLevel(currentLevels.entry, '#fbbf24', 'ENTRY', false, false);
      drawLevel(currentLevels.sl, '#ef4444', 'SL', false, false);
      drawLevel(currentLevels.tp, '#34d399', 'TP', false, false);
      drawLevel(currentLevels.trail, '#f59e0b', 'TRAIL', true, false);
      drawLevel(currentLevels.best, '#7a8099', 'BEST', true, false);

      // Build legend
      legendHtml = '';
      if (currentLevels.mean) legendHtml += '<span class="chart-legend"><span class="legend-line" style="background:#60a5fa"></span> ' + meanLbl + '</span>';
      if (currentLevels.entryLong) legendHtml += '<span class="chart-legend"><span class="legend-dash" style="border-color:' + (blocked === 'long' ? '#1a5c3a' : '#34d399') + '"></span> Long' + (blocked === 'long' ? ' (blocked)' : '') + '</span>';
      if (currentLevels.entryShort) legendHtml += '<span class="chart-legend"><span class="legend-dash" style="border-color:' + (blocked === 'short' ? '#5c1a1a' : '#ef4444') + '"></span> Short' + (blocked === 'short' ? ' (blocked)' : '') + '</span>';
      if (currentLevels.sl) legendHtml += '<span class="chart-legend"><span class="legend-line" style="background:#ef4444"></span> SL</span>';
      if (currentLevels.trail) legendHtml += '<span class="chart-legend"><span class="legend-dash" style="border-color:#f59e0b"></span> Trail</span>';
      if (currentLevels.tp) legendHtml += '<span class="chart-legend"><span class="legend-line" style="background:#34d399"></span> TP</span>';
    }
    document.getElementById('chart-legend').innerHTML = legendHtml;

    // Price line
    ctx.beginPath();
    ctx.strokeStyle = '#e2e5ed';
    ctx.lineWidth = 1.5;
    for (var i = 0; i < chartPrices.length; i++) {
      var px = xPos(i);
      var py = yPos(chartPrices[i].price);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Current price dot
    var lastP = chartPrices[chartPrices.length - 1];
    var lx = xPos(chartPrices.length - 1);
    var ly = yPos(lastP.price);
    ctx.beginPath();
    ctx.arc(lx, ly, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#e2e5ed';
    ctx.fill();
  }

  /* ─── Tabs ────────────────────────────────── */

  function getStatusClass(thinking) {
    var s = String(thinking.status || 'UNKNOWN');
    if (s.indexOf('WARMING') >= 0) return 'warmup';
    if (s.indexOf('COOLDOWN') >= 0) return 'cooldown';
    if (s.indexOf('TRD') >= 0 || s.indexOf('REV') >= 0) return 'holding';
    return 'scanning';
  }

  function buildTabs(entries) {
    for (var i = 0; i < entries.length; i++) {
      strategyStates[entries[i].name] = getStatusClass(entries[i].thinking || {});
      if (entries[i].market) strategyMarkets[entries[i].name] = entries[i].market;
    }
    var bar = document.getElementById('tab-bar');
    var html = '<button class="tab' + (activeTab === 'all' ? ' active' : '') + '" onclick="window._setTab(\\'all\\')">All</button>';
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i].name;
      var sc = strategyStates[name] || 'scanning';
      html += '<button class="tab' + (activeTab === name ? ' active' : '') + '" onclick="window._setTab(\\'' + name + '\\')">'
        + '<span class="tab-dot ' + sc + '"></span>' + name + '</button>';
    }
    bar.innerHTML = html;
  }

  function renderAccountBar() {
    if (!lastAccount) return;
    var d = lastAccount;
    var sign = function(v) { return v >= 0 ? '+' : ''; };
    var cls = function(v) { return v > 0.005 ? 'green' : v < -0.005 ? 'red' : 'neutral'; };

    var balance = d.balanceUsdc;
    var start = d.startBalanceUsdc;
    var realized = d.realizedPnl;
    var unrealized = d.unrealizedPnl;
    var total = d.totalPnl;
    var trading = d.tradingPnl || 0;

    // Per-strategy USDC data when a strategy tab is selected
    var stratLabel = '';
    if (activeTab !== 'all' && d.perStrategy && d.perStrategy[activeTab]) {
      var ps = d.perStrategy[activeTab];
      balance = ps.balanceUsdc;
      start = ps.startBalanceUsdc;
      realized = ps.realizedPnl;
      unrealized = ps.unrealizedPnl;
      total = ps.totalPnl;
      trading = ps.tradingPnl || 0;
      stratLabel = ' (' + activeTab + ')';
    }

    document.getElementById('acct-balance').textContent = '$' + fmt(balance, 2);
    document.getElementById('acct-start').textContent = '$' + fmt(start, 2);
    document.getElementById('acct-realized-label').textContent = 'Realized P&L' + stratLabel;
    document.getElementById('acct-unrealized-label').textContent = 'Unrealized P&L' + stratLabel;
    document.getElementById('acct-total-label').textContent = 'Total P&L' + stratLabel;
    document.getElementById('acct-roi-label').textContent = 'ROI (total)' + stratLabel;
    document.getElementById('acct-trading-roi-label').textContent = 'ROI (trading)' + stratLabel;

    var realEl = document.getElementById('acct-realized');
    realEl.textContent = sign(realized) + '$' + fmt(Math.abs(realized), 2);
    realEl.className = 'acct-value ' + cls(realized);
    var unrEl = document.getElementById('acct-unrealized');
    unrEl.textContent = sign(unrealized) + '$' + fmt(Math.abs(unrealized), 2);
    unrEl.className = 'acct-value ' + cls(unrealized);
    var totEl = document.getElementById('acct-total');
    totEl.textContent = sign(total) + '$' + fmt(Math.abs(total), 2);
    totEl.className = 'acct-value ' + cls(total);
    var roiEl = document.getElementById('acct-roi');
    var roiPct = start > 0 ? (total / start) * 100 : 0;
    roiEl.textContent = sign(roiPct) + fmt(Math.abs(roiPct), 2) + '%';
    roiEl.className = 'acct-value ' + cls(roiPct);
    var tradingRoiEl = document.getElementById('acct-trading-roi');
    var tradingRoiPct = start > 0 ? (trading / start) * 100 : 0;
    tradingRoiEl.textContent = sign(tradingRoiPct) + fmt(Math.abs(tradingRoiPct), 2) + '%';
    tradingRoiEl.className = 'acct-value ' + cls(tradingRoiPct);
  }

  window._setTab = function(name) {
    activeTab = name;
    // Switch chart to the selected strategy's market
    activeMarket = (name !== 'all' && strategyMarkets[name]) || 'SOL';
    document.getElementById('chart-market').textContent = activeMarket;
    var mktPrice = (marketPriceHistories[activeMarket] || []);
    if (mktPrice.length > 0) {
      document.getElementById('chart-price').textContent = '$' + fmt(mktPrice[mktPrice.length - 1].price, 2);
    }
    if (lastLeaderboard) renderStrategies(lastLeaderboard);
    renderFeed();
    renderAccountBar();
    drawChart();
  };

  /* ─── Strategy Panel ───────────────────────── */

  function renderStrategies(data) {
    lastLeaderboard = data;
    document.getElementById('uptime').textContent = data.uptime + ' | ' + data.totalTrades + ' trades';

    var panel = document.getElementById('strat-panel');
    if (data.entries.length === 0) {
      panel.innerHTML = '<div class="empty-msg">No strategies active...</div>';
      return;
    }

    buildTabs(data.entries);

    // Filter entries by active tab
    var filtered = data.entries;
    if (activeTab !== 'all') {
      filtered = data.entries.filter(function(e) { return e.name === activeTab; });
    }

    // Determine chart levels
    currentLevels = null;
    if (activeTab !== 'all') {
      for (var li = 0; li < data.entries.length; li++) {
        if (data.entries[li].name === activeTab && data.entries[li].thinking && data.entries[li].thinking._levels) {
          currentLevels = data.entries[li].thinking._levels;
          currentRegime = String(data.entries[li].thinking.regime || '');
          break;
        }
      }
    } else {
      // "All" mode: prefer the strategy that's currently holding, else first with levels
      var holdingLevels = null;
      var firstLevels = null;
      for (var li = 0; li < data.entries.length; li++) {
        var th = data.entries[li].thinking || {};
        if (th._levels) {
          if (!firstLevels) { firstLevels = th._levels; currentRegime = String(th.regime || ''); }
          var sc = getStatusClass(th);
          if (sc === 'holding') { holdingLevels = th._levels; currentRegime = String(th.regime || ''); }
        }
      }
      currentLevels = holdingLevels || firstLevels;
    }

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var e = filtered[i];
      var m = e.metrics;
      var t = e.thinking || {};
      var statusStr = String(t.status || 'UNKNOWN');
      var statusClass = getStatusClass(t);

      // Real Drift PnL (USDC) from per-strategy account data
      var ps = lastAccount && lastAccount.perStrategy && lastAccount.perStrategy[e.name];
      var pnlVal = ps ? ps.totalPnl : 0;
      var tradingVal = ps ? (ps.tradingPnl || 0) : 0;
      var pnlRoi = (ps && ps.startBalanceUsdc > 0) ? (ps.totalPnl / ps.startBalanceUsdc * 100) : 0;
      var tradingRoi = (ps && ps.startBalanceUsdc > 0) ? (tradingVal / ps.startBalanceUsdc * 100) : 0;
      var pnlClass = pnlVal > 0.005 ? 'pnl-pos' : pnlVal < -0.005 ? 'pnl-neg' : 'pnl-zero';
      var tradingClass = tradingVal > 0.005 ? 'pnl-pos' : tradingVal < -0.005 ? 'pnl-neg' : 'pnl-zero';
      var pnlSign = pnlVal >= 0 ? '+' : '';
      var tradingSign = tradingVal >= 0 ? '+' : '';

      html += '<div class="strat-card">'
        + '<div class="strat-header">'
        + '<span class="strat-name">' + e.name + ' <span style="color:#5a5f73;font-size:11px;font-weight:400">' + e.type + (e.market ? ' · ' + e.market : '') + (e.subAccountId !== undefined ? ' · sub ' + e.subAccountId : '') + '</span></span>'
        + '<span class="strat-status ' + statusClass + '">' + statusStr + '</span>'
        + '</div>'
        + '<div class="strat-metrics">'
        + '<div class="metric"><div class="metric-label">PnL (total)</div><div class="metric-value ' + pnlClass + '">' + pnlSign + '$' + fmt(Math.abs(pnlVal), 2) + '</div></div>'
        + '<div class="metric"><div class="metric-label">PnL (trading)</div><div class="metric-value ' + tradingClass + '">' + tradingSign + '$' + fmt(Math.abs(tradingVal), 2) + '</div></div>'
        + '<div class="metric"><div class="metric-label">ROI (trading)</div><div class="metric-value ' + tradingClass + '">' + tradingSign + fmt(Math.abs(tradingRoi), 2) + '%</div></div>'
        + '<div class="metric"><div class="metric-label">Trades</div><div class="metric-value">' + m.totalTrades + '</div></div>'
        + '<div class="metric"><div class="metric-label">Win Rate</div><div class="metric-value">' + m.winRate.toFixed(0) + '%</div></div>'
        + '<div class="metric"><div class="metric-label">Sharpe</div><div class="metric-value">' + m.sharpe.toFixed(2) + '</div></div>'
        + '</div>'
        + '<div class="strat-thinking">';

      var keys = Object.keys(t);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (key === 'status' || key === '_levels') continue;
        var valClass = 'think-val';
        if (key === 'ATR warning') valClass = 'think-val think-warn';
        if (key === 'last trade') valClass = 'think-val think-last';
        if (key === 'last exit') valClass = 'think-val think-last-detail';
        var span = key === 'last trade' || key === 'last exit' || key === 'ATR warning' ? 'full' : '';
        if (span === 'full') {
          html += '<div class="think-item think-full"><span class="think-key">' + key + '</span><span class="' + valClass + '">' + t[key] + '</span></div>';
        } else {
          html += '<div class="think-item"><span class="think-key">' + key + '</span><span class="' + valClass + '">' + t[key] + '</span></div>';
        }
      }

      html += '</div></div>';
    }
    panel.innerHTML = html;
    drawChart();
  }

  /* ─── Activity Feed ────────────────────────── */

  function tradeKey(t) {
    if (t.tradeId) return t.tradeId + '|' + t.action;
    return t.strategyName + '|' + t.action + '|' + t.timestamp + '|' + (t.entry || t.price);
  }

  function addActivity(item) {
    // Deduplicate (server replays recent trades on reconnect)
    var key = tradeKey(item);
    for (var i = 0; i < trades.length; i++) {
      if (tradeKey(trades[i]) === key) return;
    }
    trades.unshift(item);
    if (trades.length > MAX_TRADES) trades.pop();
    renderFeed();
  }

  function renderFeed() {
    var feed = document.getElementById('trades-feed');
    var html = '';
    var filtered = trades;
    if (activeTab !== 'all') {
      filtered = trades.filter(function(t) { return t.strategyName === activeTab; });
    }
    for (var i = 0; i < filtered.length; i++) {
      var t = filtered[i];
      var d = new Date(t.timestamp);
      var time = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');

      if (t.action === 'OPEN') {
        html += '<div class="trade-line">'
          + '<span class="trade-time">' + time + '</span>'
          + '<span class="trade-name">' + t.strategyName + '</span>'
          + '<span class="trade-action open">OPEN</span>'
          + '<span class="trade-dir ' + t.direction + '">' + t.direction.toUpperCase() + '</span>'
          + '<span class="trade-detail">@ $' + fmt(t.price, 2) + '</span>'
          + '<span class="trade-size">' + t.size + ' SOL</span>'
          + '</div>';
      } else {
        var pnlClass = t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg';
        var sign = t.pnl >= 0 ? '+' : '';
        var bestStr = t.bestPrice ? ' (best $' + fmt(t.bestPrice, 2) + ')' : '';
        html += '<div class="trade-line">'
          + '<span class="trade-time">' + time + '</span>'
          + '<span class="trade-name">' + t.strategyName + '</span>'
          + '<span class="trade-action close">EXIT</span>'
          + '<span class="trade-dir ' + t.direction + '">' + t.direction.toUpperCase() + '</span>'
          + '<span class="trade-detail">$' + fmt(t.entry, 2) + ' &rarr; $' + fmt(t.exit, 2) + bestStr + '</span>'
          + '<span class="trade-pnl ' + pnlClass + '">' + sign + t.pnl.toFixed(6) + ' SOL</span>'
          + '<span class="trade-detail">' + t.reason + '</span>'
          + '</div>';
      }
    }
    feed.innerHTML = html || '<div class="empty-msg">No trades yet...</div>';
  }

  /* ─── Connection ───────────────────────────── */

  function renderMarket(d) {
    var el = document.getElementById('market-content');
    if (!el) return;

    var fmtK = function(v) {
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
      return v.toFixed(0);
    };
    var fmtN = function(v, dec) { return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); };

    // Funding: positive = longs pay shorts, negative = shorts pay longs
    var payerLabel = d.fundingRate24h >= 0 ? 'Longs pay shorts' : 'Shorts pay longs';
    var fundingAbs = Math.abs(d.fundingRate24h);
    var fundingCls = d.fundingRate24h >= 0 ? 'funding-pos' : 'funding-neg';

    // OI
    var totalOI = d.longOI + d.shortOI;
    var longPct = totalOI > 0 ? (d.longOI / totalOI * 100) : 50;
    var notionalM = totalOI * d.markPrice / 1e6;

    // Spread as %
    var spreadPct = d.spreadBps / 100;

    // OI capacity
    var oiCapPct = d.maxOI > 0 ? (totalOI / d.maxOI * 100) : 0;
    var oiBarColor = oiCapPct > 80 ? '#ef4444' : oiCapPct > 50 ? '#fbbf24' : '#34d399';

    var html = '<div class="market-grid">'

      // Funding — who pays whom, how much
      + '<div class="market-item">'
      + '<div class="market-label">Funding (24h avg)</div>'
      + '<div class="market-value ' + fundingCls + '">' + payerLabel + '</div>'
      + '<div class="market-sub">' + fundingAbs.toFixed(4) + '%/h &mdash; cost to hold a position on the paying side</div>'
      + '</div>'

      // Spread — cost to enter/exit
      + '<div class="market-item">'
      + '<div class="market-label">Spread</div>'
      + '<div class="market-value">' + spreadPct.toFixed(3) + '%</div>'
      + '<div class="market-sub">Your cost per round-trip (open + close) &mdash; at ' + spreadPct.toFixed(3) + '% you pay ~$' + (150 * spreadPct / 100 * 2).toFixed(2) + ' per SOL traded</div>'
      + '</div>'

      // Open Interest — market size
      + '<div class="market-item">'
      + '<div class="market-label">Open Interest</div>'
      + '<div class="market-value">$' + fmtN(notionalM, 1) + 'M</div>'
      + '<div class="market-sub">' + fmtK(totalOI) + ' SOL in open positions &mdash; ' + oiCapPct.toFixed(0) + '% of ' + fmtK(d.maxOI) + ' max</div>'
      + '<div class="market-bar"><div class="market-bar-fill" style="width:' + Math.min(oiCapPct, 100).toFixed(1) + '%;background:' + oiBarColor + '"></div></div>'
      + '</div>'

      // Long/Short balance
      + '<div class="market-item" style="grid-column:span 2">'
      + '<div class="market-label">Long vs Short</div>'
      + '<div class="market-value">' + longPct.toFixed(1) + '% long / ' + (100 - longPct).toFixed(1) + '% short</div>'
      + '<div class="market-bar"><div class="market-bar-fill" style="width:100%;background:linear-gradient(90deg,#34d399 0%,#34d399 ' + longPct.toFixed(1) + '%,#ef4444 ' + longPct.toFixed(1) + '%,#ef4444 100%)"></div></div>'
      + '<div class="market-sub">' + fmtK(d.longOI) + ' SOL long / ' + fmtK(d.shortOI) + ' SOL short</div>'
      + '</div>'

      // Open positions — how many traders
      + '<div class="market-item">'
      + '<div class="market-label">Open Positions</div>'
      + '<div class="market-value">' + fmtN(d.usersWithPositions, 0) + '</div>'
      + '<div class="market-sub">Sub-accounts with open SOL-PERP positions on Drift</div>'
      + '</div>'

      + '</div>';

    el.innerHTML = html;
  }

  function setConnection(state) {
    var el = document.getElementById('connection');
    var text = el.querySelector('.conn-text');
    el.className = 'connection';
    if (state === 'connected') {
      text.textContent = 'Connected';
    } else if (state === 'reconnecting') {
      el.classList.add('reconnecting');
      text.textContent = 'Reconnecting...';
    } else {
      el.classList.add('disconnected');
      text.textContent = 'Disconnected';
    }
  }

  function connect() {
    var es = new EventSource('/events');
    setConnection('connected');

    es.addEventListener('price', function(e) {
      var d = JSON.parse(e.data);
      prevSol = d.sol;

      // Track per-market price histories
      if (d.prices) {
        for (var sym in d.prices) {
          if (!marketPriceHistories[sym]) marketPriceHistories[sym] = [];
          marketPriceHistories[sym].push({ time: d.timestamp, price: d.prices[sym] });
          if (marketPriceHistories[sym].length > MAX_CHART_POINTS) marketPriceHistories[sym].shift();
        }
      }

      // Fallback: always track SOL in the legacy array
      priceHistory.push({ time: d.timestamp, price: d.sol });
      if (priceHistory.length > MAX_CHART_POINTS) priceHistory.shift();

      // Update chart price display for the active market
      var displayPrice = (d.prices && d.prices[activeMarket]) || d.sol;
      document.getElementById('chart-price').textContent = '$' + fmt(displayPrice, 2);
      document.getElementById('chart-market').textContent = activeMarket;

      drawChart();
    });

    es.addEventListener('entry', function(e) {
      var d = JSON.parse(e.data);
      d.action = 'OPEN';
      addActivity(d);
    });

    es.addEventListener('trade', function(e) {
      var d = JSON.parse(e.data);
      d.action = 'EXIT';
      addActivity(d);
    });

    es.addEventListener('leaderboard', function(e) {
      renderStrategies(JSON.parse(e.data));
    });

    es.addEventListener('account', function(e) {
      lastAccount = JSON.parse(e.data);
      renderAccountBar();
    });

    es.addEventListener('market', function(e) {
      renderMarket(JSON.parse(e.data));
    });

    es.onerror = function() {
      setConnection('reconnecting');
      es.close();
      setTimeout(connect, 2000);
    };

    es.onopen = function() {
      setConnection('connected');
    };
  }

  connect();
})();
</script>
</body>
</html>`;
