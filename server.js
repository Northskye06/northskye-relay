// Serveur relais Northskye : met en relation deux joueurs par un code de partie et se contente de
// transmettre leurs messages. Il ne connaît rien aux règles : chaque client fait tourner le moteur
// (même graine + mêmes commandes = même partie).
"use strict";
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_MSG = 512 * 1024;            // taille max d'un message (octets)
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // une salle vide (personne connecté) est supprimée après 6 h
const CODE_RE = /^[A-Z0-9]{4,8}$/;

/** code -> { host:{ws,token}, guest:{ws,token}|null, lastActive } */
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Northskye relay OK — " + rooms.size + " salle(s)\n");
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
          const o = room[other(ws.role)];
          if (o && o.ws) send(o.ws, { t: "peer_quit" });
          rooms.delete(ws.room);
        }
        ws.room = null; ws.role = null;
        return;
      }
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

server.listen(PORT, () => console.log("Northskye relay en écoute sur le port " + PORT));
