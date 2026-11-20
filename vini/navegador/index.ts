// mr-navegador v1 (20/11/2026) -- NAVEGADOR DO VINI: o Vini entra com login e senha em sistemas de terceiros
// (sistemas dos médicos) por um Chrome sem tela na VPS (serviço isolado mr-navegador, usuário mrnav).
// Base: rf-navegador v3 do RF, mas INSTÂNCIA SEPARADA (LGPD): nada do MR passa pelo banco nem pelo serviço da RF.
// - Cofre: login/senha de cada sistema no Vault do MR (nav_cofre_*). Nunca vai para conversa, WhatsApp nem log.
// - Fila: robo_acessos. A VPS pergunta a cada 10 s (acao proximo, header x-mrnav) e devolve texto + print (acao resultado).
// - LGPD: o texto da tela NÃO é guardado (só a resposta). O print fica no máximo 7 dias (acao limpar, rotina diária).
// - Aviso: sai pelo Vini (fila vini_saida), com o print quando o motor do Vini mandar imagem.
// - SÓ LEITURA: não clica em aceitar, lançar, assinar nem prescrever nada.
// Ações da VPS (x-mrnav = nav_token): proximo, pede_codigo, codigo, resultado.
// Ações da tela (só o JWT do Renato): app_listar, app_salvar, app_pausar, app_testar, app_print, app_passos (só Renato).
// Rotina (x-mrnav-limpeza = limpeza_token): limpar.
import { createClient } from "npm:@supabase/supabase-js@2";
import { NAV_JS, NAV_VERSAO } from "./nav.ts";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const iguais = (a: string, b: string) => { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const RENATO = "2b001670-3aae-4655-9278-5f35bff4cee5", VINICIUS = "33cbfca4-e51e-452d-8535-fd2485cb70b9";
const PODE_TELA = [RENATO];   // 20/11: a tela é só do Renato
async function cofre(chave: string) { const { data } = await sb.rpc("nav_cofre_ler", { p_chave: chave }); return data ? String(data) : ""; }
async function setCofre(chave: string, valor: string) { const { error } = await sb.rpc("nav_cofre_gravar", { p_chave: chave, p_valor: valor }); if (error) throw new Error("cofre: " + error.message); }
async function estado(id: string) { const { data } = await sb.from("robo_nav_estado").select("valor").eq("id", id).maybeSingle(); return data ? String(data.valor) : ""; }
async function setEstado(id: string, valor: string) { await sb.from("robo_nav_estado").upsert({ id, valor, em: new Date().toISOString() }); }

async function responder(pergunta: string, texto: string, pngB64: string | null, nome: string) {
  try {
    const conteudo: any[] = [{ type: "text", text: `Você é o Vini, assistente do Sistema MR. Você acabou de entrar no sistema "${nome}" com o login cadastrado e está vendo a tela abaixo (texto + imagem). Responda em português, curto e direto, só com o que está na tela. Se a tela mostrar que o login falhou, pediu código de verificação ou captcha, diga isso claramente. Nunca invente dado que não está na tela. Não repita CPF, endereço nem telefone de paciente.\n\nPERGUNTA: ${pergunta}\n\nTEXTO DA TELA:\n${texto.slice(0, 12000)}` }];
    if (pngB64) conteudo.push({ type: "image_url", image_url: { url: "data:image/png;base64," + pngB64 } });
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + Deno.env.get("OPENAI_API_KEY") }, body: JSON.stringify({ model: "gpt-5.4-mini", max_completion_tokens: 900, messages: [{ role: "user", content: conteudo }] }) });
    if (!r.ok) return "";
    const j = await r.json(); return String(j?.choices?.[0]?.message?.content || "").trim();
  } catch (_) { return ""; }
}
// aviso pelo Vini: entra na fila de envio do motor (com o print, quando houver)
async function avisar(chat: string, msg: string, imagem: string | null) {
  if (!chat) return;
  await sb.from("vini_saida").insert({ chat, texto: msg, imagem_path: imagem });
}
async function guardarPrint(sistema: string, nome: string, png: string) {
  const p = `${sistema}/${nome}.png`;
  const { error } = await sb.storage.from("robo-acessos").upload(p, Uint8Array.from(atob(png), (c) => c.charCodeAt(0)), { contentType: "image/png", upsert: true });
  return error ? null : p;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") return json({ ok: true, versao: "mr-navegador v1", nav: NAV_VERSAO });
    const b = await req.json().catch(() => ({}));
    const acao = String(b.acao || "");
    // --- rotina diária: apaga prints com mais de 7 dias ---
    const tkL = req.headers.get("x-mrnav-limpeza") || "";
    if (tkL) {
      if (!iguais(tkL, await cofre("limpeza_token")) || acao !== "limpar") return json({ ok: false }, 401);
      const { data: velhos } = await sb.from("robo_acessos").select("id,print_path").not("print_path", "is", null).is("print_apagado_em", null).lt("criado_em", new Date(Date.now() - 7 * 864e5).toISOString()).limit(500);
      const ps = (velhos || []).map((x: any) => x.print_path);
      if (ps.length) { await sb.storage.from("robo-acessos").remove(ps); await sb.from("robo_acessos").update({ print_apagado_em: new Date().toISOString() }).in("id", (velhos || []).map((x: any) => x.id)); }
      await sb.from("robo_acessos").update({ status: "erro", erro: "ninguém mandou o código a tempo", fim_em: new Date().toISOString() }).eq("status", "aguardando_codigo").lt("codigo_pedido_em", new Date(Date.now() - 15 * 60e3).toISOString());
      return json({ ok: true, prints_apagados: ps.length });
    }
    // --- VPS ---
    const tkNav = req.headers.get("x-mrnav") || "";
    if (tkNav) {
      if (!iguais(tkNav, await cofre("nav_token"))) return json({ ok: false }, 401);
      if (acao === "proximo") {
        const vv = String(b.versao || "");
        await setEstado("nav-visto", new Date().toISOString() + " " + vv.slice(0, 60));
        if (vv && vv !== NAV_VERSAO) return json({ ok: true, job: null, atualizar: { versao: NAV_VERSAO, js: NAV_JS } });
        await sb.from("robo_acessos").update({ status: "erro", erro: "a VPS não devolveu em 10 min", fim_em: new Date().toISOString() }).eq("status", "rodando").lt("iniciado_em", new Date(Date.now() - 10 * 60e3).toISOString());
        const { data: fila } = await sb.from("robo_acessos").select("id,sistema,passos").eq("status", "pendente").order("criado_em").limit(1);
        const j = fila && fila[0]; if (!j) return json({ ok: true, job: null });
        const { data: pego } = await sb.from("robo_acessos").update({ status: "rodando", iniciado_em: new Date().toISOString() }).eq("id", j.id).eq("status", "pendente").select("id");
        if (!pego || !pego.length) return json({ ok: true, job: null });
        const { data: s } = await sb.from("robo_sistemas").select("*").eq("chave", j.sistema).maybeSingle();
        if (!s || !s.ativo) { await sb.from("robo_acessos").update({ status: "erro", erro: "sistema não cadastrado ou pausado", fim_em: new Date().toISOString() }).eq("id", j.id); return json({ ok: true, job: null }); }
        const cred = { login: await cofre(s.cred_login), senha: await cofre(s.cred_senha) };
        return json({ ok: true, job: { id: j.id, sistema: s.chave, url_login: s.url_login, passos: j.passos || s.passos, cred } });
      }
      if (acao === "pede_codigo") {
        const id = Number(b.id);
        const { data: a } = await sb.from("robo_acessos").select("id,sistema,avisar_chat").eq("id", id).maybeSingle(); if (!a) return json({ ok: false }, 404);
        await sb.from("robo_acessos").update({ status: "aguardando_codigo", codigo: null, codigo_pedido_em: new Date().toISOString() }).eq("id", id);
        const { data: s } = await sb.from("robo_sistemas").select("nome").eq("chave", a.sistema).maybeSingle();
        const img = b.print_b64 ? await guardarPrint(a.sistema, `${id}-codigo`, String(b.print_b64)) : null;
        await avisar(a.avisar_chat || "557599717578@s.whatsapp.net", `🔑 *O ${s?.nome || a.sistema} pediu um código de verificação*\nChegou um código por SMS, e-mail ou aplicativo? Me manda aqui assim: *código 123456*\nEspero 5 minutos.`, img);
        return json({ ok: true });
      }
      if (acao === "codigo") {
        const id = Number(b.id);
        const { data: a } = await sb.from("robo_acessos").select("codigo").eq("id", id).maybeSingle();
        if (a && a.codigo) { await sb.from("robo_acessos").update({ codigo: null, status: "rodando" }).eq("id", id); return json({ ok: true, codigo: a.codigo }); }
        return json({ ok: true, codigo: null });
      }
      if (acao === "resultado") {
        const id = Number(b.id);
        const { data: a } = await sb.from("robo_acessos").select("*").eq("id", id).maybeSingle(); if (!a) return json({ ok: false }, 404);
        const { data: s } = await sb.from("robo_sistemas").select("nome").eq("chave", a.sistema).maybeSingle();
        const nome = s?.nome || a.sistema;
        const png = b.print_b64 ? String(b.print_b64) : null;
        const printPath = png ? await guardarPrint(a.sistema, String(id), png) : null;
        let resposta = "";
        if (b.ok) resposta = await responder(a.pergunta || "O login funcionou? Diga o que aparece na tela.", String(b.texto || ""), png, nome);
        // LGPD: o texto da tela não é gravado; fica só a resposta
        await sb.from("robo_acessos").update({ status: b.ok ? "ok" : "erro", fim_em: new Date().toISOString(), url_final: String(b.url_final || "").slice(0, 500), resposta, print_path: printPath, erro: b.ok ? null : String(b.erro || "falhou").slice(0, 500) }).eq("id", id);
        if (a.avisar_chat) {
          const msg = b.ok ? `🌐 *Entrei no ${nome}*\n${a.pergunta ? "Pergunta: " + a.pergunta + "\n\n" : ""}${resposta || "Li a tela; o print ficou no sistema."}` : `⚠️ *Não consegui entrar no ${nome}*\n${String(b.erro || "").slice(0, 300)}\nO print de onde parei ficou no sistema.`;
          await avisar(a.avisar_chat, msg, printPath);
        }
        return json({ ok: true });
      }
      return json({ ok: false }, 400);
    }
    // --- tela "Acessos do Vini": só Renato e Vinicius ---
    if (acao.startsWith("app_")) {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = jwt ? await sb.auth.getUser(jwt) : { data: null } as any;
      const uid = u?.user?.id || "";
      if (!PODE_TELA.includes(uid)) return json({ ok: false, erro: "só o Renato" }, 403);
      const { data: perf } = await sb.from("perfis").select("nome").eq("id", uid).maybeSingle();
      const quem = uid === RENATO ? "Renato" : (perf?.nome || "Vinicius");
      if (acao === "app_listar") {
        const { data: sis } = await sb.from("robo_sistemas").select("chave,nome,url_login,medico,cred_login,cred_senha,passos,ativo,obs,criado_em").order("criado_em");
        const chaves = (sis || []).flatMap((x: any) => [x.cred_login, x.cred_senha]);
        const { data: q } = chaves.length ? await sb.rpc("nav_cofre_quando", { p_chaves: chaves }) : { data: [] } as any;
        const Q: Record<string, string> = {}; (q || []).forEach((x: any) => Q[x.chave] = x.atualizado_em);
        const sistemas = [];
        for (const x of sis || []) {
          const login = await cofre(x.cred_login);
          sistemas.push({ chave: x.chave, nome: x.nome, url_login: x.url_login, medico: x.medico, ativo: x.ativo, obs: x.obs, passos: uid === RENATO ? x.passos : undefined,
            login, tem_senha: !!Q[x.cred_senha], senha_em: Q[x.cred_senha] || null });
        }
        const { data: ult } = await sb.from("robo_acessos").select("id,sistema,pedido_por,pergunta,status,erro,resposta,criado_em,fim_em,print_path,print_apagado_em").order("id", { ascending: false }).limit(30);
        return json({ ok: true, sistemas, acessos: ult || [], vps: await estado("nav-visto"), nav: NAV_VERSAO, renato: uid === RENATO });
      }
      if (acao === "app_salvar") {
        const nome = String(b.nome || "").trim().slice(0, 80);
        const url = String(b.url_login || "").trim();
        if (!nome || !/^https:\/\/[^\s]+$/.test(url)) return json({ ok: false, erro: "Preencha o nome e o endereço (começando com https://)." }, 400);
        let chave = String(b.chave || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        if (!chave) chave = nome.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
        if (!chave) return json({ ok: false, erro: "Nome inválido." }, 400);
        const cl = `nav_${chave}_login`, cs = `nav_${chave}_senha`;
        const { data: ja } = await sb.from("robo_sistemas").select("chave").eq("chave", chave).maybeSingle();
        if (!ja && (!b.senha || !String(b.login || "").trim())) return json({ ok: false, erro: "Informe o login e a senha." }, 400);
        if (String(b.login || "").trim()) await setCofre(cl, String(b.login).trim());
        if (b.senha) await setCofre(cs, String(b.senha));
        const linha: any = { chave, nome, url_login: url, medico: String(b.medico || "").trim().slice(0, 80) || null, cred_login: cl, cred_senha: cs, so_leitura: true };
        if (!ja) { linha.criado_por = uid; linha.ativo = true; }
        const { error } = await sb.from("robo_sistemas").upsert(linha);
        if (error) return json({ ok: false, erro: error.message }, 500);
        return json({ ok: true, chave });
      }
      if (acao === "app_pausar") {
        const { error } = await sb.from("robo_sistemas").update({ ativo: !!b.ativo }).eq("chave", String(b.chave || ""));
        return json({ ok: !error, erro: error?.message });
      }
      if (acao === "app_passos") {
        if (uid !== RENATO) return json({ ok: false, erro: "só o Renato ajusta o roteiro" }, 403);
        if (!Array.isArray(b.passos) || b.passos.length > 30) return json({ ok: false, erro: "roteiro inválido" }, 400);
        const ok = b.passos.every((p: any) => p && typeof p === "object" && Object.keys(p).length === 1 && ["login_auto", "ir", "preencher", "clicar", "clicar_texto", "esperar", "esperar_texto"].includes(Object.keys(p)[0]));
        if (!ok) return json({ ok: false, erro: "passo desconhecido no roteiro" }, 400);
        const { error } = await sb.from("robo_sistemas").update({ passos: b.passos }).eq("chave", String(b.chave || ""));
        return json({ ok: !error, erro: error?.message });
      }
      if (acao === "app_testar") {
        const { data: s } = await sb.from("robo_sistemas").select("chave,ativo").eq("chave", String(b.chave || "")).maybeSingle();
        if (!s) return json({ ok: false, erro: "sistema não encontrado" }, 404);
        if (!s.ativo) return json({ ok: false, erro: "sistema pausado" }, 400);
        const { data, error } = await sb.from("robo_acessos").insert({ sistema: s.chave, pedido_por: quem + " (teste pela tela)", pedido_uid: uid, pergunta: "O login funcionou? Diga o que aparece na tela." }).select("id").single();
        return json({ ok: !error, id: data?.id, erro: error?.message });
      }
      if (acao === "app_print") {
        const { data: a } = await sb.from("robo_acessos").select("print_path,print_apagado_em").eq("id", Number(b.id)).maybeSingle();
        if (!a || !a.print_path || a.print_apagado_em) return json({ ok: false, erro: "sem print (apagado depois de 7 dias)" }, 404);
        const { data: u2 } = await sb.storage.from("robo-acessos").createSignedUrl(a.print_path, 600);
        return json({ ok: !!u2, url: u2?.signedUrl });
      }
      return json({ ok: false, erro: "ação desconhecida" }, 400);
    }
    return json({ ok: false, erro: "não autorizado" }, 401);
  } catch (e) { return json({ ok: false, erro: String((e as Error).message || e).slice(0, 400) }, 500); }
});
