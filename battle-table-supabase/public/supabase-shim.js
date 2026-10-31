/* Connects the table page to Supabase.
   The page was written against a tiny database interface (doc, collection, onSnapshot, set, update, delete).
   This file provides that interface on top of Supabase tables, Realtime, and the functions in schema.sql. */
(function () {
  'use strict';
  var cfg = window.BT_CONFIG || {};
  var qs = new URLSearchParams(location.search);
  var slug = (qs.get('room') || '').toLowerCase();
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var configured = !!(cfg.SUPABASE_URL && cfg.SUPABASE_KEY && cfg.SUPABASE_URL.indexOf('YOUR-') < 0 && cfg.SUPABASE_KEY.indexOf('YOUR-') < 0);

  var sb = null, uid = null, isDM = false;
  var S = { room: null, bg: null, bgRev: -1, tokens: [] };
  var sig = { map: '', combat: '', bg: '', tokens: '' };
  var subs = [], timer = null, wasConnected = false;

  function playerLink() { return location.origin + location.pathname + '?room=' + encodeURIComponent(slug); }
  window.__btPlayerLink = playerLink;
  window.__btDmLink = function () { var s = store.get('bt_dm_' + slug); return s ? playerLink() + '#dm=' + s : ''; };

  /* ---------- message overlay ---------- */
  function showMsg(title, body) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:20px;background:rgba(10,6,3,.88)';
    d.innerHTML = '<div style="max-width:520px;background:#d8c7a0;color:#2a1c0c;border:1px solid #3a2a14;padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,.7);font:17px/1.45 \'Alegreya Sans\',system-ui,sans-serif">' +
      '<h2 style="margin:0 0 8px;font:700 22px Cinzel,Georgia,serif;letter-spacing:.04em;color:#2a1c0c;text-transform:none">' + title + '</h2>' + body +
      '<p style="margin:16px 0 0"><a href="index.html" style="color:#7a2218;font-weight:700">Back to the lobby</a></p></div>';
    document.body.appendChild(d);
  }

  /* ---------- error mapping ---------- */
  function classify(err) {
    var m = (err && err.message) || '';
    if (err && (err.code === '42501' || /row-level security|permission denied|cannot change/i.test(m))) return 'invalid_argument';
    if (/too many tokens/i.test(m)) return 'quota_exceeded';
    return 'unavailable';
  }
  function reject(err) { return Promise.reject({ code: classify(err), message: (err && err.message) || 'Request failed' }); }
  function denied() { return Promise.reject({ code: 'invalid_argument', message: 'Not allowed' }); }

  /* ---------- data mapping ---------- */
  function rowToToken(r) {
    return { name: r.name, kind: r.kind, color: r.color, c: r.c, r: r.r, hp: r.hp, maxHp: r.max_hp,
             init: r.init, mod: r.mod, owner: r.owner, hidden: r.hidden, at: Number(r.at) };
  }
  var FIELD = { name: 'name', kind: 'kind', color: 'color', c: 'c', r: 'r', hp: 'hp', maxHp: 'max_hp', init: 'init', mod: 'mod', hidden: 'hidden' };
  function tokenToRow(d) {
    var out = {};
    Object.keys(d).forEach(function (k) { if (FIELD[k]) out[FIELD[k]] = d[k]; });
    return out;
  }

  /* ---------- loading ---------- */
  async function loadRoom() {
    var r = await sb.from('rooms').select('id,name,map,combat,bg_rev').eq('id', slug).maybeSingle();
    if (r.error) throw r.error;
    S.room = r.data;
  }
  async function loadTokens() {
    var r = await sb.from('tokens').select('*').eq('room_id', slug);
    if (r.error) throw r.error;
    S.tokens = r.data.map(function (x) { return { id: x.id, data: rowToToken(x) }; }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  }
  async function loadBg() {
    var r = await sb.from('room_bg').select('data_url').eq('room_id', slug).maybeSingle();
    if (r.error) throw r.error;
    S.bg = r.data ? r.data.data_url : null;
    S.bgRev = S.room ? S.room.bg_rev : 0;
  }

  /* ---------- snapshots ---------- */
  function mkDoc(id, d) {
    return { id: id, exists: !!d, data: function () { return d || undefined; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function current(sub) {
    if (sub.kind === 'col') {
      var docs = S.tokens.map(function (t) { return mkDoc(t.id, t.data); });
      return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
    }
    if (sub.path === 'map/current') return mkDoc('current', S.room && S.room.map);
    if (sub.path === 'combat/state') return mkDoc('state', S.room && S.room.combat);
    if (sub.path === 'mapbg/current') return mkDoc('current', S.bg ? { dataUrl: S.bg } : null);
    return mkDoc(sub.id, null);
  }
  function key(sub) { return sub.kind === 'col' ? 'tokens' : sub.path === 'map/current' ? 'map' : sub.path === 'combat/state' ? 'combat' : 'bg'; }
  function signature() {
    return {
      map: JSON.stringify(S.room && S.room.map), combat: JSON.stringify(S.room && S.room.combat),
      bg: String(S.bgRev), tokens: JSON.stringify(S.tokens)
    };
  }
  function notify(force) {
    var now = signature();
    subs.forEach(function (sub) {
      var k = key(sub);
      if (force || now[k] !== sig[k]) sub.next(current(sub));
    });
    sig = now;
  }
  function errAll() { subs.forEach(function (s) { if (s.error) s.error({ code: 'unavailable', message: 'Disconnected' }); }); }
  async function refreshAll(force) {
    try {
      await loadRoom();
      if (!S.room) return;
      await loadTokens();
      if (S.room.bg_rev !== S.bgRev) await loadBg();
      notify(!!force);
    } catch (e) { errAll(); }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(function () { refreshAll(false); }, 120); }

  function openChannel() {
    sb.channel('bt-' + slug)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tokens', filter: 'room_id=eq.' + slug }, schedule)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tokens' }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + slug }, schedule)
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') { if (wasConnected) refreshAll(true); wasConnected = true; }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') errAll();
      });
    // Safety net in case a live message is missed.
    setInterval(function () { if (document.visibilityState === 'visible') refreshAll(false); }, 20000);
  }

  /* ---------- writes ---------- */
  function afterWrite() { schedule(); }
  async function writeRoomField(patch) {
    if (!isDM) return denied();
    var r = await sb.from('rooms').update(patch).eq('id', slug).select('id');
    if (r.error) return reject(r.error);
    if (!r.data.length) return denied();
    Object.assign(S.room, patch); afterWrite();
  }
  async function bumpBg() {
    var rev = (S.room.bg_rev || 0) + 1;
    S.room.bg_rev = rev; S.bgRev = rev;
    var r = await sb.from('rooms').update({ bg_rev: rev }).eq('id', slug);
    if (r.error) return reject(r.error);
  }
  async function writeDoc(op, path, data) {
    var parts = path.split('/'), coll = parts[0], id = parts[1];
    if (coll === 'map' && op === 'set') return writeRoomField({ map: data });
    if (coll === 'combat' && op === 'set') {
      if (isDM) return writeRoomField({ combat: data });
      var r = await sb.rpc('player_next_turn', { p_room: slug, p_turn: data.turnId, p_round: data.round });
      if (r.error) return reject(r.error);
      if (r.data !== true) return denied();
      S.room.combat = data; afterWrite(); return;
    }
    if (coll === 'mapbg') {
      if (!isDM) return denied();
      var q = op === 'delete' ? await sb.from('room_bg').delete().eq('room_id', slug)
                              : await sb.from('room_bg').upsert({ room_id: slug, data_url: data.dataUrl });
      if (q.error) return reject(q.error);
      S.bg = op === 'delete' ? null : data.dataUrl;
      await bumpBg(); afterWrite(); return;
    }
    if (coll === 'tokens') {
      var res;
      if (op === 'set') {
        var row = Object.assign(tokenToRow(data), { id: id, room_id: slug, owner: uid, at: data.at });
        res = isDM ? await sb.from('tokens').upsert(row) : await sb.from('tokens').insert(row);
        if (res.error) return reject(res.error);
      } else if (op === 'update') {
        res = await sb.from('tokens').update(tokenToRow(data)).eq('id', id).select('id');
        if (res.error) return reject(res.error);
        if (!res.data.length) return denied();
      } else {
        res = await sb.from('tokens').delete().eq('id', id).select('id');
        if (res.error) return reject(res.error);
      }
      afterWrite(); return;
    }
    return denied();
  }

  /* ---------- the interface the page uses ---------- */
  function newId() { return (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); })); }
  function subscribe(path, kind, id, next, error) {
    var sub = { path: path, kind: kind, id: id, next: next, error: error };
    subs.push(sub);
    setTimeout(function () { if (subs.indexOf(sub) >= 0) next(current(sub)); }, 0);
    return function () { var i = subs.indexOf(sub); if (i >= 0) subs.splice(i, 1); };
  }
  function docRef(path) {
    var id = path.split('/')[1];
    return {
      id: id, path: path,
      set: function (d) { return writeDoc('set', path, d); },
      update: function (d) { return writeDoc('update', path, d); },
      delete: function () { return writeDoc('delete', path); },
      onSnapshot: function (next, error) { return subscribe(path, 'doc', id, next, error); }
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

  /* Saved-map library (DM only). */
  window.__btLib = {
    list: async function () {
      var r = await sb.from('saved_maps').select('id,name,map,created_at').eq('room_id', slug).order('created_at', { ascending: false });
      if (r.error) throw r.error; return r.data;
    },
    save: async function (name, map) {
      var r = await sb.from('saved_maps').insert({ room_id: slug, name: String(name).slice(0, 60) || 'Untitled map', map: map });
      if (r.error) throw r.error;
    },
    remove: async function (id) {
      var r = await sb.from('saved_maps').delete().eq('id', id);
      if (r.error) throw r.error;
    }
  };

  /* ---------- start up ---------- */
  async function init() {
    if (!configured) {
      showMsg('Almost there', '<p>This copy of Battle Table is not connected to a database yet. Open <b>public/config.js</b> in your repository and paste in your Supabase project URL and key, then redeploy.</p>');
      return false;
    }
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) {
      showMsg('Which table?', '<p>This link has no table code. Go back to the lobby to start a new table or join one.</p>');
      return false;
    }
    if (!window.supabase) {
      showMsg('Could not load', '<p>The connection library did not load. Check your internet connection and reload the page.</p>');
      return false;
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    try {
      var s = await sb.auth.getSession();
      if (s.data && s.data.session) uid = s.data.session.user.id;
      else {
        var a = await sb.auth.signInAnonymously();
        if (a.error) { showMsg('Sign-in is switched off', '<p>In Supabase, open Authentication, then Sign In / Providers, and turn on <b>Allow anonymous sign-ins</b>. Then reload this page.</p>'); return false; }
        uid = a.data.user.id;
      }
      var h = /dm=([A-Za-z0-9_-]+)/.exec(location.hash);
      var secret = h ? h[1] : store.get('bt_dm_' + slug);
      if (h) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
      if (secret) {
        var c = await sb.rpc('claim_dm', { p_room: slug, p_secret: secret });
        if (c.data === true) { isDM = true; store.set('bt_dm_' + slug, secret); }
      }
      if (!isDM) { var d = await sb.rpc('is_dm', { p_room: slug }); isDM = d.data === true; }
      await loadRoom();
      if (!S.room) { showMsg('Table not found', '<p>There is no table with the code <b>' + slug.replace(/[^a-z0-9-]/g, '') + '</b>. Check the link, or start a new table from the lobby.</p>'); return false; }
      await loadTokens(); await loadBg();
      sig = signature();
      openChannel();
      return true;
    } catch (e) {
      showMsg('Could not reach the table', '<p>The database did not answer. Check that your Supabase project is running (free projects pause after a week without visitors) and that the URL and key in <b>config.js</b> are correct.</p>');
      return false;
    }
  }
  var ready = init();
  window.claude = {
    use: function (name) {
      if (name !== 'db' && name !== 'user') return Promise.resolve(null);
      return ready.then(function (ok) { return ok ? (name === 'db' ? dbApi : userApi) : null; });
    }
  };
})();
