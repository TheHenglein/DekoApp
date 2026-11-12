/* Materialkalkulation – Web-App
 * Daten liegen als eine JSON-Datei in Google Drive (oder lokal im Browser).
 * Rechenlogik entspricht der LibreOffice-Tabelle.
 */
"use strict";

const CFG = Object.assign({ googleClientId: "", driveFolder: "Materialkalkulation", driveFile: "materialkalkulation.json" },
  window.APP_CONFIG || {});
const SCHEMA = 1;
const LS = { data: "mk_data", meta: "mk_meta", mode: "mk_mode", token: "mk_token", tab: "mk_tab" };

/* =================================================================== Hilfen */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };
const num = (v) => {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s); return isFinite(n) ? n : null;
};
const fEUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const fEUR4 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fNum = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 });
const eur = (v) => v == null || !isFinite(v) ? "–" : fEUR.format(v);
const eur4 = (v) => v == null || !isFinite(v) ? "–" : fEUR4.format(v);
const pct = (v, d = 0) => v == null || !isFinite(v) ? "–" : (v * 100).toLocaleString("de-DE", { maximumFractionDigits: d }) + " %";
const nf = (v) => v == null ? "" : fNum.format(v);
const todayISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const fDate = (iso) => iso ? iso.split("-").reverse().join(".") : "–";
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const initials = (s) => (s || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const clone = (o) => JSON.parse(JSON.stringify(o));
// Eingabewert für Prozentfelder: "10" oder "10 %" → 0.1
const pctIn = (v) => { const n = num(String(v ?? "").replace("%", "")); return n == null ? null : n / 100; };
const pctOut = (v) => v == null ? "" : String(+(v * 100).toFixed(4)).replace(".", ",");
const numOut = (v) => v == null ? "" : String(v).replace(".", ",");

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), ms);
}

/* =================================================================== Datenmodell */
function emptyDB() {
  return {
    schema: SCHEMA, updated: new Date().toISOString(),
    settings: { lohn: 15, verpackung: 0, gebuehr: 0, gebFix: 0, marge: 0.3, versand: false, ku: true, mwst: 0.19 },
    lists: {
      kategorien: ["Perlen"], produkttypen: ["Lichtspiel"], laeden: ["Amazon"],
      einheiten: [
        { name: "Stück", basis: "Stück", faktor: 1 }, { name: "cm", basis: "cm", faktor: 1 },
        { name: "m", basis: "cm", faktor: 100 }, { name: "mm", basis: "cm", faktor: 0.1 },
        { name: "g", basis: "g", faktor: 1 }, { name: "kg", basis: "g", faktor: 1000 },
        { name: "ml", basis: "ml", faktor: 1 }, { name: "l", basis: "ml", faktor: 1000 }],
      basis: ["Stück", "cm", "g", "ml"]
    },
    teile: [], einkaeufe: [], varianten: []
  };
}
let db = null;

function nextId(prefix, arr) {
  let max = 0;
  for (const x of arr) { const m = /^\D*(\d+)$/.exec(x.id); if (m) max = Math.max(max, +m[1]); }
  return prefix + String(max + 1).padStart(3, "0");
}
const teilById = (id) => db.teile.find((t) => t.id === id);
const varById = (id) => db.varianten.find((v) => v.id === id);
const unitsFor = (basis) => db.lists.einheiten.filter((e) => e.basis === basis);
function toBasis(menge, einheit, basis) {
  if (menge == null) return null;
  if (!einheit || einheit === basis) return menge;
  const e = db.lists.einheiten.find((x) => x.name === einheit);
  if (!e || e.basis !== basis) return null;
  return menge * e.faktor;
}

/* =================================================================== Berechnung */
let C = null; // Cache der Berechnungen, wird bei jeder Änderung neu erzeugt
function compute() {
  const s = db.settings;
  const steuer = s.ku ? 1 : 1 + (s.mwst || 0);
  const ek = {}; // id -> {basisMenge, preisBasis, ok}
  const byTeil = {};
  db.einkaeufe.forEach((e, idx) => {
    const t = teilById(e.teil);
    const bm = t ? toBasis(e.menge, e.einheit, t.basis) : null;
    const total = e.preis == null ? null : e.preis + (s.versand ? (e.versand || 0) : 0);
    const pb = bm && total != null ? total / bm / steuer : null;
    ek[e.id] = { basisMenge: bm, preisBasis: pb, ausgabe: (e.preis || 0) + (e.versand || 0), idx,
      warn: !t ? "Einzelteil fehlt" : bm == null ? "Einheit passt nicht" : pb == null ? "Preis fehlt" : null };
    if (t && pb != null) (byTeil[e.teil] ||= []).push(e);
  });
  const teil = {};
  for (const t of db.teile) {
    const list = (byTeil[t.id] || []).slice().sort((a, b) => (a.datum || "").localeCompare(b.datum || "") || ek[a.id].idx - ek[b.id].idx);
    const last = list[list.length - 1], prev = list[list.length - 2];
    const preis = last ? ek[last.id].preisBasis : null;
    const vor = prev ? ek[prev.id].preisBasis : null;
    teil[t.id] = {
      preis, last, vor, aenderung: preis != null && vor ? preis / vor - 1 : null,
      min: list.length ? Math.min(...list.map((e) => ek[e.id].preisBasis)) : null,
      anzahl: list.length, kaeufe: list.slice().reverse()
    };
  }
  const vari = {};
  for (const v of db.varianten) {
    let ohne = 0, inkl = 0, warn = null;
    const lines = (v.teile || []).map((l) => {
      const t = teilById(l.teil);
      const bm = t ? toBasis(l.menge, l.einheit, t.basis) : null;
      const p = t ? teil[t.id].preis : null;
      const vs = l.verschnitt != null ? l.verschnitt : (t && t.verschnitt) || 0;
      const k = bm != null && p != null ? bm * p : null;
      const ki = k != null ? k * (1 + vs) : null;
      const w = !t ? "Einzelteil fehlt" : l.menge == null ? "Menge fehlt" : bm == null ? "Einheit passt nicht" : p == null ? "Noch kein Einkauf" : null;
      if (k != null) { ohne += k; inkl += ki; }
      if (w && !warn) warn = "Stückliste prüfen";
      return { l, t, bm, p, vs, k, ki, warn: w };
    });
    const lohn = v.lohn ?? s.lohn, verp = v.verpackung ?? s.verpackung, geb = v.gebuehr ?? s.gebuehr,
      gfix = v.gebFix ?? s.gebFix, marge = v.marge ?? s.marge;
    const arbeit = (v.minuten || 0) / 60 * lohn;
    const hk = inkl + arbeit + verp;
    const empf = (hk * (1 + marge) + gfix) / (1 - geb) * steuer;
    const netto = v.vk != null ? v.vk / steuer : null;
    const gewinn = netto != null ? netto * (1 - geb) - gfix - hk : null;
    const effLohn = netto != null && v.minuten ? (netto * (1 - geb) - gfix - inkl - verp) / (v.minuten / 60) : null;
    if (!lines.length) warn = "Keine Teile";
    else if (!warn && !v.minuten) warn = "Arbeitszeit fehlt";
    vari[v.id] = { lines, ohne, inkl, arbeit, verp, hk, empf, gewinn, effLohn, warn, lohn };
  }
  C = { ek, teil, vari };
  return C;
}

/* =================================================================== Speicher: lokal + Google Drive */
const Sync = {
  mode: lsGet(LS.mode), // "drive" | "local" | null
  status: "idle", // idle | saving | saved | offline | error | auth
  fileId: null, folderId: null, photoFolderId: null, version: null, lastSave: null,
  dirty: false, timer: null, token: null, tokenExp: 0, tokenClient: null, email: null,

  setStatus(st) { this.status = st; renderSync(); },

  loadCache() {
    const d = lsGet(LS.data); const m = lsGet(LS.meta) || {};
    Object.assign(this, { fileId: m.fileId || null, folderId: m.folderId || null, photoFolderId: m.photoFolderId || null,
      version: m.version || null, lastSave: m.lastSave || null, dirty: !!m.dirty, email: m.email || null });
    return d;
  },
  saveCache() {
    lsSet(LS.data, db);
    lsSet(LS.meta, { fileId: this.fileId, folderId: this.folderId, photoFolderId: this.photoFolderId, version: this.version, lastSave: this.lastSave,
      dirty: this.dirty, email: this.email });
  },

  changed() {
    db.updated = new Date().toISOString();
    this.dirty = true; this.saveCache();
    if (this.mode === "drive") { clearTimeout(this.timer); this.timer = setTimeout(() => this.push(), 1200); this.setStatus("saving"); }
  },

  /* ---------- Google-Anmeldung ---------- */
  gisReady() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this._gis) return this._gis;
    this._gis = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => res(); s.onerror = () => { this._gis = null; rej(new Error("Google-Anmeldung nicht erreichbar (offline?)")); };
      document.head.appendChild(s);
    });
    return this._gis;
  },
  async getToken(interactive) {
    if (this.token && Date.now() < this.tokenExp - 60e3) return this.token;
    const cached = lsGet(LS.token);
    if (cached && Date.now() < cached.exp - 60e3) { this.token = cached.t; this.tokenExp = cached.exp; return this.token; }
    if (!interactive) throw Object.assign(new Error("Anmeldung nötig"), { auth: true });
    await this.gisReady();
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId,
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: (r) => {
          if (r.error) return rej(new Error("Anmeldung abgebrochen"));
          this.token = r.access_token; this.tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
          lsSet(LS.token, { t: this.token, exp: this.tokenExp });
          res(this.token);
        },
        error_callback: (e) => rej(new Error(e?.type === "popup_closed" ? "Anmeldefenster geschlossen" : "Anmeldung fehlgeschlagen"))
      });
      tc.requestAccessToken({ prompt: this.email ? "" : "consent", hint: this.email || undefined });
    });
  },
  async api(url, opts = {}, interactive = false) {
    const tok = await this.getToken(interactive);
    const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + tok }, opts.headers || {}) }));
    if (r.status === 401) { this.token = null; lsDel(LS.token); throw Object.assign(new Error("Anmeldung abgelaufen"), { auth: true }); }
    if (!r.ok) throw new Error("Google Drive: Fehler " + r.status);
    return r;
  },
  q(s) { return encodeURIComponent(s); },
  async findOrCreateFolder(name, parent, interactive) {
    const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : "");
    const r = await (await this.api(`https://www.googleapis.com/drive/v3/files?q=${this.q(q)}&fields=files(id)&spaces=drive`, {}, interactive)).json();
    if (r.files?.length) return r.files[0].id;
    const c = await (await this.api("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: parent ? [parent] : undefined })
    }, interactive)).json();
    return c.id;
  },
  async multipart(meta, blob, method = "POST", id = "") {
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    fd.append("file", blob);
    const url = `https://www.googleapis.com/upload/drive/v3/files${id ? "/" + id : ""}?uploadType=multipart&fields=id,md5Checksum`;
    return (await this.api(url, { method, body: fd })).json();
  },
  async whoAmI() {
    try {
      const r = await (await this.api("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)")).json();
      this.email = r.user?.emailAddress || this.email;
    } catch {}
  },

  /* Verbinden: Ordner + Datei suchen/anlegen, Daten laden */
  async connect(interactive) {
    await this.getToken(interactive);
    await this.whoAmI();
    this.folderId = await this.findOrCreateFolder(CFG.driveFolder, null, interactive);
    const q = `name='${CFG.driveFile}' and '${this.folderId}' in parents and trashed=false`;
    const r = await (await this.api(`https://www.googleapis.com/drive/v3/files?q=${this.q(q)}&fields=files(id,version)&spaces=drive`)).json();
    if (r.files?.length) {
      this.fileId = r.files[0].id;
      return "exists";
    }
    return "missing";
  },
  /* Prüfsumme des Dateiinhalts – ändert sich nur, wenn sich der Inhalt ändert */
  async checksum() {
    const m = await (await this.api(`https://www.googleapis.com/drive/v3/files/${this.fileId}?fields=md5Checksum`)).json();
    return m.md5Checksum || null;
  },
  /* Wurde die Datei seit unserem letzten Speichern von einem anderen Gerät überschrieben? */
  async changedElsewhere() {
    const sum = await this.checksum();
    if (!this.version || sum === this.version) { this.version = sum; return false; }
    // Inhalt hat sich geändert: stammt der Stand trotzdem von unserem letzten Speichern?
    const remote = await (await this.api(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`)).json();
    const legacy = !/^[0-9a-f]{32}$/.test(this.version);   // Stand aus der Vorversion der App
    if (legacy || !remote.saveId || remote.saveId === this.lastSave) { this.version = sum; return false; }
    return true;
  },
  async pull() {
    const data = await (await this.api(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`)).json();
    this.version = await this.checksum();
    this.lastSave = data.saveId || null;
    return data;
  },
  async createFile(data) {
    const r = await this.multipart({ name: CFG.driveFile, parents: [this.folderId], mimeType: "application/json" },
      new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
    this.fileId = r.id; this.version = r.md5Checksum; this.lastSave = data.saveId || null;
  },
  async push(force = false) {
    if (this.mode !== "drive" || !this.dirty) { if (this.mode === "drive") this.setStatus("saved"); return; }
    if (!navigator.onLine) return this.setStatus("offline");
    if (this._pushing) { clearTimeout(this.timer); this.timer = setTimeout(() => this.push(), 1500); return; }
    this._pushing = true; this.setStatus("saving");
    try {
      if (!this.fileId) { await this.connect(false); if (!this.fileId) await this.createFile(db); }
      if (!force && await this.changedElsewhere()) { this._pushing = false; return conflictDialog(); }
      db.saveId = uid();
      const r = await (await this.api(`https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=media&fields=md5Checksum`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(db, null, 1)
      })).json();
      this.version = r.md5Checksum; this.lastSave = db.saveId; this.dirty = false; this.saveCache(); this.setStatus("saved");
    } catch (e) {
      console.warn(e);
      this.setStatus(e.auth ? "auth" : navigator.onLine ? "error" : "offline");
    } finally { this._pushing = false; }
  },
  /* Beim Zurückkehren zur App prüfen, ob auf einem anderen Gerät gespeichert wurde */
  async refresh() {
    if (this.mode !== "drive" || !this.fileId || this.dirty || !navigator.onLine) return;
    try {
      if (await this.checksum() !== this.version) {
        const before = this.lastSave;
        const data = await this.pull();
        if (!before || data.saveId !== before) { db = migrate(data); render(); toast("Neue Daten vom anderen Gerät geladen"); }
        this.saveCache();
      }
      this.setStatus("saved");
    } catch (e) { if (e.auth) this.setStatus("auth"); }
  },

  /* ---------- Fotos ---------- */
  async photoFolder() {
    if (this.photoFolderId) return this.photoFolderId;
    if (!this.folderId) this.folderId = await this.findOrCreateFolder(CFG.driveFolder, null, false);
    this.photoFolderId = await this.findOrCreateFolder("Fotos", this.folderId, false);
    this.saveCache();
    return this.photoFolderId;
  },
  async putPhoto(blob, name) {
    if (this.mode === "drive") {
      const folder = await this.photoFolder();
      const r = await this.multipart({ name, parents: [folder], mimeType: "image/jpeg" }, blob);
      await PhotoCache.put(r.id, blob);
      return r.id;
    }
    const id = "local:" + uid();
    await IDB.put(id, blob);
    return id;
  },
  async getPhoto(id) {
    if (id.startsWith("local:")) return IDB.get(id);
    const cached = await PhotoCache.get(id);
    if (cached) return cached;
    if (this.mode !== "drive") return null;
    const r = await this.api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    const b = await r.blob(); await PhotoCache.put(id, b); return b;
  },
  async dropPhoto(id) {
    if (!id) return;
    try {
      if (id.startsWith("local:")) return IDB.del(id);
      await this.api(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    } catch (e) { console.warn(e); }
  }
};

/* Foto-Zwischenspeicher (Cache Storage) und lokale Fotos (IndexedDB) */
const PhotoCache = {
  async c() { try { return await caches.open("mk-photos"); } catch { return null; } },
  async get(id) { const c = await this.c(); const r = c && await c.match("/photo/" + id); return r ? r.blob() : null; },
  async put(id, b) { const c = await this.c(); if (c) await c.put("/photo/" + id, new Response(b)); }
};
const IDB = {
  db() {
    return this._db ||= new Promise((res, rej) => {
      const r = indexedDB.open("mk", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("photos");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) { const d = await this.db(); return new Promise((res, rej) => { const t = d.transaction("photos", mode); const q = fn(t.objectStore("photos")); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error); }); },
  get(id) { return this.tx("readonly", (s) => s.get(id)); },
  put(id, b) { return this.tx("readwrite", (s) => s.put(b, id)); },
  del(id) { return this.tx("readwrite", (s) => s.delete(id)); }
};
const photoURLs = new Map();
async function photoURL(id) {
  if (!id) return null;
  if (photoURLs.has(id)) return photoURLs.get(id);
  try { const b = await Sync.getPhoto(id); if (!b) return null; const u = URL.createObjectURL(b); photoURLs.set(id, u); return u; }
  catch { return null; }
}
/* Fotos nachladen: <span data-photo="id"> wird durch <img> ersetzt */
function hydratePhotos(root = document) {
  $$("[data-photo]", root).forEach(async (el) => {
    const id = el.dataset.photo; if (!id) return;
    const u = await photoURL(id);
    if (u && el.isConnected) { el.innerHTML = `<img src="${u}" alt="">`; }
  });
}
function resizeImage(file, max = 1200) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas"); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(u); cv.toBlob((b) => b ? res(b) : rej(new Error("Bild konnte nicht verarbeitet werden")), "image/jpeg", 0.82);
    };
    img.onerror = () => rej(new Error("Bild konnte nicht gelesen werden"));
    img.src = u;
  });
}

function migrate(d) {
  const base = emptyDB();
  if (!d || typeof d !== "object") return base;
  d.settings = Object.assign(base.settings, d.settings || {});
  d.lists = Object.assign(base.lists, d.lists || {});
  for (const k of ["teile", "einkaeufe", "varianten"]) if (!Array.isArray(d[k])) d[k] = [];
  d.varianten.forEach((v) => { if (!Array.isArray(v.teile)) v.teile = []; v.teile.forEach((l) => l.id ||= uid()); });
  d.einkaeufe.forEach((e) => e.id ||= uid());
  d.schema = SCHEMA;
  return d;
}

/* =================================================================== Navigation & Rendering */
const TABS = [
  ["start", "Übersicht", '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>'],
  ["einkauf", "Einkauf", '<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>'],
  ["teile", "Teile", '<circle cx="7" cy="7" r="3.5"/><circle cx="17" cy="7" r="3.5"/><circle cx="7" cy="17" r="3.5"/><circle cx="17" cy="17" r="3.5"/>'],
  ["produkte", "Produkte", '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>'],
  ["mehr", "Mehr", '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>']
];
let tab = lsGet(LS.tab, "start");
const ui = { q: { einkauf: "", teile: "", produkte: "" }, kat: "", typ: "" };

function svg(p) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`; }

function renderShell() {
  $("#app").innerHTML = `
  <div class="shell">
    <header class="topbar"><h1 id="title"></h1><button class="sync" id="sync" data-act="sync"></button></header>
    <div id="banner"></div>
    <main id="view"></main>
    <nav class="tabs">${TABS.map(([k, l, p]) => `<button data-tab="${k}">${svg(p)}<span>${l}</span></button>`).join("")}</nav>
  </div>`;
}
function renderSync() {
  const el = $("#sync"); if (!el) return;
  const m = {
    local: ["local", "Nur dieses Gerät"], saving: ["saving", "Speichert …"], saved: ["", "Gespeichert"], idle: ["", "Verbunden"],
    offline: ["offline", "Offline – wird später gespeichert"], error: ["error", "Speichern fehlgeschlagen"], auth: ["error", "Neu anmelden"]
  };
  const [cls, txt] = Sync.mode === "local" ? m.local : (m[Sync.status] || m.idle);
  el.className = "sync " + cls; el.innerHTML = `<span class="dot"></span><span>${txt}</span>`;
  const b = $("#banner");
  if (b) b.innerHTML = Sync.mode === "drive" && Sync.status === "auth"
    ? `<div class="authbar"><span>Zum Speichern bitte kurz neu bei Google anmelden.</span><button class="btn small primary" data-act="sync">Anmelden</button></div>` : "";
}
function render() {
  if (!db) return;
  compute();
  $$("nav.tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#title").textContent = TABS.find((t) => t[0] === tab)[1];
  const v = $("#view");
  v.innerHTML = ({ start: viewStart, einkauf: viewEinkauf, teile: viewTeile, produkte: viewProdukte, mehr: viewMehr }[tab])();
  hydratePhotos(v);
  renderSync();
}
function go(t) { tab = t; lsSet(LS.tab, t); render(); window.scrollTo(0, 0); }

const thumb = (photo, name) => `<span class="thumb" ${photo ? `data-photo="${esc(photo)}"` : ""}>${esc(initials(name))}</span>`;
const varLabel = (v) => (v.typ ? v.typ + " – " : "") + v.name;

/* ---------- Übersicht ---------- */
function viewStart() {
  const year = new Date().getFullYear();
  const ausgabenJahr = db.einkaeufe.filter((e) => (e.datum || "").startsWith(year)).reduce((s, e) => s + C.ek[e.id].ausgabe, 0);
  const vs = db.varianten.map((v) => ({ v, c: C.vari[v.id] }));
  const avg = vs.length ? vs.reduce((s, x) => s + x.c.hk, 0) / vs.length : 0;
  const zuPruefen = vs.filter((x) => x.c.warn).length + db.teile.filter((t) => !C.teil[t.id].anzahl).length;
  if (!db.teile.length && !db.varianten.length) {
    return `<div class="empty"><b>Noch keine Daten</b>Lege unter <a href="#" data-tab="teile">Teile</a> dein erstes Material an
      oder übernimm deine Tabelle unter <a href="#" data-tab="mehr">Mehr → Tabelle importieren</a>.</div>`;
  }
  const top = vs.slice().sort((a, b) => b.c.hk - a.c.hk).slice(0, 10);
  const maxHK = Math.max(1e-9, ...top.map((x) => x.c.hk));
  const changes = db.teile.map((t) => ({ t, c: C.teil[t.id] })).filter((x) => x.c.aenderung != null)
    .sort((a, b) => Math.abs(b.c.aenderung) - Math.abs(a.c.aenderung)).slice(0, 8);
  const months = [];
  const d0 = new Date(); d0.setDate(1);
  for (let i = 11; i >= 0; i--) { const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1); months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("de-DE", { month: "short" }), sum: 0 }); }
  const shops = {};
  for (const e of db.einkaeufe) {
    const m = months.find((x) => (e.datum || "").startsWith(x.key)); if (m) m.sum += C.ek[e.id].ausgabe;
    const l = e.laden || "ohne Angabe"; shops[l] = (shops[l] || 0) + C.ek[e.id].ausgabe;
  }
  const maxM = Math.max(1e-9, ...months.map((m) => m.sum));
  const shopArr = Object.entries(shops).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxS = Math.max(1e-9, ...shopArr.map((x) => x[1]));
  return `
  <div class="grid kpis">
    <div class="card kpi"><div class="l">Einzelteile</div><div class="v">${db.teile.length}</div></div>
    <div class="card kpi"><div class="l">Varianten</div><div class="v">${db.varianten.length}</div></div>
    <div class="card kpi"><div class="l">Ø Herstellkosten</div><div class="v">${eur(avg)}</div></div>
    <div class="card kpi"><div class="l">Ausgaben ${year}</div><div class="v">${eur(ausgabenJahr)}</div></div>
    <div class="card kpi ${zuPruefen ? "warn" : ""}" data-act="pruefen" style="cursor:pointer"><div class="l">Zu prüfen</div><div class="v">${zuPruefen}</div></div>
  </div>
  <div class="grid two mt">
    <div class="card"><h3>Herstellkosten je Variante</h3>
      ${top.length ? `<div class="bars">${top.map(({ v, c }) => `
        <div class="bar-row" data-act="variante" data-id="${v.id}" style="cursor:pointer"><span class="n">${esc(varLabel(v))}</span>
          <span class="bar">${[["m", c.inkl], ["a", c.arbeit], ["p", c.verp]].map(([k, x]) => `<i class="${k}" style="width:${x / maxHK * 100}%"></i>`).join("")}</span>
          <b>${eur(c.hk)}</b></div>`).join("")}</div>
        <div class="legend"><span style="--c:var(--dark)">Material</span><span style="--c:var(--acc)">Arbeit</span><span style="--c:var(--mid)">Verpackung</span></div>`
        : `<p class="muted">Noch keine Varianten.</p>`}
    </div>
    <div class="card"><h3>Größte Preisänderungen</h3>
      ${changes.length ? `<table class="t">${changes.map(({ t, c }) => `<tr data-act="teil" data-id="${t.id}" style="cursor:pointer">
        <td>${esc(t.name)}</td><td class="num">${eur4(c.preis)} / ${esc(t.basis)}</td>
        <td class="num"><span class="badge ${c.aenderung > 0 ? "up" : c.aenderung < 0 ? "down" : ""}">${c.aenderung > 0 ? "+" : ""}${pct(c.aenderung, 1)}</span></td></tr>`).join("")}</table>`
        : `<p class="muted">Sobald ein Teil zum zweiten Mal gekauft wird, erscheint hier die Preisänderung.</p>`}
    </div>
    <div class="card"><h3>Ausgaben der letzten 12 Monate</h3>
      <div class="cols">${months.map((m) => `<div class="c" title="${m.label}: ${eur(m.sum)}"><i style="height:${m.sum / maxM * 100}%"></i><span>${m.label}</span></div>`).join("")}</div>
    </div>
    <div class="card"><h3>Ausgaben je Laden</h3>
      ${shopArr.length ? `<div class="bars">${shopArr.map(([n, s]) => `<div class="bar-row"><span class="n">${esc(n)}</span>
        <span class="bar"><i class="a" style="width:${s / maxS * 100}%"></i></span><b>${eur(s)}</b></div>`).join("")}</div>` : `<p class="muted">Noch keine Einkäufe.</p>`}
    </div>
  </div>`;
}

/* ---------- Einkauf ---------- */
function viewEinkauf() {
  const q = ui.q.einkauf.toLowerCase();
  const list = db.einkaeufe.map((e) => ({ e, t: teilById(e.teil), c: C.ek[e.id] }))
    .filter(({ e, t }) => !q || [t?.name, e.laden, e.notiz].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (b.e.datum || "").localeCompare(a.e.datum || "") || b.c.idx - a.c.idx);
  let lastM = "";
  const rows = list.map(({ e, t, c }) => {
    const m = e.datum ? new Date(e.datum).toLocaleDateString("de-DE", { month: "long", year: "numeric" }) : "Ohne Datum";
    const h = m !== lastM ? `<div class="group-h">${esc(m)}</div>` : ""; lastM = m;
    return h + `<button class="item" data-act="einkauf" data-id="${e.id}">${thumb(t?.foto, t?.name)}
      <span class="main"><span class="t">${esc(t?.name || "Unbekanntes Teil")}</span>
      <span class="s">${fDate(e.datum)} · ${nf(e.menge)} ${esc(e.einheit || t?.basis || "")} · ${esc(e.laden || "")}</span></span>
      <span class="r"><span class="big">${eur(e.preis)}</span><br><span class="sub">${c.warn ? `<span class="badge warn">${c.warn}</span>` : eur4(c.preisBasis) + " / " + esc(t?.basis || "")}</span></span></button>`;
  }).join("");
  return `<div class="toolbar"><input type="search" placeholder="Suchen (Teil, Laden, Notiz)" value="${esc(ui.q.einkauf)}" data-q="einkauf"></div>
    ${rows ? `<div class="list">${rows}</div>` : `<div class="empty"><b>Noch keine Einkäufe</b>Mit dem Plus-Knopf den ersten Kauf erfassen.</div>`}
    <button class="fab" data-act="einkauf-neu" aria-label="Einkauf erfassen">+</button>`;
}

/* ---------- Teile ---------- */
function viewTeile() {
  const q = ui.q.teile.toLowerCase();
  const list = db.teile.filter((t) => (!q || (t.name + " " + t.id + " " + (t.notiz || "")).toLowerCase().includes(q)) && (!ui.kat || t.kategorie === ui.kat));
  const groups = {};
  list.forEach((t) => (groups[t.kategorie || "Ohne Kategorie"] ||= []).push(t));
  const html = Object.keys(groups).sort((a, b) => a.localeCompare(b, "de")).map((g) => `<div class="group-h">${esc(g)}</div>` +
    groups[g].sort((a, b) => a.name.localeCompare(b.name, "de")).map((t) => {
      const c = C.teil[t.id];
      const badge = !c.anzahl ? `<span class="badge warn">kein Einkauf</span>` :
        c.aenderung ? `<span class="badge ${c.aenderung > 0 ? "up" : "down"}">${c.aenderung > 0 ? "+" : ""}${pct(c.aenderung, 1)}</span>` : "";
      return `<button class="item" data-act="teil" data-id="${t.id}">${thumb(t.foto, t.name)}
        <span class="main"><span class="t">${esc(t.name)}</span><span class="s">${t.id} · ${esc(t.basis)}${t.verschnitt ? " · Verschnitt " + pct(t.verschnitt) : ""}</span></span>
        <span class="r"><span class="big">${eur4(c.preis)}</span><span class="sub"> / ${esc(t.basis)}</span><br>${badge}</span></button>`;
    }).join("")).join("");
  return `<div class="toolbar"><input type="search" placeholder="Teil suchen" value="${esc(ui.q.teile)}" data-q="teile">
    <select data-filter="kat"><option value="">Alle Kategorien</option>${db.lists.kategorien.map((k) => `<option ${k === ui.kat ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></div>
    ${html ? `<div class="list">${html}</div>` : `<div class="empty"><b>Keine Einzelteile</b>Mit dem Plus-Knopf ein Material anlegen.</div>`}
    <button class="fab" data-act="teil-neu" aria-label="Einzelteil anlegen">+</button>`;
}

/* ---------- Produkte ---------- */
function viewProdukte() {
  const q = ui.q.produkte.toLowerCase();
  const list = db.varianten.filter((v) => (!q || varLabel(v).toLowerCase().includes(q)) && (!ui.typ || v.typ === ui.typ));
  const groups = {};
  list.forEach((v) => (groups[v.typ || "Ohne Produkttyp"] ||= []).push(v));
  const html = Object.keys(groups).sort((a, b) => a.localeCompare(b, "de")).map((g) => `<div class="group-h">${esc(g)}</div>` +
    groups[g].map((v) => {
      const c = C.vari[v.id];
      return `<button class="item" data-act="variante" data-id="${v.id}">${thumb(v.foto, v.name)}
        <span class="main"><span class="t">${esc(v.name)}</span>
        <span class="s">${c.warn ? `<span class="badge warn">${c.warn}</span>` : `${v.teile.length} Teile · ${nf(v.minuten || 0)} min`}</span></span>
        <span class="r"><span class="big">${eur(c.hk)}</span><br><span class="sub">Empf. ${eur(c.empf)}</span></span></button>`;
    }).join("")).join("");
  return `<div class="toolbar"><input type="search" placeholder="Variante suchen" value="${esc(ui.q.produkte)}" data-q="produkte">
    <select data-filter="typ"><option value="">Alle Produkttypen</option>${db.lists.produkttypen.map((k) => `<option ${k === ui.typ ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></div>
    ${html ? `<div class="list">${html}</div>` : `<div class="empty"><b>Keine Varianten</b>Mit dem Plus-Knopf ein Produkt anlegen.</div>`}
    <button class="fab" data-act="variante-neu" aria-label="Variante anlegen">+</button>`;
}

/* ---------- Mehr ---------- */
function viewMehr() {
  const s = db.settings;
  const conn = Sync.mode === "drive"
    ? `<p>Verbunden mit Google Drive${Sync.email ? " als <b>" + esc(Sync.email) + "</b>" : ""}.<br><span class="sub">Datei: ${esc(CFG.driveFolder)}/${esc(CFG.driveFile)}</span></p>
       <div class="btns"><button class="btn small" data-act="sync-now">Jetzt speichern / laden</button><button class="btn small ghost" data-act="logout">Abmelden</button></div>`
    : `<p>Die Daten liegen nur in diesem Browser auf diesem Gerät.</p>
       <div class="btns">${CFG.googleClientId ? `<button class="btn small primary" data-act="connect">Mit Google Drive verbinden</button>` : `<span class="sub">Google Drive ist noch nicht eingerichtet (Client-ID in config.js fehlt).</span>`}</div>`;
  return `
  <div class="grid two">
    <div class="card"><h3>Standardwerte</h3>
      <form data-form="settings">
        <div class="row2">
          <label class="f"><span>Stundenlohn €/h</span><input name="lohn" inputmode="decimal" value="${numOut(s.lohn)}"></label>
          <label class="f"><span>Gewinnaufschlag %</span><input name="marge" inputmode="decimal" value="${pctOut(s.marge)}"></label>
          <label class="f"><span>Verpackung € / Stück</span><input name="verpackung" inputmode="decimal" value="${numOut(s.verpackung)}"></label>
          <label class="f"><span>Verkaufsgebühr %</span><input name="gebuehr" inputmode="decimal" value="${pctOut(s.gebuehr)}"></label>
          <label class="f"><span>Gebühr fix € / Verkauf</span><input name="gebFix" inputmode="decimal" value="${numOut(s.gebFix)}"></label>
          <label class="f"><span>Umsatzsteuer %</span><input name="mwst" inputmode="decimal" value="${pctOut(s.mwst)}"></label>
        </div>
        <label class="f"><span>Versandkosten auf den Stückpreis umlegen?</span><select name="versand"><option value="0" ${!s.versand ? "selected" : ""}>Nein</option><option value="1" ${s.versand ? "selected" : ""}>Ja</option></select></label>
        <label class="f"><span>Kleinunternehmer (§ 19 UStG)?</span><select name="ku"><option value="1" ${s.ku ? "selected" : ""}>Ja – alle Preise brutto</option><option value="0" ${!s.ku ? "selected" : ""}>Nein – mit Umsatzsteuer rechnen</option></select></label>
        <p class="sub">Werte bei einer Variante überschreiben diese Standardwerte. Änderungen werden sofort übernommen.</p>
      </form>
    </div>
    <div class="card"><h3>Auswahllisten</h3>
      <div class="list settings-list">
        ${[["kategorien", "Kategorien", "für Einzelteile"], ["produkttypen", "Produkttypen", "für Varianten"], ["laeden", "Läden", "für Einkäufe"], ["einheiten", "Einheiten", "Umrechnung, z. B. 1 m = 100 cm"]]
          .map(([k, l, s2]) => `<button class="item" data-act="liste" data-id="${k}"><span class="main"><span class="t">${l}</span><span class="s">${s2}</span></span><span class="r sub">${db.lists[k].length} ›</span></button>`).join("")}
      </div>
    </div>
    <div class="card"><h3>Speicherort</h3>${conn}</div>
    <div class="card"><h3>Daten</h3>
      <div class="list settings-list">
        <button class="item" data-act="import"><span class="main"><span class="t">Tabelle importieren</span><span class="s">Daten aus der LibreOffice-Tabelle (.ods) übernehmen</span></span></button>
        <button class="item" data-act="export-xlsx"><span class="main"><span class="t">Als Tabelle exportieren</span><span class="s">.xlsx mit allen Daten und Ergebnissen</span></span></button>
        <button class="item" data-act="export-json"><span class="main"><span class="t">Sicherung herunterladen</span><span class="s">JSON-Datei mit allen Daten</span></span></button>
        <button class="item" data-act="import-json"><span class="main"><span class="t">Sicherung einspielen</span><span class="s">JSON-Sicherung laden (ersetzt die aktuellen Daten)</span></span></button>
      </div>
    </div>
  </div>
  <p class="sub mt">Materialkalkulation · Datenstand ${new Date(db.updated).toLocaleString("de-DE")}</p>`;
}

/* =================================================================== Modals */
const stack = [];
function modal({ title, body, foot = "", onMount, wide }) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${wide ? 'style="max-width:820px"' : ""}>
    <div class="modal-h"><h2>${esc(title)}</h2><button class="x" data-close aria-label="Schließen">×</button></div>
    <div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ""}</div>`;
  $("#modals").appendChild(bg); stack.push(bg);
  bg.addEventListener("click", (e) => { if (e.target === bg || e.target.closest("[data-close]")) closeModal(bg); });
  document.body.style.overflow = "hidden";
  onMount && onMount(bg);
  hydratePhotos(bg);
  const first = $("input:not([type=hidden]):not([readonly]), select", $(".modal-b", bg));
  if (first && window.innerWidth > 700) first.focus();
  return bg;
}
function closeModal(bg = stack[stack.length - 1]) {
  if (!bg) return;
  const i = stack.indexOf(bg); if (i >= 0) stack.splice(i, 1);
  bg.remove(); bg.onClose && bg.onClose();
  if (!stack.length) document.body.style.overflow = "";
}
function confirmBox(title, text, okLabel = "OK", danger = false) {
  return new Promise((res) => {
    const m = modal({ title, body: `<p>${text}</p>`, foot: `<button class="btn" data-close>Abbrechen</button><button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(okLabel)}</button>` });
    m.onClose = () => res(false);
    $("[data-ok]", m).onclick = () => { m.onClose = null; closeModal(m); res(true); };
  });
}
/* Auswahl-Liste mit Suche (für Einzelteile / Varianten) */
function picker({ title, items, allowNew }) {
  return new Promise((res) => {
    const m = modal({
      title, body: `<div class="toolbar"><input type="search" placeholder="Suchen" data-pq></div>
        ${allowNew ? `<button class="btn small" data-new style="margin-bottom:10px">+ ${esc(allowNew)}</button>` : ""}<div class="pick-list"></div>`
    });
    m.onClose = () => res(null);
    const listEl = $(".pick-list", m);
    const draw = (q) => {
      q = q.toLowerCase(); let last = "";
      listEl.innerHTML = items.filter((i) => !q || (i.label + " " + (i.sub || "") + " " + (i.group || "")).toLowerCase().includes(q)).map((i) => {
        const h = i.group && i.group !== last ? `<div class="group-h">${esc(i.group)}</div>` : ""; last = i.group || last;
        return h + `<button data-v="${esc(i.value)}">${thumb(i.photo, i.label)}<span><b>${esc(i.label)}</b>${i.sub ? `<br><span class="sub">${esc(i.sub)}</span>` : ""}</span></button>`;
      }).join("") || `<p class="muted">Nichts gefunden.</p>`;
      hydratePhotos(listEl);
    };
    draw("");
    $("[data-pq]", m).addEventListener("input", (e) => draw(e.target.value));
    listEl.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) { m.onClose = null; closeModal(m); res(b.dataset.v); } });
    if (allowNew) $("[data-new]", m).onclick = () => { m.onClose = null; closeModal(m); res("__new__"); };
    setTimeout(() => window.innerWidth > 700 && $("[data-pq]", m).focus(), 50);
  });
}
const teilItems = () => db.teile.slice().sort((a, b) => (a.kategorie || "").localeCompare(b.kategorie || "", "de") || a.name.localeCompare(b.name, "de"))
  .map((t) => ({ value: t.id, label: t.name, sub: `${t.id} · ${eur4(C.teil[t.id].preis)} / ${t.basis}`, group: t.kategorie || "Ohne Kategorie", photo: t.foto }));
async function pickTeil() {
  const v = await picker({ title: "Einzelteil wählen", items: teilItems(), allowNew: "Neues Einzelteil anlegen" });
  if (v === "__new__") return editTeil(null, true);
  return v;
}

function readForm(form) {
  const o = {}; new FormData(form).forEach((v, k) => (o[k] = typeof v === "string" ? v.trim() : v)); return o;
}
function addToList(key, val) {
  if (val && !db.lists[key].some((x) => x.toLowerCase() === val.toLowerCase())) db.lists[key].push(val);
}
const opts = (arr, sel, empty) => (empty != null ? `<option value="">${esc(empty)}</option>` : "") +
  arr.map((x) => `<option ${x === sel ? "selected" : ""}>${esc(x)}</option>`).join("");
const dl = (id, arr) => `<datalist id="${id}">${arr.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;

/* ---------- Foto-Feld ---------- */
function photoField(cur, hint) {
  return `<div class="photo-box"><div class="ph" data-ph ${cur ? `data-photo="${esc(cur)}"` : ""}>${cur ? "" : "Kein Foto"}</div>
    <div class="btns" style="flex-direction:column;align-items:flex-start">
      <label class="btn small">📷 Foto aufnehmen<input type="file" accept="image/*" capture="environment" hidden data-photo-in></label>
      <label class="btn small">Bild auswählen<input type="file" accept="image/*" hidden data-photo-in></label>
      ${cur ? `<button type="button" class="btn small ghost" data-photo-rm>Foto entfernen</button>` : ""}
      ${hint ? `<span class="sub">${esc(hint)}</span>` : ""}
    </div></div>`;
}
function bindPhoto(m, state) {
  $$("[data-photo-in]", m).forEach((inp) => inp.addEventListener("change", async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      state.newBlob = await resizeImage(f);
      const u = URL.createObjectURL(state.newBlob);
      $("[data-ph]", m).innerHTML = `<img src="${u}" alt="">`;
      state.remove = false;
    } catch (e) { toast(e.message); }
  }));
  const rm = $("[data-photo-rm]", m);
  if (rm) rm.onclick = () => { state.remove = true; state.newBlob = null; $("[data-ph]", m).innerHTML = "Kein Foto"; };
}
async function applyPhoto(obj, state, name) {
  if (state.newBlob) {
    try {
      toast("Foto wird gespeichert …");
      const id = await Sync.putPhoto(state.newBlob, name.replace(/[^\w\-äöüÄÖÜß ]/g, "_") + ".jpg");
      if (obj.foto) Sync.dropPhoto(obj.foto);
      obj.foto = id;
    } catch (e) { toast("Foto konnte nicht gespeichert werden: " + e.message, 4000); }
  } else if (state.remove && obj.foto) { Sync.dropPhoto(obj.foto); delete obj.foto; }
}

/* ---------- Einzelteil ---------- */
function editTeil(id, returnId = false) {
  return new Promise((res) => {
    const isNew = !id;
    const t = isNew ? { id: nextId("T", db.teile), name: "", kategorie: "", basis: "Stück", verschnitt: null, notiz: "" } : clone(teilById(id));
    const c = isNew ? null : C.teil[t.id];
    const ph = {};
    const used = isNew ? [] : db.varianten.filter((v) => v.teile.some((l) => l.teil === t.id));
    const history = c && c.kaeufe.length ? `<h3 class="mt">Einkäufe</h3><table class="t"><tr><th>Datum</th><th>Laden</th><th class="num">Menge</th><th class="num">je ${esc(t.basis)}</th></tr>
      ${c.kaeufe.map((e) => `<tr data-act="einkauf" data-id="${e.id}" style="cursor:pointer"><td>${fDate(e.datum)}</td><td>${esc(e.laden || "")}${e.link ? ` <a href="${esc(e.link)}" target="_blank" rel="noopener">↗</a>` : ""}</td>
        <td class="num">${nf(e.menge)} ${esc(e.einheit || t.basis)}</td><td class="num">${eur4(C.ek[e.id].preisBasis)}</td></tr>`).join("")}</table>
      <p class="sub">Günstigster Preis bisher: <b>${eur4(c.min)}</b> / ${esc(t.basis)}</p>` : "";
    const m = modal({
      title: isNew ? "Neues Einzelteil" : t.name,
      body: `<form data-f>
        ${photoField(t.foto, t.bilddatei && !t.foto ? `Foto aus der Tabelle: ${t.bilddatei}` : "")}
        ${!isNew ? `<div class="calc">Aktueller Preis: <b>${eur4(c.preis)}</b> / ${esc(t.basis)}${c.last ? ` · zuletzt ${fDate(c.last.datum)} bei ${esc(c.last.laden || "–")}` : " · noch kein Einkauf"}</div>` : ""}
        <label class="f"><span>Bezeichnung</span><input name="name" required value="${esc(t.name)}" placeholder="z. B. Silberkette klein"></label>
        <div class="row2">
          <label class="f"><span>Kategorie</span><input name="kategorie" list="dl-kat" value="${esc(t.kategorie)}" placeholder="wählen oder neu">${dl("dl-kat", db.lists.kategorien)}</label>
          <label class="f"><span>Basiseinheit</span><select name="basis">${opts(db.lists.basis, t.basis)}</select><small>In dieser Einheit wird gerechnet</small></label>
        </div>
        <label class="f"><span>Verschnitt %</span><input name="verschnitt" inputmode="decimal" value="${pctOut(t.verschnitt)}" placeholder="leer = kein Verschnitt">
          <small>Nur für Material, das beim Verarbeiten verloren geht (Kette, Schnur, Draht).</small></label>
        <label class="f"><span>Notiz</span><textarea name="notiz">${esc(t.notiz || "")}</textarea></label>
        ${used.length ? `<p class="sub">Verwendet in: ${used.map((v) => esc(varLabel(v))).join(", ")}</p>` : ""}
        ${history}
      </form>`,
      foot: `${!isNew ? `<button class="btn danger" data-del>Löschen</button><button class="btn" data-buy>+ Einkauf</button>` : ""}<span class="spacer"></span>
        <button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>`,
      onMount: (m) => bindPhoto(m, ph)
    });
    m.onClose = () => res(null);
    $("[data-save]", m).onclick = async () => {
      const f = readForm($("[data-f]", m));
      if (!f.name) return toast("Bitte eine Bezeichnung eingeben");
      if (!isNew && f.basis !== t.basis && (c.anzahl || used.length)) {
        if (!await confirmBox("Basiseinheit ändern?", "Für dieses Teil gibt es schon Einkäufe oder Stücklisten. Prüfe danach, ob die Einheiten noch passen.", "Trotzdem ändern")) return;
      }
      Object.assign(t, { name: f.name, kategorie: f.kategorie, basis: f.basis, verschnitt: pctIn(f.verschnitt), notiz: f.notiz });
      addToList("kategorien", f.kategorie);
      await applyPhoto(t, ph, t.name);
      if (isNew) db.teile.push(t); else db.teile[db.teile.findIndex((x) => x.id === t.id)] = t;
      Sync.changed(); m.onClose = null; closeModal(m); render(); res(t.id);
    };
    if (!isNew) {
      $("[data-del]", m).onclick = async () => {
        if (used.length || c.anzahl) return toast(`Wird noch verwendet (${used.length} Varianten, ${c.anzahl} Einkäufe) – erst dort entfernen.`, 4000);
        if (!await confirmBox("Einzelteil löschen?", `„${esc(t.name)}“ wird gelöscht.`, "Löschen", true)) return;
        Sync.dropPhoto(t.foto);
        db.teile = db.teile.filter((x) => x.id !== t.id); Sync.changed(); m.onClose = null; closeModal(m); render(); res(null);
      };
      $("[data-buy]", m).onclick = () => editEinkauf(null, t.id);
    }
  }).then((r) => returnId ? r : undefined);
}

/* ---------- Einkauf ---------- */
function editEinkauf(id, presetTeil) {
  const isNew = !id;
  const e = isNew ? { id: uid(), datum: todayISO(), teil: presetTeil || "", menge: null, einheit: "", preis: null, versand: null, laden: "", link: "", notiz: "" } : clone(db.einkaeufe.find((x) => x.id === id));
  if (isNew && !presetTeil) {
    // Letzte Angaben zum Laden vorschlagen
    const last = db.einkaeufe[db.einkaeufe.length - 1]; if (last) e.laden = last.laden || "";
  }
  const m = modal({
    title: isNew ? "Einkauf erfassen" : "Einkauf bearbeiten",
    body: `<form data-f>
      <label class="f"><span>Einzelteil</span><button type="button" class="pickbtn" data-pick></button></label>
      <div class="row2">
        <label class="f"><span>Menge</span><input name="menge" inputmode="decimal" value="${numOut(e.menge)}" placeholder="z. B. 500"></label>
        <label class="f"><span>Einheit</span><select name="einheit"></select></label>
        <label class="f"><span>Preis gesamt €</span><input name="preis" inputmode="decimal" value="${numOut(e.preis)}" placeholder="z. B. 12,99"></label>
        <label class="f"><span>Versand €</span><input name="versand" inputmode="decimal" value="${numOut(e.versand)}" placeholder="0"></label>
      </div>
      <div class="calc" data-calc></div>
      <div class="row2">
        <label class="f"><span>Datum</span><input type="date" name="datum" value="${esc(e.datum)}"></label>
        <label class="f"><span>Laden</span><input name="laden" list="dl-laden" value="${esc(e.laden)}" placeholder="wählen oder neu">${dl("dl-laden", db.lists.laeden)}</label>
      </div>
      <label class="f"><span>Webseite / Link</span><input name="link" type="url" inputmode="url" value="${esc(e.link)}" placeholder="https://…"></label>
      <label class="f"><span>Notiz</span><input name="notiz" value="${esc(e.notiz)}"></label>
    </form>`,
    foot: `${!isNew ? `<button class="btn danger" data-del>Löschen</button>` : ""}<span class="spacer"></span>
      <button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>`
  });
  const form = $("[data-f]", m);
  const upd = () => {
    const t = teilById(e.teil);
    const pb = $("[data-pick]", m);
    pb.textContent = t ? `${t.name} (${t.basis})` : "Einzelteil wählen …"; pb.classList.toggle("empty", !t);
    const sel = form.einheit; const cur = sel.value || e.einheit || (t ? t.basis : "");
    const u = t ? unitsFor(t.basis).map((x) => x.name) : db.lists.einheiten.map((x) => x.name);
    sel.innerHTML = opts(u, u.includes(cur) ? cur : (t ? t.basis : u[0]));
    const f = readForm(form);
    const bm = t ? toBasis(num(f.menge), f.einheit, t.basis) : null;
    const p = num(f.preis), v = num(f.versand) || 0;
    const steuer = db.settings.ku ? 1 : 1 + db.settings.mwst;
    $("[data-calc]", m).innerHTML = t && bm && p != null
      ? `${nf(num(f.menge))} ${esc(f.einheit)} = ${nf(bm)} ${esc(t.basis)} → <b>${eur4((p + (db.settings.versand ? v : 0)) / bm / steuer)} je ${esc(t.basis)}</b>${!db.settings.versand && v ? ' <span class="sub">(Versand nicht eingerechnet)</span>' : ""}`
      : `<span class="sub">Preis je Einheit wird hier berechnet.</span>`;
  };
  upd();
  form.addEventListener("input", upd); form.addEventListener("change", upd);
  $("[data-pick]", m).onclick = async () => { const v = await pickTeil(); if (v) { e.teil = v; form.einheit.value = ""; upd(); } };
  $("[data-save]", m).onclick = () => {
    const f = readForm(form);
    if (!e.teil) return toast("Bitte ein Einzelteil wählen");
    if (num(f.menge) == null || num(f.preis) == null) return toast("Bitte Menge und Preis eingeben");
    Object.assign(e, { datum: f.datum, menge: num(f.menge), einheit: f.einheit, preis: num(f.preis), versand: num(f.versand), laden: f.laden, link: f.link, notiz: f.notiz });
    addToList("laeden", f.laden);
    if (isNew) db.einkaeufe.push(e); else db.einkaeufe[db.einkaeufe.findIndex((x) => x.id === e.id)] = e;
    Sync.changed(); closeModal(m); render();
    // Offene Teil-Ansicht aktualisieren
    if (stack.length) { const top = stack[stack.length - 1]; closeModal(top); editTeil(e.teil); }
    toast("Einkauf gespeichert");
  };
  if (!isNew) $("[data-del]", m).onclick = async () => {
    if (!await confirmBox("Einkauf löschen?", "Dieser Einkauf wird gelöscht. Der aktuelle Preis richtet sich dann nach dem vorherigen Kauf.", "Löschen", true)) return;
    db.einkaeufe = db.einkaeufe.filter((x) => x.id !== e.id); Sync.changed(); closeModal(m); render();
  };
}

/* ---------- Variante ---------- */
function editVariante(id, copyFrom) {
  const isNew = !id;
  let v;
  if (copyFrom) { v = clone(varById(copyFrom)); v.id = nextId("V", db.varianten); v.name += " (Kopie)"; delete v.foto; v.teile.forEach((l) => (l.id = uid())); }
  else v = isNew ? { id: nextId("V", db.varianten), typ: ui.typ || "", name: "", minuten: null, lohn: null, verpackung: null, gebuehr: null, gebFix: null, marge: null, vk: null, teile: [] } : clone(varById(id));
  const ph = {};
  const s = db.settings;
  const m = modal({
    title: isNew ? (copyFrom ? "Variante kopieren" : "Neue Variante") : varLabel(v), wide: true,
    body: `<form data-f>
      ${photoField(v.foto, v.bilddatei && !v.foto ? `Foto aus der Tabelle: ${v.bilddatei}` : "")}
      <div class="row2">
        <label class="f"><span>Produkttyp</span><input name="typ" list="dl-typ" value="${esc(v.typ)}" placeholder="wählen oder neu">${dl("dl-typ", db.lists.produkttypen)}</label>
        <label class="f"><span>Variante</span><input name="name" value="${esc(v.name)}" placeholder="z. B. Variante 1"></label>
      </div>
      <h3>Stückliste</h3>
      <div data-lines></div>
      <button type="button" class="btn small" data-addline>+ Einzelteil hinzufügen</button>
      <h3 class="mt">Arbeit &amp; Preis</h3>
      <div class="row2">
        <label class="f"><span>Arbeitszeit (Minuten)</span><input name="minuten" inputmode="decimal" value="${numOut(v.minuten)}"></label>
        <label class="f"><span>Tatsächlicher Verkaufspreis €</span><input name="vk" inputmode="decimal" value="${numOut(v.vk)}" placeholder="optional"></label>
      </div>
      <details ${[v.lohn, v.verpackung, v.gebuehr, v.gebFix, v.marge].some((x) => x != null) ? "open" : ""}><summary class="sub" style="cursor:pointer;margin-bottom:10px">Abweichend vom Standard (leer = Standardwert)</summary>
      <div class="row3">
        <label class="f"><span>Stundenlohn €/h</span><input name="lohn" inputmode="decimal" value="${numOut(v.lohn)}" placeholder="${numOut(s.lohn)}"></label>
        <label class="f"><span>Verpackung €</span><input name="verpackung" inputmode="decimal" value="${numOut(v.verpackung)}" placeholder="${numOut(s.verpackung)}"></label>
        <label class="f"><span>Gewinnaufschlag %</span><input name="marge" inputmode="decimal" value="${pctOut(v.marge)}" placeholder="${pctOut(s.marge)}"></label>
        <label class="f"><span>Verkaufsgebühr %</span><input name="gebuehr" inputmode="decimal" value="${pctOut(v.gebuehr)}" placeholder="${pctOut(s.gebuehr)}"></label>
        <label class="f"><span>Gebühr fix €</span><input name="gebFix" inputmode="decimal" value="${numOut(v.gebFix)}" placeholder="${numOut(s.gebFix)}"></label>
      </div></details>
      <div data-result></div>
    </form>`,
    foot: `${!isNew ? `<button class="btn danger" data-del>Löschen</button><button class="btn" data-copy>Kopieren</button>` : ""}<span class="spacer"></span>
      <button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>`,
    onMount: (m) => bindPhoto(m, ph)
  });
  const form = $("[data-f]", m);
  const collect = () => {
    const f = readForm(form);
    Object.assign(v, { typ: f.typ, name: f.name, minuten: num(f.minuten), vk: num(f.vk), lohn: num(f.lohn), verpackung: num(f.verpackung),
      marge: pctIn(f.marge), gebuehr: pctIn(f.gebuehr), gebFix: num(f.gebFix) });
    $$("[data-line]", m).forEach((el) => {
      const l = v.teile.find((x) => x.id === el.dataset.line); if (!l) return;
      l.menge = num($("[name=lm]", el).value); l.einheit = $("[name=le]", el).value;
      l.verschnitt = pctIn($("[name=lv]", el).value);
    });
  };
  // Live-Berechnung mit temporärer Kopie
  const result = () => {
    const keep = db.varianten; const tmp = keep.filter((x) => x.id !== v.id).concat([v]);
    db.varianten = tmp; compute(); const c = C.vari[v.id]; db.varianten = keep; compute();
    $$("[data-line]", m).forEach((el) => {
      const r = c.lines.find((x) => x.l.id === el.dataset.line); if (!r) return;
      $("[data-lf]", el).innerHTML = r.warn ? `<span class="badge warn">${r.warn}</span><span></span>`
        : `<span>${nf(r.bm)} ${esc(r.t.basis)} × ${eur4(r.p)}${r.vs ? ` + ${pct(r.vs)} Verschnitt` : ""}</span><b>${eur(r.ki)}</b>`;
    });
    $("[data-result]", m).innerHTML = `<table class="t mt">
      <tr><td>Material ohne Verschnitt</td><td class="num">${eur(c.ohne)}</td></tr>
      <tr><td>Material inkl. Verschnitt</td><td class="num">${eur(c.inkl)}</td></tr>
      <tr><td>Arbeit (${nf(v.minuten || 0)} min × ${eur(c.lohn)}/h)</td><td class="num">${eur(c.arbeit)}</td></tr>
      <tr><td>Verpackung</td><td class="num">${eur(c.verp)}</td></tr>
      <tr class="sum"><td>Herstellkosten</td><td class="num">${eur(c.hk)}</td></tr>
      <tr class="sum"><td>Preisempfehlung</td><td class="num">${eur(c.empf)}</td></tr>
      ${v.vk != null ? `<tr><td>Gewinn je Stück bei ${eur(v.vk)}</td><td class="num ${c.gewinn < 0 ? "neg" : "pos"}">${eur(c.gewinn)}</td></tr>
      <tr><td>Effektiver Stundenlohn</td><td class="num ${c.effLohn != null && c.effLohn < c.lohn ? "neg" : ""}">${eur(c.effLohn)}</td></tr>` : ""}
      </table>${c.warn ? `<p><span class="badge warn">${c.warn}</span></p>` : ""}`;
  };
  const drawLines = () => {
    $("[data-lines]", m).innerHTML = v.teile.map((l) => {
      const t = teilById(l.teil);
      const u = t ? unitsFor(t.basis).map((x) => x.name) : [];
      return `<div class="line" data-line="${l.id}">
        <div class="lh">${thumb(t?.foto, t?.name)}<button type="button" class="pickbtn" data-lpick>${esc(t ? t.name : "Teil wählen …")}</button><button type="button" class="icon-btn" data-lrm aria-label="Entfernen">×</button></div>
        <div class="lr">
          <input name="lm" inputmode="decimal" placeholder="Menge" value="${numOut(l.menge)}" aria-label="Menge">
          <select name="le" aria-label="Einheit">${opts(u, l.einheit || t?.basis)}</select>
          <input name="lv" inputmode="decimal" placeholder="${t?.verschnitt ? pctOut(t.verschnitt) + " % (Teil)" : "Verschnitt %"}" value="${pctOut(l.verschnitt)}" aria-label="Verschnitt in Prozent">
        </div>
        <div class="lf" data-lf></div></div>`;
    }).join("") || `<p class="sub">Noch keine Teile. Füge die Einzelteile hinzu, die in dieser Variante verbaut werden.</p>`;
    hydratePhotos($("[data-lines]", m));
    result();
  };
  drawLines();
  form.addEventListener("input", () => { collect(); result(); });
  form.addEventListener("change", () => { collect(); result(); });
  $("[data-addline]", m).onclick = async () => {
    collect();
    const tid = await pickTeil(); if (!tid) return;
    const t = teilById(tid);
    v.teile.push({ id: uid(), teil: tid, menge: null, einheit: t.basis, verschnitt: null });
    drawLines();
    const last = $$("[data-line]", m).pop(); last && $("[name=lm]", last).focus();
  };
  $("[data-lines]", m).addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-line]"); if (!el) return;
    const l = v.teile.find((x) => x.id === el.dataset.line);
    if (ev.target.closest("[data-lrm]")) { collect(); v.teile = v.teile.filter((x) => x !== l); drawLines(); }
    if (ev.target.closest("[data-lpick]")) { collect(); const tid = await pickTeil(); if (tid) { l.teil = tid; l.einheit = teilById(tid).basis; drawLines(); } }
  });
  $("[data-save]", m).onclick = async () => {
    collect();
    if (!v.name) return toast("Bitte einen Namen für die Variante eingeben");
    v.teile = v.teile.filter((l) => l.teil);
    addToList("produkttypen", v.typ);
    await applyPhoto(v, ph, varLabel(v));
    if (isNew) db.varianten.push(v); else db.varianten[db.varianten.findIndex((x) => x.id === v.id)] = v;
    Sync.changed(); closeModal(m); render(); toast("Variante gespeichert");
  };
  if (!isNew) {
    $("[data-del]", m).onclick = async () => {
      if (!await confirmBox("Variante löschen?", `„${esc(varLabel(v))}“ mit Stückliste wird gelöscht.`, "Löschen", true)) return;
      Sync.dropPhoto(v.foto);
      db.varianten = db.varianten.filter((x) => x.id !== v.id); Sync.changed(); closeModal(m); render();
    };
    $("[data-copy]", m).onclick = () => { closeModal(m); editVariante(null, v.id); };
  }
}

/* ---------- Listen ---------- */
const LIST_META = { kategorien: ["Kategorien", "teile", "kategorie"], produkttypen: ["Produkttypen", "varianten", "typ"], laeden: ["Läden", "einkaeufe", "laden"] };
function editListe(key) {
  if (key === "einheiten") return editEinheiten();
  const [title, coll, field] = LIST_META[key];
  const m = modal({
    title, body: `<p class="sub">Tippe auf einen Eintrag, um ihn umzubenennen – alle Verwendungen werden mit umbenannt.</p>
      <div class="chips" data-chips></div><div class="add-row"><input placeholder="Neuer Eintrag" data-new><button class="btn primary" data-add>Hinzufügen</button></div>`
  });
  const draw = () => {
    $("[data-chips]", m).innerHTML = db.lists[key].map((x, i) => {
      const n = db[coll].filter((o) => o[field] === x).length;
      return `<span class="chip"><span data-ren="${i}" style="cursor:pointer">${esc(x)} <span class="sub">${n || ""}</span></span><button data-rm="${i}" aria-label="Entfernen">×</button></span>`;
    }).join("") || `<span class="sub">Noch keine Einträge.</span>`;
  };
  draw();
  const add = () => { const inp = $("[data-new]", m); const v = inp.value.trim(); if (!v) return; addToList(key, v); inp.value = ""; Sync.changed(); draw(); };
  $("[data-add]", m).onclick = add;
  $("[data-new]", m).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  $("[data-chips]", m).addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-rm]"), ren = e.target.closest("[data-ren]");
    if (rm) {
      const x = db.lists[key][+rm.dataset.rm];
      const n = db[coll].filter((o) => o[field] === x).length;
      if (n && !await confirmBox("Eintrag entfernen?", `„${esc(x)}“ wird noch ${n}× verwendet. Er verschwindet nur aus der Auswahlliste, die bestehenden Einträge bleiben.`, "Entfernen")) return;
      db.lists[key].splice(+rm.dataset.rm, 1); Sync.changed(); draw(); render();
    }
    if (ren) {
      const i = +ren.dataset.ren, old = db.lists[key][i];
      const neu = prompt("Neuer Name:", old); if (!neu || neu.trim() === old) return;
      db.lists[key][i] = neu.trim();
      db[coll].forEach((o) => { if (o[field] === old) o[field] = neu.trim(); });
      Sync.changed(); draw(); render();
    }
  });
}
function editEinheiten() {
  const rows = clone(db.lists.einheiten);
  const m = modal({
    title: "Einheiten", body: `<p class="sub">Jede Einheit rechnet in eine Basiseinheit um. Beispiel: Rolle → cm, Faktor 1000 heißt 1 Rolle = 1000 cm.</p>
      <table class="t"><tr><th>Einheit</th><th>rechnet in</th><th class="num">Faktor</th><th></th></tr><tbody data-rows></tbody></table>
      <button class="btn small mt" data-add>+ Einheit</button>`,
    foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-save>Speichern</button>`
  });
  const draw = () => {
    $("[data-rows]", m).innerHTML = rows.map((r, i) => `<tr data-i="${i}"><td><input value="${esc(r.name)}" data-k="name"></td>
      <td><select data-k="basis">${opts(db.lists.basis, r.basis)}</select></td>
      <td><input value="${numOut(r.faktor)}" data-k="faktor" inputmode="decimal" style="text-align:right"></td>
      <td><button class="icon-btn" data-rm="${i}">×</button></td></tr>`).join("");
  };
  draw();
  const collect = () => $$("[data-i]", m).forEach((tr) => {
    const r = rows[+tr.dataset.i]; r.name = $("[data-k=name]", tr).value.trim(); r.basis = $("[data-k=basis]", tr).value; r.faktor = num($("[data-k=faktor]", tr).value);
  });
  $("[data-add]", m).onclick = () => { collect(); rows.push({ name: "", basis: "Stück", faktor: 1 }); draw(); };
  $("[data-rows]", m).addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) { collect(); rows.splice(+b.dataset.rm, 1); draw(); } });
  $("[data-save]", m).onclick = () => {
    collect();
    const clean = rows.filter((r) => r.name && r.faktor);
    for (const b of db.lists.basis) if (!clean.some((r) => r.name === b)) clean.unshift({ name: b, basis: b, faktor: 1 });
    db.lists.einheiten = clean; Sync.changed(); closeModal(m); render();
  };
}

/* ---------- Konflikt ---------- */
function conflictDialog() {
  Sync.setStatus("error");
  const m = modal({
    title: "Daten wurden woanders geändert",
    body: `<p>Die Datei in Google Drive wurde inzwischen auf einem anderen Gerät gespeichert.</p>
      <p><b>Andere Version laden:</b> Deine letzten Änderungen hier gehen verloren.<br><b>Meine Version behalten:</b> Die Änderungen vom anderen Gerät werden überschrieben.</p>`,
    foot: `<button class="btn" data-theirs>Andere Version laden</button><button class="btn primary" data-mine>Meine Version behalten</button>`
  });
  $("[data-theirs]", m).onclick = async () => { closeModal(m); db = migrate(await Sync.pull()); Sync.dirty = false; Sync.saveCache(); Sync.setStatus("saved"); render(); };
  $("[data-mine]", m).onclick = () => { closeModal(m); Sync.push(true); };
}

/* =================================================================== Import / Export */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src;
    s.onload = () => (window.XLSX ? res() : rej(new Error("leer")));
    s.onerror = () => { s.remove(); rej(new Error("nicht gefunden")); };
    document.head.appendChild(s);
  });
}
/* Import-Modul: zuerst die mitgelieferte Datei, sonst dieselbe Version aus dem Netz */
async function loadXLSX() {
  if (window.XLSX) return;
  try { await loadScript("lib/xlsx.full.min.js"); }
  catch {
    try { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"); }
    catch { throw new Error("Import-Modul konnte nicht geladen werden (Datei lib/xlsx.full.min.js fehlt und keine Internetverbindung)"); }
  }
}
function pickFile(accept) {
  return new Promise((res) => {
    const i = document.createElement("input"); i.type = "file"; i.accept = accept;
    i.onchange = () => res(i.files[0] || null); i.click();
  });
}
const norm = (s) => String(s ?? "").replace(/-\s*\n\s*/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/* Liest die LibreOffice-Tabelle. Spalten werden über die Überschriften erkannt. */
function parseWorkbook(wb) {
  const out = emptyDB();
  out.lists.kategorien = []; out.lists.produkttypen = []; out.lists.laeden = [];
  const rowsOf = (name) => { const ws = wb.Sheets[name]; return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) : null; };
  const findHeader = (rows, must) => rows.findIndex((r) => must.every((m) => r.some((c) => norm(c) === m)));
  const colMap = (hdr, spec) => {
    const h = hdr.map(norm); const map = {};
    for (const [k, test] of Object.entries(spec)) {
      const i = h.findIndex((x) => typeof test === "string" ? x === test : test(x));
      if (i >= 0) map[k] = i;
    }
    return map;
  };
  const val = (r, map, k) => (map[k] == null ? "" : r[map[k]]);
  const str = (x) => (x == null ? "" : String(x).trim());
  const n = (x) => (x === "" || x == null ? null : typeof x === "number" ? x : num(x));
  const iso = (x) => {
    if (!x) return "";
    if (x instanceof Date) return new Date(x - x.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    if (typeof x === "number") { const d = new Date(Date.UTC(1899, 11, 30) + x * 864e5); return d.toISOString().slice(0, 10); }
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(x); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
  };
  const idOf = (x) => { const m = /^([TV]\d{3,})/.exec(str(x)); return m ? m[1] : ""; };

  // Einstellungen
  const es = rowsOf("Einstellungen");
  if (es) {
    const lab = { "standard-stundenlohn": ["lohn", "n"], "standard-verpackung": ["verpackung", "n"], "standard-verkaufsgebühr": ["gebuehr", "n"],
      "standard-gebühr fix": ["gebFix", "n"], "standard-gewinnaufschlag": ["marge", "n"], "versandkosten einrechnen?": ["versand", "b"],
      "kleinunternehmer (§ 19 ustg)?": ["ku", "b"], "umsatzsteuersatz": ["mwst", "n"] };
    for (const r of es) for (let i = 0; i < r.length - 1; i++) {
      const l = lab[norm(r[i])]; if (!l) continue;
      const v = r[i + 1];
      if (l[1] === "b") out.settings[l[0]] = norm(v) === "ja"; else if (n(v) != null) out.settings[l[0]] = n(v);
    }
  }
  // Auswahllisten (neue Version: eigenes Blatt; ältere: im Blatt Einstellungen)
  for (const sn of ["Auswahllisten", "Einstellungen"]) {
    const rows = rowsOf(sn); if (!rows) continue;
    const hi = findHeader(rows, ["kategorien"]); if (hi < 0) continue;
    const map = colMap(rows[hi], { kat: "kategorien", typ: "produkttypen", laden: "läden", basisL: "basiseinheiten", eName: "einheit",
      eBasis: (x) => x.includes("basiseinheit") && x !== "basiseinheiten", eFak: "faktor" });
    const einh = [];
    for (const r of rows.slice(hi + 1)) {
      const k = str(val(r, map, "kat")), t = str(val(r, map, "typ")), l = str(val(r, map, "laden")), b = str(val(r, map, "basisL"));
      if (k) addTo(out.lists.kategorien, k); if (t) addTo(out.lists.produkttypen, t); if (l) addTo(out.lists.laeden, l);
      if (b) addTo(out.lists.basis, b);
      const en = str(val(r, map, "eName")), eb = str(val(r, map, "eBasis")), ef = n(val(r, map, "eFak"));
      if (en && eb && ef) einh.push({ name: en, basis: eb, faktor: ef });
    }
    if (einh.length) out.lists.einheiten = einh;
    break;
  }
  // Einzelteile
  const ts = rowsOf("Einzelteile");
  if (ts) {
    const hi = findHeader(ts, ["teil-id", "bezeichnung"]);
    const map = colMap(ts[hi], { id: "teil-id", name: "bezeichnung", kat: "kategorie", basis: "basiseinheit", vs: (x) => x.startsWith("verschnitt"),
      bild: (x) => x.startsWith("bilddatei"), notiz: "notiz" });
    for (const r of ts.slice(hi + 1)) {
      const name = str(val(r, map, "name")); if (!name) continue;
      const t = { id: str(val(r, map, "id")) || nextId("T", out.teile), name, kategorie: str(val(r, map, "kat")), basis: str(val(r, map, "basis")) || "Stück",
        verschnitt: n(val(r, map, "vs")), notiz: str(val(r, map, "notiz")) };
      const b = str(val(r, map, "bild")); if (b) t.bilddatei = b;
      if (t.notiz === "Beispiel – kann gelöscht werden") t.notiz = "";
      out.teile.push(t); if (t.kategorie) addTo(out.lists.kategorien, t.kategorie); addTo(out.lists.basis, t.basis);
    }
  }
  // Einkauf
  const ek = rowsOf("Einkauf");
  if (ek) {
    const hi = findHeader(ek, ["datum", "menge"]);
    const map = colMap(ek[hi], { datum: "datum", teil: (x) => x.startsWith("einzelteil"), menge: "menge", einheit: "einheit",
      preis: (x) => x.startsWith("preis gesamt"), versand: (x) => x.startsWith("versand"), laden: "laden", link: (x) => x.startsWith("webseite"), notiz: "notiz" });
    for (const r of ek.slice(hi + 1)) {
      const teil = idOf(val(r, map, "teil")); if (!teil) continue;
      const e = { id: uid(), datum: iso(val(r, map, "datum")), teil, menge: n(val(r, map, "menge")), einheit: str(val(r, map, "einheit")),
        preis: n(val(r, map, "preis")), versand: n(val(r, map, "versand")), laden: str(val(r, map, "laden")), link: str(val(r, map, "link")), notiz: str(val(r, map, "notiz")) };
      if (e.notiz === "Beispiel – kann gelöscht werden") e.notiz = "";
      out.einkaeufe.push(e); if (e.laden) addTo(out.lists.laeden, e.laden);
    }
  }
  // Varianten
  const vs = rowsOf("Varianten");
  if (vs) {
    const hi = findHeader(vs, ["id", "variante"]);
    const map = colMap(vs[hi], { id: "id", typ: "produkttyp", name: "variante", bild: "bilddatei", min: (x) => x.startsWith("arbeitszeit"),
      lohn: (x) => x.startsWith("stundenlohn"), verp: (x) => x.startsWith("verpackung €"), geb: (x) => x.startsWith("verkaufsgebühr"),
      gfix: (x) => x.startsWith("gebühr fix"), marge: (x) => x.startsWith("gewinnaufschlag"), vk: (x) => x.startsWith("tatsächlicher verkaufspreis") });
    for (const r of vs.slice(hi + 1)) {
      const name = str(val(r, map, "name")); if (!name) continue;
      const v = { id: str(val(r, map, "id")) || nextId("V", out.varianten), typ: str(val(r, map, "typ")), name, minuten: n(val(r, map, "min")),
        lohn: n(val(r, map, "lohn")), verpackung: n(val(r, map, "verp")), gebuehr: n(val(r, map, "geb")), gebFix: n(val(r, map, "gfix")),
        marge: n(val(r, map, "marge")), vk: n(val(r, map, "vk")), teile: [] };
      const b = str(val(r, map, "bild")); if (b) v.bilddatei = b;
      out.varianten.push(v); if (v.typ) addTo(out.lists.produkttypen, v.typ);
    }
  }
  // Stückliste
  const sl = rowsOf("Stückliste");
  let lines = 0;
  if (sl) {
    const hi = findHeader(sl, ["menge"]);
    const map = colMap(sl[hi], { v: (x) => x.startsWith("variante"), t: (x) => x.startsWith("einzelteil"), menge: "menge",
      einheit: (x) => x.startsWith("einheit"), vs: (x) => x.startsWith("verschnitt %") });
    for (const r of sl.slice(hi + 1)) {
      const vid = idOf(val(r, map, "v")), tid = idOf(val(r, map, "t")); if (!vid || !tid) continue;
      const v = out.varianten.find((x) => x.id === vid); if (!v) continue;
      v.teile.push({ id: uid(), teil: tid, menge: n(val(r, map, "menge")), einheit: str(val(r, map, "einheit")), verschnitt: n(val(r, map, "vs")) });
      lines++;
    }
  }
  out.varianten.forEach((v) => v.teile.forEach((l) => { const t = out.teile.find((x) => x.id === l.teil); if (t && !l.einheit) l.einheit = t.basis; }));
  out.einkaeufe.forEach((e) => { const t = out.teile.find((x) => x.id === e.teil); if (t && !e.einheit) e.einheit = t.basis; });
  return { data: out, lines };
}
function addTo(arr, v) { if (v && !arr.includes(v)) arr.push(v); }

async function doImport() {
  try {
    const f = await pickFile(".ods,.xlsx,.xls"); if (!f) return;
    toast("Tabelle wird gelesen …");
    await loadXLSX();
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    const { data, lines } = parseWorkbook(wb);
    const photos = data.teile.filter((t) => t.bilddatei).length + data.varianten.filter((v) => v.bilddatei).length;
    const hasData = db.teile.length || db.einkaeufe.length || db.varianten.length;
    const m = modal({
      title: "Tabelle importieren",
      body: `<p>In <b>${esc(f.name)}</b> gefunden:</p>
        <table class="t"><tr><td>Einzelteile</td><td class="num">${data.teile.length}</td></tr><tr><td>Einkäufe</td><td class="num">${data.einkaeufe.length}</td></tr>
        <tr><td>Varianten</td><td class="num">${data.varianten.length}</td></tr><tr><td>Stücklisten-Zeilen</td><td class="num">${lines}</td></tr>
        <tr><td>Einstellungen &amp; Auswahllisten</td><td class="num">✓</td></tr></table>
        ${photos ? `<div class="hint mt">Fotos werden nicht automatisch übernommen. Bei ${photos} Einträgen ist der Dateiname aus der Tabelle vermerkt – dort einfach das Foto neu hinzufügen.</div>` : ""}
        ${hasData ? `<div class="hint">Die aktuellen Daten in der App werden dabei <b>ersetzt</b>.</div>` : ""}`,
      foot: `<button class="btn" data-close>Abbrechen</button><button class="btn primary" data-ok>Übernehmen</button>`
    });
    $("[data-ok]", m).onclick = () => {
      db = migrate(data); Sync.changed(); closeModal(m); go("start"); toast("Tabelle übernommen");
    };
  } catch (e) { console.error(e); toast("Import fehlgeschlagen: " + e.message, 5000); }
}
function download(name, blob) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportXLSX() {
  try {
    await loadXLSX(); compute();
    const wb = XLSX.utils.book_new();
    const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
    add("Einzelteile", [["Teil-ID", "Bezeichnung", "Kategorie", "Basiseinheit", "Verschnitt", "Notiz", "Aktueller Preis je Basiseinheit", "Letzter Kauf", "Laden", "Günstigster Preis", "Anzahl Käufe"],
      ...db.teile.map((t) => { const c = C.teil[t.id]; return [t.id, t.name, t.kategorie, t.basis, t.verschnitt ?? "", t.notiz || "", c.preis ?? "", c.last?.datum || "", c.last?.laden || "", c.min ?? "", c.anzahl]; })]);
    add("Einkauf", [["Datum", "Teil-ID", "Einzelteil", "Menge", "Einheit", "Preis gesamt", "Versand", "Laden", "Link", "Notiz", "Preis je Basiseinheit"],
      ...db.einkaeufe.map((e) => [e.datum, e.teil, teilById(e.teil)?.name || "", e.menge, e.einheit, e.preis, e.versand ?? "", e.laden, e.link, e.notiz, C.ek[e.id].preisBasis ?? ""])]);
    add("Varianten", [["ID", "Produkttyp", "Variante", "Arbeitszeit (min)", "Stundenlohn", "Verpackung", "Verkaufsgebühr", "Gebühr fix", "Gewinnaufschlag", "Tats. Verkaufspreis",
      "Material ohne Verschnitt", "Material inkl. Verschnitt", "Arbeitskosten", "Herstellkosten", "Preisempfehlung", "Gewinn je Stück"],
      ...db.varianten.map((v) => { const c = C.vari[v.id]; return [v.id, v.typ, v.name, v.minuten ?? "", v.lohn ?? "", v.verpackung ?? "", v.gebuehr ?? "", v.gebFix ?? "", v.marge ?? "", v.vk ?? "", c.ohne, c.inkl, c.arbeit, c.hk, c.empf, c.gewinn ?? ""]; })]);
    add("Stückliste", [["Variante-ID", "Variante", "Teil-ID", "Einzelteil", "Menge", "Einheit", "Verschnitt (eigener Wert)", "Kosten inkl. Verschnitt"],
      ...db.varianten.flatMap((v) => C.vari[v.id].lines.map((r) => [v.id, varLabel(v), r.l.teil, r.t?.name || "", r.l.menge, r.l.einheit, r.l.verschnitt ?? "", r.ki ?? ""]))]);
    XLSX.writeFile(wb, `Materialkalkulation_${todayISO()}.xlsx`);
  } catch (e) { toast("Export fehlgeschlagen: " + e.message, 4000); }
}
async function importJSON() {
  const f = await pickFile(".json,application/json"); if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d.teile || !d.varianten) throw new Error("Keine gültige Sicherung");
    if (!await confirmBox("Sicherung einspielen?", `Die aktuellen Daten werden durch die Sicherung vom ${new Date(d.updated).toLocaleString("de-DE")} ersetzt.`, "Einspielen", true)) return;
    db = migrate(d); Sync.changed(); render(); toast("Sicherung eingespielt");
  } catch (e) { toast("Datei konnte nicht gelesen werden: " + e.message, 4000); }
}

/* =================================================================== Start / Willkommen */
function welcome() {
  $("#app").innerHTML = `<div class="welcome">
    <img class="logo" src="icons/icon.svg" alt="">
    <h1>Materialkalkulation</h1>
    <p>Einkäufe erfassen, Materialkosten herunterrechnen und Herstellkosten je Produktvariante berechnen.</p>
    ${CFG.googleClientId ? `<button class="btn primary" data-act="connect">Mit Google Drive verbinden</button>
      <p class="sub">Die Daten werden in deinem Google Drive im Ordner „${esc(CFG.driveFolder)}“ gespeichert und sind so auf Handy und Laptop gleich.</p>` :
      `<div class="hint">Google Drive ist noch nicht eingerichtet (Client-ID in <code>config.js</code> fehlt).</div>`}
    <button class="btn" data-act="local">${CFG.googleClientId ? "Ohne Konto ausprobieren" : "Starten (nur auf diesem Gerät)"}</button>
    <p class="sub">Ohne Konto bleiben die Daten nur in diesem Browser.</p>
  </div>`;
}
function startApp() { renderShell(); render(); }

async function connectDrive() {
  try {
    toast("Verbinde mit Google Drive …", 8000);
    const hadLocal = Sync.mode === "local" && db && (db.teile.length || db.varianten.length || db.einkaeufe.length);
    const st = await Sync.connect(true);
    let useLocal = false;
    if (st === "exists" && hadLocal) {
      useLocal = await confirmBox("Welche Daten verwenden?", "In Google Drive gibt es bereits Daten, und auf diesem Gerät auch. Sollen die Daten <b>von diesem Gerät</b> nach Drive übernommen werden? (Sonst werden die Drive-Daten geladen.)", "Daten von diesem Gerät übernehmen");
    }
    if (st === "exists" && !useLocal) { db = migrate(await Sync.pull()); Sync.dirty = false; }
    else {
      if (!db) db = emptyDB();
      if (st === "missing") await Sync.createFile(db);
      Sync.dirty = true;
    }
    Sync.mode = "drive"; lsSet(LS.mode, "drive"); Sync.saveCache();
    if (Sync.dirty) await Sync.push(true); else Sync.setStatus("saved");
    toast("Mit Google Drive verbunden");
    startApp();
  } catch (e) { console.error(e); toast(e.message || "Verbindung fehlgeschlagen", 5000); }
}

/* =================================================================== Ereignisse */
document.addEventListener("click", async (e) => {
  const tb = e.target.closest("[data-tab]");
  if (tb) { e.preventDefault(); closeAll(); return go(tb.dataset.tab); }
  const a = e.target.closest("[data-act]"); if (!a) return;
  const id = a.dataset.id;
  switch (a.dataset.act) {
    case "connect": return connectDrive();
    case "local": Sync.mode = "local"; lsSet(LS.mode, "local"); db = db || emptyDB(); Sync.saveCache(); return startApp();
    case "einkauf-neu": return editEinkauf(null);
    case "einkauf": return editEinkauf(id);
    case "teil-neu": return editTeil(null);
    case "teil": return editTeil(id);
    case "variante-neu": return editVariante(null);
    case "variante": return editVariante(id);
    case "liste": return editListe(id);
    case "import": return doImport();
    case "export-xlsx": return exportXLSX();
    case "export-json": return download(`Materialkalkulation_Sicherung_${todayISO()}.json`, new Blob([JSON.stringify(db, null, 1)], { type: "application/json" }));
    case "import-json": return importJSON();
    case "pruefen": return showPruefen();
    case "sync": case "sync-now":
      if (Sync.mode !== "drive") return go("mehr");
      if (Sync.status === "auth") { try { await Sync.getToken(true); } catch (err) { return toast(err.message); } }
      if (Sync.dirty) return Sync.push(); return Sync.refresh().then(() => toast("Daten sind aktuell"));
    case "logout":
      if (!await confirmBox("Abmelden?", "Die App wird auf diesem Gerät von Google Drive getrennt. Die Daten in Drive bleiben erhalten.", "Abmelden")) return;
      if (Sync.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(Sync.token, () => {});
      [LS.data, LS.meta, LS.mode, LS.token].forEach(lsDel); location.reload();
  }
});
function closeAll() { while (stack.length) closeModal(); }
document.addEventListener("input", (e) => {
  const q = e.target.dataset?.q;
  if (q) { ui.q[q] = e.target.value; const pos = e.target.selectionStart; render(); const el = $(`[data-q=${q}]`); el.focus(); el.setSelectionRange(pos, pos); }
});
document.addEventListener("change", (e) => {
  const fl = e.target.dataset?.filter;
  if (fl) { ui[fl] = e.target.value; render(); }
  const form = e.target.closest("[data-form=settings]");
  if (form) {
    const f = readForm(form); const s = db.settings;
    const nOr = (v, d) => (num(v) ?? d);
    Object.assign(s, { lohn: nOr(f.lohn, 0), verpackung: nOr(f.verpackung, 0), gebFix: nOr(f.gebFix, 0), marge: pctIn(f.marge) ?? 0,
      gebuehr: pctIn(f.gebuehr) ?? 0, mwst: pctIn(f.mwst) ?? 0.19, versand: f.versand === "1", ku: f.ku === "1" });
    Sync.changed(); compute(); toast("Gespeichert");
  }
});
function showPruefen() {
  const v = db.varianten.filter((x) => C.vari[x.id].warn), t = db.teile.filter((x) => !C.teil[x.id].anzahl);
  const m = modal({
    title: "Zu prüfen",
    body: (v.length ? `<div class="group-h">Varianten</div><div class="list">${v.map((x) => `<button class="item" data-act="variante" data-id="${x.id}"><span class="main"><span class="t">${esc(varLabel(x))}</span></span><span class="badge warn">${C.vari[x.id].warn}</span></button>`).join("")}</div>` : "") +
      (t.length ? `<div class="group-h">Einzelteile ohne Einkauf</div><div class="list">${t.map((x) => `<button class="item" data-act="teil" data-id="${x.id}"><span class="main"><span class="t">${esc(x.name)}</span></span><span class="badge warn">kein Einkauf</span></button>`).join("")}</div>` : "") ||
      `<p>Alles in Ordnung.</p>`
  });
  m.addEventListener("click", (e) => { if (e.target.closest("[data-act]")) closeModal(m); }, true);
}
window.addEventListener("online", () => { if (Sync.mode === "drive") Sync.push(); });
window.addEventListener("offline", () => Sync.mode === "drive" && Sync.setStatus("offline"));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { if (Sync.dirty) Sync.push(); else Sync.refresh(); } });
window.addEventListener("beforeunload", (e) => { if (Sync.mode === "drive" && Sync.dirty) { Sync.push(); } });

/* =================================================================== Init */
(async function init() {
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  const cached = Sync.loadCache();
  db = cached ? migrate(cached) : null;
  if (!Sync.mode) return welcome();
  if (!db) db = emptyDB();
  startApp();
  if (Sync.mode === "drive") {
    if (Sync.dirty) return Sync.push();
    if (!navigator.onLine) return Sync.setStatus("offline");
    try {
      if (!Sync.fileId) { const st = await Sync.connect(false); if (st === "missing") { await Sync.createFile(db); } }
      if (await Sync.checksum() !== Sync.version) { db = migrate(await Sync.pull()); Sync.saveCache(); render(); }
      Sync.setStatus("saved");
    } catch (e) { Sync.setStatus(e.auth ? "auth" : "error"); }
  }
})();
