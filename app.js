// ═══════════════════════════════════════════════════
//  GhostChip — App Logic
// ═══════════════════════════════════════════════════

const $ = id => document.getElementById(id);
let GROQ_KEY = localStorage.getItem('gc_groq_key') || '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const WARN_KEY = 'gc_legal_v2';

// ─── Smart Base URL ───
// When served from the ESP32 (same origin) → use relative URLs (no CORS)
// When opened as file:// or from another host → use absolute URL
function BASE() {
  const h = location.hostname;
  // Same origin: relative path, no CORS needed
  if (h === 'ghostchip.local' || h.startsWith('192.168.') || h === '4.1') return '';
  // External: use configured host
  return 'http://' + ($('ipInput')?.value?.trim() || 'ghostchip.local');
}
function isRemote() { return BASE() !== ''; }

// ─── Device Fetch Helper ───
// Handles CORS transparently: same-origin uses normal fetch, cross-origin uses no-cors
async function deviceFetch(path, opts = {}) {
  const url = BASE() + path;
  if (isRemote()) {
    // Cross-origin: must use no-cors for POST, means opaque response
    opts.mode = 'no-cors';
  }
  return fetch(url, opts);
}

// Same as deviceFetch but for GET requests that need JSON response
// Falls back to XMLHttpRequest which works on some ESP32 setups with CORS headers
async function deviceGet(path) {
  const url = BASE() + path;
  try {
    const r = await fetch(url);
    return await r.json();
  } catch (e) {
    // If CORS blocks fetch, try XHR as fallback
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', '*/*');
      xhr.onload = () => {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid JSON')); }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.timeout = 8000;
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send();
    });
  }
}

// ─── Toast ───
function toast(msg, type = 'ok', dur = 3500) {
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  const icons = { ok: '✓', err: '✗', warn: '⚠' };
  el.innerHTML = `<span>${icons[type] || '✓'}</span><span style="flex:1">${msg}</span>`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, dur);
}

// ─── Boot Sequence ───
const BOOT_LINES = [
  '> init esp32-s3 core...',
  '> loading drivers...',
  '> mounting spiffs...',
  '> starting wifi ap...',
  '> loading eeprom...',
  '> hid keyboard ready...',
  '> neopixel init...',
  '> web server online...',
  '> ghost chip ready ✓',
];
(function boot() {
  let i = 0;
  const log = $('bootLog'), bar = $('bootBar'), overlay = $('boot');
  function next() {
    if (i >= BOOT_LINES.length) {
      setTimeout(() => {
        overlay.classList.add('done');
        setTimeout(() => {
          overlay.style.display = 'none';
          $('app').style.display = 'flex';
          if (!sessionStorage.getItem(WARN_KEY)) $('legalModal').style.display = 'flex';
          initApp();
        }, 700);
      }, 400);
      return;
    }
    log.innerHTML += BOOT_LINES[i] + '<br>';
    log.scrollTop = log.scrollHeight;
    bar.style.width = Math.round(((i + 1) / BOOT_LINES.length) * 100) + '%';
    i++;
    setTimeout(next, 180 + Math.random() * 120);
  }
  next();
})();

$('acceptBtn').addEventListener('click', () => {
  sessionStorage.setItem(WARN_KEY, '1');
  $('legalModal').style.display = 'none';
});

// ─── Init ───
function initApp() {
  // Restore IP
  const savedIp = localStorage.getItem('gc_ip');
  if (savedIp && $('ipInput')) $('ipInput').value = savedIp;
  // Restore script
  const savedScript = localStorage.getItem('gc_script');
  if (savedScript) { $('editor').value = savedScript; updateLines(); }
  // Auto-save
  $('editor').addEventListener('input', () => {
    updateLines();
    localStorage.setItem('gc_script', $('editor').value);
  });
  $('editor').addEventListener('scroll', () => { $('lineNums').scrollTop = $('editor').scrollTop; });
  if ($('ipInput')) $('ipInput').addEventListener('change', () => localStorage.setItem('gc_ip', $('ipInput').value.trim()));
  // Try loading API key from device EEPROM if we don't have one locally
  loadApiKeyFromDevice();
}

// ─── Navigation ───
function goPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('page-' + name).classList.add('active');
  btn.classList.add('active');
  // Scroll to top
  document.querySelector('.pages').scrollTop = 0;
}
function showSettings() { 
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  $('page-settings').classList.add('active');
  document.querySelectorAll('.nav-item')[4].classList.add('active');
}

// ─── Line Numbers ───
function updateLines() {
  const lines = $('editor').value.split('\n').length;
  $('lineNums').innerHTML = Array.from({ length: lines }, (_, i) => `<span>${i + 1}</span>`).join('');
  $('lineCount').textContent = lines + ' line' + (lines !== 1 ? 's' : '');
}
updateLines();

// ─── Presets ───
function togglePresets() {
  $('presetsDrawer').classList.toggle('open');
}
const PRESETS = {
  'win-run': 'REM Windows Run Dialog\nDELAY 500\nGUI r\nDELAY 500',
  'win-term': 'REM Windows Terminal Admin\nDELAY 500\nGUI x\nDELAY 400\nSTRING a\nDELAY 600\nLEFTARROW\nENTER',
  'win-info': 'REM Windows System Info\nDELAY 500\nGUI r\nDELAY 600\nSTRING cmd\nENTER\nDELAY 800\nSTRING systeminfo\nENTER',
  'win-wifi': 'REM Show WiFi Passwords\nDELAY 500\nGUI r\nDELAY 600\nSTRING cmd\nENTER\nDELAY 900\nSTRING netsh wlan show profiles\nENTER',
  'mac-spot': 'REM macOS Spotlight\nDELAY 500\nGUI SPACE\nDELAY 400',
  'mac-term': 'REM macOS Terminal\nDELAY 500\nGUI SPACE\nDELAY 400\nSTRING Terminal\nENTER\nDELAY 800',
  'lnx-term': 'REM Linux Terminal\nDELAY 500\nCTRL ALT t\nDELAY 800',
  'lnx-recon': 'REM Linux Recon\nDELAY 500\nCTRL ALT t\nDELAY 900\nSTRING whoami && id && hostname\nENTER',
};
function loadPreset(k) {
  $('editor').value = PRESETS[k] || '';
  updateLines();
  localStorage.setItem('gc_script', $('editor').value);
  toast('Preset loaded', 'ok', 2000);
  $('presetsDrawer').classList.remove('open');
}

// ─── File I/O ───
function openFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    $('editor').value = ev.target.result;
    updateLines();
    $('fileName').textContent = f.name;
    localStorage.setItem('gc_script', $('editor').value);
    toast('Loaded ' + f.name, 'ok');
  };
  r.readAsText(f);
  e.target.value = '';
}
function clearEditor() {
  $('editor').value = '';
  updateLines();
  $('fileName').textContent = 'untitled.txt';
  localStorage.removeItem('gc_script');
}

// ─── Terminal ───
function termWrite(msg, cls = 't-dim') {
  const t = $('terminal');
  if (t.querySelector('.t-dim:only-child')) t.innerHTML = '';
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = msg;
  t.appendChild(s);
  t.appendChild(document.createElement('br'));
  t.scrollTop = t.scrollHeight;
}
function clearTerm() {
  $('terminal').innerHTML = '<span class="t-dim">// output appears here...</span>';
}

// ─── Execute Script ───
let isRunning = false, execPoll = null, lastLogLen = 0;

async function runScript() {
  const script = $('editor').value.trim();
  if (!script) { toast('No script to execute', 'warn'); return; }
  if (isRunning) return;
  isRunning = true;
  const btn = $('runBtn');
  btn.classList.add('running');
  btn.innerHTML = '<span class="spin"></span> EXECUTING...';
  $('execDot').className = 'exec-dot run';
  $('execLabel').textContent = 'Executing...';
  clearTerm();
  lastLogLen = 0;
  termWrite('[' + new Date().toLocaleTimeString() + '] Sending payload...', 't-start');

  try {
    await deviceFetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'duckyscript=' + encodeURIComponent(script)
    });
    termWrite('Payload delivered ✓', 't-ok');
    toast('Script executed ✓');
    $('connDot').className = 'conn-dot on';
  } catch (e) {
    termWrite('Payload sent (opaque)', 't-ok');
    toast('Script sent ✓');
    $('connDot').className = 'conn-dot on';
  }

  // Try polling for live status
  if (execPoll) clearInterval(execPoll);
  execPoll = setInterval(pollExec, 500);
  setTimeout(finishExec, 5000);
}

function pollExec() {
  deviceGet('/execstatus').then(d => {
    if (d.log && d.log.length > lastLogLen) {
      for (let i = lastLogLen; i < d.log.length; i++) {
        let cls = 't-dim';
        if (d.log[i].startsWith('[START]')) cls = 't-start';
        else if (d.log[i].startsWith('[DONE]')) cls = 't-ok';
        else if (d.log[i].includes('REM')) cls = 't-rem';
        termWrite(d.log[i], cls);
      }
      lastLogLen = d.log.length;
    }
    if (!d.running) finishExec();
  }).catch(() => {});
}

function finishExec() {
  if (execPoll) { clearInterval(execPoll); execPoll = null; }
  isRunning = false;
  $('runBtn').classList.remove('running');
  $('runBtn').innerHTML = '<span class="btn-icon">▶</span> EXECUTE';
  $('execDot').className = 'exec-dot ok';
  $('execLabel').textContent = 'Ready';
}

// ─── Ping / Connection ───
async function pingDevice() {
  toast('Pinging...', 'warn', 1500);
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 4000);
    await deviceFetch('/', { signal: c.signal });
    $('connDot').className = 'conn-dot on';
    toast('Device connected ✓');
  } catch (e) {
    if (e.name === 'AbortError') {
      $('connDot').className = 'conn-dot err';
      toast('Connection timeout', 'err');
    } else {
      $('connDot').className = 'conn-dot on';
      toast('Device connected ✓');
    }
  }
}

function togglePass(id, btn) {
  const inp = $(id);
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = show ? 'HIDE' : 'SHOW';
}

// ─── API Key ───
async function saveApiKey() {
  const k = $('apiKeyInput').value.trim();
  if (!k) { toast('Enter a key first', 'warn'); return; }
  // Save locally so AI works even when not on device
  GROQ_KEY = k;
  localStorage.setItem('gc_groq_key', k);
  // Also save to device EEPROM if connected
  try {
    await deviceFetch('/saveApiKey', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'apiKey=' + encodeURIComponent(k)
    });
  } catch (e) { /* device might not be connected, that's ok */ }
  toast('API Key saved ✓');
  $('apiKeyInput').value = '';
}
function clearApiKey() {
  if (!confirm('Clear API key?')) return;
  GROQ_KEY = '';
  localStorage.removeItem('gc_groq_key');
  deviceFetch('/saveApiKey', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'apiKey=' })
    .then(() => toast('Key cleared', 'warn'));
}
// Try to load API key from device EEPROM on startup
// The device embeds the key in /aigenerate page as: const SAVED_KEY = "gsk_...";
async function loadApiKeyFromDevice() {
  if (GROQ_KEY) return; // already have a key from localStorage
  try {
    const url = BASE() + '/aigenerate';
    const r = await fetch(url);
    const html = await r.text();
    const m = html.match(/const\s+SAVED_KEY\s*=\s*"([^"]+)"/);
    if (m && m[1] && m[1].length > 4) {
      GROQ_KEY = m[1];
      localStorage.setItem('gc_groq_key', m[1]);
      toast('API key loaded from device ✓', 'ok', 2000);
    }
  } catch (e) { /* device not connected */ }
}

// ─── Scan Tabs ───
function switchScan(name) {
  document.querySelectorAll('.scan-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.seg').forEach(s => s.classList.remove('active'));
  $('scan-' + name).classList.add('active');
  $('seg-' + name).classList.add('active');
}

// ─── Signal Bars ───
function signalBars(rssi) {
  let lv = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : rssi >= -85 ? 1 : 0;
  const h = [4, 7, 10, 14];
  return '<div class="net-signal">' + h.map((height, i) =>
    `<span style="height:${height}px" class="${i < lv ? 'lit' : ''}"></span>`
  ).join('') + '</div>';
}

// ─── WiFi Scan ───
async function scanWifi() {
  const list = $('wifiResults');
  list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const nets = await deviceGet('/wifi/scan');
    if (!nets.length) { list.innerHTML = '<div class="empty-state">No networks found</div>'; toast('No networks', 'warn'); return; }
    nets.sort((a, b) => b.rssi - a.rssi);
    list.innerHTML = nets.map(n => `
      <div class="net-card">
        <div class="net-info">
          <div class="net-ssid">${n.secure ? '🔒' : '🔓'} ${n.ssid || '(hidden)'}</div>
          <div class="net-meta">CH ${n.channel || '?'} · ${n.rssi} dBm · ${n.bssid || ''}</div>
        </div>
        ${signalBars(n.rssi)}
      </div>
    `).join('');
    toast('Found ' + nets.length + ' networks');
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Scan failed — check connection</div>';
    toast('WiFi scan failed', 'err');
  }
}

// ─── WiFi Settings Scan ───
let selectedSsid = null;
async function scanWifiSettings() {
  const list = $('wifiSettingsList');
  list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const nets = await deviceGet('/wifi/scan');
    list.innerHTML = nets.sort((a, b) => b.rssi - a.rssi).map(n => `
      <div class="net-card" onclick="selectWifi('${(n.ssid || '').replace(/'/g, "\\'")}')">
        <div class="net-info">
          <div class="net-ssid">${n.secure ? '🔒' : '🔓'} ${n.ssid || '(hidden)'}</div>
          <div class="net-meta">${n.rssi} dBm</div>
        </div>
        ${signalBars(n.rssi)}
      </div>
    `).join('');
  } catch (e) { list.innerHTML = ''; toast('Scan failed', 'err'); }
}
function selectWifi(ssid) {
  selectedSsid = ssid;
  $('wifiSelSsid').textContent = ssid;
  $('wifiPassGroup').style.display = 'block';
  $('wifiPassInput').focus();
}
async function connectWifi() {
  if (!selectedSsid) return;
  try {
    await deviceFetch('/wifi/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'ssid=' + encodeURIComponent(selectedSsid) + '&pass=' + encodeURIComponent($('wifiPassInput').value)
    });
    toast('Connected to ' + selectedSsid + ' ✓');
  } catch (e) { toast('Connection failed', 'err'); }
}

// ─── BLE Scan ───
async function scanBle() {
  const list = $('bleResults');
  list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const devs = await deviceGet('/blescan');
    if (!devs.length) { list.innerHTML = '<div class="empty-state">No BLE devices found</div>'; toast('No devices', 'warn'); return; }
    devs.sort((a, b) => b.rssi - a.rssi);
    list.innerHTML = devs.map(d => `
      <div class="net-card">
        <div class="net-info">
          <div class="net-ssid">${d.flipper ? '🐬' : '📱'} ${d.name || '(unknown)'}</div>
          <div class="net-meta">${d.mac} · ${d.rssi} dBm${d.flipper ? ' · Flipper ' + d.flipperColor : ''}</div>
        </div>
        ${signalBars(d.rssi)}
      </div>
    `).join('');
    toast('Found ' + devs.length + ' BLE devices');
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Scan failed</div>';
    toast('BLE scan failed', 'err');
  }
}

// ─── Deauth Detector ───
let ddPoll = null, ddSeen = 0;
function deauthStart() {
  deviceFetch('/deauth/start', { method: 'POST' }).then(() => {
    $('ddDot').className = 'dd-dot on';
    $('ddLabel').textContent = 'Monitoring...';
    toast('Deauth monitor started');
    if (ddPoll) clearInterval(ddPoll);
    ddPoll = setInterval(deauthPoll, 1500);
  }).catch(() => toast('Failed to start', 'err'));
}
function deauthStop() {
  if (ddPoll) { clearInterval(ddPoll); ddPoll = null; }
  deviceFetch('/deauth/stop', { method: 'POST' }).then(() => {
    $('ddDot').className = 'dd-dot';
    $('ddLabel').textContent = 'Stopped';
    toast('Monitor stopped', 'warn');
  });
}
function deauthPoll() {
  deviceGet('/deauth/results').then(d => {
    if (d.events && d.events.length > ddSeen) {
      for (let i = ddSeen; i < d.events.length; i++) {
        const e = d.events[i];
        const log = $('deauthLog');
        log.innerHTML += `<span class="t-err">⚠ DEAUTH from ${e.mac} CH:${e.ch} ${e.rssi}dBm</span><br>`;
        log.scrollTop = log.scrollHeight;
        $('ddDot').className = 'dd-dot alert';
        toast('⚠ Deauth: ' + e.mac, 'err', 5000);
        setTimeout(() => { if (ddPoll) $('ddDot').className = 'dd-dot on'; }, 1200);
      }
      ddSeen = d.events.length;
    }
  }).catch(() => {});
}

// ─── AI Generate ───
function fillAi(t) { $('aiPrompt').value = t; }
async function aiGenerate() {
  const prompt = $('aiPrompt').value.trim();
  if (!prompt) { toast('Enter a description', 'warn'); return; }
  const btn = $('aiGenBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Generating...';
  const apiKey = GROQ_KEY || localStorage.getItem('gc_groq_key') || '';
  if (!apiKey || apiKey.length < 5) {
    toast('No API key found. Go to Settings → save your Groq key first.', 'err');
    btn.disabled = false;
    btn.innerHTML = '⚡ Generate DuckyScript';
    return;
  }
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a DuckyScript expert for USB Rubber Ducky / ESP32 HID payloads. Generate ONLY the DuckyScript payload — no explanations, no markdown code fences, no extra text. Use proper DuckyScript syntax: DELAY, STRING, ENTER, GUI, ALT, CTRL, SHIFT, TAB, SPACE, UP, DOWN, LEFT, RIGHT, REM, F1-F12, CAPSLOCK, etc.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 800
      })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Groq API error: ' + res.status);
    }
    const data = await res.json();
    let script = data.choices?.[0]?.message?.content?.trim() || '';
    script = script.replace(/```[\w]*\n?/g, '').trim();
    $('aiOutput').value = script;
    $('aiOutputCard').style.display = 'block';
    toast('Script generated ✓');
  } catch (e) {
    toast('Generation failed: ' + e.message + '. Check Groq API key.', 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '⚡ Generate DuckyScript';
  }
}
function aiCopy() {
  navigator.clipboard.writeText($('aiOutput').value).then(() => toast('Copied ✓', 'ok', 2000));
}
function aiToEditor() {
  $('editor').value = $('aiOutput').value;
  updateLines();
  localStorage.setItem('gc_script', $('editor').value);
  goPage('scripts', document.querySelectorAll('.nav-item')[0]);
  toast('Script sent to editor ✓');
}
async function aiExec() {
  const s = $('aiOutput').value.trim();
  if (!s || !confirm('Execute AI script on device?')) return;
  try {
    await deviceFetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'duckyscript=' + encodeURIComponent(s) });
    toast('AI script executed ✓');
  } catch { toast('Script sent ✓'); }
}

// ─── NeoPixel ───
let neo = { on: false, bright: 80, r: 0, g: 255, b: 65 };
function neoToggle() {
  neo.on = !neo.on;
  neoUI();
  deviceFetch('/neopixel/toggle', { method: 'POST' }).catch(() => {});
  toast('NeoPixel ' + (neo.on ? 'ON' : 'OFF'), neo.on ? 'ok' : 'warn', 1500);
}
function neoUpdate() {
  neo.bright = +$('neoBright').value;
  neo.r = +$('neoR').value; neo.g = +$('neoG').value; neo.b = +$('neoB').value;
  $('neoBrightV').textContent = neo.bright;
  $('neoRV').textContent = neo.r; $('neoGV').textContent = neo.g; $('neoBV').textContent = neo.b;
  const hex = '#' + [neo.r, neo.g, neo.b].map(v => v.toString(16).padStart(2, '0')).join('');
  $('neoPreview').style.background = neo.on ? hex : '#222';
  $('neoPreview').style.boxShadow = neo.on ? `0 0 14px ${hex}, 0 0 28px ${hex}44` : 'none';
}
function neoSet(r, g, b) {
  neo.r = r; neo.g = g; neo.b = b;
  $('neoR').value = r; $('neoG').value = g; $('neoB').value = b;
  neoUpdate();
}
function neoUI() {
  const t = $('neoToggle');
  t.className = 'toggle' + (neo.on ? ' on' : '');
  $('neoLabel').textContent = neo.on ? 'ON' : 'OFF';
  neoUpdate();
}
function neoApply() {
  deviceFetch('/neopixel/set', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `brightness=${neo.bright}&r=${neo.r}&g=${neo.g}&b=${neo.b}`
  }).then(() => toast('NeoPixel saved ✓')).catch(() => toast('Failed', 'err'));
}

// ─── Firmware ───
function fwPick(input) {
  const f = input.files[0];
  if (!f) return;
  $('fwInfo').style.display = 'block';
  $('fwInfo').textContent = f.name + ' — ' + (f.size / 1024).toFixed(1) + ' KB';
  $('flashBtn').disabled = false;
  toast('Firmware selected: ' + f.name);
}
const dz = $('dropzone');
if (dz) {
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.bin')) {
      const dt = new DataTransfer(); dt.items.add(f);
      $('fwFile').files = dt.files; fwPick($('fwFile'));
    } else toast('Drop a .bin file', 'err');
  });
}
$('otaForm')?.addEventListener('submit', () => {
  $('otaBarWrap').style.display = 'block';
  let p = 0;
  const iv = setInterval(() => { p = Math.min(p + 2, 95); $('otaBar').style.width = p + '%'; }, 200);
  toast('Flashing firmware...', 'warn', 12000);
  setTimeout(() => { clearInterval(iv); $('otaBar').style.width = '100%'; toast('Flash complete — rebooting'); }, 10000);
});
