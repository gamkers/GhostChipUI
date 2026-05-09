// ═══════════════════════════════════════════════════
//  GhostChip — App Logic
// ═══════════════════════════════════════════════════

const $ = id => document.getElementById(id);
let GROQ_KEY = localStorage.getItem('gc_groq_key') || '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const WARN_KEY = 'gc_legal_v2';

// ═══════════════════════════════════════════════════
//  Global Application State
// ═══════════════════════════════════════════════════
var kbActiveMods = { shift: false, ctrl: false, alt: false, gui: false };
var simRunning = false, simAbort = false;
var targetOS = 'windows';
var scOS = 'windows';
var scCmdType = 'run';
var neo = { on: false, bright: 80, r: 0, g: 255, b: 65 };
var isRunning = false, execPoll = null, lastLogLen = 0;
var selectedSsid = null;
var ddPoll = null, ddSeen = 0;
var voiceRecog = null, isListening = false;


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
  let bootFinished = false;
  function finishBoot() {
    if (bootFinished) return;
    bootFinished = true;
    overlay.classList.add('done');
    setTimeout(() => {
      overlay.style.display = 'none';
      $('app').style.display = 'flex';
      if (!sessionStorage.getItem(WARN_KEY)) $('legalModal').style.display = 'flex';
      try { initApp(); }
      catch (e) {
        console.error('[GhostChip] init failed:', e);
        toast('Startup recovered. Check settings if a feature is offline.', 'warn', 4500);
      }
    }, 700);
  }
  function next() {
    if (i >= BOOT_LINES.length) {
      setTimeout(finishBoot, 400);
      return;
    }
    log.innerHTML += BOOT_LINES[i] + '<br>';
    log.scrollTop = log.scrollHeight;
    bar.style.width = Math.round(((i + 1) / BOOT_LINES.length) * 100) + '%';
    i++;
    setTimeout(next, 180 + Math.random() * 120);
  }
  next();
  setTimeout(finishBoot, 5000);
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

// ─── Line Numbers + Syntax Highlighting ───
const DUCKY_CMDS = /^(DELAY|STRING|ENTER|GUI|ALT|CTRL|SHIFT|TAB|SPACE|REPEAT|DEFAULTDELAY|DEFAULT_DELAY|PRINT|PRINTLN|WINDOWS|COMMAND|MENU|APP|DELETE|HOME|END|INSERT|PAGEUP|PAGEDOWN|UPARROW|DOWNARROW|LEFTARROW|RIGHTARROW|SCROLLLOCK|NUMLOCK|BREAK|PAUSE|ESC|ESCAPE)(?=\s|$)/;
const DUCKY_KEYS = /\b(F[1-9]|F1[0-2]|UP|DOWN|LEFT|RIGHT|CAPSLOCK|BACKSPACE|PRINTSCREEN)\b/g;
const DUCKY_MODS = /\b(CTRL|SHIFT|ALT|GUI|COMMAND|WINDOWS)\b/g;

function highlightDucky(code) {
  return code.split('\n').map(line => {
    const trimmed = line.trimStart();
    // Comments
    if (trimmed.startsWith('REM')) return `<span class="hl-rem">${escHtml(line)}</span>`;
    // STRING lines
    if (trimmed.startsWith('STRING ') || trimmed.startsWith('PRINTLN ') || trimmed.startsWith('PRINT ')) {
      const sp = line.indexOf(' ');
      return `<span class="hl-cmd">${escHtml(line.slice(0, sp))}</span> <span class="hl-str">${escHtml(line.slice(sp + 1))}</span>`;
    }
    // DELAY with numbers
    if (trimmed.startsWith('DELAY ') || trimmed.startsWith('DEFAULTDELAY ') || trimmed.startsWith('DEFAULT_DELAY ')) {
      const sp = line.indexOf(' ');
      return `<span class="hl-cmd">${escHtml(line.slice(0, sp))}</span> <span class="hl-num">${escHtml(line.slice(sp + 1))}</span>`;
    }
    // REPEAT
    if (trimmed.startsWith('REPEAT ')) {
      const sp = line.indexOf(' ');
      return `<span class="hl-cmd">${escHtml(line.slice(0, sp))}</span> <span class="hl-num">${escHtml(line.slice(sp + 1))}</span>`;
    }
    // Commands with modifiers/keys
    let hl = escHtml(line);
    hl = hl.replace(/^(\s*)(CTRL|SHIFT|ALT|GUI|COMMAND|WINDOWS)\b/g, '$1<span class="hl-mod">$2</span>');
    hl = hl.replace(DUCKY_CMDS, '<span class="hl-cmd">$1</span>');
    hl = hl.replace(DUCKY_KEYS, '<span class="hl-key">$1</span>');
    hl = hl.replace(/\b(CTRL|SHIFT|ALT|GUI|COMMAND|WINDOWS)\b/g, '<span class="hl-mod">$1</span>');
    return hl;
  }).join('\n');
}
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function updateLines() {
  const code = $('editor').value;
  const lines = code.split('\n').length;
  $('lineNums').innerHTML = Array.from({ length: lines }, (_, i) => `<span>${i + 1}</span>`).join('');
  $('lineCount').textContent = lines + ' line' + (lines !== 1 ? 's' : '');
  // Syntax highlight overlay
  const hl = $('editorHighlight');
  if (hl) hl.querySelector('code').innerHTML = highlightDucky(code) + '\n';
}
updateLines();
// Sync scroll between editor and highlight
const edEl = $('editor');
if (edEl) {
  edEl.addEventListener('scroll', () => {
    const hl = $('editorHighlight');
    if (hl) { hl.scrollTop = edEl.scrollTop; hl.scrollLeft = edEl.scrollLeft; }
  });
}

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
function terminalReset() {
  $('terminal').innerHTML = '<div><span class="t-dim">Terminal initialized...</span></div>';
  lastLogLen = 0;
}

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
// Only runs when on the device (HTTP same-origin), not from GitHub Pages (HTTPS)
async function loadApiKeyFromDevice() {
  if (GROQ_KEY) { console.log('[GhostChip] API key already loaded from localStorage'); return; }
  if (location.protocol === 'https:') { console.log('[GhostChip] On HTTPS — skipping device key fetch. Use Settings to enter key.'); return; }
  try {
    const url = BASE() + '/aigenerate';
    console.log('[GhostChip] Fetching API key from:', url);
    const r = await fetch(url);
    const html = await r.text();
    const m = html.match(/const\s+SAVED_KEY\s*=\s*"([^"]+)"/);
    if (m && m[1] && m[1].length > 4) {
      GROQ_KEY = m[1];
      localStorage.setItem('gc_groq_key', m[1]);
      console.log('[GhostChip] API key loaded from device ✓');
      toast('API key loaded from device ✓', 'ok', 2000);
    } else {
      console.log('[GhostChip] No SAVED_KEY found in /aigenerate response');
    }
  } catch (e) { console.log('[GhostChip] Device not reachable:', e.message); }
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
// ═══════════════════════════════════════════════════
//  WIFI SCANNER
// ═══════════════════════════════════════════════════
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
// ═══════════════════════════════════════════════════
//  DEAUTH LOGS
// ═══════════════════════════════════════════════════
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

// ─── Voice Input ───
function toggleVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('Speech recognition not supported in this browser', 'err');
    return;
  }

  if (isListening && voiceRecog) {
    voiceRecog.stop();
    return;
  }

  voiceRecog = new SpeechRecognition();
  voiceRecog.lang = 'en-US';
  voiceRecog.interimResults = true;
  voiceRecog.continuous = false;
  voiceRecog.maxAlternatives = 1;

  const btn = $('micBtn');
  const prompt = $('aiPrompt');
  let finalTranscript = prompt.value;

  voiceRecog.onstart = () => {
    isListening = true;
    btn.classList.add('listening');
    toast('🎙 Listening...', 'ok', 2000);
  };

  voiceRecog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) {
        finalTranscript += (finalTranscript ? ' ' : '') + t;
      } else {
        interim += t;
      }
    }
    prompt.value = finalTranscript + (interim ? ' ' + interim : '');
  };

  voiceRecog.onend = () => {
    isListening = false;
    btn.classList.remove('listening');
    if (finalTranscript.trim()) {
      toast('Voice captured ✓', 'ok', 1500);
    }
  };

  voiceRecog.onerror = (e) => {
    isListening = false;
    btn.classList.remove('listening');
    if (e.error === 'not-allowed') {
      toast('Microphone permission denied', 'err');
    } else if (e.error !== 'aborted') {
      toast('Voice error: ' + e.error, 'err');
    }
  };

  voiceRecog.start();
}

// ─── AI Generate ───
// ═══════════════════════════════════════════════════
//  AI GENERATE
// ═══════════════════════════════════════════════════
function setTargetOS(os, btn) {
  targetOS = os;
  document.querySelectorAll('.os-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
function fillAi(t) { $('aiPrompt').value = t; }

function getOSContext() {
  const map = {
    windows: 'Target OS is Windows. Use GUI r for Run dialog, cmd/powershell for terminal.',
    macos: 'Target OS is macOS. Use GUI SPACE for Spotlight, open Terminal.app via Spotlight.',
    linux: 'Target OS is Linux. Use CTRL ALT t to open terminal on most distros.'
  };
  return map[targetOS] || map.windows;
}

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
  $('aiOutput').value = '';
  $('aiOutputCard').style.display = 'none';
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
            content: `You are a DuckyScript expert for USB Rubber Ducky / ESP32 HID payloads. ${getOSContext()} Generate ONLY the DuckyScript payload — no explanations, no markdown code fences, no extra text. Use proper DuckyScript syntax: DELAY, STRING, ENTER, GUI, ALT, CTRL, SHIFT, TAB, SPACE, UP, DOWN, LEFT, RIGHT, REM, F1-F12, CAPSLOCK, etc.`
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

// ─── Multi-OS Converter ───
async function aiConvertOS(newOS) {
  const script = $('aiOutput').value.trim();
  if (!script) { toast('No script to convert', 'warn'); return; }
  const apiKey = GROQ_KEY || localStorage.getItem('gc_groq_key') || '';
  if (!apiKey || apiKey.length < 5) { toast('No API key. Save in Settings.', 'err'); return; }
  const osNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
  toast(`Converting to ${osNames[newOS]}...`, 'ok', 2000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: `Convert the following DuckyScript payload to work on ${osNames[newOS]}. Output ONLY the converted DuckyScript — no explanations, no code fences. Adapt all OS-specific commands (e.g. GUI r for Windows Run → GUI SPACE for macOS Spotlight, CTRL ALT t for Linux terminal). Keep the same overall logic and intent.` },
          { role: 'user', content: script }
        ],
        temperature: 0.2,
        max_tokens: 800
      })
    });
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    let converted = data.choices?.[0]?.message?.content?.trim() || '';
    converted = converted.replace(/```[\w]*\n?/g, '').trim();
    $('aiOutput').value = converted;
    toast(`Converted to ${osNames[newOS]} ✓`);
  } catch (e) { toast('Conversion failed: ' + e.message, 'err'); }
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
// ═══════════════════════════════════════════════════
//  NEOPIXEL
// ═══════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════
//  TOOL PANELS
// ═══════════════════════════════════════════════════
function openTool(name) {
  document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('open'));
  const panel = $('tool-' + name);
  if (panel) panel.classList.add('open');
}
function closeTool(name) {
  const panel = $('tool-' + name);
  if (panel) panel.classList.remove('open');
}

// ═══════════════════════════════════════════════════
//  PAYLOAD QUEUE
// ═══════════════════════════════════════════════════
let payloadQueue = JSON.parse(localStorage.getItem('gc_queue') || '[]');
let queueRunning = false;

function saveQueue() { localStorage.setItem('gc_queue', JSON.stringify(payloadQueue)); }

function addToQueue() {
  const script = $('editor').value.trim();
  if (!script) { toast('Write a script first', 'warn'); return; }
  const delay = parseInt($('queueDelay').value) || 0;
  const firstLine = script.split('\n').find(l => !l.trim().startsWith('REM') && l.trim()) || 'Payload';
  payloadQueue.push({ script, delay, name: firstLine.substring(0, 40) });
  saveQueue();
  renderQueue();
  toast('Added to queue ✓', 'ok', 1500);
  if (!$('queuePanel').classList.contains('open')) toggleQueuePanel();
}

function removeFromQueue(i) {
  payloadQueue.splice(i, 1);
  saveQueue();
  renderQueue();
}

function clearQueue() {
  if (!confirm('Clear entire queue?')) return;
  payloadQueue = [];
  saveQueue();
  renderQueue();
  toast('Queue cleared', 'warn', 1500);
}

function renderQueue() {
  const list = $('queueList');
  if (!list) return;
  if (!payloadQueue.length) {
    list.innerHTML = '<div class="empty-state">Queue empty — add scripts to chain</div>';
    $('runQueueBtn').style.display = 'none';
    $('clearQueueBtn').style.display = 'none';
    return;
  }
  $('runQueueBtn').style.display = 'block';
  $('clearQueueBtn').style.display = 'block';
  list.innerHTML = payloadQueue.map((item, i) => `
    <div class="queue-item" id="qi-${i}">
      <div class="qi-num">${i + 1}</div>
      <div class="qi-body">
        <div class="qi-name">${escHtml(item.name)}</div>
        <div class="qi-meta">${item.script.split('\\n').length} lines · ${item.delay}s delay</div>
      </div>
      <button class="qi-del" onclick="removeFromQueue(${i})" title="Remove">✕</button>
      <div class="qi-progress" style="width:0"></div>
    </div>
  `).join('');
}
renderQueue();

async function runQueue() {
  if (queueRunning || !payloadQueue.length) return;
  if (!confirm(`Execute ${payloadQueue.length} payloads sequentially?`)) return;
  queueRunning = true;
  $('runQueueBtn').disabled = true;
  $('runQueueBtn').innerHTML = '<span class="spin"></span> Running Queue...';

  for (let i = 0; i < payloadQueue.length; i++) {
    const item = payloadQueue[i];
    const el = $('qi-' + i);
    if (el) { el.classList.add('qi-active'); el.classList.remove('qi-done'); }

    // Wait delay
    if (item.delay > 0) {
      toast(`⏱ Waiting ${item.delay}s before payload ${i + 1}...`, 'warn', item.delay * 1000);
      for (let s = 0; s < item.delay * 10; s++) {
        await new Promise(r => setTimeout(r, 100));
        const pct = ((s + 1) / (item.delay * 10)) * 100;
        if (el) el.querySelector('.qi-progress').style.width = pct + '%';
      }
    }

    // Execute
    try {
      await deviceFetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'duckyscript=' + encodeURIComponent(item.script)
      });
      toast(`Payload ${i + 1} executed ✓`, 'ok', 2000);
    } catch (e) {
      toast(`Payload ${i + 1} sent ✓`, 'ok', 2000);
    }

    if (el) { el.classList.remove('qi-active'); el.classList.add('qi-done'); el.querySelector('.qi-progress').style.width = '100%'; }
  }

  queueRunning = false;
  $('runQueueBtn').disabled = false;
  $('runQueueBtn').innerHTML = '⚡ Run Queue';
  toast('Queue complete ✓');
}

// ═══════════════════════════════════════════════════
//  LIVE PAYLOAD SIMULATOR
// ═══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
//  LIVE PAYLOAD SIMULATOR
// ═══════════════════════════════════════════════════

function parseDucky(script) {
  return script.split('\n').filter(l => l.trim()).map(line => {
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toUpperCase();
    const arg = trimmed.substring(cmd.length).trim();
    return { cmd, arg, raw: trimmed };
  });
}

function simGetSpeed() {
  return parseInt($('simSpeed')?.value || '2');
}

function simDelay(ms) {
  return new Promise(r => {
    const actual = Math.max(ms / simGetSpeed(), 30);
    const id = setTimeout(r, actual);
    if (simAbort) { clearTimeout(id); r(); }
  });
}

async function simulatePayload() {
  const script = $('editor').value.trim();
  if (!script) { toast('No script to simulate', 'warn'); return; }
  if (simRunning) return;

  simRunning = true;
  simAbort = false;
  $('simOverlay').style.display = 'flex';
  const content = $('simContent');
  const cmdEl = $('simCmd');
  const counterEl = $('simCounter');
  const progressEl = $('simProgress');
  content.innerHTML = '';

  const commands = parseDucky(script);
  const total = commands.length;

  for (let i = 0; i < commands.length; i++) {
    if (simAbort) break;
    const { cmd, arg, raw } = commands[i];
    counterEl.textContent = `${i + 1} / ${total}`;
    progressEl.style.width = ((i + 1) / total * 100) + '%';
    cmdEl.textContent = raw;

    switch (cmd) {
      case 'REM':
        content.innerHTML += `<div class="sim-comment">// ${escHtml(arg)}</div>`;
        await simDelay(300);
        break;

      case 'DELAY':
      case 'DEFAULTDELAY':
      case 'DEFAULT_DELAY': {
        const ms = parseInt(arg) || 500;
        const delayEl = document.createElement('span');
        delayEl.className = 'sim-delay';
        content.appendChild(delayEl);
        content.appendChild(document.createElement('br'));
        // Countdown
        const steps = 20;
        const stepMs = ms / steps;
        for (let s = steps; s >= 0; s--) {
          if (simAbort) break;
          delayEl.textContent = `⏱ DELAY ${Math.round(s * stepMs)}ms`;
          await simDelay(stepMs);
        }
        delayEl.textContent = `⏱ DELAY ${ms}ms ✓`;
        break;
      }

      case 'STRING':
      case 'PRINT':
      case 'PRINTLN': {
        const text = arg;
        for (let c = 0; c < text.length; c++) {
          if (simAbort) break;
          content.innerHTML += escHtml(text[c]);
          content.scrollTop = content.scrollHeight;
          await simDelay(30 + Math.random() * 20);
        }
        if (cmd === 'PRINTLN' || cmd === 'STRING') {
          // Don't add newline for STRING, only PRINTLN
        }
        break;
      }

      case 'ENTER':
      case 'RETURN':
        content.innerHTML += `<span class="sim-newline">↵</span>\n`;
        await simDelay(100);
        break;

      case 'GUI':
      case 'WINDOWS':
      case 'COMMAND': {
        const keyCombo = cmd + (arg ? ' ' + arg : '');
        content.innerHTML += `<span class="sim-badge">${escHtml(keyCombo)}</span>`;
        // Show OS-appropriate window hint
        if (arg.toLowerCase() === 'r') {
          content.innerHTML += `\n<div class="sim-window"><div class="sim-window-title">▸ Run Dialog</div>Windows + R → Run</div>`;
        } else if (arg.toLowerCase() === 'space') {
          content.innerHTML += `\n<div class="sim-window"><div class="sim-window-title">▸ Spotlight / Search</div>⌘ Space → Spotlight Search</div>`;
        }
        content.innerHTML += '\n';
        await simDelay(400);
        break;
      }

      case 'CTRL':
      case 'ALT':
      case 'SHIFT': {
        const keyCombo = cmd + (arg ? ' ' + arg : '');
        content.innerHTML += `<span class="sim-badge">${escHtml(keyCombo)}</span>\n`;
        if (cmd === 'CTRL' && arg.toUpperCase().includes('ALT') && arg.toLowerCase().includes('t')) {
          content.innerHTML += `<div class="sim-window"><div class="sim-window-title">▸ Terminal</div>Ctrl+Alt+T → Open Terminal</div>`;
        }
        await simDelay(300);
        break;
      }

      case 'TAB':
      case 'SPACE':
      case 'ESCAPE':
      case 'ESC':
      case 'DELETE':
      case 'BACKSPACE':
      case 'CAPSLOCK':
      case 'UPARROW':
      case 'DOWNARROW':
      case 'LEFTARROW':
      case 'RIGHTARROW':
      case 'UP':
      case 'DOWN':
      case 'LEFT':
      case 'RIGHT':
      case 'HOME':
      case 'END':
      case 'PAGEUP':
      case 'PAGEDOWN':
      case 'INSERT':
      case 'MENU':
      case 'APP':
      case 'BREAK':
      case 'PAUSE':
      case 'NUMLOCK':
      case 'SCROLLLOCK':
      case 'PRINTSCREEN':
        content.innerHTML += `<span class="sim-badge">${escHtml(cmd)}</span>\n`;
        await simDelay(200);
        break;

      case 'REPEAT': {
        const count = parseInt(arg) || 1;
        content.innerHTML += `<span class="sim-delay">🔁 REPEAT ×${count}</span>\n`;
        await simDelay(200 * count);
        break;
      }

      default:
        // F-keys or unknown
        if (cmd.match(/^F\d{1,2}$/)) {
          content.innerHTML += `<span class="sim-badge">${escHtml(cmd)}</span>\n`;
          await simDelay(200);
        } else {
          content.innerHTML += `<span class="sim-badge">${escHtml(raw)}</span>\n`;
          await simDelay(200);
        }
    }

    content.scrollTop = content.scrollHeight;
  }

  if (!simAbort) {
    content.innerHTML += `\n<span class="sim-delay" style="color:var(--g)">✓ Simulation Complete</span>`;
    cmdEl.textContent = 'Done';
    progressEl.style.width = '100%';
  }
  simRunning = false;
}

function stopSimulator() {
  simAbort = true;
  simRunning = false;
  $('simOverlay').style.display = 'none';
}

// ═══════════════════════════════════════════════════
//  SCRIPT CONSTRUCTOR
// ═══════════════════════════════════════════════════
//  SCRIPT CONSTRUCTOR
// ═══════════════════════════════════════════════════

function scSetOS(os, btn) {
  scOS = os;
  document.querySelectorAll('.sc-os-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function scShowForm(name) {
  // Hide all forms
  document.querySelectorAll('#scFormArea .sc-form').forEach(f => f.style.display = 'none');
  // Show the requested one
  const form = $('scf-' + name);
  if (form) {
    form.style.display = 'block';
    // Focus the first input in the form
    const inp = form.querySelector('input[type=text],input[type=url]');
    if (inp) setTimeout(() => inp.focus(), 100);
  }
}

function scAppend(line) {
  const out = $('scOutput');
  if (out.value && !out.value.endsWith('\n')) out.value += '\n';
  out.value += line;
  $('scLineCount').textContent = out.value.split('\n').filter(l => l.trim()).length + ' lines';
  out.scrollTop = out.scrollHeight;
}

function scQuick(cmd) {
  scAppend(cmd);
  toast('Added: ' + cmd, 'ok', 1000);
}

function scAddText() {
  const val = $('scTextInput').value;
  if (!val) { toast('Enter text first', 'warn'); return; }
  scAppend('STRING ' + val);
  $('scTextInput').value = '';
  toast('Added STRING', 'ok', 1000);
}

function scAddRem() {
  const val = $('scRemInput').value;
  if (!val) { toast('Enter comment', 'warn'); return; }
  scAppend('REM ' + val);
  $('scRemInput').value = '';
}

function scAddUrl() {
  const url = $('scUrlInput').value;
  if (!url || url === 'https://') { toast('Enter a URL', 'warn'); return; }
  const s = 'REM Open URL\nDELAY 500\nGUI r\nDELAY 600\nSTRING ' + url + '\nENTER';
  scAppend(s);
  $('scUrlInput').value = '';
  toast('Added Open URL', 'ok', 1000);
}

function scAddDownload() {
  const url = $('scDlUrl').value;
  const name = $('scDlName').value || 'downloaded_file';
  if (!url || url === 'https://') { toast('Enter download URL', 'warn'); return; }
  const s = 'REM Download & Execute\nDELAY 500\nGUI r\nDELAY 600\nSTRING powershell\nENTER\nDELAY 800\nSTRING Invoke-WebRequest -Uri "' + url + '" -OutFile "$env:TEMP\\' + name + '"\nENTER';
  scAppend(s);
  $('scDlUrl').value = '';
  $('scDlName').value = '';
  toast('Added Download', 'ok', 1000);
}

function scSetCmdType(type, btn) {
  scCmdType = type;
  document.querySelectorAll('#scCmdChoices .sc-choice').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function scAddCmd() {
  const type = scCmdType;
  const cmd = $('scCmdInput').value;
  if (!cmd) { toast('Enter a command', 'warn'); return; }

  let s = '';
  if (type === 'run') {
    s = 'REM Run\nDELAY 500\nGUI r\nDELAY 600\nSTRING ' + cmd + '\nENTER';
  } else if (type === 'powershell') {
    s = 'REM PowerShell\nDELAY 500\nGUI r\nDELAY 600\nSTRING powershell -w hidden -c "' + cmd + '"\nENTER';
  } else if (type === 'powershell_admin') {
    s = 'REM PS Admin\nDELAY 500\nGUI x\nDELAY 400\nSTRING a\nDELAY 1000\nLEFTARROW\nENTER\nDELAY 1200\nSTRING ' + cmd + '\nENTER';
  } else if (type === 'cmd') {
    s = 'REM CMD\nDELAY 500\nGUI r\nDELAY 600\nSTRING cmd\nENTER\nDELAY 600\nSTRING ' + cmd + '\nENTER';
  } else if (type === 'cmd_admin') {
    s = 'REM CMD Admin\nDELAY 500\nGUI x\nDELAY 400\nSTRING a\nDELAY 800\nLEFTARROW\nENTER\nDELAY 1000\nSTRING ' + cmd + '\nENTER';
  } else if (type === 'terminal') {
    s = 'REM Terminal\nDELAY 500\nGUI SPACE\nDELAY 600\nSTRING Terminal\nENTER\nDELAY 800\nSTRING ' + cmd + '\nENTER';
  }
  scAppend(s);
  $('scCmdInput').value = '';
  toast('Added Command', 'ok', 1000);
}

function scClear() {
  $('scOutput').value = '';
  $('scLineCount').textContent = '0 lines';
}

function scToEditor() {
  const script = $('scOutput').value.trim();
  if (!script) { toast('Build a script first', 'warn'); return; }
  $('editor').value = script;
  updateLines();
  localStorage.setItem('gc_script', script);
  closeTool('constructor');
  goPage('scripts', document.querySelectorAll('.nav-item')[0]);
  toast('Script sent to editor');
}

// ═══════════════════════════════════════════════════
//  LIVE KEYBOARD
// ═══════════════════════════════════════════════════

function kbToggle(mod) {
  kbActiveMods[mod] = !kbActiveMods[mod];
  const el = $(`kb${mod.charAt(0).toUpperCase() + mod.slice(1)}`);
  if (el) el.classList.toggle('active', kbActiveMods[mod]);
}

function kbKey(key) {
  let script = '';
  let mods = [];
  if (kbActiveMods.ctrl) mods.push('CTRL');
  if (kbActiveMods.alt) mods.push('ALT');
  if (kbActiveMods.shift) mods.push('SHIFT');
  if (kbActiveMods.gui) mods.push('GUI');

  if (mods.length > 0) {
    script = mods.join(' ') + ' ' + key.toUpperCase();
  } else {
    if (key.length === 1) {
      script = 'STRING ' + key;
    } else {
      script = key.toUpperCase();
    }
  }

  $('kbStatus').textContent = 'Sending: ' + script;
  deviceFetch('/', { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, 
    body: 'duckyscript=' + encodeURIComponent(script) 
  }).then(() => {
    setTimeout(() => { if ($('kbStatus')) $('kbStatus').textContent = 'Ready.'; }, 500);
  });
}

function kbMacro(m) {
  $('kbStatus').textContent = 'Executing macro...';
  deviceFetch('/', { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, 
    body: 'duckyscript=' + encodeURIComponent(m) 
  }).then(() => {
    setTimeout(() => { if ($('kbStatus')) $('kbStatus').textContent = 'Ready.'; }, 800);
  });
}


// ═══════════════════════════════════════════════════
//  FILE MANAGER
// ═══════════════════════════════════════════════════

var fmCurrentPath = '/';
var fmSelectedFile = null;
var fmRunBusy = false;

function fmBase() {
  const b = BASE();
  if (b === '') return location.origin;
  return b || 'http://192.168.4.1';
}

async function fmFetch(path) {
  const url = fmBase() + path;
  try {
    return await fetch(url, {
      headers: { 'Accept': '*/*', 'Referer': fmBase() + '/file-manager' }
    });
  } catch (e) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', '*/*');
      xhr.onload = () => resolve({ ok: xhr.status < 400, status: xhr.status, text: async () => xhr.responseText, json: async () => JSON.parse(xhr.responseText) });
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.timeout = 8000; xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send();
    });
  }
}

async function fmFetchPost(path) {
  const url = fmBase() + path;
  const crossOrigin = new URL(url).origin !== location.origin;
  const opts = crossOrigin
    ? { method: 'POST', mode: 'no-cors', body: null }
    : { method: 'POST', headers: { 'Accept': '*/*' }, body: null };
  return fetch(url, opts);
}

async function fmNavigate(path) {
  fmCurrentPath = path;
  fmSelectedFile = null;
  fmRenderBreadcrumb(path);
  await fmLoadList(path);
}

function fmRefresh() { fmNavigate(fmCurrentPath); }

function fmUp() {
  if (fmCurrentPath === '/') return;
  const parent = fmCurrentPath.split('/').filter(Boolean).slice(0, -1).join('/');
  fmNavigate(parent ? '/' + parent : '/');
}

function fmRenderBreadcrumb(path) {
  const parts = path.split('/').filter(p => p);
  let crumbs = [{ label: '⌂ root', path: '/' }];
  let built = '';
  parts.forEach(p => { built += '/' + p; crumbs.push({ label: p, path: built }); });
  const bc = $('fmBreadcrumb');
  if (!bc) return;
  bc.innerHTML = crumbs.map((c, i) =>
    '<span class="fm-crumb' + (i === crumbs.length - 1 ? ' active' : '') + '" onclick="fmNavigate(\'' + c.path.replace(/'/g, "\\'") + '\')">' + escHtml(c.label) + '</span>'
  ).join('<span class="fm-sep">›</span>');
}

async function fmLoadList(path) {
  const list = $('fmList');
  if (!list) return;
  list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const r = await fmFetch('/fm/list?path=' + encodeURIComponent(path));
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = []; }
    const items = Array.isArray(data) ? data : (data.files || data.entries || []);
    if (!items.length) { list.innerHTML = '<div class="empty-state">Empty folder</div>'; return; }
    items.sort((a, b) => {
      const aD = a.dir === true || a.type === 'dir' || a.isDir || a.directory;
      const bD = b.dir === true || b.type === 'dir' || b.isDir || b.directory;
      if (aD && !bD) return -1; if (!aD && bD) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    list.innerHTML = items.map(item => {
      const isDir = item.dir === true || item.type === 'dir' || item.isDir || item.directory;
      const name = item.name || item.filename || '';
      const size = item.size != null ? fmFormatSize(item.size) : '';
      const iPath = (path === '/' ? '' : path) + '/' + name;
      const sp = iPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const sn = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const icon = isDir
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
        : fmFileIcon(name);
      return '<div class="fm-item' + (isDir ? ' fm-dir' : '') + '" onclick="' + (isDir ? 'fmNavigate(\'' + sp + '\')' : 'fmSelectFile(\'' + sp + '\',\'' + sn + '\',false,this)') + '">' +
        '<div class="fm-item-icon">' + icon + '</div>' +
        '<div class="fm-item-info"><div class="fm-item-name">' + escHtml(name) + '</div>' + (!isDir && size ? '<div class="fm-item-size">' + size + '</div>' : '') + '</div>' +
        (isDir ? '<span class="fm-arrow">›</span>' : '') + '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state">Failed to load — check connection<br><small style="opacity:.6">' + escHtml(e.message) + '</small></div>';
    toast('FM: Load failed', 'err');
  }
}

function fmFileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['txt','ducky','ds','ps1','sh','bat','py'].includes(ext))
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
}

function fmFormatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmSelectFile(path, name, isDir, el) {
  fmSelectedFile = { path, name, isDir };
  document.querySelectorAll('.fm-item').forEach(e => e.classList.remove('fm-selected'));
  document.querySelectorAll('.fm-file-actions').forEach(e => e.remove());
  if (el) el.classList.add('fm-selected');
  if (!el) return;
  const actions = document.createElement('div');
  actions.className = 'fm-file-actions';
  actions.innerHTML =
    '<button class="fm-inline-btn fm-inline-run" onclick="event.stopPropagation(); fmRunSelected()">Run</button>' +
    '<button class="fm-inline-btn" onclick="event.stopPropagation(); fmDownloadSelected()">Download</button>';
  el.appendChild(actions);
}

function fmClearSelection() {
  fmSelectedFile = null;
  document.querySelectorAll('.fm-item').forEach(e => e.classList.remove('fm-selected'));
  document.querySelectorAll('.fm-file-actions').forEach(e => e.remove());
}

async function fmRunSelected() {
  if (!fmSelectedFile || fmRunBusy) return;
  fmRunBusy = true;
  try {
    await fmFetchPost('/fm/run?path=' + encodeURIComponent(fmSelectedFile.path));
    toast('Script running: ' + fmSelectedFile.name + ' ✓');
    fmClearSelection();
  } catch (e) {
    toast('Run sent. Check device status.', 'warn');
    fmClearSelection();
  } finally {
    fmRunBusy = false;
  }
}

function fmDownloadSelected() {
  if (!fmSelectedFile) return;
  const url = fmBase() + '/fm/download?path=' + encodeURIComponent(fmSelectedFile.path);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) {
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) location.href = url;
    toast('Opening download: ' + fmSelectedFile.name + '...');
    return;
  }
  const a = document.createElement('a');
  a.href = url; a.download = fmSelectedFile.name; a.target = '_blank';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  toast('Downloading ' + fmSelectedFile.name + '...');
}

function fmUploadClick() { if ($('fmUploadInput')) $('fmUploadInput').click(); }

async function fmHandleUpload(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  const uploadUrl = fmBase() + '/fm/upload?path=' + encodeURIComponent(fmCurrentPath);
  const crossOrigin = new URL(uploadUrl).origin !== location.origin;
  for (const file of files) {
    toast('Uploading ' + file.name + '...', 'warn', 4000);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const opts = crossOrigin
        ? { method: 'POST', mode: 'no-cors', body: fd }
        : { method: 'POST', headers: { 'Accept': '*/*' }, body: fd };
      await fetch(uploadUrl, opts);
      toast('Uploaded ' + file.name + ' ✓');
    } catch (e) {
      toast('Upload sent. Refreshing folder...', 'warn', 2500);
    }
  }
  event.target.value = '';
  await fmLoadList(fmCurrentPath);
}

setTimeout(() => {
  const dz = $('fmDropzone');
  if (!dz) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag');
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    $('fmUploadInput').files = dt.files;
    fmHandleUpload({ target: $('fmUploadInput') });
  });
}, 800);

function fmShowMkdir() { if ($('fmMkdirForm')) { $('fmMkdirForm').style.display = 'block'; setTimeout(() => $('fmMkdirName') && $('fmMkdirName').focus(), 100); } }
function fmHideMkdir() { if ($('fmMkdirForm')) { $('fmMkdirForm').style.display = 'none'; if ($('fmMkdirName')) $('fmMkdirName').value = ''; } }

async function fmCreateFolder() {
  const name = $('fmMkdirName') ? $('fmMkdirName').value.trim() : '';
  if (!name) { toast('Enter a folder name', 'warn'); return; }
  const folderPath = (fmCurrentPath === '/' ? '' : fmCurrentPath) + '/' + name;
  try {
    await fmFetchPost('/fm/mkdir?path=' + encodeURIComponent(folderPath));
    toast('Folder created: ' + name + ' ✓');
    fmHideMkdir();
    await fmLoadList(fmCurrentPath);
  } catch (e) { toast('Create failed: ' + e.message, 'err'); }
}
