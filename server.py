#!/usr/bin/env python3
"""线束钉板放样与装配推演台 — 离线本地服务

仅使用 Python 标准库：http.server 提供静态页面与 REST 接口，sqlite3 存档。
用法：python3 server.py [--port 8765]
  钉板推演台：  http://127.0.0.1:8765/
  电气检验批次：http://127.0.0.1:8765/inspect
"""
import argparse
import json
import os
import sqlite3
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import qc

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, 'static')
DB_PATH = os.environ.get('HARNESS_DB', os.path.join(ROOT, 'harness.db'))

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}

MAX_BODY = 16 * 1024 * 1024  # 16MB
MAX_IMPORT_ROWS = 5000

READING_RESULTS = ('continuity', 'open')
POLARITIES = ('none', 'normal', 'reverse')


def now_iso():
    return datetime.now().isoformat(timespec='seconds')


def init_db():
    with sqlite3.connect(DB_PATH) as con:
        con.execute(
            'CREATE TABLE IF NOT EXISTS designs ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' name TEXT UNIQUE NOT NULL,'
            ' data TEXT NOT NULL,'
            ' updated_at TEXT NOT NULL)'
        )
        # 电气检验批次：待准备 preparing → 检测中 testing → 待复核 review → 已归档 archived
        con.execute(
            'CREATE TABLE IF NOT EXISTS batches ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' design_id INTEGER NOT NULL,'
            ' name TEXT NOT NULL,'
            " status TEXT NOT NULL DEFAULT 'preparing',"
            ' paused INTEGER NOT NULL DEFAULT 0,'
            ' snapshot TEXT NOT NULL,'
            ' created_at TEXT NOT NULL,'
            ' updated_at TEXT NOT NULL)'
        )
        con.execute(
            'CREATE TABLE IF NOT EXISTS readings ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' batch_id INTEGER NOT NULL,'
            ' a TEXT NOT NULL, b TEXT NOT NULL,'
            ' result TEXT NOT NULL,'
            ' ohms REAL, unit TEXT, polarity TEXT,'
            " source TEXT NOT NULL DEFAULT 'manual',"
            ' operator TEXT, note TEXT,'
            ' withdrawn INTEGER NOT NULL DEFAULT 0,'
            ' created_at TEXT NOT NULL)'
        )
        con.execute(
            'CREATE TABLE IF NOT EXISTS dispositions ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' batch_id INTEGER NOT NULL,'
            ' akey TEXT NOT NULL, kind TEXT,'
            ' action TEXT NOT NULL, note TEXT, operator TEXT,'
            ' created_at TEXT NOT NULL)'
        )
        con.execute('CREATE INDEX IF NOT EXISTS idx_readings_batch ON readings(batch_id)')
        con.execute('CREATE INDEX IF NOT EXISTS idx_disp_batch ON dispositions(batch_id)')


# ---------- 钉板方案存档 ----------

def db_list():
    with sqlite3.connect(DB_PATH) as con:
        rows = con.execute(
            'SELECT id, name, updated_at, length(data) FROM designs ORDER BY updated_at DESC'
        ).fetchall()
    return [{'id': r[0], 'name': r[1], 'updated_at': r[2], 'size': r[3]} for r in rows]


def db_get(did):
    with sqlite3.connect(DB_PATH) as con:
        row = con.execute('SELECT id, name, data, updated_at FROM designs WHERE id=?', (did,)).fetchone()
    if not row:
        return None
    return {'id': row[0], 'name': row[1], 'data': json.loads(row[2]), 'updated_at': row[3]}


def db_save(name, data, did=None):
    now = now_iso()
    payload = json.dumps(data, ensure_ascii=False)
    with sqlite3.connect(DB_PATH) as con:
        if did:
            cur = con.execute('UPDATE designs SET name=?, data=?, updated_at=? WHERE id=?',
                              (name, payload, now, did))
            if cur.rowcount:
                return did
        cur = con.execute('INSERT INTO designs(name, data, updated_at) VALUES(?,?,?)'
                          ' ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at',
                          (name, payload, now))
        return cur.lastrowid or con.execute('SELECT id FROM designs WHERE name=?', (name,)).fetchone()[0]


def db_delete(did):
    with sqlite3.connect(DB_PATH) as con:
        return con.execute('DELETE FROM designs WHERE id=?', (did,)).rowcount > 0


# ---------- 检验批次 ----------

def db_batch_list():
    with sqlite3.connect(DB_PATH) as con:
        rows = con.execute(
            'SELECT b.id, b.name, b.status, b.paused, b.created_at, b.updated_at, b.design_id,'
            " COALESCE(d.name, '（方案已删除）'),"
            ' (SELECT COUNT(*) FROM readings r WHERE r.batch_id = b.id AND r.withdrawn = 0)'
            ' FROM batches b LEFT JOIN designs d ON d.id = b.design_id'
            ' ORDER BY b.updated_at DESC, b.id DESC'
        ).fetchall()
    return [{'id': r[0], 'name': r[1], 'status': r[2], 'paused': bool(r[3]),
             'created_at': r[4], 'updated_at': r[5], 'design_id': r[6],
             'design_name': r[7], 'readings': r[8]} for r in rows]


def db_batch_get(bid):
    with sqlite3.connect(DB_PATH) as con:
        row = con.execute(
            'SELECT id, name, status, paused, snapshot, created_at, updated_at, design_id'
            ' FROM batches WHERE id=?', (bid,)).fetchone()
    if not row:
        return None
    return {'id': row[0], 'name': row[1], 'status': row[2], 'paused': bool(row[3]),
            'snapshot': json.loads(row[4]), 'created_at': row[5], 'updated_at': row[6],
            'design_id': row[7]}


def db_batch_readings(bid):
    with sqlite3.connect(DB_PATH) as con:
        rows = con.execute(
            'SELECT id, a, b, result, ohms, unit, polarity, source, operator, note, withdrawn, created_at'
            ' FROM readings WHERE batch_id=? ORDER BY id', (bid,)).fetchall()
    return [{'id': r[0], 'a': r[1], 'b': r[2], 'result': r[3], 'ohms': r[4],
             'unit': r[5] or '', 'polarity': r[6] or 'none', 'source': r[7],
             'operator': r[8] or '', 'note': r[9] or '',
             'withdrawn': bool(r[10]), 'created_at': r[11]} for r in rows]


def db_batch_dispositions(bid):
    with sqlite3.connect(DB_PATH) as con:
        rows = con.execute(
            'SELECT id, akey, kind, action, note, operator, created_at'
            ' FROM dispositions WHERE batch_id=? ORDER BY id', (bid,)).fetchall()
    return [{'id': r[0], 'akey': r[1], 'kind': r[2] or '', 'action': r[3],
             'note': r[4] or '', 'operator': r[5] or '', 'created_at': r[6]} for r in rows]


def batch_detail(bid):
    b = db_batch_get(bid)
    if not b:
        return None
    snap = b.pop('snapshot')
    return {'batch': b, 'snapshot': snap,
            'readings': db_batch_readings(bid), 'dispositions': db_batch_dispositions(bid)}


def db_batch_create(design_id, name):
    d = db_get(design_id)
    if not d:
        return None, '钉板方案不存在'
    try:
        snap = qc.build_snapshot(d['data'], design_id=d['id'], design_name=d['name'])
    except (ValueError, TypeError, KeyError) as e:
        return None, '方案快照失败：%s' % e
    now = now_iso()
    with sqlite3.connect(DB_PATH) as con:
        cur = con.execute(
            'INSERT INTO batches(design_id, name, status, paused, snapshot, created_at, updated_at)'
            ' VALUES(?,?,?,?,?,?,?)',
            (design_id, name, 'preparing', 0, json.dumps(snap, ensure_ascii=False), now, now))
        return cur.lastrowid, None


def db_batch_action(bid, action):
    """批次状态机：开测/暂停/继续/结束检测/返回检测/归档。归档要求异常均有结论。"""
    b = db_batch_get(bid)
    if not b:
        return None, (404, '批次不存在')
    st = b['status']
    if action == 'start':
        if st != 'preparing':
            return None, (409, '仅待准备批次可开测')
        newst, paused = 'testing', b['paused']
    elif action == 'pause':
        if st != 'testing' or b['paused']:
            return None, (409, '仅检测中且未暂停的批次可暂停')
        newst, paused = st, True
    elif action == 'resume':
        if st != 'testing' or not b['paused']:
            return None, (409, '批次未处于暂停状态')
        newst, paused = st, False
    elif action == 'finish':
        if st != 'testing':
            return None, (409, '仅检测中批次可结束检测')
        newst, paused = 'review', False
    elif action == 'reopen':
        if st != 'review':
            return None, (409, '仅待复核批次可返回检测')
        newst, paused = 'testing', False
    elif action == 'archive':
        if st != 'review':
            return None, (409, '仅待复核批次可归档')
        d = batch_detail(bid)
        an = qc.analyze(d['snapshot'], d['readings'], d['dispositions'])
        unresolved = [a for a in an['anomalies'] if not a['resolved']]
        if unresolved:
            return None, (409, '尚有 %d 项异常未结论，不能归档' % len(unresolved),
                          [{'key': a['key'], 'msg': a['msg']} for a in unresolved])
        newst, paused = 'archived', False
    else:
        return None, (400, '未知操作：%s' % action)
    with sqlite3.connect(DB_PATH) as con:
        con.execute('UPDATE batches SET status=?, paused=?, updated_at=? WHERE id=?',
                    (newst, 1 if paused else 0, now_iso(), bid))
    return {'ok': True, 'status': newst, 'paused': paused}, None


def db_batch_delete(bid):
    with sqlite3.connect(DB_PATH) as con:
        con.execute('DELETE FROM readings WHERE batch_id=?', (bid,))
        con.execute('DELETE FROM dispositions WHERE batch_id=?', (bid,))
        return con.execute('DELETE FROM batches WHERE id=?', (bid,)).rowcount > 0


def clean_reading(body):
    """校验单条读数；端点是否存在于快照由分析层判定（交人工），此处只做格式校验。"""
    a = str(body.get('a') or '').strip()
    b = str(body.get('b') or '').strip()
    if not a or not b or len(a) > 64 or len(b) > 64:
        return None, '端点缺失或过长'
    result = body.get('result')
    if result not in READING_RESULTS:
        return None, '导通结果无效（应为 continuity/open）'
    ohms = body.get('ohms')
    if ohms is not None:
        try:
            ohms = float(ohms)
        except (TypeError, ValueError):
            return None, '阻值必须是数字'
        if not 0 <= ohms < 1e12:
            return None, '阻值超出范围'
    return {
        'a': a, 'b': b, 'result': result, 'ohms': ohms,
        'unit': str(body.get('unit') or '').strip()[:8],
        'polarity': body.get('polarity') if body.get('polarity') in POLARITIES else 'none',
        'operator': str(body.get('operator') or '').strip()[:50],
        'note': str(body.get('note') or '').strip()[:200],
    }, None


def db_reading_add(bid, rec, source='manual'):
    with sqlite3.connect(DB_PATH) as con:
        cur = con.execute(
            'INSERT INTO readings(batch_id, a, b, result, ohms, unit, polarity, source, operator, note,'
            ' withdrawn, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)',
            (bid, rec['a'], rec['b'], rec['result'], rec['ohms'], rec['unit'], rec['polarity'],
             source, rec['operator'], rec['note'], now_iso()))
        con.execute('UPDATE batches SET updated_at=? WHERE id=?', (now_iso(), bid))
        return cur.lastrowid


def db_readings_import(bid, rows):
    inserted = skipped = 0
    with sqlite3.connect(DB_PATH) as con:
        for row in rows[:MAX_IMPORT_ROWS]:
            rec, err = clean_reading(row)
            if err or rec['a'] == rec['b']:
                skipped += 1
                continue
            con.execute(
                'INSERT INTO readings(batch_id, a, b, result, ohms, unit, polarity, source, operator, note,'
                " withdrawn, created_at) VALUES(?,?,?,?,?,?,?,?,'csv',?,?,0,?)",
                (bid, rec['a'], rec['b'], rec['result'], rec['ohms'], rec['unit'], rec['polarity'],
                 rec['operator'], rec['note'], now_iso()))
            inserted += 1
        con.execute('UPDATE batches SET updated_at=? WHERE id=?', (now_iso(), bid))
    return inserted, skipped


def db_reading_withdraw(bid, rid):
    with sqlite3.connect(DB_PATH) as con:
        cur = con.execute('UPDATE readings SET withdrawn=1 WHERE id=? AND batch_id=? AND withdrawn=0',
                          (rid, bid))
        if not cur.rowcount:
            return False
        con.execute('UPDATE batches SET updated_at=? WHERE id=?', (now_iso(), bid))
        return True


def db_retest_net(bid, net_id):
    """重测网络：撤回该网络端点间的全部有效读数（保留历史，不动物理方案）。"""
    b = db_batch_get(bid)
    if not b:
        return None
    net = next((n for n in b['snapshot']['nets'] if n['id'] == net_id), None)
    if not net:
        return None
    eps = set(net['endpoints'])
    ids = [r['id'] for r in db_batch_readings(bid)
           if not r['withdrawn'] and r['a'] in eps and r['b'] in eps]
    with sqlite3.connect(DB_PATH) as con:
        con.executemany('UPDATE readings SET withdrawn=1 WHERE id=?', [(i,) for i in ids])
        con.execute('UPDATE batches SET updated_at=? WHERE id=?', (now_iso(), bid))
    return len(ids)


def db_disposition_add(bid, body):
    akey = str(body.get('akey') or '').strip()[:200]
    action = str(body.get('action') or '').strip()[:50]
    if not akey or not action:
        return None, '缺少异常标识或处置结论'
    kind = str(body.get('kind') or '').strip()[:30]
    note = str(body.get('note') or '').strip()[:500]
    operator = str(body.get('operator') or '').strip()[:50]
    wrid = body.get('withdraw_reading_id')
    with sqlite3.connect(DB_PATH) as con:
        con.execute(
            'INSERT INTO dispositions(batch_id, akey, kind, action, note, operator, created_at)'
            ' VALUES(?,?,?,?,?,?,?)', (bid, akey, kind, action, note, operator, now_iso()))
        if wrid:
            con.execute('UPDATE readings SET withdrawn=1 WHERE id=? AND batch_id=?', (wrid, bid))
        con.execute('UPDATE batches SET updated_at=? WHERE id=?', (now_iso(), bid))
    return {'ok': True}, None


class Handler(BaseHTTPRequestHandler):
    server_version = 'HarnessBench/1.1'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        print('[%s] %s' % (datetime.now().strftime('%H:%M:%S'), fmt % args))

    # ---------- 工具 ----------

    def _send(self, code, body=b'', ctype='text/plain; charset=utf-8', extra=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), 'application/json; charset=utf-8')

    def _error(self, code, msg):
        self._json({'error': msg}, code)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            raise ValueError('请求体过大')
        return json.loads(self.rfile.read(n) or b'{}')

    # ---------- 路由 ----------

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/health':
            return self._json({'ok': True, 'time': now_iso()})
        if path == '/api/designs':
            return self._json(db_list())
        if path.startswith('/api/designs/'):
            d = db_get(path.rsplit('/', 1)[1])
            return self._json(d) if d else self._error(404, '存档不存在')
        parts = [p for p in path.split('/') if p]
        if parts[:2] == ['api', 'batches']:
            return self._batches_get(parts)
        if path == '/' or path == '/index.html':
            return self._file(os.path.join(STATIC_DIR, 'index.html'))
        if path == '/inspect' or path == '/inspect.html':
            return self._file(os.path.join(STATIC_DIR, 'inspect.html'))
        if path.startswith('/static/'):
            rel = os.path.normpath(path[len('/static/'):]).lstrip(os.sep)
            full = os.path.join(STATIC_DIR, rel)
            if os.path.commonpath([os.path.abspath(full), STATIC_DIR]) != STATIC_DIR:
                return self._error(403, '禁止访问')
            return self._file(full)
        self._error(404, '未找到')

    def _batches_get(self, parts):
        if len(parts) == 2:
            return self._json(db_batch_list())
        if len(parts) == 3 and parts[2] == 'compare':
            qs = parse_qs(urlparse(self.path).query)
            ids = [int(x) for x in (qs.get('ids') or [''])[0].split(',') if x.strip().isdigit()]
            return self._batches_compare(ids)
        if len(parts) == 3 and parts[2].isdigit():
            d = batch_detail(int(parts[2]))
            return self._json(d) if d else self._error(404, '批次不存在')
        if len(parts) == 4 and parts[2].isdigit() and parts[3] == 'analysis':
            d = batch_detail(int(parts[2]))
            if not d:
                return self._error(404, '批次不存在')
            return self._json(qc.analyze(d['snapshot'], d['readings'], d['dispositions']))
        self._error(404, '未找到')

    def _batches_compare(self, ids):
        if len(ids) < 2:
            return self._error(400, '并排比较至少需要两个批次')
        details = []
        for i in ids:
            d = batch_detail(i)
            if not d:
                return self._error(404, '批次 %s 不存在' % i)
            if d['batch']['status'] != 'archived':
                return self._error(409, '批次「%s」尚未归档，不能参与比较' % d['batch']['name'])
            details.append(d)
        if len({d['batch']['design_id'] for d in details}) > 1:
            return self._error(409, '仅可按同一方案并排比较')
        for d in details:
            d['analysis'] = qc.analyze(d['snapshot'], d['readings'], d['dispositions'])
        return self._json(details)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._body()
        except Exception as e:
            return self._error(400, '请求格式错误：%s' % e)
        if path == '/api/designs':
            name = str(body.get('name') or '').strip()
            data = body.get('data')
            if not name:
                return self._error(400, '缺少设计名称')
            if not isinstance(data, dict) or not isinstance(data.get('wires'), list):
                return self._error(400, '设计数据无效')
            did = db_save(name, data, body.get('id'))
            return self._json({'ok': True, 'id': did})
        parts = [p for p in path.split('/') if p]
        if parts[:2] == ['api', 'batches']:
            return self._batches_post(parts, body)
        self._error(404, '未找到')

    def _batches_post(self, parts, body):
        if len(parts) == 2:  # 新建批次（从已保存方案取快照）
            try:
                design_id = int(body.get('design_id'))
            except (TypeError, ValueError):
                return self._error(400, '缺少方案 ID')
            name = str(body.get('name') or '').strip() or ('检验批次 ' + now_iso())
            bid, err = db_batch_create(design_id, name)
            if err:
                return self._error(400, err)
            return self._json({'ok': True, 'id': bid})
        if len(parts) < 4 or not parts[2].isdigit():
            return self._error(404, '未找到')
        bid = int(parts[2])
        b = db_batch_get(bid)
        if not b:
            return self._error(404, '批次不存在')
        sub = parts[3]

        if sub == 'status':
            res, err = db_batch_action(bid, str(body.get('action') or ''))
            if err:
                payload = {'error': err[1]}
                if len(err) > 2:
                    payload['unresolved'] = err[2]
                return self._json(payload, err[0])
            return self._json(res)

        if sub == 'readings':
            if len(parts) == 4:  # 录入单条
                if b['status'] != 'testing':
                    return self._error(409, '仅检测中批次可录入读数')
                if b['paused']:
                    return self._error(409, '批次已暂停后续测，请先继续检测')
                rec, err = clean_reading(body)
                if err:
                    return self._error(400, err)
                return self._json({'ok': True, 'id': db_reading_add(bid, rec)})
            if len(parts) == 5 and parts[4] == 'preview':  # CSV 导入前预览
                rows = body.get('rows')
                if not isinstance(rows, list):
                    return self._error(400, '缺少行数据')
                return self._json(qc.preview_rows(b['snapshot'], db_batch_readings(bid),
                                                  rows[:MAX_IMPORT_ROWS]))
            if len(parts) == 5 and parts[4] == 'import':  # CSV 导入
                if b['status'] != 'testing':
                    return self._error(409, '仅检测中批次可导入读数')
                if b['paused']:
                    return self._error(409, '批次已暂停后续测，请先继续检测')
                rows = body.get('rows')
                if not isinstance(rows, list):
                    return self._error(400, '缺少行数据')
                ins, skip = db_readings_import(bid, rows)
                return self._json({'ok': True, 'inserted': ins, 'skipped': skip})
            if len(parts) == 6 and parts[4].isdigit() and parts[5] == 'withdraw':  # 撤回读数
                if b['status'] != 'testing':
                    return self._error(409, '仅检测中批次可撤回读数')
                ok = db_reading_withdraw(bid, int(parts[4]))
                return self._json({'ok': True}) if ok else self._error(404, '读数不存在或已撤回')
            return self._error(404, '未找到')

        if sub == 'retest':  # 重测某个网络
            if b['status'] != 'testing':
                return self._error(409, '仅检测中批次可重测网络')
            n = db_retest_net(bid, str(body.get('net') or ''))
            if n is None:
                return self._error(400, '网络不存在')
            return self._json({'ok': True, 'withdrawn': n})

        if sub == 'dispositions':  # 异常处置结论
            if b['status'] not in ('testing', 'review'):
                return self._error(409, '当前状态不可处置异常')
            res, err = db_disposition_add(bid, body)
            if err:
                return self._error(400, err)
            return self._json(res)

        self._error(404, '未找到')

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith('/api/designs/'):
            ok = db_delete(path.rsplit('/', 1)[1])
            return self._json({'ok': ok}) if ok else self._error(404, '存档不存在')
        parts = [p for p in path.split('/') if p]
        if len(parts) == 3 and parts[:2] == ['api', 'batches'] and parts[2].isdigit():
            ok = db_batch_delete(int(parts[2]))
            return self._json({'ok': ok}) if ok else self._error(404, '批次不存在')
        self._error(404, '未找到')

    def _file(self, full):
        if not os.path.isfile(full):
            return self._error(404, '未找到')
        ext = os.path.splitext(full)[1].lower()
        with open(full, 'rb') as f:
            self._send(200, f.read(), MIME.get(ext, 'application/octet-stream'))


def create_server(host='127.0.0.1', port=8765):
    init_db()
    return ThreadingHTTPServer((host, port), Handler)


def main():
    ap = argparse.ArgumentParser(description='线束钉板放样与装配推演台（离线）')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    srv = create_server(args.host, args.port)
    print('线束钉板放样与装配推演台')
    print('存档数据库：%s' % DB_PATH)
    print('钉板推演台：  http://%s:%d/' % (args.host, args.port))
    print('电气检验批次：http://%s:%d/inspect' % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
