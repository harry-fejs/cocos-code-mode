import ctypes
import json
import subprocess
import sys
import time
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
EnumChildProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumChildWindows.argtypes = [wintypes.HWND, EnumChildProc, wintypes.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.SendMessageW.restype = wintypes.LPARAM
WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetAncestor.restype = wintypes.HWND
user32.GetParent.argtypes = [wintypes.HWND]
user32.GetParent.restype = wintypes.HWND
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetWindow.restype = wintypes.HWND
user32.GetDesktopWindow.restype = wintypes.HWND
GW_HWNDFIRST = 0
GW_HWNDNEXT = 2
GW_HWNDPREV = 3
GW_OWNER = 4
GW_ENABLEDPOPUP = 6
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetLastActivePopup.argtypes = [wintypes.HWND]
user32.GetLastActivePopup.restype = wintypes.HWND
user32.IsWindowEnabled.argtypes = [wintypes.HWND]
user32.IsWindowEnabled.restype = wintypes.BOOL
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
user32.SendMessageTimeoutW.restype = wintypes.LPARAM
BM_CLICK = 0x00F5
SMTO_ABORTIFHUNG = 0x0002
MAX_ITEMS = 32
MAX_ACTIONS = 16
MAX_CONTENT_CONTROLS = 16
MAX_CONTENT_CHARS = 4096
def text(hwnd, fn):
    buffer = ctypes.create_unicode_buffer(257)
    fn(hwnd, buffer, 257)
    value = buffer.value[:256]
    if value:
        return value
    length = int(user32.SendMessageW(hwnd, WM_GETTEXTLENGTH, 0, 0))
    if length <= 0:
        return ''
    buffer = ctypes.create_unicode_buffer(min(length + 1, 4097))
    user32.SendMessageW(hwnd, WM_GETTEXT, len(buffer), ctypes.cast(buffer, ctypes.LPWSTR))
    return buffer.value[:4096]
def pid_of(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)

def hwnd_string(hwnd):
    return f'0x{int(hwnd):X}'

def parse_hwnd(value):
    if not isinstance(value, str) or not value.lower().startswith('0x'):
        raise ValueError('invalid HWND')
    return wintypes.HWND(int(value[2:], 16))

def bounds(hwnd):
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return {'x': rect.left, 'y': rect.top, 'width': max(0, rect.right - rect.left), 'height': max(0, rect.bottom - rect.top)}

def content_text(dialog):
    script = r'''Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $ErrorActionPreference='Stop'; $e=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new(__HWND__)); $c=$e.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition); $parts=@(); for($i=0;$i -lt $c.Count -and $parts.Count -lt 16;$i++){ $x=$c.Item($i); if($x.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $x.Current.Name){ $parts += $x.Current.Name } }; $parts | ConvertTo-Json -Compress'''.replace('__HWND__', str(int(dialog)))
    try:
        output = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True, timeout=0.8, creationflags=subprocess.CREATE_NO_WINDOW)
        if output.returncode != 0:
            return {'text': None, 'source': None, 'truncated': False}
        raw = output.stdout.strip()
        values = json.loads(raw) if raw else []
        if isinstance(values, str):
            values = [values]
        parts = [value.strip() for value in values if isinstance(value, str) and value.strip()]
        joined = '\n'.join(parts)
        return {'text': joined[:MAX_CONTENT_CHARS] if joined else None, 'source': 'native-control' if joined else None, 'truncated': len(joined) > MAX_CONTENT_CHARS}
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
        return {'text': None, 'source': None, 'truncated': False}

def button_actions(dialog):
    result = []
    @EnumChildProc
    def visit(child, _):
        if text(child, user32.GetClassNameW) != 'Button':
            return True
        result.append({'hwnd': hwnd_string(child), 'label': text(child, user32.GetWindowTextW), 'enabled': bool(user32.IsWindowEnabled(child))})
        return len(result) < MAX_ACTIONS
    user32.EnumChildWindows(dialog, visit, 0)
    return result

def ordered_top_level_windows():
    rows = []
    seen = set()
    @EnumWindowsProc
    def visit(hwnd, _):
        if int(hwnd) in seen:
            return False
        seen.add(int(hwnd))
        rows.append(hwnd)
        return len(rows) < 4096
    complete = bool(user32.EnumWindows(visit, 0))
    return rows, complete

def inspect(pid):
    rows = []
    foreground = user32.GetForegroundWindow()
    desktop_order, order_complete = ordered_top_level_windows()
    z_rank = {int(hwnd): index for index, hwnd in enumerate(desktop_order)} if order_complete else {}
    @EnumWindowsProc
    def visit(hwnd, _):
        if pid_of(hwnd) != pid:
            return True
        class_name = text(hwnd, user32.GetClassNameW)
        owner = user32.GetWindow(hwnd, GW_OWNER)
        root_owner = user32.GetAncestor(hwnd, 3)
        rows.append({'hwnd': hwnd_string(hwnd), 'pid': pid, 'visible': bool(user32.IsWindowVisible(hwnd)), 'title': text(hwnd, user32.GetWindowTextW), 'className': class_name, 'ownerHwnd': hwnd_string(owner) if owner else None, 'rootOwnerHwnd': hwnd_string(root_owner) if root_owner else None, 'bounds': bounds(hwnd), 'foreground': int(hwnd) == int(foreground) if foreground else False, 'zOrderRank': z_rank.get(int(hwnd)), 'actions': button_actions(hwnd) if class_name == '#32770' else [], 'content': content_text(hwnd) if class_name == '#32770' else {'text': None, 'source': None, 'truncated': False}})
        return len(rows) < MAX_ITEMS
    row_scan_complete = bool(user32.EnumWindows(visit, 0))
    order_complete = order_complete and row_scan_complete
    if not order_complete:
        for row in rows:
            row['zOrderRank'] = None
    owners = [row for row in rows if row['ownerHwnd'] is None and row['zOrderRank'] is not None and row['className'] != '#32770']
    for main in owners:
        main_id = main['hwnd']
        main_hwnd = parse_hwnd(main_id)
        group = [row for row in rows if row['visible'] and row['className'] == '#32770' and (row['ownerHwnd'] == main_id or row['rootOwnerHwnd'] == main_id)]
        ranked = sorted((row for row in group if row['zOrderRank'] is not None), key=lambda row: row['zOrderRank'])
        if not ranked or len(ranked) != len(group):
            continue
        active = user32.GetLastActivePopup(main_hwnd)
        enabled = user32.GetWindow(main_hwnd, GW_ENABLEDPOPUP)
        unique_top = ranked[0]['hwnd'] if len(ranked) == 1 or ranked[0]['zOrderRank'] < ranked[1]['zOrderRank'] else None
        group_ids = {row['hwnd'].upper() for row in ranked}
        if unique_top and ((active and hwnd_string(active).upper() in group_ids and hwnd_string(active).upper() != unique_top.upper()) or (enabled and hwnd_string(enabled).upper() in group_ids and hwnd_string(enabled).upper() != unique_top.upper())):
            unique_top = None
        for index, row in enumerate(ranked):
            row['ownerGroupRank'] = index
            row['topCandidate'] = row['hwnd'] == unique_top
            row['lastActivePopup'] = bool(row['topCandidate'] and active and row['hwnd'].upper() == hwnd_string(active).upper())
            row['enabledPopup'] = bool(row['topCandidate'] and enabled and row['hwnd'].upper() == hwnd_string(enabled).upper())
    for row in rows:
        row.setdefault('ownerGroupRank', None)
        row.setdefault('topCandidate', False)
        row.setdefault('lastActivePopup', False)
        row.setdefault('enabledPopup', False)
    return {'windows': rows, 'foregroundHwnd': hwnd_string(foreground) if foreground else None, 'orderComplete': order_complete}
def activate(pid, popup_value, action_value, title, label, owner_value, owner_title, owner_class, expected_content):
    popup = parse_hwnd(popup_value)
    action = parse_hwnd(action_value)
    owner = parse_hwnd(owner_value)
    scan = inspect(pid)
    rows = scan['windows']
    row = next((item for item in rows if item['hwnd'].upper() == popup_value.upper()), None)
    main = next((item for item in rows if item['hwnd'].upper() == owner_value.upper()), None)
    if not row or not main or not row['visible'] or row['className'] != '#32770' or row['title'] != title:
        raise ValueError('popup identity is stale')
    if row['content'] != expected_content or expected_content['truncated']:
        raise ValueError('popup content changed or is truncated')
    owner_linked = row['ownerHwnd'] is not None and row['ownerHwnd'].upper() == owner_value.upper()
    tracked_fixture = (row['ownerHwnd'] is None and row['rootOwnerHwnd'] is not None and row['rootOwnerHwnd'].upper() == popup_value.upper() and title.startswith('CCP3X Action Qualification ') and len(title) == len('CCP3X Action Qualification ') + 32 and label == 'Cancel' and sorted(item['label'] for item in row['actions']) == ['Cancel', 'Continue'] and all(item['enabled'] for item in row['actions']))
    if not tracked_fixture and (not scan['orderComplete'] or not row['topCandidate'] or row['ownerGroupRank'] != 0):
        raise ValueError(f"popup top order is not verified (complete={scan['orderComplete']}, rank={row['zOrderRank']}, ownerGroupRank={row['ownerGroupRank']}, owner={row['ownerHwnd']}, main={main['hwnd']}, mainRank={main['zOrderRank']}, mainClass={main['className']}, mainVisible={main['visible']})")
    if not main['title'] == owner_title or main['className'] != owner_class or pid_of(owner) != pid or not (owner_linked or tracked_fixture):
        raise ValueError('popup owner is not verified')
    children = [item for item in row['actions'] if item['hwnd'].upper() == action_value.upper() and item['label'] == label and item['enabled']]
    if len(children) != 1 or pid_of(popup) != pid or pid_of(action) != pid:
        raise ValueError('action identity is stale')
    result = ctypes.c_size_t()
    if not user32.SendMessageTimeoutW(action, BM_CLICK, 0, 0, SMTO_ABORTIFHUNG, 300, ctypes.byref(result)):
        raise ValueError('button dispatch timed out')
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if not any(item['hwnd'].upper() == popup_value.upper() and item['visible'] for item in inspect(pid)['windows']):
            return {'activated': True, 'closed': True}
        time.sleep(0.02)
    return {'activated': True, 'closed': False}

if __name__ == '__main__':
    if len(sys.argv) not in (2, 10) or not sys.argv[1].isdigit():
        raise SystemExit('usage: native-popup-probe.py <pid> [popupHwnd actionHwnd title label ownerHwnd ownerTitle ownerClass contentJson]')
    pid = int(sys.argv[1])
    if len(sys.argv) == 10:
        expected_content = json.loads(sys.argv[9])
        if not isinstance(expected_content, dict) or set(expected_content) != {'text', 'source', 'truncated'} or expected_content['source'] not in (None, 'native-control') or not isinstance(expected_content['truncated'], bool) or (expected_content['text'] is not None and (not isinstance(expected_content['text'], str) or len(expected_content['text']) > MAX_CONTENT_CHARS)):
            raise SystemExit('invalid popup content')
        print(json.dumps(activate(pid, *sys.argv[2:9], expected_content), separators=(',', ':')))
    else:
        print(json.dumps(inspect(pid), separators=(',', ':')))
