/* Cronometro officina – Mondo Metalli
 * Web app (PWA) in JavaScript puro. Versione 1.0.0
 *
 * Principi:
 * - il tempo si calcola SEMPRE dai timestamp degli eventi (Date.now()), mai contando i tick;
 * - lo stato del cronometro si salva a ogni evento, così sopravvive a chiusura e riavvio;
 * - ogni misura salvata va prima nella coda locale e solo dopo si prova a inviarla.
 */
'use strict';

const VERSIONE = '1.0.0';
const BLOCCO_INVIO = 20;            // misure per chiamata
const RIPROVA_MS = 60 * 1000;       // nuovo tentativo se la coda non è vuota
const TIMEOUT_MS = 30 * 1000;

// Chiavi di memoria locale
const K = {
  impostazioni: 'co_impostazioni',
  config: 'co_config',
  coda: 'co_coda',
  inviate: 'co_inviate',
  cronometri: 'co_cronometri',
  commesse: 'co_commesse',
  contatori: 'co_contatori',
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

const imp = () => Object.assign({ url: '', token: '', operatore: '', vibrazione: true }, leggi(K.impostazioni, {}));
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

/** Tempo per lo schermo: mm:ss,d (oppure h:mm:ss,d oltre l'ora). */
function fmtTempo(ms) {
  const decimi = Math.floor(Math.max(0, ms) / 100);
  const s = Math.floor(decimi / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60) + ',' + (decimi % 10);
}

/** Secondi leggibili: 75,3 s → "1:15,3". */
const fmtSec = s => fmtTempo(s * 1000);

function aNumero(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim().replace(',', '.');
  if (s === '') return '';
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : String(v).trim();
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
// Calcolo del cronometro dagli eventi
// ---------------------------------------------------------------------------
// Eventi: {tipo:'avvio'|'giro'|'pausa'|'ripresa'|'fase'|'stop', t:ms, fase?, motivo?}

function calcola(c, ora) {
  const r = {
    avviato: false, fermato: false, inPausa: false, faseAttiva: null,
    inizio: null, fine: null, netto: 0, pause: 0, lordo: 0,
    giri: [], fasi: {}, motivi: {}, dalGiro: 0, motivoPausa: null
  };
  let tPrec = null;
  let fase = null;
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
      if (fase) r.fasi[fase] = (r.fasi[fase] || 0) + d;
    }
  };

  for (const e of c.eventi) {
    if (tPrec !== null) accumula(e.t - tPrec);
    tPrec = e.t;
    switch (e.tipo) {
      case 'avvio': r.avviato = true; r.inizio = e.t; if (e.fase) fase = e.fase; break;
      case 'giro': r.giri.push(r.netto - nettoUltimoGiro); nettoUltimoGiro = r.netto; break;
      case 'pausa': inPausa = true; motivo = e.motivo || 'Senza motivo'; break;
      case 'ripresa': inPausa = false; if (e.fase) fase = e.fase; break;
      case 'fase': fase = e.fase; break;
      case 'stop': r.fermato = true; r.fine = e.t; break;
    }
    if (r.fermato) break;
  }
  if (r.avviato && !r.fermato && tPrec !== null) accumula(ora - tPrec);

  r.inPausa = inPausa && !r.fermato;
  r.motivoPausa = inPausa ? motivo : null;
  r.faseAttiva = fase;
  r.dalGiro = r.netto - nettoUltimoGiro;
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
// Configurazione (Catalogo, Provini_da_fare, Impostazioni)
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
  if (!i.operatore && nuova.impostazioni.operatori && nuova.impostazioni.operatori.length) {
    i.operatore = nuova.impostazioni.operatori[0];
    scrivi(K.impostazioni, i);
  }
  return nuova;
}

const catalogo = () => (cfg() ? cfg().catalogo : []);
const operazione = codice => catalogo().find(o => o.codice === codice) || null;
const impFoglio = () => Object.assign(
  { operatori: [], fasi: ['Attrezzaggio', 'Lavoro', 'Movimentazione', 'Controllo', 'Attesa'], motiviPausa: ['Altro'], ripetizioniProvino: 3 },
  cfg() ? cfg().impostazioni : {}
);

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

/** Mappa i parametri del Catalogo sulle colonne fisse del Registro. */
function mappaParametri(valori) {
  const out = { tecnica: '', materiale: '', spessore_sezione: '', altri: [] };
  valori.forEach(({ nome, valore }) => {
    const v = String(valore || '').trim();
    const n = nome.trim().toLowerCase();
    if (n === 'tecnica') out.tecnica = v;
    else if (n === 'materiale') out.materiale = v;
    else if (n.startsWith('spessore') || n.startsWith('sezione')) out.spessore_sezione = v;
    else if (v) out.altri.push(`${nome}=${v}`);
  });
  return out;
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
      if (vistaCorrente.nome === 'coda' || vistaCorrente.nome === 'home') mostra(vistaCorrente, true);
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

const COLONNE_CSV = [
  ['ID misura', m => m.id], ['Ricevuto il', () => ''], ['Inizio', m => m.inizio], ['Fine', m => m.fine],
  ['Operatore', m => m.operatore], ['Tipo', m => m.tipo], ['Riferimento', m => m.riferimento],
  ['Ripetizione', m => m.ripetizione], ['Codice operazione', m => m.codice], ['Reparto', m => m.reparto],
  ['Operazione', m => m.operazione], ['Modalità', m => m.modalita], ['Tecnica', m => m.tecnica],
  ['Materiale', m => m.materiale], ['Spessore / sezione', m => m.spessore_sezione], ['Dettaglio', m => m.dettaglio],
  ['Misura', m => m.misura], ['Unità', m => m.unita], ['Quantità', m => m.quantita],
  ['Tempo netto (s)', m => m.netto_s], ['Pause (s)', m => m.pause_s], ['Tempo lordo (s)', m => m.lordo_s],
  ['Attrezzaggio (s)', m => fasiCsv(m, 'Attrezzaggio')], ['Lavoro (s)', m => fasiCsv(m, 'Lavoro')],
  ['Movimentazione (s)', m => fasiCsv(m, 'Movimentazione')], ['Controllo (s)', m => fasiCsv(m, 'Controllo')],
  ['Attesa (s)', m => fasiCsv(m, 'Attesa')], ['Giri (s)', m => (m.giri_s || []).map(g => g.toFixed(1)).join(';')],
  ['Altri parametri', m => m.altri_parametri], ['Motivi pause', m => m.motivi_pause], ['Note', m => m.note],
  ['Stato', () => 'valida'], ['Dispositivo', m => m.dispositivo], ['Versione app', m => m.versione]
];
const fasiCsv = (m, f) => (m.modalita === 'fasi' ? (m.fasi_s || {})[f] || 0 : '');

function esportaCsv() {
  const righe = coda();
  if (!righe.length) { avviso('La coda è vuota: niente da esportare'); return; }
  const cella = v => {
    let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v === null || v === undefined ? '' : v);
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
  if (silenzioso) window.scrollTo(0, scrollPrima); else window.scrollTo(0, 0);
  aggiornaBarra();
  gestisciSchermo();
}

window.addEventListener('popstate', e => {
  if (chiudiDialogoCorrente) chiudiDialogoCorrente(undefined);
  mostra(e.state || { nome: 'home' });
});

// Scelta "✎ Altro…" nei menu: permette di scrivere un valore non previsto
document.addEventListener('change', e => {
  const s = e.target;
  if (s.tagName === 'SELECT' && s.value === '__altro') {
    const v = prompt('Scrivi il valore:');
    if (v && v.trim()) {
      const o = document.createElement('option');
      o.textContent = v.trim();
      s.insertBefore(o, s.lastElementChild);
      s.value = v.trim();
    } else {
      s.value = s.dataset.prec || '';
    }
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (s.tagName === 'SELECT') s.dataset.prec = s.value;
});

// ---------------------------------------------------------------------------
// Pezzi di interfaccia
// ---------------------------------------------------------------------------

function campoParam(id, etichetta, opzioni, valore) {
  const opz = String(opzioni || '').trim();
  const v = valore === null || valore === undefined ? '' : String(valore);
  if (opz && opz !== '#') {
    let lista = opz.split('|').map(s => s.trim()).filter(Boolean);
    if (v && !lista.includes(v)) lista = [v].concat(lista);
    return `<label class="campo"><span>${esc(etichetta)}</span>
      <select id="${id}" data-prec="${esc(v)}"><option value=""></option>
      ${lista.map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="__altro">✎ Altro…</option></select></label>`;
  }
  return `<label class="campo"><span>${esc(etichetta)}</span>
    <input id="${id}" value="${esc(v)}" autocomplete="off"${opz === '#' ? ' inputmode="decimal"' : ''}></label>`;
}
const valore = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

function raggruppa(elenco, chiave) {
  const gruppi = new Map();
  elenco.forEach(x => {
    const k = x[chiave] || 'Altro';
    if (!gruppi.has(k)) gruppi.set(k, []);
    gruppi.get(k).push(x);
  });
  return gruppi;
}

function nuovoCronometro(meta) {
  if (cronoAttivo()) { avviso('C\'è già un cronometro aperto'); return; }
  const c = { id: uuid(), creatoIl: Date.now(), stato: 'pronto', eventi: [], meta: Object.assign({ operatore: imp().operatore }, meta) };
  salvaCrono(c);
  tocco();
  vai('cronometro', null, false);
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
    vista.innerHTML = `
      <div class="scheda centro">
        <p class="piccolo">${daControllare ? 'Misura da controllare e salvare' : r.avviato ? (r.inPausa ? 'Cronometro in pausa' : 'Cronometro in corso') : 'Cronometro pronto (non avviato)'}</p>
        <h1>${esc(c.meta.titolo)}</h1>
        <p>${esc(c.meta.operatore)}</p>
        <div class="crono-tempo" id="home-tempo">${fmtTempo(r.netto)}</div>
      </div>
      <button class="btn verde grande" id="torna">${daControllare ? 'Vai al controllo' : 'Torna al cronometro'}</button>`;
    $('#torna').onclick = () => { tocco(); vai(daControllare ? 'controllo' : 'cronometro'); };
    return;
  }
  const i = imp();
  const operatori = impFoglio().operatori;
  const n = coda().length;
  vista.innerHTML = `
    <label class="campo"><span>Operatore osservato</span>
      <select id="operatore">${operatori.map(o => `<option${o === i.operatore ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>
    </label>
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
  $('#operatore').onchange = e => { const x = imp(); x.operatore = e.target.value; scrivi(K.impostazioni, x); };
  if (!i.operatore && operatori[0]) { i.operatore = operatori[0]; scrivi(K.impostazioni, i); }
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
  const opzioni = nome => {
    const par = op ? op.parametri.find(x => x.nome.toLowerCase().startsWith(nome)) : null;
    return par ? par.opzioni : '';
  };
  const campi = [
    ['tecnica', 'Tecnica', opzioni('tecnica')],
    ['materiale', 'Materiale', opzioni('materiale')],
    ['spessore_sezione', 'Spessore / sezione', ''],
    ['dettaglio', 'Dettaglio', ''],
    ['misura', 'Misura', '#'],
    ['unita', 'Unità', '']
  ];
  vista.innerHTML = `
    <h1>${esc(p.id)} · ${esc(p.operazione)}</h1>
    <p class="piccolo">${esc(p.reparto)} · ${esc(p.codice)} · modalità <b>${esc(modalita)}</b>${modalita === 'serie' ? ` · obiettivo ${qta} ${esc(op ? op.unita : '')}` : ''}</p>
    <div class="evidenza"><b>Cosa cronometrare:</b><br>${esc(p.cosa || (op && op.cosa) || '—')}</div>
    <div class="scheda centro"><b style="font-size:24px">Prova ${s.fatte + 1} di ${s.richieste}</b>
      ${s.fatte >= s.richieste ? '<p class="piccolo">Ripetizioni già completate: questa è una prova in più.</p>' : ''}
      <p class="piccolo">Operatore: <b>${esc(imp().operatore)}</b> · Q.tà per prova: ${qta}</p></div>
    <h2>Parametri (modificabili)</h2>
    ${campi.map(([k, et, o]) => campoParam('p-' + k, et, o, p[k])).join('')}
    <label class="campo"><span>Note</span><textarea id="p-note"></textarea></label>
    <button class="btn verde grande" id="inizia">Vai al cronometro</button>`;
  campi.forEach(([k]) => {
    const el = document.getElementById('p-' + k);
    const segna = () => el.classList.toggle('modificato', el.value.trim() !== String(p[k] || '').trim());
    el.addEventListener('input', segna);
    el.addEventListener('change', segna);
  });
  $('#inizia').onclick = () => {
    const v = {};
    const modifiche = [];
    campi.forEach(([k, et]) => {
      v[k] = valore('p-' + k);
      const orig = String(p[k] || '').trim();
      if (v[k] !== orig) modifiche.push(`${et} ${orig || '(vuoto)'}→${v[k] || '(vuoto)'}`);
    });
    nuovoCronometro({
      tipo: 'provino', riferimento: p.id, codice: p.codice, reparto: p.reparto, operazione: p.operazione,
      modalita, obiettivo: modalita === 'serie' ? qta : 0,
      tecnica: v.tecnica, materiale: v.materiale, spessore_sezione: v.spessore_sezione, dettaglio: v.dettaglio,
      misura: aNumero(v.misura), unita: v.unita, quantita: qta, altri_parametri: '',
      note: valore('p-note'), noteModifiche: modifiche.length ? 'Parametri modificati: ' + modifiche.join(', ') : '',
      cosa: p.cosa || (op && op.cosa) || '',
      titolo: `${p.id} · ${p.operazione}`, sottotitolo: `Prova ${s.fatte + 1} di ${s.richieste}`
    });
  };
};

// ---- Commessa ----
VISTE.commessa = vista => {
  $('#barra-titolo').textContent = 'Commessa a fasi';
  const op = operazione('COM') || catalogo().find(o => o.modalita === 'fasi') || { codice: 'COM', operazione: 'Commessa a fasi', parametri: [], unita: 'pezzi' };
  const parRep = op.parametri.find(x => x.nome.toLowerCase().startsWith('reparto'));
  const reparti = parRep && parRep.opzioni ? parRep.opzioni : [...new Set(catalogo().map(o => o.reparto).filter(Boolean))].join('|');
  const ultime = leggi(K.commesse, []);
  vista.innerHTML = `
    <h1>Commessa</h1>
    ${op.cosa ? `<div class="evidenza">${esc(op.cosa)}</div>` : ''}
    <label class="campo"><span>Commessa / articolo</span>
      <input id="c-rif" list="c-ultime" autocomplete="off" autocapitalize="characters"></label>
    <datalist id="c-ultime">${ultime.map(u => `<option value="${esc(u)}">`).join('')}</datalist>
    ${ultime.length ? `<div class="griglia2">${ultime.slice(0, 4).map(u => `<button class="btn rapido" data-v="${esc(u)}">${esc(u)}</button>`).join('')}</div>` : ''}
    ${campoParam('c-rep', 'Reparto prevalente', reparti, '')}
    <label class="campo"><span>Quantità pezzi (si può scrivere anche alla fine)</span><input id="c-qta" inputmode="decimal"></label>
    <label class="campo"><span>Note</span><textarea id="c-note"></textarea></label>
    <button class="btn verde grande" id="inizia">Vai al cronometro</button>`;
  vista.querySelectorAll('.rapido').forEach(b => { b.onclick = () => { tocco(); $('#c-rif').value = b.dataset.v; }; });
  $('#inizia').onclick = () => {
    const rif = valore('c-rif');
    if (!rif) { avviso('Scrivi il codice della commessa o dell\'articolo'); $('#c-rif').focus(); return; }
    scrivi(K.commesse, [rif].concat(ultime.filter(u => u !== rif)).slice(0, 10));
    nuovoCronometro({
      tipo: 'commessa', riferimento: rif, codice: op.codice, reparto: valore('c-rep'), operazione: op.operazione,
      modalita: 'fasi', obiettivo: 0, tecnica: '', materiale: '', spessore_sezione: '', dettaglio: '',
      misura: '', unita: op.unita || 'pezzi', quantita: aNumero(valore('c-qta')), altri_parametri: '',
      note: valore('c-note'), noteModifiche: '', cosa: op.cosa || '',
      titolo: `Commessa ${rif}`, sottotitolo: valore('c-rep')
    });
  };
};

// ---- Misura libera: scelta dal Catalogo ----
VISTE.libera = (vista, codice) => {
  if (!codice) {
    $('#barra-titolo').textContent = 'Misura libera';
    let html = '<h1>Scegli l\'operazione</h1>';
    raggruppa(catalogo(), 'reparto').forEach((lista, reparto) => {
      html += `<h2>${esc(reparto)}</h2><div class="elenco">` + lista.map(o => `
        <button class="voce" data-c="${esc(o.codice)}"><span class="desc"><b>${esc(o.operazione)}</b><br>${esc(o.codice)} · ${esc(o.modalita)}</span></button>`).join('') + '</div>';
    });
    vista.innerHTML = html;
    vista.querySelectorAll('.voce').forEach(b => { b.onclick = () => { tocco(); vai('libera', b.dataset.c); }; });
    return;
  }
  const op = operazione(codice);
  if (!op) { vai('libera', null, true); return; }
  $('#barra-titolo').textContent = op.codice;
  vista.innerHTML = `
    <h1>${esc(op.operazione)}</h1>
    <p class="piccolo">${esc(op.reparto)} · ${esc(op.codice)} · modalità <b>${esc(op.modalita)}</b></p>
    ${op.cosa ? `<div class="evidenza"><b>Cosa cronometrare:</b><br>${esc(op.cosa)}</div>` : ''}
    ${op.parametri.map((par, i) => campoParam('l-par' + i, par.nome, par.opzioni, '')).join('')}
    <div class="griglia2">
      <label class="campo"><span>Misura</span><input id="l-misura" inputmode="decimal"></label>
      <label class="campo"><span>Unità</span><input id="l-unita" value="${esc(op.unita)}"></label>
    </div>
    ${op.modalita === 'serie' ? '' : `<label class="campo"><span>Quantità (${esc(op.unita)})</span><input id="l-qta" inputmode="decimal" value="1"></label>`}
    <label class="campo"><span>Riferimento (facoltativo)</span><input id="l-rif" value="${esc(op.codice)}"></label>
    <label class="campo"><span>Note</span><textarea id="l-note"></textarea></label>
    <button class="btn verde grande" id="inizia">Vai al cronometro</button>`;
  $('#inizia').onclick = () => {
    const mp = mappaParametri(op.parametri.map((par, i) => ({ nome: par.nome, valore: valore('l-par' + i) })));
    const rif = valore('l-rif') || op.codice;
    nuovoCronometro({
      tipo: 'libera', riferimento: rif, codice: op.codice, reparto: op.reparto, operazione: op.operazione,
      modalita: op.modalita, obiettivo: 0, tecnica: mp.tecnica, materiale: mp.materiale,
      spessore_sezione: mp.spessore_sezione, dettaglio: '', misura: aNumero(valore('l-misura')),
      unita: valore('l-unita'), quantita: op.modalita === 'serie' ? '' : aNumero(valore('l-qta')),
      altri_parametri: mp.altri.join('; '), note: valore('l-note'), noteModifiche: '', cosa: op.cosa || '',
      titolo: op.operazione, sottotitolo: rif !== op.codice ? rif : ''
    });
  };
};

// ---- Cronometro ----
let avvisatoObiettivo = null;

VISTE.cronometro = vista => {
  const c = cronoAttivo();
  if (!c) { vai('home', null, true); return; }
  if (c.stato === 'controllo') { vai('controllo', null, true); return; }
  const m = c.meta;
  $('#barra-titolo').textContent = m.titolo;
  const r = calcola(c, Date.now());
  const testa = `
    <div class="crono-testa">
      <div class="crono-rif">${esc(m.sottotitolo || '')}${m.sottotitolo ? ' · ' : ''}${esc(m.operatore)}</div>
      ${m.cosa ? `<details class="piccolo"><summary>Cosa cronometrare</summary>${esc(m.cosa)}</details>` : ''}
    </div>
    <div class="crono-tempo${r.inPausa ? ' pausa' : ''}" id="tempo">${fmtTempo(r.netto)}</div>
    <div class="crono-stato${r.inPausa ? ' pausa' : ''}" id="stato">${statoTesto(c, r)}</div>`;

  if (m.modalita === 'fasi') {
    const fasi = impFoglio().fasi;
    vista.innerHTML = `
      ${testa}
      <div class="fasi">${fasi.map((f, i) => `
        <button class="fase${r.avviato && !r.inPausa && r.faseAttiva === f ? ' attiva' : ''}" data-f="${i}">
          ${esc(f)}<span class="t" id="fase-${i}">${fmtTempo(r.fasi[f] || 0)}</span></button>`).join('')}
      </div>
      <div class="spazio"></div>
      <div class="griglia3">
        <button class="btn ${r.inPausa ? 'verde' : 'giallo'}" id="b-pausa"${r.avviato ? '' : ' disabled'}>${r.inPausa ? 'Riprendi' : 'Pausa'}</button>
        <button class="btn rosso" id="b-stop"${r.avviato ? '' : ' disabled'}>Stop</button>
        <button class="btn contorno-rosso" id="b-annulla">Annulla misura</button>
      </div>`;
    vista.querySelectorAll('.fase').forEach(b => {
      b.onclick = () => {
        const f = fasi[+b.dataset.f];
        const ora = calcola(c, Date.now());
        if (!ora.avviato) { c.stato = 'in corso'; aggiungiEvento(c, { tipo: 'avvio', fase: f }); }
        else if (ora.inPausa) aggiungiEvento(c, { tipo: 'ripresa', fase: f });
        else if (ora.faseAttiva !== f) aggiungiEvento(c, { tipo: 'fase', fase: f });
        tocco();
        mostra(vistaCorrente, true);
      };
    });
  } else {
    const serie = m.modalita === 'serie';
    let principale;
    if (!r.avviato) principale = '<button class="btn verde enorme" id="b-main">AVVIA</button>';
    else if (r.inPausa) principale = '<button class="btn verde enorme" id="b-main">RIPRENDI</button>';
    else if (serie) principale = '<button class="btn blu enorme" id="b-main">GIRO</button>';
    else principale = '<button class="btn rosso enorme" id="b-main">STOP</button>';
    const giri = r.giri;
    const med = mediana(giri);
    const raggiunto = m.obiettivo && giri.length >= m.obiettivo;
    vista.innerHTML = `
      <div class="crono-griglia">
        <div>
          ${testa}
          ${serie ? `<div class="contatore${raggiunto ? ' raggiunto' : ''}" id="contatore">Giri <b>${giri.length}</b>${m.obiettivo ? ` / ${m.obiettivo}` : ''}
            ${r.avviato && giri.length ? `<div class="piccolo">da ultimo giro: <span id="dalgiro">${fmtTempo(r.dalGiro)}</span></div>` : ''}</div>` : ''}
        </div>
        <div>
          ${principale}
          <div class="spazio"></div>
          <div class="griglia2">
            <button class="btn ${r.inPausa ? 'verde' : 'giallo'}" id="b-pausa"${r.avviato ? '' : ' disabled'}>${r.inPausa ? 'Riprendi' : 'Pausa'}</button>
            ${serie ? `<button class="btn" id="b-annullagiro"${giri.length ? '' : ' disabled'}>Annulla ultimo giro</button>
                       <button class="btn rosso" id="b-stop"${r.avviato ? '' : ' disabled'}>Stop</button>` : ''}
            <button class="btn contorno-rosso" id="b-annulla">Annulla misura</button>
          </div>
        </div>
      </div>
      ${serie && giri.length ? `<h2>Ultimi giri</h2><div class="giri">${giri.map((g, i) => ({ g, i })).reverse().slice(0, 12).map(({ g, i }) =>
        `<div class="giro${giri.length >= 3 && med > 0 && Math.abs(g - med) > 0.5 * med ? ' anomalo' : ''}"><span>${i + 1}</span><span>${fmtTempo(g)}</span></div>`).join('')}</div>` : ''}`;

    $('#b-main').onclick = () => {
      const ora = calcola(c, Date.now());
      if (!ora.avviato) { c.stato = 'in corso'; aggiungiEvento(c, { tipo: 'avvio' }); tocco(); }
      else if (ora.inPausa) { aggiungiEvento(c, { tipo: 'ripresa' }); tocco(); }
      else if (serie) {
        aggiungiEvento(c, { tipo: 'giro' });
        const n = ora.giri.length + 1;
        if (m.obiettivo && n === m.obiettivo && avvisatoObiettivo !== c.id) {
          avvisatoObiettivo = c.id;
          tocco(true);
          avviso(`Obiettivo raggiunto: ${n} di ${m.obiettivo}. Puoi continuare o premere Stop.`, 5000);
        } else tocco();
      } else { ferma(c); return; }
      mostra(vistaCorrente, true);
    };
    const bg = $('#b-annullagiro');
    if (bg) bg.onclick = () => {
      const i = c.eventi.map(e => e.tipo).lastIndexOf('giro');
      if (i < 0) return;
      c.eventi.splice(i, 1);
      salvaCrono(c);
      if (avvisatoObiettivo === c.id) avvisatoObiettivo = null;
      tocco();
      avviso('Ultimo giro annullato: il suo tempo passa al prossimo giro');
      mostra(vistaCorrente, true);
    };
  }

  const bp = $('#b-pausa');
  bp.onclick = async () => {
    const ora = calcola(c, Date.now());
    if (!ora.avviato) return;
    tocco();
    if (ora.inPausa) { aggiungiEvento(c, { tipo: 'ripresa' }); mostra(vistaCorrente, true); return; }
    aggiungiEvento(c, { tipo: 'pausa', motivo: null }); // l'istante è quello del tocco, il motivo si sceglie dopo
    mostra(vistaCorrente, true);
    chiediMotivo(c);
  };
  const bs = $('#b-stop');
  if (bs) bs.onclick = () => ferma(c);
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

function statoTesto(c, r) {
  if (!r.avviato) return c.meta.modalita === 'fasi' ? 'Tocca una fase per iniziare' : 'Pronto';
  if (r.inPausa) return `In pausa: ${esc(r.motivoPausa)} · <span id="pausa-t">${fmtTempo(r.pause)}</span>`;
  if (c.meta.modalita === 'fasi') return `Fase: ${esc(r.faseAttiva || '—')}`;
  return r.pause > 0 ? `Pause: ${fmtTempo(r.pause)}` : 'In corso';
}

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

// Aggiornamento del tempo sullo schermo (~10 volte al secondo). Solo grafica: il calcolo è dai timestamp.
setInterval(() => {
  const c = cronoAttivo();
  if (!c) return;
  const r = calcola(c, Date.now());
  const t = document.getElementById('tempo') || document.getElementById('home-tempo');
  if (t) t.textContent = fmtTempo(r.netto);
  const pt = document.getElementById('pausa-t');
  if (pt) pt.textContent = fmtTempo(r.pause);
  const dg = document.getElementById('dalgiro');
  if (dg) dg.textContent = fmtTempo(r.dalGiro);
  if (c.meta.modalita === 'fasi' && vistaCorrente.nome === 'cronometro') {
    impFoglio().fasi.forEach((f, i) => {
      const el = document.getElementById('fase-' + i);
      if (el) el.textContent = fmtTempo(r.fasi[f] || 0);
    });
  }
}, 100);

// ---- Controllo dopo lo Stop ----
VISTE.controllo = vista => {
  const c = cronoAttivo();
  if (!c) { vai('home', null, true); return; }
  if (c.stato !== 'controllo') { vai('cronometro', null, true); return; }
  const m = c.meta;
  $('#barra-titolo').textContent = 'Controllo misura';
  const r = calcola(c, Date.now());
  const s = secondi(r);
  const serie = m.modalita === 'serie';
  const qtaPredef = serie ? r.giri.length : (m.quantita === '' || m.quantita === undefined ? '' : m.quantita);
  const perUnita = () => {
    const q = aNumero($('#k-qta') ? $('#k-qta').value : qtaPredef);
    if (serie && r.giri.length) return s.netto / r.giri.length;
    return typeof q === 'number' && q > 0 ? s.netto / q : null;
  };
  let fasiHtml = '';
  if (m.modalita === 'fasi') {
    fasiHtml = '<h2>Fasi</h2>' + Object.keys(s.fasi).map(f => {
      const perc = s.netto > 0 ? (s.fasi[f] / s.netto) * 100 : 0;
      return `<div class="scheda"><div class="riga"><b>${esc(f)}</b><span style="text-align:right">${fmtSec(s.fasi[f])} · ${perc.toFixed(0)}%</span></div>
        <div class="barra-perc"><i style="width:${perc.toFixed(1)}%"></i></div></div>`;
    }).join('');
  }
  vista.innerHTML = `
    <h1>${esc(m.titolo)}</h1>
    <p class="piccolo">${esc(m.sottotitolo || '')} · ${esc(m.operatore)} · ${dataOra(r.inizio)}</p>
    <div class="riepilogo">
      <div>Netto<b>${fmtSec(s.netto)}</b></div>
      <div>Pause<b>${fmtSec(s.pause)}</b></div>
      ${serie ? `<div>Giri<b>${r.giri.length}</b></div>` : `<div>Lordo<b>${fmtSec(s.lordo)}</b></div>`}
      <div>s per unità<b id="k-unita">—</b></div>
    </div>
    ${Object.keys(s.motivi).length ? `<p class="piccolo">Pause: ${esc(s.motiviTesto)}</p>` : ''}
    ${fasiHtml}
    <label class="campo"><span>Quantità${m.unita ? ' (' + esc(m.unita) + ')' : ''}${serie ? ' – predefinita = numero di giri' : ''}</span>
      <input id="k-qta" inputmode="decimal" value="${esc(qtaPredef)}"></label>
    ${m.noteModifiche ? `<p class="piccolo">${esc(m.noteModifiche)}</p>` : ''}
    <label class="campo"><span>Note</span><textarea id="k-note">${esc(m.note || '')}</textarea></label>
    <div class="griglia2">
      <button class="btn verde grande" id="k-salva">Salva</button>
      <button class="btn contorno-rosso grande" id="k-scarta">Scarta</button>
    </div>
    <div class="spazio"></div>
    <button class="btn" id="k-riprendi">Stop per errore: riprendi il cronometro</button>`;
  const aggiornaUnita = () => {
    const u = perUnita();
    $('#k-unita').textContent = u === null ? '—' : numIt(u);
  };
  aggiornaUnita();
  $('#k-qta').oninput = aggiornaUnita;
  if (m.modalita === 'fasi' && qtaPredef === '') $('#k-qta').classList.add('modificato');

  $('#k-salva').onclick = () => {
    tocco();
    const misura = costruisciMisura(c, r, s, aNumero(valore('k-qta')), valore('k-note'));
    const q = coda();
    if (!q.some(x => x.id === misura.id)) q.push(misura);
    scrivi(K.coda, q);
    eliminaCrono(c.id);
    avviso(`Misura salvata (${misura.riferimento}, ripetizione ${misura.ripetizione})`);
    sincronizza();
    if (m.tipo === 'provino') vai('provino', m.riferimento, true);
    else vai('home', null, true);
  };
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

/** Secondi con un decimale, coerenti: netto = lordo − pause, somma fasi = netto. */
function secondi(r) {
  const lordo = r1(r.lordo / 1000);
  const pause = r1(r.pause / 1000);
  const netto = r1(lordo - pause);
  const fasi = {};
  impFoglio().fasi.forEach(f => { fasi[f] = r1((r.fasi[f] || 0) / 1000); });
  Object.keys(r.fasi).forEach(f => { if (!(f in fasi)) fasi[f] = r1(r.fasi[f] / 1000); });
  const somma = r1(Object.values(fasi).reduce((a, b) => a + b, 0));
  const diff = r1(netto - somma);
  if (diff !== 0 && somma > 0) {
    const maggiore = Object.keys(fasi).reduce((a, b) => (fasi[b] > fasi[a] ? b : a));
    fasi[maggiore] = r1(fasi[maggiore] + diff);
  }
  const motivi = {};
  Object.keys(r.motivi).forEach(k => { motivi[k] = r1(r.motivi[k] / 1000); });
  const motiviTesto = Object.keys(motivi).map(k => `${k}=${motivi[k].toFixed(1)}`).join('; ');
  return { lordo, pause, netto, fasi, motivi, motiviTesto, giri: r.giri.map(g => r1(g / 1000)) };
}

function prossimaRipetizione(meta) {
  if (meta.tipo === 'provino') {
    const p = (cfg().provini || []).find(x => x.id === meta.riferimento);
    return (p ? parseInt(p.fatte, 10) || 0 : 0) + misureLocali('provino', meta.riferimento) + 1;
  }
  const cont = leggi(K.contatori, {});
  return (cont[meta.tipo + '|' + meta.riferimento] || 0) + 1;
}

function costruisciMisura(c, r, s, quantita, note) {
  const m = c.meta;
  const ripetizione = prossimaRipetizione(m);
  if (m.tipo !== 'provino') {
    const cont = leggi(K.contatori, {});
    cont[m.tipo + '|' + m.riferimento] = ripetizione;
    scrivi(K.contatori, cont);
  }
  return {
    id: c.id,
    inizio: dataOra(r.inizio),
    fine: dataOra(r.fine),
    operatore: m.operatore,
    tipo: m.tipo,
    riferimento: m.riferimento,
    ripetizione,
    codice: m.codice,
    reparto: m.reparto,
    operazione: m.operazione,
    modalita: m.modalita,
    tecnica: m.tecnica,
    materiale: m.materiale,
    spessore_sezione: m.spessore_sezione,
    dettaglio: m.dettaglio,
    misura: m.misura,
    unita: m.unita,
    quantita,
    netto_s: s.netto,
    pause_s: s.pause,
    lordo_s: s.lordo,
    fasi_s: m.modalita === 'fasi' ? s.fasi : { Attrezzaggio: 0, Lavoro: 0, Movimentazione: 0, Controllo: 0, Attesa: 0 },
    giri_s: m.modalita === 'serie' ? s.giri : [],
    altri_parametri: m.altri_parametri || '',
    motivi_pause: s.motiviTesto,
    note: [m.noteModifiche, note].filter(Boolean).join(' · '),
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
  const operatori = impFoglio().operatori;
  vista.innerHTML = `
    ${primo ? `<h1>Benvenuto</h1><p>Inserisci l'indirizzo dello script (quello che finisce con <b>/exec</b>) e il token, poi premi <b>Salva e scarica</b>.</p>` : '<h1>Impostazioni</h1>'}
    <label class="campo"><span>Indirizzo dello script (/exec)</span>
      <input id="i-url" value="${esc(i.url)}" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"></label>
    <label class="campo"><span>Token</span>
      <input id="i-token" value="${esc(i.token)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    ${operatori.length ? `<label class="campo"><span>Operatore predefinito</span>
      <select id="i-op">${operatori.map(o => `<option${o === i.operatore ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>` : ''}
    <div class="interruttore"><input type="checkbox" id="i-vib"${i.vibrazione ? ' checked' : ''}><label for="i-vib">Vibrazione a ogni tocco</label></div>
    <div class="spazio"></div>
    <button class="btn verde grande" id="i-salva">Salva e scarica</button>
    <p id="i-esito" class="centro"></p>
    <p class="piccolo centro">Versione app ${VERSIONE} · ${esc(dispositivo())}</p>`;
  $('#i-salva').onclick = async () => {
    tocco();
    const nuove = imp();
    nuove.url = valore('i-url');
    nuove.token = valore('i-token');
    if ($('#i-op')) nuove.operatore = $('#i-op').value;
    nuove.vibrazione = $('#i-vib').checked;
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
