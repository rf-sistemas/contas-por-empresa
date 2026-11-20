// Edge Function: vini-ponte — CÉREBRO DO ROBÔ VINI (WhatsApp do Sistema MR)
// Só o motor do WhatsApp (VPS) chama esta função, com o cabeçalho x-vini-token (token na tabela vini_segredo).
// Ações: status (motor informa conexão/QR/grupos), saida (motor busca o que enviar), saida_ok, entrada (mensagem recebida).
// Regras: só responde a contatos cadastrados em vini_contatos (v5: lista de ferramentas por contato); lançamento só depois de "SIM" de quem pode_lancar;
// tudo fica gravado em vini_mensagens / vini_acoes. Nunca usa o banco da RF.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSAO = "vini-ponte v9 (20/11/2026)";
const J = (o: unknown, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "Content-Type": "application/json" } });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const OPENAI = Deno.env.get("OPENAI_API_KEY");
const ASSINA = "\n\n_Vini · Sistema MR_";
const so = (t: unknown) => String(t ?? "").replace(/\D/g, "");
const norm = (t: unknown) => String(t ?? "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const brl = (v: number) => "R$ " + (Math.round((+v || 0) * 100) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dbr = (d: string) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "");
// WhatsApp grava celular do Brasil às vezes SEM o 9 (ex.: 557599717578 = (75) 9 9971-7578): aceita as duas formas
const variantes = (d: string) => { const v = [d]; if (/^55\d{2}9\d{8}$/.test(d)) v.push(d.slice(0, 4) + d.slice(5)); if (/^55\d{2}[6-9]\d{7}$/.test(d)) v.push(d.slice(0, 4) + "9" + d.slice(4)); return v; };
const hojeBahia = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function log(direcao: string, chat: string, texto: string, extra: Record<string, unknown> = {}) {
  await sb.from("vini_mensagens").insert({ direcao, chat, texto: (texto || "").slice(0, 4000), ...extra });
}

/* ---------- IA ---------- */
async function ia(messages: any[], tools?: any[], json = false) {
  const body: any = { model: "gpt-5.4-mini", max_completion_tokens: 6000, messages };
  if (tools) body.tools = tools;
  if (json) body.response_format = { type: "json_object" };
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + OPENAI }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("IA: " + (await r.text()).slice(0, 200));
  const j = await r.json();
  if (j?.usage) await sb.from("uso_ia").insert({ robo: "vini", modelo: body.model, tokens_in: j.usage.prompt_tokens || 0, tokens_out: j.usage.completion_tokens || 0 }).then(() => {}, () => {});   // v9: custo de IA no painel
  return j?.choices?.[0]?.message;
}

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
  const destino = `procedimentos/${d.dia_id}/${Date.now()}-whatsapp-vini.jpg`;
  const mv = await sb.storage.from("notas").move(d.foto, destino);
  const docs = Array.isArray(dia.proc_docs) ? dia.proc_docs : [];
  if (!mv.error) docs.push({ path: destino, nome: "mapa-whatsapp-vini.jpg", em: new Date().toISOString(), via: "Vini" });
  const tot = it.filter((x: any) => x.situacao !== "cancelado").reduce((a: number, x: any) => a + (x.valor || 0), 0);
  await sb.from("esc_dias").update({ proc_docs: docs, valor: Math.round(tot * 100) / 100 }).eq("id", d.dia_id);
  return `✅ Lancei ${it.length} procedimento(s) no plantão — total ${brl(tot)}. A foto ficou guardada como prova no plantão.`;
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
];
const NAVEGA = ["acessar_sistema", "informar_codigo_sistema"];
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
async function conversa(chat: string, contato: any, texto: string, grupo = false) {
  // v7: o WhatsApp pode usar um id "@lid" na conversa; junta também o que o Vini mandou para o número da pessoa
  const chats = [chat, ...variantes(so(contato.telefone)).map((v) => v + "@s.whatsapp.net")];
  const { data: hist } = await sb.from("vini_mensagens").select("direcao,texto").in("chat", grupo ? [chat] : chats).order("em", { ascending: false }).limit(8);
  const msgs: any[] = [{ role: "system", content: `Você é o Vini, assistente do Sistema MR (contas por empresa, escala de anestesia da NAFS e Hospital IDAD) no WhatsApp. Fala português do Brasil, curto e direto, como um funcionário de confiança. Hoje é ${dbr(hojeBahia())}. Está falando com ${contato.nome}. Use as ferramentas para responder com dados reais; nunca invente valores. Você NÃO altera nada por conversa: lançamentos só por foto do mapa cirúrgico com confirmação SIM, o resto é pelo sistema. Formate para WhatsApp (*negrito*, listas curtas). Não assine. Se a pergunta for vaga, use o mês atual. Se o sistema não tiver o dado, diga isso claramente. Se não souber responder ou fazer o que pediram, NUNCA deixe a pessoa sem resposta: diga que vai passar para a equipe técnica.${grupo ? "\n\nATENÇÃO: você está num GRUPO. NUNCA fale de valores, financeiro, pagamentos ou saldos aqui — se perguntarem, diga que isso você só responde no privado." : ""}\n\n${MAPA}\n\nREGRAS APRENDIDAS:\n${await regras()}` }];
  (hist || []).reverse().forEach((h: any) => h.texto && msgs.push({ role: h.direcao === "entrada" ? "user" : "assistant", content: h.texto.replace(ASSINA, "") }));
  if (!msgs.length || msgs[msgs.length - 1].content !== texto) msgs.push({ role: "user", content: texto });
  // ferramentas liberadas: grupo só escala; contato com lista própria (vini_contatos.ferramentas) só a lista
  const lista: string[] | null = grupo ? ["escala", "anestesistas"] : (Array.isArray(contato.ferramentas) && contato.ferramentas.length ? contato.ferramentas : null);
  const base = TOOLS.filter((t: any) => !NAVEGA.includes(t.function.name) || (contato.pode_navegar && !grupo));
  const liberadas = lista ? base.filter((t: any) => lista.includes(t.function.name)) : base;
  if (lista && !grupo) msgs[0].content += `\n\nACESSO RESTRITO: ${contato.nome} só pode consultar: ${lista.join(", ")}. Sobre qualquer outro assunto do sistema (outros CNPJs, NAFS, salários etc.), diga educadamente que essa informação não está liberada para ela/ele.`;
  for (let i = 0; i < 6; i++) {
    const m = await ia(msgs, liberadas);
    if (!m?.tool_calls?.length) return String(m?.content || "Não entendi. Pode repetir?");
    msgs.push(m);
    for (const tc of m.tool_calls) { let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch { /* */ } msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(!liberadas.some((t: any) => t.function.name === tc.function.name) ? { erro: "não liberado para este contato" } : NAVEGA.includes(tc.function.name) ? await navegar(tc.function.name, a, { chat, contato }) : await ferramenta(tc.function.name, a)).slice(0, 12000) }); }
  }
  return "Não consegui fechar a resposta. Pode perguntar de outro jeito?";
}

/* ---------- v9 (20/11/2026): LOTE DE FOTOS, ESCALA, DÚVIDAS E APRENDIZADO ----------
   Pedido do Renato: o Vini nunca descarta um documento. Se não conhece, pergunta a quem mandou o que fazer.
   Se não souber executar a resposta, sobe para a equipe técnica (Claude, tarefa agendada); se ela não resolver em 2 h,
   sobe para o Renato. O que for ensinado vira regra (vini_conhecimento) e entra no cérebro do Vini. */
async function regras(): Promise<string> {
  const { data } = await sb.from("vini_conhecimento").select("assunto,regra").eq("ativo", true).order("id");
  return (data || []).map((r: any, i: number) => `${i + 1}. [${r.assunto}] ${r.regra}`).join("\n");
}
const PROMPT_DOC = (rg: string) => `Voce recebe a FOTO de um documento enviado ao Vini (assistente do Sistema MR: escala de anestesistas NAFS/Anestesia, producao cirurgica, Hospital IDAD).
Classifique e extraia. Responda SOMENTE JSON:
{"tipo":"escala|producao|outro","data":"AAAA-MM-DD ou null","hospital":"","cirurgiao":"",
 "escala":[{"local":"nome do local/hospital como escrito","turno":"M|T|N|SN|","anestesista":"nome","vermelho":false}],
 "itens":[{"paciente":"","idade":null,"procedimento":"","situacao":"realizado|cancelado","obs":""}],
 "resumo":"1 frase dizendo que documento e este (sem CPF, sem endereco)"}
- escala: tabela de anestesistas x locais/turnos de um dia (preencha "escala").
- producao: mapa cirurgico, lista de cirurgias, ficha/descricao cirurgica ou relatorio de procedimentos de UM paciente ou de varios (preencha "itens"; linha riscada = cancelado).
- outro: qualquer outra coisa (pedido de exame, guia, recibo, conversa...). Descreva bem no resumo.
REGRAS APRENDIDAS (siga):
${rg || "(nenhuma)"}`;
async function lerDoc(b64: string, mime: string, legenda: string, rg: string) {
  const msg = await ia([{ role: "user", content: [{ type: "text", text: PROMPT_DOC(rg) + (legenda ? `\n\nTEXTO QUE A PESSOA MANDOU JUNTO: ${legenda}` : "") }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}`, detail: "high" } }] }], undefined, true);
  try { return JSON.parse(String(msg?.content || "").replace(/^```json|```$/g, "")); } catch { return { tipo: "outro", resumo: "não consegui ler a foto" }; }
}
async function baixar(path: string) {
  const { data } = await sb.storage.from("notas").download(path); if (!data) return null;
  const u = new Uint8Array(await data.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s);
}
// foto chegou: guarda e espera ~20 s; quem processa é a última foto da sequência
async function receberFoto(b: any, chat: string, autor: string, contato: any): Promise<string[]> {
  const path = `vini/entrada/${crypto.randomUUID()}.jpg`;
  await sb.storage.from("notas").upload(path, Uint8Array.from(atob(b.midia.b64), (c) => c.charCodeAt(0)), { contentType: b.midia.mime || "image/jpeg" });
  const legenda = String(b.texto || "").trim() || null;
  const { data: ant } = await sb.from("vini_lote").select("id").eq("chat", chat).eq("processado", false).gte("em", new Date(Date.now() - 3 * 60e3).toISOString()).limit(1);
  const { data: eu } = await sb.from("vini_lote").insert({ chat, autor, foto_path: path, mime: b.midia.mime || "image/jpeg", legenda }).select("id").single();
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil((async () => {
    await new Promise((r) => setTimeout(r, 22000));
    const { data: depois } = await sb.from("vini_lote").select("id").eq("chat", chat).eq("processado", false).gt("id", eu.id).limit(1);
    if (depois?.length) return;                                      // chegou outra foto: a última processa
    try { await processarLote(chat, autor, contato); } catch (e) { await sb.from("vini_saida").insert({ chat, texto: "Tive um problema lendo as fotos: " + String((e as Error).message).slice(0, 150) + ". Pode mandar de novo?" }); }
  })());
  return ant?.length ? [] : ["📥 Recebendo… pode mandar todas as fotos. Quando terminar eu leio tudo junto e te respondo com um resumo."];
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
  let n = 0;
  for (const f of fotos) {
    const b64 = await baixar(f.foto_path); if (!b64) continue;
    const d: any = await lerDoc(b64, f.mime, f.legenda || "", rg); n++;
    const data = /^\d{4}-\d{2}-\d{2}$/.test(d?.data || "") ? d.data : null;
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
  let t = `📋 *Li ${n} foto(s).*\n`;
  if (linhasEsc.length) t += "\n" + linhasEsc.join("\n") + "\n";
  if (linhasProd.length) t += "\n*Produção*\n" + linhasProd.join("\n") + "\n";
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
  const m = await ia([{ role: "user", content: prompt }], undefined, true);
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

/* ---------- Mensagem recebida ---------- */
async function entrada(b: any): Promise<string[]> {
  const chat = String(b.chat || ""), autor = so(b.autor), grupo = !!b.grupo, texto = String(b.texto || "").trim();
  await log("entrada", chat, texto || (b.midia ? "[imagem]" : ""), { autor, autor_nome: b.autor_nome || null, grupo, wa_id: b.wa_id || null, midia: b.midia ? { mime: b.midia.mime, bytes: Math.round((b.midia.b64 || "").length * 0.75) } : null });
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
  // ação aguardando resposta?
  const { data: acao } = await sb.from("vini_acoes").select("*").eq("chat", chat).eq("autor", autor).eq("status", "aguardando").gte("criado_em", new Date(Date.now() - 6 * 3600e3).toISOString()).order("criado_em", { ascending: false }).limit(1).maybeSingle();
  if (acao && acao.tipo === "lote" && texto && !b.midia) {   // v9
    const t = norm(texto);
    if (/^(SIM|S|CONFIRMO|PODE|OK|LANCA|PODE FAZER)$/.test(t)) {
      if (!contato.pode_lancar) return ["Você não tem permissão para confirmar lançamentos pelo WhatsApp. Peça ao Renato."];
      const r = await gravarLote(acao); await sb.from("vini_acoes").update({ status: "confirmada", resultado: r, resolvido_em: new Date().toISOString() }).eq("id", acao.id);
      await proximaDuvida(chat); return [r];
    }
    if (/^(NAO|N|CANCELA|CANCELAR)$/.test(t)) { await sb.from("vini_acoes").update({ status: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", acao.id); await proximaDuvida(chat); return ["Ok, não fiz nada desse resumo."]; }
  }
  if (acao && acao.tipo !== "lote" && texto && !b.midia) {
    const t = norm(texto), d = acao.dados;
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
  if (grupo && b.midia) return ["Fotos para lançar eu recebo só no privado — me manda lá, por favor."];
  if (b.midia && /^image\//.test(b.midia.mime || "")) return await receberFoto(b, chat, autor, contato);   // v9: junta as fotos num lote
  // v9: texto mandado no meio das fotos = legenda da última foto
  if (texto && !b.midia) {
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
  if (b.midia) return ["Por enquanto eu leio fotos (imagem). PDF e áudio ainda não."];
  if (!texto) return [];
  // v8: "código 123456" para o navegador do Vini
  const mc = texto.match(/^c[oó]d(?:igo)?\.?\s*:?\s*([A-Za-z0-9 ]{4,12})$/i);
  if (mc && (mc[1].match(/\d/g) || []).length >= 4 && contato.pode_navegar && !grupo) { const r: any = await gravarCodigo(mc[1], { chat, contato }); return [r.ok ? r.resposta_para_a_pessoa : "Não achei acesso esperando código agora (o prazo é de 5 minutos)."]; }
  // agradecimento/confirmação solta não é pergunta (v6): responde curto, sem consultar nada
  if (/^(OK|OKAY|OK OK|BELEZA|BLZ|VALEU|OBRIGADO|OBRIGADA|OBG|TA BOM|TA|SHOW|TOP|PERFEITO|CERTO|ENTENDI|BOM|JOIA|BOA)( VINI)?$/.test(norm(texto)) || /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\s\u{FE0F}\u{200D}]+$/u.test(texto)) return grupo ? [] : ["👍"];
  return [await conversa(chat, contato, texto, grupo)];
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
      const { data } = await sb.from("vini_saida").select("id,chat,texto,imagem_path").eq("status", "pendente").order("criado_em").limit(5);
      if (data?.length) await sb.from("vini_saida").update({ status: "enviando" }).in("id", data.map((x: any) => x.id));
      // v8: print do navegador do Vini -> link temporário (10 min) para o motor baixar e mandar como imagem
      const itens = [];
      for (const x of data || []) {
        let imagem_url = null;
        if (x.imagem_path) { const { data: u } = await sb.storage.from("robo-acessos").createSignedUrl(x.imagem_path, 600); imagem_url = u?.signedUrl || null; }
        itens.push({ id: x.id, chat: x.chat, texto: x.texto + ASSINA, imagem_url });
      }
      return J({ ok: true, itens });
    }
    if (b.acao === "saida_ok") {
      const { data: s } = await sb.from("vini_saida").select("*").eq("id", b.id).maybeSingle();
      if (s) { await sb.from("vini_saida").update(b.ok ? { status: "enviado", enviado_em: agora } : { status: s.tentativas >= 2 ? "erro" : "pendente", tentativas: s.tentativas + 1, erro: String(b.erro || "").slice(0, 300) }).eq("id", b.id);
        if (b.ok) await log("saida", s.chat, s.texto, { wa_id: b.wa_id || null }); }
      return J({ ok: true });
    }
    if (b.acao === "entrada") {
      let resp: string[] = [];
      try { resp = await entrada(b); } catch (e) { resp = ["Tive um problema aqui e não consegui responder agora. O erro ficou registrado no sistema."]; await sb.from("vini_status").update({ erro: String((e as Error).message).slice(0, 300) }).eq("id", 1); }
      for (const t of resp) await log("saida", String(b.chat), t);
      return J({ ok: true, responder: resp.map((t) => t + ASSINA) });
    }
    return J({ erro: "ação desconhecida" }, 400);
  } catch (e) { return J({ erro: (e as Error).message }, 500); }
});
