/* Connects the page to the Battle Table server. Exposes the small slice of the
   shared-database and user API that the page uses. */
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var room = qs.get('room') || 'table';
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var uid = store.get('bt_uid');
  if (!uid) {
    uid = 'p' + Array.from(crypto.getRandomValues(new Uint8Array(12))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    store.set('bt_uid', uid);
  }
  var dm = qs.get('dm');
  if (dm) {
    store.set('bt_dm', dm);
    qs.delete('dm');
    var clean = location.pathname + (qs.toString() ? '?' + qs.toString() : '');
    try { history.replaceState(null, '', clean); } catch (e) {}
  }
  dm = store.get('bt_dm') || '';

  window.__btPlayerLink = function () {
    var q = room !== 'table' ? '?room=' + encodeURIComponent(room) : '';
    return location.origin + location.pathname + q;
  };

  var ws = null, isDM = false, sidN = 0, ridN = 0, backoff = 500;
  var subs = new Map(), pending = new Map(), opened = false, resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function mkDoc(id, d) {
    return { id: id, exists: !!d, data: function () { return d || undefined; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function deliver(sub, m) {
    if (sub.kind === 'doc') sub.next(mkDoc(sub.id, m.exists ? m.data : null));
    else {
      var docs = m.docs.map(function (d) { return mkDoc(d.id, d.data); });
      sub.next({ docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } });
    }
  }
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws?room=' + encodeURIComponent(room));
    ws.onopen = function () { send({ t: 'hello', uid: uid, dm: dm }); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.t === 'welcome') {
        isDM = !!m.isDM; backoff = 500;
        if (!opened) { opened = true; resolveReady(true); }
        subs.forEach(function (s, sid) { send({ t: 'sub', sid: sid, path: s.path }); });
      } else if (m.t === 'snap') {
        var s = subs.get(m.sid); if (s) deliver(s, m);
      } else if (m.t === 'ack') {
        var p = pending.get(m.rid); if (!p) return;
        pending.delete(m.rid);
        m.ok ? p.resolve() : p.reject({ code: m.code || 'unavailable', message: 'Write refused' });
      }
    };
    ws.onclose = function () {
      pending.forEach(function (p) { p.reject({ code: 'unavailable', message: 'Disconnected' }); });
      pending.clear();
      subs.forEach(function (s) { if (s.error) s.error({ code: 'unavailable', message: 'Disconnected' }); });
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onerror = function () {};
  }
  function write(op, path, data) {
    return new Promise(function (resolve, reject) {
      if (!ws || ws.readyState !== 1) return reject({ code: 'unavailable', message: 'Not connected' });
      var rid = ++ridN; pending.set(rid, { resolve: resolve, reject: reject });
      send({ t: 'w', rid: rid, op: op, path: path, data: data });
    });
  }
  function subscribe(path, kind, id, next, error) {
    var sid = 's' + (++sidN);
    subs.set(sid, { path: path, kind: kind, id: id, next: next, error: error });
    send({ t: 'sub', sid: sid, path: path });
    return function () { subs.delete(sid); send({ t: 'unsub', sid: sid }); };
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
  function newId() { return Array.from(crypto.getRandomValues(new Uint8Array(9))).map(function (b) { return b.toString(36).padStart(2, '0'); }).join('').slice(0, 14); }
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
  var timeout = new Promise(function (r) { setTimeout(function () { r(false); }, 8000); });
  window.claude = {
    use: function (name) {
      if (name !== 'db' && name !== 'user') return Promise.resolve(null);
      return Promise.race([ready, timeout]).then(function (ok) { return ok ? (name === 'db' ? dbApi : userApi) : null; });
    }
  };
})();
