#!/usr/bin/env python3
"""线束钉板放样与装配推演台 — 离线本地服务

仅使用 Python 标准库：http.server 提供静态页面与 REST 接口，sqlite3 存档。
用法：python3 server.py [--port 8765]，然后浏览器打开 http://127.0.0.1:8765/
"""
import argparse
import json
import os
import sqlite3
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, 'static')
DB_PATH = os.path.join(ROOT, 'harness.db')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
}

MAX_BODY = 16 * 1024 * 1024  # 16MB


def init_db():
    with sqlite3.connect(DB_PATH) as con:
        con.execute(
            'CREATE TABLE IF NOT EXISTS designs ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' name TEXT UNIQUE NOT NULL,'
            ' data TEXT NOT NULL,'
            ' updated_at TEXT NOT NULL)'
        )


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
    now = datetime.now().isoformat(timespec='seconds')
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


class Handler(BaseHTTPRequestHandler):
    server_version = 'HarnessBench/1.0'
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
            return self._json({'ok': True, 'time': datetime.now().isoformat(timespec='seconds')})
        if path == '/api/designs':
            return self._json(db_list())
        if path.startswith('/api/designs/'):
            d = db_get(path.rsplit('/', 1)[1])
            return self._json(d) if d else self._error(404, '存档不存在')
        if path == '/' or path == '/index.html':
            return self._file(os.path.join(STATIC_DIR, 'index.html'))
        if path.startswith('/static/'):
            rel = os.path.normpath(path[len('/static/'):]).lstrip(os.sep)
            full = os.path.join(STATIC_DIR, rel)
            if os.path.commonpath([os.path.abspath(full), STATIC_DIR]) != STATIC_DIR:
                return self._error(403, '禁止访问')
            return self._file(full)
        self._error(404, '未找到')

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/api/designs':
            try:
                body = self._body()
            except Exception as e:
                return self._error(400, '请求格式错误：%s' % e)
            name = str(body.get('name') or '').strip()
            data = body.get('data')
            if not name:
                return self._error(400, '缺少设计名称')
            if not isinstance(data, dict) or not isinstance(data.get('wires'), list):
                return self._error(400, '设计数据无效')
            did = db_save(name, data, body.get('id'))
            return self._json({'ok': True, 'id': did})
        self._error(404, '未找到')

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith('/api/designs/'):
            ok = db_delete(path.rsplit('/', 1)[1])
            return self._json({'ok': ok}) if ok else self._error(404, '存档不存在')
        self._error(404, '未找到')

    def _file(self, full):
        if not os.path.isfile(full):
            return self._error(404, '未找到')
        ext = os.path.splitext(full)[1].lower()
        with open(full, 'rb') as f:
            self._send(200, f.read(), MIME.get(ext, 'application/octet-stream'))


def main():
    ap = argparse.ArgumentParser(description='线束钉板放样与装配推演台（离线）')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    init_db()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print('线束钉板放样与装配推演台')
    print('存档数据库：%s' % DB_PATH)
    print('请在浏览器打开： http://%s:%d/' % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
