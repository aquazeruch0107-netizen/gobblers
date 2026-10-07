/* ==================================================================
   ゴブレットゴブラーズ オンライン対戦 — Cloudflare Workers + Durable Objects
   仕様書 v0.1 準拠（WebSocketプロキシの await 削除・最終修正版）
   ================================================================== */

const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN = 5;
const ROOM_TTL = 30 * 60 * 1000;
const ABANDON_MS = 60 * 1000;
const ALIVE_MS = 15 * 1000;
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const SIZES = [1,2,3];

const now = () => Date.now();
const otherP = (p) => (p === "P1" ? "P2" : "P1");

function randomCode() {
  const buf = new Uint32Array(CODE_LEN);
  crypto.getRandomValues(buf);
  let c = "";
  for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return c;
}
function sanitizeName(s) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 12);
}
function normCode(s) {
  return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/* ==================================================================
   1. ゲームロジック（純粋関数）
   ================================================================== */
const G = {
  newState() {
    return {
      board: Array.from({ length: 9 }, () => []),
      reserve: { P1: { 1: 2, 2: 2, 3: 2 }, P2: { 1: 2, 2: 2, 3: 2 } },
      turn: "P1", status: "waiting", winner: null, winLine: null, endReason: null,
      history: [], positions: {}, turnStartedAt: 0, seq: 0
    };
  },
  top(cell) { return cell && cell.length ? cell[cell.length - 1] : null; },
  topAt(board, i) { return G.top(board[i]); },
  cloneBoard(board) { return board.map((c) => c.map((p) => ({ owner: p.owner, size: p.size }))); },
  findLines(board, owner) {
    const out = [];
    for (const ln of LINES) {
      if (ln.every((i) => { const t = G.top(board[i]); return t && t.owner === owner; })) out.push(ln);
    }
    return out;
  },
  isLegal(st, mv, player) {
    if (!mv || typeof mv !== "object") return false;
    if (mv.type === "place") {
      if (SIZES.indexOf(mv.size) < 0) return false;
      if ((st.reserve[player][mv.size] | 0) <= 0) return false;
      const t = G.topAt(st.board, mv.to); return !t || t.size < mv.size;
    }
    if (mv.type === "move") {
      if (mv.from === mv.to) return false;
      if (mv.from < 0 || mv.from > 8 || mv.to < 0 || mv.to > 8) return false;
      const t = G.topAt(st.board, mv.from); if (!t || t.owner !== player) return false;
      const u = G.topAt(st.board, mv.to); return !u || u.size < t.size;
    }
    return false;
  },
  legalMoves(st, player) {
    const out = [];
    for (const s of SIZES) {
      if (st.reserve[player][s] > 0) {
        for (let i = 0; i < 9; i++) { const t = G.topAt(st.board, i); if (!t || t.size < s) out.push({ type: "place", size: s, to: i }); }
      }
    }
    for (let i = 0; i < 9; i++) {
      const t = G.topAt(st.board, i);
      if (t && t.owner === player) {
        for (let j = 0; j < 9; j++) {
          if (j === i) continue;
          const u = G.topAt(st.board, j); if (!u || u.size < t.size) out.push({ type: "move", from: i, to: j });
        }
      }
    }
    return out;
  },
  positionKey(st) {
    return st.board.map((c) => c.map((p) => p.owner + p.size).join(",")).join("|") + "#" + st.turn + "#" + SIZES.map((s) => st.reserve.P1[s] + st.reserve.P2[s]).join("");
  },
  applyMove(prev, mv, settings) {
    const set = Object.assign({ simultaneous: "mover", repetition: true }, settings || {});
    const st = structuredClone(prev);
    const player = st.turn, opp = otherP(player);
    if (st.status !== "playing") return { ok: false, code: "NOT_PLAYING", message: "対戦中ではありません" };
    if (!G.isLegal(st, mv, player)) return { ok: false, code: "ILLEGAL_MOVE", message: "その手は指せません" };
    let revealedLine = null;
    if (mv.type === "move") {
      const lifted = G.cloneBoard(st.board); lifted[mv.from].pop();
      const rev = G.findLines(lifted, opp);
      const unavoidable = rev.find((ln) => ln.indexOf(mv.to) === -1);
      if (unavoidable) revealedLine = unavoidable;
    }
    const movingPiece = mv.type === "move" ? G.topAt(st.board, mv.from) : { owner: player, size: mv.size };
    if (mv.type === "place") { st.board[mv.to].push({ owner: player, size: mv.size }); st.reserve[player][mv.size]--; }
    else { const p = st.board[mv.from].pop(); st.board[mv.to].push(p); }
    st.seq++;
    st.history.push({ type: mv.type, by: player, to: mv.to, from: mv.type === "move" ? mv.from : null, size: movingPiece.size, at: now(), n: st.seq });
    const finish = (winner, line, reason) => {
      st.status = "finished"; st.winner = winner; st.winLine = line || null; st.endReason = reason; st.turnStartedAt = 0;
      return { ok: true, state: st, event: { kind: winner === "draw" ? "draw" : "win", winner: winner, reason: reason } };
    };
    if (revealedLine) return finish(opp, revealedLine, "LIFT");
    const mine = G.findLines(st.board, player), theirs = G.findLines(st.board, opp);
    if (mine.length || theirs.length) {
      if (mine.length && theirs.length) return set.simultaneous === "opponent" ? finish(opp, theirs[0], "SIMULTANEOUS") : finish(player, mine[0], "SIMULTANEOUS");
      if (mine.length) return finish(player, mine[0], "LINE");
      return finish(opp, theirs[0], "LINE");
    }
    st.turn = opp; st.turnStartedAt = now();
    st.positions = st.positions || {};
    const key = G.positionKey(st); st.positions[key] = (st.positions[key] || 0) + 1;
    if (set.repetition && st.positions[key] >= 3) return finish("draw", null, "REPETITION");
    if (G.legalMoves(st, opp).length === 0) return finish(player, null, "NOMOVES");
    return { ok: true, state: st, event: { kind: mv.type } };
  }
};

/* ==================================================================
   2. メイン Worker
   ================================================================== */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/new-code") return Response.json({ code: randomCode() });
    if (url.pathname === "/healthz") return Response.json({ ok: true, time: now() });
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const code = normCode(url.searchParams.get("code"));
      if (!code) return new Response("missing code", { status: 400 });
      try {
        const id = env.ROOM.idFromName(code);
        const stub = env.ROOM.get(id);
        
        // ★★★【超重要】WebSocketをDOにプロキシする際は、絶対に await を付けないこと！★★★
        // await を付けると、WebSocketストリームがCloudflareエッジで破壊され接続失敗(CONNECT_FAIL)します。
        return stub.fetch(request);
        
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        return new Response("Worker Error: " + msg, { status: 500, headers: { "X-Debug-Error": msg } });
      }
    }
    return env.ASSETS.fetch(request);
  }
};

/* ==================================================================
   3. ルーム Durable Object
   ================================================================== */
export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.room = null; this.loaded = false; this.rate = new WeakMap();
  }
  async load() {
    if (!this.loaded) { this.room = (await this.ctx.storage.get("room")) || null; this.loaded = true; }
    return this.room;
  }
  async save() {
    if (!this.room) return;
    this.room.lastActiveAt = now();
    await this.ctx.storage.put("room", this.room);
  }
  async ensureAlarm() {
    const cur = await this.ctx.storage.getAlarm();
    if (!cur) await this.ctx.storage.setAlarm(now() + ALIVE_MS);
  }
  seatOfToken(token) {
    if (!this.room || !token) return null;
    for (const k of ["P1", "P2"]) { const p = this.room.players[k]; if (p && p.token === token) return k; }
    return null;
  }
  auth(att) { return att && att.token ? this.seatOfToken(att.token) : null; }
  pub() {
    const r = structuredClone(this.room);
    for (const k of ["P1", "P2"]) { if (r.players[k]) delete r.players[k].token; }
    return r;
  }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) {} }
  }
  async publish(meta) {
    const base = { ev: "room:state", room: this.pub(), meta: meta || null };
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        const you = att && att.token ? this.seatOfToken(att.token) : null;
        ws.send(JSON.stringify(Object.assign({}, base, { you: you })));
      } catch (e) {}
    }
  }
  ok(ws, reqId, payload) {
    try { ws.send(JSON.stringify(Object.assign({ ev: "ok" }, payload || {}, { reqId: reqId == null ? null : reqId }))); } catch (e) {}
  }
  err(ws, reqId, code, message) {
    try { ws.send(JSON.stringify({ ev: "error", code: code, message: message, reqId: reqId == null ? null : reqId })); } catch (e) {}
  }
  rateOk(ws) {
    const sec = Math.floor(now() / 1000);
    let r = this.rate.get(ws); if (!r) { r = { t: sec, c: 0 }; this.rate.set(ws, r); }
    if (r.t !== sec) { r.t = sec; r.c = 0; }
    return ++r.c <= 30;
  }

  // ★DO側でもハンドシェイクを遅延させないため、await this.load() は行わない
  async fetch(request) {
    try {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const url = new URL(request.url);
      const code = normCode(url.searchParams.get("code"));
      if (!code) return new Response("bad code", { status: 400 });
      
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], { code: code, token: null });
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return new Response("DO Error: " + msg, { status: 500, headers: { "X-Debug-Error": msg } });
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 8192) return;
    let msg; try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg.ev !== "string") return;
    if (!this.rateOk(ws)) return;
    
    // メッセージが届いたタイミングで初めてストレージから読み込む
    await this.load();
    
    const att = ws.deserializeAttachment() || {};
    const reqId = msg.reqId != null ? String(msg.reqId).slice(0, 32) : null;
    const t = now();
    try {
      if (msg.ev === "ping") {
        const seat = this.auth(att);
        if (seat && this.room && this.room.players[seat]) {
          this.room.players[seat].connected = true; this.room.players[seat].lastPing = t; await this.save();
        }
        return;
      }
      if (msg.ev === "stamp") {
        const seat = this.auth(att);
        if (!seat) return;
        this.broadcast({ ev: "stamp", from: seat, stampId: String(msg.stampId || "").slice(0, 24) });
        return;
      }
      switch (msg.ev) {
        case "room:peek": return this.ok(ws, reqId, { room: this.room ? this.pub() : null });
        case "room:create": {
          if (this.room) return this.err(ws, reqId, "EXISTS", "このコードは使用中です。");
          const token = crypto.randomUUID();
          this.room = {
            code: att.code, createdAt: t, lastActiveAt: t, gameCount: 0, startedOnce: false,
            players: { P1: { name: sanitizeName(msg.name) || "ゲスト1", token: token, connected: true, lastPing: t, host: true }, P2: null },
            settings: { firstPlayer: "random", simultaneous: "mover", timeControl: 0, repetition: true },
            rematch: { P1: false, P2: false }, game: G.newState()
          };
          ws.serializeAttachment({ code: att.code, token: token });
          await this.save(); await this.ensureAlarm(); await this.publish({ joined: "P1" });
          return this.ok(ws, reqId, { seat: "P1", token: token, room: this.pub() });
        }
        case "room:join": {
          const room = this.room;
          if (!room) return this.err(ws, reqId, "NOT_FOUND", "ルームが見つかりません。");
          if (msg.token) {
            const seat = this.seatOfToken(msg.token);
            if (seat) {
              room.players[seat].connected = true; room.players[seat].lastPing = t;
              const nm = sanitizeName(msg.name); if (nm) room.players[seat].name = nm;
              ws.serializeAttachment({ code: att.code, token: msg.token });
              await this.save(); await this.ensureAlarm(); await this.publish({ rejoined: seat });
              return this.ok(ws, reqId, { seat: seat, token: msg.token, room: this.pub(), reconnected: true });
            }
          }
          const empty = !room.players.P1 ? "P1" : (!room.players.P2 ? "P2" : null);
          if (!empty) return this.err(ws, reqId, "FULL", "このルームは満員です。");
          const token = crypto.randomUUID();
          room.players[empty] = { name: sanitizeName(msg.name) || ("ゲスト" + (empty === "P1" ? 1 : 2)), token: token, connected: true, lastPing: t, host: empty === "P1" };
          ws.serializeAttachment({ code: att.code, token: token });
          await this.save(); await this.ensureAlarm(); await this.publish({ joined: empty });
          return this.ok(ws, reqId, { seat: empty, token: token, room: this.pub() });
        }
        case "room:settings": {
          const seat = this.auth(att); if (!seat) return this.err(ws, reqId, "AUTH", "認証失敗");
          const room = this.room;
          if (!room.players[seat].host) return this.err(ws, reqId, "NOT_HOST", "ホストのみ");
          if (room.game.status === "playing") return this.err(ws, reqId, "IN_GAME", "対戦中");
          const p = msg.patch || {};
          if (["random", "P1", "P2"].indexOf(p.firstPlayer) >= 0) room.settings.firstPlayer = p.firstPlayer;
          if (["mover", "opponent"].indexOf(p.simultaneous) >= 0) room.settings.simultaneous = p.simultaneous;
          if ([0, 15, 30, 60].indexOf(Number(p.timeControl)) >= 0) room.settings.timeControl = Number(p.timeControl);
          if (typeof p.repetition === "boolean") room.settings.repetition = p.repetition;
          await this.save(); await this.publish();
          return this.ok(ws, reqId, { room: this.pub(), seat: seat });
        }
        case "game:start": {
          const seat = this.auth(att); if (!seat) return this.err(ws, reqId, "AUTH", "認証失敗");
          const room = this.room;
          if (!room.players[seat].host) return this.err(ws, reqId, "NOT_HOST", "ホストのみ");
          if (!room.players.P1 || !room.players.P2) return this.err(ws, reqId, "NEED2", "2名必要");
          if (room.game.status === "playing") return this.err(ws, reqId, "ALREADY", "対戦中");
          const g = G.newState(); let first = "P1";
          if (room.settings.firstPlayer === "random") first = Math.random() < 0.5 ? "P1" : "P2";
          else if (room.settings.firstPlayer === "P2") first = "P2";
          g.turn = first; g.status = "playing"; g.turnStartedAt = t; g.positions[G.positionKey(g)] = 1;
          room.game = g; room.rematch = { P1: false, P2: false }; room.startedOnce = true; room.gameCount = (room.gameCount || 0) + 1;
          await this.save(); await this.publish({ started: true });
          return this.ok(ws, reqId, { room: this.pub(), seat: seat });
        }
        case "game:move": {
          const seat = this.auth(att); if (!seat) return this.err(ws, reqId, "AUTH", "認証失敗");
          const room = this.room;
          if (room.game.status !== "playing") return this.err(ws, reqId, "NOT_PLAYING", "対戦中ではない");
          if (room.game.turn !== seat) return this.err(ws, reqId, "NOT_YOUR_TURN", "手番違い");
          const res = G.applyMove(room.game, msg.move, room.settings);
          if (!res.ok) return this.err(ws, reqId, res.code, res.message);
          room.game = res.state; await this.save(); await this.publish({ event: res.event });
          return this.ok(ws, reqId, { room: this.pub(), seat: seat, event: res.event });
        }
        case "game:resign": {
          const seat = this.auth(att); if (!seat) return this.err(ws, reqId, "AUTH", "認証失敗");
          const room = this.room;
          if (room.game.status !== "playing") return this.err(ws, reqId, "NOT_PLAYING", "対戦中ではない");
          room.game.status = "finished"; room.game.winner = otherP(seat); room.game.winLine = null;
          room.game.endReason = "RESIGN"; room.game.turnStartedAt = 0; room.game.seq++;
          await this.save(); await this.publish({ event: { kind: "win", winner: room.game.winner, reason: "RESIGN" } });
          return this.ok(ws, reqId, { room: this.pub(), seat: seat });
        }
        case "game:claimwin": {
          const seat = this.auth(att); if (!seat) return this.err(ws, reqId, "AUTH", "認証失敗");
          const room = this.room;
          if (room.game.status !== "playing") return this.err(ws, reqId, "NOT_PLAYING", "対戦中ではない");
          const o = room.players[otherP(seat)];
          if (o && o.connected) return this.err(ws, reqId, "TOO_EARLY", "相手は接続中");
          if (!o || t - (o.lastPing || 0) < ABANDON_MS) return this.err(ws, reqId, "TOO_EARLY", "60秒未経過");
          room.game.status = "finished"; room.game.winner = seat; room.game.winLine = null;
          room.game.endReason = "ABANDON"; room.game.turnStartedAt = 0; room.game.seq++;
          await this.save(); await this.publish({ event: { kind: "win", winner: seat, reason: "ABANDON" } });
          return this.ok(ws, reqId, { room: this.pub(), seat: seat });
        }
        case "game:rematch": {
          const seat = this.auth(att); if (!seat) return this.err(ws, reqId, "AUTH", "認証失敗");
          const room = this.room;
          if (room.game.status !== "finished") return this.err(ws, reqId, "NOT_FINISHED", "終了後");
          room.rematch[seat] = true; let started = false;
          if (room.rematch.P1 && room.rematch.P2) {
            const a = room.players.P1, b = room.players.P2;
            room.players.P1 = b; room.players.P2 = a;
            if (room.players.P1) room.players.P1.host = false; if (room.players.P2) room.players.P2.host = true;
            const g = G.newState(); g.turn = "P1"; g.status = "playing"; g.turnStartedAt = t; g.positions[G.positionKey(g)] = 1;
            room.game = g; room.rematch = { P1: false, P2: false }; room.gameCount = (room.gameCount || 0) + 1; started = true;
          }
          await this.save(); await this.publish(started ? { started: true } : { rematchRequested: seat });
          return this.ok(ws, reqId, { room: this.pub(), seat: this.auth(att), started: started });
        }
        case "room:leave": {
          const seat = this.auth(att); if (!seat) return this.ok(ws, reqId, {});
          const room = this.room; room.players[seat] = null;
          ws.serializeAttachment({ code: att.code, token: null });
          const remain = room.players.P1 || room.players.P2; if (remain) remain.host = true;
          if (room.game.status === "playing") {
            room.game.status = "finished"; room.game.winner = otherP(seat); room.game.endReason = "RESIGN";
            room.game.winLine = null; room.game.turnStartedAt = 0; room.game.seq++;
          }
          await this.save(); await this.publish({ left: seat });
          return this.ok(ws, reqId, {});
        }
        default: return this.err(ws, reqId, "UNKNOWN", "不明なev");
      }
    } catch (e) {
      console.error("webSocketMessage error", e && e.message);
      return this.err(ws, reqId, "INTERNAL", "サーバーエラー");
    }
  }
  async webSocketClose(ws) { await this.handleDisconnect(ws); }
  async webSocketError(ws) { await this.handleDisconnect(ws); }
  async handleDisconnect(ws) {
    try {
      await this.load();
      const att = ws.deserializeAttachment();
      if (!att || !att.token || !this.room) return;
      const seat = this.seatOfToken(att.token); if (!seat) return;
      const stillLive = this.ctx.getWebSockets().some((s) => {
        if (s === ws) return false; const a = s.deserializeAttachment(); return !!(a && a.token === att.token);
      });
      if (!stillLive && this.room.players[seat]) {
        this.room.players[seat].connected = false; await this.save(); await this.publish({ presence: seat });
      }
    } catch (e) { console.error("handleDisconnect error", e && e.message); }
  }
  async alarm() {
    await this.load(); if (!this.room) return; const t = now();
    const live = new Set();
    for (const s of this.ctx.getWebSockets()) {
      const a = s.deserializeAttachment(); if (a && a.token) { const seat = this.seatOfToken(a.token); if (seat) live.add(seat); }
    }
    let changed = false;
    for (const k of ["P1", "P2"]) {
      const p = this.room.players[k]; if (p && p.connected && !live.has(k)) { p.connected = false; changed = true; }
    }
    if (changed) { await this.save(); await this.publish({ presence: true }); }
    if (live.size > 0) await this.ctx.storage.setAlarm(t + ALIVE_MS);
    else if (t - (this.room.lastActiveAt || 0) >= ROOM_TTL) { await this.ctx.storage.deleteAll(); this.room = null; }
    else await this.ctx.storage.setAlarm(Math.min(t + 60000, (this.room.lastActiveAt || t) + ROOM_TTL));
  }
}
