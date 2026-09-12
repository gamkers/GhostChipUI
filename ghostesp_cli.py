#!/usr/bin/env python3
"""
GhostESP TUI — Arrow-key navigation, curses-based
↑↓ navigate  Enter select  Q quit
"""

import curses, sys, time, random, threading, argparse
from datetime import datetime
from collections import deque

try:
    import serial
    SERIAL_AVAILABLE = True
except ImportError:
    SERIAL_AVAILABLE = False

# ── palette indices ────────────────────────────────────────────
P_GREEN   = 1
P_CYAN    = 2
P_RED     = 3
P_YELLOW  = 4
P_WHITE   = 5
P_DIM     = 6
P_BG_SEL  = 7   # selected row highlight
P_MAGENTA = 8

MENU_ITEMS = [
    ("scanap",      "Scan WiFi Access Points",       "wifi"),
    ("scansta",     "Scan Client Stations",           "wifi"),
    ("select -a",   "Select AP Target",               "wifi"),
    ("select -s",   "Select Station Target",          "wifi"),
    ("blescan -f",  "Find Flipper Zero Devices",      "ble"),
    ("blescan -a",  "Find AirTag Trackers",           "ble"),
    ("attack -d",   "Deauth Attack",                  "attack"),
    ("blespam",     "Apple Proximity BLE Spam",       "attack"),
    ("beaconspam",  "Rickroll SSID Beacon Flood",     "attack"),
    ("startportal", "Deploy Evil Captive Portal",     "attack"),
    ("capture",     "Capture Probe / WPS Frames",     "passive"),
    ("stop",        "Stop All Active Tasks",          "control"),
    ("console",     "Direct CLI Console Mode",        "control"),
    ("exit",        "Exit",                           "control"),
]

CAT_COLOR_IDX = {
    "wifi":    P_CYAN,
    "ble":     P_MAGENTA,
    "attack":  P_RED,
    "passive": P_YELLOW,
    "control": P_DIM,
}

BANNER_LINES = [
    " ██████╗ ██╗  ██╗ ██████╗ ███████╗████████╗   ███████╗███████╗██████╗",
    "██╔════╝ ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝   ██╔════╝██╔════╝██╔══██╗",
    "██║  ███╗███████║██║   ██║███████╗   ██║       █████╗  ███████╗██████╔╝",
    "██║   ██║██╔══██║██║   ██║╚════██║   ██║       ██╔══╝  ╚════██║██╔═══╝",
    "╚██████╔╝██║  ██║╚██████╔╝███████║   ██║       ███████╗███████║██║",
    " ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝       ╚══════╝╚══════╝╚═╝",
]


# ── log buffer ─────────────────────────────────────────────────
class LogBuffer:
    def __init__(self, maxlen=400):
        self._q    = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def add(self, text, kind="info"):
        ts = datetime.now().strftime("%H:%M:%S")
        with self._lock:
            self._q.append((ts, text, kind))

    def recent(self, n):
        with self._lock:
            return list(self._q)[-n:]


# ── app state ──────────────────────────────────────────────────
class AppState:
    def __init__(self):
        self.connected      = False
        self.simulation     = False
        self.port           = None
        self.wifi_aps       = []
        self.wifi_stations  = []
        self.selected_ap    = None
        self.selected_sta   = None
        self.packets_sent   = 0
        self.attack_running = False
        self.active_task    = None
        self.stop_threads   = False
        self.serial_conn    = None


# ── engine ─────────────────────────────────────────────────────
class GhostEngine:
    def __init__(self, state, log):
        self.s   = state
        self.log = log

    def _log(self, prefix, msg, kind):
        self.log.add(f"{prefix} {msg}", kind)

    def sys(self, m):  self._log("[SYS]", m, "sys")
    def err(self, m):  self._log("[ERR]", m, "err")
    def ok(self, m):   self._log("[OK] ", m, "ok")
    def warn(self, m): self._log("[WRN]", m, "warn")
    def raw(self, m):  self.log.add(m, "raw")

    def connect(self, port=None, baud=115200):
        if not port or not SERIAL_AVAILABLE:
            self.s.simulation = True
            self.s.connected  = True
            self.sys("VIRTUAL SANDBOX ACTIVE — ESP32-S3 simulator online")
            return
        try:
            self.s.serial_conn = serial.Serial(port, baud, timeout=1)
            self.s.connected   = True
            self.s.port        = port
            self.ok(f"Connected on {port} @ {baud} baud")
            threading.Thread(target=self._read_loop, daemon=True).start()
        except Exception as e:
            self.err(f"Serial failed: {e}")
            self.s.simulation = True
            self.s.connected  = True
            self.sys("Falling back to VIRTUAL SANDBOX")

    def _read_loop(self):
        """
        Stateful parser for GhostESP serial output.

        AP block (triggered by [N] SSID: ...):
            [0] SSID: Akash_2.4Ghz,
            BSSID: 3C:6A:D2:4F:D8:16,
            RSSI: -39,
            Channel: 4,
            Vendor: Tp-Link Systems Inc

        Station block (triggered by 'New Station:'):
            New Station:
            Station: D6:61:86:1C:63:F5,
            STA Vendor: Unknown,
            Associated AP: ZTE-ZhXZD7,
            AP BSSID: E4:47:B3:8D:A3:8E,
            AP Vendor: Unknown

        Deauth packet rate:
            123 packets/sec

        Everything else → raw log.
        """
        import re
        ap_buf  = {}   # partial AP being built
        sta_buf = {}   # partial station being built

        def val(line, key):
            # extract value after "Key: " stripping trailing comma
            try:
                return line.split(f"{key}:")[1].strip().rstrip(",")
            except:
                return ""

        def commit_ap():
            if ap_buf.get("ssid") and ap_buf.get("bssid"):
                idx = ap_buf.get("idx", len(self.s.wifi_aps))
                # update existing or append
                for i, existing in enumerate(self.s.wifi_aps):
                    if existing["idx"] == idx:
                        self.s.wifi_aps[i] = dict(ap_buf)
                        return
                self.s.wifi_aps.append(dict(ap_buf))

        def commit_sta():
            if sta_buf.get("mac"):
                mac = sta_buf["mac"]
                for i, existing in enumerate(self.s.wifi_stations):
                    if existing["mac"] == mac:
                        self.s.wifi_stations[i] = dict(sta_buf)
                        return
                self.s.wifi_stations.append(dict(sta_buf))

        ap_pat  = re.compile(r'^\[(\d+)\]\s+SSID:\s*(.+)')
        pkt_pat = re.compile(r'^(\d+)\s+packets?/sec', re.IGNORECASE)

        while not self.s.stop_threads and self.s.serial_conn and self.s.serial_conn.is_open:
            try:
                if self.s.serial_conn.in_waiting > 0:
                    raw = self.s.serial_conn.readline().decode('utf-8', errors='ignore')
                    line = raw.strip().lstrip('\x00')
                    if not line:
                        time.sleep(0.02)
                        continue

                    self.raw(line)  # always show in output log

                    # ── AP block start ─────────────────────────────
                    m = ap_pat.match(line)
                    if m:
                        if ap_buf: commit_ap()
                        ap_buf.clear()
                        sta_buf.clear()
                        ap_buf["idx"]  = int(m.group(1))
                        ap_buf["ssid"] = m.group(2).rstrip(",").strip()
                        self.s.active_task = "WiFi AP Scan"
                        continue

                    # ── AP block fields ────────────────────────────
                    if ap_buf and not sta_buf:
                        ll = line.lower()
                        if "bssid:"   in ll: ap_buf["bssid"]  = val(line, "BSSID");   continue
                        if "rssi:"    in ll:
                            try: ap_buf["rssi"] = int(val(line,"RSSI"))
                            except: pass
                            continue
                        if "channel:" in ll:
                            try: ap_buf["ch"] = int(val(line,"Channel"))
                            except: pass
                            continue
                        if "vendor:"  in ll: ap_buf["vendor"] = val(line,"Vendor");   continue
                        if "enc:" in ll or "encryption:" in ll:
                            ap_buf["enc"] = val(line, "Enc") or val(line, "Encryption"); continue
                        # any unrelated line — commit current AP
                        commit_ap(); ap_buf.clear()

                    # ── scan complete ──────────────────────────────
                    if "scan completed" in line.lower() or "found" in line.lower():
                        if ap_buf: commit_ap(); ap_buf.clear()
                        if sta_buf: commit_sta(); sta_buf.clear()
                        self.s.active_task = None
                        continue

                    # ── station block start ────────────────────────
                    if line.lower().startswith("new station"):
                        if ap_buf: commit_ap(); ap_buf.clear()
                        if sta_buf: commit_sta(); sta_buf.clear()
                        sta_buf.clear()
                        self.s.active_task = "Station Scan"
                        continue

                    # ── station block fields ───────────────────────
                    if sta_buf is not None and "mac" not in sta_buf.__class__.__dict__:
                        pass  # always check sta_buf dict
                    if sta_buf or line.lower().startswith("station:"):
                        ll = line.lower()
                        if ll.startswith("station:"):
                            sta_buf["mac"] = val(line,"Station"); continue
                        if "sta vendor:"     in ll: sta_buf["vendor"] = val(line,"STA Vendor");   continue
                        if "associated ap:"  in ll: sta_buf["ssid"]   = val(line,"Associated AP");continue
                        if "ap bssid:"       in ll: sta_buf["bssid"]  = val(line,"AP BSSID");     continue
                        if "ap vendor:"      in ll:
                            sta_buf["ap_vendor"] = val(line,"AP Vendor")
                            commit_sta(); sta_buf.clear()
                            continue

                    # ── deauth packet rate ─────────────────────────
                    m2 = pkt_pat.match(line)
                    if m2:
                        try:
                            self.s.packets_sent += int(m2.group(1))
                        except: pass
                        continue

                    # ── task state hints ───────────────────────────
                    ll = line.lower()
                    if "started station scan"  in ll: self.s.active_task = "Station Scan"
                    elif "deauth" in ll and "start" in ll: self.s.active_task = "Deauth Attack"
                    elif "portal" in ll and "start" in ll: self.s.active_task = "Evil Portal"
                    elif "ble scan" in ll:                 self.s.active_task = "BLE Scan"
                    elif "beacon spam" in ll:              self.s.active_task = "Beacon Flood"
                    elif "stopped" in ll or "halted" in ll: self.s.active_task = None

            except Exception as e:
                self.err(f"Read error: {e}")
                break
            time.sleep(0.02)

    def stop_all(self):
        self.s.stop_threads   = True
        self.s.attack_running = False
        self.s.active_task    = None
        # Send physical hardware stop commands
        if not self.s.simulation and self.s.connected:
            self.send("stop deauth")
            time.sleep(0.05)
            self.send("stop spam")
            time.sleep(0.05)
            self.send("stopscan")
        time.sleep(0.15)
        self.s.stop_threads   = False
        self.warn("All tasks halted")

    def send(self, cmd):
        if not self.s.connected: self.err("Not connected."); return
        if self.s.simulation:    self._sim(cmd)
        elif self.s.serial_conn and self.s.serial_conn.is_open:
            try:   self.s.serial_conn.write((cmd+"\r\n").encode())
            except Exception as e: self.err(f"Write error: {e}")

    def _sim(self, cmd):
        c = cmd.strip().lower()
        self.stop_all()

        if c.startswith("scanap"):
            self.s.active_task = "WiFi AP Scan"
            self.s.wifi_aps = [
                {"idx":0,"ssid":"Akash_2.4Ghz",   "bssid":"3C:6A:D2:4F:D8:16","rssi":-39,"ch":4, "enc":"WPA2"},
                {"idx":1,"ssid":"ZTE-ZhXZD7",      "bssid":"E4:47:B3:8D:A3:8E","rssi":-78,"ch":4, "enc":"WPA2"},
                {"idx":2,"ssid":"Free WiFi",        "bssid":"2A:EA:D0:A7:8A:44","rssi":-85,"ch":10,"enc":"OPEN"},
                {"idx":3,"ssid":"Airtel_elan_5747", "bssid":"F4:27:56:95:EC:70","rssi":-87,"ch":7, "enc":"WPA2"},
            ]
            threading.Thread(target=self._do_scanap, daemon=True).start()

        elif c.startswith("scansta"):
            self.s.active_task = "Station Scan"
            self.s.wifi_stations = [
                {"mac":"E0:D4:E8:4D:53:73","vendor":"Intel","ssid":"ZTE-ZhXZD7",   "bssid":"E4:47:B3:8D:A3:8E"},
                {"mac":"12:40:52:59:6B:43","vendor":"?",    "ssid":"Free WiFi",     "bssid":"2A:EA:D0:A7:8A:44"},
                {"mac":"3E:6A:D2:0F:D8:16","vendor":"?",    "ssid":"ZTE-ZhXZD7",   "bssid":"E4:47:B3:8D:A3:8E"},
                {"mac":"FA:A9:CE:D0:6B:13","vendor":"?",    "ssid":"Akash_2.4Ghz", "bssid":"3C:6A:D2:4F:D8:16"},
            ]
            threading.Thread(target=self._do_scansta, daemon=True).start()

        elif c.startswith("blescan"):
            flipper = "-f" in c
            self.s.active_task = "Flipper Scan" if flipper else "BLE Scan"
            threading.Thread(target=self._do_blescan, args=(flipper,), daemon=True).start()

        elif c.startswith("select -a"):
            try:
                idx = int(c.replace("select -a","").strip())
                self.s.selected_ap = idx
                label = self.s.wifi_aps[idx]['ssid'] if idx < len(self.s.wifi_aps) else f"#{idx}"
                self.ok(f"AP target → [{idx}] {label}")
            except: self.err("Invalid index")

        elif c.startswith("select -s"):
            try:
                idx = int(c.replace("select -s","").strip())
                self.s.selected_sta = idx
                label = self.s.wifi_stations[idx]['mac'] if idx < len(self.s.wifi_stations) else f"#{idx}"
                self.ok(f"STA target → [{idx}] {label}")
            except: self.err("Invalid index")

        elif c.startswith("attack -d"):
            self.s.active_task = "Deauth Attack"
            self.s.attack_running = True
            threading.Thread(target=self._do_deauth, daemon=True).start()

        elif c.startswith("blespam"):
            self.s.active_task = "BLE Spam"
            self.s.attack_running = True
            threading.Thread(target=self._do_blespam, daemon=True).start()

        elif c.startswith("beaconspam"):
            self.s.active_task = "Beacon Flood"
            self.s.attack_running = True
            threading.Thread(target=self._do_beaconspam, daemon=True).start()

        elif c.startswith("startportal"):
            self.s.active_task = "Evil Portal"
            threading.Thread(target=self._do_portal, daemon=True).start()

        elif c.startswith("capture"):
            self.s.active_task = "Frame Capture"
            self.s.attack_running = True
            threading.Thread(target=self._do_capture, daemon=True).start()

        elif "stop" in c:
            self.stop_all()

        else:
            self.err(f"Unknown: {cmd}")

    @staticmethod
    def rssi_bar(rssi):
        s = max(0, min(5, (rssi + 100) // 10))
        return "█"*s + "░"*(5-s)

    def _do_scanap(self):
        for step in ["Stopping Wi-Fi...","Starting AP scan...","Channel hopping...","Done."]:
            if self.s.stop_threads: return
            self.raw(f"  {step}"); time.sleep(0.5)
        self.ok(f"Found {len(self.s.wifi_aps)} access points")
        for ap in self.s.wifi_aps:
            if self.s.stop_threads: return
            self.raw(f"  [{ap['idx']}] {ap['ssid']:<20} {ap['bssid']}  CH{ap['ch']:>2}  {ap['enc']}  {self.rssi_bar(ap['rssi'])} {ap['rssi']}dBm")
            time.sleep(0.3)
        self.s.active_task = None

    def _do_scansta(self):
        for step in ["Initial scan...","Channel hopping...","Sniffing probes..."]:
            if self.s.stop_threads: return
            self.raw(f"  {step}"); time.sleep(0.4)
        for sta in self.s.wifi_stations:
            if self.s.stop_threads: return
            time.sleep(1.2)
            self.raw(f"  [STA] {sta['mac']}  ← {sta['ssid']}  ({sta['vendor']})")
        self.ok(f"Found {len(self.s.wifi_stations)} stations")
        self.s.active_task = None

    def _do_blescan(self, flipper):
        self.raw("  Starting BLE scan..."); time.sleep(0.8)
        devices = [("47:61:6d:26:e1:80","Gamkers",-57),("3c:71:bf:9a:cc:11","GhostFlip",-72)] if flipper \
             else [("aa:bb:cc:dd:ee:ff","AirTag",-65),("f1:22:33:44:55:66","iPhone Steve",-70)]
        for i,(mac,name,rssi) in enumerate(devices):
            if self.s.stop_threads: return
            self.raw(f"  [{i}] {mac}  {name:<16}  {rssi}dBm")
            time.sleep(1.0)
        self.ok("BLE scan complete"); self.s.active_task = None

    def _do_deauth(self):
        tgt = self.s.wifi_aps[self.s.selected_ap]['ssid'] if self.s.selected_ap is not None and self.s.wifi_aps else "Broadcast"
        self.warn(f"Deauth → {tgt}")
        pkts = 0
        while self.s.attack_running and not self.s.stop_threads:
            pkts += random.randint(12,20); self.s.packets_sent = pkts
            self.raw(f"  [DEAUTH] {pkts} pkts/s → {tgt}"); time.sleep(0.5)

    def _do_blespam(self):
        pkts = 0
        while self.s.attack_running and not self.s.stop_threads:
            pkts += 40; self.raw(f"  [BLE_SPAM] total: {pkts}"); time.sleep(1.0)

    def _do_beaconspam(self):
        pkts = 0
        while self.s.attack_running and not self.s.stop_threads:
            pkts += 80; self.raw(f"  [BEACON] packets: {pkts}"); time.sleep(1.0)

    def _do_portal(self):
        self.ok("Evil portal on 192.168.4.1 — SSID: 'Free WiFi'")
        time.sleep(3.0)
        if self.s.stop_threads: return
        self.raw("  [PORTAL] Client connected: 192.168.4.24")
        time.sleep(4.5)
        if self.s.stop_threads: return
        self.warn('  [PORTAL] Creds: user="steve@gamkers.com" pass="Gamer9922!"')
        self.s.active_task = None

    def _do_capture(self):
        frames = ["probe request","WPS request","deauth frame","beacon","probe response"]
        while self.s.attack_running and not self.s.stop_threads:
            src = ":".join(f"{random.randint(0,255):02x}" for _ in range(6))
            self.raw(f"  [CAP] {random.choice(frames):<18}  src={src}"); time.sleep(0.9)


# ── curses drawing helpers ─────────────────────────────────────
def safe_addstr(win, y, x, text, attr=0):
    h, w = win.getmaxyx()
    if y < 0 or y >= h: return
    if x < 0: text = text[-x:]; x = 0
    if x >= w: return
    text = text[:w - x]
    try: win.addstr(y, x, text, attr)
    except curses.error: pass

def draw_box(win, title="", color_pair=P_GREEN):
    h, w = win.getmaxyx()
    attr = curses.color_pair(color_pair)
    try:
        win.border(0)
    except curses.error: pass
    if title:
        label = f" {title} "
        safe_addstr(win, 0, 2, label, attr | curses.A_BOLD)

def fill_bg(win):
    h, w = win.getmaxyx()
    for y in range(h):
        safe_addstr(win, y, 0, " "*w, curses.color_pair(P_WHITE))


# ── kind → color ───────────────────────────────────────────────
KIND_COLOR = {
    "sys":  P_GREEN,
    "ok":   P_GREEN,
    "err":  P_RED,
    "warn": P_YELLOW,
    "raw":  P_WHITE,
    "info": P_CYAN,
}


# ── main TUI ───────────────────────────────────────────────────
def run_tui(stdscr, state, log, engine, args):
    curses.curs_set(0)
    curses.start_color()
    curses.use_default_colors()

    # colour pairs
    curses.init_pair(P_GREEN,   curses.COLOR_GREEN,   -1)
    curses.init_pair(P_CYAN,    curses.COLOR_CYAN,    -1)
    curses.init_pair(P_RED,     curses.COLOR_RED,     -1)
    curses.init_pair(P_YELLOW,  curses.COLOR_YELLOW,  -1)
    curses.init_pair(P_WHITE,   curses.COLOR_WHITE,   -1)
    curses.init_pair(P_DIM,     8,                    -1)   # dark grey if supported
    curses.init_pair(P_BG_SEL,  curses.COLOR_BLACK,   curses.COLOR_GREEN)
    curses.init_pair(P_MAGENTA, curses.COLOR_MAGENTA, -1)

    stdscr.timeout(120)   # non-blocking getch with 120ms timeout
    stdscr.keypad(True)

    sel      = 0          # selected menu row (0-indexed, skipping separators)
    log_off  = 0          # scroll offset for output panel
    input_mode  = False
    input_label = ""
    input_buf   = ""
    input_cb    = None    # callback(value)

    engine.connect(args.port, args.baud)

    def do_input(label, cb):
        nonlocal input_mode, input_label, input_buf, input_cb
        input_mode  = True
        input_label = label
        input_buf   = ""
        input_cb    = cb
        curses.curs_set(1)

    def finish_input():
        nonlocal input_mode
        input_mode = False
        curses.curs_set(0)

    # ── dispatch menu action ───────────────────────────────────
    def dispatch(cmd):
        if cmd == "exit":
            return False

        elif cmd == "stop":
            engine.stop_all()

        elif cmd == "select -a":
            def cb(v):
                try:
                    state.selected_ap = int(v)
                except:
                    pass
                engine.send(f"select -a {v}")
            do_input("AP index", cb)

        elif cmd == "select -s":
            def cb(v):
                try:
                    state.selected_sta = int(v)
                except:
                    pass
                engine.send(f"select -s {v}")
            do_input("Station index", cb)

        elif cmd == "console":
            # temporarily leave curses for raw CLI
            curses.endwin()
            print("\n\033[92mDirect CLI Mode\033[0m — type 'back' to return\n")
            while True:
                try: raw = input("\033[92mghost-cli ▸ \033[0m").strip()
                except (KeyboardInterrupt, EOFError): break
                if raw.lower() in ("back","menu"): break
                if raw.lower() == "exit":
                    engine.stop_all(); sys.exit(0)
                if raw:
                    engine.send(raw)
                    time.sleep(0.4)
                    for ts, msg, kind in log.recent(6):
                        col = "\033[92m" if kind in ("ok","sys") else "\033[91m" if kind=="err" else "\033[93m" if kind=="warn" else "\033[0m"
                        print(f"\033[90m{ts}\033[0m {col}{msg}\033[0m")
            stdscr.refresh()
            curses.doupdate()

        else:
            engine.send(cmd)

        return True

    while True:
        sh, sw = stdscr.getmaxyx()
        stdscr.erase()

        # ── layout ────────────────────────────────────────────
        HEADER_H = 3
        STATUS_H = 3
        body_h   = sh - HEADER_H - STATUS_H
        menu_w   = 32
        info_w   = 40
        out_w    = sw - menu_w - info_w

        # ── header ────────────────────────────────────────────
        hdr = stdscr.derwin(HEADER_H, sw, 0, 0)
        mode = "SANDBOX" if state.simulation else (state.port or "SERIAL")
        task = f"  ● {state.active_task}" if state.active_task else "  ○ IDLE"
        hdr_txt = f" GHOST ESP // {mode}{task}"
        safe_addstr(hdr, 1, 1, hdr_txt[:sw-2], curses.color_pair(P_GREEN)|curses.A_BOLD)
        safe_addstr(hdr, 0, 0, "─"*(sw), curses.color_pair(P_GREEN))
        safe_addstr(hdr, 2, 0, "─"*(sw), curses.color_pair(P_GREEN))

        # ── menu panel ────────────────────────────────────────
        menu_win = stdscr.derwin(body_h, menu_w, HEADER_H, 0)
        draw_box(menu_win, "MENU", P_GREEN)

        row = 1
        prev_cat = None
        visible_items = []   # (menu_idx, cmd, label, cat)
        for idx,(cmd,label,cat) in enumerate(MENU_ITEMS):
            if cat != prev_cat:
                if row < body_h-1:
                    cat_label = f"  ── {cat.upper()} ──"
                    safe_addstr(menu_win, row, 1, cat_label[:menu_w-2], curses.color_pair(CAT_COLOR_IDX[cat]))
                    row += 1
                prev_cat = cat
            if row < body_h-1:
                visible_items.append((idx, cmd, label, cat, row))
                is_sel = (idx == sel)
                attr = curses.color_pair(P_BG_SEL)|curses.A_BOLD if is_sel else curses.color_pair(P_WHITE)
                prefix = " ▶ " if is_sel else "   "
                line   = f"{prefix}{label}"
                safe_addstr(menu_win, row, 1, " "*(menu_w-2), attr)
                safe_addstr(menu_win, row, 1, line[:menu_w-2], attr)
                row += 1

        safe_addstr(menu_win, body_h-1, 1, " ↑↓ navigate   Enter select ", curses.color_pair(P_DIM))

        # ── output panel ──────────────────────────────────────
        out_win = stdscr.derwin(body_h, out_w, HEADER_H, menu_w)
        draw_box(out_win, "OUTPUT", P_GREEN)

        lines    = log.recent(1000)
        visible  = body_h - 2
        total    = len(lines)
        log_off  = max(0, min(log_off, max(0, total - visible)))
        show     = lines[total - visible - log_off : total - log_off] if log_off else lines[max(0,total-visible):]

        for i, (ts, msg, kind) in enumerate(show):
            y = i + 1
            if y >= body_h-1: break
            attr = curses.color_pair(KIND_COLOR.get(kind, P_WHITE))
            safe_addstr(out_win, y, 1, f"{ts} ", curses.color_pair(P_DIM))
            safe_addstr(out_win, y, 10, msg[:out_w-12], attr)

        scroll_hint = " ↑↓ scroll " if total > visible else ""
        safe_addstr(out_win, body_h-1, 1, scroll_hint, curses.color_pair(P_DIM))

        # ── info panel ────────────────────────────────────────
        info_win = stdscr.derwin(body_h, info_w, HEADER_H, menu_w+out_w)
        draw_box(info_win, "TARGETS", P_GREEN)

        def iw(y, x, txt, attr):
            if y < body_h-1:
                safe_addstr(info_win, y, x, txt[:info_w-x-1], attr)

        iy = 1
        # ── AP section ────────────────────────────────────────
        iw(iy, 1, f"{'ACCESS POINTS':─<{info_w-3}}", curses.color_pair(P_GREEN)|curses.A_BOLD); iy+=1
        for ap in state.wifi_aps:
            if iy >= body_h-3: break
            rssi    = ap.get("rssi", -99)
            ssid    = ap.get("ssid", "?")
            ch      = ap.get("ch", "?")
            idx     = ap.get("idx", "?")
            enc     = ap.get("enc", "")
            bar     = GhostEngine.rssi_bar(rssi)
            col     = P_GREEN if rssi > -60 else P_YELLOW if rssi > -75 else P_RED
            marker  = "▶" if state.selected_ap == idx else " "
            # line 1: marker + index + ssid
            iw(iy, 1, f" {marker}[{idx}] {ssid}", curses.color_pair(P_WHITE)|curses.A_BOLD); iy+=1
            if iy >= body_h-3: break
            # line 2: ch + enc + signal bar
            enc_str = f" {enc}" if enc else ""
            iw(iy, 4, f"CH{ch}{enc_str}  {bar} {rssi}dBm", curses.color_pair(col)); iy+=1

        iy+=1
        # ── Station section ───────────────────────────────────
        if iy < body_h-3:
            iw(iy, 1, f"{'STATIONS':─<{info_w-3}}", curses.color_pair(P_CYAN)|curses.A_BOLD); iy+=1
        for i, sta in enumerate(state.wifi_stations):
            if iy >= body_h-3: break
            mac    = sta.get("mac", "?")
            ssid   = sta.get("ssid", "?")
            vendor = sta.get("vendor", "")
            marker = "▶" if state.selected_sta == i else " "
            iw(iy, 1, f" {marker}[{i}] {mac}", curses.color_pair(P_WHITE)|curses.A_BOLD); iy+=1
            if iy >= body_h-3: break
            iw(iy, 4, f"↳ {ssid}  {vendor}", curses.color_pair(P_DIM)); iy+=1

        iy+=1
        # ── Selected targets ──────────────────────────────────
        if iy < body_h-3:
            iw(iy, 1, f"{'SELECTED':─<{info_w-3}}", curses.color_pair(P_YELLOW)|curses.A_BOLD); iy+=1
        if iy < body_h-2:
            ap_label = state.wifi_aps[state.selected_ap].get("ssid","?") \
                       if state.selected_ap is not None and state.wifi_aps else "—"
            iw(iy, 1, f"  AP  ▸ {ap_label}", curses.color_pair(P_GREEN)|curses.A_BOLD); iy+=1
        if iy < body_h-2:
            sta_label = state.wifi_stations[state.selected_sta].get("mac","?") \
                        if state.selected_sta is not None and state.wifi_stations else "—"
            iw(iy, 1, f"  STA ▸ {sta_label}", curses.color_pair(P_CYAN)|curses.A_BOLD); iy+=1
        if state.packets_sent and iy < body_h-2:
            iw(iy, 1, f"  PKT ▸ {state.packets_sent}", curses.color_pair(P_YELLOW)); iy+=1

        # ── status bar ────────────────────────────────────────
        stat_win = stdscr.derwin(STATUS_H, sw, sh-STATUS_H, 0)
        safe_addstr(stat_win, 0, 0, "─"*sw, curses.color_pair(P_GREEN))
        conn = "CONNECTED" if state.connected else "DISCONNECTED"
        mode_str = "SIM" if state.simulation else "SERIAL"
        task_str = f"▶ {state.active_task}" if state.active_task else "IDLE"
        pkt_str  = f"  pkts:{state.packets_sent}" if state.packets_sent else ""
        status   = f"  {conn} | {mode_str} | {task_str}{pkt_str}   Q:quit"
        safe_addstr(stat_win, 1, 0, status[:sw], curses.color_pair(P_GREEN)|curses.A_BOLD)

        # ── input overlay ─────────────────────────────────────
        if input_mode:
            prompt = f"  {input_label} ▸ {input_buf}_"
            box_y  = sh//2
            box_w  = min(50, sw-4)
            box_x  = (sw - box_w)//2
            inp_win = stdscr.derwin(3, box_w, box_y, box_x)
            inp_win.erase()
            draw_box(inp_win, input_label, P_YELLOW)
            safe_addstr(inp_win, 1, 1, f" ▸ {input_buf}_"[:box_w-2], curses.color_pair(P_GREEN)|curses.A_BOLD)
            inp_win.refresh()

        stdscr.noutrefresh()
        curses.doupdate()

        # ── input handling ────────────────────────────────────
        key = stdscr.getch()

        if input_mode:
            if key in (curses.KEY_ENTER, 10, 13):
                cb = input_cb
                val = input_buf
                finish_input()
                if cb: cb(val)
            elif key in (curses.KEY_BACKSPACE, 127, 8):
                input_buf = input_buf[:-1]
            elif key == 27:   # ESC cancel
                finish_input()
            elif 32 <= key <= 126:
                input_buf += chr(key)
            continue

        if key == curses.KEY_UP:
            sel = (sel - 1) % len(MENU_ITEMS)
        elif key == curses.KEY_DOWN:
            sel = (sel + 1) % len(MENU_ITEMS)
        elif key in (curses.KEY_ENTER, 10, 13):
            cmd = MENU_ITEMS[sel][0]
            if not dispatch(cmd):
                break
        elif key in (ord('q'), ord('Q')):
            break
        # output scroll — only when cursor is in output area (just use PgUp/Dn)
        elif key == curses.KEY_PPAGE:
            log_off = min(log_off+10, max(0, len(log.recent(1000))-(body_h-2)))
        elif key == curses.KEY_NPAGE:
            log_off = max(0, log_off-10)

    engine.stop_all()


# ── entry point ────────────────────────────────────────────────
def get_agent_tools(engine, state, log):
    from langchain_core.tools import tool
    from typing import Any
    import time

    def wait_for_silence(initial_wait=4.0, silence_timeout=1.5, max_timeout=12.0):
        start_time = time.time()
        time.sleep(initial_wait)
        
        last_log_time = time.time()
        last_log_count = len(log.recent(1000))
        
        while (time.time() - start_time) < max_timeout:
            time.sleep(0.3)
            current_log_count = len(log.recent(1000))
            if current_log_count > last_log_count:
                last_log_time = time.time()
                last_log_count = current_log_count
            else:
                if (time.time() - last_log_time) >= silence_timeout:
                    break

    @tool
    def get_system_state() -> str:
        """
        Returns the current state of the GhostESP device/simulator, including 
        connection status, active tasks, selected targets, packets sent, and findings.
        """
        status = {
            "connected": state.connected,
            "simulation_mode": state.simulation,
            "active_task": state.active_task,
            "packets_sent": state.packets_sent,
            "selected_ap": state.selected_ap,
            "selected_sta": state.selected_sta,
            "wifi_aps_count": len(state.wifi_aps),
            "wifi_stations_count": len(state.wifi_stations),
        }
        return f"Current System State: {status}"

    @tool
    def scan_wifi_aps() -> str:
        """
        Scans for nearby WiFi Access Points (APs).
        This tool waits for the scan to complete and returns the list of discovered APs.
        """
        state.wifi_aps.clear()
        engine.send("scanap")
        wait_for_silence(initial_wait=4.0, silence_timeout=1.5, max_timeout=12.0)
        
        if not state.wifi_aps:
            return "No WiFi Access Points found. Please try scanning again."
        
        result = []
        for ap in state.wifi_aps:
            idx = ap.get('idx', '?')
            ssid = ap.get('ssid', '?')
            bssid = ap.get('bssid', '?')
            ch = ap.get('ch', '?')
            enc = ap.get('enc', '?')
            rssi = ap.get('rssi', '?')
            result.append(f"Index {idx}: SSID={ssid}, BSSID={bssid}, CH={ch}, ENC={enc}, RSSI={rssi}dBm")
        return "Discovered WiFi Access Points:\n" + "\n".join(result)

    @tool
    def scan_client_stations() -> str:
        """
        Scans for nearby client stations (devices associated with WiFi APs or sending probes).
        This tool waits for the scan to complete and returns the list of discovered stations.
        """
        state.wifi_stations.clear()
        engine.send("scansta")
        wait_for_silence(initial_wait=4.0, silence_timeout=1.5, max_timeout=12.0)
        
        if not state.wifi_stations:
            return "No client stations found. Please try scanning again."
        
        result = []
        for i, sta in enumerate(state.wifi_stations):
            result.append(f"Index {i}: MAC={sta.get('mac', '?')}, SSID={sta.get('ssid', '?')}, Vendor={sta.get('vendor', '?')}")
        return "Discovered Client Stations:\n" + "\n".join(result)

    @tool
    def select_ap_target(idx: int) -> str:
        """
        Selects a target Access Point (AP) from the list of scanned APs by index.
        Make sure you scan first so that the index exists.
        """
        if idx < 0 or idx >= len(state.wifi_aps):
            return f"Error: Index {idx} is out of bounds. Scanned AP count is {len(state.wifi_aps)}."
        engine.send(f"select -a {idx}")
        state.selected_ap = idx
        time.sleep(0.5)
        ap = state.wifi_aps[idx]
        return f"Successfully selected AP target: [{idx}] SSID={ap.get('ssid', '?')}, BSSID={ap.get('bssid', '?')}"

    @tool
    def select_station_target(idx: int) -> str:
        """
        Selects a target client station from the list of scanned stations by index.
        Make sure you scan stations first so that the index exists.
        """
        if idx < 0 or idx >= len(state.wifi_stations):
            return f"Error: Index {idx} is out of bounds. Scanned station count is {len(state.wifi_stations)}."
        engine.send(f"select -s {idx}")
        state.selected_sta = idx
        time.sleep(0.5)
        sta = state.wifi_stations[idx]
        return f"Successfully selected Station target: [{idx}] MAC={sta.get('mac', '?')}, SSID={sta.get('ssid', '?')}"

    @tool
    def scan_flipper_devices() -> str:
        """
        Scans for Flipper Zero devices via BLE.
        Waits for scan completion (approx 6 seconds).
        """
        initial_log_count = len(log.recent(1000))
        engine.send("blescan -f")
        wait_for_silence(initial_wait=3.5, silence_timeout=1.5, max_timeout=10.0)
        
        new_logs = log.recent(1000)[initial_log_count:]
        output_lines = [msg for ts, msg, kind in new_logs if "ble" in msg.lower() or "flipper" in msg.lower() or "found" in msg.lower() or "dev" in msg.lower()]
        
        return "BLE Flipper Zero scan completed.\nLogs:\n" + "\n".join(output_lines)

    @tool
    def scan_airtag_trackers() -> str:
        """
        Scans for Apple AirTag trackers via BLE.
        Waits for scan completion (approx 6 seconds).
        """
        initial_log_count = len(log.recent(1000))
        engine.send("blescan -a")
        wait_for_silence(initial_wait=3.5, silence_timeout=1.5, max_timeout=10.0)
        
        new_logs = log.recent(1000)[initial_log_count:]
        output_lines = [msg for ts, msg, kind in new_logs if "ble" in msg.lower() or "airtag" in msg.lower() or "found" in msg.lower() or "dev" in msg.lower()]
        
        return "BLE AirTag scan completed.\nLogs:\n" + "\n".join(output_lines)

    @tool
    def deauth_attack(duration_seconds: int = 5, stop_after: Any = True) -> str:
        """
        Performs a Deauthentication attack against the selected target AP and/or Station.
        You MUST select a target AP or station before launching this attack.
        - duration_seconds: duration in seconds to let the attack run.
        - stop_after: if True, stops the attack after duration_seconds. If False, lets it run in the background.
        """
        is_stop = stop_after
        if isinstance(is_stop, str):
            is_stop = is_stop.lower() in ("true", "1", "yes")
            
        if state.selected_ap is None and state.selected_sta is None:
            return "Error: No target (AP or Station) selected. Select a target first using select_ap_target or select_station_target."
        
        initial_log_count = len(log.recent(1000))
        engine.send("attack -d")
        time.sleep(1.0)
        
        if duration_seconds > 0:
            time.sleep(duration_seconds)
            
        packets = state.packets_sent
        new_logs = log.recent(1000)[initial_log_count:]
        attack_logs = [msg for ts, msg, kind in new_logs if "deauth" in msg.lower() or "packet" in msg.lower() or "attack" in msg.lower()]
        
        if is_stop:
            engine.stop_all()
            return f"Deauth attack executed for {duration_seconds} seconds. Sent approximately {packets} packets. Attack stopped.\nLogs:\n" + "\n".join(attack_logs)
        else:
            return f"Deauth attack launched in the background. Approximately {packets} packets sent so far. Use stop_tasks tool to stop it.\nLogs:\n" + "\n".join(attack_logs)

    @tool
    def apple_ble_spam(duration_seconds: int = 5, stop_after: Any = True) -> str:
        """
        Starts Apple Proximity BLE Spam attack (floods iOS devices).
        - duration_seconds: duration in seconds to let the spam run.
        - stop_after: if True, stops the spam after duration_seconds.
        """
        is_stop = stop_after
        if isinstance(is_stop, str):
            is_stop = is_stop.lower() in ("true", "1", "yes")

        initial_log_count = len(log.recent(1000))
        engine.send("blespam -apple")
        time.sleep(1.0)
        
        if duration_seconds > 0:
            time.sleep(duration_seconds)
            
        new_logs = log.recent(1000)[initial_log_count:]
        spam_logs = [msg for ts, msg, kind in new_logs if "spam" in msg.lower() or "ble" in msg.lower()]
        
        if is_stop:
            engine.stop_all()
            return f"Apple BLE Spam executed for {duration_seconds} seconds and then stopped.\nLogs:\n" + "\n".join(spam_logs)
        else:
            return "Apple BLE Spam launched in the background. Use stop_tasks tool to stop it.\nLogs:\n" + "\n".join(spam_logs)

    @tool
    def samsung_ble_spam(duration_seconds: int = 5, stop_after: Any = True) -> str:
        """
        Starts Samsung BLE Spam attack (floods Samsung/Android devices).
        - duration_seconds: duration in seconds to let the spam run.
        - stop_after: if True, stops the spam after duration_seconds.
        """
        is_stop = stop_after
        if isinstance(is_stop, str):
            is_stop = is_stop.lower() in ("true", "1", "yes")

        initial_log_count = len(log.recent(1000))
        engine.send("blespam -samsung")
        time.sleep(1.0)
        
        if duration_seconds > 0:
            time.sleep(duration_seconds)
            
        new_logs = log.recent(1000)[initial_log_count:]
        spam_logs = [msg for ts, msg, kind in new_logs if "spam" in msg.lower() or "ble" in msg.lower()]
        
        if is_stop:
            engine.stop_all()
            return f"Samsung BLE Spam executed for {duration_seconds} seconds and then stopped.\nLogs:\n" + "\n".join(spam_logs)
        else:
            return "Samsung BLE Spam launched in the background. Use stop_tasks tool to stop it.\nLogs:\n" + "\n".join(spam_logs)

    @tool
    def wifi_beacon_spam(duration_seconds: int = 5, stop_after: Any = True) -> str:
        """
        Starts WiFi SSID Beacon Spam / Flood (Random SSIDs).
        This generates fake access point networks with random SSIDs in target ranges.
        - duration_seconds: duration in seconds to let the flood run.
        - stop_after: if True, stops the flood after duration_seconds.
        """
        is_stop = stop_after
        if isinstance(is_stop, str):
            is_stop = is_stop.lower() in ("true", "1", "yes")

        initial_log_count = len(log.recent(1000))
        engine.send("beaconspam -r")
        time.sleep(1.0)
        
        if duration_seconds > 0:
            time.sleep(duration_seconds)
            
        new_logs = log.recent(1000)[initial_log_count:]
        beacon_logs = [msg for ts, msg, kind in new_logs if "beacon" in msg.lower() or "spam" in msg.lower() or "flood" in msg.lower()]
        
        if is_stop:
            engine.stop_all()
            return f"WiFi SSID Beacon Spam executed for {duration_seconds} seconds and then stopped.\nLogs:\n" + "\n".join(beacon_logs)
        else:
            return "WiFi SSID Beacon Spam launched in the background. Use stop_tasks tool to stop it.\nLogs:\n" + "\n".join(beacon_logs)

    @tool
    def rickroll_beacon_flood(duration_seconds: int = 5, stop_after: Any = True) -> str:
        """
        Starts Rickroll SSID Beacon Flood (spams Rick Astley lyrics as WiFi SSIDs).
        - duration_seconds: duration in seconds to let the flood run.
        - stop_after: if True, stops the flood after duration_seconds.
        """
        is_stop = stop_after
        if isinstance(is_stop, str):
            is_stop = is_stop.lower() in ("true", "1", "yes")

        initial_log_count = len(log.recent(1000))
        engine.send("beaconspam -rr")
        time.sleep(1.0)
        
        if duration_seconds > 0:
            time.sleep(duration_seconds)
            
        new_logs = log.recent(1000)[initial_log_count:]
        beacon_logs = [msg for ts, msg, kind in new_logs if "beacon" in msg.lower() or "spam" in msg.lower() or "flood" in msg.lower()]
        
        if is_stop:
            engine.stop_all()
            return f"Rickroll Beacon Flood executed for {duration_seconds} seconds and then stopped.\nLogs:\n" + "\n".join(beacon_logs)
        else:
            return "Rickroll Beacon Flood launched in the background. Use stop_tasks tool to stop it.\nLogs:\n" + "\n".join(beacon_logs)

    @tool
    def deploy_captive_portal(duration_seconds: int = 10, stop_after: Any = True) -> str:
        """
        Deploys an Evil Captive Portal SSID 'Free WiFi' to harvest credentials.
        - duration_seconds: duration to wait/sniff for client connections/credentials.
        - stop_after: if True, stops the portal after duration_seconds.
        """
        is_stop = stop_after
        if isinstance(is_stop, str):
            is_stop = is_stop.lower() in ("true", "1", "yes")

        initial_log_count = len(log.recent(1000))
        engine.send("startportal")
        time.sleep(1.0)
        
        if duration_seconds > 0:
            time.sleep(duration_seconds)
            
        new_logs = log.recent(1000)[initial_log_count:]
        portal_logs = [msg for ts, msg, kind in new_logs if "portal" in msg.lower() or "creds" in msg.lower() or "client" in msg.lower()]
        
        if is_stop:
            engine.stop_all()
            return f"Evil Captive Portal ran for {duration_seconds} seconds and was stopped.\nLogs:\n" + "\n".join(portal_logs)
        else:
            return "Evil Captive Portal launched in the background. Use stop_tasks tool to stop it.\nLogs:\n" + "\n".join(portal_logs)

    @tool
    def capture_frames(duration_seconds: int = 5, stop_after: Any = True) -> str:
        """
        Captures Probe and WPS frames passively from the air.
        - duration_seconds: duration to run capture.
        - stop_after: if True, stops capturing after duration_seconds.
        """
        is_stop = stop_after
        if isinstance(is_stop, str):
            is_stop = is_stop.lower() in ("true", "1", "yes")

        initial_log_count = len(log.recent(1000))
        engine.send("capture")
        time.sleep(1.0)
        
        if duration_seconds > 0:
            time.sleep(duration_seconds)
            
        new_logs = log.recent(1000)[initial_log_count:]
        cap_logs = [msg for ts, msg, kind in new_logs if "cap" in msg.lower() or "frame" in msg.lower() or "probe" in msg.lower() or "wps" in msg.lower()]
        
        if is_stop:
            engine.stop_all()
            return f"Passive frame capture ran for {duration_seconds} seconds and was stopped.\nLogs:\n" + "\n".join(cap_logs)
        else:
            return "Passive frame capture running in the background. Use stop_tasks tool to stop it.\nLogs:\n" + "\n".join(cap_logs)

    @tool
    def stop_tasks() -> str:
        """
        Stops all active attacks, scanning tasks, and background processes.
        """
        engine.stop_all()
        return "All active tasks and attacks have been successfully stopped."

    return [
        get_system_state,
        scan_wifi_aps,
        scan_client_stations,
        select_ap_target,
        select_station_target,
        scan_flipper_devices,
        scan_airtag_trackers,
        deauth_attack,
        apple_ble_spam,
        samsung_ble_spam,
        wifi_beacon_spam,
        rickroll_beacon_flood,
        deploy_captive_portal,
        capture_frames,
        stop_tasks
    ]


def run_ai_agent(state, log, engine, args):
    import os
    print("\n" + "═"*80)
    print("  GHOST ESP // AI OPERATOR SETUP")
    print("═"*80)
    
    try:
        api_key_input = input(f"Enter OpenRouter API Key: ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nExiting.")
        return
    api_key = api_key_input
    
    default_model = "qwen/qwen3.6-27b"
    try:
        model_input = input(f"Enter model name [Press Enter for '{default_model}']: ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nExiting.")
        return
    model_name = model_input if model_input else default_model
    
    print("\n[SYS] Initializing LangChain AI Agent...")
    
    # Set up engine connection
    engine.connect(args.port, args.baud)
    
    from langchain_groq import ChatGroq
    from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, ToolMessage
    
    system_prompt = (
        "You are the GhostESP AI Operator, an advanced security assistant. "
        "You have access to a suite of tools that control the GhostESP hardware or sandbox simulator.\n\n"
        "Here is the workflow you should follow:\n"
        "1. When asked to scan or attack, check what targets are available by calling scan tools first if necessary.\n"
        "2. Always select a target AP or Station index before launching attacks that require targets (like deauth_attack).\n"
        "3. If the user requests a background attack or passive sniff, make sure to set stop_after=False or as requested.\n"
        "4. Summarize your actions and findings clearly to the operator."
    )
    
    try:
        llm = ChatGroq(
            temperature=0.0,
            groq_api_key=api_key,
            model_name=model_name
        )
        tools = get_agent_tools(engine, state, log)
        llm_with_tools = llm.bind_tools(tools)
    except Exception as e:
        print(f"\n\033[91m[ERR] Failed to initialize Groq model/agent with '{model_name}': {e}\033[0m")
        try:
            fallback = input("Would you like to try a fallback model (e.g. 'qwen-2.5-coder-32b')? [Y/n]: ").strip().lower()
        except (KeyboardInterrupt, EOFError):
            return
        if fallback != 'n':
            fallback_model = "qwen-2.5-coder-32b"
            print(f"[SYS] Initializing with fallback model '{fallback_model}'...")
            try:
                llm = ChatGroq(
                    temperature=0.0,
                    groq_api_key=api_key,
                    model_name=fallback_model
                )
                tools = get_agent_tools(engine, state, log)
                llm_with_tools = llm.bind_tools(tools)
                model_name = fallback_model
            except Exception as e2:
                print(f"\033[91m[ERR] Fallback failed: {e2}. Exiting.\033[0m")
                return
        else:
            return

    # print gorgeous banner
    print("\n" + "═"*80)
    print("  GHOST ESP // AI AGENT CONSOLE ACTIVE")
    print("═"*80)
    print(f"  Model:   {model_name}")
    print(f"  Sandbox: {'Active (Virtual ESP32-S3)' if state.simulation else 'Serial Hardware Mode'}")
    print("  Type 'exit' to quit, 'help' for instructions.")
    print("═"*80 + "\n")
    
    chat_history = []
    
    last_printed_idx = 0
    def print_logs():
        nonlocal last_printed_idx
        while not state.stop_threads:
            recent_logs = log.recent(100)
            if len(recent_logs) > last_printed_idx:
                for item in recent_logs[last_printed_idx:]:
                    ts, msg, kind = item
                    col = "\033[90m" # dim
                    if kind in ("ok", "sys"):
                        col = "\033[92m" # green
                    elif kind == "err":
                        col = "\033[91m" # red
                    elif kind == "warn":
                        col = "\033[93m" # yellow
                    print(f"  {col}[ESP] {msg}\033[0m")
                last_printed_idx = len(recent_logs)
            time.sleep(0.3)

    log_thread = threading.Thread(target=print_logs, daemon=True)
    log_thread.start()
    
    while True:
        try:
            # Use ANSI colored prompt
            user_input = input("\033[95mghost-ai ▸ \033[0m").strip()
        except (KeyboardInterrupt, EOFError):
            break
            
        if not user_input:
            continue
            
        if user_input.lower() in ("exit", "quit"):
            break
            
        if user_input.lower() == "help":
            print("\nAvailable commands:")
            print("  - Ask anything: e.g. 'scan the wifi and select the third AP'")
            print("  - 'exit' or 'quit': terminate session")
            print("  - 'help': print this help message\n")
            continue
            
        print("\033[94mThinking...\033[0m")
        try:
            # Clear stop threads just in case
            state.stop_threads = False
            
            # Construct messages list including system message, history, and user input
            messages = [SystemMessage(content=system_prompt)]
            for role, text in chat_history:
                if role == "human":
                    messages.append(HumanMessage(content=text))
                elif role == "ai":
                    messages.append(AIMessage(content=text))
            
            messages.append(HumanMessage(content=user_input))
            
            while True:
                response = llm_with_tools.invoke(messages)
                messages.append(response)
                
                if not response.tool_calls:
                    output = response.content
                    break
                
                for tool_call in response.tool_calls:
                    tool_name = tool_call["name"]
                    tool_args = tool_call["args"]
                    tool_id = tool_call["id"]
                    
                    matched_tool = next((t for t in tools if t.name == tool_name), None)
                    if matched_tool:
                        print(f"\033[93m[AI-TOOL] Executing: {tool_name} with {tool_args}\033[0m")
                        try:
                            if isinstance(tool_args, dict):
                                tool_output = matched_tool.invoke(tool_args)
                            else:
                                tool_output = matched_tool.invoke(tool_args)
                        except Exception as te:
                            tool_output = f"Error running tool: {te}"
                    else:
                        tool_output = f"Error: Tool '{tool_name}' not found."
                        
                    print(f"\033[96m[AI-TOOL RESULT] {tool_output}\033[0m")
                    messages.append(ToolMessage(content=str(tool_output), tool_call_id=tool_id))
            
            print(f"\n\033[92mAI Operator:\033[0m {output}\n")
            
            chat_history.append(("human", user_input))
            chat_history.append(("ai", output))
            
        except Exception as e:
            print(f"\n\033[91m[ERR] Agent execution error: {e}\033[0m\n")
            
    engine.stop_all()
    print("\n\033[92mAI Agent Console exited.\033[0m\n")


def choose_serial_port():
    print("\n" + "═"*80)
    print("  GHOST ESP // PORT SELECTION")
    print("═"*80)
    
    ports = []
    if SERIAL_AVAILABLE:
        try:
            import serial.tools.list_ports
            ports = list(serial.tools.list_ports.comports())
        except Exception:
            pass
            
    if not ports:
        print("  No active serial ports detected.")
        print("  [0] Virtual Sandbox Mode (Simulator)")
        print("═"*80)
        try:
            choice = input("Select port [Press Enter for Virtual Sandbox]: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            sys.exit(0)
        return None
        
    for i, port in enumerate(ports):
        print(f"  [{i + 1}] {port.device} - {port.description}")
    print(f"  [0] Virtual Sandbox Mode (Simulator)")
    print("═"*80)
    
    while True:
        try:
            choice = input(f"Select serial port (0 to {len(ports)}) [Default: 0]: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            sys.exit(0)
            
        if not choice or choice == "0":
            return None
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(ports):
                return ports[idx].device
        except ValueError:
            pass
        print("Invalid selection. Please try again.")


# ── entry point ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="GhostESP TUI")
    parser.add_argument("-p","--port")
    parser.add_argument("-b","--baud", type=int, default=115200)
    args = parser.parse_args()

    if not args.port:
        args.port = choose_serial_port()

    state  = AppState()
    log    = LogBuffer()
    engine = GhostEngine(state, log)

    print("\n" + "═"*80)
    print("  GHOST ESP // BOOT SELECTOR")
    print("═"*80)
    print("  [1] Manual Mode (Interactive Curses TUI)")
    print("  [2] AI Agent Mode (LangChain Autonomous Operator)")
    print("═"*80)
    
    choice = ""
    while choice not in ("1", "2"):
        try:
            choice = input("Select operation mode (1 or 2): ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting.")
            sys.exit(0)
            
    if choice == "1":
        curses.wrapper(run_tui, state, log, engine, args)
        print("\n\033[92mGhostESP TUI exited.\033[0m\n")
    else:
        run_ai_agent(state, log, engine, args)

if __name__ == "__main__":
    main()