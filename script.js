(() => {
  const K = {logs:"netlog.v1", aggs:"netlog.aggs", samples:"netlog.samples", ips:"netlog.ips",
             lastip:"netlog.lastip", speed:"netlog.lastspeed", set:"netlog.settings", alive:"netlog.alive"};
  const PING_URL = "https://www.gstatic.com/generate_204";
  const SPEED_URL = "https://speed.cloudflare.com/__down?bytes=8000000";
  const IP_URL = "https://api.ipify.org?format=json";
  const INTERVAL = 10000;
  const TIMEOUT = 5000;
  const FAILS_TO_DOWN = 2;
  const GAP_THRESHOLD = 2 * 60000;
  const SAMPLE_KEEP = 6 * 3600000;
  const AGG_KEEP = 90 * 86400000;
  const IP_INTERVAL = 5 * 60000;
  const BASE_TITLE = "ネット切断ログ";

  const $ = id => document.getElementById(id);
  const rd = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---------- 状態 ----------
  let logs = rd(K.logs, []); if (!Array.isArray(logs)) logs = [];
  let aggs = rd(K.aggs, {}); if (typeof aggs !== "object" || Array.isArray(aggs)) aggs = {};
  let samples = rd(K.samples, []); if (!Array.isArray(samples)) samples = [];
  let ips = rd(K.ips, []); if (!Array.isArray(ips)) ips = [];
  let lastSpeed = rd(K.speed, null);
  let set = Object.assign({slowMs:300, speedMin:60, hideIp:false, bg:!matchMedia("(prefers-reduced-motion: reduce)").matches}, rd(K.set, {}));
  let currentIp = rd(K.lastip, null);

  let isDown = false, downSince = null, fails = 0;
  let slowSince = null, slowPeak = 0, slowCount = 0, normalCount = 0, normalStart = null;
  let lastMs = null, testing = false, dirty = false, range = 60;
  let intro = true, reveal = 1;

  const now0 = Date.now();
  samples = samples.filter(s => Array.isArray(s) && s[0] >= now0 - SAMPLE_KEEP);
  for (const k of Object.keys(aggs)) if (+k < now0 - AGG_KEEP) delete aggs[k];

  // ---------- 表示ヘルパー ----------
  const fmtTime = t => new Date(t).toLocaleString("ja-JP", {hour12:false});
  const fmtClock = t => new Date(t).toLocaleTimeString("ja-JP", {hour12:false, hour:"2-digit", minute:"2-digit"});
  function fmtDur(ms){
    const s = Math.round(ms/1000);
    if (s < 60) return s + "秒";
    const m = Math.floor(s/60), r = s % 60;
    if (m < 60) return m + "分" + r + "秒";
    return Math.floor(m/60) + "時間" + (m % 60) + "分";
  }
  const showIp = s => (s == null ? "-" : (set.hideIp ? String(s).replace(/[0-9]/g, "•") : s));
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function tag(cls, txt){ const s = document.createElement("span"); s.className = "tag " + cls; s.textContent = txt; return s; }
  const seenRows = new Set();
  function row(cells, key, i){
    const tr = document.createElement("tr");
    if (key && !seenRows.has(key)){
      seenRows.add(key);
      tr.className = "rowin";
      tr.style.animationDelay = Math.min(i || 0, 12) * 40 + "ms";
    }
    for (const c of cells){
      const td = document.createElement("td");
      if (c instanceof Node) td.appendChild(c); else td.textContent = c;
      tr.appendChild(td);
    }
    return tr;
  }
  function emptyRow(tb, cols, msg){
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = cols; td.className = "empty"; td.textContent = msg;
    tr.appendChild(td); tb.appendChild(tr);
  }

  // ---------- 保存 ----------
  function save(){
    wr(K.logs, logs); wr(K.aggs, aggs); wr(K.samples, samples); wr(K.ips, ips); dirty = false;
  }

  // ---------- 集計 ----------
  function bucketKey(t){ const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); }
  function bucket(t){
    const k = bucketKey(t);
    return aggs[k] || (aggs[k] = {n:0, ok:0, sum:0, max:0, slow:0, sp:0, sn:0});
  }
  function addAgg(t, ms){
    const a = bucket(t);
    a.n++;
    if (ms >= 0){ a.ok++; a.sum += ms; if (ms > a.max) a.max = ms; if (ms > set.slowMs) a.slow++; }
    dirty = true;
  }
  function sumSince(from){
    let n = 0, ok = 0, sum = 0;
    for (const k in aggs){ if (+k >= from){ n += aggs[k].n; ok += aggs[k].ok; sum += aggs[k].sum; } }
    return {n, ok, sum};
  }

  // ---------- 状態表示 ----------
  function setStatus(){
    const dot = $("dot"), banner = $("banner");
    banner.className = "banner";
    if (isDown){
      dot.className = "dot down";
      $("stateText").textContent = "オフライン(ネットが落ちています)";
      $("stateSub").textContent = fmtTime(downSince) + " から";
      banner.textContent = "ネットが切断されています(" + fmtTime(downSince) + " から)";
      banner.classList.add("show", "red");
      document.title = "🔴 " + BASE_TITLE;
    } else if (slowSince){
      dot.className = "dot slow";
      $("stateText").textContent = "オンライン(不安定)";
      $("stateSub").textContent = "遅延が" + set.slowMs + "msを超える状態が続いています";
      banner.textContent = "回線が不安定です。遅延が大きい状態が " + fmtTime(slowSince) + " から続いています(最大 " + slowPeak + "ms)";
      banner.classList.add("show");
      document.title = "🟠 " + BASE_TITLE;
    } else {
      dot.className = "dot up";
      $("stateText").textContent = "オンライン";
      $("stateSub").textContent = "最終確認: " + fmtTime(Date.now());
      document.title = BASE_TITLE;
    }
  }

  function renderStats(){
    const nets = logs.filter(l => l.type === "net" || l.type == null);
    const total = nets.reduce((a, l) => a + (l.end - l.start), 0);
    const max = nets.reduce((a, l) => Math.max(a, l.end - l.start), 0);
    $("sCount").textContent = nets.length;
    $("sTotal").textContent = nets.length ? fmtDur(total) : "0秒";
    $("sMax").textContent = max ? fmtDur(max) : "-";
    $("sNow").textContent = isDown ? "切断中" : (lastMs != null ? lastMs + " ms" : "-");

    const d = new Date();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const today = sumSince(dayStart);
    $("sAvg").textContent = today.ok ? Math.round(today.sum / today.ok) + " ms" : "-";
    const month = sumSince(monthStart);
    $("sUp").textContent = month.n ? (month.ok / month.n * 100).toFixed(2) + "%" : "-";

    if (lastSpeed){
      $("sSpeed").textContent = lastSpeed.mbps.toFixed(1) + " Mbps";
      $("sSpeedT").textContent = fmtTime(lastSpeed.t);
    }
    $("sIp").textContent = showIp(currentIp);
  }

  // ---------- ログ表 ----------
  function renderEvents(){
    const tb = $("rows"); tb.textContent = "";
    const list = logs.slice().sort((a, b) => b.start - a.start);
    if (slowSince) list.unshift({type:"slow", start:slowSince, end:null, peak:slowPeak});
    if (isDown) list.unshift({type:"net", start:downSince, end:null});
    if (!list.length){ emptyRow(tb, 4, "まだ記録はありません"); return; }
    for (const l of list.slice(0, 300)){
      const type = l.type || "net";
      const t = type === "gap" ? tag("gap", "空白") : type === "slow" ? tag("slow", "不安定") : tag("net", "切断");
      let dur = l.end ? fmtDur(l.end - l.start) : (type === "net" ? "切断中…" : "継続中…");
      if (type === "slow" && l.peak) dur += "(最大 " + l.peak + "ms)";
      tb.appendChild(row([t, fmtTime(l.start), l.end ? fmtTime(l.end) : "-", dur], "e" + type + l.start, tb.children.length));
    }
  }

  function renderIps(){
    const tb = $("ipRows"); tb.textContent = "";
    if (!ips.length){ emptyRow(tb, 4, "まだ記録はありません"); return; }
    for (const e of ips.slice().reverse().slice(0, 100)){
      const first = e.from == null;
      tb.appendChild(row([first ? tag("gap", "初回記録") : tag("ip", "変更"), fmtTime(e.t), first ? "-" : showIp(e.from), showIp(e.to)], "i" + e.t, tb.children.length));
    }
  }

  // ---------- ヒートマップ・速度グラフ ----------
  function div(txt){ const d = document.createElement("div"); d.textContent = txt; return d; }
  function renderHeat(){
    const grid = Array.from({length:7}, () => Array.from({length:24}, () => ({n:0, ok:0})));
    for (const k in aggs){
      const a = aggs[k], d = new Date(+k), c = grid[(d.getDay() + 6) % 7][d.getHours()];
      c.n += a.n; c.ok += a.ok;
    }
    const el = $("heat"); el.textContent = "";
    el.appendChild(div(""));
    for (let h = 0; h < 24; h++) el.appendChild(div(h % 3 === 0 ? h : ""));
    const names = ["月","火","水","木","金","土","日"];
    const lo = [22, 53, 31], hi = [255, 92, 92];
    for (let r = 0; r < 7; r++){
      el.appendChild(div(names[r]));
      for (let h = 0; h < 24; h++){
        const c = grid[r][h], cell = document.createElement("div");
        if (!c.n){
          cell.style.background = "#222228";
          cell.title = names[r] + "曜 " + h + "時台: データなし";
        } else {
          const rate = (c.n - c.ok) / c.n, s = Math.min(rate / 0.05, 1);
          const col = lo.map((v, i) => Math.round(v + (hi[i] - v) * s));
          cell.style.background = "rgb(" + col.join(",") + ")";
          cell.title = names[r] + "曜 " + h + "時台: 失敗 " + (c.n - c.ok) + "/" + c.n + "回 (" + (rate * 100).toFixed(1) + "%)";
        }
        if (intro){ cell.classList.add("pop"); cell.style.animationDelay = (r * 24 + h) * 6 + "ms"; }
        el.appendChild(cell);
      }
    }
  }

  function renderBars(){
    const sp = Array(24).fill(0), sn = Array(24).fill(0);
    for (const k in aggs){
      const a = aggs[k]; if (!a.sn) continue;
      const h = new Date(+k).getHours();
      sp[h] += a.sp; sn[h] += a.sn;
    }
    const avg = sp.map((v, i) => sn[i] ? v / sn[i] : 0);
    const max = Math.max(...avg);
    const el = $("bars"); el.textContent = "";
    for (let h = 0; h < 24; h++){
      const col = document.createElement("div"); col.className = "col";
      const bar = document.createElement("div"); bar.className = "bar";
      bar.style.height = (max ? Math.max(2, avg[h] / max * 100) : 2) + "px";
      col.title = sn[h] ? h + "時台: 平均 " + avg[h].toFixed(1) + " Mbps(" + sn[h] + "回)" : h + "時台: データなし";
      const lab = document.createElement("i"); lab.textContent = h % 3 === 0 ? h : "";
      if (intro){ bar.classList.add("grow"); bar.style.animationDelay = h * 30 + "ms"; }
      col.appendChild(bar); col.appendChild(lab); el.appendChild(col);
    }
    $("barsCap").textContent = max ? "最大 " + max.toFixed(1) + " Mbps(棒にマウスを載せると詳細が出ます)" : "まだ速度の測定データがありません。";
  }

  // ---------- 遅延グラフ ----------
  function drawLatency(){
    const c = $("lat"), w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext("2d");
    g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    if (reveal < 1){ g.beginPath(); g.rect(0, 0, 40 + (w - 40) * reveal, h); g.clip(); }

    const now = Date.now(), span = range * 60000, t0 = now - span;
    const data = samples.filter(s => s[0] >= t0);
    const L = 48, R = 10, T = 10, B = 22, pw = w - L - R, ph = h - T - B;
    let maxv = set.slowMs;
    for (const s of data) if (s[1] > maxv) maxv = s[1];
    maxv = Math.min(Math.max(maxv * 1.15, 100), 3000);
    const X = t => L + (t - t0) / span * pw;
    const Y = v => T + ph - Math.min(v, maxv) / maxv * ph;

    g.font = "11px system-ui"; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++){
      const v = maxv * i / 4, y = Y(v);
      g.strokeStyle = css("--line");
      g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
      g.fillStyle = css("--sub"); g.fillText(Math.round(v) + "ms", 4, y + 4);
    }
    g.fillStyle = css("--sub");
    g.fillText(fmtClock(t0), L, h - 6);
    const te = fmtClock(now); g.fillText(te, w - R - g.measureText(te).width, h - 6);

    g.strokeStyle = css("--warn"); g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(L, Y(set.slowMs)); g.lineTo(w - R, Y(set.slowMs)); g.stroke();
    g.setLineDash([]);

    g.fillStyle = "rgba(255,92,92,.35)";
    for (const s of data) if (s[1] < 0) g.fillRect(X(s[0]) - 1, T, Math.max(2, pw * INTERVAL / span), ph);

    g.strokeStyle = css("--ok"); g.lineWidth = 1.5; g.beginPath();
    let prev = null;
    for (const s of data){
      if (s[1] < 0){ prev = null; continue; }
      const x = X(s[0]), y = Y(s[1]);
      if (prev === null || s[0] - prev > INTERVAL * 3) g.moveTo(x, y); else g.lineTo(x, y);
      prev = s[0];
    }
    g.stroke();
    const lastS = data[data.length - 1];
    if (lastS && lastS[1] >= 0){
      g.fillStyle = css("--ok"); g.shadowColor = css("--ok"); g.shadowBlur = 12;
      g.beginPath(); g.arc(X(lastS[0]), Y(lastS[1]), 3.5, 0, 7); g.fill();
      g.shadowBlur = 0;
    }
    if (!data.length){ g.fillStyle = css("--sub"); g.fillText("データなし", L + 10, T + 20); }
  }

  // ---------- 切断・不安定の判定 ----------
  function closeSlow(end){
    if (slowSince){
      logs.push({type:"slow", start:slowSince, end:Math.max(end, slowSince + 1000), peak:slowPeak});
      slowSince = null; save();
    }
    slowCount = 0; slowPeak = 0; normalCount = 0; normalStart = null;
  }
  function trackSlow(now, ms){
    if (ms > set.slowMs){
      normalCount = 0; slowCount++; slowPeak = Math.max(slowPeak, ms);
      if (!slowSince && slowCount >= 3){ slowSince = now - INTERVAL * 2; renderEvents(); }
    } else if (slowSince){
      normalCount++; if (normalCount === 1) normalStart = now;
      if (normalCount >= 3){ closeSlow(normalStart); renderEvents(); }
    } else { slowCount = 0; slowPeak = 0; }
  }
  function goDown(at){
    if (isDown) return;
    closeSlow(at);
    isDown = true; downSince = at;
    flash("255,92,92");
    setStatus(); renderEvents(); renderStats();
  }
  function goUp(at){
    if (!isDown) return;
    logs.push({type:"net", start:downSince, end:at});
    isDown = false; downSince = null;
    flash("61,220,132");
    save(); setStatus(); renderEvents(); renderStats();
    setTimeout(checkIP, 3000);
  }

  async function check(){
    if (testing) return;
    const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), TIMEOUT);
    let ms = -1; const t0 = performance.now();
    try {
      await fetch(PING_URL + "?t=" + Date.now(), {mode:"no-cors", cache:"no-store", signal:ctrl.signal});
      ms = Math.round(performance.now() - t0);
    } catch {}
    clearTimeout(to);

    const now = Date.now();
    samples.push([now, ms]);
    while (samples.length && samples[0][0] < now - SAMPLE_KEEP) samples.shift();
    addAgg(now, ms);

    if (ms >= 0){
      fails = 0; lastMs = ms;
      if (isDown) goUp(now);
      trackSlow(now, ms);
    } else {
      fails++;
      if (fails >= FAILS_TO_DOWN) goDown(now - INTERVAL * (FAILS_TO_DOWN - 1));
    }
    wr(K.alive, now);
    setStatus(); renderStats(); drawLatency();
    pingRing();
  }

  // ---------- 速度測定 ----------
  async function speedTest(){
    if (isDown || testing) return;
    testing = true;
    const btn = $("btnSpeed"); btn.disabled = true; btn.textContent = "測定中…"; btn.classList.add("busy");
    const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 30000);
    try {
      const t0 = performance.now();
      const res = await fetch(SPEED_URL + "&r=" + Date.now(), {cache:"no-store", signal:ctrl.signal});
      if (!res.ok) throw new Error("http");
      const reader = res.body.getReader();
      let got = 0, tFirst = 0, firstLen = 0;
      for (;;){
        const {done, value} = await reader.read();
        if (done) break;
        if (!tFirst){ tFirst = performance.now(); firstLen = value.length; }
        got += value.length;
      }
      const tEnd = performance.now(), dt = (tEnd - tFirst) / 1000;
      const mbps = (got - firstLen > 0 && dt > 0.02)
        ? (got - firstLen) * 8 / dt / 1e6
        : got * 8 / ((tEnd - t0) / 1000) / 1e6;
      if (isFinite(mbps) && mbps > 0){
        const t = Date.now(), a = bucket(t);
        a.sp += mbps; a.sn++;
        lastSpeed = {t, mbps}; wr(K.speed, lastSpeed); dirty = true;
      }
    } catch {
      $("sSpeedT").textContent = "測定に失敗しました(" + fmtClock(Date.now()) + ")";
    }
    clearTimeout(to);
    testing = false; btn.disabled = false; btn.textContent = "今すぐ測定"; btn.classList.remove("busy");
    renderStats(); renderBars();
  }
  function tickSpeed(){
    if (!set.speedMin || isDown || testing) return;
    const last = lastSpeed ? lastSpeed.t : 0;
    if (Date.now() - last >= set.speedMin * 60000) speedTest();
  }

  // ---------- グローバルIP ----------
  async function checkIP(){
    if (isDown) return;
    const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 5000);
    let ip = null;
    try {
      const r = await fetch(IP_URL, {cache:"no-store", signal:ctrl.signal});
      const j = await r.json();
      if (j && typeof j.ip === "string") ip = j.ip;
    } catch {}
    clearTimeout(to);
    if (!ip) return;
    const last = rd(K.lastip, null);
    if (ip !== last){
      ips.push({t:Date.now(), from:last, to:ip});
      if (ips.length > 200) ips.shift();
      wr(K.ips, ips); wr(K.lastip, ip);
    }
    currentIp = ip;
    renderIps(); renderStats();
  }

  // ---------- 起動時の空白検出 ----------
  (function(){
    const last = Number(rd(K.alive, 0)), now = Date.now();
    if (last && now - last > GAP_THRESHOLD){
      logs.push({type:"gap", start:last, end:now});
      save();
    }
  })();

  window.addEventListener("offline", () => { fails = FAILS_TO_DOWN; goDown(Date.now()); });
  window.addEventListener("online", () => { check(); });

  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > GAP_THRESHOLD){
      logs.push({type:"gap", start:lastTick, end:now});
      save(); renderEvents();
    }
    lastTick = now;
  }, 5000);

  window.addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
  setInterval(() => { if (dirty) save(); }, 30000);

  // ---------- 操作 ----------
  $("rangeBtns").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    range = Number(b.dataset.r);
    for (const x of $("rangeBtns").children) x.classList.toggle("on", x === b);
    animateLatency();
  });
  window.addEventListener("resize", drawLatency);
  $("btnSpeed").onclick = speedTest;

  $("setSlow").value = set.slowMs;
  $("setSpeed").value = String(set.speedMin);
  $("setHide").checked = !!set.hideIp;
  $("setSlow").onchange = e => {
    const v = Math.min(5000, Math.max(50, Number(e.target.value) || 300));
    set.slowMs = v; e.target.value = v; wr(K.set, set); drawLatency();
  };
  $("setSpeed").onchange = e => { set.speedMin = Number(e.target.value); wr(K.set, set); };
  $("setHide").onchange = e => { set.hideIp = e.target.checked; wr(K.set, set); renderIps(); renderStats(); };

  $("btnExport").onclick = () => {
    save();
    const data = {version:2, logs, ips, aggs, samples, lastSpeed};
    const blob = new Blob([JSON.stringify(data)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "netlog.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("btnImport").onclick = () => $("file").click();
  $("file").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const okLog = l => l && typeof l.start === "number" && typeof l.end === "number";
      if (Array.isArray(data)){
        logs = data.filter(okLog);
      } else if (data && typeof data === "object"){
        if (Array.isArray(data.logs)) logs = data.logs.filter(okLog);
        if (Array.isArray(data.ips)) ips = data.ips.filter(x => x && typeof x.t === "number" && typeof x.to === "string");
        if (data.aggs && typeof data.aggs === "object"){
          aggs = {};
          for (const k in data.aggs){
            const a = data.aggs[k];
            if (a && [a.n, a.ok, a.sum, a.max, a.slow, a.sp, a.sn].every(v => typeof v === "number")) aggs[k] = a;
          }
        }
        if (Array.isArray(data.samples)) samples = data.samples.filter(s => Array.isArray(s) && typeof s[0] === "number" && typeof s[1] === "number");
        if (data.lastSpeed && typeof data.lastSpeed.mbps === "number" && typeof data.lastSpeed.t === "number"){
          lastSpeed = data.lastSpeed; wr(K.speed, lastSpeed);
        }
        if (ips.length){ currentIp = ips[ips.length - 1].to; wr(K.lastip, currentIp); }
      } else throw 0;
      save(); renderAll();
    } catch { alert("読み込めませんでした。netlog.json の形式か確認してください。"); }
    e.target.value = "";
  };
  $("btnClear").onclick = () => {
    if (!confirm("ログとグラフのデータを全部消します。よろしいですか?")) return;
    logs = []; aggs = {}; samples = []; ips = []; lastSpeed = null; currentIp = null;
    try { for (const k of [K.speed, K.lastip]) localStorage.removeItem(k); } catch {}
    save(); renderAll();
  };

  function renderAll(){
    renderEvents(); renderIps(); renderHeat(); renderBars(); renderStats(); setStatus(); drawLatency();
  }

  // ---------- 演出 ----------
  function pingRing(){
    const d = $("dot");
    d.classList.remove("ping"); void d.offsetWidth; d.classList.add("ping");
  }
  function flash(rgb){
    if (!set.bg) return;
    const f = $("flash");
    f.style.setProperty("--fc", rgb);
    f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  }
  function animateLatency(){
    if (!set.bg){ reveal = 1; drawLatency(); return; }
    const t0 = performance.now(), D = 900;
    reveal = 0;
    (function step(t){
      const p = Math.min(1, (t - t0) / D);
      reveal = 1 - Math.pow(1 - p, 3);
      drawLatency();
      if (p < 1) requestAnimationFrame(step); else reveal = 1;
    })(t0);
  }

  // 数値が変わったらポンと跳ねる
  const lastTxt = new WeakMap();
  const mo = new MutationObserver(list => {
    for (const m of list){
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!el || !el.matches(".stats strong")) continue;
      const t = el.textContent;
      if (lastTxt.get(el) !== t){
        if (lastTxt.has(el)){ el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
        lastTxt.set(el, t);
      }
    }
  });
  document.querySelectorAll(".stats strong").forEach(el => {
    lastTxt.set(el, el.textContent);
    mo.observe(el, {childList:true, characterData:true, subtree:true});
  });

  // 登場演出の順番
  Array.from(document.querySelector("main").children).forEach((el, i) => el.style.setProperty("--i", i));
  document.querySelectorAll(".stats > .card").forEach((el, i) => el.style.setProperty("--i", i));
  setTimeout(() => { intro = false; }, 3500);

  // 背景のネットワーク演出(切断中は赤、不安定はオレンジ)
  const bgc = $("bg"), bg = bgc.getContext("2d");
  let bgW = 0, bgH = 0, bgPts = [], bgRaf = 0, bgLast = 0;
  function bgResize(){
    const d = Math.min(window.devicePixelRatio || 1, 2);
    bgW = window.innerWidth; bgH = window.innerHeight;
    bgc.width = bgW * d; bgc.height = bgH * d;
    bg.setTransform(d, 0, 0, d, 0, 0);
    const n = Math.round(Math.min(48, bgW * bgH / 30000));
    bgPts = Array.from({length:n}, () => ({x:Math.random() * bgW, y:Math.random() * bgH, vx:(Math.random() - .5) * .3, vy:(Math.random() - .5) * .3}));
  }
  function bgFrame(t){
    bgRaf = requestAnimationFrame(bgFrame);
    if (t - bgLast < 33) return;
    bgLast = t;
    bg.clearRect(0, 0, bgW, bgH);
    const col = isDown ? "255,92,92" : slowSince ? "255,169,77" : "61,220,132";
    for (const p of bgPts){
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > bgW) p.vx *= -1;
      if (p.y < 0 || p.y > bgH) p.vy *= -1;
    }
    for (let i = 0; i < bgPts.length; i++){
      const a = bgPts[i];
      bg.fillStyle = "rgba(" + col + ",.5)";
      bg.beginPath(); bg.arc(a.x, a.y, 1.8, 0, 7); bg.fill();
      for (let j = i + 1; j < bgPts.length; j++){
        const b = bgPts[j], dx = a.x - b.x, dy = a.y - b.y, dd = dx * dx + dy * dy;
        if (dd < 16900){
          bg.strokeStyle = "rgba(" + col + "," + (0.2 * (1 - dd / 16900)).toFixed(3) + ")";
          bg.beginPath(); bg.moveTo(a.x, a.y); bg.lineTo(b.x, b.y); bg.stroke();
        }
      }
    }
  }
  function bgApply(){
    document.body.classList.toggle("noanim", !set.bg);
    const run = set.bg && document.visibilityState === "visible";
    if (run && !bgRaf){ bgResize(); bgRaf = requestAnimationFrame(bgFrame); }
    else if (!run && bgRaf){ cancelAnimationFrame(bgRaf); bgRaf = 0; bg.clearRect(0, 0, bgW, bgH); }
  }
  window.addEventListener("resize", () => { if (bgRaf) bgResize(); });
  document.addEventListener("visibilitychange", bgApply);
  $("setAnim").checked = !!set.bg;
  $("setAnim").onchange = e => { set.bg = e.target.checked; wr(K.set, set); bgApply(); animateLatency(); };

  // ---------- この端末の情報 ----------
  function uaInfo(){
    const ua = navigator.userAgent;
    let os = "不明";
    if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Android/.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
    else if (/Mac OS X/.test(ua)) os = "macOS";
    else if (/CrOS/.test(ua)) os = "ChromeOS";
    else if (/Linux/.test(ua)) os = "Linux";
    let br = "不明";
    if (/Edg\//.test(ua)) br = "Edge";
    else if (/OPR\//.test(ua)) br = "Opera";
    else if (/Firefox\//.test(ua)) br = "Firefox";
    else if (/Chrome\//.test(ua)) br = "Chrome";
    else if (/Safari\//.test(ua)) br = "Safari";
    return {os, br};
  }
  function renderDevice(){
    const el = $("dev"); el.textContent = "";
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const u = uaInfo();
    let net = "非対応", netSub = "このブラウザでは取得できません";
    if (c && c.effectiveType){
      net = String(c.effectiveType).toUpperCase();
      netSub = (c.downlink != null ? "下り目安 " + c.downlink + " Mbps" : "") + (c.rtt != null ? " / RTT " + c.rtt + " ms" : "") + (c.saveData ? " / データ節約" : "");
    }
    const items = [
      ["OS", u.os, ""],
      ["ブラウザ", u.br, ""],
      ["CPUコア数", navigator.hardwareConcurrency ? navigator.hardwareConcurrency + " コア" : "取得不可", ""],
      ["メモリ", navigator.deviceMemory ? navigator.deviceMemory + " GB以上" : "取得不可", "ブラウザが丸めた値"],
      ["画面", screen.width + "×" + screen.height, "倍率 " + (window.devicePixelRatio || 1)],
      ["言語", navigator.language || "-", (Intl.DateTimeFormat().resolvedOptions().timeZone) || ""],
      ["回線の種類(推定)", net, netSub],
      ["ブラウザの接続状態", navigator.onLine ? "オンライン" : "オフライン", ""]
    ];
    items.forEach(([l, v, s], i) => {
      const card = document.createElement("div"); card.className = "card";
      const a = document.createElement("span"); a.textContent = l;
      const b = document.createElement("strong"); b.textContent = v;
      card.appendChild(a); card.appendChild(b);
      if (s){ const sm = document.createElement("small"); sm.textContent = s; card.appendChild(sm); }
      card.style.setProperty("--i", i);
      if (!intro) card.style.animation = "none";
      el.appendChild(card);
    });
  }
  renderDevice();
  const conn = navigator.connection;
  if (conn && conn.addEventListener) conn.addEventListener("change", renderDevice);
  window.addEventListener("online", renderDevice);
  window.addEventListener("offline", renderDevice);

  renderAll();
  bgApply();
  setTimeout(animateLatency, 400);
  check();
  setInterval(check, INTERVAL);
  setTimeout(checkIP, 2000);
  setInterval(checkIP, IP_INTERVAL);
  setTimeout(tickSpeed, 8000);
  setInterval(tickSpeed, 30000);
  setInterval(() => { renderHeat(); renderBars(); }, 60000);
})();
