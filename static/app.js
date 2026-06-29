let charts = {};
let currentTicker = null;
let refreshInterval = null;
let lastData = null;

// ─── Watchlist (localStorage) ───
function getWatchlist() {
  try { return JSON.parse(localStorage.getItem('st_watchlist') || '[]'); } catch(e) { return []; }
}
function saveWatchlist(wl) { localStorage.setItem('st_watchlist', JSON.stringify(wl)); }
function renderWatchlist() {
  const wl = getWatchlist();
  const list = document.getElementById('wlList');
  const empty = document.getElementById('wlEmpty');
  if (!wl.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  list.innerHTML = wl.map(t => '<li class="si" onclick="sel(\'' + t + '\')" id="wl-' + t + '">' + t + '</li>').join('');
}
function toggleWatchlist() {
  if (!currentTicker) return;
  let wl = getWatchlist();
  const idx = wl.indexOf(currentTicker);
  if (idx >= 0) { wl.splice(idx, 1); } else { wl.push(currentTicker); }
  saveWatchlist(wl);
  renderWatchlist();
  updateWatchlistBtn();
}
function updateWatchlistBtn() {
  const btn = document.getElementById('wlToggle');
  if (!btn || !currentTicker) return;
  const inWl = getWatchlist().includes(currentTicker);
  btn.textContent = inWl ? '⭐ In Watchlist' : '☆ Add to Watchlist';
  btn.className = 'wl-btn' + (inWl ? ' active' : '');
}
renderWatchlist();

// ─── Clock ───
function updateClock() {
  document.getElementById('hdrTime').textContent = new Date().toLocaleTimeString('en-US', {hour12:false});
}
setInterval(updateClock, 1000); updateClock();

// ─── Search ───
function filterS() {
  const q = document.getElementById('sb').value.toUpperCase();
  document.querySelectorAll('#slist .si').forEach(e => {
    e.style.display = e.textContent.trim().toUpperCase().includes(q) ? '' : 'none';
  });
}

// ─── Select ticker ───
async function sel(t) {
  document.querySelectorAll('.si').forEach(e => e.classList.remove('active'));
  const el = document.getElementById('s-' + t);
  if (el) el.classList.add('active');
  currentTicker = t;
  document.getElementById('hdrTicker').textContent = t;
  document.getElementById('welc').style.display = 'none';
  const d = document.getElementById('dash');
  d.style.display = 'flex'; d.style.flexDirection = 'column'; d.style.gap = '16px';
  d.className = 'fade-in';
  updateWatchlistBtn();

  document.getElementById('bVal').innerHTML = '<span class="loading-spinner"></span>Analyzing...';
  document.getElementById('priceMain').textContent = '...';

  try {
    const r = await fetch('/api/predict/' + t);
    const data = await r.json();
    if (data.error) { alert(data.error); return; }
    lastData = data;
    update(data);
  } catch (e) { alert('Error: ' + e.message); }

  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => refreshQuote(t), 30000);
}

// ─── Quick Quote Refresh ───
async function refreshQuote(t) {
  try {
    const r = await fetch('/api/quote/' + t);
    const data = await r.json();
    if (!data.error && data.price) {
      document.getElementById('priceMain').textContent = '$' + data.price.toFixed(2);
      const chEl = document.getElementById('priceChange');
      if (data.change !== null) {
        const up = data.change >= 0;
        chEl.textContent = (up ? '+' : '') + data.change.toFixed(2) + ' (' + data.change_pct.toFixed(2) + '%)';
        chEl.className = 'price-change ' + (up ? 'green' : 'red');
      }
      document.getElementById('refreshTime').textContent = 'Updated: ' + data.timestamp;
    }
  } catch(e) {}
}

// ─── Forecast Card Helper ───
function setFC(id, f, target) {
  const card = document.getElementById(id);
  const cls = f.direction === 'UP' ? 'up' : f.direction === 'DOWN' ? 'down' : 'neutral';
  card.className = 'fc ' + cls;
  const prefix = id.replace('d', '');
  document.getElementById(prefix + 'arrow').textContent = f.direction === 'UP' ? '▲' : f.direction === 'DOWN' ? '▼' : '●';
  document.getElementById(prefix + 'arrow').className = 'fc-arrow ' + (f.direction === 'UP' ? 'green' : f.direction === 'DOWN' ? 'red' : 'amber');
  document.getElementById(prefix + 'dir').textContent = f.direction;
  document.getElementById(prefix + 'dir').style.color = f.direction === 'UP' ? 'var(--green)' : f.direction === 'DOWN' ? 'var(--red)' : 'var(--amber)';
  document.getElementById(prefix + 'conf').textContent = f.confidence + '% Confidence';
  document.getElementById(prefix + 'str').textContent = f.strength + ' Signal';
  if (target !== undefined) {
    document.getElementById(prefix + 'target').textContent = 'Target: $' + target;
  }
}

// ─── Format Helpers ───
function fmtNum(n) {
  if (!n) return '—';
  if (n >= 1e12) return '$' + (n/1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  return '$' + n.toFixed(2);
}
function fmtVol(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return n.toString();
}

// ─── AI Gauge Drawing ───
function drawGauge(score) {
  const canvas = document.getElementById('gaugeCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  
  const cx = w / 2, cy = h - 10;
  const radius = 90;
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  
  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.lineWidth = 18;
  ctx.strokeStyle = 'rgba(55,65,100,.3)';
  ctx.lineCap = 'round';
  ctx.stroke();
  
  // Gradient arc
  const grad = ctx.createLinearGradient(cx - radius, cy, cx + radius, cy);
  grad.addColorStop(0, '#ff1744');
  grad.addColorStop(0.35, '#ff9100');
  grad.addColorStop(0.5, '#ffd740');
  grad.addColorStop(0.65, '#76ff03');
  grad.addColorStop(1, '#00e676');
  
  const valueAngle = startAngle + (score / 100) * Math.PI;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, valueAngle);
  ctx.lineWidth = 18;
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.stroke();
  
  // Needle
  const needleAngle = startAngle + (score / 100) * Math.PI;
  const needleLen = radius - 25;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + needleLen * Math.cos(needleAngle), cy + needleLen * Math.sin(needleAngle));
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#f0f2f5';
  ctx.lineCap = 'round';
  ctx.stroke();
  
  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#448aff';
  ctx.fill();
  
  // Labels
  ctx.fillStyle = '#505a6e';
  ctx.font = '10px Inter';
  ctx.textAlign = 'center';
  ctx.fillText('SELL', cx - radius + 10, cy + 20);
  ctx.fillText('BUY', cx + radius - 10, cy + 20);
  ctx.fillText('HOLD', cx, cy - radius + 25);
}

// ─── Main Update ───
function update(d) {
  // Price header
  const price = d.current_price || d.last_close;
  document.getElementById('priceMain').textContent = '$' + price.toFixed(2);
  const chEl = document.getElementById('priceChange');
  const up = d.change >= 0;
  chEl.textContent = (up ? '+' : '') + d.change.toFixed(2) + ' (' + d.change_pct.toFixed(2) + '%)';
  chEl.className = 'price-change ' + (up ? 'green' : 'red');
  document.getElementById('priceTicker').textContent = d.ticker;

  const tag = document.getElementById('priceTag');
  tag.textContent = d.is_realtime ? '● LIVE' : '● DELAYED';
  tag.className = 'price-tag ' + (d.is_realtime ? 'live' : 'delayed');

  let metaText = d.last_date;
  if (d.market_cap) metaText += '  ·  MCap: ' + fmtNum(d.market_cap);
  document.getElementById('priceMeta').textContent = metaText;
  document.getElementById('refreshTime').textContent = 'Updated: ' + d.timestamp.split(' ')[1];

  // AI Gauge
  drawGauge(d.gauge_score);
  const gv = document.getElementById('gaugeVal');
  gv.textContent = d.gauge_score;
  gv.style.color = d.gauge_score > 60 ? 'var(--green)' : d.gauge_score < 40 ? 'var(--red)' : 'var(--amber)';
  document.getElementById('gaugeLbl').textContent = d.gauge_score > 60 ? 'Bullish' : d.gauge_score < 40 ? 'Bearish' : 'Neutral';

  // Signal
  const bull = d.prediction === 'BULLISH'; const neut = d.prediction === 'NEUTRAL';
  document.getElementById('bVal').textContent = d.prediction;
  document.getElementById('bVal').style.color = bull ? 'var(--green)' : neut ? 'var(--amber)' : 'var(--red)';
  document.getElementById('bProb').textContent = 'Confidence: ' + d.confidence + '% · AI Prob: ' + d.ai_probability;

  // Forecasts with price targets
  setFC('fc1d', d.forecasts['1d'], d.price_targets['1d']);
  setFC('fc5d', d.forecasts['5d'], d.price_targets['5d']);
  setFC('fc10d', d.forecasts['10d'], d.price_targets['10d']);

  // Metrics
  document.getElementById('mCl').textContent = '$' + d.last_close;
  const mch = document.getElementById('mCh');
  mch.textContent = (d.change >= 0 ? '+' : '') + d.change + ' (' + d.change_pct.toFixed(2) + '%)';
  mch.className = 'csub ' + (d.change >= 0 ? 'green' : 'red');

  const rsi = d.indicators.rsi;
  document.getElementById('mR').textContent = rsi;
  document.getElementById('mR').style.color = rsi > 70 ? 'var(--red)' : rsi < 30 ? 'var(--green)' : 'var(--blue)';
  document.getElementById('mRs').textContent = rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Normal Range';

  document.getElementById('mM').textContent = d.indicators.macd;
  document.getElementById('mM').style.color = d.indicators.macd_hist > 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('mMs').textContent = 'Histogram: ' + d.indicators.macd_hist;

  const tr = d.indicators.trend_align;
  document.getElementById('mT').textContent = tr + ' / 4';
  document.getElementById('mT').style.color = tr >= 3 ? 'var(--green)' : tr <= 1 ? 'var(--red)' : 'var(--amber)';
  document.getElementById('mTs').textContent = tr >= 3 ? 'Strong Uptrend' : tr <= 1 ? 'Downtrend' : 'Mixed Signals';

  // Support/Resistance
  if (d.support_resistance) {
    document.getElementById('lvR2').textContent = '$' + d.support_resistance.resistance_2;
    document.getElementById('lvR1').textContent = '$' + d.support_resistance.resistance_1;
    document.getElementById('lvPivot').textContent = '$' + d.support_resistance.pivot;
    document.getElementById('lvS1').textContent = '$' + d.support_resistance.support_1;
    document.getElementById('lvS2').textContent = '$' + d.support_resistance.support_2;
  }

  // Price Targets
  if (d.price_targets) {
    document.getElementById('pt1d').textContent = '$' + d.price_targets['1d'];
    document.getElementById('pt5d').textContent = '$' + d.price_targets['5d'];
    document.getElementById('pt10d').textContent = '$' + d.price_targets['10d'];
  }

  // BB Position bar
  const bbPos = Math.min(Math.max((d.indicators.bb_pos || 0.5) * 100, 0), 100);
  const bbFill = document.getElementById('bbFill');
  bbFill.style.width = bbPos + '%';
  bbFill.style.background = bbPos > 80 ? 'var(--red)' : bbPos < 20 ? 'var(--green)' : 'var(--blue)';
  document.getElementById('bbVal').textContent = bbPos.toFixed(0) + '%';

  // Stats
  if (d.stats) {
    document.getElementById('st52H').textContent = '$' + d.stats.high_52w;
    document.getElementById('st52L').textContent = '$' + d.stats.low_52w;
    const pfh = d.stats.pct_from_high;
    const pfhEl = document.getElementById('stFromH');
    pfhEl.textContent = pfh + '%';
    pfhEl.className = 'stat-val ' + (pfh >= 0 ? 'green' : 'red');
    document.getElementById('stDayH').textContent = '$' + d.stats.day_high;
    document.getElementById('stDayL').textContent = '$' + d.stats.day_low;
    document.getElementById('stAvgVol').textContent = fmtVol(d.stats.avg_volume);
  }

  document.getElementById('chTk').textContent = '— ' + d.ticker;
  buildPrice(d.price_data); buildRSI(d.price_data); buildVolume(d.price_data); buildTable(d.price_data);
}

// ─── Chart Colors ───
function cc() {
  return {
    grid:'rgba(55,65,100,.25)', tick:'#505a6e',
    blue:'#448aff', blueFill:'rgba(68,138,255,.08)',
    amber:'#ffd740', purple:'#b388ff', cyan:'#18ffff',
    green:'#00e676', red:'#ff1744'
  };
}

// ─── Price Chart with Bollinger Bands ───
function buildPrice(p) {
  if (charts.pr) charts.pr.destroy();
  const c = cc();
  const datasets = [
    {label:'Close', data:p.close, borderColor:c.blue, backgroundColor:c.blueFill, fill:true, tension:.4, pointRadius:0, borderWidth:2.5},
    {label:'EMA 5', data:p.ema5, borderColor:c.cyan, borderDash:[3,3], pointRadius:0, borderWidth:1.2, fill:false},
    {label:'SMA 20', data:p.sma20, borderColor:c.amber, borderDash:[5,3], pointRadius:0, borderWidth:1.5, fill:false},
    {label:'SMA 50', data:p.sma50, borderColor:c.purple, borderDash:[5,3], pointRadius:0, borderWidth:1.5, fill:false},
  ];
  // Add Bollinger Bands if available
  if (p.bb_upper && p.bb_lower) {
    datasets.push({label:'BB Upper', data:p.bb_upper, borderColor:'rgba(255,23,68,.3)', borderDash:[2,4], pointRadius:0, borderWidth:1, fill:false});
    datasets.push({label:'BB Lower', data:p.bb_lower, borderColor:'rgba(0,230,118,.3)', borderDash:[2,4], pointRadius:0, borderWidth:1, fill:'+1',
      backgroundColor:'rgba(68,138,255,.04)'});
  }
  charts.pr = new Chart(document.getElementById('priceC'), {
    type:'line', data:{labels:p.dates.map(d=>d.substring(5)), datasets},
    options:{responsive:true, interaction:{intersect:false,mode:'index'},
      plugins:{legend:{labels:{color:c.tick,font:{size:10,family:'Inter'},usePointStyle:true,pointStyle:'circle'}},
        tooltip:{backgroundColor:'rgba(10,14,23,.95)',borderColor:c.blue,borderWidth:1,titleFont:{family:'JetBrains Mono'},bodyFont:{family:'JetBrains Mono',size:11}}},
      scales:{x:{ticks:{color:c.tick,maxTicksLimit:8,font:{size:9}},grid:{color:c.grid}},
        y:{ticks:{color:c.tick,font:{size:10,family:'JetBrains Mono'}},grid:{color:c.grid}}}}
  });
}

// ─── RSI Chart ───
function buildRSI(p) {
  if (charts.rs) charts.rs.destroy();
  const c = cc();
  const cols = p.rsi.map(v => v > 70 ? 'rgba(255,23,68,.6)' : v < 30 ? 'rgba(0,230,118,.6)' : 'rgba(68,138,255,.5)');
  charts.rs = new Chart(document.getElementById('rsiC'), {
    type:'bar', data:{labels:p.dates.map(d=>d.substring(5)),
    datasets:[{label:'RSI',data:p.rsi,backgroundColor:cols,borderRadius:3,borderSkipped:false}]},
    options:{responsive:true,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(10,14,23,.95)',borderColor:c.blue,borderWidth:1,bodyFont:{family:'JetBrains Mono',size:11}}},
      scales:{x:{ticks:{color:c.tick,maxTicksLimit:8,font:{size:9}},grid:{display:false}},
        y:{min:0,max:100,ticks:{color:c.tick,font:{size:10}},grid:{color:c.grid}}}}
  });
}

// ─── Volume Chart ───
function buildVolume(p) {
  if (charts.vol) charts.vol.destroy();
  if (!p.volume) return;
  const c = cc();
  const volCols = p.close.map((cl,i) => i > 0 && cl >= p.close[i-1] ? 'rgba(0,230,118,.4)' : 'rgba(255,23,68,.4)');
  charts.vol = new Chart(document.getElementById('volC'), {
    type:'bar', data:{labels:p.dates.map(d=>d.substring(5)),
    datasets:[{label:'Volume',data:p.volume,backgroundColor:volCols,borderRadius:2,borderSkipped:false}]},
    options:{responsive:true,plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:c.tick,maxTicksLimit:8,font:{size:9}},grid:{display:false}},
        y:{ticks:{color:c.tick,font:{size:9},callback:v=>v>=1e6?(v/1e6).toFixed(0)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':v},grid:{color:c.grid}}}}
  });
}

// ─── History Table ───
function buildTable(p) {
  let h = '';
  for (let i = p.dates.length - 1; i >= Math.max(0, p.dates.length - 15); i--) {
    const r = p.rsi[i]; const rc = r > 70 ? 'red' : r < 30 ? 'green' : '';
    const chg = i > 0 ? ((p.close[i] - p.close[i-1]) / p.close[i-1] * 100).toFixed(2) : '0.00';
    const chgBdg = parseFloat(chg) >= 0 ? 'up' : 'down';
    h += '<tr><td>' + p.dates[i] + '</td><td>$' + p.close[i] + '</td>';
    h += '<td class="' + rc + '">' + r + '</td>';
    h += '<td><span class="badge ' + chgBdg + '">' + (parseFloat(chg) >= 0 ? '+' : '') + chg + '%</span></td></tr>';
  }
  document.getElementById('htb').innerHTML = h;
}

// ─── Export CSV ───
function exportCSV() {
  if (!lastData) { alert('No data to export. Select a ticker first.'); return; }
  const d = lastData;
  let csv = 'Date,Open,High,Low,Close,Volume,RSI\n';
  const p = d.price_data;
  for (let i = 0; i < p.dates.length; i++) {
    csv += [p.dates[i], p.open[i], p.high[i], p.low[i], p.close[i], p.volume[i], p.rsi[i]].join(',') + '\n';
  }
  csv += '\n--- AI Analysis ---\n';
  csv += 'Ticker,' + d.ticker + '\n';
  csv += 'Prediction,' + d.prediction + '\n';
  csv += 'Confidence,' + d.confidence + '%\n';
  csv += 'AI Probability,' + d.ai_probability + '\n';
  csv += '1D Target,$' + d.price_targets['1d'] + '\n';
  csv += '5D Target,$' + d.price_targets['5d'] + '\n';
  csv += '10D Target,$' + d.price_targets['10d'] + '\n';
  
  const blob = new Blob([csv], {type: 'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = d.ticker + '_analysis_' + new Date().toISOString().split('T')[0] + '.csv';
  a.click(); URL.revokeObjectURL(url);
}

// ─── Keyboard Shortcuts ───
document.addEventListener('keydown', function(e) {
  // Ctrl+K = focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); document.getElementById('sb').focus(); }
  // E = export
  if (e.key === 'e' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT') { exportCSV(); }
  // R = refresh
  if (e.key === 'r' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT') { if (currentTicker) sel(currentTicker); }
  // W = toggle watchlist
  if (e.key === 'w' && !e.ctrlKey && document.activeElement.tagName !== 'INPUT') { toggleWatchlist(); }
  // Escape = clear search
  if (e.key === 'Escape') { const sb = document.getElementById('sb'); sb.value = ''; filterS(); sb.blur(); }
});

// ─── Market Overview ───
async function loadMarketOverview() {
  try {
    const r = await fetch('/api/market_overview');
    const data = await r.json();
    const el = document.getElementById('marketBar');
    if (el && data.length) {
      el.innerHTML = data.map(d => {
        const up = d.change >= 0;
        return '<span style="margin-right:20px"><strong>' + d.ticker + '</strong> $' + d.price +
          ' <span class="' + (up?'green':'red') + '">' + (up?'+':'') + d.change_pct.toFixed(2) + '%</span></span>';
      }).join('');
    }
  } catch(e){}
}
loadMarketOverview();
setInterval(loadMarketOverview, 60000);
