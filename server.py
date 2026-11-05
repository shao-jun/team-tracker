#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""团队工作台 —— 本地轻量团队跟踪站点（零第三方依赖）
启动：python3 server.py  →  http://127.0.0.1:8770
数据：同目录 data.db (SQLite)
"""
import base64
import getpass
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "data.db")
STATIC = os.path.join(BASE, "static")
AVATAR_DIR = os.path.join(BASE, "avatars")
PORT = int(os.environ.get("PORT", "8770"))

CATEGORIES = ("需求", "任务", "其他")
PRIO_CN = {"P0": "高", "P1": "中", "P2": "低"}

STATUS_CN = {"todo": "待办", "doing": "进行中", "paused": "暂停", "review": "待验收", "blocked": "阻塞", "done": "已完成"}
FIELD_CN = {
    "title": "标题", "detail": "说明", "member_id": "负责人", "status": "状态",
    "priority": "优先级", "category": "类型", "progress": "进度",
    "start_date": "开始日期", "due_date": "截止日期", "estimate": "预估工时",
}
MAX_AVATAR_BYTES = 3 * 1024 * 1024
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  color TEXT DEFAULT '#4f46e5',
  capacity INTEGER DEFAULT 40,
  active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0,
  ip TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  last_seen TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  member_id INTEGER,
  action TEXT DEFAULT 'update',
  field TEXT DEFAULT '',
  old_value TEXT DEFAULT '',
  new_value TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER,
  week_start TEXT,
  content TEXT DEFAULT '',
  submitted_at TEXT,
  ip TEXT DEFAULT '',
  UNIQUE(member_id, week_start)
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  member_id INTEGER,
  status TEXT DEFAULT 'todo',
  priority TEXT DEFAULT 'P1',
  category TEXT DEFAULT '需求',
  progress INTEGER DEFAULT 0,
  start_date TEXT,
  due_date TEXT,
  estimate REAL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS kpis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER,
  name TEXT NOT NULL,
  cat TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  target REAL DEFAULT 100,
  current REAL DEFAULT 0,
  period TEXT DEFAULT 'month',
  direction TEXT DEFAULT 'up',
  weight INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  member_id INTEGER,
  content TEXT NOT NULL,
  kind TEXT DEFAULT 'note',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT DEFAULT '',
  member_id INTEGER,
  guest INTEGER DEFAULT 0,
  agent TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS hosts (
  ip TEXT PRIMARY KEY,
  host TEXT DEFAULT '',
  os_user TEXT DEFAULT '',
  source TEXT DEFAULT '',
  updated_at TEXT
);
"""


# ---------------------------------------------------------------- db helpers
def conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    return c


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


def today():
    return date.today().isoformat()


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def mask_phone(p):
    """138****5678；没有号码返回空。"""
    digits = re.sub(r"\D", "", p or "")
    if len(digits) < 7:
        return ""
    return digits[:3] + "****" + digits[-4:]


def member_view(m, with_phone=False):
    """给前端的成员对象：默认不带手机号，只给是否已登记 + 掩码。"""
    out = dict(m)
    phone = out.pop("phone", "") or ""
    out["has_phone"] = bool(re.sub(r"\D", "", phone))
    out["phone_mask"] = mask_phone(phone)
    if with_phone:
        out["phone"] = phone
    return out


# 验证码失败计数（按 IP），超过阈值锁 10 分钟
FAILS = {}
FAILS_LOCK = threading.Lock()
FAIL_LIMIT = 5
FAIL_WINDOW = 600


def fail_guard(ip):
    """返回剩余锁定秒数；0 表示可以尝试。"""
    with FAILS_LOCK:
        n, ts = FAILS.get(ip, (0, 0))
        if time.time() - ts > FAIL_WINDOW:
            FAILS.pop(ip, None)
            return 0
        if n >= FAIL_LIMIT:
            return int(FAIL_WINDOW - (time.time() - ts))
        return 0


def fail_note(ip, ok=False):
    with FAILS_LOCK:
        if ok:
            FAILS.pop(ip, None)
            return
        n, _ = FAILS.get(ip, (0, 0))
        FAILS[ip] = (n + 1, time.time())


def is_local_req(handler):
    """请求是否来自本机（localhost / 127.0.0.1）。成员增改只允许在这种访问下进行。"""
    ip = (handler.client_address[0] if handler.client_address else "") or ""
    if ip.startswith("::ffff:"):
        ip = ip[7:]
    return ip in ("127.0.0.1", "::1", "0.0.0.0")


def client_ip(handler):
    ip = (handler.client_address[0] if handler.client_address else "") or ""
    if ip.startswith("::ffff:"):
        ip = ip[7:]
    if ip in ("::1", "0.0.0.0"):
        ip = "127.0.0.1"
    # 在本机用 127.0.0.1 / localhost / 局域网地址打开，都算同一个人
    if ip == "127.0.0.1":
        ip = local_ip() or ip
    return ip


def who_is(c, ip):
    """按 IP 反查当前操作人；查不到返回 None。"""
    if not ip:
        return None
    row = c.execute("SELECT * FROM members WHERE ip=? AND active=1", (ip,)).fetchone()
    return dict(row) if row else None


def is_guest(c, ip):
    """该 IP 是否被标记为游客（选了「参观一下」，且没有绑定成员）。"""
    if not ip or who_is(c, ip):
        return False
    r = c.execute("SELECT guest FROM visits WHERE ip=? ORDER BY id DESC LIMIT 1", (ip,)).fetchone()
    return bool(r and r["guest"])


# ---------------------------------------------------------------- 设备信息
LOCAL_IPS = {"127.0.0.1", "::1", "localhost", ""}


def _cmd(args, timeout=1.2):
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=timeout, universal_newlines=True)
        return p.stdout or ""
    except Exception:  # noqa
        return ""


def local_ip():
    """本机在局域网里的地址，用来判断「访问者就是跑服务的这台机器」。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:  # noqa
        return ""


def resolve_host(ip):
    """尽力获取设备名与登录用户名。

    - 本机访问：直接读系统，能拿到登录用户名 + 主机名；
    - 局域网其它机器：没有凭据拿不到对方登录账号，只能靠 NetBIOS / 反向解析拿设备名，
      成不成功取决于对方系统（Windows 开 NetBIOS、DNS 有记录）。
    """
    out = {"ip": ip, "host": "", "os_user": "", "source": ""}
    if ip in LOCAL_IPS or ip == local_ip():
        out["host"] = socket.gethostname()
        out["os_user"] = getpass.getuser()
        out["source"] = "本机"
        # 本机如果有图形会话，优先取当前登录的桌面用户
        sess = _cmd(["loginctl", "list-sessions", "--no-legend"])
        for line in sess.splitlines():
            parts = line.split()
            if len(parts) >= 3:
                out["os_user"] = parts[2]
                break
        return out

    txt = _cmd(["nmblookup", "-A", ip], 1.5)
    for line in txt.splitlines():
        bits = line.split()
        if len(bits) >= 2 and bits[1] == "<00>" and "<GROUP>" not in line:
            out["host"], out["source"] = bits[0], "NetBIOS"
            break
    if not out["host"]:
        try:
            out["host"] = socket.gethostbyaddr(ip)[0]
            out["source"] = "反向解析"
        except Exception:  # noqa
            pass
    if not out["host"]:
        bits = _cmd(["getent", "hosts", ip]).split()
        if len(bits) >= 2:
            out["host"], out["source"] = bits[1], "DNS"
    return out


def refresh_host(ip):
    """解析并落库；同一 IP 6 小时内不重复解析。"""
    if not ip:
        return
    c = conn()
    row = c.execute("SELECT * FROM hosts WHERE ip=?", (ip,)).fetchone()
    fresh = row and row["updated_at"] and row["updated_at"] >= (
        datetime.now() - timedelta(hours=6)).strftime("%Y-%m-%d %H:%M:%S")
    c.close()
    if fresh:
        return
    info = resolve_host(ip)
    c = conn()
    c.execute("INSERT OR REPLACE INTO hosts(ip,host,os_user,source,updated_at) VALUES(?,?,?,?,?)",
              (ip, info["host"] or "", info["os_user"] or "", info["source"] or "", now()))
    c.commit()
    c.close()


def kick_host(ip):
    """页面加载不等解析结果，后台补设备信息。"""
    try:
        threading.Thread(target=refresh_host, args=(ip,), daemon=True).start()
    except Exception:  # noqa
        pass


def visit_summary(c, limit=200):
    """按 IP 汇总访问次数；IP 能对上成员就显示人名，并附设备名/系统登录用户。"""
    names = {r["ip"]: r["name"] for r in rows(c.execute("SELECT ip,name FROM members WHERE ip<>''"))}
    rs = rows(c.execute(
        "SELECT v.ip AS ip, COUNT(*) AS n, MAX(v.created_at) AS last, MAX(v.guest) AS g, "
        "       MAX(v.member_id) AS mid, MAX(h.host) AS host, MAX(h.os_user) AS os_user, "
        "       MAX(h.source) AS source, "
        "       (SELECT note FROM visits v2 WHERE v2.ip=v.ip AND v2.note<>'' ORDER BY v2.id DESC LIMIT 1) AS note, "
        "       (SELECT platform FROM visits v3 WHERE v3.ip=v.ip ORDER BY v3.id DESC LIMIT 1) AS platform "
        "FROM visits v LEFT JOIN hosts h ON h.ip=v.ip "
        "GROUP BY v.ip ORDER BY n DESC, last DESC LIMIT ?", (limit,)))
    for r in rs:
        r["name"] = names.get(r["ip"], "")
        r["guest"] = bool(r["g"])
        if not r["name"] and r["mid"]:
            row = c.execute("SELECT name FROM members WHERE id=?", (r["mid"],)).fetchone()
            r["name"] = row["name"] if row else ""
        r["host"] = r["host"] or ""
        r["os_user"] = r["os_user"] or ""
        r.pop("g", None)
        r.pop("mid", None)
    total = c.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
    today_n = c.execute("SELECT COUNT(*) FROM visits WHERE date(created_at)=?", (today(),)).fetchone()[0]
    guests = c.execute("SELECT COUNT(DISTINCT ip) FROM visits WHERE guest=1").fetchone()[0]
    return {"total": total, "today": today_n, "guests": guests, "rows": rs}


def add_log(c, task_id, member_id, ip, action, field="", old="", new=""):
    c.execute(
        "INSERT INTO task_logs(task_id,member_id,action,field,old_value,new_value,ip,created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (task_id, member_id, action, field, str(old), str(new), ip, now()))


def log_text(field, value, c):
    if field == "status":
        return STATUS_CN.get(value, value or "-")
    if field == "member_id":
        if not value:
            return "未指派"
        row = c.execute("SELECT name FROM members WHERE id=?", (value,)).fetchone()
        return row[0] if row else str(value)
    return "" if value is None else str(value)


def week_start_of(d):
    """周报周期按「上周五 ~ 本周四」计算：取不晚于 d 的最近一个周五。"""
    return (d - timedelta(days=(d.weekday() - 4) % 7)).isoformat()


def init_db(with_demo=True):
    first = not os.path.exists(DB_PATH) or os.path.getsize(DB_PATH) == 0
    c = conn()
    c.executescript(SCHEMA)
    c.commit()
    migrate(c)
    n = c.execute("SELECT COUNT(*) FROM members").fetchone()[0]
    c.close()
    if (first or n == 0) and with_demo:
        seed()


def migrate(c):
    """给老库补列，保持向后兼容（不动已有数据）。"""
    def cols(t):
        return [r[1] for r in c.execute("PRAGMA table_info(%s)" % t).fetchall()]

    mc = cols("members")
    for name, ddl in (("ip", "TEXT DEFAULT ''"), ("avatar", "TEXT DEFAULT ''"),
                      ("last_seen", "TEXT DEFAULT ''"), ("phone", "TEXT DEFAULT ''")):
        if name not in mc:
            c.execute("ALTER TABLE members ADD COLUMN %s %s" % (name, ddl))
    uc = cols("updates")
    if "ip" not in uc:
        c.execute("ALTER TABLE updates ADD COLUMN ip TEXT DEFAULT ''")
    vc = cols("visits")
    if vc:
        for name in ("platform", "note"):
            if name not in vc:
                c.execute("ALTER TABLE visits ADD COLUMN %s TEXT DEFAULT ''" % name)
    kc = cols("kpis")
    if kc and "cat" not in kc:
        c.execute("ALTER TABLE kpis ADD COLUMN cat TEXT DEFAULT ''")
    c.commit()


def seed():
    """演示数据：按今天动态生成日期，首次打开就能看到完整效果。"""
    d = date.today()
    c = conn()
    cur = c.cursor()
    members = [
        ("张明", "桌面客户端", "#4f46e5", 40),
        ("李静", "后端 / 平台", "#0ea5e9", 40),
        ("陈昊", "测试 / 质量", "#10b981", 40),
        ("赵敏", "产品 / 交付", "#f59e0b", 36),
    ]
    for i, (n, r, col, cap) in enumerate(members):
        cur.execute(
            "INSERT INTO members(name,role,color,capacity,sort) VALUES(?,?,?,?,?)",
            (n, r, col, cap, i),
        )
    mid = {n: i + 1 for i, (n, _, _, _) in enumerate(members)}

    def dt(offset):
        return (d + timedelta(days=offset)).isoformat()

    tasks = [
        # title, member, status, prio, category, progress, start, due, est, detail
        ("统一登录组件适配 deepin 25", "李静", "doing", "P0", "需求", 65, -6, 3, 24,
         "对接新认证服务，替换本地 pam 调用；已完成后端 token 刷新逻辑，客户端联调中。"),
        ("任务栏崩溃堆栈归因（kwin_x11）", "张明", "doing", "P0", "缺陷", 40, -4, 5, 16,
         "崩溃集中在多屏切换场景，疑似 screen 对象生命周期问题，正在补符号表复现。"),
        ("应用商店更新失败排查", "陈昊", "review", "P1", "缺陷", 90, -9, -1, 12,
         "定位为证书链校验超时，补丁已提测，等待研发复核后关闭。"),
        ("多屏缩放记忆策略设计", "赵敏", "doing", "P1", "需求", 30, -3, 7, 20,
         "输出策略文档，覆盖热插拔、混合 DPI、外接投影三类场景。"),
        ("1070 版本回归用例补充", "陈昊", "todo", "P1", "测试", 0, 1, 8, 16,
         "针对本次修改的 dock 与文件管理器模块补充 30 条回归用例。"),
        ("dde-dock 内存泄漏修复", "张明", "blocked", "P0", "缺陷", 55, -12, 2, 30,
         "阻塞点：需要上游 qt5integration 补丁先合入，正在等社区反馈。"),
        ("文件管理器右键菜单卡顿", "李静", "done", "P1", "缺陷", 100, -10, -2, 8,
         "改为异步构建菜单项，首帧从 780ms 降到 120ms。"),
        ("桌面图标布局持久化", "张明", "done", "P2", "需求", 100, -14, -5, 12,
         "按显示器序列化布局，重启与分辨率切换后均可恢复。"),
        ("周版本发布说明整理", "赵敏", "done", "P2", "交付", 100, -3, -1, 4,
         "汇总 12 条变更，已同步到内部发布页。"),
        ("工单自动分派脚本", "李静", "todo", "P2", "运维", 0, 3, 12, 10,
         "按模块关键词把 ztgd 工单自动路由到对应研发，减少人工分派。"),
        ("输入法候选框错位", "陈昊", "doing", "P2", "缺陷", 20, -1, 6, 6,
         "复现于 150% 缩放 + 双屏，待与输入法团队对齐坐标换算口径。"),
    ]
    for t in tasks:
        title, mem, st, prio, cat, prog, s, due, est, detail = t
        done_at = (datetime.now() - timedelta(days=abs(due))).strftime("%Y-%m-%d %H:%M:%S") if st == "done" else None
        cur.execute(
            """INSERT INTO tasks(title,detail,member_id,status,priority,category,progress,start_date,due_date,estimate,created_at,updated_at,done_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (title, detail, mid[mem], st, prio, cat, prog, dt(s), dt(due), est,
             dt(s) + " 09:30:00", dt(min(0, due)) + " 18:00:00", done_at),
        )
    tid = {r[1]: r[0] for r in cur.execute("SELECT id,title FROM tasks").fetchall()}

    kpis = [
        ("张明", "崩溃工单闭环率", "%", 90, 86, "month", "up", 3),
        ("张明", "平均修复时长", "天", 3, 4.2, "month", "down", 2),
        ("张明", "代码评审数", "次", 8, 9, "month", "up", 1),
        ("李静", "需求按期交付率", "%", 95, 92, "month", "up", 3),
        ("李静", "接口平均响应", "ms", 200, 168, "week", "down", 2),
        ("陈昊", "回归用例覆盖", "%", 100, 88, "month", "up", 3),
        ("陈昊", "遗留缺陷数", "个", 8, 11, "month", "down", 2),
        ("赵敏", "版本按时发布", "%", 100, 100, "month", "up", 3),
        ("赵敏", "客户问题响应", "小时", 4, 3.2, "week", "down", 2),
    ]
    for i, (m, name, unit, target, cur_v, period, direction, weight) in enumerate(kpis):
        cur.execute(
            """INSERT INTO kpis(member_id,name,unit,target,current,period,direction,weight,sort,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (mid[m], name, unit, target, cur_v, period, direction, weight, i, now()),
        )

    notes = [
        ("统一登录组件适配 deepin 25", "李静", "token 刷新逻辑完成，客户端联调通过 3/5 场景", -2),
        ("统一登录组件适配 deepin 25", "李静", "剩余离线登录与账号切换两个场景", -1),
        ("任务栏崩溃堆栈归因（kwin_x11）", "张明", "补齐 symbol 后确认崩在 QScreen 析构", -1),
        ("dde-dock 内存泄漏修复", "张明", "上游补丁 review 中，暂无法继续", -3),
        ("应用商店更新失败排查", "陈昊", "证书链超时补丁已提测，等待复核", -1),
        ("多屏缩放记忆策略设计", "赵敏", "策略文档初稿完成，待评审", -1),
        ("文件管理器右键菜单卡顿", "李静", "异步构建菜单项已合入主线", -3),
    ]
    for title, mem, content, off in notes:
        cur.execute(
            "INSERT INTO updates(task_id,member_id,content,kind,created_at) VALUES(?,?,?,?,?)",
            (tid[title], mid[mem], content, "note", (datetime.now() + timedelta(days=off)).strftime("%Y-%m-%d 17:%M")),
        )
    c.commit()
    c.close()


# ---------------------------------------------------------------- payload helpers
def task_payload(data, existing=None):
    fields = ["title", "detail", "member_id", "status", "priority", "category",
              "progress", "start_date", "due_date", "estimate"]
    out = {}
    for f in fields:
        if f in data:
            v = data[f]
            if f in ("member_id", "progress"):
                v = int(v) if str(v).strip() not in ("", "None") else None
            elif f == "estimate":
                v = float(v or 0)
            elif f == "title":
                v = str(v).strip()
            out[f] = v
    if "status" in out and out["status"] not in STATUS_CN:
        raise ValueError("非法状态")
    if "category" in out:
        cat = str(out["category"] or "").strip()
        out["category"] = cat if cat in CATEGORIES else "其他"
    if "progress" in out and out["progress"] is not None:
        out["progress"] = max(0, min(100, out["progress"]))
    if out.get("status") == "done":
        out["progress"] = 100
        out["done_at"] = now()
    elif existing and existing.get("status") == "done" and "status" in out:
        out["done_at"] = None
    # 进度与状态联动：有进度就是进行中，100% 就是已完成，归零回未开始
    if out.get("progress") is not None:
        prog = out["progress"]
        st = out.get("status") or (existing or {}).get("status") or "todo"
        if prog >= 100:
            out["status"] = "done"
            out["progress"] = 100
            if st != "done":
                out["done_at"] = now()
        elif prog > 0 and st in ("todo", "done"):
            out["status"] = "doing"
            if st == "done":
                out["done_at"] = None
        elif prog == 0 and st == "done":
            out["status"] = "todo"
            out["done_at"] = None
    return out


# ---------------------------------------------------------------- report
def build_report(start_s, end_s):
    c = conn()
    members = rows(c.execute("SELECT * FROM members WHERE active=1 ORDER BY sort,id"))
    mname = {m["id"]: m["name"] for m in members}
    tasks = rows(c.execute("SELECT * FROM tasks"))
    kpis = rows(c.execute("SELECT * FROM kpis"))
    ups = rows(c.execute(
        "SELECT * FROM updates WHERE date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC",
        (start_s, end_s)))
    c.close()

    def fdate(s):
        if not s:
            return "—"
        return s[5:10].replace("-", "/")

    start_d = datetime.strptime(start_s, "%Y-%m-%d").date()
    end_d = datetime.strptime(end_s, "%Y-%m-%d").date()

    def done_in(t):
        return t["status"] == "done" and t["done_at"] and start_s <= t["done_at"][:10] <= end_s

    done = [t for t in tasks if done_in(t)]
    doing = [t for t in tasks if t["status"] in ("doing", "review", "blocked")]
    overdue = [t for t in tasks if t["status"] not in ("done", "paused")
               and t["due_date"] and t["due_date"] < date.today().isoformat()]
    paused = [t for t in tasks if t["status"] == "paused"]
    nxt_start = end_d + timedelta(days=1)
    nxt_end = end_d + timedelta(days=7)
    upcoming = [t for t in tasks if t["status"] != "done" and t["due_date"]
                and nxt_start.isoformat() <= t["due_date"] <= nxt_end.isoformat()]
    upcoming.sort(key=lambda t: t["due_date"])

    by_member = {m["id"]: {"doing": 0, "done": 0} for m in members}
    for t in doing:
        if t["member_id"] in by_member:
            by_member[t["member_id"]]["doing"] += 1
    for t in done:
        if t["member_id"] in by_member:
            by_member[t["member_id"]]["done"] += 1

    lines = []
    lines.append("# 团队周报（%s ~ %s）" % (start_s, end_s))
    lines.append("")
    lines.append("> 自动生成于 %s · 共 %d 名成员 · 本期完成 %d 项，进行中 %d 项，逾期 %d 项"
                 % (datetime.now().strftime("%Y-%m-%d %H:%M"), len(members), len(done), len(doing), len(overdue)))
    lines.append("")

    lines.append("## 一、本期完成（%d 项）" % len(done))
    if done:
        for t in sorted(done, key=lambda x: x["done_at"] or ""):
            lines.append("- **%s** — %s · %s 完成 · %s" % (
                t["title"], mname.get(t["member_id"], "未指派"),
                fdate(t["done_at"]), t["category"]))
    else:
        lines.append("- 无已完成事务")
    lines.append("")

    lines.append("## 二、进行中（%d 项）" % len(doing))
    if doing:
        for t in sorted(doing, key=lambda x: (x["due_date"] or "9999", -x["progress"])):
            tail = ""
            latest = next((u for u in ups if u["task_id"] == t["id"] and u["kind"] == "note"), None)
            if latest:
                tail = "；最新进展：" + latest["content"]
            flag = "「阻塞」" if t["status"] == "blocked" else ""
            lines.append("- %s**%s**%s — %s · 进度 %d%%%s · 截止 %s" % (
                "⚠️ " if t["status"] == "blocked" else "", t["title"], flag,
                mname.get(t["member_id"], "未指派"), t["progress"], tail, fdate(t["due_date"])))
    else:
        lines.append("- 无进行中事务")
    if paused:
        lines.append("")
        lines.append("- 暂停中（%d 项）：%s" % (len(paused), "；".join(
            "%s（%s）" % (t["title"], mname.get(t["member_id"], "未指派")) for t in paused)))
    lines.append("")

    lines.append("## 三、风险与逾期（%d 项）" % len(overdue))
    if overdue:
        for t in sorted(overdue, key=lambda x: x["due_date"]):
            days = (date.today() - datetime.strptime(t["due_date"], "%Y-%m-%d").date()).days
            lines.append("- **%s** — %s · 已逾期 %d 天 · 当前进度 %d%%" % (
                t["title"], mname.get(t["member_id"], "未指派"), days, t["progress"]))
    else:
        lines.append("- 无逾期事务")
    lines.append("")

    lines.append("## 四、下周计划（%d 项）" % len(upcoming))
    if upcoming:
        for t in upcoming:
            lines.append("- %s — %s · 截止 %s · 优先级 %s" % (
                t["title"], mname.get(t["member_id"], "未指派"), fdate(t["due_date"]), PRIO_CN.get(t["priority"], t["priority"])))
    else:
        lines.append("- 暂无排期事务")
    lines.append("")

    lines.append("## 五、成员概览")
    lines.append("")
    lines.append("| 成员 | 进行中 | 本期完成 | KPI 达成 |")
    lines.append("| --- | --- | --- | --- |")
    for m in members:
        mine = [k for k in kpis if k["member_id"] == m["id"]]
        if mine:
            rates = []
            for k in mine:
                tgt = k["target"] or 1
                if k["direction"] == "down":
                    rates.append(min(1.6, tgt / k["current"]) if k["current"] else 0)
                else:
                    rates.append(min(1.6, k["current"] / tgt) if tgt else 0)
            rate = int(sum(rates) / len(rates) * 100)
        else:
            rate = 0
        lines.append("| %s | %d | %d | %d%% |" % (
            m["name"], by_member[m["id"]]["doing"], by_member[m["id"]]["done"], rate))
    lines.append("")

    c2 = conn()
    reps = rows(c2.execute(
        "SELECT r.*, m.name AS mname FROM reports r LEFT JOIN members m ON m.id = r.member_id "
        "WHERE r.week_start >= ? AND r.week_start <= ? ORDER BY m.sort, m.id", (start_s, end_s)))
    c2.close()
    submitted_ids = set(r["member_id"] for r in reps)
    missing = [m for m in members if m["id"] not in submitted_ids]

    lines.append("## 六、成员周报（已提交 %d / %d）" % (len(submitted_ids), len(members)))
    lines.append("")
    if reps:
        for r in reps:
            lines.append("### %s" % (r["mname"] or "未知成员"))
            for ln in (r["content"] or "").split("\n"):
                lines.append("" if not ln.strip() else ln.rstrip())
            lines.append("")
            lines.append("*提交于 %s*" % (r["submitted_at"] or "")[:16])
            lines.append("")
    else:
        lines.append("- 还没有成员提交周报")
        lines.append("")
    if missing:
        lines.append("未提交：%s" % "、".join(m["name"] for m in missing))
        lines.append("")

    stalled = [t for t in doing if not any(u["task_id"] == t["id"] and u["created_at"][:10] >= (date.today() - timedelta(days=4)).isoformat() for u in ups)]
    if stalled:
        lines.append("## 七、需要关注")
        for t in stalled[:5]:
            lines.append("- %s（%s）超过 3 天无进展记录，建议同步进展或调整排期" % (
                t["title"], mname.get(t["member_id"], "未指派")))
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    server_version = "TeamTracker/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # ---------- plumbing
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw or "{}")

    def _err(self, msg, code=400):
        self._json({"ok": False, "error": msg}, code)

    # ---------- GET
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        qs = parse_qs(u.query)
        try:
            if path == "/api/bootstrap":
                return self.api_bootstrap()
            if path == "/api/whoami":
                return self.api_whoami()
            if path == "/api/visits":
                return self.api_visits()
            if path == "/api/reports":
                return self.api_reports(qs)
            if path == "/api/reports/draft":
                return self.api_report_draft(qs)
            if path == "/api/report":
                end = qs.get("end", [date.today().isoformat()])[0]
                start = qs.get("start", [(date.today() - timedelta(days=6)).isoformat()])[0]
                md = build_report(start, end)
                if qs.get("format", ["json"])[0] == "md":
                    return self._send(200, md, "text/markdown; charset=utf-8")
                return self._json({"ok": True, "start": start, "end": end, "markdown": md})
            if path == "/health":
                return self._json({"ok": True, "time": now()})
            return self.serve_static(path)
        except Exception as e:  # noqa
            self._err("服务端错误：%s" % e, 500)

    def api_bootstrap(self):
        c = conn()
        members = [member_view(m, is_local_req(self)) for m in rows(c.execute("SELECT * FROM members ORDER BY sort,id"))]
        tasks = rows(c.execute("SELECT * FROM tasks ORDER BY (due_date IS NULL), due_date, id"))
        kpis = rows(c.execute("SELECT * FROM kpis ORDER BY member_id, sort, id"))
        updates = rows(c.execute(
            "SELECT u.*, m.name AS member_name FROM updates u LEFT JOIN members m ON m.id=u.member_id "
            "ORDER BY u.created_at DESC, u.id DESC LIMIT 500"))
        logs = rows(c.execute(
            "SELECT l.*, m.name AS member_name FROM task_logs l LEFT JOIN members m ON m.id=l.member_id "
            "ORDER BY l.id DESC LIMIT 800"))
        vis = visit_summary(c, 8)
        c.close()
        self._json({"ok": True, "today": today(), "members": members, "tasks": tasks,
                    "kpis": kpis, "updates": updates, "logs": logs, "visits": vis})

    def api_whoami(self):
        ip = client_ip(self)
        c = conn()
        m = who_is(c, ip)
        if m:
            c.execute("UPDATE members SET last_seen=? WHERE id=?", (now(), m["id"]))
            c.commit()
        guest = is_guest(c, ip)
        nr = c.execute("SELECT note FROM visits WHERE ip=? AND note<>'' ORDER BY id DESC LIMIT 1", (ip,)).fetchone()
        c.close()
        self._json({"ok": True, "ip": ip, "member": (member_view(m) if m else None), "guest": guest,
                    "note": (nr["note"] if nr else ""), "local": is_local_req(self)})

    def api_visits(self):
        c = conn()
        data = visit_summary(c)
        c.close()
        data["ok"] = True
        self._json(data)

    def record_visit(self):
        d = self._body()
        ip = client_ip(self)
        c = conn()
        me = who_is(c, ip)
        guest = 0 if me else (1 if d.get("kind") == "guest" else 0)
        c.execute("INSERT INTO visits(ip,member_id,guest,agent,platform,note,created_at) VALUES(?,?,?,?,?,?,?)",
                  (ip, me["id"] if me else None, guest,
                   (self.headers.get("User-Agent") or "")[:180],
                   (d.get("platform") or "")[:120], (d.get("note") or "")[:40], now()))
        c.commit()
        c.close()
        kick_host(ip)
        self._json({"ok": True, "guest": bool(guest)})

    def api_reports(self, qs):
        week = qs.get("week", [week_start_of(date.today())])[0]
        c = conn()
        members = [member_view(m) for m in rows(c.execute("SELECT * FROM members WHERE active=1 ORDER BY sort,id"))]
        reps = rows(c.execute("SELECT * FROM reports WHERE week_start=? ORDER BY submitted_at", (week,)))
        c.close()
        submitted = [r["member_id"] for r in reps]
        self._json({"ok": True, "week": week, "members": members, "reports": reps,
                    "submitted": submitted,
                    "all_submitted": len(submitted) >= len(members) and len(members) > 0})

    def api_report_draft(self, qs):
        week = qs.get("week", [week_start_of(date.today())])[0]
        ip = client_ip(self)
        c = conn()
        me = who_is(c, ip)
        mid = int(qs.get("member_id", ["0"])[0] or 0) or (me["id"] if me else 0)
        if not mid:
            c.close()
            return self._json({"ok": True, "content": ""})
        w_start = week
        w_end = (datetime.strptime(week, "%Y-%m-%d").date() + timedelta(days=6)).isoformat()
        n_start = (datetime.strptime(week, "%Y-%m-%d").date() + timedelta(days=7)).isoformat()
        n_end = (datetime.strptime(week, "%Y-%m-%d").date() + timedelta(days=13)).isoformat()
        tasks = rows(c.execute("SELECT * FROM tasks WHERE member_id=? ORDER BY id", (mid,)))

        def note(tid, limit=140):
            r = rows(c.execute(
                "SELECT content FROM updates WHERE task_id=? AND kind='note' ORDER BY id DESC LIMIT 1", (tid,)))
            if not r:
                return ""
            txt = " / ".join(x.strip() for x in (r[0]["content"] or "").splitlines() if x.strip())
            return txt[:limit] + ("…" if len(txt) > limit else "")

        def line(t, tag=""):
            bits = []
            if t["due_date"]:
                bits.append("截止 " + t["due_date"][5:])
            if t["status"] != "done":
                bits.append("进度 %d%%" % t["progress"])
            head = "- " + (tag + " " if tag else "") + t["title"]
            if bits:
                head += "（" + " · ".join(bits) + "）"
            n = note(t["id"])
            return [head] + (["  进展：" + n] if n else [])

        done = [t for t in tasks if t["status"] == "done" and t["done_at"] and w_start <= t["done_at"][:10] <= w_end]
        paused = [t for t in tasks if t["status"] == "paused"]
        nxt = [t for t in tasks if t["status"] not in ("done", "paused", "blocked")
               and t["due_date"] and n_start <= t["due_date"] <= n_end]
        nxt.sort(key=lambda x: (x["due_date"] or "9999", x["id"]))
        blocked = [t for t in tasks if t["status"] == "blocked"]
        over = [t for t in tasks if t["status"] not in ("done", "paused", "blocked")
                and t["due_date"] and t["due_date"] < today()]

        lines = ["【本周完成】"]
        for t in done:
            lines.append("- %s（%s）" % (t["title"], t["category"] or "事务"))
            n = note(t["id"])
            if n:
                lines.append("  进展：" + n)
        if not done:
            lines.append("- 无")

        lines += ["", "【下周计划】"]
        block = []
        for t in nxt:
            block += line(t)
        lines += block or ["- 暂无排期"]

        if paused:
            lines += ["", "【暂停中】"]
            for t in paused:
                lines.append("- %s（截止 %s）" % (t["title"], t["due_date"][5:] if t["due_date"] else "未定"))
                n = note(t["id"])
                if n:
                    lines.append("  说明：" + n)

        lines += ["", "【风险 / 需要支持】"]
        risk = []
        for t in blocked:
            risk += line(t, "[阻塞]")
        for t in over:
            dd = datetime.strptime(t["due_date"], "%Y-%m-%d").date()
            risk.append("- [逾期] %s 已逾期 %d 天（截止 %s · 进度 %d%%）" % (
                t["title"], (date.today() - dd).days, t["due_date"][5:], t["progress"]))
            n = note(t["id"])
            if n:
                risk.append("  进展：" + n)
        lines += risk or ["- 无"]

        lines += ["", "【其他说明】", "- "]
        c.close()
        self._json({"ok": True, "content": "\n".join(lines),
                    "stats": {"done": len(done), "doing": len(nxt), "paused": len(paused),
                              "blocked": len(blocked), "overdue": len(over)}})

    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = unquote(path).lstrip("/")
        if ".." in rel:
            return self._err("非法路径", 400)
        if rel.startswith("avatars/"):
            full = os.path.join(AVATAR_DIR, rel[len("avatars/"):])
        else:
            full = os.path.join(STATIC, rel)
        if not os.path.isfile(full):
            return self._send(404, "Not Found", "text/plain; charset=utf-8")
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, MIME.get(ext, "application/octet-stream"))

    # ---------- write endpoints
    def _blocked_guest(self):
        """游客（选了「参观一下」且没绑定成员）只读。"""
        try:
            c = conn()
            g = is_guest(c, client_ip(self))
            c.close()
            return g
        except Exception:  # noqa
            return False

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path not in ("/api/visit", "/api/whoami") and self._blocked_guest():
                return self._err("游客只能浏览，不能修改数据", 403)
            if path == "/api/members":
                return self.add_member()
            if path == "/api/tasks":
                return self.add_task()
            if path == "/api/kpis":
                return self.add_kpi()
            if path == "/api/whoami":
                return self.bind_identity()
            if path == "/api/visit":
                return self.record_visit()
            if path == "/api/reports":
                return self.submit_report()
            m = re.match(r"^/api/members/(\d+)/avatar$", path)
            if m:
                return self.upload_avatar(int(m.group(1)))
            m = re.match(r"^/api/tasks/(\d+)/updates$", path)
            if m:
                return self.add_update(int(m.group(1)))
            if path == "/api/reset":
                if not is_local_req(self):
                    return self._err("只有在本机（localhost）才能清空数据", 403)
                d = self._body()
                if os.path.exists(DB_PATH):
                    os.remove(DB_PATH)
                init_db(bool(d.get("seed", True)))
                return self._json({"ok": True})
            return self._err("未知接口", 404)
        except Exception as e:  # noqa
            self._err(str(e), 500)

    def add_member(self):
        if not is_local_req(self):
            return self._err("只有在本机（localhost）打开网站才能添加成员", 403)
        d = self._body()
        name = (d.get("name") or "").strip()
        if not name:
            return self._err("成员姓名不能为空")
        c = conn()
        n = c.execute("SELECT COUNT(*) FROM members").fetchone()[0]
        ip = (d.get("ip") or "").strip()
        if ip:
            c.execute("UPDATE members SET ip='' WHERE ip=?", (ip,))
        c.execute("INSERT INTO members(name,role,color,capacity,sort,ip,phone) VALUES(?,?,?,?,?,?,?)",
                  (name, d.get("role", ""), d.get("color") or "#4f46e5", int(d.get("capacity") or 40), n, ip,
                   re.sub(r"\D", "", str(d.get("phone") or ""))))
        c.commit()
        c.close()
        self._json({"ok": True})

    def add_task(self):
        d = self._body()
        if not (d.get("title") or "").strip():
            return self._err("事务标题不能为空")
        ip = client_ip(self)
        p = task_payload(d)
        p.setdefault("status", "todo")
        p.setdefault("priority", "P1")
        p.setdefault("category", "需求")
        p.setdefault("progress", 0)
        p.setdefault("start_date", today())
        p["created_at"] = now()
        p["updated_at"] = now()
        cols = list(p.keys())
        c = conn()
        me = who_is(c, ip)
        if not p.get("member_id") and me:
            p["member_id"] = me["id"]
            cols = list(p.keys())
        c.execute("INSERT INTO tasks(%s) VALUES(%s)" % (",".join(cols), ",".join("?" * len(cols))),
                  [p[k] for k in cols])
        tid = c.execute("SELECT last_insert_rowid()").fetchone()[0]
        c.execute("INSERT INTO updates(task_id,member_id,content,kind,ip,created_at) VALUES(?,?,?,?,?,?)",
                  (tid, p.get("member_id"), "创建事务", "system", ip, now()))
        add_log(c, tid, me["id"] if me else None, ip, "create",
                "title", "", p.get("title", ""))
        c.commit()
        c.close()
        self._json({"ok": True, "id": tid})

    def add_kpi(self):
        d = self._body()
        if not (d.get("name") or "").strip():
            return self._err("KPI 名称不能为空")
        c = conn()
        n = c.execute("SELECT COUNT(*) FROM kpis WHERE member_id=?", (d.get("member_id"),)).fetchone()[0]
        c.execute("""INSERT INTO kpis(member_id,name,cat,unit,target,current,period,direction,weight,sort,updated_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                  (d.get("member_id"), d["name"].strip(), d.get("cat", ""), d.get("unit", ""),
                   float(d.get("target") or 0), float(d.get("current") or 0),
                   d.get("period", "month"), d.get("direction", "up"),
                   float(d.get("weight") or 1), n, now()))
        c.commit()
        c.close()
        self._json({"ok": True})

    def add_update(self, task_id):
        d = self._body()
        content = (d.get("content") or "").strip()
        if not content:
            return self._err("进展内容不能为空")
        ip = client_ip(self)
        c = conn()
        t = c.execute("SELECT member_id FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not t:
            c.close()
            return self._err("事务不存在", 404)
        me = who_is(c, ip)
        mid = (me["id"] if me else None) or d.get("member_id") or t["member_id"]
        c.execute("INSERT INTO updates(task_id,member_id,content,kind,ip,created_at) VALUES(?,?,?,?,?,?)",
                  (task_id, mid, content, "note", ip, now()))
        c.execute("UPDATE tasks SET updated_at=? WHERE id=?", (now(), task_id))
        c.commit()
        c.close()
        self._json({"ok": True})

    def bind_identity(self):
        d = self._body()
        if d.get("guest"):
            ip = client_ip(self)
            c = conn()
            c.execute("INSERT INTO visits(ip,member_id,guest,agent,platform,note,created_at) VALUES(?,?,?,?,?,?,?)",
                      (ip, None, 1, (self.headers.get("User-Agent") or "")[:180],
                       (d.get("platform") or "")[:120], (d.get("note") or "")[:40], now()))
            c.commit()
            c.close()
            kick_host(ip)
            return self._json({"ok": True, "guest": True, "member": None, "ip": ip})
        try:
            mid = int(d.get("member_id") or 0)
        except (TypeError, ValueError):
            mid = 0
        if not mid:
            return self._err("请选择成员")
        ip = client_ip(self)
        lock = fail_guard(ip)
        if lock:
            return self._err("验证码输错次数太多，%d 分钟后再试" % (lock // 60 + 1), 429)
        c = conn()
        row = c.execute("SELECT * FROM members WHERE id=?", (mid,)).fetchone()
        if not row:
            c.close()
            return self._err("成员不存在", 404)
        phone = re.sub(r"\D", "", row["phone"] or "")
        code = re.sub(r"\D", "", str(d.get("code") or ""))
        if len(phone) >= 7:
            if code != phone[3:7]:
                c.close()
                fail_note(ip)
                return self._err("验证码不对，再试一次", 403)
        elif not is_local_req(self):
            c.close()
            return self._err("这位成员还没登记手机号，请联系王少君", 403)
        fail_note(ip, ok=True)
        # 一个 IP 只对应一个人；一个人也只保留一个 IP
        c.execute("UPDATE members SET ip='' WHERE ip=? AND id<>?", (ip, mid))
        c.execute("UPDATE members SET ip=?, last_seen=? WHERE id=?", (ip, now(), mid))
        c.commit()
        row = dict(c.execute("SELECT * FROM members WHERE id=?", (mid,)).fetchone())
        c.close()
        kick_host(ip)
        self._json({"ok": True, "member": member_view(row), "ip": ip})

    def upload_avatar(self, mid):
        d = self._body()
        data = d.get("data") or ""
        m = re.match(r"^data:image/(png|jpeg|jpg|webp);base64,(.+)$", data, re.S)
        if not m:
            return self._err("图片格式不支持，请选择 PNG / JPG / WebP")
        ext = "png" if m.group(1) == "png" else ("webp" if m.group(1) == "webp" else "jpg")
        try:
            raw = base64.b64decode(m.group(2))
        except Exception:
            return self._err("图片数据损坏")
        if len(raw) > MAX_AVATAR_BYTES:
            return self._err("图片太大，请控制在 3MB 内")
        c = conn()
        if not c.execute("SELECT 1 FROM members WHERE id=?", (mid,)).fetchone():
            c.close()
            return self._err("成员不存在", 404)
        os.makedirs(AVATAR_DIR, exist_ok=True)
        name = "m%d-%d.%s" % (mid, int(time.time()), ext)
        with open(os.path.join(AVATAR_DIR, name), "wb") as f:
            f.write(raw)
        c.execute("UPDATE members SET avatar=? WHERE id=?", ("/avatars/" + name, mid))
        c.commit()
        c.close()
        self._json({"ok": True, "avatar": "/avatars/" + name})

    def submit_report(self):
        d = self._body()
        content = (d.get("content") or "").strip()
        week = (d.get("week_start") or "").strip() or week_start_of(date.today())
        if len(content) < 10:
            return self._err("周报内容太短，至少写两句")
        ip = client_ip(self)
        c = conn()
        me = who_is(c, ip)
        mid = me["id"] if me else 0
        if not mid:
            c.close()
            return self._err("请先在右上角选择「我是谁」再提交", 403)
        c.execute(
            "INSERT INTO reports(member_id,week_start,content,submitted_at,ip) VALUES(?,?,?,?,?) "
            "ON CONFLICT(member_id,week_start) DO UPDATE SET content=excluded.content, "
            "submitted_at=excluded.submitted_at, ip=excluded.ip",
            (mid, week, content, now(), ip))
        c.commit()
        c.close()
        self._json({"ok": True, "member_id": mid, "week": week})

    # ---------- PATCH
    def do_PATCH(self):
        path = urlparse(self.path).path
        try:
            if self._blocked_guest():
                return self._err("游客只能浏览，不能修改数据", 403)
            body = self._body()
            m = re.match(r"^/api/tasks/(\d+)$", path)
            if m:
                return self.patch_task(int(m.group(1)), body)
            m = re.match(r"^/api/kpis/(\d+)$", path)
            if m:
                return self.patch_kpi(int(m.group(1)), body)
            m = re.match(r"^/api/members/(\d+)$", path)
            if m:
                return self.patch_member(int(m.group(1)), body)
            return self._err("未知接口", 404)
        except Exception as e:  # noqa
            self._err(str(e), 500)

    def patch_task(self, tid, d):
        c = conn()
        old = c.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
        if not old:
            c.close()
            return self._err("事务不存在", 404)
        old = dict(old)
        p = task_payload(d, old)
        if not p:
            c.close()
            return self._err("没有可更新字段")
        ip = client_ip(self)
        me = who_is(c, ip)
        p["updated_at"] = now()
        changes = []
        for k in p:
            if k in ("updated_at", "done_at"):
                continue
            ov, nv = old.get(k), p[k]
            if str(ov if ov is not None else "") == str(nv if nv is not None else ""):
                continue
            changes.append((k, ov, nv))
        cols = list(p.keys())
        c.execute("UPDATE tasks SET %s WHERE id=?" % ",".join("%s=?" % k for k in cols),
                  [p[k] for k in cols] + [tid])
        op_id = me["id"] if me else None
        for k, ov, nv in changes:
            a, b = log_text(k, ov, c), log_text(k, nv, c)
            if k == "detail":
                a, b = (a[:40] + ("…" if len(a) > 40 else "")), (b[:40] + ("…" if len(b) > 40 else ""))
            add_log(c, tid, op_id, ip, "update", k, a, b)
        if "status" in p and p["status"] != old["status"]:
            c.execute("INSERT INTO updates(task_id,member_id,content,kind,ip,created_at) VALUES(?,?,?,?,?,?)",
                      (tid, p.get("member_id", old["member_id"]),
                       "状态 %s → %s" % (STATUS_CN.get(old["status"], old["status"]),
                                        STATUS_CN.get(p["status"], p["status"])), "system", ip, now()))
        if "member_id" in p and p["member_id"] != old["member_id"]:
            c.execute("INSERT INTO updates(task_id,member_id,content,kind,ip,created_at) VALUES(?,?,?,?,?,?)",
                      (tid, p["member_id"], "负责人变更为 %s" % log_text("member_id", p["member_id"], c),
                       "system", ip, now()))
        c.commit()
        c.close()
        self._json({"ok": True, "changed": len(changes)})

    def patch_kpi(self, kid, d):
        c = conn()
        old = c.execute("SELECT * FROM kpis WHERE id=?", (kid,)).fetchone()
        if not old:
            c.close()
            return self._err("KPI 不存在", 404)
        fields = ["name", "cat", "unit", "target", "current", "period", "direction", "weight", "member_id"]
        sets, vals = [], []
        for f in fields:
            if f in d:
                v = d[f]
                if f in ("target", "current", "weight"):
                    v = float(v or 0)
                elif f == "member_id":
                    v = int(v or 0)
                sets.append("%s=?" % f)
                vals.append(v)
        if not sets:
            c.close()
            return self._err("没有可更新字段")
        sets.append("updated_at=?")
        vals += [now(), kid]
        c.execute("UPDATE kpis SET %s WHERE id=?" % ",".join(sets), vals)
        c.commit()
        c.close()
        self._json({"ok": True})

    def patch_member(self, mid, d):
        if not is_local_req(self):
            return self._err("只有在本机（localhost）打开网站才能修改成员", 403)
        c = conn()
        fields = ["name", "role", "color", "capacity", "active", "sort", "ip", "avatar", "phone"]
        sets, vals = [], []
        for f in fields:
            if f in d:
                sets.append("%s=?" % f)
                vals.append(d[f])
        if not sets:
            c.close()
            return self._err("没有可更新字段")
        vals.append(mid)
        c.execute("UPDATE members SET %s WHERE id=?" % ",".join(sets), vals)
        c.commit()
        c.close()
        self._json({"ok": True})

    # ---------- DELETE
    def do_DELETE(self):
        path = urlparse(self.path).path
        try:
            if self._blocked_guest():
                return self._err("游客只能浏览，不能修改数据", 403)
            m = re.match(r"^/api/tasks/(\d+)$", path)
            if m:
                c = conn()
                c.execute("DELETE FROM updates WHERE task_id=?", (int(m.group(1)),))
                c.execute("DELETE FROM tasks WHERE id=?", (int(m.group(1)),))
                c.commit()
                c.close()
                return self._json({"ok": True})
            m = re.match(r"^/api/kpis/(\d+)$", path)
            if m:
                c = conn()
                c.execute("DELETE FROM kpis WHERE id=?", (int(m.group(1)),))
                c.commit()
                c.close()
                return self._json({"ok": True})
            m = re.match(r"^/api/members/(\d+)$", path)
            if m:
                if not is_local_req(self):
                    return self._err("只有在本机（localhost）才能移除成员", 403)
                mid = int(m.group(1))
                c = conn()
                n = c.execute("SELECT COUNT(*) FROM tasks WHERE member_id=? AND status!='done'", (mid,)).fetchone()[0]
                if n:
                    c.close()
                    return self._err("该成员还有 %d 项未完成事务，先转移负责人" % n)
                c.execute("UPDATE members SET active=0 WHERE id=?", (mid,))
                c.commit()
                c.close()
                return self._json({"ok": True})
            return self._err("未知接口", 404)
        except Exception as e:  # noqa
            self._err(str(e), 500)


def main():
    init_db("--empty" not in sys.argv)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("团队工作台已启动： http://127.0.0.1:%d" % PORT)
    print("数据库： %s" % DB_PATH)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
