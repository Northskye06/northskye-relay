// Serveur relais Northskye : met en relation deux joueurs par un code de partie et se contente de
// transmettre leurs messages. Il ne connaît rien aux règles : chaque client fait tourner le moteur
// (même graine + mêmes commandes = même partie).
"use strict";
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const Store = require("./store");

const PORT = process.env.PORT || 8080;
const MAX_MSG = 512 * 1024;            // taille max d'un message (octets)
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // une salle vide (personne connecté) est supprimée après 6 h
const CODE_RE = /^[A-Z0-9]{4,8}$/;
const PID_RE = /^[a-f0-9]{32}$/;
const MIN_FORFEIT_MS = 3 * 60 * 1000;   // abandon pris en compte seulement après 3 minutes de partie
const LONE_REPORT_MS = 60 * 1000;       // une défaite déclarée seule est validée si l'adversaire ne dit rien pendant 1 minute

/** Classement en ligne (null = désactivé si le stockage ne démarre pas). */
let store = null;

/** code -> { host:{ws,token}, guest:{ws,token}|null, lastActive } */
const rooms = new Map();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health" || u.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Northskye relay OK — " + rooms.size + " salle(s)" + (store ? " — classement actif" : " — classement indisponible") + "\n");
  } else if (u.pathname === "/ladder") {
    const headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    if (!store) { res.writeHead(503, headers); return res.end(JSON.stringify({ error: "unavailable" })); }
    try {
      const pid = u.searchParams.get("pid") || "";
      const top = await store.top(20);
      let me = null;
      if (PID_RE.test(pid)) {
        const p = await store.get(pid);
        if (p) me = Object.assign({ rank: await store.rankOf(pid) }, p);
      }
      const out = { top: top.map((p, i) => ({ rank: i + 1, name: p.name, elo: p.elo, wins: p.wins, losses: p.losses, draws: p.draws, me: p.pid === pid })), me: me && { rank: me.rank, name: me.name, elo: me.elo, wins: me.wins, losses: me.losses, draws: me.draws }, total: await store.count() };
      res.writeHead(200, headers);
      res.end(JSON.stringify(out));
    } catch (e) {
      console.error("ladder:", e.message);
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: "server" }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function newToken() {
  return crypto.randomBytes(16).toString("hex");
}
function other(role) {
  return role === "host" ? "guest" : "host";
}
function connected(room, role) {
  const p = room[role];
  return !!(p && p.ws && p.ws.readyState === 1);
}

const sha = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");

/** Enregistre la fin d'une partie classée et prévient les deux joueurs. winner : "host" | "guest" | "draw". */
async function settleGame(room, winner, why) {
  const g = room.game;
  if (!g || g.settled || !store) return;
  g.settled = true;
  clearTimeout(g.timer);
  const a = g.pids.host, b = g.pids.guest;
  if (!a || !b) return;
  try {
    const r = await store.applyGame(g.gid, a, b, winner === "host" ? "a" : winner === "guest" ? "b" : "draw");
    if (!r) return;
    for (const role of ["host", "guest"]) {
      const o = role === "host" ? r.a : r.b;
      const pid = role === "host" ? a : b;
      send(room[role] && room[role].ws, { t: "rated", gid: g.gid, delta: o.delta, elo: o.elo, rank: await store.rankOf(pid), why });
    }
  } catch (e) { console.error("settle:", e.message); }
}

function resultToWinner(role, res) { // résultat déclaré par `role` -> gagnant
  if (res === "draw") return "draw";
  if (res === "win") return role;
  return other(role);
}

async function onReport(ws, m) {
  const room = ws.room && rooms.get(ws.room);
  const g = room && room.game;
  if (!g || g.settled || m.gid !== g.gid || !ws.role) return;
  if (!["win", "loss", "draw"].includes(m.res)) return;
  g.reports[ws.role] = { res: m.res, h: String(m.h || ""), n: Number(m.n) || 0 };
  const mine = g.reports[ws.role], theirs = g.reports[other(ws.role)];
  if (theirs) {
    const w1 = resultToWinner(ws.role, mine.res), w2 = resultToWinner(other(ws.role), theirs.res);
    if (w1 === w2 && mine.h === theirs.h && mine.n === theirs.n) return settleGame(room, w1, "confirmed");
    g.settled = true; // désaccord : partie non comptée
    clearTimeout(g.timer);
    for (const role of ["host", "guest"]) send(room[role] && room[role].ws, { t: "rated", gid: g.gid, error: "mismatch" });
    return;
  }
  // un seul rapport : seule une défaite / égalité (contre l'intérêt du déclarant) est validée sans accord
  if (mine.res !== "win" && !g.timer) {
    g.timer = setTimeout(() => {
      const r = g.reports[ws.role];
      if (r && !g.reports[other(ws.role)]) settleGame(room, resultToWinner(ws.role, r.res), "lone");
    }, LONE_REPORT_MS);
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.role = null;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(raw.toString("utf8")); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    const code = typeof m.code === "string" ? m.code.toUpperCase() : "";

    switch (m.t) {
      case "create": {
        if (!CODE_RE.test(code)) return send(ws, { t: "error", e: "bad_code" });
        const ex = rooms.get(code);
        if (ex && (connected(ex, "host") || connected(ex, "guest"))) return send(ws, { t: "error", e: "code_taken" });
        const room = { host: { ws, token: newToken() }, guest: null, lastActive: Date.now() };
        rooms.set(code, room);
        ws.room = code; ws.role = "host";
        return send(ws, { t: "created", code, token: room.host.token });
      }
      case "join": {
        const room = rooms.get(code);
        if (!room) return send(ws, { t: "error", e: "no_room" });
        if (room.guest) return send(ws, { t: "error", e: "room_full" });
        if (!connected(room, "host")) return send(ws, { t: "error", e: "host_away" });
        room.guest = { ws, token: newToken() };
        room.lastActive = Date.now();
        ws.room = code; ws.role = "guest";
        send(ws, { t: "joined", code, token: room.guest.token });
        return send(room.host.ws, { t: "peer_joined" });
      }
      case "rejoin": {
        const room = rooms.get(code);
        if (!room) return send(ws, { t: "error", e: "no_room" });
        let role = null;
        if (room.host && room.host.token === m.token) role = "host";
        else if (room.guest && room.guest.token === m.token) role = "guest";
        if (!role) return send(ws, { t: "error", e: "bad_token" });
        const old = room[role].ws;
        room[role].ws = ws;
        if (old && old !== ws && old.readyState === 1) { old.room = null; old.close(); }
        ws.room = code; ws.role = role;
        room.lastActive = Date.now();
        send(ws, { t: "rejoined", code, role, peer: connected(room, other(role)) });
        const o = room[other(role)];
        if (o && connected(room, other(role))) send(o.ws, { t: "peer_joined" });
        return;
      }
      case "relay": {
        const room = ws.room && rooms.get(ws.room);
        if (!room || !ws.role) return;
        room.lastActive = Date.now();
        const o = room[other(ws.role)];
        if (o && o.ws && o.ws.readyState === 1) send(o.ws, { t: "relay", d: m.d });
        return;
      }
      case "leave": {
        const room = ws.room && rooms.get(ws.room);
        if (room && ws.role) {
          const g = room.game;
          if (g && !g.settled && !g.reports[ws.role] && g.pids.host && g.pids.guest && Date.now() - g.startedAt > MIN_FORFEIT_MS) {
            settleGame(room, other(ws.role), "forfeit"); // abandon en cours de partie : défaite pour celui qui part
          }
          const o = room[other(ws.role)];
          if (o && o.ws) send(o.ws, { t: "peer_quit" });
          rooms.delete(ws.room);
        }
        ws.room = null; ws.role = null;
        return;
      }
      case "player": {
        if (!store) return send(ws, { t: "player_ok", off: true });
        if (!PID_RE.test(String(m.pid || "")) || String(m.secret || "").length < 16) return send(ws, { t: "error", e: "bad_player" });
        return store.register(m.pid, sha(m.secret), m.name).then(async (p) => {
          if (!p) return send(ws, { t: "player_ok", bad_secret: true });
          ws.pid = p.pid;
          send(ws, { t: "player_ok", elo: p.elo, rank: await store.rankOf(p.pid), name: p.name });
        }).catch((e) => console.error("player:", e.message));
      }
      case "game_start": {
        const room = ws.room && rooms.get(ws.room);
        if (!room || !ws.role || !ws.pid || typeof m.gid !== "string" || m.gid.length > 40) return;
        const gid = ws.room + ":" + m.gid;
        if (!room.game || room.game.gid !== gid) {
          room.game = { gid, startedAt: Date.now(), pids: {}, reports: {}, settled: false, timer: null };
        }
        room.game.pids[ws.role] = ws.pid;
        return;
      }
      case "game_end":
        if (typeof m.gid === "string") m.gid = (ws.room || "") + ":" + m.gid;
        return onReport(ws, m);
      case "ping":
        return send(ws, { t: "pong" });
    }
  });

  ws.on("close", () => {
    const room = ws.room && rooms.get(ws.room);
    if (!room || !ws.role) return;
    if (room[ws.role] && room[ws.role].ws === ws) {
      room[ws.role].ws = null;
      const o = room[other(ws.role)];
      if (o && connected(room, other(ws.role))) send(o.ws, { t: "peer_left" });
    }
  });
  ws.on("error", () => {});
});

// battement de cœur (évite que l'hébergeur coupe les connexions inactives) et nettoyage des salles
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!connected(room, "host") && !connected(room, "guest") && now - room.lastActive > ROOM_TTL_MS) rooms.delete(code);
  }
}, 20000);

(async () => {
  try {
    const st = Store.create();
    await st.init();
    store = st;
    console.log("Classement en ligne : " + (process.env.DATABASE_URL ? "PostgreSQL" : "fichier local (non persistant sur l'offre gratuite de Render)"));
  } catch (e) {
    console.error("Classement désactivé :", e.message);
  }
  server.listen(PORT, () => console.log("Northskye relay en écoute sur le port " + PORT));
})();
