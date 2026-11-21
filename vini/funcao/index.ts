// Edge Function: vini-ponte — CÉREBRO DO ROBÔ VINI (WhatsApp do Sistema MR)
// Só o motor do WhatsApp (VPS) chama esta função, com o cabeçalho x-vini-token (token na tabela vini_segredo).
// Ações: status (motor informa conexão/QR/grupos), saida (motor busca o que enviar), saida_ok, entrada (mensagem recebida).
// Regras: só responde a contatos cadastrados em vini_contatos (v5: lista de ferramentas por contato); lançamento só depois de "SIM" de quem pode_lancar;
// tudo fica gravado em vini_mensagens / vini_acoes. Nunca usa o banco da RF.
// v12 (21/11/2026): ÁUDIO — o Vini ouve (transcreve) e responde também em nota de voz; lê PDF como lê foto.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSAO = "vini-ponte v20 (21/11/2026)";
// v20 (21/11/2026): NOTA FISCAL de compra → o Vini procura a compra em todos os cartões e consolida (mesma regra do CPE v130).
// v19 (21/11/2026): pedido do Renato/Vinicius — a equipe diz ao Vini (texto ou áudio) de qual CNPJ / obra / pessoal é cada conta ou compra e o Vini EXECUTA direto e avisa; "desfaz" volta a última.
// v18 (21/11/2026): lançamento direto só para fatura em PDF com vencimento (print do app é pedaço da fatura → pede SIM); separação aponta Financeiro › Cartões e compras (CPE v125).
// v17 (21/11/2026): pedido do Renato — fatura que bate 100% com o total entra DIRETO, sem pedir SIM ("fatura lida e 100%"). Só pede SIM se não bater.
// v16 (21/11/2026): fatura NUNCA entra duas vezes — confere a fatura inteira (cartão + vencimento) e refaz a conferência na hora do SIM.
// v15 (21/11/2026): CPE v124 — fatura do Vini cai na aba do cartão da Obra do IDAD (cartao_faturas, parcelas já existentes, cartão novo sem final) e a obra liga pelo movimento_id.
// v14 (21/11/2026): FATURA DE CARTÃO — o Vini lê a fatura (PDF/foto), confere o total, lança com SIM no "Apontar depois"
// e depois a pessoa diz pelo número o que é obra (vai para a Obra do IDAD), pessoal ou de qual CNPJ.
// v13 (21/11/2026): o Vini manda recado a contatos cadastrados a pedido de quem tem pode_mandar (só o Renato) e avisa quando respondem.
const J = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const OPENAI = Deno.env.get("OPENAI_API_KEY");
const ASSINA = "\n\n_Vini · Sistema MR_";
const so = (t: unknown) => String(t ?? "").replace(/\D/g, "");
const norm = (t: unknown) => String(t ?? "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const brl = (v: number) => "R$ " + (Math.round((+v || 0) * 100) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dbr = (d: string) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "");
// WhatsApp grava celular do Brasil às vezes SEM o 9 (ex.: 557599717578 = (75) 9 9971-7578): aceita as duas formas
const variantes = (d: string) => { const v = [d]; if (/^55\d{2}9\d{8}$/.test(d)) v.push(d.slice(0, 4) + d.slice(5)); if (/^55\d{2}[6-9]\d{7}$/.test(d)) v.push(d.slice(0, 4) + "9" + d.slice(4)); return v; };
const hojeBahia = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function log(direcao: string, chat: string, texto: string, extra: Record<string, unknown> = {}) {
  await sb.from("vini_mensagens").insert({ direcao, chat, texto: (texto || "").slice(0, 4000), ...extra });
}

/* ---------- IA ---------- */
// v10: modelo por tarefa + cache da OpenAI (ponto de corte explícito no fim das instruções fixas) + modelo de reserva
const MODELO_CONVERSA = "gpt-5.6-terra", MODELO_LEITURA = "gpt-5.4-mini", MODELO_RESERVA = "gpt-5.4-mini";
async function erro(tipo: string, d: Record<string, unknown>) {
  await sb.from("vini_erros").insert({ tipo, chat: d.chat ?? null, quem: d.quem ?? null, ferramenta: d.ferramenta ?? null, detalhe: String(d.detalhe ?? "").slice(0, 2000), pergunta: String(d.pergunta ?? "").slice(0, 1000) }).then(() => {}, () => {});
}
async function chamar(body: any) {
  if (body.tools && /^gpt-5\.6/.test(body.model)) body = { ...body, reasoning_effort: "none" };   // 5.6 + ferramentas no chat/completions exige reasoning_effort "none"
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + OPENAI }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, txt: r.ok ? "" : (await r.text()).slice(0, 300), j: r.ok ? await r.json() : null };
}
async function ia(messages: any[], tools?: any[], json = false, modelo = MODELO_LEITURA, ctx: any = {}) {
  const corte = (msgs: any[], usar: boolean) => msgs.map((m, i) => i === 0 && m.role === "system" && typeof m.content === "string" && usar
    ? { role: "system", content: [{ type: "text", text: m.content, prompt_cache_breakpoint: { mode: "explicit" } }] } : m);
  const base: any = { max_completion_tokens: 6000 };
  if (tools) base.tools = tools;
  if (json) base.response_format = { type: "json_object" };
  let r = await chamar({ ...base, model: modelo, messages: corte(messages, true) });
  if (!r.ok && r.status === 400) r = await chamar({ ...base, model: modelo, messages });                 // recusou o ponto de corte
  if (!r.ok && modelo !== MODELO_RESERVA) { await erro("ia_falhou", { ...ctx, detalhe: `${modelo} ${r.status}: ${r.txt} — usei a reserva` }); modelo = MODELO_RESERVA; r = await chamar({ ...base, model: modelo, messages }); }
  if (!r.ok) { await erro("ia_falhou", { ...ctx, detalhe: `${modelo} ${r.status}: ${r.txt}` }); throw new Error("IA: " + r.txt.slice(0, 200)); }
  const j = r.j, u = j?.usage;
  if (u) await sb.from("uso_ia").insert({ robo: "vini", modelo, tokens_in: u.prompt_tokens || 0, tokens_out: u.completion_tokens || 0, tokens_cache: u.prompt_tokens_details?.cached_tokens || 0 }).then(() => {}, () => {});
  return j?.choices?.[0]?.message;
}

/* ---------- v12 (21/11/2026): ÁUDIO — ouvir (transcrição) e falar (nota de voz) ----------
   Pedido do Vinicius/contratantes (21/11): o Vini precisa ouvir e responder áudio, e também mandar áudio.
   Entrada: o motor manda o áudio (audio/ogg; codecs=opus) em b.midia → transcreve → segue o fluxo normal como se fosse texto
   (inclusive SIM/NÃO e respostas de dúvida). Saída: quando a pessoa mandou áudio (ou pediu "em áudio"), a resposta vai por escrito
   E em nota de voz (vini_saida.audio_path). A nota de voz só sai quando o motor for v3 ou maior (o v2 não sabe mandar áudio). */
const MODELO_OUVIR = "gpt-4o-transcribe", OUVIR_RESERVA = "whisper-1", MODELO_FALAR = "gpt-4o-mini-tts", FALAR_RESERVA = "tts-1", VOZ = "ash";
const b64bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesB64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
async function transcrever(b64: string, mime: string, ctx: any = {}): Promise<string> {
  const m = String(mime || "audio/ogg").split(";")[0];
  const ext = /mpeg|mp3/.test(m) ? "mp3" : /mp4|m4a|aac/.test(m) ? "m4a" : /wav/.test(m) ? "wav" : /webm/.test(m) ? "webm" : "ogg";
  const bytes = b64bytes(b64);
  for (const modelo of [MODELO_OUVIR, OUVIR_RESERVA]) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: m }), "audio." + ext);
    fd.append("model", modelo); fd.append("language", "pt");
    fd.append("prompt", "Conversa de WhatsApp com o Vini, assistente do Sistema MR: NAFS, Hospital IDAD, anestesia, anestesista, plantão, escala, produção, mapa cirúrgico, CNPJ, Pix, convênio, procedimento.");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + OPENAI }, body: fd });
    if (r.ok) {
      const j = await r.json(), u = j?.usage;
      await sb.from("uso_ia").insert({ robo: "vini", modelo, tokens_in: u?.input_tokens || u?.prompt_tokens || 0, tokens_out: u?.output_tokens || 0, tokens_cache: 0 }).then(() => {}, () => {});
      return String(j?.text || "").trim();
    }
    await erro("ia_falhou", { ...ctx, detalhe: `${modelo} (transcrição) ${r.status}: ${(await r.text()).slice(0, 300)}` });
  }
  throw new Error("IA: não consegui transcrever o áudio");
}
// texto do WhatsApp → texto para falar (sem *negrito*, emoji, link e assinatura)
function paraFala(t: string) {
  return String(t || "").replace(ASSINA, "").replace(/^🎤 _.*_\n*/u, "").replace(/https?:\/\/\S+/g, "o link")
    .replace(/[*_~`]/g, "").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/^\s*[-•]\s+/gm, "").replace(/\n{2,}/g, "\n").trim();
}
async function falar(texto: string, ctx: any = {}): Promise<Uint8Array | null> {
  let t = paraFala(texto);
  if (t.length > 900) t = t.slice(0, 850).replace(/\s+\S*$/, "") + ". O restante te mandei por escrito.";
  if (!t) return null;
  const tentativas: any[] = [
    { model: MODELO_FALAR, voice: VOZ, input: t, response_format: "opus", instructions: "Fale em português do Brasil, tom cordial e profissional, ritmo natural de mensagem de voz de WhatsApp. Leia valores em reais e datas de forma natural." },
    { model: FALAR_RESERVA, voice: "onyx", input: t, response_format: "opus" },
  ];
  for (const body of tentativas) {
    const r = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + OPENAI }, body: JSON.stringify(body) });
    if (r.ok) {
      // a voz é cobrada por texto de entrada: grava ~tokens (4 caracteres por token) para o painel de gasto
      await sb.from("uso_ia").insert({ robo: "vini", modelo: body.model, tokens_in: Math.ceil(t.length / 4), tokens_out: 0, tokens_cache: 0 }).then(() => {}, () => {});
      return new Uint8Array(await r.arrayBuffer());
    }
    await erro("ia_falhou", { ...ctx, detalhe: `${body.model} (voz) ${r.status}: ${(await r.text()).slice(0, 300)}` });
  }
  return null;
}
async function motorFalaAudio() {
  const { data } = await sb.from("vini_status").select("motor_versao").eq("id", 1).maybeSingle();
  const m = String(data?.motor_versao || "").match(/v(\d+)/); return !!m && +m[1] >= 3;
}
async function enviarVoz(chat: string, texto: string, ctx: any = {}) {
  const audio = await falar(texto, ctx); if (!audio) return false;
  const path = `vini/audio/saida/${crypto.randomUUID()}.ogg`;
  const up = await sb.storage.from("notas").upload(path, audio, { contentType: "audio/ogg" });
  if (up.error) { await erro("ferramenta_falhou", { ...ctx, ferramenta: "voz", detalhe: up.error.message }); return false; }
  await sb.from("vini_saida").insert({ chat, texto: "", audio_path: path });
  return true;
}
const PEDIU_AUDIO = /\b(EM|POR|NUM|DE|UM|COM) AUDIO\b|\bMANDA (UM )?AUDIO\b|\bGRAVA (UM )?AUDIO\b|\bFALA (PRA|PARA) MIM\b/;

/* ---------- Produção da anestesia (foto do mapa cirúrgico) ---------- */
const PROMPT_PROC = `Voce esta lendo foto(s) de uma LISTA DE CIRURGIAS / PROCEDIMENTOS de um hospital (mapa cirurgico, lista de atendimentos, relatorio de internacoes). A foto pode estar girada, inclinada ou com marca-texto e anotacoes a caneta.
Devolva UM item por PROCEDIMENTO, na ordem da lista:
- paciente: nome do paciente como esta escrito.
- idade: numero inteiro se houver; senao null.
- procedimento: o procedimento como esta escrito. Se o mesmo paciente tem DOIS procedimentos, devolva DOIS itens. Se houver correcao a caneta, use o corrigido.
- situacao: "cancelado" quando a linha estiver RISCADA ou anotada como cancelado/adiado/suspenso; senao "realizado".
- obs: anotacao a caneta relevante, curta; senao "".
Ignore linhas de resumo/total. Devolva tambem, se aparecer: data da lista AAAA-MM-DD, hospital, cirurgiao.
Responda SOMENTE JSON: {"data":"","hospital":"","cirurgiao":"","itens":[{"paciente":"","idade":null,"procedimento":"","situacao":"realizado","obs":""}]}
Se a imagem nao for uma lista de procedimentos, responda {"erro":"nao e lista"}`;

function servicoDo(h: any, texto: string) {
  const t = norm(texto).replace(/\bVIDEO\s*LAPAROSCOPICA\b/g, "VIDEOLAPAROSCOPICA"), tw = t.split(" ");
  let melhor: any = null, nota = 0;
  (Array.isArray(h?.servicos) ? h.servicos : []).filter((s: any) => s && s.nome).forEach((s: any) => {
    let n = 0; const sig = String(s.sigla || "").toUpperCase().trim();
    if (sig && (tw.includes(sig) || t === sig)) n += 10;
    norm(s.nome).split(" ").filter((w) => w.length >= 5).forEach((w) => { const r = w.slice(0, 7); if (tw.some((x) => x.slice(0, 7) === r)) n += 1; });
    if (n > nota) { nota = n; melhor = s; }
  });
  return nota > 0 ? melhor : null;
}

async function plantoesDoDia(data: string) {
  const { data: dias } = await sb.from("esc_dias").select("id,data,turno,local_id,anestesista_id,cirurgiao,status,proc_docs,valor").eq("data", data);
  const { data: locais } = await sb.from("esc_locais").select("id,hospital,unidade");
  const { data: anes } = await sb.from("esc_anestesistas").select("id,nome");
  const { data: hosp } = await sb.from("esc_hospitais").select("nome,servicos");
  return (dias || []).filter((d: any) => d.status !== "cancelado").map((d: any) => {
    const l = (locais || []).find((x: any) => x.id === d.local_id) || {};
    const hn = (l as any).hospital || (l as any).unidade || "—";
    return { ...d, hospital: hn, anestesista: ((anes || []).find((a: any) => a.id === d.anestesista_id) as any)?.nome || "sem anestesista",
      cad: (hosp || []).find((h: any) => String(h.nome).trim().toLowerCase() === String(hn).trim().toLowerCase()) || null };
  });
}
const TURNO: Record<string, string> = { M: "Manhã", T: "Tarde", N: "Noite" };
const rotPlantao = (p: any) => `${dbr(p.data)} · ${p.hospital}${p.turno ? " · " + (TURNO[p.turno] || p.turno) : ""} · ${p.anestesista}`;

async function lerProducao(chat: string, autor: string, midia: any): Promise<string> {
  const msg = await ia([{ role: "user", content: [{ type: "text", text: PROMPT_PROC }, { type: "image_url", image_url: { url: `data:${midia.mime || "image/jpeg"};base64,${midia.b64}`, detail: "high" } }] }], undefined, true);
  let out: any; try { out = JSON.parse(String(msg?.content || "").replace(/^```json|```$/g, "")); } catch { return "Não consegui ler a foto. Pode mandar outra mais nítida?"; }
  if (out?.erro) return "Recebi a foto, mas ela não parece ser uma lista de procedimentos. Por enquanto eu leio o *mapa cirúrgico / lista de atendimentos* da anestesia.";
  const itens = (out?.itens || []).filter((x: any) => x?.procedimento).map((x: any) => ({ paciente: String(x.paciente || "").slice(0, 120), idade: Number.isFinite(+x.idade) && x.idade !== null ? Math.round(+x.idade) : null, procedimento: String(x.procedimento).slice(0, 160), situacao: x.situacao === "cancelado" ? "cancelado" : "realizado", obs: String(x.obs || "").slice(0, 120) }));
  if (!itens.length) return "Não achei nenhum procedimento na foto.";
  const data = /^\d{4}-\d{2}-\d{2}$/.test(out?.data || "") ? out.data : null;
  // guarda a foto como prova (vai para o plantão quando confirmar)
  const tmp = `vini/${crypto.randomUUID()}.jpg`;
  await sb.storage.from("notas").upload(tmp, Uint8Array.from(atob(midia.b64), (c) => c.charCodeAt(0)), { contentType: midia.mime || "image/jpeg" });
  let cand: any[] = [];
  if (data) {
    const ps = await plantoesDoDia(data), hn = norm(out?.hospital || "");
    const porHosp = hn ? ps.filter((p) => { const a = norm(p.hospital); return a && (a.includes(hn) || hn.includes(a) || a.split(" ").some((w) => w.length >= 5 && hn.includes(w))); }) : [];
    cand = porHosp.length ? porHosp : ps;
  }
  const dados = { itens, data, hospital_lido: out?.hospital || "", cirurgiao: out?.cirurgiao || "", foto: tmp, candidatos: cand.map((p) => ({ id: p.id, rot: rotPlantao(p), servicos: p.cad?.servicos || [] })), dia_id: cand.length === 1 ? cand[0].id : null };
  await sb.from("vini_acoes").update({ status: "expirada", resolvido_em: new Date().toISOString() }).eq("chat", chat).eq("status", "aguardando");
  await sb.from("vini_acoes").insert({ chat, autor, tipo: "lancar_procedimentos", dados });
  return resumoProducao(dados);
}
function precos(dados: any) {
  const c = dados.candidatos.find((x: any) => x.id === dados.dia_id);
  return dados.itens.map((x: any) => { const s = c ? servicoDo({ servicos: c.servicos }, x.procedimento) : null; return { ...x, procedimento: s ? s.nome : x.procedimento, valor: s && s.valor != null ? +s.valor : null }; });
}
function resumoProducao(dados: any) {
  const it = precos(dados), real = it.filter((x: any) => x.situacao !== "cancelado"), semP = real.filter((x: any) => x.valor == null).length;
  let t = `📋 *Li ${it.length} procedimento(s)*${dados.data ? " da lista de " + dbr(dados.data) : ""}${dados.hospital_lido ? " — " + dados.hospital_lido : ""}:\n`;
  it.slice(0, 25).forEach((x: any, i: number) => { t += `${i + 1}. ${x.paciente || "—"} — ${x.procedimento}${x.situacao === "cancelado" ? " _(cancelado)_" : x.valor != null ? " · " + brl(x.valor) : ""}\n`; });
  if (it.length > 25) t += `… e mais ${it.length - 25}\n`;
  if (dados.dia_id) {
    const c = dados.candidatos.find((x: any) => x.id === dados.dia_id);
    t += `\nPlantão: *${c.rot}*\nTotal: *${brl(real.reduce((a: number, x: any) => a + (x.valor || 0), 0))}*${semP ? ` (${semP} sem preço na tabela do hospital — complete no sistema)` : ""}\n\nPosso lançar? Responda *SIM* ou *NÃO*.`;
  } else if (dados.candidatos.length > 1) {
    t += `\nEm qual plantão eu lanço? Responda o número:\n` + dados.candidatos.map((c: any, i: number) => `*${i + 1}* — ${c.rot}`).join("\n");
  } else {
    t += `\n⚠️ ${dados.data ? "Não achei plantão na escala em " + dbr(dados.data) : "Não consegui ver a data na lista"}. Me diga a data (ex.: *18/11*) ou lance pelo sistema.`;
  }
  return t;
}
async function gravarProducao(acao: any): Promise<string> {
  const d = acao.dados, it = precos(d).filter((x: any) => x.procedimento);
  const { data: dia } = await sb.from("esc_dias").select("id,proc_docs").eq("id", d.dia_id).maybeSingle();
  if (!dia) throw new Error("plantão não encontrado");
  const { count } = await sb.from("esc_procedimentos").select("id", { count: "exact", head: true }).eq("dia_id", d.dia_id);
  if ((count || 0) > 0) return `Esse plantão já tem ${count} procedimento(s) lançado(s). Para não duplicar, não gravei — confira no sistema (Anestesia › Produção por escala).`;
  const ins = await sb.from("esc_procedimentos").insert(it.map((x: any, i: number) => ({ dia_id: d.dia_id, ordem: i + 1, paciente: x.paciente || null, idade: x.idade, procedimento: x.procedimento, valor: x.valor, situacao: x.situacao, obs: x.obs || null })));
  if (ins.error) throw new Error(ins.error.message);
  const ext = /\.pdf$/i.test(d.foto || "") ? "pdf" : "jpg";
  const destino = `procedimentos/${d.dia_id}/${Date.now()}-whatsapp-vini.${ext}`;
  const mv = await sb.storage.from("notas").move(d.foto, destino);
  const docs = Array.isArray(dia.proc_docs) ? dia.proc_docs : [];
  if (!mv.error) docs.push({ path: destino, nome: `mapa-whatsapp-vini.${ext}`, em: new Date().toISOString(), via: "Vini" });
  const tot = it.filter((x: any) => x.situacao !== "cancelado").reduce((a: number, x: any) => a + (x.valor || 0), 0);
  await sb.from("esc_dias").update({ proc_docs: docs, valor: Math.round(tot * 100) / 100 }).eq("id", d.dia_id);
  return `✅ Lancei ${it.length} procedimento(s) no plantão — total ${brl(tot)}. ${ext === "pdf" ? "O PDF" : "A foto"} ficou guardad${ext === "pdf" ? "o" : "a"} como prova no plantão.`;
}

/* ---------- Consultas (ferramentas da IA) — v3: o Vini conhece o sistema inteiro (só leitura) ---------- */
const MAPA = `MAPA DO SISTEMA MR (o que existe e onde fica):
- FINANCEIRO: CNPJs (empresas do grupo) com entradas, saídas, contas a pagar e saldo; "Apontar depois" = lançamentos (extrato/fatura/nota) que ainda não têm CNPJ definido; Cartões e contas (origens: cartões, contas bancárias, caixas); Nomes (fornecedores aprendidos); Despesas pessoais (privadas, você NÃO acessa).
- NAFS e ANESTESIA: escala de anestesistas por hospital/unidade, dia e turno (M manhã 7-13, T tarde 13-19, N noite 19-7, MT manhã+tarde). Cada plantão tem valor, CNPJ pagador, status (previsto/cancelado), confirmação do anestesista (fiz / não fiz), pago ou não, e procedimentos (mapa cirúrgico) com prova física. Hospitais cadastrados com forma de pagamento (por dia, por turno, mensal, por procedimento) e prazo. Saldo terceirizado da NAFS (valor de partida descontado pelas saídas).
- HOSPITAL IDAD (CNPJ 33.231.594/0001-09): Financeiro do IDAD (auditado), Conciliação (relatório da recepção Pixeon x caixa x Pix x Stone), Convênios e procedimentos (tabela de valores por convênio, parte médico/hospital, vigência), Cadastro de pacientes, Farmácia e Almoxarifado (estoque), Obra do IDAD.
- FICHÁRIO: fichas de consulta lidas por foto (médico padrão Marcus Adriano, CRM 36770/BA), com convênio e procedimento.
- USUÁRIOS: logins e permissões.
- SISTEMAS EXTERNOS (navegador do Vini): sistemas de terceiros cadastrados na tela "Acessos do Vini" (login e senha guardados no cofre). Você entra, lê a tela e responde; só leitura (não aceita, lança, assina nem prescreve nada). Nunca peça nem repita senha.
Regras: você só CONSULTA. Nunca mostre CPF, endereço, telefone ou dados clínicos de paciente; para pacientes dê só contagens. Valores sempre em R$.`;
const TOOLS = [
  { type: "function", function: { name: "contas", description: "Contas a pagar/receber: vencidas e a vencer.", parameters: { type: "object", properties: { empresa: { type: "string", description: "nome ou parte do nome do CNPJ (opcional)" }, dias: { type: "integer", description: "dias à frente (padrão 7)" }, tipo: { type: "string", enum: ["saida", "entrada"] } } } } },
  { type: "function", function: { name: "resumo_mes", description: "Entradas e saídas pagas/recebidas de um mês, por empresa.", parameters: { type: "object", properties: { mes: { type: "string", description: "AAAA-MM" }, empresa: { type: "string" } }, required: ["mes"] } } },
  { type: "function", function: { name: "empresas", description: "Lista dos CNPJs cadastrados.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "apontar_depois", description: "Fila 'Apontar depois': lançamentos sem CNPJ definido (quantos, quanto, maiores).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "contas_cartoes", description: "Cartões e contas (origens) e o movimento de um mês em cada uma.", parameters: { type: "object", properties: { mes: { type: "string", description: "AAAA-MM (opcional)" } } } } },
  { type: "function", function: { name: "escala", description: "Plantões de um dia (quem, onde, turno).", parameters: { type: "object", properties: { data: { type: "string", description: "AAAA-MM-DD" } }, required: ["data"] } } },
  { type: "function", function: { name: "plantoes", description: "Plantões de um mês com totais: quantos, valor, confirmados pelo anestesista, pagos, sem CNPJ pagador, com procedimentos. Filtra por anestesista, hospital ou grupo (NAFS/ANESTESIA).", parameters: { type: "object", properties: { mes: { type: "string", description: "AAAA-MM" }, anestesista: { type: "string" }, hospital: { type: "string" }, grupo: { type: "string", enum: ["NAFS", "ANESTESIA"] } }, required: ["mes"] } } },
  { type: "function", function: { name: "anestesistas", description: "Anestesistas cadastrados (nome, grupo, valor por dia).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "hospitais", description: "Hospitais cadastrados: forma de pagamento, prazo, valores e serviços/procedimentos com preço.", parameters: { type: "object", properties: { nome: { type: "string" } } } } },
  { type: "function", function: { name: "saldo_terceirizado", description: "Saldo terceirizado da NAFS: partida, saídas e saldo.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "idad", description: "Hospital IDAD. assunto: financeiro (mês), conciliacao (mês), convenios (valor de um convênio/procedimento), estoque (itens abaixo do mínimo), obra (gastos), pacientes (só contagem), fichario (fichas do mês).", parameters: { type: "object", properties: { assunto: { type: "string", enum: ["financeiro", "conciliacao", "convenios", "estoque", "obra", "pacientes", "fichario"] }, mes: { type: "string", description: "AAAA-MM" }, convenio: { type: "string" }, procedimento: { type: "string" } }, required: ["assunto"] } } },
  { type: "function", function: { name: "usuarios", description: "Quem tem login no sistema e o papel de cada um.", parameters: { type: "object", properties: {} } } },
  // v8: navegador do Vini (sistemas de terceiros, ex.: sistemas dos médicos). Só leitura. Nunca pede senha.
  { type: "function", function: { name: "acessar_sistema", description: "Entra com o login cadastrado num sistema EXTERNO (site de terceiro, ex.: sistema de um hospital ou convênio) e responde a pergunta lendo a tela; a resposta e o print chegam em ~1 min. Use quando pedirem algo que está nesse sistema externo. Sem argumentos de sistema, lista os sistemas cadastrados.", parameters: { type: "object", properties: { sistema: { type: "string", description: "nome ou chave do sistema cadastrado" }, pergunta: { type: "string", description: "o que procurar na tela" } } } } },
  { type: "function", function: { name: "informar_codigo_sistema", description: "Grava o código de verificação (SMS/e-mail/app) que a pessoa mandou para o acesso que está esperando código.", parameters: { type: "object", properties: { codigo: { type: "string" } }, required: ["codigo"] } } },
  // v13 (21/11/2026): recado para contato cadastrado — só para quem tem vini_contatos.pode_mandar (hoje só o Renato)
  { type: "function", function: { name: "enviar_recado", description: "Manda uma mensagem de WhatsApp, em nome do Vini, para uma pessoa CADASTRADA nos contatos do Vini (ex.: Vinicius, Neuza, Carol, Kelly). Use quando quem está falando pedir para chamar/avisar/mandar recado a alguém. Escreva o texto do recado já pronto, curto e educado, com o que foi pedido. Quando a pessoa responder, você avisa quem pediu. Sem 'para', lista os contatos.", parameters: { type: "object", properties: { para: { type: "string", description: "nome do contato cadastrado" }, texto: { type: "string", description: "mensagem pronta para enviar" } } } } },
  // v19 (21/11/2026): a equipe direciona contas e compras pelo WhatsApp (só quem tem pode_lancar / pode_fatura / pode_direcionar)
  { type: "function", function: { name: "buscar_lancamentos", description: "Procura contas e compras no sistema para direcionar (cartões, faturas, Apontar depois, contas dos CNPJs). Devolve cada uma com um código curto (#ref). Use antes de direcionar. Filtre pelo que a pessoa disse: texto (fornecedor/descrição, ex.: 'Leo Madeiras', 'pix reinildo', 'energia'), cartão ou conta (pessoa, banco ou final, ex.: 'Carol', 'final 2201', 'Unicred'), mês/vencimento, valor, só sem destino.", parameters: { type: "object", properties: { texto: { type: "string" }, cartao: { type: "string", description: "pessoa, banco ou final do cartão/conta" }, mes: { type: "string", description: "AAAA-MM (data da compra ou vencimento)" }, vencimento: { type: "string", description: "AAAA-MM-DD da fatura/conta" }, valor: { type: "number" }, so_sem_destino: { type: "boolean" }, empresa: { type: "string", description: "CNPJ onde está hoje (opcional)" } } } } },
  { type: "function", function: { name: "direcionar_lancamentos", description: "EXECUTA: manda contas/compras para um destino. destino: 'obra' (Obra do IDAD), 'cnpj' (informe empresa), 'pessoal' (informe pessoa; padrão = dono do cartão) ou 'tirar' (volta para o Apontar depois). Passe os #ref da busca (refs) — ou 'todos_da_busca': true para tudo que a última busca achou. Só use o que a pessoa pediu; se estiver ambíguo, pergunte antes.", parameters: { type: "object", properties: { refs: { type: "array", items: { type: "string" } }, todos_da_busca: { type: "boolean" }, destino: { type: "string", enum: ["obra", "cnpj", "pessoal", "tirar"] }, empresa: { type: "string" }, pessoa: { type: "string" }, categoria: { type: "string", description: "categoria opcional (ex.: Material, Combustível)" } }, required: ["destino"] } } },
  { type: "function", function: { name: "desfazer_direcionamento", description: "Desfaz o último direcionamento feito por esta pessoa (volta cada lançamento para onde estava).", parameters: { type: "object", properties: {} } } },
];
const NAVEGA = ["acessar_sistema", "informar_codigo_sistema"];
const DIRECIONA = ["buscar_lancamentos", "direcionar_lancamentos", "desfazer_direcionamento"];
const RECADO = ["enviar_recado"];
/* ---------- v19 (21/11/2026): DIRECIONAR CONTAS E COMPRAS PELO WHATSAPP ----------
   Pedido do Renato: "Vinicius vai pedir a Vini quais contas pertence a qual CNPJ por WhatsApp e Vini fará o que Vinicius pedir".
   Executa direto e avisa (decisão do Renato: sem SIM). Mesma regra da tela Cartões e compras (CPE v125):
   obra → CNPJ do IDAD + categoria "Obra do IDAD" + linha em idad_obra (movimento_id); cnpj → empresa; pessoal → Despesas pessoais da pessoa;
   tirar → Apontar depois. Tudo auditado (cpe_auditoria) e guardado em vini_acoes (tipo direcionar, com o "antes") para o "desfaz". */
const OBRA_CAT = "Obra do IDAD";
async function direcionar(nome: string, a: any, ctx: any) {
  const { chat, contato } = ctx, agora = new Date().toISOString();
  const { data: emps } = await sb.from("empresas").select("id,nome,cnpj,ativo");
  const idad: any = (emps || []).find((e: any) => so(e.cnpj) === "33231594000109");
  const { data: origs } = await sb.from("origens").select("id,nome,tipo,identificador,titular,banco");
  const nomeO = (id: string) => { const o: any = (origs || []).find((x: any) => x.id === id); return o ? `${o.titular || o.nome}${o.banco ? " " + o.banco : ""}${o.identificador ? " final " + o.identificador : ""}` : "—"; };
  const destinoDe = (m: any) => m.pessoal ? "pessoal" : !m.empresa_id ? "sem destino" : (idad && m.empresa_id === idad.id && m.categoria === OBRA_CAT) ? "Obra do IDAD" : ((emps || []).find((e: any) => e.id === m.empresa_id)?.nome || "CNPJ");
  if (nome === "buscar_lancamentos") {
    let q = sb.from("movimentos").select("id,tipo,data_movimento,vencimento,descricao,fornecedor,valor,empresa_id,origem_id,categoria,pessoal").eq("pessoal", false).order("data_movimento", { ascending: false }).limit(400);
    if (a.mes && /^\d{4}-\d{2}$/.test(a.mes)) q = q.or(`and(data_movimento.gte.${a.mes}-01,data_movimento.lte.${fimMes(a.mes)}),and(vencimento.gte.${a.mes}-01,vencimento.lte.${fimMes(a.mes)})`);
    if (a.vencimento && /^\d{4}-\d{2}-\d{2}$/.test(a.vencimento)) q = q.eq("vencimento", a.vencimento);
    if (a.so_sem_destino) q = q.is("empresa_id", null);
    if (a.valor) q = q.gte("valor", r2(+a.valor - 0.01)).lte("valor", r2(+a.valor + 0.01));
    if (a.cartao) {
      const c = norm(a.cartao), fin = so(a.cartao).slice(-4);
      const ids = (origs || []).filter((o: any) => (fin.length === 4 && so(o.identificador).slice(-4) === fin) || (!fin && [o.nome, o.titular, o.banco].some((v: any) => v && (norm(v).includes(c) || c.split(" ").every((w) => w.length < 3 || norm(o.nome + " " + (o.titular || "") + " " + (o.banco || "")).includes(w)))))).map((o: any) => o.id);
      if (!ids.length) return { erro: "não achei esse cartão/conta", cartoes: (origs || []).filter((o: any) => o.tipo === "cartao").map((o: any) => nomeO(o.id)) };
      q = q.in("origem_id", ids);
    }
    if (a.empresa) { const e: any = (emps || []).find((y: any) => norm(y.nome).includes(norm(a.empresa))); if (e) q = q.eq("empresa_id", e.id); }
    let l = (await q).data || [];
    if (a.texto) { const ws = norm(a.texto).split(" ").filter((w) => w.length >= 3); l = l.filter((m: any) => { const t = norm((m.fornecedor || "") + " " + (m.descricao || "")); return ws.every((w) => t.includes(w)); }); }
    l = l.slice(0, 60);
    await sb.from("vini_acoes").insert({ chat, autor: so(contato.telefone), tipo: "busca_direcionar", status: "confirmada", resolvido_em: agora, dados: { ids: l.map((m: any) => m.id) } });
    return { achados: l.length, total: soma(l.map((m: any) => ({ valor: m.tipo === "entrada" ? -m.valor : +m.valor }))), lista: l.map((m: any) => ({ ref: "#" + m.id.slice(0, 6), data: m.data_movimento, venc: m.vencimento, desc: m.fornecedor || m.descricao, valor: +m.valor, cartao_conta: nomeO(m.origem_id), destino_hoje: destinoDe(m) })),
      aviso: l.length === 60 ? "mostrei só 60 — peça um filtro mais fino" : undefined };
  }
  if (nome === "desfazer_direcionamento") {
    const { data: ac } = await sb.from("vini_acoes").select("id,dados").eq("chat", chat).eq("tipo", "direcionar").eq("status", "confirmada").order("criado_em", { ascending: false }).limit(1).maybeSingle();
    if (!ac) return { erro: "não achei direcionamento para desfazer" };
    let n = 0;
    for (const x of ac.dados?.antes || []) {
      const u = await sb.from("movimentos").update({ empresa_id: x.empresa_id, pessoal: x.pessoal, pessoa_id: x.pessoa_id, categoria: x.categoria }).eq("id", x.id);
      if (!u.error) n++;
      await sb.from("idad_obra").delete().eq("movimento_id", x.id);
      if (x.obra_linha) await sb.from("idad_obra").insert(x.obra_linha);
    }
    await sb.from("vini_acoes").update({ status: "desfeita", resultado: `desfeito: ${n}` }).eq("id", ac.id);
    return { ok: true, desfeitos: n };
  }
  // direcionar_lancamentos
  let ids: string[] = [];
  const { data: busca } = await sb.from("vini_acoes").select("dados").eq("chat", chat).eq("tipo", "busca_direcionar").order("criado_em", { ascending: false }).limit(1).maybeSingle();
  const daBusca: string[] = busca?.dados?.ids || [];
  if (a.todos_da_busca) ids = daBusca;
  else for (const r of a.refs || []) { const k = String(r).replace(/^#/, "").toLowerCase(); const id = daBusca.find((x) => x.startsWith(k)); if (id) ids.push(id); }
  ids = [...new Set(ids)];
  if (!ids.length) return { erro: "não sei quais lançamentos — faça a busca primeiro e use os #ref" };
  if (ids.length > 200) return { erro: "são muitos de uma vez (máx. 200) — divida o pedido" };
  let alvo: any = {};
  if (a.destino === "obra") { if (!idad) return { erro: "não achei o CNPJ do IDAD" }; alvo = { empresa_id: idad.id, pessoal: false, pessoa_id: null, categoria: OBRA_CAT }; }
  else if (a.destino === "cnpj") {
    const n = norm(a.empresa || ""); const e: any = n && ((emps || []).find((y: any) => norm(y.nome) === n) || (emps || []).find((y: any) => norm(y.nome).includes(n) || n.includes(norm(y.nome))) || (emps || []).find((y: any) => so(y.cnpj) && so(a.empresa).length >= 8 && so(y.cnpj).startsWith(so(a.empresa))));
    if (!e) return { erro: "não achei esse CNPJ", cnpjs: (emps || []).filter((x: any) => x.ativo !== false).map((x: any) => x.nome) };
    alvo = { empresa_id: e.id, pessoal: false, pessoa_id: null, _nome: e.nome };
  } else if (a.destino === "pessoal") {
    const { data: areas } = await sb.from("pessoais_area").select("dono_id,nome");
    let quem = a.pessoa;
    if (!quem) { const { data: m1 } = await sb.from("movimentos").select("origem_id").eq("id", ids[0]).maybeSingle(); quem = (origs || []).find((o: any) => o.id === m1?.origem_id)?.titular || ""; }
    const ar: any = (areas || []).find((x: any) => norm(x.nome).split(" ")[0] === norm(quem).split(" ")[0]);
    if (!ar) return { erro: `não achei a área pessoal de "${quem || "?"}"`, areas: (areas || []).map((x: any) => x.nome) };
    alvo = { empresa_id: null, pessoal: true, pessoa_id: ar.dono_id, _nome: ar.nome };
  } else alvo = { empresa_id: null, pessoal: false, pessoa_id: null };
  const { data: movs } = await sb.from("movimentos").select("id,tipo,data_movimento,descricao,fornecedor,valor,empresa_id,pessoal,pessoa_id,categoria,origem_id").in("id", ids);
  const { data: obrasAnt } = await sb.from("idad_obra").select("*").in("movimento_id", ids);
  const antes: any[] = []; let n = 0, tot = 0; const falhas: string[] = [];
  for (const m of movs || []) {
    const obraLinha = (obrasAnt || []).find((o: any) => o.movimento_id === m.id) || null;
    antes.push({ id: m.id, empresa_id: m.empresa_id, pessoal: m.pessoal, pessoa_id: m.pessoa_id, categoria: m.categoria, obra_linha: obraLinha ? (({ id, ...r }: any) => r)(obraLinha) : null });
    const upd: any = { empresa_id: alvo.empresa_id, pessoal: alvo.pessoal, pessoa_id: alvo.pessoa_id };
    if (a.destino === "obra") upd.categoria = OBRA_CAT;
    else if (m.categoria === OBRA_CAT) upd.categoria = a.categoria || null;
    else if (a.categoria) upd.categoria = a.categoria;
    const u = await sb.from("movimentos").update(upd).eq("id", m.id);
    if (u.error) { falhas.push(`${m.fornecedor || m.descricao}: ${u.error.message}`); continue; }
    if (a.destino === "obra") {
      if (!obraLinha) await sb.from("idad_obra").insert({ data: m.data_movimento, descricao: m.descricao, categoria: a.categoria || "Outros", fornecedor: String(m.fornecedor || m.descricao || "").slice(0, 80),
        valor: m.tipo === "entrada" ? -m.valor : +m.valor, forma_pag: nomeO(m.origem_id) !== "—" ? "Cartão " + nomeO(m.origem_id) : null, pago: false, pago_por: (origs || []).find((o: any) => o.id === m.origem_id)?.titular || null,
        obs: `[Direcionado pelo Vini a pedido de ${contato.nome} · movimento ${m.id}]`, movimento_id: m.id });
    } else if (obraLinha) await sb.from("idad_obra").delete().eq("movimento_id", m.id);
    n++; tot += m.tipo === "entrada" ? -m.valor : +m.valor;
  }
  const rot = a.destino === "obra" ? "Obra do IDAD" : a.destino === "cnpj" ? alvo._nome : a.destino === "pessoal" ? "pessoal de " + alvo._nome : "Apontar depois (sem destino)";
  await sb.from("vini_acoes").insert({ chat, autor: so(contato.telefone), tipo: "direcionar", status: "confirmada", resultado: `${n} → ${rot}`, resolvido_em: agora, dados: { destino: a.destino, para: rot, pedido_por: contato.nome, antes } });
  return { ok: true, feitos: n, para: rot, total: r2(tot), falhas: falhas.length ? falhas : undefined, aviso: "Diga o que foi feito (quantos, para onde, total) e que, se precisar, é só pedir 'desfaz'." };
}
async function enviarRecado(a: any, ctx: any) {
  const { data: cs } = await sb.from("vini_contatos").select("nome,telefone").eq("ativo", true).order("nome");
  const lista = (cs || []).filter((c: any) => so(c.telefone) !== so(ctx.contato.telefone)).map((c: any) => c.nome);
  if (!a.para) return { contatos: lista };
  const n = norm(a.para), c: any = (cs || []).find((x: any) => norm(x.nome) === n) || (cs || []).find((x: any) => norm(x.nome).split(" ")[0] === n.split(" ")[0]) || (cs || []).find((x: any) => norm(x.nome).includes(n));
  if (!c) return { erro: "essa pessoa não está nos contatos do Vini", contatos: lista };
  const texto = String(a.texto || "").trim().slice(0, 1500);
  if (!texto) return { erro: "faltou o texto do recado" };
  // endereço: o @lid que a pessoa já usou com o Vini; senão o número (o gatilho vini_saida_endereco também troca)
  const { data: m } = await sb.from("vini_mensagens").select("chat").eq("direcao", "entrada").eq("grupo", false).in("autor", variantes(so(c.telefone))).order("em", { ascending: false }).limit(1).maybeSingle();
  const chat = m?.chat || so(c.telefone) + "@s.whatsapp.net";
  const ins = await sb.from("vini_saida").insert({ chat, texto });
  if (ins.error) return { erro: ins.error.message };
  await sb.from("vini_recados").insert({ para_nome: c.nome, para_telefone: so(c.telefone), para_chat: chat, texto, pedido_por: ctx.contato.nome, avisar_chat: ctx.chat });
  return { ok: true, enviado_para: c.nome, texto, aviso: "Diga a quem pediu que o recado foi enviado (mostre o texto) e que você avisa quando a pessoa responder." };
}
async function empresas() { const { data } = await sb.from("empresas").select("id,nome,cnpj,ativo"); return data || []; }
const mesAtual = () => hojeBahia().slice(0, 7);
const fimMes = (m: string) => { const [a, b] = m.split("-").map(Number); return new Date(Date.UTC(a, b, 0)).toISOString().slice(0, 10); };
const soma = (l: any[], k = "valor") => Math.round(l.reduce((s, x) => s + (+x[k] || 0), 0) * 100) / 100;
async function tudo(q: () => any) { let out: any[] = []; for (let i = 0; i < 20; i++) { const { data } = await q().range(i * 1000, i * 1000 + 999); out = out.concat(data || []); if (!data || data.length < 1000) break; } return out; }
async function navegar(nome: string, a: any, ctx: any) {
  if (nome === "acessar_sistema") {
    const { data: sis } = await sb.from("robo_sistemas").select("chave,nome,medico,ativo").order("nome");
    const lista = (sis || []).map((x: any) => ({ sistema: x.nome, chave: x.chave, medico: x.medico, pausado: !x.ativo }));
    if (!a.sistema) return { sistemas: lista };
    const n = norm(a.sistema), s = (sis || []).find((x: any) => x.chave === String(a.sistema).toLowerCase() || norm(x.nome) === n) || (sis || []).find((x: any) => norm(x.nome).includes(n) || n.includes(norm(x.nome)));
    if (!s) return { erro: "sistema não cadastrado", sistemas: lista };
    if (!s.ativo) return { erro: "esse sistema está pausado na tela Acessos do Vini" };
    const { data: ja } = await sb.from("robo_acessos").select("id").eq("sistema", s.chave).in("status", ["pendente", "rodando", "aguardando_codigo"]).gte("criado_em", new Date(Date.now() - 10 * 60e3).toISOString()).limit(1);
    if (ja?.length) return { ok: true, aviso: "já tem um acesso a esse sistema em andamento; a resposta chega em seguida" };
    const { error } = await sb.from("robo_acessos").insert({ sistema: s.chave, pedido_por: ctx.contato.nome + " (WhatsApp)", pedido_fone: ctx.contato.telefone, pergunta: String(a.pergunta || "O que aparece na tela inicial?").slice(0, 500), avisar_chat: ctx.chat });
    if (error) return { erro: error.message };
    return { ok: true, resposta_para_a_pessoa: `Estou entrando no ${s.nome}; em ~1 min mando a resposta com o print. Se o site pedir código de verificação, eu te pergunto aqui.` };
  }
  if (nome === "informar_codigo_sistema") return await gravarCodigo(String(a.codigo || ""), ctx);
  return { erro: "ferramenta desconhecida" };
}
async function gravarCodigo(codigo: string, ctx: any) {
  const c = codigo.replace(/\s/g, "");
  if (!/^[A-Za-z0-9]{4,10}$/.test(c)) return { erro: "código inválido" };
  const chats = [ctx.chat, ...variantes(so(ctx.contato.telefone)).map((v) => v + "@s.whatsapp.net")];
  const { data: a } = await sb.from("robo_acessos").select("id,sistema").eq("status", "aguardando_codigo").in("avisar_chat", chats).gte("codigo_pedido_em", new Date(Date.now() - 6 * 60e3).toISOString()).order("codigo_pedido_em", { ascending: false }).limit(1).maybeSingle();
  if (!a) return { erro: "não há acesso esperando código agora (o prazo é de 5 minutos)" };
  await sb.from("robo_acessos").update({ codigo: c }).eq("id", a.id);
  return { ok: true, resposta_para_a_pessoa: "Recebi o código, estou entrando. Em seguida mando a resposta com o print." };
}
async function ferramenta(nome: string, a: any) {
  const emps = await empresas(), filtroE = (n?: string) => n ? emps.filter((e: any) => norm(e.nome).includes(norm(n))) : emps;
  const nomeE = (id: string) => emps.find((e: any) => e.id === id)?.nome || "sem CNPJ";
  if (nome === "contas") {
    const hoje = hojeBahia(), ate = new Date(Date.now() + (a.dias || 7) * 864e5).toISOString().slice(0, 10), es = filtroE(a.empresa).map((e: any) => e.id);
    const { data } = await sb.from("movimentos").select("descricao,fornecedor,valor,vencimento,empresa_id,tipo").eq("pago", false).eq("pessoal", false).eq("tipo", a.tipo || "saida").lte("vencimento", ate).in("empresa_id", es).order("vencimento").limit(60);
    return (data || []).map((m: any) => ({ empresa: nomeE(m.empresa_id), desc: m.fornecedor || m.descricao, valor: +m.valor, vencimento: m.vencimento, vencida: m.vencimento < hoje }));
  }
  if (nome === "resumo_mes") {
    const es = filtroE(a.empresa), ini = a.mes + "-01", fim = fimMes(a.mes);
    const data = await tudo(() => sb.from("movimentos").select("tipo,valor,empresa_id,categoria").eq("pago", true).eq("pessoal", false).gte("data_pagamento", ini).lte("data_pagamento", fim).in("empresa_id", es.map((e: any) => e.id)));
    return es.map((e: any) => { const m = data.filter((x: any) => x.empresa_id === e.id && !/^Transfer/.test(x.categoria || "")); return { empresa: e.nome, entradas: soma(m.filter((x: any) => x.tipo === "entrada")), saidas: soma(m.filter((x: any) => x.tipo === "saida")) }; });
  }
  if (nome === "empresas") return emps.map((e: any) => ({ nome: e.nome, cnpj: e.cnpj, ativo: e.ativo }));
  if (nome === "apontar_depois") {
    const l = await tudo(() => sb.from("movimentos").select("descricao,fornecedor,valor,data_movimento,tipo").is("empresa_id", null).eq("pessoal", false));
    return { quantidade: l.length, total_saidas: soma(l.filter((x: any) => x.tipo === "saida")), total_entradas: soma(l.filter((x: any) => x.tipo === "entrada")),
      maiores: l.sort((x: any, y: any) => +y.valor - +x.valor).slice(0, 10).map((x: any) => ({ desc: x.fornecedor || x.descricao, valor: +x.valor, data: x.data_movimento, tipo: x.tipo })) };
  }
  if (nome === "contas_cartoes") {
    const { data: os } = await sb.from("origens").select("id,nome,tipo,empresa_id");
    const m = a.mes || mesAtual(), l = await tudo(() => sb.from("movimentos").select("origem_id,tipo,valor").eq("pessoal", false).gte("data_movimento", m + "-01").lte("data_movimento", fimMes(m)));
    return (os || []).map((o: any) => { const x = l.filter((y: any) => y.origem_id === o.id); return { nome: o.nome, tipo: o.tipo, empresa: o.empresa_id ? nomeE(o.empresa_id) : "várias", mes: m, entradas: soma(x.filter((y: any) => y.tipo === "entrada")), saidas: soma(x.filter((y: any) => y.tipo === "saida")), lancamentos: x.length }; });
  }
  if (nome === "escala") return (await plantoesDoDia(a.data)).map((p) => ({ plantao: rotPlantao(p), cirurgiao: p.cirurgiao }));
  if (nome === "plantoes") {
    const m = a.mes || mesAtual();
    let q = sb.from("esc_dias").select("id,data,turno,local_id,anestesista_id,valor,empresa_id,status,pago,validacao,grupo,servico").gte("data", m + "-01").lte("data", fimMes(m));
    if (a.grupo) q = q.eq("grupo", a.grupo);
    const dias = (await q).data || [];
    const { data: locais } = await sb.from("esc_locais").select("id,hospital,unidade"); const { data: anes } = await sb.from("esc_anestesistas").select("id,nome");
    let l = dias.filter((d: any) => d.status !== "cancelado").map((d: any) => { const lo: any = (locais || []).find((x: any) => x.id === d.local_id) || {}; return { ...d, hospital: lo.hospital || lo.unidade || "—", unidade: lo.unidade, anestesista: (anes || []).find((x: any) => x.id === d.anestesista_id)?.nome || "sem anestesista" }; });
    if (a.anestesista) l = l.filter((d: any) => norm(d.anestesista).includes(norm(a.anestesista)));
    if (a.hospital) l = l.filter((d: any) => norm(d.hospital + " " + (d.unidade || "")).includes(norm(a.hospital)));
    const { data: pr } = await sb.from("esc_procedimentos").select("dia_id").in("dia_id", l.map((d: any) => d.id).slice(0, 900));
    const hoje = hojeBahia();
    return { mes: m, plantoes: l.length, valor_total: soma(l), confirmados_fiz: l.filter((d: any) => d.validacao === "fiz").length, nao_fiz: l.filter((d: any) => d.validacao === "nao_fiz").length,
      passados_sem_confirmacao: l.filter((d: any) => !d.validacao && d.data <= hoje && d.anestesista_id).length, pagos: l.filter((d: any) => d.pago).length, valor_pago: soma(l.filter((d: any) => d.pago)),
      sem_cnpj_pagador: l.filter((d: any) => !d.empresa_id).length, sem_anestesista: l.filter((d: any) => !d.anestesista_id).length, com_procedimentos: new Set((pr || []).map((x: any) => x.dia_id)).size,
      por_anestesista: Object.entries(l.reduce((o: any, d: any) => { o[d.anestesista] = o[d.anestesista] || { plantoes: 0, valor: 0 }; o[d.anestesista].plantoes++; o[d.anestesista].valor += +d.valor || 0; return o; }, {})).slice(0, 30),
      lista: l.length <= 40 ? l.map((d: any) => ({ data: d.data, hospital: d.hospital, turno: d.turno, anestesista: d.anestesista, valor: d.valor, pago: d.pago, confirmacao: d.validacao })) : "lista grande — peça filtro" };
  }
  if (nome === "anestesistas") { const { data } = await sb.from("esc_anestesistas").select("nome,grupo,valor_dia,ativo").order("nome"); return data || []; }
  if (nome === "hospitais") {
    const { data } = await sb.from("esc_hospitais").select("nome,forma_pagamento,prazo_tipo,prazo_dias,prazo_dia_mes,valor_dia,valor_m,valor_t,valor_n,valor_mensal,servicos,ativo,cnpj").order("nome");
    return (data || []).filter((h: any) => !a.nome || norm(h.nome).includes(norm(a.nome))).map((h: any) => ({ ...h, servicos: (h.servicos || []).map((s: any) => ({ nome: s.nome, sigla: s.sigla, valor: s.valor })) }));
  }
  if (nome === "saldo_terceirizado") { const { data } = await sb.from("fin_saldo_mov").select("tipo,valor,data,descricao,recebedor").order("data"); const l = data || [];
    const partida = soma(l.filter((x: any) => x.tipo === "partida")), saidas = soma(l.filter((x: any) => x.tipo === "saida")), entradas = soma(l.filter((x: any) => x.tipo === "entrada"));
    return { partida, entradas, saidas, saldo: Math.round((partida + entradas - saidas) * 100) / 100, ultimas_saidas: l.filter((x: any) => x.tipo === "saida").slice(-5) }; }
  if (nome === "idad") {
    const idad = emps.find((e: any) => so(e.cnpj) === "33231594000109"), m = a.mes || mesAtual();
    if (a.assunto === "financeiro") {
      const l = await tudo(() => sb.from("movimentos").select("tipo,valor,pago,vencimento,data_pagamento,categoria,conferir,fornecedor,descricao").eq("empresa_id", idad.id).eq("pessoal", false));
      const noMes = l.filter((x: any) => String(x.data_pagamento || x.vencimento || "").slice(0, 7) === m && !/^Transfer/.test(x.categoria || ""));
      const hoje = hojeBahia();
      return { mes: m, recebido: soma(noMes.filter((x: any) => x.tipo === "entrada" && x.pago)), pago: soma(noMes.filter((x: any) => x.tipo === "saida" && x.pago)), a_pagar_no_mes: soma(noMes.filter((x: any) => x.tipo === "saida" && !x.pago)),
        vencidas: l.filter((x: any) => x.tipo === "saida" && !x.pago && x.vencimento && x.vencimento < hoje).map((x: any) => ({ desc: x.fornecedor || x.descricao, valor: +x.valor, vencimento: x.vencimento })).slice(0, 20),
        a_conferir: l.filter((x: any) => x.conferir).length, saidas_sem_categoria_no_mes: noMes.filter((x: any) => x.tipo === "saida" && !x.categoria).length };
    }
    if (a.assunto === "conciliacao") {
      const li = await tudo(() => sb.from("idad_conc_linhas").select("fonte,forma,parte_medico,parte_idad,valor_bruto,valor_liquido,data").eq("empresa_id", idad.id).gte("data", m + "-01").lte("data", fimMes(m)));
      const px = li.filter((x: any) => x.fonte === "pixeon"), st = li.filter((x: any) => x.fonte === "stone");
      const { count } = await sb.from("idad_conc_justificativas").select("id", { count: "exact", head: true }).gte("data", m + "-01").lte("data", fimMes(m));
      return { mes: m, relatorio_recepcao: px.length ? { itens: px.length, atendido: soma(px, "valor_bruto"), parte_medicos: soma(px, "parte_medico"), parte_idad: soma(px, "parte_idad") } : "não importado",
        stone: st.length ? { vendas: st.length, bruto: soma(st, "valor_bruto"), liquido: soma(st, "valor_liquido") } : "não importado", justificativas_gravadas: count || 0,
        obs: "As pendências dia a dia ficam na tela Hospital IDAD › Conciliação." };
    }
    if (a.assunto === "convenios") {
      const { data } = await sb.from("idad_convenios").select("convenio,procedimento,especialidade,valor_total,valor_medico,valor_hospital,situacao,vigencia_inicio,vigencia_fim");
      return (data || []).filter((c: any) => !c.vigencia_fim && (!a.convenio || norm(c.convenio).includes(norm(a.convenio))) && (!a.procedimento || norm(c.procedimento).includes(norm(a.procedimento)))).slice(0, 40);
    }
    if (a.assunto === "estoque") {
      const { data: it } = await sb.from("idad_itens").select("id,setor,nome,unidade,estoque_min").eq("ativo", true); const mv = await tudo(() => sb.from("idad_movs").select("item_id,tipo,qtd,validade"));
      const hoje = hojeBahia();
      const l = (it || []).map((i: any) => { const x = mv.filter((y: any) => y.item_id === i.id); const saldo = x.reduce((s: number, y: any) => s + (y.tipo === "entrada" ? +y.qtd : -(+y.qtd)), 0); return { ...i, saldo }; });
      return { itens: l.length, abaixo_do_minimo: l.filter((i: any) => i.estoque_min != null && i.saldo < +i.estoque_min).map((i: any) => ({ setor: i.setor, item: i.nome, saldo: i.saldo, minimo: i.estoque_min })),
        lotes_vencidos: mv.filter((y: any) => y.tipo === "entrada" && y.validade && y.validade < hoje).length };
    }
    if (a.assunto === "obra") { const { data } = await sb.from("idad_obra").select("valor,pago,etapa,categoria"); const l = data || [];
      return { lancamentos: l.length, total: soma(l), pago: soma(l.filter((x: any) => x.pago)), a_pagar: soma(l.filter((x: any) => !x.pago)), por_etapa: Object.entries(l.reduce((o: any, x: any) => { o[x.etapa || "—"] = (o[x.etapa || "—"] || 0) + (+x.valor || 0); return o; }, {})) }; }
    if (a.assunto === "pacientes") { const { count } = await sb.from("idad_pacientes").select("id", { count: "exact", head: true }); return { pacientes_cadastrados: count || 0 }; }
    if (a.assunto === "fichario") { const l = await tudo(() => sb.from("fichas").select("data_consulta,convenio,valor_total").gte("data_consulta", m + "-01").lte("data_consulta", fimMes(m)));
      return { mes: m, fichas: l.length, com_convenio: l.filter((x: any) => x.convenio).length, valor_total_tabela: soma(l, "valor_total"), por_convenio: Object.entries(l.reduce((o: any, x: any) => { const k = x.convenio || "sem convênio"; o[k] = (o[k] || 0) + 1; return o; }, {})) }; }
  }
  if (nome === "usuarios") { const { data } = await sb.from("perfis").select("nome,papel,ativo").order("papel"); return (data || []).map((p: any) => ({ nome: p.nome, papel: p.papel === "adm1" ? "ADM_Nivel 1" : p.papel, ativo: p.ativo })); }
  return { erro: "ferramenta desconhecida" };
}
const FIXO = `Você é o Vini, assistente do Sistema MR (contas por empresa, escala de anestesia da NAFS e Hospital IDAD) no WhatsApp. Fala português do Brasil, curto e direto, como um funcionário de confiança. Use as ferramentas para responder com dados reais; nunca invente valores. Nunca diga que fez, lançou ou registrou algo se não usou uma ferramenta para isso. Por conversa você só altera uma coisa: o DESTINO de contas e compras (de qual CNPJ, obra do IDAD ou pessoal), com as ferramentas buscar_lancamentos e direcionar_lancamentos, quando elas estiverem disponíveis para a pessoa. Lançamentos novos só por foto ou PDF; o resto é pelo sistema. Formate para WhatsApp (*negrito*, listas curtas). Responda sempre em português, só a resposta final (nada de rascunho). Não assine. Se a pergunta for vaga, use o mês atual. Se o sistema não tiver o dado, diga isso claramente. Se não souber responder ou fazer o que pediram, NUNCA deixe a pessoa sem resposta: diga que vai passar para a equipe técnica.
ÁUDIO: você OUVE áudios — mensagens que começam com 🎤 são áudios que a pessoa gravou, já transcritos para você. E você FALA: quando a pessoa manda áudio ou pede resposta em áudio, o sistema transforma a sua resposta em nota de voz automaticamente. Nunca diga que não ouve ou não manda áudio. Se a transcrição vier confusa, peça para repetir.
FATURAS DE CARTÃO: você SABE lançar fatura. A pessoa manda a fatura em PDF ou foto; você lê e, se for o PDF da fatura e a soma bater 100% com o total, lança sozinho no "Apontar depois" (sem pedir SIM) e avisa "fatura lida e 100%"; se não bater, mostra e pede SIM. A separação (obra do IDAD, pessoal ou CNPJ) é feita em Financeiro › Cartões e compras, na aba do cartão. Se pedirem para lançar/organizar uma fatura, peça o PDF da fatura.
DIRECIONAR: quando a pessoa disser de quem/qual CNPJ é uma conta ou compra (ex.: \"a Leo Madeiras do cartão da Carol é da obra\", \"pix do Reinildo é da NAFS\", \"fatura do Marcus toda pro CMVR\"), primeiro busque (buscar_lancamentos) e depois EXECUTE (direcionar_lancamentos) sem pedir confirmação — a decisão do dono é executar direto e avisar. Se a busca achar coisas demais ou não ficar claro quais são, pergunte antes. Depois conte o que fez (quantos, para onde, total) e lembre que dá para pedir \"desfaz\". Nunca mostre despesas pessoais de ninguém.\nRECADOS: se a ferramenta enviar_recado estiver disponível para você, você PODE chamar/avisar pessoas cadastradas no WhatsApp quando pedirem — use a ferramenta (nunca diga que não consegue). Sem ela, diga que mandar recado não está liberado para essa pessoa.\n\n${MAPA}`;
const PALAVRAS_EN = /\b(the|and|with|will|this|that|let me|tool|function|I'll|I am|here is|you)\b/gi;
async function conversa(chat: string, contato: any, texto: string, grupo = false) {
  // v7: o WhatsApp pode usar um id "@lid" na conversa; junta também o que o Vini mandou para o número da pessoa
  const chats = [chat, ...variantes(so(contato.telefone)).map((v) => v + "@s.whatsapp.net")];
  const { data: hist } = await sb.from("vini_mensagens").select("direcao,texto").in("chat", grupo ? [chat] : chats).order("em", { ascending: false }).limit(8);
  // ferramentas liberadas: grupo só escala; contato com lista própria (vini_contatos.ferramentas) só a lista
  const lista: string[] | null = grupo ? ["escala", "anestesistas"] : (Array.isArray(contato.ferramentas) && contato.ferramentas.length ? contato.ferramentas : null);
  const podeDir = !grupo && (contato.pode_lancar || contato.pode_fatura || contato.pode_direcionar);   // v19
  const base = TOOLS.filter((t: any) => (!NAVEGA.includes(t.function.name) || (contato.pode_navegar && !grupo)) && (!RECADO.includes(t.function.name) || (contato.pode_mandar && !grupo)) && (!DIRECIONA.includes(t.function.name) || podeDir));
  const liberadas = lista ? base.filter((t: any) => lista.includes(t.function.name) || RECADO.includes(t.function.name) || DIRECIONA.includes(t.function.name)) : base;
  // v10 (cache): instruções fixas primeiro; o que muda vai numa mensagem de sistema depois do histórico, antes da pergunta
  const msgs: any[] = [{ role: "system", content: FIXO }];
  (hist || []).reverse().forEach((h: any) => h.texto && msgs.push({ role: h.direcao === "entrada" ? "user" : "assistant", content: h.texto.replace(ASSINA, "") }));
  const limpa = (s: string) => String(s || "").replace(/^🎤\s*/u, "").trim();
  if (msgs.length > 1 && msgs[msgs.length - 1].role === "user" && limpa(msgs[msgs.length - 1].content) === limpa(texto)) msgs.pop();
  let varia = `Hoje é ${dbr(hojeBahia())}. Está falando com ${contato.nome}.`;
  if (grupo) varia += "\nATENÇÃO: você está num GRUPO. NUNCA fale de valores, financeiro, pagamentos ou saldos aqui — se perguntarem, diga que isso você só responde no privado.";
  if (lista && !grupo) varia += `\nACESSO RESTRITO: ${contato.nome} só pode consultar: ${lista.join(", ")}. Sobre qualquer outro assunto do sistema (outros CNPJs, NAFS, salários etc.), diga educadamente que essa informação não está liberada para ela/ele.`;
  varia += `\n\nREGRAS APRENDIDAS:\n${await regras()}`;
  msgs.push({ role: "system", content: varia }, { role: "user", content: texto });
  const ctx = { chat, quem: contato.nome, pergunta: texto };
  let usouFerramenta = false;
  for (let i = 0; i < 6; i++) {
    const m = await ia(msgs, liberadas, false, MODELO_CONVERSA, ctx);
    if (!m?.tool_calls?.length) {
      const resp = String(m?.content || "Não entendi. Pode repetir?");
      // v10: o Vini anota os próprios deslizes para a equipe técnica corrigir
      if (!usouFerramenta && /\b(lancei|lançad[oa]s?|registrei|gravei|atualizei|cadastrei|enviei|marquei|preenchi|corrigi)\b/i.test(resp)) await erro("disse_sem_fazer", { ...ctx, detalhe: resp });
      if ((resp.match(PALAVRAS_EN) || []).length >= 4) await erro("rascunho_ingles", { ...ctx, detalhe: resp });
      return resp;
    }
    msgs.push(m);
    for (const tc of m.tool_calls) {
      let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch { /* */ }
      usouFerramenta = true;
      let res: any;
      if (!liberadas.some((t: any) => t.function.name === tc.function.name)) res = { erro: "não liberado para este contato" };
      else {
        try { res = NAVEGA.includes(tc.function.name) ? await navegar(tc.function.name, a, { chat, contato }) : RECADO.includes(tc.function.name) ? await enviarRecado(a, { chat, contato }) : DIRECIONA.includes(tc.function.name) ? await direcionar(tc.function.name, a, { chat, contato }) : await ferramenta(tc.function.name, a); }
        catch (e) { res = { erro: "a consulta falhou" }; await erro("ferramenta_falhou", { ...ctx, ferramenta: tc.function.name, detalhe: `${(e as Error).message} | args: ${JSON.stringify(a).slice(0, 300)}` }); }
        if (res && !Array.isArray(res) && res.erro && !String(res.erro).startsWith("não liberado")) await erro("ferramenta_erro", { ...ctx, ferramenta: tc.function.name, detalhe: `${res.erro} | args: ${JSON.stringify(a).slice(0, 300)}` });
      }
      msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(res).slice(0, 12000) });
    }
  }
  await erro("ferramenta_erro", { ...ctx, detalhe: "não fechou a resposta em 6 rodadas" });
  return "Não consegui fechar a resposta. Pode perguntar de outro jeito?";
}

/* ---------- v9 (20/11/2026): LOTE DE FOTOS, ESCALA, DÚVIDAS E APRENDIZADO ----------
   Pedido do Renato: o Vini nunca descarta um documento. Se não conhece, pergunta a quem mandou o que fazer.
   Se não souber executar a resposta, sobe para a equipe técnica (Claude, tarefa agendada); se ela não resolver em 2 h,
   sobe para o Renato. O que for ensinado vira regra (vini_conhecimento) e entra no cérebro do Vini.
   v12: PDF entra no mesmo lote das fotos (lido pela IA como arquivo). */
async function regras(): Promise<string> {
  const { data } = await sb.from("vini_conhecimento").select("assunto,regra").eq("ativo", true).order("id");
  return (data || []).map((r: any, i: number) => `${i + 1}. [${r.assunto}] ${r.regra}`).join("\n");
}
const PROMPT_DOC = (rg: string) => `Voce recebe a FOTO ou o PDF de um documento enviado ao Vini (assistente do Sistema MR: escala de anestesistas NAFS/Anestesia, producao cirurgica, Hospital IDAD).
Classifique e extraia. Responda SOMENTE JSON:
{"tipo":"escala|producao|fatura|nota|outro","data":"AAAA-MM-DD ou null","hospital":"","cirurgiao":"",
 "nota":{"emitente":"razao social de quem vendeu","cnpj_emitente":"so numeros","numero":"numero da NF","valor":0,"parcelas":1,"final_cartao":"4 digitos ou vazio"},
 "escala":[{"local":"nome do local/hospital como escrito","turno":"M|T|N|SN|","anestesista":"nome","vermelho":false}],
 "itens":[{"paciente":"","idade":null,"procedimento":"","situacao":"realizado|cancelado","obs":""}],
 "resumo":"1 frase dizendo que documento e este (sem CPF, sem endereco)"}
- escala: tabela de anestesistas x locais/turnos de um dia (preencha "escala").
- producao: mapa cirurgico, lista de cirurgias, ficha/descricao cirurgica ou relatorio de procedimentos de UM paciente ou de varios (preencha "itens"; linha riscada = cancelado).
- fatura: FATURA DE CARTAO DE CREDITO (lista de compras do cartao com total da fatura e vencimento). Extrato de conta bancaria NAO e fatura (use outro).
- nota: NOTA FISCAL / DANFE / cupom fiscal de uma COMPRA (loja vendendo mercadoria ou servico). Preencha "nota" com o VALOR TOTAL DA NOTA, a data de emissao em "data", o numero de parcelas (ex.: CARTAO X6 = 6) e o final do cartao se aparecer no comprovante da maquininha.
- outro: qualquer outra coisa (pedido de exame, guia, recibo, conversa...). Descreva bem no resumo.
REGRAS APRENDIDAS (siga):
${rg || "(nenhuma)"}`;
async function lerDoc(b64: string, mime: string, legenda: string, rg: string) {
  const anexo = /pdf/i.test(mime)
    ? { type: "file", file: { filename: "documento.pdf", file_data: `data:application/pdf;base64,${b64}` } }
    : { type: "image_url", image_url: { url: `data:${mime};base64,${b64}`, detail: "high" } };
  const msg = await ia([{ role: "user", content: [{ type: "text", text: PROMPT_DOC(rg) + (legenda ? `\n\nTEXTO QUE A PESSOA MANDOU JUNTO: ${legenda}` : "") }, anexo] }], undefined, true);
  try { return JSON.parse(String(msg?.content || "").replace(/^```json|```$/g, "")); } catch { return { tipo: "outro", resumo: "não consegui ler o documento" }; }
}

/* ---------- v20: CONSOLIDAÇÃO — nota fiscal casa com a compra do cartão (regra igual à do CPE v130) ---------- */
const parcNum = (d: string) => { const p = String(d || "").match(/PARC\w*\.?\s*(\d{1,2})\s*(?:\/|DE)\s*(\d{1,2})/i); return p && +p[2] > 1 ? [+p[1], +p[2]] : null; };
const nomeParecido = (a: string, b: string) => { const n = (s: string) => norm(s).split(" ").filter((w) => w.length >= 3 && !/^(LTDA|COM|MAT|PARC|FEIRA|SANT|SAN|DE|DA|DO)$/.test(w)); const A = n(a), B = n(b); return A.some((w) => B.some((x) => x.startsWith(w) || w.startsWith(x))); };
async function consolidarNota(n: any, foto: string, autor: string): Promise<string> {
  const valor = Math.round((+n.valor || 0) * 100) / 100, data = n.data, tol = Math.max(0.10, valor * 0.002);
  const rot = `*${n.emitente || "Nota"}*${n.numero ? " · NF " + n.numero : ""} · ${brl(valor)}${data ? " · " + dbr(data) : ""}`;
  if (!valor) return `❓ ${rot}: não consegui ler o valor da nota.`;
  const { data: cartoes } = await sb.from("origens").select("id,nome,titular,banco,identificador").eq("tipo", "cartao");
  const ids = (cartoes || []).map((o: any) => o.id);
  let q = sb.from("movimentos").select("id,origem_id,descricao,fornecedor,valor,data_movimento,tipo,nota_id").in("origem_id", ids).is("nota_id", null).neq("tipo", "entrada");
  if (data) { const d0 = new Date(Date.parse(data) - 5 * 864e5).toISOString().slice(0, 10), d1 = new Date(Date.parse(data) + 5 * 864e5).toISOString().slice(0, 10); q = q.gte("data_movimento", d0).lte("data_movimento", d1); }
  const movs = await tudo(() => q);
  const g: Record<string, any> = {};
  for (const m of movs) {
    const pn = parcNum(m.descricao), total = pn ? (+m.valor) * pn[1] : +m.valor;
    if (Math.abs(total - valor) > tol) continue;
    const base = String(m.fornecedor || m.descricao || "").replace(/\s*PARC\w*\.?\s*\d+\s*(\/|DE)\s*\d+.*$/i, "").trim();
    const k = m.origem_id + "|" + base + "|" + (pn ? pn[1] : 1) + "|" + (+m.valor).toFixed(2);
    const o: any = (cartoes || []).find((x: any) => x.id === m.origem_id) || {};
    (g[k] = g[k] || { o, base, parc: pn ? pn[1] : 1, valor: +m.valor, total, movs: [], nomeOk: nomeParecido(base, n.emitente || ""), finalOk: !!n.final_cartao && so(n.final_cartao).slice(-4) === String(o.identificador || "") }).movs.push(m);
  }
  const c = Object.values(g).sort((a: any, b: any) => (b.finalOk - a.finalOk) || (b.nomeOk - a.nomeOk) || (Math.abs(a.total - valor) - Math.abs(b.total - valor)));
  const top: any = c[0], forte = top && (c.length === 1 || (top.finalOk && !(c[1] as any).finalOk) || (top.nomeOk && !(c[1] as any).nomeOk));
  const reg: any = { emitente: n.emitente || null, cnpj_emitente: so(n.cnpj_emitente) || null, numero: n.numero ? String(n.numero) : null, data: data || null, valor, final_cartao: so(n.final_cartao).slice(-4) || null, path: foto, nome: "nota pelo WhatsApp", via: "vini", status: forte ? "casada" : "sem_compra" };
  const { data: nt, error } = await sb.from("cartao_notas").insert(reg).select("id").single();
  if (error) return `⚠️ ${rot}: não consegui guardar a nota (${error.message}).`;
  if (!forte) return `⏳ ${rot}: ${c.length ? c.length + " compras parecidas nos cartões — confira em Cartões e compras." : "ainda não achei a compra em nenhum cartão. Guardei a nota e tento de novo quando chegar fatura nova."}`;
  await sb.from("movimentos").update({ nota_id: nt.id }).in("id", top.movs.map((m: any) => m.id));
  await sb.from("cartao_notas").update({ movimento_ids: top.movs.map((m: any) => m.id) }).eq("id", nt.id);
  const cart = `${top.o.titular || top.o.nome || "cartão"}${top.o.banco ? " " + top.o.banco : ""}${top.o.identificador ? " final " + top.o.identificador : ""}`;
  return `✅ ${rot}: *nota casada* com ${top.base} no cartão ${cart} — ${top.parc > 1 ? top.parc + "× " + brl(top.valor) + " = " : ""}${brl(top.total)}. Consolidada.`;
}
async function baixar(path: string) {
  const { data } = await sb.storage.from("notas").download(path); if (!data) return null;
  return bytesB64(new Uint8Array(await data.arrayBuffer()));
}
// foto (ou PDF) chegou: guarda e espera ~20 s; quem processa é o último arquivo da sequência
async function receberFoto(b: any, chat: string, autor: string, contato: any): Promise<string[]> {
  const mime = b.midia.mime || "image/jpeg", ext = /pdf/i.test(mime) ? "pdf" : /png/i.test(mime) ? "png" : "jpg";
  const path = `vini/entrada/${crypto.randomUUID()}.${ext}`;
  await sb.storage.from("notas").upload(path, b64bytes(b.midia.b64), { contentType: mime });
  const legenda = String(b.texto || "").trim() || null;
  const { data: ant } = await sb.from("vini_lote").select("id").eq("chat", chat).eq("processado", false).gte("em", new Date(Date.now() - 3 * 60e3).toISOString()).limit(1);
  const { data: eu } = await sb.from("vini_lote").insert({ chat, autor, foto_path: path, mime, legenda }).select("id").single();
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil((async () => {
    await new Promise((r) => setTimeout(r, 22000));
    const { data: depois } = await sb.from("vini_lote").select("id").eq("chat", chat).eq("processado", false).gt("id", eu.id).limit(1);
    if (depois?.length) return;                                      // chegou outro arquivo: o último processa
    try { await processarLote(chat, autor, contato); } catch (e) { await sb.from("vini_saida").insert({ chat, texto: "Tive um problema lendo os arquivos: " + String((e as Error).message).slice(0, 150) + ". Pode mandar de novo?" }); }
  })());
  return ant?.length ? [] : [ext === "pdf" ? "📥 Recebi o PDF, estou lendo… Se tiver mais arquivos, pode mandar que eu leio tudo junto e te respondo com um resumo." : "📥 Recebendo… pode mandar todas as fotos. Quando terminar eu leio tudo junto e te respondo com um resumo."];
}
const turnoOk = (a: string, b: string) => !a || !b || a === b || (a === "SN" || b === "SN");
async function processarLote(chat: string, autor: string, contato: any) {
  const { data: fotos } = await sb.from("vini_lote").select("*").eq("chat", chat).eq("processado", false).order("id");
  if (!fotos?.length) return;
  await sb.from("vini_lote").update({ processado: true }).in("id", fotos.map((f: any) => f.id));
  const rg = await regras();
  const { data: locais } = await sb.from("esc_locais").select("id,hospital,unidade");
  const { data: anes } = await sb.from("esc_anestesistas").select("id,nome,ativo");
  const nomeLocal = (id: string) => { const l: any = (locais || []).find((x: any) => x.id === id) || {}; return l.hospital || l.unidade || "—"; };
  const preencher: any[] = [], producao: any[] = [], linhasEsc: string[] = [], linhasProd: string[] = [], duvidas: any[] = [];
  let n = 0, nPdf = 0;
  const faturas: any[] = [];   // v14
  const linhasNotas: string[] = [];   // v20
  for (const f of fotos) {
    const b64 = await baixar(f.foto_path); if (!b64) continue;
    const d: any = await lerDoc(b64, f.mime, f.legenda || "", rg); n++; if (/pdf/i.test(f.mime || "")) nPdf++;
    const data = /^\d{4}-\d{2}-\d{2}$/.test(d?.data || "") ? d.data : null;
    if (d.tipo === "fatura") { faturas.push({ f, b64 }); continue; }   // v14: fatura de cartão tem fluxo próprio
    if (d.tipo === "nota" && d.nota && (contato.pode_lancar || contato.pode_fatura || contato.pode_direcionar)) {   // v20
      try { linhasNotas.push(await consolidarNota({ ...d.nota, data }, f.foto_path, autor)); } catch (e) { linhasNotas.push(`⚠️ Nota: ${(e as Error).message}`); }
      continue;
    }
    if (d.tipo === "escala" && Array.isArray(d.escala) && data) {
      const ps = await plantoesDoDia(data);
      linhasEsc.push(`*Escala de ${dbr(data)}*`);
      for (const e of d.escala.filter((x: any) => !x.vermelho && x.anestesista)) {
        const ln = norm(e.local), t = String(e.turno || "").toUpperCase();
        const cand = ps.filter((p: any) => { const h = norm(p.hospital); return h && (h === ln || h.includes(ln) || ln.includes(h)) && turnoOk(String(p.turno || ""), t); });
        const an = norm(e.anestesista), ac = (anes || []).filter((a: any) => a.ativo !== false && (norm(a.nome) === an || norm(a.nome).startsWith(an + " ") || norm(a.nome).split(" ")[0] === an.split(" ")[0]));
        const rot = `${e.local}${t ? " (" + t + ")" : ""} — ${e.anestesista}`;
        if (!cand.length) { linhasEsc.push(`❓ ${rot}: não achei esse plantão na escala do sistema`); continue; }
        const p = cand[0];
        if (p.anestesista_id) { const ok = ac.some((a: any) => a.id === p.anestesista_id); linhasEsc.push(ok ? `✅ ${rot}` : `⚠️ ${rot}: no sistema está *${p.anestesista}* (não mudei)`); continue; }
        if (ac.length !== 1) { linhasEsc.push(`❓ ${rot}: ${ac.length ? "mais de um anestesista com esse nome" : "anestesista não cadastrado"}`); continue; }
        preencher.push({ dia_id: p.id, anestesista_id: ac[0].id, rot: `${nomeLocal(p.local_id)}${p.turno ? " (" + p.turno + ")" : ""} → ${ac[0].nome}` });
        linhasEsc.push(`➕ ${rot}: plantão está *sem anestesista* — vou preencher com ${ac[0].nome}`);
      }
      continue;
    }
    if (d.tipo === "producao" && Array.isArray(d.itens) && d.itens.length) {
      const itens = d.itens.filter((x: any) => x?.procedimento).map((x: any) => ({ paciente: String(x.paciente || "").slice(0, 120), idade: Number.isFinite(+x.idade) && x.idade !== null ? Math.round(+x.idade) : null, procedimento: String(x.procedimento).slice(0, 160), situacao: x.situacao === "cancelado" ? "cancelado" : "realizado", obs: String(x.obs || "").slice(0, 120) }));
      const rot = `${d.hospital || "hospital?"} · ${data ? dbr(data) : "sem data"} · ${itens.map((x: any) => x.procedimento).join(" + ").slice(0, 90)}`;
      let cand: any[] = [];
      if (data) { const ps = await plantoesDoDia(data), hn = norm(d.hospital || ""); cand = hn ? ps.filter((p: any) => { const a = norm(p.hospital); return a && (a.includes(hn) || hn.includes(a) || a.split(" ").some((w: string) => w.length >= 4 && hn.includes(w))); }) : []; }
      const velha = data && (Date.parse(hojeBahia()) - Date.parse(data)) > 7 * 864e5;
      if (cand.length === 1 && !velha) { producao.push({ dia_id: cand[0].id, itens, foto: f.foto_path, rot: rotPlantao(cand[0]), cad: cand[0].cad?.servicos || [] }); linhasProd.push(`➕ ${rot} → plantão *${rotPlantao(cand[0])}*`); continue; }
      const motivo = !data ? "não consegui ver a data" : velha ? `a data da ficha é ${dbr(data)} (mais de 7 dias atrás)` : cand.length ? `há ${cand.length} plantões possíveis nesse dia` : `não achei plantão de ${d.hospital || "esse hospital"} em ${dbr(data)} na escala`;
      linhasProd.push(`❓ ${rot}: ${motivo}`);
      duvidas.push({ resumo: `Ficha de produção: ${rot}`, dados: { tipo: "producao", data, hospital: d.hospital, cirurgiao: d.cirurgiao, itens, candidatos: cand.map((p: any) => ({ id: p.id, rot: rotPlantao(p), servicos: p.cad?.servicos || [] })) }, foto: f.foto_path,
        pergunta: `Sobre a ficha *${rot}*: ${motivo}. Em qual plantão eu lanço (data, hospital e anestesista)? Ou devo ignorar?` });
      continue;
    }
    duvidas.push({ resumo: `Documento: ${d.resumo || "não identificado"}${f.legenda ? ` — você escreveu: "${f.legenda}"` : ""}`, dados: { tipo: d.tipo || "outro", data, hospital: d.hospital, itens: d.itens || [], legenda: f.legenda }, foto: f.foto_path,
      pergunta: `Recebi um documento que ainda não sei tratar: *${d.resumo || "não identificado"}*${f.legenda ? ` (você escreveu: "${f.legenda}")` : ""}. O que você quer que eu faça com ele?` });
  }
  // v14: fatura de cartão → resumo próprio com SIM (uma por vez)
  if (faturas.length && !preencher.length && !producao.length) {
    try { await prepararFatura(chat, autor, faturas[0].f, faturas[0].b64, faturas.slice(1).map((x: any) => ({ foto_path: x.f.foto_path, mime: x.f.mime }))); }
    catch (e) { await sb.from("vini_saida").insert({ chat, texto: "Tive um problema lendo a fatura: " + String((e as Error).message).slice(0, 150) + ". Pode mandar de novo?" }); await erro("ferramenta_falhou", { chat, quem: contato.nome, ferramenta: "fatura", detalhe: (e as Error).stack || (e as Error).message }); }
    if (!linhasEsc.length && !linhasProd.length && !duvidas.length && !linhasNotas.length) return;
  } else if (faturas.length) linhasProd.push(`💳 Recebi também ${faturas.length} fatura(s) de cartão: mande de novo depois de responder este resumo, que eu lanço.`);
  const nFoto = n - nPdf;
  let t = `📋 *Li ${[nFoto ? nFoto + " foto(s)" : "", nPdf ? nPdf + " PDF(s)" : ""].filter(Boolean).join(" e ") || "0 arquivo(s)"}.*\n`;
  if (linhasEsc.length) t += "\n" + linhasEsc.join("\n") + "\n";
  if (linhasProd.length) t += "\n*Produção*\n" + linhasProd.join("\n") + "\n";
  if (linhasNotas.length) t += "\n*Notas (consolidação dos cartões)*\n" + linhasNotas.join("\n") + "\n";
  for (const q of duvidas) await sb.from("vini_duvidas").insert({ chat, autor, autor_nome: contato.nome, tipo: "documento", resumo: q.resumo, dados: q.dados, foto_path: q.foto, pergunta: q.pergunta });
  if (preencher.length || producao.length) {
    await sb.from("vini_acoes").update({ status: "expirada", resolvido_em: new Date().toISOString() }).eq("chat", chat).eq("status", "aguardando");
    await sb.from("vini_acoes").insert({ chat, autor, tipo: "lote", dados: { preencher, producao } });
    t += `\nPosso fazer o que está com ➕ (${preencher.length} anestesista(s) na escala, ${producao.length} ficha(s) de produção)? Responda *SIM* ou *NÃO*.`;
    if (duvidas.length) t += `\nDepois eu te pergunto sobre ${duvidas.length === 1 ? "o item com ❓" : "os " + duvidas.length + " itens com ❓"}, um de cada vez.`;
    await sb.from("vini_saida").insert({ chat, texto: t });
  } else {
    await sb.from("vini_saida").insert({ chat, texto: t + (duvidas.length ? `\nVou te perguntar sobre ${duvidas.length === 1 ? "o item com ❓" : "os " + duvidas.length + " itens com ❓"}, um de cada vez.` : "") });
    await proximaDuvida(chat);
  }
}
async function gravarLote(acao: any): Promise<string> {
  const d = acao.dados; let esc = 0, procs = 0; const avisos: string[] = [];
  for (const p of d.preencher || []) { const { data } = await sb.from("esc_dias").update({ anestesista_id: p.anestesista_id }).eq("id", p.dia_id).is("anestesista_id", null).select("id"); if (data?.length) esc++; else avisos.push(`${p.rot}: já tinha anestesista, não mudei`); }
  for (const p of d.producao || []) {
    try { const r = await gravarProducao({ dados: { itens: p.itens, foto: p.foto, dia_id: p.dia_id, candidatos: [{ id: p.dia_id, rot: p.rot, servicos: p.cad || [] }] } }); if (/^✅/.test(r)) procs++; else avisos.push(r); }
    catch (e) { avisos.push(`${p.rot}: ${(e as Error).message}`); }
  }
  return `✅ Feito: ${esc} anestesista(s) colocados na escala e ${procs} ficha(s) de produção lançadas.` + (avisos.length ? "\n" + avisos.map((a) => "⚠️ " + a).join("\n") : "");
}
// faz a próxima pergunta da fila (uma de cada vez)
async function proximaDuvida(chat: string) {
  const { data: ja } = await sb.from("vini_duvidas").select("id").eq("chat", chat).eq("status", "aguardando_pessoa").limit(1);
  if (ja?.length) return;
  const { data: q } = await sb.from("vini_duvidas").select("id,pergunta").eq("chat", chat).eq("status", "na_fila").order("id").limit(1).maybeSingle();
  if (!q) return;
  await sb.from("vini_duvidas").update({ status: "aguardando_pessoa", atualizado_em: new Date().toISOString() }).eq("id", q.id);
  await sb.from("vini_saida").insert({ chat, texto: `❓ *Dúvida #${q.id}*\n${q.pergunta}` });
}
// a pessoa (ou o Renato) respondeu uma dúvida: o Vini tenta executar; se não souber, sobe de nível
async function responderDuvida(dv: any, texto: string, chat: string, autor: string, contato: any, deRenato = false): Promise<string[]> {
  const rg = await regras(), dd = dv.dados || {};
  let cand = dd.candidatos || [];
  const prompt = `Voce e o Vini (Sistema MR). Voce perguntou a ${deRenato ? "Renato (dono do sistema)" : contato.nome} sobre um documento e recebeu a resposta. Decida o que fazer.
DOCUMENTO: ${dv.resumo}
LEITURA: ${JSON.stringify({ data: dd.data, hospital: dd.hospital, itens: (dd.itens || []).map((x: any) => x.procedimento), legenda: dd.legenda })}
PLANTOES POSSIVEIS (id e rotulo): ${JSON.stringify(cand.map((c: any) => ({ id: c.id, rot: c.rot })))}
SUA PERGUNTA: ${dv.pergunta}
RESPOSTA: ${texto}
O QUE VOCE SABE FAZER: (a) lancar a producao num plantao da escala (precisa de um plantao: id da lista ou uma data AAAA-MM-DD + hospital para eu procurar); (b) ignorar/arquivar o documento; (c) qualquer outra coisa voce NAO sabe fazer ainda.
REGRAS APRENDIDAS: ${rg}
Se a RESPOSTA nao tem nada a ver com a pergunta (a pessoa mudou de assunto), use "acao":"outro_assunto".
Responda SOMENTE JSON: {"acao":"lancar|ignorar|nao_sei|outro_assunto","dia_id":"id da lista ou null","data":"AAAA-MM-DD ou null","hospital":"","regra":"se a resposta ensina algo que vale para os proximos documentos, escreva a regra geral (como reconhecer + o que fazer); senao vazio","resposta":"frase curta para a pessoa"}`;
  const m = await ia([{ role: "user", content: prompt }], undefined, true, MODELO_CONVERSA, { chat, quem: contato.nome, pergunta: texto });
  let r: any = {}; try { r = JSON.parse(String(m?.content || "{}")); } catch { r = { acao: "nao_sei" }; }
  const agora = new Date().toISOString();
  if (r.acao === "outro_assunto" && !deRenato) return [await conversa(chat, contato, texto, false) + `\n\n_(Ainda espero sua resposta sobre a dúvida #${dv.id}.)_`];
  if (r.regra) await sb.from("vini_conhecimento").insert({ assunto: String(dv.resumo || "").slice(0, 80), regra: String(r.regra).slice(0, 600), origem: (deRenato ? "Renato" : contato.nome) + ` (dúvida #${dv.id})`, duvida_id: dv.id, ativo: deRenato });
  if (r.acao === "lancar" && (dd.itens || []).length) {
    if (!r.dia_id && r.data && /^\d{4}-\d{2}-\d{2}$/.test(r.data)) { const ps = await plantoesDoDia(r.data), hn = norm(r.hospital || dd.hospital || ""); const f = hn ? ps.filter((p: any) => { const a = norm(p.hospital); return a && (a.includes(hn) || hn.includes(a)); }) : ps; cand = f.map((p: any) => ({ id: p.id, rot: rotPlantao(p), servicos: p.cad?.servicos || [] })); }
    const dia = r.dia_id && cand.find((c: any) => c.id === r.dia_id) ? r.dia_id : (cand.length === 1 ? cand[0].id : null);
    if (cand.length) {
      await sb.from("vini_duvidas").update({ resposta: texto, status: "resolvida", solucao: "lançar produção", resolvido_por: deRenato ? "Renato" : contato.nome, resolvida_em: agora, atualizado_em: agora }).eq("id", dv.id);
      const dados = { itens: dd.itens, data: r.data || dd.data, hospital_lido: dd.hospital || "", cirurgiao: dd.cirurgiao || "", foto: dv.foto_path, candidatos: cand, dia_id: dia, duvida: dv.id };
      await sb.from("vini_acoes").update({ status: "expirada", resolvido_em: agora }).eq("chat", chat).eq("status", "aguardando");
      await sb.from("vini_acoes").insert({ chat, autor, tipo: "lancar_procedimentos", dados });
      if (deRenato && dv.chat !== chat) await sb.from("vini_saida").insert({ chat: dv.chat, texto: `✅ Sobre a dúvida #${dv.id}: o Renato me orientou e estou lançando com ele.` });
      return [resumoProducao(dados)];
    }
  }
  if (r.acao === "ignorar") {
    await sb.from("vini_duvidas").update({ resposta: texto, status: "resolvida", solucao: "ignorar", resolvido_por: deRenato ? "Renato" : contato.nome, resolvida_em: agora, atualizado_em: agora }).eq("id", dv.id);
    if (deRenato && dv.chat !== chat) await sb.from("vini_saida").insert({ chat: dv.chat, texto: `✅ Sobre a dúvida #${dv.id}: o Renato orientou deixar esse documento de lado.` });
    await proximaDuvida(dv.chat); return [r.resposta || "Ok, deixei esse documento de lado."];
  }
  // não sabe: sobe um nível (pessoa -> equipe técnica; equipe técnica/Renato -> Renato)
  const nivel = deRenato ? "renato" : "claude";
  await sb.from("vini_duvidas").update({ resposta: deRenato ? (dv.resposta || "") + `\nRenato: ${texto}` : texto, status: deRenato ? "com_renato" : "com_claude", nivel, atualizado_em: agora }).eq("id", dv.id);
  if (!deRenato) await proximaDuvida(chat);
  return [deRenato ? `Anotei, Renato. Ainda não sei executar isso sozinho; a dúvida #${dv.id} fica registrada para a equipe técnica me ensinar.` : `Anotei sua resposta 👍 Ainda não sei fazer isso sozinho, então passei para a equipe técnica (dúvida #${dv.id}). Te retorno assim que tiver a resposta.`];
}

/* ---------- v14 (21/11/2026): FATURA DE CARTÃO ----------
   Pedido do Vinicius (21/11): "vamos colocar no sistema pra dentro dessa fatura eu dizer o que é da obra e o que é pessoal".
   Decisão do Renato: o Vini importa sozinho; o que for "obra" vai para a Obra do IDAD.
   1) lerFatura: IA lê todos os lançamentos e confere com o total impresso (se não bater, relê com o modelo maior).
   2) SIM de quem pode (pode_lancar ou pode_fatura) → lançamentos no "Apontar depois" (empresa vazia), no cartão certo (origem pelo final), sem duplicar.
   3) A pessoa diz pelo número: obra / pessoal / nome do CNPJ ("resto pessoal" vale). SIM grava:
      obra → movimento vai para o IDAD com categoria "Obra do IDAD" + linha na Obra do IDAD (idad_obra, ligada pelo id do movimento);
      pessoal → despesa pessoal do titular (área pessoal dele); CNPJ → movimento vai para aquele CNPJ. O que não for marcado fica no "Apontar depois". */
const PROMPT_FAT = `Voce esta lendo a FATURA de um cartao de credito (PDF ou foto). Extraia TODOS os lancamentos desta fatura, um por linha, na ordem em que aparecem (todas as paginas).
Responda SOMENTE JSON:
{"banco":"","bandeira":"ex.: Ourocard Visa","final":"4 ultimos digitos do cartao","titular":"nome impresso","vencimento":"AAAA-MM-DD","fechamento":"AAAA-MM-DD ou null","total_fatura":0,"soma_lancamentos":0,
 "lancamentos":[{"data":"AAAA-MM-DD","descricao":"como esta escrito, com a parcela (ex.: PARC 02/10) se houver","valor":0,"tipo":"compra|estorno|pagamento|encargo"}]}
Regras:
- O ano de cada data vem do fechamento/vencimento da fatura; se o mes da compra for maior que o mes do fechamento, a compra e do ano anterior.
- "pagamento" = pagamento da fatura anterior. "estorno" = credito/devolucao. "encargo" = juros, multa, IOF, anuidade, tarifa.
- soma_lancamentos = o total que a fatura imprime para os lancamentos desta fatura (ex.: "Compras nacionais" + "Compras internacionais" + "Tarifas, encargos e multas"); se nao houver, use o total da fatura.
- Valores sempre positivos, com ponto decimal (1234.56). Nao invente linhas.`;
const r2 = (v: number) => Math.round((+v || 0) * 100) / 100;
async function lerFatura(b64: string, mime: string) {
  const anexo = /pdf/i.test(mime) ? { type: "file", file: { filename: "fatura.pdf", file_data: `data:application/pdf;base64,${b64}` } }
    : { type: "image_url", image_url: { url: `data:${mime};base64,${b64}`, detail: "high" } };
  const tenta = async (modelo: string) => {
    try { const m = await ia([{ role: "user", content: [{ type: "text", text: PROMPT_FAT }, anexo] }], undefined, true, modelo); return JSON.parse(String(m?.content || "").replace(/^```json|```$/g, "")); } catch { return null; }
  };
  const avalia = (f: any) => {
    if (!f || !Array.isArray(f.lancamentos)) return null;
    const itens = f.lancamentos.filter((x: any) => x && +x.valor > 0 && x.tipo !== "pagamento" && /^\d{4}-\d{2}-\d{2}$/.test(String(x.data || "")))
      .map((x: any) => ({ data: x.data, descricao: String(x.descricao || "").replace(/\s+/g, " ").trim().slice(0, 140), valor: r2(x.valor), tipo: x.tipo === "estorno" ? "entrada" : "saida", encargo: x.tipo === "encargo" }));
    const soma = r2(itens.reduce((s: number, x: any) => s + (x.tipo === "saida" ? x.valor : -x.valor), 0));
    const alvo = +f.soma_lancamentos || +f.total_fatura || 0, dif = r2(soma - alvo);
    return { ...f, itens, soma, alvo, dif, ok: !!alvo && Math.abs(dif) < 0.02 };
  };
  let f = avalia(await tenta(MODELO_LEITURA));
  if (!f || !f.ok) { const g = avalia(await tenta(MODELO_CONVERSA)); if (g && (!f || g.ok || Math.abs(g.dif) < Math.abs(f.dif))) f = g; }   // relê com o modelo maior
  if (!f || !f.itens.length) throw new Error("não consegui ler os lançamentos da fatura");
  f.final = String(f.final || "").replace(/\D/g, "").slice(-4);
  return f;
}
async function origemCartao(final: string, titular: string, criar = false, banco = "") {
  const { data: os } = await sb.from("origens").select("id,nome,tipo,identificador,titular,obra").eq("tipo", "cartao");
  const o = final ? (os || []).find((x: any) => so(x.identificador).slice(-4) === final || new RegExp(`final\\s*${final}\\b`, "i").test(x.nome)) : null;
  if (o) return o;
  // v15: cartão cadastrado na Obra ainda sem final (ex.: "Cartão Vinicius Unicred") — mesmo titular; se houver mais de um, o banco no nome desempata
  const t1 = norm(titular).split(" ")[0];
  let ph = (os || []).filter((x: any) => !x.identificador && t1 && norm(x.titular || x.nome.replace(/^CART[AÃ]O\s+/i, "")).split(" ")[0] === t1);
  const BANCOS = ["UNICRED", "OUROCARD", "BB", "ITAU", "BRADESCO", "SANTANDER", "NUBANK", "INTER", "CAIXA", "SICOOB", "SICREDI", "C6", "XP", "BTG"];
  const bancoDe = (t: string) => BANCOS.find((k) => ` ${norm(t)} `.includes(` ${k} `)) || "";
  if (banco) ph = ph.filter((x: any) => { const bn = bancoDe(x.nome); return !bn || bn === bancoDe(banco) || (bn === "BB" && bancoDe(banco) === "OUROCARD"); });
  if (ph.length === 1) { if (criar && final) await sb.from("origens").update({ identificador: final }).eq("id", ph[0].id); return ph[0]; }
  if (!criar) return null;
  const primeiro = String(titular || "").trim().split(/\s+/)[0] || "";
  const nome = `Cartão ${primeiro ? primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase() + " " : ""}final ${final || "????"}`;
  const { data: nova, error } = await sb.from("origens").insert({ nome, tipo: "cartao", empresa_id: null, identificador: final || null, titular: titular || null, observacao: "Criado pelo Vini ao importar fatura (v14)" }).select("id,nome").single();
  if (error) throw new Error("não criei o cartão: " + error.message);
  return nova;
}
const linhaFat = (x: any, i: number) => `${i + 1}. ${dbr(x.data).slice(0, 5)} ${x.descricao} — ${x.tipo === "entrada" ? "+" : ""}${brl(x.valor)}${x.repetido ? " ♻️" : ""}`;
async function marcarRepetidos(fat: any, o: any) {
  // não duplica: mesmo valor no mesmo cartão, na data da PARCELA (o sistema grava cada parcela no mês dela), com folga de 7 dias
    const addMes = (d: string, k: number) => { const [a, m, dd] = d.split("-").map(Number); const x = new Date(Date.UTC(a, m - 1 + k, 1)); const fim = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(dd, fim)).padStart(2, "0")}`; };
    fat.itens.forEach((x: any) => { const p = String(x.descricao).match(/PARC\w*\s*(\d{1,2})\s*\/\s*(\d{1,2})/i); x.data_parcela = p ? addMes(x.data, +p[1] - 1) : x.data; });
    if (!o) return;
    const ds = fat.itens.map((x: any) => x.data_parcela).sort(), ini = new Date(Date.parse(ds[0]) - 8 * 864e5).toISOString().slice(0, 10), fim = new Date(Date.parse(ds[ds.length - 1]) + 8 * 864e5).toISOString().slice(0, 10);
    const { data: ja } = await sb.from("movimentos").select("id,data_movimento,valor").eq("origem_id", o.id).gte("data_movimento", ini).lte("data_movimento", fim);
    const pool = [...(ja || [])];
    fat.itens.forEach((x: any) => { x.repetido = false; delete x.rep_id; });
    fat.itens.forEach((x: any) => { const i = pool.findIndex((m: any) => r2(m.valor) === x.valor && Math.abs(Date.parse(m.data_movimento) - Date.parse(x.data_parcela)) <= 7 * 864e5); if (i >= 0) { x.repetido = true; x.rep_id = pool[i].id; pool.splice(i, 1); } });
}
// v16: fila de faturas — quando chegam várias juntas, o Vini faz uma de cada vez sem pedir para reenviar
async function proximaFatura(chat: string, autor: string, fila: any[]) {
  if (!fila?.length) return;
  const [f, ...resto] = fila; const b64 = await baixar(f.foto_path);
  if (!b64) return await proximaFatura(chat, autor, resto);
  try { await prepararFatura(chat, autor, f, b64, resto); }
  catch (e) { await sb.from("vini_saida").insert({ chat, texto: "Não consegui ler uma das faturas: " + String((e as Error).message).slice(0, 150) + ". Mande essa de novo depois." }); await proximaFatura(chat, autor, resto); }
}
async function prepararFatura(chat: string, autor: string, f: any, b64: string, fila: any[] = []) {
  const outras = fila.length;
  const fat = await lerFatura(b64, f.mime || "application/pdf");
  const o = await origemCartao(fat.final, fat.titular, false, fat.banco || fat.bandeira || "");
  await marcarRepetidos(fat, o);
  const novos = fat.itens.filter((x: any) => !x.repetido), vencida = fat.vencimento && fat.vencimento < hojeBahia();
  // v16: a fatura inteira já entrou? (mesmo cartão + mesmo vencimento)
  const { data: jaFat } = o && fat.vencimento ? await sb.from("cartao_faturas").select("criado_em,via").eq("origem_id", o.id).eq("vencimento", fat.vencimento).maybeSingle() : { data: null };
  if (jaFat && !novos.length) {
    await sb.from("vini_saida").insert({ chat, texto: `💳 Essa fatura (*${o.nome}*, vencimento ${dbr(fat.vencimento)}) *já está no sistema* — entrou em ${dbr(String(jaFat.criado_em).slice(0, 10))}${jaFat.via === "vini" ? " pelo Vini" : " pela tela"}. Não lancei nada de novo, para não repetir.\n\nA separação (obra / pessoal / CNPJ) fica em Financeiro › Cartões e compras, na aba do cartão.` });
    return await proximaFatura(chat, autor, fila);
  }
  // v17: bateu 100% e quem mandou pode lançar fatura → lança direto, sem SIM
  if (novos.length && fat.ok && /pdf/i.test(f.mime || "") && /^\d{4}-\d{2}-\d{2}$/.test(String(fat.vencimento || ""))) {
    const { data: cts } = await sb.from("vini_contatos").select("pode_lancar,pode_fatura").in("telefone", variantes(so(autor))).eq("ativo", true).limit(1);
    if (cts?.[0] && (cts[0].pode_lancar || cts[0].pode_fatura)) {
      const acao = { chat, autor, dados: { ...fat, lancamentos: undefined, pdf: f.foto_path, origem_id: o?.id || null, fila, auto: true } };
      let r: string;
      try { r = await importarFatura(acao); await sb.from("vini_acoes").insert({ chat, autor, tipo: "fatura", status: "confirmada", resultado: r.slice(0, 300), resolvido_em: new Date().toISOString(), dados: { final: fat.final, vencimento: fat.vencimento, total_fatura: fat.total_fatura, auto: true } }).then(() => {}, () => {}); }
      catch (e) { await erro("ferramenta_falhou", { chat, ferramenta: "fatura", detalhe: (e as Error).message }); await sb.from("vini_acoes").insert({ chat, autor, tipo: "fatura", status: "erro", resultado: String((e as Error).message).slice(0, 300), dados: acao.dados }); r = "⚠️ Li a fatura, mas não consegui lançar: " + (e as Error).message + ". A equipe técnica vai ver."; }
      await sb.from("vini_saida").insert({ chat, texto: r });
      return await proximaFatura(chat, autor, fila);
    }
  }
  let t = `💳 *Fatura ${fat.bandeira || "do cartão"} final ${fat.final || "?"}*${fat.titular ? " — " + fat.titular : ""}\n`;
  t += `Vencimento: *${dbr(fat.vencimento) || "?"}*${vencida ? " ⚠️ *vencida*" : ""} · Total da fatura: *${brl(fat.total_fatura)}*\n`;
  t += `${fat.itens.length} lançamento(s) somam *${brl(fat.soma)}* ${fat.ok ? "✅ bate com a fatura" : `⚠️ a fatura diz ${brl(fat.alvo)} (diferença ${brl(fat.dif)}) — confira antes`}\n`;
  if (fat.itens.length - novos.length) t += `♻️ ${fat.itens.length - novos.length} já estavam no sistema (não vou duplicar)\n`;
  if (jaFat) t += `⚠️ Essa fatura já tinha sido importada em ${dbr(String(jaFat.criado_em).slice(0, 10))}; só os ${novos.length} que faltam entram agora.\n`;
  t += `Cartão no sistema: *${o ? o.nome : `novo — vou criar "Cartão final ${fat.final}"`}*\n\n`;
  t += fat.itens.slice(0, 80).map(linhaFat).join("\n");
  if (fat.itens.length > 80) t += `\n… e mais ${fat.itens.length - 80}`;
  t += novos.length ? `\n\n${!fat.ok ? "⚠️ *Não lancei sozinho porque a soma não bateu com o total da fatura.* " : !/pdf/i.test(f.mime || "") ? "⚠️ *Não lancei sozinho porque veio por foto/print* (pode ser só um pedaço da fatura — o ideal é o PDF). " : "⚠️ *Não lancei sozinho porque não achei o vencimento.* "}Posso lançar os ${novos.length} lançamento(s) no sistema (ficam no *Apontar depois*)? Responda *SIM* ou *NÃO*.\nDepois você me diz, pelo número, o que é da *obra*, o que é *pessoal* e o que é de algum CNPJ.`
    : `\n\nTodos já estão no sistema; não há o que lançar.`;
  if (outras) t += `\n\n_(Tenho mais ${outras} fatura(s) na fila: depois do seu SIM ou NÃO desta, mostro a próxima.)_`;
  if (novos.length) {
    await sb.from("vini_acoes").update({ status: "expirada", resolvido_em: new Date().toISOString() }).eq("chat", chat).eq("status", "aguardando");
    await sb.from("vini_acoes").insert({ chat, autor, tipo: "fatura", dados: { ...fat, lancamentos: undefined, pdf: f.foto_path, origem_id: o?.id || null, fila } });
  }
  await sb.from("vini_saida").insert({ chat, texto: t });
  if (!novos.length) await proximaFatura(chat, autor, fila);   // v16: nada a lançar → segue a fila
}
async function importarFatura(acao: any): Promise<string> {
  const d = acao.dados;
  const o = d.origem_id ? { id: d.origem_id } : await origemCartao(d.final, d.titular, true, d.banco || d.bandeira || "");
  if (d.origem_id && d.final) await sb.from("origens").update({ identificador: d.final }).eq("id", d.origem_id).is("identificador", null);
  const marca = `[Fatura ${d.bandeira || "cartão"} final ${d.final || "?"} venc. ${dbr(d.vencimento)} — importada pelo Vini em ${dbr(hojeBahia())}]`;
  await marcarRepetidos(d, o);   // v16: confere de novo na hora do SIM (pode ter entrado pela tela ou por outra conversa nesse meio-tempo)
  const novos = d.itens.filter((x: any) => !x.repetido);
  if (!novos.length) return `Essa fatura já está toda no sistema (entrou enquanto esperava o seu SIM). Não lancei nada de novo, para não repetir.`;
  const ins = await sb.from("movimentos").insert(novos.map((x: any) => ({
    tipo: x.tipo, empresa_id: null, origem_id: o.id, descricao: x.descricao, fornecedor: x.descricao.replace(/\s+PARC\w*\s*\d+\s*\/\s*\d+.*$/i, "").slice(0, 80),
    categoria: x.encargo ? "Encargos do cartão" : null, valor: x.valor, data_movimento: x.data_parcela || x.data, vencimento: d.vencimento || null, pago: false,
    lido_por_ia: true, observacao: marca, anexo_path: d.pdf || null, anexo_nome: d.pdf ? "fatura-whatsapp-vini.pdf" : null, pessoal: false }))).select("id,data_movimento,valor,descricao,tipo");
  if (ins.error) throw new Error(ins.error.message);
  // mesma ordem do resumo: casa cada linha nova com o id gravado
  const pool = [...(ins.data || [])];
  const itens = novos.map((x: any) => { const i = pool.findIndex((m: any) => m.data_movimento === (x.data_parcela || x.data) && r2(m.valor) === x.valor && m.descricao === x.descricao); const m = i >= 0 ? pool.splice(i, 1)[0] : null; return { ...x, id: m?.id || null }; }).filter((x: any) => x.id);
  // v15: cabeçalho da fatura para a aba do cartão na Obra do IDAD (CPE v124)
  if (d.vencimento) await sb.from("cartao_faturas").upsert({ origem_id: o.id, vencimento: d.vencimento, total: d.total_fatura ?? null, pdf_path: d.pdf || null, via: "vini",
    movs_existentes: d.itens.filter((x: any) => x.repetido && x.rep_id).map((x: any) => x.rep_id) }, { onConflict: "origem_id,vencimento" }).then(() => {}, () => {});
  const tot0 = r2(itens.reduce((s: number, x: any) => s + (x.tipo === "saida" ? x.valor : -x.valor), 0)), nRep = d.itens.length - novos.length;
  if (d.auto) { const { data: oo } = await sb.from("origens").select("nome").eq("id", o.id).maybeSingle();
    return `✅ *Fatura lida e 100%* — ${oo?.nome || "cartão final " + d.final}, vencimento ${dbr(d.vencimento)}\n${d.itens.length} lançamento(s) = *${brl(d.total_fatura)}* (bate com a fatura)\n${nRep ? `♻️ ${nRep} já estavam no sistema (não repeti) · ` : ""}${itens.length} lançado(s) agora (${brl(tot0)})\n\nSeparação (obra / pessoal / CNPJ): Financeiro › Cartões e compras › aba do cartão.`; }
  await sb.from("vini_acoes").insert({ chat: acao.chat, autor: acao.autor, tipo: "classificar_fatura", dados: { titular: d.titular, final: d.final, bandeira: d.bandeira, vencimento: d.vencimento, itens, marcas: {} } });
  const tot = r2(itens.reduce((s: number, x: any) => s + (x.tipo === "saida" ? x.valor : -x.valor), 0));
  if (d.fila?.length) return `✅ Lancei ${itens.length} lançamento(s) da fatura final ${d.final} (${brl(tot)}) no *Apontar depois*. A separação (obra / pessoal / CNPJ) desta você faz em Financeiro › Cartões e compras, na aba do cartão.\n\nAgora a próxima fatura da fila 👇`;
  return `✅ Lancei ${itens.length} lançamento(s) da fatura final ${d.final} (${brl(tot)}) no *Apontar depois*.\n\nAgora me diga, pelo número, o destino de cada um. Exemplos:\n• *obra 1, 3, 5 a 8*\n• *pessoal 2 e 4*\n• *NAFS 9*\n• *resto pessoal*\n\nPode mandar por escrito ou por áudio, em quantas mensagens quiser. No fim eu mostro o resumo e gravo com o seu *SIM*.`;
}
const faixas = (ns: number[]) => { const s = [...ns].sort((a, b) => a - b), out: string[] = []; for (let i = 0; i < s.length; i++) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(j - i >= 2 ? `${s[i]} a ${s[j]}` : j > i ? `${s[i]}, ${s[j]}` : `${s[i]}`); i = j; } return out.join(", "); };
function statusMarcas(d: any) {
  const grupos: Record<string, number[]> = {}, falta: number[] = [];
  d.itens.forEach((x: any, i: number) => { const m = d.marcas[i + 1]; if (!m) falta.push(i + 1); else { const k = m.destino === "empresa" ? "🏢 " + m.empresa : m.destino === "obra" ? "🏗️ Obra do IDAD" : "👤 Pessoal"; (grupos[k] = grupos[k] || []).push(i + 1); } });
  const val = (ns: number[]) => brl(ns.reduce((s, n) => { const x = d.itens[n - 1]; return s + (x.tipo === "saida" ? x.valor : -x.valor); }, 0));
  let t = Object.entries(grupos).map(([k, ns]) => `${k}: ${faixas(ns)} — *${val(ns)}*`).join("\n");
  if (falta.length) t += `${t ? "\n" : ""}⏳ Faltam: ${faixas(falta)} — ${val(falta)}`;
  t += falta.length === d.itens.length ? "" : falta.length ? `\n\nMe diga o destino dos que faltam (ex.: *resto pessoal*) ou responda *SIM* para gravar só os marcados (os outros ficam no Apontar depois).` : `\n\nTudo marcado. Posso gravar? Responda *SIM* ou *NÃO*.`;
  return t;
}
async function lerMarcas(texto: string, d: any, ctx: any) {
  const { data: emps } = await sb.from("empresas").select("nome").eq("ativo", true);
  const lista = d.itens.map((x: any, i: number) => `${i + 1}. ${x.data} ${x.descricao} ${x.valor}`).join("\n");
  const prompt = `Lancamentos de uma fatura de cartao (numero. data descricao valor):\n${lista}\n\nMarcas ja feitas (numero -> destino): ${JSON.stringify(d.marcas)}\n\nMensagem da pessoa: "${texto}"\n\nDestinos validos: "obra" (obra do Hospital IDAD), "pessoal" (despesa pessoal de ${d.titular || "titular do cartao"}), ou "empresa" com o nome de um destes CNPJs: ${(emps || []).map((e: any) => e.nome).join("; ")}.\n- "resto", "o restante", "os outros" = todos os numeros ainda sem marca. "todos" = todos. "1 a 5" = 1,2,3,4,5. A pessoa pode corrigir uma marca ja feita.\n- A pessoa pode citar pela descricao (ex.: "a da Leroy e obra").\n- Se a mensagem NAO for sobre classificar estes lancamentos (pergunta, outro assunto), use "acao":"outro".\nResponda SOMENTE JSON: {"acao":"marcar|outro","marcas":[{"n":1,"destino":"obra|pessoal|empresa","empresa":"nome do CNPJ se destino=empresa"}]}`;
  const m = await ia([{ role: "user", content: prompt }], undefined, true, MODELO_CONVERSA, ctx);
  try { return JSON.parse(String(m?.content || "{}")); } catch { return { acao: "outro" }; }
}
async function aplicarMarcas(acao: any, contato: any): Promise<string> {
  const d = acao.dados, agora = new Date().toISOString();
  const { data: emps } = await sb.from("empresas").select("id,nome,cnpj");
  const idad: any = (emps || []).find((e: any) => so(e.cnpj) === "33231594000109") || (emps || []).find((e: any) => norm(e.nome) === "IDAD");
  const { data: areas } = await sb.from("pessoais_area").select("dono_id,nome");
  const t1 = norm(d.titular).split(" ")[0];
  const area: any = (areas || []).find((a: any) => t1 && norm(a.nome).split(" ")[0] === t1) || null;
  const obra = d.itens.map((x: any, i: number) => ({ x, n: i + 1 })).filter((o: any) => d.marcas[o.n]?.destino === "obra");
  let cats: Record<string, string> = {};
  if (obra.length) {   // categoria da obra pela descrição (só sugestão; corrige na tela)
    try { const m = await ia([{ role: "user", content: `Classifique cada gasto da obra de um hospital numa destas categorias: Material; Mão de obra; Serviço; Equipamento; Projeto / engenharia; Taxas e licenças; Frete; Outros.\n${obra.map((o: any) => `${o.n}. ${o.x.descricao}`).join("\n")}\nResponda SOMENTE JSON {"n":"categoria"}.` }], undefined, true, MODELO_LEITURA); cats = JSON.parse(String(m?.content || "{}")); } catch { /* fica Outros */ }
  }
  let nO = 0, nP = 0, nE = 0; const avisos: string[] = [];
  for (let i = 0; i < d.itens.length; i++) {
    const x = d.itens[i], n = i + 1, mk = d.marcas[n]; if (!mk || !x.id) continue;
    if (mk.destino === "obra") {
      if (!idad) { avisos.push(`${n}: não achei o CNPJ do IDAD`); continue; }
      const u = await sb.from("movimentos").update({ empresa_id: idad.id, categoria: "Obra do IDAD", pessoal: false, pessoa_id: null }).eq("id", x.id);
      if (u.error) { avisos.push(`${n}: ${u.error.message}`); continue; }
      const OK = ["Material", "Mão de obra", "Serviço", "Equipamento", "Projeto / engenharia", "Taxas e licenças", "Frete", "Outros"];
      await sb.from("idad_obra").insert({ data: x.data, descricao: x.descricao, categoria: OK.includes(cats[n]) ? cats[n] : "Outros", fornecedor: x.descricao.replace(/\s+PARC\w*\s*\d+\s*\/\s*\d+.*$/i, "").slice(0, 80),
        valor: x.tipo === "saida" ? x.valor : -x.valor, forma_pag: `Cartão ${d.bandeira || ""} final ${d.final}`.replace(/\s+/g, " "), pago: false, pago_por: d.titular || null,
        obs: `[Fatura venc. ${dbr(d.vencimento)} — via Vini · movimento ${x.id}]`, movimento_id: x.id });
      nO++;
    } else if (mk.destino === "pessoal") {
      if (!area) { avisos.push(`${n}: não achei a área pessoal de ${d.titular || "titular"} — ficou no Apontar depois`); continue; }
      const u = await sb.from("movimentos").update({ pessoal: true, pessoa_id: area.dono_id, empresa_id: null }).eq("id", x.id);
      if (u.error) avisos.push(`${n}: ${u.error.message}`); else nP++;
    } else if (mk.destino === "empresa") {
      const e: any = (emps || []).find((y: any) => norm(y.nome) === norm(mk.empresa)) || (emps || []).find((y: any) => norm(y.nome).includes(norm(mk.empresa)) || norm(mk.empresa).includes(norm(y.nome)));
      if (!e) { avisos.push(`${n}: não achei o CNPJ "${mk.empresa}" — ficou no Apontar depois`); continue; }
      const u = await sb.from("movimentos").update({ empresa_id: e.id, pessoal: false, pessoa_id: null }).eq("id", x.id);
      if (u.error) avisos.push(`${n}: ${u.error.message}`); else nE++;
    }
  }
  await sb.from("vini_acoes").update({ status: "confirmada", resultado: `obra ${nO}, pessoal ${nP}, cnpj ${nE}`, resolvido_em: agora }).eq("id", acao.id);
  const resto = d.itens.length - nO - nP - nE;
  return `✅ Gravado: ${nO} na *Obra do IDAD*, ${nP} como *pessoal*${area ? ` (${area.nome})` : ""}, ${nE} em outros CNPJs.${resto ? `\n${resto} ficaram no *Apontar depois* (dá para separar pela tela).` : ""}` + (avisos.length ? "\n" + avisos.map((a) => "⚠️ " + a).join("\n") : "");
}

/* ---------- Mensagem recebida ---------- */
// info (v12): o handler lê info.voz (responder também em áudio) e info.audio (a pessoa mandou áudio)
async function entrada(b: any, info: any = {}): Promise<string[]> {
  const chat = String(b.chat || ""), autor = so(b.autor), grupo = !!b.grupo;
  let texto = String(b.texto || "").trim();
  const mimeIn = String(b.midia?.mime || ""), ehAudio = !!b.midia && /^audio\//.test(mimeIn);
  const rotMidia = !b.midia ? "" : ehAudio ? "[🎤 áudio]" : /pdf/i.test(mimeIn) ? "[pdf]" : /^image\//.test(mimeIn) ? "[imagem]" : `[arquivo ${mimeIn}]`;
  const { data: lg } = await sb.from("vini_mensagens").insert({ direcao: "entrada", chat, texto: (texto || rotMidia).slice(0, 4000), autor, autor_nome: b.autor_nome || null, grupo, wa_id: b.wa_id || null,
    midia: b.midia ? { mime: mimeIn, bytes: Math.round((b.midia.b64 || "").length * 0.75), segundos: b.midia.segundos ?? null } : null }).select("id").single();
  const st = (await sb.from("vini_status").select("pausado").eq("id", 1).maybeSingle()).data;
  if (st?.pausado) return [];
  const { data: cts } = await sb.from("vini_contatos").select("*").in("telefone", variantes(autor)).eq("ativo", true).limit(1);
  const contato = cts?.[0] || null;
  if (grupo && !b.mencionado) return [];                             // em grupo, só quando chamado ("Vini" ou @)
  if (!contato) {
    if (grupo) return [];
    const { count } = await sb.from("vini_mensagens").select("id", { count: "exact", head: true }).eq("chat", chat).eq("direcao", "saida").gte("em", new Date(Date.now() - 864e5).toISOString());
    return count ? [] : ["Olá! Eu sou o Vini, assistente do Sistema MR. Este número é de uso interno da equipe."];
  }
  // v13: a pessoa respondeu um recado mandado a pedido de alguém (até 24 h) → avisa quem pediu (uma vez por recado)
  if (!grupo) {
    const { data: rc } = await sb.from("vini_recados").select("id,pedido_por,avisar_chat,texto").in("para_telefone", variantes(autor)).eq("avisar", true).is("respondido_em", null).gte("criado_em", new Date(Date.now() - 864e5).toISOString()).order("id", { ascending: false }).limit(1).maybeSingle();
    if (rc && rc.avisar_chat && rc.avisar_chat !== chat) {
      const oque = texto || (ehAudio ? "(mandou um áudio)" : rotMidia);
      await sb.from("vini_recados").update({ respondido_em: new Date().toISOString(), resposta: oque.slice(0, 1000) }).eq("id", rc.id);
      // @ts-ignore EdgeRuntime existe no Supabase
      EdgeRuntime.waitUntil((async () => {
        let mostra = oque;
        if (ehAudio) { try { mostra = "🎤 " + await transcrever(b.midia.b64, mimeIn, { chat, quem: contato.nome }); } catch { /* fica "(mandou um áudio)" */ } }
        await sb.from("vini_saida").insert({ chat: rc.avisar_chat, texto: `📩 *${contato.nome} respondeu* ao recado:\n${mostra.slice(0, 1200)}` });
      })());
    }
  }
  // v12: ÁUDIO → transcreve e segue o fluxo como texto (SIM/NÃO, dúvidas, perguntas — tudo vale por áudio)
  if (ehAudio) {
    let ouvido = "";
    try { ouvido = await transcrever(b.midia.b64, mimeIn, { chat, quem: contato.nome }); } catch { /* erro já anotado */ }
    if (!ouvido) return ["🎤 Não consegui entender o áudio. Pode gravar de novo ou escrever?"];
    if (lg?.id) await sb.from("vini_mensagens").update({ texto: ("🎤 " + ouvido).slice(0, 4000) }).eq("id", lg.id);
    texto = ouvido; b = { ...b, midia: null, texto: ouvido };
    info.audio = true; info.voz = true; info.ouvido = ouvido;
  }
  if (texto && !ehAudio && PEDIU_AUDIO.test(norm(texto))) info.voz = true;
  // ação aguardando resposta?
  // v14: fatura e separação da fatura ficam abertas 48 h; o resto, 6 h
  let { data: acao } = await sb.from("vini_acoes").select("*").eq("chat", chat).eq("autor", autor).eq("status", "aguardando").gte("criado_em", new Date(Date.now() - 48 * 3600e3).toISOString()).order("criado_em", { ascending: false }).limit(1).maybeSingle();
  if (acao && !["fatura", "classificar_fatura"].includes(acao.tipo) && Date.parse(acao.criado_em) < Date.now() - 6 * 3600e3) acao = null;
  // por áudio a pessoa costuma falar "sim, pode lançar." — tira pontuação e o que vem depois da 1ª palavra quando for SIM/NÃO
  const tSimNao = (() => { const t = norm(texto); if (!info.audio) return t; const p = t.split(" ")[0]; return /^(SIM|NAO|PODE|OK|CONFIRMO|CANCELA|CANCELAR|LANCA)$/.test(p) && t.split(" ").length <= 4 ? p : t; })();
  const podeFatura = contato.pode_lancar || contato.pode_fatura;
  if (acao && acao.tipo === "fatura" && texto && !b.midia) {   // v14
    const t = tSimNao;
    if (/^(SIM|S|CONFIRMO|PODE|OK|LANCA|PODE LANCAR)$/.test(t)) {
      if (!podeFatura) return ["Você não tem permissão para confirmar lançamentos pelo WhatsApp. Peça ao Renato."];
      try { const r = await importarFatura(acao); await sb.from("vini_acoes").update({ status: "confirmada", resultado: r.slice(0, 300), resolvido_em: new Date().toISOString() }).eq("id", acao.id);
        // @ts-ignore EdgeRuntime existe no Supabase
        if (acao.dados?.fila?.length) EdgeRuntime.waitUntil(new Promise((ok) => setTimeout(ok, 4000)).then(() => proximaFatura(chat, autor, acao.dados.fila)));   // v16
        return [r]; }
      catch (e) { await sb.from("vini_acoes").update({ status: "erro", resultado: String((e as Error).message), resolvido_em: new Date().toISOString() }).eq("id", acao.id); await erro("ferramenta_falhou", { chat, quem: contato.nome, ferramenta: "fatura", detalhe: (e as Error).message }); return ["Não consegui lançar a fatura: " + (e as Error).message + ". A equipe técnica vai ver."]; }
    }
    if (/^(NAO|N|CANCELA|CANCELAR)$/.test(t)) { await sb.from("vini_acoes").update({ status: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", acao.id);
      // @ts-ignore EdgeRuntime existe no Supabase
      if (acao.dados?.fila?.length) { EdgeRuntime.waitUntil(new Promise((ok) => setTimeout(ok, 3000)).then(() => proximaFatura(chat, autor, acao.dados.fila))); return ["Ok, não lancei essa fatura. Vou para a próxima da fila."]; }
      return ["Ok, não lancei a fatura."]; }
  }
  if (acao && acao.tipo === "classificar_fatura" && texto && !b.midia) {   // v14
    const t = tSimNao, d = acao.dados;
    if (/^(SIM|S|CONFIRMO|PODE|OK|GRAVA|PODE GRAVAR)$/.test(t)) {
      if (!podeFatura) return ["Você não tem permissão para confirmar lançamentos pelo WhatsApp. Peça ao Renato."];
      if (!Object.keys(d.marcas || {}).length) return ["Ainda não tem nada marcado. Me diga pelo número o que é *obra*, o que é *pessoal* ou de qual CNPJ (ex.: *obra 1 a 5, resto pessoal*)."];
      return [await aplicarMarcas(acao, contato)];
    }
    if (/^(NAO|N|CANCELA|CANCELAR)$/.test(t)) { await sb.from("vini_acoes").update({ status: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", acao.id); return ["Ok, não gravei a separação. Os lançamentos da fatura continuam no *Apontar depois*."]; }
    const r: any = await lerMarcas(texto, d, { chat, quem: contato.nome, pergunta: texto });
    if (r?.acao === "marcar" && Array.isArray(r.marcas) && r.marcas.length) {
      d.marcas = d.marcas || {};
      for (const mk of r.marcas) { const n = +mk.n; if (n >= 1 && n <= d.itens.length && ["obra", "pessoal", "empresa"].includes(mk.destino)) d.marcas[n] = mk.destino === "empresa" ? { destino: "empresa", empresa: String(mk.empresa || "") } : { destino: mk.destino }; }
      await sb.from("vini_acoes").update({ dados: d }).eq("id", acao.id);
      return [statusMarcas(d)];
    }
    // não era sobre a fatura: segue para a conversa normal
  }
  if (acao && acao.tipo === "lote" && texto && !b.midia) {   // v9
    const t = tSimNao;
    if (/^(SIM|S|CONFIRMO|PODE|OK|LANCA|PODE FAZER)$/.test(t)) {
      if (!contato.pode_lancar) return ["Você não tem permissão para confirmar lançamentos pelo WhatsApp. Peça ao Renato."];
      const r = await gravarLote(acao); await sb.from("vini_acoes").update({ status: "confirmada", resultado: r, resolvido_em: new Date().toISOString() }).eq("id", acao.id);
      await proximaDuvida(chat); return [r];
    }
    if (/^(NAO|N|CANCELA|CANCELAR)$/.test(t)) { await sb.from("vini_acoes").update({ status: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", acao.id); await proximaDuvida(chat); return ["Ok, não fiz nada desse resumo."]; }
  }
  if (acao && acao.tipo === "lancar_procedimentos" && texto && !b.midia) {
    const t = tSimNao, d = acao.dados;
    if (!d.dia_id && /^\d{1,2}$/.test(t) && d.candidatos[+t - 1]) { d.dia_id = d.candidatos[+t - 1].id; await sb.from("vini_acoes").update({ dados: d }).eq("id", acao.id); return [resumoProducao(d)]; }
    const m = texto.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!d.dia_id && m) { const ano = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : hojeBahia().slice(0, 4); d.data = `${ano}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      const ps = await plantoesDoDia(d.data); d.candidatos = ps.map((p) => ({ id: p.id, rot: rotPlantao(p), servicos: p.cad?.servicos || [] })); d.dia_id = ps.length === 1 ? ps[0].id : null;
      await sb.from("vini_acoes").update({ dados: d }).eq("id", acao.id); return [resumoProducao(d)]; }
    if (/^(SIM|S|CONFIRMO|PODE|PODE LANCAR|OK|LANCA)$/.test(t) && d.dia_id) {
      if (!contato.pode_lancar) return ["Você não tem permissão para confirmar lançamentos pelo WhatsApp. Peça ao Renato."];
      try { const r = await gravarProducao(acao); await sb.from("vini_acoes").update({ status: "confirmada", resultado: r, resolvido_em: new Date().toISOString() }).eq("id", acao.id); await proximaDuvida(chat); return [r]; }
      catch (e) { await sb.from("vini_acoes").update({ status: "erro", resultado: String((e as Error).message), resolvido_em: new Date().toISOString() }).eq("id", acao.id); return ["Não consegui lançar: " + (e as Error).message]; }
    }
    if (/^(NAO|N|CANCELA|CANCELAR)$/.test(t)) { await sb.from("vini_acoes").update({ status: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", acao.id); await sb.storage.from("notas").remove([d.foto]); return ["Ok, não lancei nada."]; }
  }
  if (grupo && b.midia) return ["Fotos e documentos para lançar eu recebo só no privado — me manda lá, por favor."];
  if (b.midia && (/^image\//.test(b.midia.mime || "") || /pdf/i.test(b.midia.mime || ""))) return await receberFoto(b, chat, autor, contato);   // v9: lote; v12: PDF também
  // v9: texto mandado no meio das fotos = legenda da última foto
  if (texto && !b.midia && !info.audio) {
    const { data: aberto } = await sb.from("vini_lote").select("id,legenda").eq("chat", chat).eq("processado", false).gte("em", new Date(Date.now() - 60e3).toISOString()).order("id", { ascending: false }).limit(1).maybeSingle();
    if (aberto) { await sb.from("vini_lote").update({ legenda: ((aberto.legenda ? aberto.legenda + " / " : "") + texto).slice(0, 500) }).eq("id", aberto.id); return []; }
  }
  // v9: Renato responde uma dúvida escalada: "#12 o que fazer"
  const mr = texto.match(/^#\s*(\d+)\s+([\s\S]+)$/);
  if (mr && so(contato.telefone) === "5575999717578") {
    const { data: dv } = await sb.from("vini_duvidas").select("*").eq("id", Number(mr[1])).maybeSingle();
    if (!dv) return [`Não achei a dúvida #${mr[1]}.`];
    return await responderDuvida(dv, mr[2], chat, autor, contato, true);
  }
  // v9: a pessoa está respondendo uma dúvida do Vini
  if (texto && !b.midia && !grupo) {
    const chats = [chat, ...variantes(so(contato.telefone)).map((v) => v + "@s.whatsapp.net")];
    const { data: dv } = await sb.from("vini_duvidas").select("*").in("chat", chats).eq("status", "aguardando_pessoa").order("id").limit(1).maybeSingle();
    if (dv && !/^(OK|OKAY|BELEZA|BLZ|VALEU|OBRIGADO|OBRIGADA|SHOW|TOP)$/.test(norm(texto))) return await responderDuvida(dv, texto, chat, autor, contato);
  }
  if (b.midia) return ["Por enquanto eu leio fotos, PDF e áudio. Vídeo e outros tipos de arquivo ainda não."];
  if (!texto) return [];
  // v8: "código 123456" para o navegador do Vini
  const mc = texto.match(/^c[oó]d(?:igo)?\.?\s*:?\s*([A-Za-z0-9 ]{4,12})$/i);
  if (mc && (mc[1].match(/\d/g) || []).length >= 4 && contato.pode_navegar && !grupo) { const r: any = await gravarCodigo(mc[1], { chat, contato }); return [r.ok ? r.resposta_para_a_pessoa : "Não achei acesso esperando código agora (o prazo é de 5 minutos)."]; }
  // agradecimento/confirmação solta não é pergunta (v6): responde curto, sem consultar nada
  if (/^(OK|OKAY|OK OK|BELEZA|BLZ|VALEU|OBRIGADO|OBRIGADA|OBG|TA BOM|TA|SHOW|TOP|PERFEITO|CERTO|ENTENDI|BOM|JOIA|BOA)( VINI)?$/.test(norm(texto)) || /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\s\u{FE0F}\u{200D}]+$/u.test(texto)) { info.voz = false; return grupo ? [] : ["👍"]; }
  return [await conversa(chat, contato, info.audio ? "🎤 " + texto : texto, grupo)];
}

let TOKEN = "";   // token do motor: tabela vini_segredo (sem acesso pela API pública)
Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return J({ ok: true, versao: VERSAO });
    if (!TOKEN) TOKEN = (await sb.from("vini_segredo").select("token").eq("id", 1).maybeSingle()).data?.token || "";
    if (!TOKEN || req.headers.get("x-vini-token") !== TOKEN) return J({ erro: "não autorizado" }, 401);
    const b = await req.json(), agora = new Date().toISOString();
    if (b.acao === "status") {
      const up: any = { visto_em: agora, motor_versao: b.versao || null };
      for (const k of ["conectado", "numero", "nome", "qr", "grupos", "erro"]) if (k in b) up[k] = b[k];
      if ("qr" in b) up.qr_em = b.qr ? agora : null;
      await sb.from("vini_status").update(up).eq("id", 1);
      const { data: s } = await sb.from("vini_status").select("pausado,pedido").eq("id", 1).maybeSingle();
      if (s?.pedido) await sb.from("vini_status").update({ pedido: null, pedido_em: null }).eq("id", 1);
      return J({ ok: true, pausado: !!s?.pausado, pedido: s?.pedido || null, ponte: VERSAO });
    }
    if (b.acao === "saida") {
      await sb.from("vini_saida").update({ status: "pendente" }).eq("status", "enviando").lt("criado_em", new Date(Date.now() - 5 * 60e3).toISOString());
      const { data } = await sb.from("vini_saida").select("id,chat,texto,imagem_path,audio_path").eq("status", "pendente").order("criado_em").limit(5);
      if (data?.length) await sb.from("vini_saida").update({ status: "enviando" }).in("id", data.map((x: any) => x.id));
      // v8: print do navegador do Vini -> link temporário (10 min) para o motor baixar e mandar como imagem
      // v12: nota de voz -> audio_url (10 min); o motor v3 manda como áudio gravado (ptt). Item só de áudio vem com texto "".
      const itens = [];
      for (const x of data || []) {
        let imagem_url = null, audio_url = null;
        if (x.imagem_path) { const { data: u } = await sb.storage.from("robo-acessos").createSignedUrl(x.imagem_path, 600); imagem_url = u?.signedUrl || null; }
        if (x.audio_path) { const { data: u } = await sb.storage.from("notas").createSignedUrl(x.audio_path, 600); audio_url = u?.signedUrl || null; }
        itens.push({ id: x.id, chat: x.chat, texto: x.texto ? x.texto + ASSINA : "", imagem_url, audio_url });
      }
      return J({ ok: true, itens });
    }
    if (b.acao === "saida_ok") {
      const { data: s } = await sb.from("vini_saida").select("*").eq("id", b.id).maybeSingle();
      if (s) { await sb.from("vini_saida").update(b.ok ? { status: "enviado", enviado_em: agora } : { status: s.tentativas >= 2 ? "erro" : "pendente", tentativas: s.tentativas + 1, erro: String(b.erro || "").slice(0, 300) }).eq("id", b.id);
        if (b.ok) await log("saida", s.chat, s.texto || (s.audio_path ? "[🔊 resposta em áudio]" : ""), { wa_id: b.wa_id || null }); }
      return J({ ok: true });
    }
    if (b.acao === "entrada") {
      let resp: string[] = [];
      const info: any = {};
      try { resp = await entrada(b, info); } catch (e) { resp = ["Tive um problema aqui e não consegui responder agora. O erro ficou registrado e a equipe técnica vai ver."]; await sb.from("vini_status").update({ erro: String((e as Error).message).slice(0, 300) }).eq("id", 1); await erro(/^IA:/.test((e as Error).message) ? "ia_falhou" : "ferramenta_falhou", { chat: b.chat, quem: b.autor_nome || b.autor, pergunta: b.texto, detalhe: (e as Error).stack || (e as Error).message }); }
      // v12: resposta a um áudio mostra o que o Vini entendeu (importante para SIM/NÃO por voz)
      if (info.audio && resp.length) resp[0] = `🎤 _"${String(info.ouvido).slice(0, 160)}${String(info.ouvido).length > 160 ? "…" : ""}"_\n\n` + resp[0];
      // v12: nota de voz com a resposta (sai pela fila vini_saida quando o motor for v3+)
      if (info.voz && resp.length) {
        if (await motorFalaAudio()) {
          // @ts-ignore EdgeRuntime existe no Supabase
          EdgeRuntime.waitUntil(enviarVoz(String(b.chat), resp.join("\n\n"), { chat: b.chat, quem: b.autor_nome || b.autor }));
        } else if (!info.audio) resp[resp.length - 1] += "\n\n_(A resposta em áudio está sendo instalada e chega em breve.)_";
      }
      for (const t of resp) await log("saida", String(b.chat), t);
      return J({ ok: true, responder: resp.map((t) => t + ASSINA) });
    }
    // v12: teste de voz e ouvido (gera um áudio, transcreve de volta; opcional: lê um PDF de teste). Só com o token do motor.
    if (b.acao === "teste_audio") {
      const frase = String(b.frase || "Bom dia! Aqui é o Vini, do Sistema MR. Agora eu também ouço e respondo áudio.");
      const audio = await falar(frase, { quem: "teste" });
      if (!audio) return J({ ok: false, etapa: "voz" });
      const ouvido = await transcrever(bytesB64(audio), "audio/ogg; codecs=opus", { quem: "teste" }).catch((e) => "ERRO: " + (e as Error).message);
      let caminho = null;
      if (b.guardar) { caminho = `vini/audio/teste/${Date.now()}.ogg`; await sb.storage.from("notas").upload(caminho, audio, { contentType: "audio/ogg" }); }
      const pdf = b.pdf_b64 ? await lerDoc(String(b.pdf_b64), "application/pdf", "", await regras()).catch((e) => ({ erro: (e as Error).message })) : null;
      return J({ ok: true, versao: VERSAO, bytes: audio.length, cabecalho: String.fromCharCode(...audio.subarray(0, 4)), ouvido, caminho, pdf });
    }
    // v14: teste da leitura de fatura de um arquivo já guardado no bucket notas (não manda nada a ninguém)
    if (b.acao === "teste_fatura") {
      const b64 = await baixar(String(b.path || "")); if (!b64) return J({ ok: false, erro: "arquivo não encontrado" });
      const f = await lerFatura(b64, /\.pdf$/i.test(String(b.path)) ? "application/pdf" : "image/jpeg");
      const o = await origemCartao(f.final, f.titular, false, f.banco || f.bandeira || "");
      await marcarRepetidos(f, o);
      return J({ ok: true, versao: VERSAO, repetidos: f.itens.filter((x: any) => x.repetido).length, final: f.final, titular: f.titular, bandeira: f.bandeira, vencimento: f.vencimento, total: f.total_fatura, alvo: f.alvo, soma: f.soma, dif: f.dif, bate: f.ok, n: f.itens.length, origem: o?.nome || null, itens: f.itens });
    }
    // v14: refaz o resumo de uma fatura já recebida e manda para o chat (só com autorização do Renato)
    if (b.acao === "fatura_reprocessar") {
      await prepararFatura(String(b.chat), so(b.autor), { foto_path: String(b.path), mime: /\.pdf$/i.test(String(b.path)) ? "application/pdf" : "image/jpeg" }, (await baixar(String(b.path))) || "", []);
      return J({ ok: true });
    }
    return J({ erro: "ação desconhecida" }, 400);
  } catch (e) { return J({ erro: (e as Error).message }, 500); }
});
