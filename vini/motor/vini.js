/* MOTOR DO VINI — WhatsApp do Sistema MR (VPS Hostinger, isolado do Ravi)
   Só faz o "canal": recebe e envia mensagens. A inteligência fica no Supabase do MR (função vini-ponte).
   - Pasta própria (auth-vini), processo próprio no pm2 ("vini"), sem porta aberta: ele só CHAMA a ponte.
   - Nada do Ravi/RF é lido ou alterado.
   Config no arquivo .env ao lado: PONTE_URL e VINI_TOKEN. */
const VERSAO = 'motor-vini v2 (20/11/2026)';   // v2: manda o print do navegador do Vini como imagem
const fs = require('fs'), path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, Browsers } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const pino = require('pino');

const PONTE = process.env.PONTE_URL, TOKEN = process.env.VINI_TOKEN, AUTH = path.join(__dirname, 'auth-vini');
if (!PONTE || !TOKEN) { console.error('Falta PONTE_URL ou VINI_TOKEN no .env'); process.exit(1); }
const log = pino({ level: 'warn' });
const espera = ms => new Promise(r => setTimeout(r, ms));
let sock = null, conectado = false, pausado = false, ultimoQr = null;

async function ponte(corpo) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(PONTE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vini-token': TOKEN }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(90000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      console.error('ponte', r.status, JSON.stringify(j).slice(0, 200));
      if (r.status === 401) return {};
    } catch (e) { console.error('ponte falhou:', e.message); }
    await espera(3000 * (i + 1));
  }
  return {};
}
async function status(extra = {}) {
  const j = await ponte({ acao: 'status', versao: VERSAO, conectado, ...extra });
  pausado = !!j.pausado;
  if (j.pedido === 'reiniciar') { console.log('pedido: reiniciar'); process.exit(0); }
  if (j.pedido === 'desconectar') { console.log('pedido: desconectar'); try { await sock.logout(); } catch (e) {} fs.rmSync(AUTH, { recursive: true, force: true }); process.exit(0); }
}
async function grupos() {
  try { const g = await sock.groupFetchAllParticipating(); return Object.values(g).map(x => ({ id: x.id, nome: x.subject, membros: (x.participants || []).length })); } catch { return []; }
}
function textoDe(m) {
  const x = m.message || {};
  return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.documentMessage?.caption || '';
}
function midiaDe(m) {
  const x = m.message || {};
  if (x.imageMessage) return { mime: x.imageMessage.mimetype || 'image/jpeg' };
  if (x.documentMessage) return { mime: x.documentMessage.mimetype || 'application/octet-stream' };
  if (x.audioMessage) return { mime: x.audioMessage.mimetype || 'audio/ogg' };
  return null;
}
async function digitarEResponder(chat, textos, citada) {
  for (const t of textos) {
    try { await sock.sendPresenceUpdate('composing', chat); } catch {}
    await espera(1200 + Math.min(4000, t.length * 15));          // ritmo humano
    await sock.sendMessage(chat, { text: t }, citada ? { quoted: citada } : undefined);
    try { await sock.sendPresenceUpdate('paused', chat); } catch {}
  }
}
async function recebida(m) {
  if (!m.message || m.key.fromMe) return;
  const chat = m.key.remoteJid; if (!chat || chat === 'status@broadcast' || chat.endsWith('@newsletter')) return;
  const grupo = chat.endsWith('@g.us');
  const autorJid = grupo ? (m.key.participantPn || m.key.participant) : (m.key.senderPn || chat);
  const texto = textoDe(m), md = midiaDe(m);
  const eu = (sock.user?.id || '').split(':')[0], euLid = (sock.user?.lid || '').split(':')[0];
  const mencoes = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || m.message?.imageMessage?.contextInfo?.mentionedJid || [];
  const mencionado = /\bvini\b/i.test(texto) || mencoes.some(j => (eu && j.startsWith(eu)) || (euLid && j.startsWith(euLid)));
  if (grupo && !mencionado) return;          // em grupo só age quando chamado ("Vini" ou @) — não grava conversa alheia
  let midia = null;
  if (md) {
    try { const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
      if (buf.length <= 8 * 1024 * 1024) midia = { mime: md.mime, b64: buf.toString('base64') }; } catch (e) { console.error('mídia:', e.message); }
  }
  try { await sock.readMessages([m.key]); } catch {}
  const j = await ponte({ acao: 'entrada', chat, autor: autorJid, autor_nome: m.pushName, grupo, texto, midia, wa_id: m.key.id, mencionado });
  if (Array.isArray(j.responder) && j.responder.length) await digitarEResponder(chat, j.responder, grupo ? m : null);
}
async function filaDeSaida() {
  if (!conectado || pausado) return;
  const j = await ponte({ acao: 'saida' });
  for (const it of (j.itens || [])) {
    try {
      await digitarEResponder(it.chat, [it.texto]);
      if (it.imagem_url) {   // v2: print do navegador (link temporário do Supabase do MR)
        try { const r = await fetch(it.imagem_url, { signal: AbortSignal.timeout(30000) }); if (r.ok) await sock.sendMessage(it.chat, { image: Buffer.from(await r.arrayBuffer()), mimetype: 'image/png' }); }
        catch (e) { console.error('print não foi:', e.message); }
      }
      await ponte({ acao: 'saida_ok', id: it.id, ok: true });
    }
    catch (e) { await ponte({ acao: 'saida_ok', id: it.id, ok: false, erro: e.message }); }
    await espera(2500);
  }
}

async function ligar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({ auth: state, version, logger: log, browser: Browsers.ubuntu('Sistema MR'), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr && u.qr !== ultimoQr) { ultimoQr = u.qr; await status({ conectado: false, qr: await QR.toDataURL(u.qr, { margin: 1, width: 320 }), erro: null }); console.log('QR novo enviado ao sistema'); }
    if (u.connection === 'open') {
      conectado = true; ultimoQr = null;
      await status({ conectado: true, qr: null, numero: (sock.user?.id || '').split(':')[0], nome: sock.user?.name || null, grupos: await grupos(), erro: null });
      console.log('Vini conectado:', sock.user?.id);
    }
    if (u.connection === 'close') {
      conectado = false;
      const cod = u.lastDisconnect?.error?.output?.statusCode;
      const saiu = cod === DisconnectReason.loggedOut;
      await status({ conectado: false, erro: saiu ? 'Número desconectado do WhatsApp — ler o QR de novo' : 'Conexão caiu (' + (cod || '?') + '), reconectando' });
      if (saiu) { fs.rmSync(AUTH, { recursive: true, force: true }); }
      setTimeout(ligar, saiu ? 3000 : 5000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) { try { await recebida(m); } catch (e) { console.error('mensagem:', e.message); } }
  });
  sock.ev.on('groups.upsert', async () => { if (conectado) await status({ grupos: await grupos() }); });
}

console.log(VERSAO, 'iniciando');
ligar();
setInterval(() => status().catch(() => {}), 30000);     // batimento: o sistema vê se o motor está vivo
setInterval(() => filaDeSaida().catch(() => {}), 10000);                 // mensagens que o sistema mandou enviar
process.on('unhandledRejection', e => console.error('erro solto:', e && e.message));
