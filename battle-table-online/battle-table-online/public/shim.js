/* Battle Table <-> Supabase bridge.
   - Live play: every token move, die roll, map change and turn change is broadcast on a
     Supabase Realtime channel (one channel per room).
   - Saving: window.__btSave() writes the whole board to the `game_states` table.
   - Loading: the newest saved board for the room loads automatically when the page opens.
   The page talks to this file through the same small db/user API it always used. */
(function () {
  'use strict';

  /* ---------- settings ---------- */
  var SUPABASE_URL = 'https://pfglcjaqcpguohfkhgxq.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmZ2xjamFxY3BndW9oZmtoZ3hxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzNzIxMjcsImV4cCI6MjEwODk0ODEyN30.v4bCDs0v7JVqrsBFoADwv1kFW4mvm9ni2JOi892fdAk';
  var DM_KEY = 'CHANGE-ME-dm-secret'; // open the page once with ?dm=THIS_VALUE to become the DM
  var MAX_DOC = 300000, MAX_TOKENS = 150;
  var COLL = { map: 1, mapbg: 1, tokens: 1, combat: 1 };
  var PLAYER_FIELDS = { name: 1, color: 1, c: 1, r: 1, hp: 1, maxHp: 1, init: 1, mod: 1 };

  /* ---------- identity, room, DM link ---------- */
  var qs = new URLSearchParams(location.search);
  var room = (qs.get('room') || 'table').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'table';
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  function randHex(n) { return Array.from(crypto.getRandomValues(new Uint8Array(n))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  var uid = store.get('bt_uid');
  if (!uid) { uid = 'p' + randHex(12); store.set('bt_uid', uid); }
  var dm = qs.get('dm');
  if (dm) {
    store.set('bt_dm', dm);
    qs.delete('dm');
    try { history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : '')); } catch (e) {}
  }
  var isDM = (store.get('bt_dm') || '') === DM_KEY;

  window.__btPlayerLink = function () {
    return location.origin + location.pathname + (room !== 'table' ? '?room=' + encodeURIComponent(room) : '');
  };

  /* ---------- local copy of the table ---------- */
  var docs = { map: {}, mapbg: {}, tokens: {}, combat: {} };
  var subs = new Map(), sidN = 0;
  var client = null, channel = null, connected = false, gotPeerState = false;
  var resolveReady, ready = new Promise(function (r) { resolveReady = r; });

  function visible(coll, d) { return !!d && (isDM || coll !== 'tokens' || d.hidden !== true || d.owner === uid); }
  function mkDoc(id, d) {
    return { id: id, exists: !!d, data: function () { return d || undefined; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function deliver(sub) {
    var col = docs[sub.coll];
    if (sub.kind === 'doc') {
      sub.next(mkDoc(sub.id, visible(sub.coll, col[sub.id]) ? col[sub.id] : null));
    } else {
      var list = Object.keys(col).filter(function (id) { return visible(sub.coll, col[id]); }).map(function (id) { return mkDoc(id, col[id]); });
      sub.next({ docs: list, size: list.length, empty: !list.length, metadata: { fromCache: false, hasPendingWrites: false } });
    }
  }
  function notify(coll, id) {
    subs.forEach(function (s) { if (s.coll === coll && (s.kind === 'col' || s.id === id)) deliver(s); });
  }
  function notifyAll() { Object.keys(COLL).forEach(function (c) { notify(c, null); }); }
  function parsePath(path) {
    var p = String(path || '').split('/');
    if (p.length !== 2 || !COLL[p[0]] || !/^[A-Za-z0-9_-]{1,64}$/.test(p[1])) return null;
    return { coll: p[0], id: p[1] };
  }
  function applyOp(op, coll, id, data) {
    var col = docs[coll];
    if (op === 'set') col[id] = data;
    else if (op === 'update') { if (!col[id]) return; col[id] = Object.assign({}, col[id], data); }
    else if (op === 'delete') delete col[id];
    else return;
    notify(coll, id);
  }
  function replaceAll(next) {
    docs = { map: {}, mapbg: {}, tokens: {}, combat: {} };
    Object.keys(COLL).forEach(function (c) {
      var src = next && next[c];
      if (src && typeof src === 'object') Object.keys(src).forEach(function (id) { if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && src[id] && typeof src[id] === 'object') docs[c][id] = src[id]; });
    });
    notifyAll();
  }

  /* ---------- who may change what (same rules the old server used) ---------- */
  function authorize(op, coll, id, data, existing) {
    if (isDM) return true;
    if (coll === 'tokens') {
      if (op === 'set') {
        if (existing || Object.keys(docs.tokens).length >= MAX_TOKENS) return false;
        return data.owner === uid && data.kind === 'pc' && data.hidden === false;
      }
      if (!existing || existing.owner !== uid || existing.kind !== 'pc') return false;
      if (op === 'delete') return true;
      return Object.keys(data).every(function (k) { return PLAYER_FIELDS[k]; });
    }
    if (coll === 'combat' && op === 'set' && id === 'state') {
      var cur = docs.combat.state;
      if (!cur || !cur.active || data.active !== true) return false;
      var t = docs.tokens[cur.turnId];
      return !!t && t.owner === uid;
    }
    return false;
  }

  /* ---------- live channel ---------- */
  function kindOf(op, coll, data) {
    if (coll === 'map' || coll === 'mapbg') return 'map';
    if (coll === 'combat') return 'combat';
    if (op === 'update' && data) {
      var k = Object.keys(data);
      if (k.length && k.every(function (x) { return x === 'c' || x === 'r'; })) return 'move';
      if ('init' in data) return 'roll';
    }
    return 'token';
  }
  function emit(event, payload) {
    if (!channel || !connected) return;
    payload.uid = uid;
    channel.send({ type: 'broadcast', event: event, payload: payload });
  }
  function onRemoteGame(p) {
    if (!p || p.uid === uid) return;
    var pp = parsePath(p.path);
    if (!pp || ['set', 'update', 'delete'].indexOf(p.op) < 0) return;
    if (p.op !== 'delete' && (!p.data || typeof p.data !== 'object' || Array.isArray(p.data))) return;
    applyOp(p.op, pp.coll, pp.id, p.data);
  }
  function snapshotForPeer() { return JSON.parse(JSON.stringify(docs)); }

  /* ---------- save / load ---------- */
  function hasContent() { return Object.keys(COLL).some(function (c) { return Object.keys(docs[c]).length > 0; }); }
  window.__btSave = function () {
    if (!client) return Promise.reject(new Error('Not connected'));
    var layout = { docs: snapshotForPeer(), savedBy: uid, v: 1 };
    return client.from('game_states').insert({ room: room, layout: layout }).then(function (res) {
      if (res.error) throw res.error;
      return true;
    });
  };
  function loadLast() {
    return client.from('game_states').select('layout,saved_at').eq('room', room)
      .order('saved_at', { ascending: false }).limit(1).then(function (res) {
        if (res.error) { console.warn('Could not load saved game:', res.error.message); return; }
        if (res.data && res.data.length && res.data[0].layout && res.data[0].layout.docs) {
          replaceAll(res.data[0].layout.docs);
          if (typeof window.__btOnLoaded === 'function') window.__btOnLoaded(res.data[0].saved_at);
        }
      }, function (e) { console.warn('Could not load saved game:', e && e.message); });
  }

  /* ---------- dice ---------- */
  window.__btRoll = function (msg) { emit('dice', { msg: String(msg).slice(0, 120) }); };

  /* ---------- connect ---------- */
  function connect() {
    if (!window.supabase || !window.supabase.createClient) { console.warn('Supabase library did not load.'); return; }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { params: { eventsPerSecond: 20 } } });
    channel = client.channel('battle-table:' + room, { config: { broadcast: { self: false } } });
    channel
      .on('broadcast', { event: 'game' }, function (m) { onRemoteGame(m.payload); })
      .on('broadcast', { event: 'dice' }, function (m) {
        var p = m.payload;
        if (p && p.uid !== uid && typeof window.__btOnRoll === 'function') window.__btOnRoll(String(p.msg || ''));
      })
      .on('broadcast', { event: 'sync-req' }, function (m) {
        var p = m.payload;
        if (!p || p.uid === uid || !hasContent()) return;
        // answer after a short random delay so a crowd of players does not all reply at once
        setTimeout(function () { emit('sync-state', { to: p.uid, docs: snapshotForPeer() }); }, Math.random() * 400);
      })
      .on('broadcast', { event: 'sync-state' }, function (m) {
        var p = m.payload;
        if (!p || p.to !== uid || gotPeerState || !p.docs) return;
        gotPeerState = true; replaceAll(p.docs);
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          connected = true;
          loadLast().then(function () {
            emit('sync-req', {}); // ask anyone already at the table for the live board
            resolveReady(true);
            notifyAll(); // clears the "Reconnecting" state after a drop
          });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          connected = false; gotPeerState = false;
          subs.forEach(function (s) { if (s.error) s.error({ code: 'unavailable', message: 'Disconnected' }); });
        }
      });
  }

  /* ---------- the db/user API the page uses ---------- */
  function newId() { return Array.from(crypto.getRandomValues(new Uint8Array(9))).map(function (b) { return b.toString(36).padStart(2, '0'); }).join('').slice(0, 14); }
  function write(op, path, data) {
    return new Promise(function (resolve, reject) {
      if (!connected) return reject({ code: 'unavailable', message: 'Not connected' });
      var pp = parsePath(path);
      if (!pp) return reject({ code: 'invalid_argument', message: 'Bad path' });
      if (op !== 'delete') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return reject({ code: 'invalid_argument' });
        if (JSON.stringify(data).length > MAX_DOC) return reject({ code: 'quota_exceeded' });
      }
      var existing = docs[pp.coll][pp.id];
      if (op === 'update' && !existing) return reject({ code: 'invalid_argument' });
      if (!authorize(op, pp.coll, pp.id, data, existing)) return reject({ code: 'invalid_argument', message: 'Write refused' });
      applyOp(op, pp.coll, pp.id, data);
      emit('game', { type: kindOf(op, pp.coll, data), op: op, path: path, data: data || null });
      resolve();
    });
  }
  function subscribe(path, kind, id, next, error) {
    var sid = 's' + (++sidN);
    var sub = { coll: path.split('/')[0], kind: kind, id: id, next: next, error: error };
    subs.set(sid, sub);
    setTimeout(function () { if (subs.has(sid)) deliver(sub); }, 0);
    return function () { subs.delete(sid); };
  }
  function docRef(path) {
    var parts = path.split('/');
    return {
      id: parts[1], path: path,
      set: function (d) { return write('set', path, d); },
      update: function (d) { return write('update', path, d); },
      delete: function () { return write('delete', path); },
      onSnapshot: function (next, error) { return subscribe(path, 'doc', parts[1], next, error); }
    };
  }
  var dbApi = {
    doc: docRef,
    collection: function (name) {
      return {
        path: name,
        doc: function (id) { return docRef(name + '/' + (id || newId())); },
        onSnapshot: function (next, error) { return subscribe(name, 'col', null, next, error); }
      };
    }
  };
  var userApi = {
    id: function () { return Promise.resolve(uid); },
    canEdit: function () { return Promise.resolve(isDM); },
    can: function () { return Promise.resolve(true); }
  };

  connect();
  var timeout = new Promise(function (r) { setTimeout(function () { r(false); }, 10000); });
  window.claude = {
    use: function (name) {
      if (name !== 'db' && name !== 'user') return Promise.resolve(null);
      return Promise.race([ready, timeout]).then(function (ok) { return ok ? (name === 'db' ? dbApi : userApi) : null; });
    }
  };
})();
