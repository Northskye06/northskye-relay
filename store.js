// Stockage du classement en ligne.
//  - Si DATABASE_URL est défini : base PostgreSQL (Neon, Supabase… offres gratuites) — les données survivent aux redémarrages.
//  - Sinon : simple fichier JSON (pratique pour tester en local ; sur l'offre gratuite de Render le disque est effacé à chaque redémarrage).
"use strict";
const fs = require("fs");
const path = require("path");

const START_ELO = 1000;
const MIN_ELO = 100;
const K = 32;

function eloDelta(ra, rb, score) { // score : 1 victoire, 0.5 nul, 0 défaite (du point de vue de A)
  const exp = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(K * (score - exp));
}

function clean(name) {
  const n = String(name || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 20);
  return n || "Voyageur";
}

/** Calcule le résultat d'une partie sur deux fiches joueur (modifie a et b) ; winner : "a" | "b" | "draw". */
function settle(a, b, winner) {
  const sa = winner === "a" ? 1 : winner === "b" ? 0 : 0.5;
  const da0 = eloDelta(a.elo, b.elo, sa);
  const db0 = -da0;
  const na = Math.max(MIN_ELO, a.elo + da0), nb = Math.max(MIN_ELO, b.elo + db0);
  const out = { a: na - a.elo, b: nb - b.elo };
  a.elo = na; b.elo = nb;
  if (winner === "a") { a.wins++; b.losses++; }
  else if (winner === "b") { b.wins++; a.losses++; }
  else { a.draws++; b.draws++; }
  a.updated = b.updated = Date.now();
  return out;
}

// ---------------------------------------------------------------- fichier JSON
class FileStore {
  constructor(file) {
    this.file = file;
    this.db = { players: {}, games: {} };
    try { this.db = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
    this.db.players = this.db.players || {}; this.db.games = this.db.games || {};
    this._t = null;
  }
  async init() {}
  _save() {
    if (this._t) return;
    this._t = setTimeout(() => {
      this._t = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.db));
        fs.renameSync(this.file + ".tmp", this.file);
      } catch (e) { console.error("sauvegarde du classement impossible :", e.message); }
    }, 500);
  }
  _pub(p) { return p && { pid: p.pid, name: p.name, elo: p.elo, wins: p.wins, losses: p.losses, draws: p.draws }; }
  async register(pid, secretHash, name) {
    let p = this.db.players[pid];
    if (!p) {
      p = { pid, secret: secretHash, name: clean(name), elo: START_ELO, wins: 0, losses: 0, draws: 0, updated: Date.now() };
      this.db.players[pid] = p;
    } else if (p.secret !== secretHash) return null;
    else p.name = clean(name);
    this._save();
    return this._pub(p);
  }
  async get(pid) { return this._pub(this.db.players[pid]); }
  async top(n) {
    return Object.values(this.db.players).filter((p) => p.wins + p.losses + p.draws > 0)
      .sort((x, y) => y.elo - x.elo || y.wins - x.wins).slice(0, n).map((p) => this._pub(p));
  }
  async rankOf(pid) {
    const p = this.db.players[pid];
    if (!p) return null;
    return 1 + Object.values(this.db.players).filter((q) => q.wins + q.losses + q.draws > 0 && (q.elo > p.elo)).length;
  }
  async count() { return Object.values(this.db.players).filter((p) => p.wins + p.losses + p.draws > 0).length; }
  /** Enregistre une partie (une seule fois par gid). Renvoie { a:{elo,delta}, b:{elo,delta} } ou null si déjà enregistrée. */
  async applyGame(gid, pidA, pidB, winner) {
    if (this.db.games[gid]) return null;
    const a = this.db.players[pidA], b = this.db.players[pidB];
    if (!a || !b || pidA === pidB) return null;
    const d = settle(a, b, winner);
    this.db.games[gid] = { a: pidA, b: pidB, w: winner, t: Date.now() };
    const keys = Object.keys(this.db.games);
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete this.db.games[k];
    this._save();
    return { a: { elo: a.elo, delta: d.a }, b: { elo: b.elo, delta: d.b } };
  }
}

// ---------------------------------------------------------------- PostgreSQL
class PgStore {
  constructor(url) {
    const { Pool } = require("pg");
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({ connectionString: url, max: 4, ssl: local ? false : { rejectUnauthorized: false } });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS players (
      pid TEXT PRIMARY KEY, secret TEXT NOT NULL, name TEXT NOT NULL,
      elo INTEGER NOT NULL DEFAULT ${START_ELO}, wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, updated BIGINT NOT NULL DEFAULT 0)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS games (
      gid TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, w TEXT NOT NULL,
      da INTEGER NOT NULL, db INTEGER NOT NULL, t BIGINT NOT NULL)`);
    await this.pool.query("CREATE INDEX IF NOT EXISTS players_elo ON players (elo DESC)");
  }
  _pub(r) { return r && { pid: r.pid, name: r.name, elo: Number(r.elo), wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws) }; }
  async register(pid, secretHash, name) {
    const nm = clean(name);
    await this.pool.query(
      "INSERT INTO players (pid, secret, name, updated) VALUES ($1,$2,$3,$4) ON CONFLICT (pid) DO NOTHING", [pid, secretHash, nm, Date.now()]);
    const r = await this.pool.query("SELECT * FROM players WHERE pid=$1", [pid]);
    if (!r.rows[0] || r.rows[0].secret !== secretHash) return null;
    if (r.rows[0].name !== nm) await this.pool.query("UPDATE players SET name=$2 WHERE pid=$1", [pid, nm]);
    r.rows[0].name = nm;
    return this._pub(r.rows[0]);
  }
  async get(pid) { const r = await this.pool.query("SELECT * FROM players WHERE pid=$1", [pid]); return this._pub(r.rows[0]); }
  async top(n) {
    const r = await this.pool.query("SELECT * FROM players WHERE wins+losses+draws>0 ORDER BY elo DESC, wins DESC LIMIT $1", [n]);
    return r.rows.map((x) => this._pub(x));
  }
  async rankOf(pid) {
    const me = await this.pool.query("SELECT elo FROM players WHERE pid=$1", [pid]);
    if (!me.rows[0]) return null;
    const r = await this.pool.query("SELECT COUNT(*) AS n FROM players WHERE wins+losses+draws>0 AND elo > $1", [Number(me.rows[0].elo)]);
    return 1 + Number(r.rows[0].n);
  }
  async count() { const r = await this.pool.query("SELECT COUNT(*) AS n FROM players WHERE wins+losses+draws>0"); return Number(r.rows[0].n); }
  async applyGame(gid, pidA, pidB, winner) {
    if (pidA === pidB) return null;
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const dup = await c.query("SELECT 1 FROM games WHERE gid=$1", [gid]);
      if (dup.rows.length) { await c.query("ROLLBACK"); return null; }
      await c.query("INSERT INTO games (gid,a,b,w,da,db,t) VALUES ($1,$2,$3,$4,0,0,$5)", [gid, pidA, pidB, winner, Date.now()]); // clé unique : un doublon simultané échoue
      const got = {};
      for (const id of [pidA, pidB].sort()) { // ordre fixe : évite les blocages croisés
        const r = await c.query("SELECT * FROM players WHERE pid=$1 FOR UPDATE", [id]);
        got[id] = r.rows[0];
      }
      const a = got[pidA], b = got[pidB];
      if (!a || !b) { await c.query("ROLLBACK"); return null; }
      a.elo = Number(a.elo); b.elo = Number(b.elo);
      a.wins = Number(a.wins); a.losses = Number(a.losses); a.draws = Number(a.draws);
      b.wins = Number(b.wins); b.losses = Number(b.losses); b.draws = Number(b.draws);
      const d = settle(a, b, winner);
      for (const p of [a, b]) {
        await c.query("UPDATE players SET elo=$2, wins=$3, losses=$4, draws=$5, updated=$6 WHERE pid=$1", [p.pid, p.elo, p.wins, p.losses, p.draws, p.updated]);
      }
      await c.query("UPDATE games SET da=$2, db=$3 WHERE gid=$1", [gid, d.a, d.b]);
      await c.query("COMMIT");
      return { a: { elo: a.elo, delta: d.a }, b: { elo: b.elo, delta: d.b } };
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch (e2) {}
      throw e;
    } finally { c.release(); }
  }
}

function create() {
  if (process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  return new FileStore(process.env.LADDER_FILE || path.join(__dirname, "data", "ladder.json"));
}

module.exports = { create, FileStore, PgStore, eloDelta, clean, START_ELO };
