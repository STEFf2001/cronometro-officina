/* Cronometro officina – Mondo Metalli
 * Web app (PWA) in JavaScript puro. Versione 1.1.0
 *
 * Principi:
 * - il tempo si calcola SEMPRE dai timestamp degli eventi (Date.now()), mai contando i tick;
 * - lo stato del cronometro si salva a ogni evento, così sopravvive a chiusura e riavvio;
 * - durante il cronometro il tempo NON si mostra: compare solo nel Controllo dopo lo Stop;
 * - i dati della misura si compilano a misura finita (Controllo), tranne i provini;
 * - ogni misura salvata va prima nella coda locale e solo dopo si prova a inviarla;
 * - niente che dipenda dall'officina è scritto nel codice: tutto arriva dal Google Sheet.
 */
'use strict';

const VERSIONE = '1.1.0';
const BLOCCO_INVIO = 20;            // misure per chiamata
const RIPROVA_MS = 60 * 1000;       // nuovo tentativo se la coda non è vuota
const TIMEOUT_MS = 30 * 1000;
const LAVORAZIONI_PREDEFINITE = ['Lavoro', 'Attrezzaggio', 'Movimentazione', 'Controllo', 'Attesa'];
const SUGGERIMENTO_SEZIONE = 'Tondi: D + diametro x spessore (D25x1,5)';

// Chiavi di memoria locale
const K = {
  impostazioni: 'co_impostazioni',
  config: 'co_config',
  coda: 'co_coda',
  inviate: 'co_inviate',
  cronometri: 'co_cronometri',
  commesse: 'co_commesse',
  contatori: 'co_contatori',
  ultimi: 'co_ultimi_valori',
  avvisoWake: 'co_avviso_wakelock'
};

// ---------------------------------------------------------------------------
// Memoria locale
// ---------------------------------------------------------------------------

function leggi(chiave, predefinito) {
  try {
    const v = localStorage.getItem(chiave);
    return v === null ? predefinito : JSON.parse(v);
  } catch (e) {
    return predefinito;
  }
}

function scrivi(chiave, valore) {
  try {
    localStorage.setItem(chiave, JSON.stringify(valore));
  } catch (e) {
    alert('Memoria del telefono piena: impossibile salvare. Esporta la coda in CSV e libera spazio.');
    throw e;
  }
}

/** Impostazioni del telefono. Dalla 1.1 gli operatori sono un elenco (scelta multipla). */
function imp() {
  const i = Object.assign({ url: '', token: '', operatori: null, vibrazione: true }, leggi(K.impostazioni, {}));
  if (!Array.isArray(i.operatori)) i.operatori = i.operatore ? [i.operatore] : [];
  return i;
}
const cfg = () => leggi(K.config, null);
const coda = () => leggi(K.coda, []);

// Più cronometri in futuro: oggi se ne usa uno solo (il primo dell'elenco)
const cronometri = () => leggi(K.cronometri, []);
const cronoAttivo = () => cronometri()[0] || null;
function salvaCrono(c) {
  const tutti = cronometri().filter(x => x.id !== c.id);
  tutti.unshift(c);
  scrivi(K.cronometri, tutti);
}
function eliminaCrono(id) {
  scrivi(K.cronometri, cronometri().filter(x => x.id !== id));
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

const $ = sel => document.querySelector(sel);
const esc = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad = n => String(n).padStart(2, '0');
const r1 = x => Math.round(x * 10) / 10;
const numIt = x => r1(x).toFixed(1).replace('.', ',');

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const formatoItalia = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
/** Data/ora in formato AAAA-MM-GG HH:MM:SS, ora italiana. */
function dataOra(ts) {
  const p = {};
  formatoItalia.formatToParts(new Date(ts)).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Tempo leggibile (solo nel Controllo e nella Coda): mm:ss,d oppure h:mm:ss,d. */
function fmtTempo(ms) {
  const decimi = Math.floor(Math.max(0, ms) / 100);
  const s = Math.floor(decimi / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60) + ',' + (decimi % 10);
}
const fmtSec = s => fmtTempo(s * 1000);

function aNumero(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim().replace(',', '.');
  if (s === '') return '';
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : String(v).trim();
}

/** Sezioni: niente spazi, D iniziale maiuscola, "x" minuscola, decimali con la virgola. d25 x 1.5 → D25x1,5 */
function normalizzaSezione(v) {
  let s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '';
  s = s.replace(/\s+/g, '').replace(/[X×*]/g, 'x').replace(/\./g, ',');
  s = s.replace(/^[dDØø⌀]/, 'D');
  return s;
}

function dispositivo() {
  const ua = navigator.userAgent;
  let so = '';
  let m = ua.match(/Android [\d.]+/);
  if (m) so = m[0];
  m = ua.match(/(iPhone|iPad).*?OS ([\d_]+)/);
  if (m) so = `${m[1]} iOS ${m[2].replace(/_/g, '.')}`;
  m = ua.match(/(EdgA|SamsungBrowser|CriOS|FxiOS|Firefox|Chrome)\/(\d+)/);
  let br = m ? `${m[1]} ${m[2]}` : '';
  if (!br && /Safari/.test(ua)) { m = ua.match(/Version\/(\d+)/); br = 'Safari' + (m ? ' ' + m[1] : ''); }
  if (/Windows/.test(ua) && !so) so = 'Windows';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `${so} ${br}${standalone ? ' app' : ''}`.trim() || ua.slice(0, 80);
}

function mediana(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

// Colori delle lavorazioni: fissi per posizione nell'elenco di Impostazioni
const PALETTE = ['#1fae5b', '#f08a24', '#2f81f7', '#c45bd6', '#e0c341', '#26b0b0', '#e05a7a',
  '#8fa84a', '#b07a50', '#6c7ae0', '#e8eef5', '#4fc3f7', '#9e9e2e', '#d48ac0'];
function colore(lav) {
  let i = impFoglio().lavorazioni.indexOf(lav);
  if (i < 0) { i = 0; for (const ch of String(lav)) i = (i * 31 + ch.charCodeAt(0)) >>> 0; }
  return PALETTE[i % PALETTE.length];
}
function testoSu(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#111' : '#fff';
}

// ---------------------------------------------------------------------------
// Feedback al tocco
// ---------------------------------------------------------------------------

function tocco(lungo) {
  if (imp().vibrazione && navigator.vibrate) {
    try { navigator.vibrate(lungo ? [80, 60, 80] : 40); } catch (e) { /* non supportata */ }
  }
  const l = $('#lampo');
  l.classList.remove('via');
  void l.offsetWidth; // riavvia l'animazione
  l.classList.add('via');
}

let timerAvviso = null;
function avviso(testo, ms) {
  const a = $('#avviso');
  a.textContent = testo;
  a.classList.remove('nascosto');
  clearTimeout(timerAvviso);
  timerAvviso = setTimeout(() => a.classList.add('nascosto'), ms || 3500);
}

// ---------------------------------------------------------------------------
// Dialogo (conferme, scelta del motivo di pausa)
// ---------------------------------------------------------------------------

let chiudiDialogoCorrente = null;
/** Mostra un dialogo con pulsanti; risolve con il valore del pulsante premuto. */
function chiedi({ titolo, testo, pulsanti }) {
  return new Promise(risolvi => {
    const box = $('#dialogo-box');
    box.innerHTML = `
      ${titolo ? `<h1>${esc(titolo)}</h1>` : ''}
      ${testo ? `<p>${esc(testo)}</p>` : ''}
      <div class="colonna" style="margin-top:12px">
        ${pulsanti.map((p, i) => `<button class="btn ${p.cls || ''}" data-i="${i}">${esc(p.testo)}</button>`).join('')}
      </div>`;
    $('#dialogo').classList.remove('nascosto');
    const chiudi = valore => {
      $('#dialogo').classList.add('nascosto');
      box.innerHTML = '';
      chiudiDialogoCorrente = null;
      risolvi(valore);
    };
    chiudiDialogoCorrente = chiudi;
    box.querySelectorAll('button[data-i]').forEach(b => {
      b.onclick = () => { tocco(); chiudi(pulsanti[+b.dataset.i].valore); };
    });
  });
}
const conferma = (titolo, testo, si, no) => chiedi({
  titolo, testo,
  pulsanti: [{ testo: si || 'Sì', cls: 'rosso', valore: true }, { testo: no || 'No, torna indietro', valore: false }]
});

// ---------------------------------------------------------------------------
// Configurazione (Catalogo, Provini_da_fare, Impostazioni)
// ---------------------------------------------------------------------------

const catalogo = () => (cfg() ? cfg().catalogo : []);
const operazione = codice => catalogo().find(o => o.codice === codice) || null;
function impFoglio() {
  const i = Object.assign(
    { operatori: [], lavorazioni: null, motiviPausa: ['Altro'], reparti: [], ripetizioniProvino: 3 },
    cfg() ? cfg().impostazioni : {}
  );
  // Configurazione salvata dalla 1.0: la colonna si chiamava "fasi"
  if (!Array.isArray(i.lavorazioni) || !i.lavorazioni.length) i.lavorazioni = (i.fasi && i.fasi.length) ? i.fasi : LAVORAZIONI_PREDEFINITE;
  if (!Array.isArray(i.reparti)) i.reparti = [];
  return i;
}

/** Lavorazioni del cronometro: la prima è la principale, le altre accessorie. */
function lavorazioniDi(meta) {
  if (Array.isArray(meta.lavorazioni) && meta.lavorazioni.length) return meta.lavorazioni;
  return LAVORAZIONI_PREDEFINITE; // cronometri partiti con la 1.0
}
function lavorazioniOperazione(op) {
  return op && Array.isArray(op.lavorazioni) && op.lavorazioni.length ? op.lavorazioni : LAVORAZIONI_PREDEFINITE;
}
const operatoriDi = meta => (Array.isArray(meta.operatori) ? meta.operatori : (meta.operatore ? [meta.operatore] : []));

// ---------------------------------------------------------------------------
// Calcolo del cronometro dagli eventi
// ---------------------------------------------------------------------------
// Eventi: {tipo:'avvio'|'giro'|'pausa'|'ripresa'|'lav'|'stop', t:ms, lav?, motivo?}
// ('fase' al posto di 'lav' nei cronometri partiti con la 1.0: trattati allo stesso modo)

function calcola(c, ora) {
  const principale = lavorazioniDi(c.meta)[0];
  const r = {
    avviato: false, fermato: false, inPausa: false, lav: principale,
    inizio: null, fine: null, netto: 0, pause: 0, lordo: 0,
    giri: [], lavorazioni: {}, motivi: {}, motivoPausa: null
  };
  let tPrec = null;
  let lav = principale;
  let inPausa = false;
  let motivo = null;
  let nettoUltimoGiro = 0;

  const accumula = d => {
    if (!r.avviato || d <= 0) return;
    if (inPausa) {
      r.pause += d;
      r.motivi[motivo] = (r.motivi[motivo] || 0) + d;
    } else {
      r.netto += d;
      r.lavorazioni[lav] = (r.lavorazioni[lav] || 0) + d;
    }
  };

  for (const e of c.eventi) {
    if (tPrec !== null) accumula(e.t - tPrec);
    tPrec = e.t;
    const nuova = e.lav || e.fase;
    switch (e.tipo) {
      case 'avvio': r.avviato = true; r.inizio = e.t; if (nuova) lav = nuova; break;
      case 'giro': r.giri.push(r.netto - nettoUltimoGiro); nettoUltimoGiro = r.netto; break;
      case 'pausa': inPausa = true; motivo = e.motivo || 'Senza motivo'; break;
      case 'ripresa': inPausa = false; if (nuova) lav = nuova; break;
      case 'lav': case 'fase': if (nuova) lav = nuova; break;
      case 'stop': r.fermato = true; r.fine = e.t; break;
    }
    if (r.fermato) break;
  }
  if (r.avviato && !r.fermato && tPrec !== null) accumula(ora - tPrec);

  r.inPausa = inPausa && !r.fermato;
  r.motivoPausa = inPausa ? motivo : null;
  r.lav = lav;
  r.lordo = r.avviato ? (r.fine || ora) - r.inizio : 0;
  return r;
}

const ultimaPausa = c => [...c.eventi].reverse().find(e => e.tipo === 'pausa');

function aggiungiEvento(c, ev) {
  ev.t = ev.t || Date.now();
  c.eventi.push(ev);
  salvaCrono(c);
}

// ---------------------------------------------------------------------------
// Comunicazione con lo script
// ---------------------------------------------------------------------------

async function chiamaScript(params, corpo) {
  const { url, token } = imp();
  if (!url || !token) throw new Error('Indirizzo dello script o token mancanti (vedi Impostazioni)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let risposta;
    if (corpo) {
      // text/plain evita la richiesta preliminare CORS, che Apps Script non gestisce
      risposta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ token }, corpo)),
        signal: ctrl.signal, redirect: 'follow', cache: 'no-store'
      });
    } else {
      const q = new URLSearchParams(Object.assign({ token }, params)).toString();
      risposta = await fetch(url + (url.includes('?') ? '&' : '?') + q, {
        signal: ctrl.signal, redirect: 'follow', cache: 'no-store'
      });
    }
    const testo = await risposta.text();
    let dati;
    try {
      dati = JSON.parse(testo);
    } catch (e) {
      throw new Error('Risposta non valida dallo script: controlla l\'indirizzo /exec e che l\'accesso sia "Chiunque"');
    }
    if (!dati.ok) throw new Error(dati.errore || 'Errore sconosciuto dallo script');
    return dati;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Nessuna risposta dallo script (tempo scaduto)');
    if (e instanceof TypeError) throw new Error('Rete non disponibile o indirizzo errato');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function aggiornaConfig() {
  // Prima si svuota la coda, così il conteggio "Fatte" del foglio è coerente con quello locale
  if (invioInCorso) { try { await invioInCorso; } catch (e) { /* ignora */ } }
  const partenza = Date.now();
  const dati = await chiamaScript({ azione: 'config' });
  const nuova = {
    catalogo: dati.catalogo || [],
    provini: dati.provini || [],
    impostazioni: dati.impostazioni || {},
    scaricataIl: dati.scaricataIl,
    scaricataTs: partenza
  };
  scrivi(K.config, nuova);
  const i = imp();
  const elenco = nuova.impostazioni.operatori || [];
  const validi = i.operatori.filter(o => elenco.includes(o));
  if (!validi.length && elenco.length) validi.push(elenco[0]);
  i.operatori = validi;
  scrivi(K.impostazioni, i);
  return nuova;
}

/** Misure locali (in coda o inviate dopo l'ultimo scaricamento) per un riferimento. */
function misureLocali(tipo, riferimento) {
  const dopo = cfg() ? cfg().scaricataTs : 0;
  const inCoda = coda().filter(m => m.tipo === tipo && m.riferimento === riferimento).length;
  const inviate = leggi(K.inviate, []).filter(m => m.tipo === tipo && m.riferimento === riferimento && m.ts > dopo).length;
  return inCoda + inviate;
}

function statoProvino(p) {
  const richieste = parseInt(p.richieste, 10) || impFoglio().ripetizioniProvino || 3;
  const fatte = (parseInt(p.fatte, 10) || 0) + misureLocali('provino', p.id);
  let testo = 'da fare';
  let cls = '';
  if (fatte >= richieste) { testo = 'fatto'; cls = 'fatto'; }
  else if (fatte > 0) { testo = `in corso ${fatte} di ${richieste}`; cls = 'corso'; }
  return { richieste, fatte, testo, cls };
}

// ---------------------------------------------------------------------------
// Coda e sincronizzazione
// ---------------------------------------------------------------------------

let invioInCorso = null;
let ultimoErrore = '';

function sincronizza() {
  if (invioInCorso) return invioInCorso;
  if (!coda().length) { aggiornaBarra(); return Promise.resolve(); }
  invioInCorso = (async () => {
    await null; // il blocco finally deve girare dopo l'assegnazione di invioInCorso
    try {
      while (coda().length) {
        const blocco = coda().slice(0, BLOCCO_INVIO);
        const dati = await chiamaScript(null, { misure: blocco });
        const accettati = new Set(dati.accettati || []);
        if (!accettati.size) throw new Error('Lo script non ha accettato le misure');
        const ora = Date.now();
        const inviate = leggi(K.inviate, []);
        blocco.filter(m => accettati.has(m.id)).forEach(m => {
          inviate.push({ id: m.id, tipo: m.tipo, riferimento: m.riferimento, ts: ora });
        });
        scrivi(K.inviate, inviate.slice(-2000));
        scrivi(K.coda, coda().filter(m => !accettati.has(m.id)));
      }
      ultimoErrore = '';
    } catch (e) {
      ultimoErrore = e.message;
    } finally {
      invioInCorso = null;
      aggiornaBarra();
      if (vistaCorrente.nome === 'coda' || (vistaCorrente.nome === 'home' && !cronoAttivo())) mostra(vistaCorrente, true);
    }
  })();
  aggiornaBarra();
  return invioInCorso;
}

function aggiornaBarra() {
  const b = $('#btn-sync');
  const n = coda().length;
  b.className = 'barra-sync ' + (n === 0 ? 'ok' : ultimoErrore ? 'errore' : 'attesa');
  if (invioInCorso && n) b.textContent = `⇅ invio ${n}…`;
  else if (n === 0) b.textContent = '✓ tutto inviato';
  else b.textContent = `${ultimoErrore ? '⚠' : '⏳'} ${n} ${n === 1 ? 'misura' : 'misure'} in attesa`;
}

// Stessa logica dello script, per l'esportazione CSV di emergenza (vale anche per misure della 1.0)
function lavorazioniMisura(m) {
  if (m.lavorazioni_s) return m.lavorazioni_s;
  if (m.modalita === 'fasi' && m.fasi_s) return m.fasi_s;
  return null;
}
function colonnaFissa(m, nome) {
  const lav = lavorazioniMisura(m);
  if (!lav) return '';
  if (nome === 'Lavoro' && m.principale && m.lavorazioni_s) return lav[m.principale] || 0;
  return lav[nome] || 0;
}
const COLONNE_CSV = [
  ['ID misura', m => m.id], ['Ricevuto il', () => ''], ['Inizio', m => m.inizio], ['Fine', m => m.fine],
  ['Operatore', m => m.operatore], ['Tipo', m => m.tipo], ['Riferimento', m => m.riferimento],
  ['Ripetizione', m => m.ripetizione], ['Codice operazione', m => m.codice], ['Reparto', m => m.reparto],
  ['Operazione', m => m.operazione], ['Modalità', m => m.modalita], ['Tecnica', m => m.tecnica],
  ['Materiale', m => m.materiale], ['Spessore / sezione', m => m.spessore_sezione], ['Dettaglio', m => m.dettaglio],
  ['Misura', m => m.misura], ['Unità', m => m.unita], ['Quantità', m => m.quantita],
  ['Tempo netto (s)', m => m.netto_s], ['Pause (s)', m => m.pause_s], ['Tempo lordo (s)', m => m.lordo_s],
  ['Attrezzaggio (s)', m => colonnaFissa(m, 'Attrezzaggio')], ['Lavoro (s)', m => colonnaFissa(m, 'Lavoro')],
  ['Movimentazione (s)', m => colonnaFissa(m, 'Movimentazione')], ['Controllo (s)', m => colonnaFissa(m, 'Controllo')],
  ['Attesa (s)', m => colonnaFissa(m, 'Attesa')], ['Giri (s)', m => (m.giri_s || []).map(g => g.toFixed(1)).join(';')],
  ['Altri parametri', m => m.altri_parametri], ['Motivi pause', m => m.motivi_pause], ['Note', m => m.note],
  ['Stato', () => 'valida'], ['Dispositivo', m => m.dispositivo], ['Versione app', m => m.versione],
  ['Persone', m => (m.persone !== undefined ? m.persone : (m.operatore ? String(m.operatore).split('+').length : ''))],
  ['Lavorazioni (dettaglio)', m => { const l = lavorazioniMisura(m); return l ? Object.keys(l).filter(k => l[k] > 0).map(k => `${k}=${Number(l[k]).toFixed(1)}`).join('; ') : ''; }],
  ['Op. ciclo', m => m.op_ciclo || '']
];

function esportaCsv() {
  const righe = coda();
  if (!righe.length) { avviso('La coda è vuota: niente da esportare'); return; }
  const cella = v => {
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v === null || v === undefined ? '' : v);
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const testo = [COLONNE_CSV.map(c => c[0]).join(';')]
    .concat(righe.map(m => COLONNE_CSV.map(c => cella(c[1](m))).join(';')))
    .join('\r\n');
  const blob = new Blob(['﻿' + testo], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cronometro_coda_${dataOra(Date.now()).replace(/[: ]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------------------------------------------------------------------------
// Schermo sempre acceso
// ---------------------------------------------------------------------------

let wakeLock = null;
async function gestisciSchermo() {
  const c = cronoAttivo();
  const serve = !!c && c.stato !== 'controllo' && document.visibilityState === 'visible';
  if (serve && !wakeLock) {
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch (e) { /* rifiutato (batteria scarica, ecc.) */ }
    } else if (!leggi(K.avvisoWake, false)) {
      scrivi(K.avvisoWake, true);
      avviso('Questo browser non tiene lo schermo acceso da solo: allunga lo spegnimento automatico nelle impostazioni del telefono. Il tempo resta comunque giusto.', 8000);
    }
  } else if (!serve && wakeLock) {
    try { await wakeLock.release(); } catch (e) { /* già rilasciato */ }
    wakeLock = null;
  }
}

// ---------------------------------------------------------------------------
// Navigazione
// ---------------------------------------------------------------------------

let vistaCorrente = { nome: 'home', param: null };
const VISTE_CON_CRONO = ['cronometro', 'controllo', 'coda', 'impostazioni'];

function vai(nome, param, sostituisci) {
  const stato = { nome, param: param || null };
  if (sostituisci) history.replaceState(stato, '');
  else history.pushState(stato, '');
  mostra(stato);
}

function mostra(stato, silenzioso) {
  let { nome, param } = stato || { nome: 'home' };
  const i = imp();
  if ((!i.url || !i.token || !cfg()) && nome !== 'impostazioni') nome = 'impostazioni';
  // Con un cronometro aperto, le schermate di scelta portano alla home (che mostra solo quello)
  if (cronoAttivo() && !VISTE_CON_CRONO.includes(nome)) nome = 'home';
  vistaCorrente = { nome, param };
  const vista = $('#vista');
  const scrollPrima = silenzioso ? window.scrollY : 0;
  (VISTE[nome] || VISTE.home)(vista, param);
  window.scrollTo(0, scrollPrima);
  aggiornaBarra();
  gestisciSchermo();
}

window.addEventListener('popstate', e => {
  if (chiudiDialogoCorrente) chiudiDialogoCorrente(undefined);
  mostra(e.state || { nome: 'home' });
});

// Scelta "✎ Altro…" (o la voce "altro" del Catalogo) nei menu: si scrive un valore non previsto
document.addEventListener('change', e => {
  const s = e.target;
  if (s.tagName !== 'SELECT') return;
  if (s.value === '__altro' || s.value.toLowerCase() === 'altro') {
    let v = prompt('Scrivi il valore:');
    if (v && v.trim()) {
      v = v.trim();
      if (s.dataset.ruolo === 'sezione') v = normalizzaSezione(v);
      const o = document.createElement('option');
      o.textContent = v;
      s.insertBefore(o, s.lastElementChild);
      s.value = v;
    } else {
      s.value = s.dataset.prec || '';
    }
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }
  s.dataset.prec = s.value;
});

// ---------------------------------------------------------------------------
// Pezzi di interfaccia
// ---------------------------------------------------------------------------

/** Campo di un parametro: menu se ci sono opzioni A|B|C, tastierino se "#", testo altrimenti. */
function campoParam(id, etichetta, opzioni, valore, extra) {
  const opz = String(opzioni || '').trim();
  const v = valore === null || valore === undefined ? '' : String(valore);
  const x = extra || {};
  const attr = `id="${id}"${x.ruolo ? ` data-ruolo="${x.ruolo}"` : ''}${x.obbligatorio ? ' data-obbligatorio="1"' : ''}`;
  const titolo = `<span>${esc(etichetta)}${x.obbligatorio ? ' <b class="obbl">*</b>' : ''}${x.suggerimento ? `<br><i>${esc(x.suggerimento)}</i>` : ''}</span>`;
  if (opz && opz !== '#') {
    let lista = opz.split('|').map(s => s.trim()).filter(Boolean);
    const haAltro = lista.some(o => o.toLowerCase() === 'altro');
    lista = lista.filter(o => o.toLowerCase() !== 'altro');
    if (v && !lista.includes(v)) lista = [v].concat(lista);
    return `<label class="campo">${titolo}
      <select ${attr} data-prec="${esc(v)}"><option value=""></option>
      ${lista.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="__altro">✎ ${haAltro ? 'altro' : 'Altro…'}</option></select></label>`;
  }
  return `<label class="campo">${titolo}
    <input ${attr} value="${esc(v)}" autocomplete="off"${opz === '#' ? ' inputmode="decimal"' : ''}></label>`;
}
const valore = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

/** Pulsanti a scelta multipla per gli operatori. */
function sceltaOperatori(id, scelti) {
  const elenco = impFoglio().operatori;
  const tutti = elenco.concat(scelti.filter(o => !elenco.includes(o)));
  return `<div class="chips" id="${id}">${tutti.map(o =>
    `<button type="button" class="chip${scelti.includes(o) ? ' scelto' : ''}" data-o="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
}
function leggiOperatori(id) {
  return [...document.querySelectorAll(`#${id} .chip.scelto`)].map(b => b.dataset.o);
}
function attivaChips(id, quandoCambia) {
  document.querySelectorAll(`#${id} .chip`).forEach(b => {
    b.onclick = () => { tocco(); b.classList.toggle('scelto'); if (quandoCambia) quandoCambia(leggiOperatori(id)); };
  });
}

function raggruppa(elenco, chiave) {
  const gruppi = new Map();
  elenco.forEach(x => {
    const k = x[chiave] || 'Altro';
    if (!gruppi.has(k)) gruppi.set(k, []);
    gruppi.get(k).push(x);
  });
  return gruppi;
}

/** Apre un nuovo cronometro. Se avviaSu è una lavorazione, parte subito su quella. */
function nuovoCronometro(meta, avviaSu) {
  if (cronoAttivo()) { avviso('C\'è già un cronometro aperto'); return; }
  const c = {
    id: uuid(), creatoIl: Date.now(), stato: 'pronto', eventi: [],
    meta: Object.assign({ operatori: imp().operatori.slice() }, meta)
  };
  if (avviaSu) { c.eventi.push({ tipo: 'avvio', t: Date.now(), lav: avviaSu }); c.stato = 'in corso'; }
  salvaCrono(c);
  tocco();
  vai('cronometro', null, false);
}

/** Dati comuni di un cronometro partito da un'operazione del Catalogo. */
function metaDaOperazione(op, extra) {
  return Object.assign({
    codice: op.codice, reparto: op.reparto, operazione: op.operazione, modalita: op.modalita || 'singola',
    unita: op.unita || '', lavorazioni: lavorazioniOperazione(op), cosa: op.cosa || '', obiettivo: 0,
    valori: null, note: '', opCiclo: ''
  }, extra);
}

function indicatore(r, conTesto) {
  if (!r.avviato) return `<span class="punto fermo"></span>${conTesto ? ' Da avviare' : ''}`;
  if (r.inPausa) return `<span class="punto fermo"></span>${conTesto ? ' PAUSA' : ''}`;
  return `<span class="punto" style="--c:${colore(r.lav)}"></span>${conTesto ? ' ' + esc(r.lav) : ''}`;
}

// ---------------------------------------------------------------------------
// Viste
// ---------------------------------------------------------------------------

const VISTE = {};

// ---- Home ----
VISTE.home = vista => {
  $('#barra-titolo').textContent = 'Cronometro officina';
  const c = cronoAttivo();
  if (c) {
    const r = calcola(c, Date.now());
    const daControllare = c.stato === 'controllo';
    let stato;
    if (daControllare) stato = 'Misura da controllare e salvare';
    else if (!r.avviato) stato = 'Cronometro pronto, da avviare';
    else if (r.inPausa) stato = `Cronometro in PAUSA – ${r.lav}`;
    else stato = `Cronometro in corso – ${r.lav}`;
    vista.innerHTML = `
      <button class="banner${r.inPausa || !r.avviato || daControllare ? ' fermo' : ''}" id="torna">
        <span class="banner-riga">${daControllare ? '<span class="punto fermo"></span>' : indicatore(r)} ${esc(stato)}</span>
        <span class="banner-titolo">${esc(c.meta.titolo)}</span>
        <span class="banner-torna">${daControllare ? 'Vai al controllo ›' : 'Torna al cronometro ›'}</span>
      </button>`;
    $('#torna').onclick = () => { tocco(); vai(daControllare ? 'controllo' : 'cronometro'); };
    return;
  }
  const n = coda().length;
  vista.innerHTML = `
    <div class="campo"><span class="piccolo">Operatori osservati</span>${sceltaOperatori('h-op', imp().operatori)}</div>
    <div class="colonna">
      <button class="btn blu grande" id="b-provini">Provini</button>
      <button class="btn verde grande" id="b-commessa">Commessa</button>
      <button class="btn" id="b-libera">Misura libera</button>
    </div>
    <div class="spazio"></div>
    <div class="scheda">
      <p>${n === 0 ? '✓ Tutte le misure sono state inviate' : `⏳ ${n} ${n === 1 ? 'misura' : 'misure'} in attesa di invio`}</p>
      ${ultimoErrore && n ? `<p class="piccolo" style="color:#ff8f8f">${esc(ultimoErrore)}</p>` : ''}
      <p class="piccolo">Catalogo aggiornato il ${esc(cfg().scaricataIl || '—')} · ${catalogo().length} operazioni · ${cfg().provini.length} provini</p>
    </div>
    <div class="griglia2">
      <button class="btn" id="b-aggiorna">↻ Aggiorna catalogo</button>
      <button class="btn" id="b-coda">Coda</button>
    </div>
    <div class="spazio"></div>
    <button class="btn" id="b-imp">⚙ Impostazioni</button>
    <p class="piccolo centro">Versione ${VERSIONE}</p>`;
  attivaChips('h-op', scelti => { const x = imp(); x.operatori = scelti; scrivi(K.impostazioni, x); });
  $('#b-provini').onclick = () => { tocco(); vai('provini'); };
  $('#b-commessa').onclick = () => { tocco(); vai('commessa'); };
  $('#b-libera').onclick = () => { tocco(); vai('libera'); };
  $('#b-coda').onclick = () => { tocco(); vai('coda'); };
  $('#b-imp').onclick = () => { tocco(); vai('impostazioni'); };
  $('#b-aggiorna').onclick = async e => {
    tocco();
    e.target.disabled = true;
    e.target.textContent = 'Scarico…';
    try {
      const nuova = await aggiornaConfig();
      avviso(`Catalogo aggiornato: ${nuova.catalogo.length} operazioni, ${nuova.provini.length} provini`);
    } catch (err) {
      avviso('Aggiornamento non riuscito: ' + err.message + '. Resta valida l\'ultima copia.', 6000);
    }
    mostra(vistaCorrente, true);
  };
};

// ---- Elenco provini ----
let soloDaFare = true;
VISTE.provini = vista => {
  $('#barra-titolo').textContent = 'Provini';
  const provini = cfg().provini;
  const gruppi = raggruppa(provini, 'reparto');
  let html = `<div class="interruttore"><input type="checkbox" id="filtro"${soloDaFare ? ' checked' : ''}><label for="filtro">Solo da fare</label></div>`;
  let visibili = 0;
  gruppi.forEach((lista, reparto) => {
    const voci = lista.map(p => ({ p, s: statoProvino(p) })).filter(x => !soloDaFare || x.s.cls !== 'fatto');
    if (!voci.length) return;
    visibili += voci.length;
    html += `<h2>${esc(reparto)}</h2><div class="elenco">` + voci.map(({ p, s }) => `
      <button class="voce" data-id="${esc(p.id)}">
        <span class="id">${esc(p.id)}</span>
        <span class="desc"><b>${esc(p.operazione)}</b><br>${esc([p.tecnica, p.materiale, p.spessore_sezione, p.dettaglio, p.misura && (p.misura + ' ' + p.unita)].filter(Boolean).join(' · '))}</span>
        <span class="etichetta ${s.cls}">${esc(s.testo)}</span>
      </button>`).join('') + '</div>';
  });
  if (!visibili) html += `<p class="centro">${provini.length ? 'Tutti i provini sono fatti 🎉' : 'Nessun provino nel foglio.'}</p>`;
  vista.innerHTML = html;
  $('#filtro').onchange = e => { soloDaFare = e.target.checked; mostra(vistaCorrente, true); };
  vista.querySelectorAll('.voce').forEach(b => { b.onclick = () => { tocco(); vai('provino', b.dataset.id); }; });
};

const CAMPI_PROVINO = [
  ['tecnica', 'Tecnica'], ['materiale', 'Materiale'], ['spessore_sezione', 'Spessore / sezione'],
  ['dettaglio', 'Dettaglio'], ['misura', 'Misura'], ['unita', 'Unità']
];

// ---- Scheda provino ----
VISTE.provino = (vista, id) => {
  const p = cfg().provini.find(x => x.id === id);
  if (!p) { vai('provini', null, true); return; }
  $('#barra-titolo').textContent = `Provino ${p.id}`;
  const op = operazione(p.codice);
  const s = statoProvino(p);
  const qta = parseInt(p.qta, 10) || 1;
  let modalita = op ? op.modalita : 'singola';
  if (qta > 1 && modalita !== 'fasi') modalita = 'serie';
  const lavs = lavorazioniOperazione(op);
  vista.innerHTML = `
    <h1>${esc(p.id)} · ${esc(p.operazione)}</h1>
    <p class="piccolo">${esc(p.reparto)} · ${esc(p.codice)} · modalità <b>${esc(modalita)}</b>${modalita === 'serie' ? ` · obiettivo ${qta} ${esc(p.unita || (op ? op.unita : ''))}` : ''}</p>
    <div class="evidenza"><b>Cosa cronometrare:</b><br>${esc(p.cosa || (op && op.cosa) || '—')}</div>
    <div class="scheda centro"><b style="font-size:24px">Prova ${s.fatte + 1} di ${s.richieste}</b>
      ${s.fatte >= s.richieste ? '<p class="piccolo">Ripetizioni già completate: questa è una prova in più.</p>' : ''}</div>
    <dl class="dati scheda">${CAMPI_PROVINO.map(([k, et]) => `<dt>${et}</dt><dd>${esc(p[k] || '—')}</dd>`).join('')}
      <dt>Q.tà per prova</dt><dd>${qta}</dd><dt>Lavorazioni</dt><dd>${esc(lavs.join(' · '))}</dd></dl>
    <p class="piccolo">Se manca lo scarto giusto, i dati si correggono nel Controllo dopo lo Stop.</p>
    <button class="btn verde grande" id="inizia">Vai al cronometro</button>`;
  $('#inizia').onclick = () => {
    const provino = {};
    CAMPI_PROVINO.forEach(([k]) => { provino[k] = p[k] || ''; });
    provino.qta = qta;
    nuovoCronometro(metaDaOperazione(op || { codice: p.codice, reparto: p.reparto, operazione: p.operazione, modalita }, {
      tipo: 'provino', riferimento: p.id, reparto: p.reparto, operazione: p.operazione, modalita,
      obiettivo: modalita === 'serie' ? qta : 0, unita: p.unita, provino, cosa: p.cosa || (op && op.cosa) || '',
      titolo: `${p.id} · ${p.operazione}`, sottotitolo: `Prova ${s.fatte + 1} di ${s.richieste}`
    }));
  };
};

// ---- Commessa: codice commessa + lavorazione ----
VISTE.commessa = (vista, param) => {
  $('#barra-titolo').textContent = 'Commessa';
  const ultime = leggi(K.commesse, []);
  const rifIniziale = (param && param.riferimento) || '';
  const com = operazione('COM') || catalogo().find(o => o.modalita === 'fasi');
  const altre = catalogo().filter(o => o !== com);
  let html = `
    <label class="campo"><span>Commessa / articolo</span>
      <input id="c-rif" list="c-ultime" autocomplete="off" autocapitalize="characters" value="${esc(rifIniziale)}"></label>
    <datalist id="c-ultime">${ultime.map(u => `<option value="${esc(u)}">`).join('')}</datalist>
    ${ultime.length && !rifIniziale ? `<div class="griglia2">${ultime.slice(0, 4).map(u => `<button class="btn rapido" data-v="${esc(u)}">${esc(u)}</button>`).join('')}</div>` : ''}
    <h2>Lavorazione</h2>
    ${com ? `<button class="btn verde grande scegli" data-c="${esc(com.codice)}">${esc(com.operazione)}<small>${esc(lavorazioniOperazione(com).join(' · '))}</small></button>` : ''}`;
  raggruppa(altre, 'reparto').forEach((lista, reparto) => {
    html += `<h2>${esc(reparto)}</h2><div class="elenco">` + lista.map(o => `
      <button class="voce scegli" data-c="${esc(o.codice)}"><span class="desc"><b>${esc(o.operazione)}</b><br>${esc(o.codice)} · ${esc(o.modalita)}</span></button>`).join('') + '</div>';
  });
  vista.innerHTML = html;
  vista.querySelectorAll('.rapido').forEach(b => { b.onclick = () => { tocco(); $('#c-rif').value = b.dataset.v; }; });
  vista.querySelectorAll('.scegli').forEach(b => {
    b.onclick = () => {
      const rif = valore('c-rif');
      if (!rif) { avviso('Scrivi prima il codice della commessa o dell\'articolo'); $('#c-rif').focus(); window.scrollTo(0, 0); return; }
      const op = operazione(b.dataset.c);
      scrivi(K.commesse, [rif].concat(ultime.filter(u => u !== rif)).slice(0, 10));
      nuovoCronometro(metaDaOperazione(op, {
        tipo: 'commessa', riferimento: rif,
        titolo: `${rif} · ${op.operazione}`, sottotitolo: `Commessa ${rif}`
      }));
    };
  });
};

// ---- Misura libera: si sceglie solo l'operazione ----
VISTE.libera = vista => {
  $('#barra-titolo').textContent = 'Misura libera';
  let html = '<h1>Scegli l\'operazione</h1>';
  raggruppa(catalogo(), 'reparto').forEach((lista, reparto) => {
    html += `<h2>${esc(reparto)}</h2><div class="elenco">` + lista.map(o => `
      <button class="voce" data-c="${esc(o.codice)}"><span class="desc"><b>${esc(o.operazione)}</b><br>${esc(o.codice)} · ${esc(o.modalita)}</span></button>`).join('') + '</div>';
  });
  vista.innerHTML = html;
  vista.querySelectorAll('.voce').forEach(b => {
    b.onclick = () => {
      const op = operazione(b.dataset.c);
      nuovoCronometro(metaDaOperazione(op, { tipo: 'libera', riferimento: op.codice, titolo: op.operazione, sottotitolo: 'Misura libera' }));
    };
  });
};

// ---- Cronometro (senza tempo a schermo) ----
let avvisatoObiettivo = null;

VISTE.cronometro = vista => {
  const c = cronoAttivo();
  if (!c) { vai('home', null, true); return; }
  if (c.stato === 'controllo') { vai('controllo', null, true); return; }
  const m = c.meta;
  $('#barra-titolo').textContent = m.titolo;
  const r = calcola(c, Date.now());
  const lavs = lavorazioniDi(m);
  const principale = lavs[0];
  const accessori = lavs.slice(1);
  const serie = m.modalita === 'serie';
  const attiva = lav => r.avviato && !r.inPausa && r.lav === lav;
  const stileLav = lav => { const col = colore(lav); return `--c:${col};--t:${testoSu(col)}`; };

  const testa = `
    <div class="crono-testa">
      <div class="crono-rif">${esc(m.sottotitolo || '')}${m.sottotitolo ? ' · ' : ''}${esc(operatoriDi(m).join(' + '))}</div>
      ${m.cosa ? `<details class="piccolo"><summary>Cosa cronometrare</summary>${esc(m.cosa)}</details>` : ''}
      <div class="crono-indicatore${r.inPausa ? ' pausa' : ''}">${indicatore(r, true)}${r.inPausa && r.motivoPausa ? `<small>${esc(r.motivoPausa)}</small>` : ''}</div>
    </div>`;

  if (!r.avviato) {
    vista.innerHTML = `${testa}
      <button class="btn verde enorme" id="b-avvia">AVVIA<small>parte su ${esc(principale)}</small></button>
      <div class="spazio"></div>
      <button class="btn contorno-rosso" id="b-annulla">Annulla misura</button>`;
    $('#b-avvia').onclick = () => {
      c.stato = 'in corso';
      aggiungiEvento(c, { tipo: 'avvio', lav: principale });
      tocco();
      mostra(vistaCorrente, true);
    };
  } else {
    const giri = r.giri.length;
    const raggiunto = m.obiettivo && giri >= m.obiettivo;
    vista.innerHTML = `${testa}
      ${serie ? `
        <div class="contatore${raggiunto ? ' raggiunto' : ''}">Pezzi <b>${giri}</b>${m.obiettivo ? ` / ${m.obiettivo}` : ''}</div>
        <button class="btn blu giro" id="b-giro"${r.inPausa ? ' disabled' : ''}>GIRO</button>` : ''}
      <button class="lavorazione principale${attiva(principale) ? ' attiva' : ''}" style="${stileLav(principale)}" data-lav="${esc(principale)}">
        ${attiva(principale) ? '<span class="punto"></span>' : ''}${esc(principale)}</button>
      ${accessori.length ? `<div class="accessori">${accessori.map(a => `
        <button class="lavorazione${attiva(a) ? ' attiva' : ''}" style="${stileLav(a)}" data-lav="${esc(a)}">
          ${attiva(a) ? '<span class="punto"></span>' : ''}${esc(a)}</button>`).join('')}</div>` : ''}
      <div class="spazio"></div>
      <div class="griglia2">
        <button class="btn ${r.inPausa ? 'verde' : 'giallo'} medio" id="b-pausa">${r.inPausa ? 'Riprendi' : 'Pausa'}</button>
        <button class="btn rosso medio" id="b-stop">Stop</button>
      </div>
      <div class="spazio"></div>
      <div class="griglia2">
        ${serie ? `<button class="btn" id="b-annullagiro"${giri ? '' : ' disabled'}>Annulla ultimo giro</button>` : ''}
        <button class="btn contorno-rosso" id="b-annulla">Annulla misura</button>
      </div>`;

    vista.querySelectorAll('.lavorazione').forEach(b => {
      b.onclick = () => {
        const lav = b.dataset.lav;
        const ora = calcola(c, Date.now());
        if (ora.inPausa) aggiungiEvento(c, { tipo: 'ripresa', lav });
        else if (ora.lav !== lav) aggiungiEvento(c, { tipo: 'lav', lav });
        tocco();
        mostra(vistaCorrente, true);
      };
    });
    const bg = $('#b-giro');
    if (bg) bg.onclick = () => {
      const ora = calcola(c, Date.now());
      if (ora.inPausa) return;
      aggiungiEvento(c, { tipo: 'giro' });
      const n = ora.giri.length + 1;
      if (m.obiettivo && n === m.obiettivo && avvisatoObiettivo !== c.id) {
        avvisatoObiettivo = c.id;
        tocco(true);
        avviso(`Obiettivo raggiunto: ${n} di ${m.obiettivo}. Puoi continuare o premere Stop.`, 5000);
      } else tocco();
      mostra(vistaCorrente, true);
    };
    const bag = $('#b-annullagiro');
    if (bag) bag.onclick = () => {
      const i = c.eventi.map(e => e.tipo).lastIndexOf('giro');
      if (i < 0) return;
      c.eventi.splice(i, 1);
      salvaCrono(c);
      if (avvisatoObiettivo === c.id) avvisatoObiettivo = null;
      tocco();
      avviso('Ultimo giro annullato');
      mostra(vistaCorrente, true);
    };
    $('#b-pausa').onclick = () => {
      const ora = calcola(c, Date.now());
      tocco();
      if (ora.inPausa) { aggiungiEvento(c, { tipo: 'ripresa' }); mostra(vistaCorrente, true); return; }
      aggiungiEvento(c, { tipo: 'pausa', motivo: null }); // l'istante è quello del tocco, il motivo si sceglie dopo
      mostra(vistaCorrente, true);
      chiediMotivo(c);
    };
    $('#b-stop').onclick = () => ferma(c);
  }

  $('#b-annulla').onclick = async () => {
    tocco();
    if (await conferma('Annullare la misura?', 'Il tempo registrato andrà perso e non verrà inviato.', 'Sì, annulla misura')) {
      eliminaCrono(c.id);
      vai('home', null, true);
    }
  };

  // Pausa rimasta senza motivo (app chiusa mentre si sceglieva): lo richiede
  const up = ultimaPausa(c);
  if (r.inPausa && up && !up.motivo && !chiudiDialogoCorrente) chiediMotivo(c);
};

async function chiediMotivo(c) {
  const motivi = impFoglio().motiviPausa;
  const scelta = await chiedi({
    titolo: 'Motivo della pausa',
    pulsanti: motivi.map(m => ({ testo: m, valore: m })).concat([{ testo: 'Annulla pausa', cls: 'contorno-rosso', valore: '__annulla' }])
  });
  const attuale = cronoAttivo();
  if (!attuale || attuale.id !== c.id) return;
  const ev = ultimaPausa(attuale);
  if (!ev) return;
  if (scelta === '__annulla') {
    attuale.eventi.splice(attuale.eventi.lastIndexOf(ev), 1);
  } else if (scelta) {
    ev.motivo = scelta;
  } else {
    return; // dialogo chiuso dal tasto indietro: si richiederà
  }
  salvaCrono(attuale);
  if (vistaCorrente.nome === 'cronometro') mostra(vistaCorrente, true);
}

function ferma(c) {
  const ora = calcola(c, Date.now());
  if (!ora.avviato) return;
  aggiungiEvento(c, { tipo: 'stop' });
  c.stato = 'controllo';
  salvaCrono(c);
  tocco(true);
  vai('controllo', null, true);
}

// ---- Controllo dopo lo Stop: tempi + dati della misura ----

/** Ruolo di un parametro del Catalogo verso le colonne del Registro. */
function ruoloParametro(nome) {
  const n = nome.trim().toLowerCase();
  if (n === 'tecnica') return 'tecnica';
  if (n === 'materiale') return 'materiale';
  if (n.startsWith('spessore') || n.startsWith('sezione')) return 'sezione';
  if (n === 'pezzi') return 'quantita';
  if (n.startsWith('reparto')) return 'reparto';
  if (n.startsWith('commessa')) return 'salta'; // è già il Riferimento
  return 'altro';
}

/** Campi da compilare nel Controllo. */
function campiControllo(c, r) {
  const m = c.meta;
  const op = operazione(m.codice);
  const serie = m.modalita === 'serie';
  const campi = [];
  const opzioniDi = nome => {
    const p = op ? op.parametri.find(x => x.nome.toLowerCase() === nome.toLowerCase()) : null;
    return p ? p : null;
  };
  if (m.tipo === 'provino') {
    const pv = m.provino || {
      tecnica: m.tecnica, materiale: m.materiale, spessore_sezione: m.spessore_sezione,
      dettaglio: m.dettaglio, misura: m.misura, unita: m.unita, qta: m.quantita
    };
    CAMPI_PROVINO.forEach(([k, et]) => {
      const ruolo = k === 'spessore_sezione' ? 'sezione' : k;
      const p = opzioniDi(et);
      campi.push({
        chiave: k, nome: et, etichetta: et, ruolo, originale: pv[k] || '', valore: pv[k] || '',
        opzioni: k === 'misura' ? '#' : (p ? p.opzioni : ''), obbligatorio: !!(p && p.obbligatorio),
        suggerimento: ruolo === 'sezione' ? SUGGERIMENTO_SEZIONE : ''
      });
    });
    campi.push({
      chiave: 'quantita', nome: 'Quantità', etichetta: `Quantità${pv.unita ? ' (' + pv.unita + ')' : ''}`, ruolo: 'quantita',
      opzioni: '#', valore: serie && r.giri.length ? r.giri.length : (pv.qta || 1)
    });
    return campi;
  }
  const precedenti = m.valori || leggi(K.ultimi, {})[m.codice] || {};
  const reparti = impFoglio().reparti;
  const parametri = op ? op.parametri : [];
  // In serie il numero di giri va nel parametro "N. …" (es. N. punti: un giro = un punto), altrimenti in Pezzi
  const contaGiri = parametri.find(p => /^n\.\s/i.test(p.nome)) || parametri.find(p => ruoloParametro(p.nome) === 'quantita');
  parametri.forEach((p, i) => {
    const ruolo = ruoloParametro(p.nome);
    if (ruolo === 'salta') return;
    let opzioni = p.opzioni;
    if (ruolo === 'reparto' && reparti.length) opzioni = reparti.join('|'); // reparto solo dall'elenco unico
    let v = precedenti[p.nome] !== undefined ? precedenti[p.nome] : '';
    if (p === contaGiri && serie && r.giri.length) v = r.giri.length;
    campi.push({
      chiave: 'par' + i, nome: p.nome, etichetta: p.nome, ruolo, opzioni, valore: v, obbligatorio: !!p.obbligatorio,
      suggerimento: ruolo === 'sezione' && p.nome.toLowerCase().startsWith('sezione') ? SUGGERIMENTO_SEZIONE : ''
    });
  });
  if (!campi.some(x => x.ruolo === 'quantita')) {
    let v = precedenti['Quantità'] !== undefined ? precedenti['Quantità'] : '';
    if (serie && r.giri.length) v = r.giri.length;
    campi.push({ chiave: 'quantita', nome: 'Quantità', etichetta: `Quantità${m.unita ? ' (' + m.unita + ')' : ''}`, ruolo: 'quantita', opzioni: '#', valore: v });
  }
  return campi;
}

VISTE.controllo = vista => {
  const c = cronoAttivo();
  if (!c) { vai('home', null, true); return; }
  if (c.stato !== 'controllo') { vai('cronometro', null, true); return; }
  const m = c.meta;
  $('#barra-titolo').textContent = 'Controllo misura';
  const r = calcola(c, Date.now());
  const lavs = lavorazioniDi(m);
  const s = secondi(r, lavs);
  const serie = m.modalita === 'serie';
  const campi = campiControllo(c, r);
  const operatori = operatoriDi(m);
  const personeIniziali = m.persone || Math.max(operatori.length, 1);
  const commessa = m.tipo === 'commessa';

  // Giri
  const med = mediana(s.giri);
  const anomalo = g => s.giri.length >= 3 && med > 0 && Math.abs(g - med) > 0.5 * med;
  const nAnomali = s.giri.filter(anomalo).length;
  const mediaGiro = s.giri.length ? s.giri.reduce((a, b) => a + b, 0) / s.giri.length : null;

  vista.innerHTML = `
    <h1>${esc(m.titolo)}</h1>
    <p class="piccolo">${esc(m.sottotitolo || '')} · ${dataOra(r.inizio)}</p>
    <div class="riepilogo">
      <div>Netto<b>${fmtSec(s.netto)}</b></div>
      <div>Pause<b>${fmtSec(s.pause)}</b></div>
      ${serie ? `<div>Giri<b>${s.giri.length}</b></div><div>Media giro<b>${mediaGiro === null ? '—' : numIt(mediaGiro) + ' s'}</b></div>`
              : `<div>Lordo<b>${fmtSec(s.lordo)}</b></div><div>s per unità<b id="k-unita">—</b></div>`}
    </div>
    ${s.motiviTesto ? `<p class="piccolo">Pause: ${esc(s.motiviTesto)}</p>` : ''}
    <div id="k-avvisi"></div>
    <h2>Lavorazioni</h2>
    ${Object.keys(s.lavorazioni).map(l => {
      const perc = s.netto > 0 ? (s.lavorazioni[l] / s.netto) * 100 : 0;
      return `<div class="scheda"><div class="riga"><b><span class="punto fermo" style="background:${colore(l)}"></span> ${esc(l)}</b>
        <span style="text-align:right">${fmtSec(s.lavorazioni[l])} · ${perc.toFixed(0)}%</span></div>
        <div class="barra-perc"><i style="width:${perc.toFixed(1)}%;background:${colore(l)}"></i></div></div>`;
    }).join('') || '<p class="piccolo">—</p>'}
    ${s.giri.length ? `<details${nAnomali ? ' open' : ''}><summary>Giri (${s.giri.length}${nAnomali ? `, ${nAnomali} anomali` : ''})</summary>
      <div class="giri">${s.giri.map((g, i) => `<div class="giro${anomalo(g) ? ' anomalo' : ''}"><span>${i + 1}</span><span>${numIt(g)} s</span></div>`).join('')}</div></details>` : ''}

    <h2>Chi ha lavorato</h2>
    ${sceltaOperatori('k-op', operatori)}
    <label class="campo"><span>Persone</span>
      <select id="k-persone">${[1, 2, 3, 4, 5].map(n => `<option${n === personeIniziali ? ' selected' : ''}>${n}</option>`).join('')}</select></label>

    <h2>Dati della misura</h2>
    ${campi.map(f => campoParam('k-' + f.chiave, f.etichetta, f.opzioni, f.valore, f)).join('')}
    ${commessa ? `<label class="campo"><span>Op. ciclo (facoltativo, es. 010)</span><input id="k-ciclo" inputmode="numeric" value="${esc(m.opCiclo || '')}"></label>` : ''}
    <label class="campo"><span>Note</span><textarea id="k-note">${esc(m.note || '')}</textarea></label>

    <div class="colonna">
      <button class="btn verde grande" id="k-salva">Salva</button>
      ${commessa ? `<button class="btn blu" id="k-lotto">Salva e lotto successivo</button>
                    <button class="btn" id="k-nuova">Salva e nuova lavorazione</button>` : ''}
      <button class="btn contorno-rosso" id="k-scarta">Scarta</button>
    </div>
    <div class="spazio"></div>
    <button class="btn" id="k-riprendi">Stop per errore: riprendi il cronometro</button>`;

  // Persone segue il numero di operatori finché non viene cambiata a mano
  let personeAMano = !!m.persone;
  $('#k-persone').onchange = () => { personeAMano = true; };
  attivaChips('k-op', scelti => { if (!personeAMano && scelti.length) $('#k-persone').value = String(Math.min(scelti.length, 5)); });

  const quantita = () => aNumero(valore('k-quantita') || valore(`k-${(campi.find(f => f.ruolo === 'quantita') || {}).chiave}`));
  const aggiorna = () => {
    const q = quantita();
    const u = $('#k-unita');
    if (u) u.textContent = typeof q === 'number' && q > 0 ? numIt(s.netto / q) : '—';
    const avvisi = [];
    if (serie && !s.giri.length) avvisi.push('Nessun giro registrato: tempo medio = netto ÷ quantità' + (typeof q === 'number' && q > 0 ? ` = ${numIt(s.netto / q)} s` : ''));
    if (serie && m.tipo === 'libera' && typeof q === 'number' && q < 5) avvisi.push('Meno di 5 pezzi: vale come indicazione, non come tempo standard');
    $('#k-avvisi').innerHTML = avvisi.map(a => `<div class="evidenza">${esc(a)}</div>`).join('');
  };
  vista.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', () => { aggiorna(); el.classList.remove('mancante'); });
    el.addEventListener('change', () => { aggiorna(); el.classList.remove('mancante'); });
  });
  // Evidenzia i campi dei provini cambiati rispetto al foglio
  campi.filter(f => f.originale !== undefined).forEach(f => {
    const el = document.getElementById('k-' + f.chiave);
    const segna = () => el.classList.toggle('modificato', el.value.trim() !== String(f.originale).trim());
    el.addEventListener('input', segna);
    el.addEventListener('change', segna);
  });
  aggiorna();

  const salva = dopo => {
    // Controllo dei campi obbligatori
    const mancanti = campi.filter(f => f.obbligatorio && !valore('k-' + f.chiave));
    const operatoriScelti = leggiOperatori('k-op');
    vista.querySelectorAll('.mancante').forEach(el => el.classList.remove('mancante'));
    mancanti.forEach(f => document.getElementById('k-' + f.chiave).classList.add('mancante'));
    if (!operatoriScelti.length) $('#k-op').classList.add('mancante');
    if (mancanti.length || !operatoriScelti.length) {
      tocco(true);
      avviso(mancanti.length ? `Manca: ${mancanti.map(f => f.nome).join(', ')}` : 'Scegli almeno un operatore');
      (document.querySelector('.mancante') || vista).scrollIntoView({ block: 'center' });
      return;
    }
    tocco();
    const valori = {};
    campi.forEach(f => { valori[f.nome] = f.ruolo === 'sezione' ? normalizzaSezione(valore('k-' + f.chiave)) : valore('k-' + f.chiave); });
    const persone = parseInt($('#k-persone').value, 10) || operatoriScelti.length;
    const opCiclo = valore('k-ciclo');
    const misura = costruisciMisura(c, r, s, campi, valori, {
      operatori: operatoriScelti, persone, opCiclo, note: valore('k-note')
    });
    const q = coda();
    if (!q.some(x => x.id === misura.id)) q.push(misura);
    scrivi(K.coda, q);
    // Valori proposti per la prossima misura dello stesso codice
    if (m.tipo !== 'provino') {
      const ultimi = leggi(K.ultimi, {});
      ultimi[m.codice] = valori;
      scrivi(K.ultimi, ultimi);
    }
    const i = imp();
    i.operatori = operatoriScelti;
    scrivi(K.impostazioni, i);
    eliminaCrono(c.id);
    avviso(`Misura salvata (${misura.riferimento}, ripetizione ${misura.ripetizione})`);
    sincronizza();

    if (dopo === 'lotto') {
      // Stessa commessa e lavorazione, dati copiati, cronometro già partito su Attrezzaggio (o sulla principale)
      const meta = Object.assign({}, m, {
        valori, operatori: operatoriScelti, persone: personeAMano ? persone : 0, opCiclo, note: '',
        sottotitolo: `Commessa ${m.riferimento} · lotto successivo`
      });
      nuovoCronometro(meta, lavs.includes('Attrezzaggio') ? 'Attrezzaggio' : lavs[0]);
      history.replaceState({ nome: 'cronometro', param: null }, '');
    } else if (dopo === 'nuova') {
      vai('commessa', { riferimento: m.riferimento }, true);
    } else if (m.tipo === 'provino') {
      vai('provino', m.riferimento, true);
    } else {
      vai('home', null, true);
    }
  };
  $('#k-salva').onclick = () => salva();
  if (commessa) {
    $('#k-lotto').onclick = () => salva('lotto');
    $('#k-nuova').onclick = () => salva('nuova');
  }
  $('#k-scarta').onclick = async () => {
    tocco();
    if (await conferma('Scartare la misura?', 'Non verrà salvata né inviata.', 'Sì, scarta')) {
      eliminaCrono(c.id);
      vai('home', null, true);
    }
  };
  $('#k-riprendi').onclick = () => {
    // Il tempo passato sulla schermata di controllo diventa una pausa
    tocco();
    const stop = c.eventi.pop();
    c.eventi.push({ tipo: 'pausa', t: stop.t, motivo: 'Stop annullato' });
    c.eventi.push({ tipo: 'ripresa', t: Date.now() });
    c.stato = 'in corso';
    salvaCrono(c);
    vai('cronometro', null, true);
  };
};

/** Secondi con un decimale, coerenti: netto = lordo − pause, somma lavorazioni = netto. */
function secondi(r, lavs) {
  const lordo = r1(r.lordo / 1000);
  const pause = r1(r.pause / 1000);
  const netto = r1(lordo - pause);
  // Ordine: lavorazioni del cronometro, poi eventuali altre; solo quelle usate
  const ordine = lavs.concat(Object.keys(r.lavorazioni).filter(k => !lavs.includes(k)));
  const lavorazioni = {};
  ordine.forEach(l => { if (r.lavorazioni[l] > 0) lavorazioni[l] = r1(r.lavorazioni[l] / 1000); });
  const somma = r1(Object.values(lavorazioni).reduce((a, b) => a + b, 0));
  const diff = r1(netto - somma);
  if (diff !== 0 && somma > 0) {
    const maggiore = Object.keys(lavorazioni).reduce((a, b) => (lavorazioni[b] > lavorazioni[a] ? b : a));
    lavorazioni[maggiore] = r1(lavorazioni[maggiore] + diff);
  }
  const motivi = {};
  Object.keys(r.motivi).forEach(k => { motivi[k] = r1(r.motivi[k] / 1000); });
  const motiviTesto = Object.keys(motivi).map(k => `${k}=${motivi[k].toFixed(1)}`).join('; ');
  return { lordo, pause, netto, lavorazioni, motivi, motiviTesto, giri: r.giri.map(g => r1(g / 1000)) };
}

function prossimaRipetizione(meta) {
  if (meta.tipo === 'provino') {
    const p = (cfg().provini || []).find(x => x.id === meta.riferimento);
    return (p ? parseInt(p.fatte, 10) || 0 : 0) + misureLocali('provino', meta.riferimento) + 1;
  }
  const cont = leggi(K.contatori, {});
  return (cont[meta.tipo + '|' + meta.riferimento] || 0) + 1;
}

function costruisciMisura(c, r, s, campi, valori, extra) {
  const m = c.meta;
  const ripetizione = prossimaRipetizione(m);
  if (m.tipo !== 'provino') {
    const cont = leggi(K.contatori, {});
    cont[m.tipo + '|' + m.riferimento] = ripetizione;
    scrivi(K.contatori, cont);
  }
  // Mappatura verso le colonne del Registro
  const col = { tecnica: '', materiale: '', spessore_sezione: '', dettaglio: '', misura: '', unita: m.unita || '', quantita: '', reparto: m.reparto || '' };
  const altri = [];
  const modifiche = [];
  campi.forEach(f => {
    const v = valori[f.nome];
    if (f.originale !== undefined) { // provini: confronto con il foglio
      const orig = f.ruolo === 'sezione' ? normalizzaSezione(f.originale) : String(f.originale).trim();
      if (v !== orig) modifiche.push(`${f.nome} ${orig || '(vuoto)'}→${v || '(vuoto)'}`);
    }
    switch (f.ruolo) {
      case 'tecnica': if (!col.tecnica) { col.tecnica = v; return; } break;
      case 'materiale': if (!col.materiale) { col.materiale = v; return; } break;
      case 'sezione': if (!col.spessore_sezione) { col.spessore_sezione = v; return; } break;
      case 'quantita': if (col.quantita === '') { col.quantita = aNumero(v); return; } break;
      case 'reparto': if (v) { col.reparto = v; return; } return;
      case 'dettaglio': col.dettaglio = v; return;
      case 'misura': col.misura = aNumero(v); return;
      case 'unita': col.unita = v; return;
    }
    if (v) altri.push(`${f.nome}=${v}`);
  });
  const note = [];
  if (modifiche.length) note.push('Parametri modificati: ' + modifiche.join(', '));
  if (m.modalita === 'serie' && !s.giri.length) note.push('senza giri');
  if (extra.note) note.push(extra.note);
  const lavs = lavorazioniDi(m);
  return {
    id: c.id,
    inizio: dataOra(r.inizio),
    fine: dataOra(r.fine),
    operatore: extra.operatori.join(' + '),
    persone: extra.persone,
    tipo: m.tipo,
    riferimento: m.riferimento,
    ripetizione,
    codice: m.codice,
    reparto: col.reparto,
    operazione: m.operazione,
    modalita: m.modalita,
    tecnica: col.tecnica,
    materiale: col.materiale,
    spessore_sezione: col.spessore_sezione,
    dettaglio: col.dettaglio,
    misura: col.misura,
    unita: col.unita,
    quantita: col.quantita,
    netto_s: s.netto,
    pause_s: s.pause,
    lordo_s: s.lordo,
    principale: lavs[0],
    lavorazioni_s: s.lavorazioni,
    giri_s: m.modalita === 'serie' ? s.giri : [],
    altri_parametri: altri.join('; '),
    motivi_pause: s.motiviTesto,
    note: note.join(' · '),
    op_ciclo: extra.opCiclo || '',
    dispositivo: dispositivo(),
    versione: VERSIONE
  };
}

// ---- Coda ----
VISTE.coda = vista => {
  $('#barra-titolo').textContent = 'Coda di invio';
  const q = coda();
  vista.innerHTML = `
    <h1>${q.length ? `${q.length} ${q.length === 1 ? 'misura' : 'misure'} in attesa` : 'Coda vuota: tutto inviato'}</h1>
    ${ultimoErrore && q.length ? `<div class="evidenza">Ultimo errore: ${esc(ultimoErrore)}</div>` : ''}
    <div class="griglia2">
      <button class="btn blu" id="q-invia"${q.length && !invioInCorso ? '' : ' disabled'}>${invioInCorso ? 'Invio…' : 'Invia ora'}</button>
      <button class="btn" id="q-csv"${q.length ? '' : ' disabled'}>Esporta CSV</button>
    </div>
    <div class="spazio"></div>
    <div class="elenco">${q.slice().reverse().map(m => `
      <div class="voce"><span class="desc"><b>${esc(m.riferimento)} · ${esc(m.operazione)}</b><br>
        ${esc(m.inizio)} · ${esc(m.operatore)} · netto ${fmtSec(m.netto_s)} · rip. ${m.ripetizione}</span></div>`).join('')}
    </div>
    <p class="piccolo">Le misure restano sul telefono finché lo script non conferma di averle scritte. Il CSV è un'uscita di emergenza: le misure esportate restano comunque in coda.</p>`;
  $('#q-invia').onclick = () => { tocco(); sincronizza(); mostra(vistaCorrente, true); };
  $('#q-csv').onclick = () => { tocco(); esportaCsv(); };
};

// ---- Impostazioni (anche primo avvio) ----
VISTE.impostazioni = vista => {
  $('#barra-titolo').textContent = 'Impostazioni';
  const i = imp();
  const primo = !i.url || !i.token || !cfg();
  vista.innerHTML = `
    ${primo ? `<h1>Benvenuto</h1><p>Inserisci l'indirizzo dello script (quello che finisce con <b>/exec</b>) e il token, poi premi <b>Salva e scarica</b>.</p>` : '<h1>Impostazioni</h1>'}
    <label class="campo"><span>Indirizzo dello script (/exec)</span>
      <input id="i-url" value="${esc(i.url)}" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"></label>
    <label class="campo"><span>Token</span>
      <input id="i-token" value="${esc(i.token)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    ${!primo && impFoglio().operatori.length ? `<div class="campo"><span class="piccolo">Operatori predefiniti</span>${sceltaOperatori('i-op', i.operatori)}</div>` : ''}
    <div class="interruttore"><input type="checkbox" id="i-vib"${i.vibrazione ? ' checked' : ''}><label for="i-vib">Vibrazione a ogni tocco</label></div>
    <div class="spazio"></div>
    <button class="btn verde grande" id="i-salva">Salva e scarica</button>
    <p id="i-esito" class="centro"></p>
    <p class="piccolo centro">Versione app ${VERSIONE} · ${esc(dispositivo())}</p>`;
  if ($('#i-op')) attivaChips('i-op');
  $('#i-salva').onclick = async () => {
    tocco();
    const nuove = imp();
    nuove.url = valore('i-url');
    nuove.token = valore('i-token');
    if ($('#i-op')) nuove.operatori = leggiOperatori('i-op');
    nuove.vibrazione = $('#i-vib').checked;
    delete nuove.operatore;
    if (!/^https:\/\//.test(nuove.url)) { $('#i-esito').textContent = 'L\'indirizzo deve iniziare con https://'; return; }
    scrivi(K.impostazioni, nuove);
    const b = $('#i-salva');
    b.disabled = true;
    b.textContent = 'Collegamento…';
    try {
      const c = await aggiornaConfig();
      avviso(`Collegato: ${c.catalogo.length} operazioni, ${c.provini.length} provini`, 5000);
      sincronizza();
      vai('home', null, true);
    } catch (e) {
      b.disabled = false;
      b.textContent = 'Salva e scarica';
      $('#i-esito').textContent = '⚠ ' + e.message;
    }
  };
};

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

$('#btn-home').onclick = () => { tocco(); vai('home'); };
$('#btn-sync').onclick = () => { tocco(); vai('coda'); };

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    gestisciSchermo();
    if (vistaCorrente.nome === 'cronometro' || vistaCorrente.nome === 'home') mostra(vistaCorrente, true);
    if (coda().length) sincronizza();
  }
});
window.addEventListener('online', () => sincronizza());
setInterval(() => { if (coda().length && navigator.onLine !== false) sincronizza(); }, RIPROVA_MS);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* senza service worker funziona solo online */ });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

history.replaceState({ nome: 'home' }, '');
mostra({ nome: 'home' });
if (coda().length) sincronizza();
// Aggiorna il catalogo in silenzio all'apertura (se non c'è rete resta l'ultima copia)
if (imp().url && imp().token && cfg() && !cronoAttivo()) {
  aggiornaConfig().then(() => { if (vistaCorrente.nome === 'home') mostra(vistaCorrente, true); }).catch(() => {});
}
