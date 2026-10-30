'use strict';
// Battle Table server: serves the page and syncs table state over WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUB = path.join(__dirname, 'public');
const COLL = new Set(['map', 'mapbg', 'tokens', 'combat']);
const PLAYER_FIELDS = new Set(['name', 'color', 'c', 'r', 'hp', 'maxHp', 'init', 'mod']);
const MAX_DOC = 300000, MAX_TOKENS = 150, MAX_ROOMS = 200;

/* ---- persistence ---- */
let saved = {};
try { saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { saved = {}; }
let dmKey = process.env.DM_KEY || saved.dmKey;
if (!dmKey) dmKey = crypto.randomBytes(9).toString('base64url');
const rooms = new Map();
Object.keys(saved.rooms || {}).forEach(n => rooms.set(n, { docs: saved.rooms[n].docs, clients: new Set() }));
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = { dmKey: process.env.DM_KEY ? undefined : dmKey, rooms: {} };
    rooms.forEach((r, n) => { out.rooms[n] = { docs: r.docs }; });
    fs.writeFile(DATA_FILE, JSON.stringify(out), () => {});
  }, 1500);
}
function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { docs: { map: {}, mapbg: {}, tokens: {}, combat: {} }, clients: new Set() };
    rooms.set(name, r);
  }
  COLL.forEach(c => { r.docs[c] = r.docs[c] || {}; });
  r.clients = r.clients || new Set();
  return r;
}

/* ---- static files ---- */
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/shim.js': ['shim.js', 'text/javascript; charset=utf-8']
};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(PUB, f[0]), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Error'); }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
});

/* ---- sync ---- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

function visible(ws, coll, d) { return !!d && (ws.isDM || coll !== 'tokens' || d.hidden !== true || d.owner === ws.uid); }
function snapFor(room, sub, ws) {
  const col = room.docs[sub.coll];
  if (sub.kind === 'doc') {
    const d = visible(ws, sub.coll, col[sub.id]) ? col[sub.id] : undefined;
    return { t: 'snap', sid: sub.sid, kind: 'doc', id: sub.id, exists: !!d, data: d || null };
  }
  return { t: 'snap', sid: sub.sid, kind: 'col', docs: Object.keys(col).filter(id => visible(ws, sub.coll, col[id])).map(id => ({ id, data: col[id] })) };
}
function broadcast(room, coll, id) {
  room.clients.forEach(ws => {
    ws.subs.forEach(sub => {
      if (sub.coll === coll && (sub.kind === 'col' || sub.id === id)) send(ws, snapFor(room, sub, ws));
    });
  });
}

function authorize(ws, op, coll, id, data, existing, room) {
  if (ws.isDM) return true;
  if (coll === 'tokens') {
    if (op === 'set') {
      if (existing) return false;
      if (Object.keys(room.docs.tokens).length >= MAX_TOKENS) return false;
      return data.owner === ws.uid && data.kind === 'pc' && data.hidden === false;
    }
    if (!existing || existing.owner !== ws.uid || existing.kind !== 'pc') return false;
    if (op === 'delete') return true;
    return Object.keys(data).every(k => PLAYER_FIELDS.has(k));
  }
  if (coll === 'combat' && op === 'set' && id === 'state') {
    const cur = room.docs.combat.state;
    if (!cur || !cur.active || data.active !== true) return false;
    const t = room.docs.tokens[cur.turnId];
    return !!t && t.owner === ws.uid;
  }
  return false;
}

function handleWrite(ws, m) {
  const ack = (ok, code) => send(ws, { t: 'ack', rid: m.rid, ok, code });
  const parts = String(m.path || '').split('/');
  if (parts.length !== 2 || !COLL.has(parts[0]) || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[1])) return ack(false, 'invalid_argument');
  if (['set', 'update', 'delete'].indexOf(m.op) < 0) return ack(false, 'invalid_argument');
  const coll = parts[0], id = parts[1], room = ws.room, existing = room.docs[coll][id];
  let data = m.data;
  if (m.op !== 'delete') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return ack(false, 'invalid_argument');
    if (JSON.stringify(data).length > MAX_DOC) return ack(false, 'quota_exceeded');
  }
  if (m.op === 'update' && !existing) return ack(false, 'invalid_argument');
  if (!authorize(ws, m.op, coll, id, data, existing, room)) return ack(false, 'invalid_argument');
  if (m.op === 'set') room.docs[coll][id] = data;
  else if (m.op === 'update') room.docs[coll][id] = Object.assign({}, existing, data);
  else delete room.docs[coll][id];
  ack(true);
  broadcast(room, coll, id);
  save();
}

wss.on('connection', (ws, req) => {
  let name = 'table';
  try { name = new URL(req.url, 'http://x').searchParams.get('room') || 'table'; } catch (e) {}
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) name = 'table';
  const room = getRoom(name);
  if (!room) return ws.close();
  ws.room = room; ws.subs = new Map(); ws.hello = false; ws.isDM = false; ws.uid = null;
  let count = 0;
  const tick = setInterval(() => { count = 0; }, 1000);
  ws.on('close', () => { clearInterval(tick); room.clients.delete(ws); });
  ws.on('error', () => {});
  ws.on('message', raw => {
    if (++count > 40) return;
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') {
      ws.uid = typeof m.uid === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(m.uid) ? m.uid : null;
      const a = Buffer.from(String(m.dm || '')), b = Buffer.from(dmKey);
      ws.isDM = a.length === b.length && crypto.timingSafeEqual(a, b);
      ws.hello = true; room.clients.add(ws);
      return send(ws, { t: 'welcome', isDM: ws.isDM, uid: ws.uid });
    }
    if (!ws.hello || !ws.uid) return;
    if (m.t === 'sub') {
      const parts = String(m.path || '').split('/');
      if (!COLL.has(parts[0]) || parts.length > 2) return;
      const sub = { sid: m.sid, coll: parts[0], kind: parts.length === 2 ? 'doc' : 'col', id: parts[1] };
      ws.subs.set(m.sid, sub);
      return send(ws, snapFor(room, sub, ws));
    }
    if (m.t === 'unsub') return void ws.subs.delete(m.sid);
    if (m.t === 'w') return handleWrite(ws, m);
  });
});

server.listen(PORT, () => {
  console.log('Battle Table is running on port ' + PORT);
  console.log('DM key: ' + dmKey);
  console.log('DM link: http://localhost:' + PORT + '/?dm=' + dmKey);
});
