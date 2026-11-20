// Edge Function: vini-ponte — CÉREBRO DO ROBÔ VINI (WhatsApp do Sistema MR)
// Só o motor do WhatsApp (VPS) chama esta função, com o cabeçalho x-vini-token (token na tabela vini_segredo).
// Ações: status (motor informa conexão/QR/grupos), saida (motor busca o que enviar), saida_ok, entrada (mensagem recebida).
// Regras: só responde a contatos cadastrados em vini_contatos; lançamento só depois de "SIM" de quem pode_lancar;
// tudo fica gravado em vini_mensagens / vini_acoes. Nunca usa o banco da RF.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSAO = "vini-ponte v4 (20/11/2026)";
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
  return (await r.json())?.choices?.[0]?.message;
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
];
async function empresas() { const { data } = await sb.from("empresas").select("id,nome,cnpj,ativo"); return data || []; }
const mesAtual = () => hojeBahia().slice(0, 7);
const fimMes = (m: string) => { const [a, b] = m.split("-").map(Number); return new Date(Date.UTC(a, b, 0)).toISOString().slice(0, 10); };
const soma = (l: any[], k = "valor") => Math.round(l.reduce((s, x) => s + (+x[k] || 0), 0) * 100) / 100;
async function tudo(q: () => any) { let out: any[] = []; for (let i = 0; i < 20; i++) { const { data } = await q().range(i * 1000, i * 1000 + 999); out = out.concat(data || []); if (!data || data.length < 1000) break; } return out; }
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
  const { data: hist } = await sb.from("vini_mensagens").select("direcao,texto").eq("chat", chat).order("em", { ascending: false }).limit(8);
  const msgs: any[] = [{ role: "system", content: `Você é o Vini, assistente do Sistema MR (contas por empresa, escala de anestesia da NAFS e Hospital IDAD) no WhatsApp. Fala português do Brasil, curto e direto, como um funcionário de confiança. Hoje é ${dbr(hojeBahia())}. Está falando com ${contato.nome}. Use as ferramentas para responder com dados reais; nunca invente valores. Você NÃO altera nada por conversa: lançamentos só por foto do mapa cirúrgico com confirmação SIM, o resto é pelo sistema. Formate para WhatsApp (*negrito*, listas curtas). Não assine. Se a pergunta for vaga, use o mês atual. Se o sistema não tiver o dado, diga isso claramente.${grupo ? "\n\nATENÇÃO: você está num GRUPO. NUNCA fale de valores, financeiro, pagamentos ou saldos aqui — se perguntarem, diga que isso você só responde no privado." : ""}\n\n${MAPA}` }];
  (hist || []).reverse().forEach((h: any) => h.texto && msgs.push({ role: h.direcao === "entrada" ? "user" : "assistant", content: h.texto.replace(ASSINA, "") }));
  if (!msgs.length || msgs[msgs.length - 1].content !== texto) msgs.push({ role: "user", content: texto });
  for (let i = 0; i < 6; i++) {
    const m = await ia(msgs, grupo ? TOOLS.filter((t: any) => ["escala", "anestesistas"].includes(t.function.name)) : TOOLS);
    if (!m?.tool_calls?.length) return String(m?.content || "Não entendi. Pode repetir?");
    msgs.push(m);
    for (const tc of m.tool_calls) { let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch { /* */ } msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(await ferramenta(tc.function.name, a)).slice(0, 12000) }); }
  }
  return "Não consegui fechar a resposta. Pode perguntar de outro jeito?";
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
  if (acao && texto && !b.midia) {
    const t = norm(texto), d = acao.dados;
    if (!d.dia_id && /^\d{1,2}$/.test(t) && d.candidatos[+t - 1]) { d.dia_id = d.candidatos[+t - 1].id; await sb.from("vini_acoes").update({ dados: d }).eq("id", acao.id); return [resumoProducao(d)]; }
    const m = texto.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!d.dia_id && m) { const ano = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : hojeBahia().slice(0, 4); d.data = `${ano}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      const ps = await plantoesDoDia(d.data); d.candidatos = ps.map((p) => ({ id: p.id, rot: rotPlantao(p), servicos: p.cad?.servicos || [] })); d.dia_id = ps.length === 1 ? ps[0].id : null;
      await sb.from("vini_acoes").update({ dados: d }).eq("id", acao.id); return [resumoProducao(d)]; }
    if (/^(SIM|S|CONFIRMO|PODE|PODE LANCAR|OK|LANCA)$/.test(t) && d.dia_id) {
      if (!contato.pode_lancar) return ["Você não tem permissão para confirmar lançamentos pelo WhatsApp. Peça ao Renato."];
      try { const r = await gravarProducao(acao); await sb.from("vini_acoes").update({ status: "confirmada", resultado: r, resolvido_em: new Date().toISOString() }).eq("id", acao.id); return [r]; }
      catch (e) { await sb.from("vini_acoes").update({ status: "erro", resultado: String((e as Error).message), resolvido_em: new Date().toISOString() }).eq("id", acao.id); return ["Não consegui lançar: " + (e as Error).message]; }
    }
    if (/^(NAO|N|CANCELA|CANCELAR)$/.test(t)) { await sb.from("vini_acoes").update({ status: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", acao.id); await sb.storage.from("notas").remove([d.foto]); return ["Ok, não lancei nada."]; }
  }
  if (grupo && b.midia) return ["Fotos para lançar eu recebo só no privado — me manda lá, por favor."];
  if (b.midia && /^image\//.test(b.midia.mime || "")) return [await lerProducao(chat, autor, b.midia)];
  if (b.midia) return ["Por enquanto eu leio fotos (imagem). PDF e áudio ainda não."];
  if (!texto) return [];
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
      const { data } = await sb.from("vini_saida").select("id,chat,texto").eq("status", "pendente").order("criado_em").limit(5);
      if (data?.length) await sb.from("vini_saida").update({ status: "enviando" }).in("id", data.map((x: any) => x.id));
      return J({ ok: true, itens: (data || []).map((x: any) => ({ ...x, texto: x.texto + ASSINA })) });
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
