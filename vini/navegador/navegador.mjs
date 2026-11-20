// Sistema MR - NAVEGADOR DOS ROBOS (Vini) - mr-navegador v1 20/11/2026 (base: rf-navegador v3 do RF, instancia separada por LGPD)
// Chrome sem tela (Playwright). Nao abre porta: pergunta a fila na Edge mr-navegador a cada 10 s,
// entra no sistema externo com o login do cofre, le a tela, tira o print e devolve. A senha so existe em memoria.
// SO LEITURA: nao clica em aceitar, lancar, assinar nem prescrever nada.
import { chromium } from "playwright";
import fs from "node:fs";
const VERSAO = "mr-navegador v1 (20/11/2026)";
const BASE = "/opt/mr-navegador";
const ENV = {};
for (const l of fs.readFileSync(BASE + "/.env", "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0) ENV[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
const API = ENV.API, TK = ENV.TOKEN;
const SESS = BASE + "/sessoes";
fs.mkdirSync(SESS, { recursive: true, mode: 0o700 });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(corpo) {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json", "x-mrnav": TK }, body: JSON.stringify(corpo) });
  return r.json().catch(() => ({}));
}
// pagina que recarrega sozinha (app com sessao salva): tenta de novo em vez de falhar
async function tentar(fn, n = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const m = String(e && e.message || e);
      if (i < n - 1 && /context was destroyed|navigation|detached|Target closed|interrupted/i.test(m)) { await espera(3000); continue; }
      throw e;
    }
  }
}
async function abrir(page, url) {
  await page.goto(url, { waitUntil: "commit", timeout: 90000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await espera(4000);
}
// o site pediu CODIGO de verificacao (SMS/e-mail/app): o Vini pergunta no WhatsApp e o navegador espera ate 5 min
const RX_CAMPO_COD = /(otp|token|c[oó]digo|code|verifica|2fa|mfa|pin)/i;
const RX_TEXTO_COD = /(c[oó]digo de (verifica|seguran|acesso|confirma)|enviamos um c[oó]digo|digite o c[oó]digo|informe o c[oó]digo|verification code|two-factor|autentica[cç][aã]o em duas)/i;
async function campoCodigo(page) {
  const ins = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
  const n = Math.min(await ins.count(), 12);
  for (let i = 0; i < n; i++) {
    const el = ins.nth(i);
    const at = await el.evaluate((e) => [e.getAttribute("autocomplete"), e.name, e.id, e.placeholder, e.getAttribute("aria-label")].join(" ")).catch(() => "");
    if (/one-time-code/i.test(at) || RX_CAMPO_COD.test(at)) return el;
  }
  const txt = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
  if (RX_TEXTO_COD.test(txt) && n > 0) return ins.first();
  return null;
}
async function temCaptcha(page) {
  const f = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]').count().catch(() => 0);
  if (f) return true;
  const txt = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
  return /n[aã]o sou um rob[oô]|i'?m not a robot|captcha/i.test(txt);
}
async function resolverCodigo(page, job, log) {
  if (job._codigoFeito) return;
  const el = await campoCodigo(page).catch(() => null);
  if (!el) return;
  job._codigoFeito = true;
  const png = (await page.screenshot({ type: "png" }).catch(() => null));
  await api({ acao: "pede_codigo", id: job.id, print_b64: png ? png.toString("base64") : null });
  log.push("pediu codigo");
  const fim = Date.now() + 5 * 60e3;
  while (Date.now() < fim) {
    await espera(5000);
    const r = await api({ acao: "codigo", id: job.id }).catch(() => ({}));
    if (r && r.codigo) {
      await el.fill(String(r.codigo));
      await el.press("Enter");
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await espera(5000);
      log.push("codigo usado");
      return;
    }
  }
  throw new Error("o site pediu codigo de verificacao e ninguem mandou em 5 minutos");
}
const sub = (v, c) => String(v).replace(/\{\{login\}\}/g, c.login || "").replace(/\{\{senha\}\}/g, c.senha || "");
async function loginAuto(page, c) {
  await espera(1500);
  const pw = page.locator('input[type="password"]:visible').first();
  if (!(await pw.count())) return "ja_logado_ou_sem_campo_senha";
  const user = page.locator('input[type="email"]:visible, input[type="text"]:visible, input[type="tel"]:visible, input:not([type]):visible').first();
  if (await user.count()) await user.fill(c.login || "");
  await pw.fill(c.senha || "");
  await pw.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await espera(5000);
  const ainda = await page.locator('input[type="password"]:visible').count();
  return ainda ? "campo_de_senha_continua_na_tela" : "ok";
}
async function rodar(job) {
  const c = job.cred || {};
  const tirar = (s) => { let t = String(s || ""); if (c.senha) t = t.split(c.senha).join("***"); return t; };
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const sf = SESS + "/" + String(job.sistema).replace(/[^a-z0-9_-]/gi, "") + ".json";
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: "pt-BR", timezoneId: "America/Bahia",
    storageState: fs.existsSync(sf) ? sf : undefined,
  });
  const page = await ctx.newPage();
  const log = [];
  try {
    await abrir(page, job.url_login);
    for (const p of job.passos || []) {
      await tentar(async () => {
        if (p.login_auto) {
          log.push("login: " + (await loginAuto(page, c)));
          if (await temCaptcha(page)) throw new Error("o site pediu CAPTCHA (aquele 'nao sou um robo') -- o robo nao consegue passar; entre uma vez pelo navegador");
          await resolverCodigo(page, job, log);
        }
        else if (p.ir) { await abrir(page, sub(p.ir, c)); log.push("ir"); }
        else if (p.preencher) { await page.locator(p.preencher[0]).first().fill(sub(p.preencher[1], c)); log.push("preencher " + p.preencher[0]); }
        else if (p.clicar) { await page.locator(p.clicar).first().click({ timeout: 20000 }); log.push("clicar " + p.clicar); }
        else if (p.clicar_texto) { await page.getByText(p.clicar_texto, { exact: false }).first().click({ timeout: 20000 }); log.push("clicar_texto " + p.clicar_texto); }
        else if (p.esperar) await espera(Math.min(Number(p.esperar) || 0, 30000));
        else if (p.esperar_texto) await page.getByText(p.esperar_texto).first().waitFor({ timeout: 30000 });
      });
    }
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await espera(1500);
    const texto = tirar(await tentar(async () => (await page.evaluate(() => (document.body ? document.body.innerText : ""))).slice(0, 20000)));
    const png = await page.screenshot({ type: "png" });
    await ctx.storageState({ path: sf }).catch(() => {});
    try { fs.chmodSync(sf, 0o600); } catch (_) { /* */ }
    return { ok: true, texto, print_b64: png.toString("base64"), url_final: page.url(), log };
  } catch (e) {
    let png = null;
    try { png = (await page.screenshot({ type: "png" })).toString("base64"); } catch (_) { /* */ }
    return { ok: false, erro: tirar(e && e.message || e).slice(0, 500), print_b64: png, url_final: page.url(), log };
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
console.log(VERSAO, "no ar");
for (;;) {
  try {
    const r = await api({ acao: "proximo", versao: VERSAO });
    // auto-atualizacao pela fila: grava o codigo novo e sai; o systemd reinicia em 10 s
    if (r && r.atualizar && r.atualizar.versao && r.atualizar.versao !== VERSAO && String(r.atualizar.js || "").includes("NAVEGADOR DOS ROBOS")) {
      fs.writeFileSync(BASE + "/navegador.mjs.novo", r.atualizar.js);
      fs.renameSync(BASE + "/navegador.mjs.novo", BASE + "/navegador.mjs");
      console.log(VERSAO, "-> atualizado para", r.atualizar.versao);
      process.exit(0);
    }
    if (r && r.job) {
      const res = await Promise.race([rodar(r.job), espera(540000).then(() => ({ ok: false, erro: "tempo esgotado (9 min)" }))]);
      await api({ acao: "resultado", id: r.job.id, ...res });
      continue;
    }
  } catch (e) { console.error("loop:", String(e && e.message || e).slice(0, 200)); }
  await espera(10000);
}
