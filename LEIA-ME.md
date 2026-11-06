# Sistema MR (código interno: CPE)

Sistema do grupo do Vinicius (M.R Serviços Médicos, NAFS e os outros CNPJs): financeiro por CNPJ e escalas da NAFS e da Anestesia.
Desenvolvido e mantido pela **RF Sistemas**.

- **No ar:** https://rf-sistemas.github.io/contas-por-empresa/
- **Publicação:** GitHub Pages, a partir do ramo `main`. Tudo o que entra no `main` vai para o ar em 1 ou 2 minutos.
- **APK Android:** `apk/SistemaMR.apk`, gerado automaticamente pelo GitHub Actions.

---

## Regras do projeto (leia antes de mexer)

1. **Ramo `main` = produção.** Cada commit no `main` vai direto para os usuários. Antes de começar, sempre faça `git pull`, porque a RF Sistemas também publica neste repositório.
2. **O arquivo principal se chama sempre `index.html`.** Com outro nome (`index (1).html`, `index-v71.html`…), o site não atualiza.
3. **Versão em 4 lugares.** A cada entrega, suba a versão (`v70` → `v71`) e atualize a data em todos estes pontos:
   - meta tags no `<head>`: `rf-versao` e `rf-data`;
   - a const `SISTEMA` no topo do script (`versao` e `data`);
   - o selo do rodapé e a linha no console, que já leem a const `SISTEMA`.
4. **Prévia antes de publicar.** Mande ao Renato um print da tela nova e só publique depois que ele aprovar.
5. **Não misture com outros sistemas.** O Sistema MR não compartilha código, banco nem dados com o rf-logistica-app nem com o Rodavia 360.
6. **Identidade visual:** logo "MR" em degradê verde → turquesa → azul; as cores das telas seguem a logo.

## Estrutura do repositório

| Arquivo / pasta | O que é |
|---|---|
| `index.html` | O sistema inteiro: HTML, CSS e JavaScript num arquivo só, sem build. |
| `manifest.json` | Nome do app ("Sistema MR") e ícones para instalar no celular. |
| `service-worker.js` | Cache para funcionar como app instalado (PWA). |
| `icon-*.png`, `apple-touch-icon.png` | Ícones MR (Android, iPhone, maskable). |
| `android-app/` | Projeto Android (WebView) que abre o site em tela cheia. |
| `.github/workflows/apk.yml` | Compila o APK quando algo muda em `android-app/` e grava em `apk/`. |
| `apk/` | O APK pronto (`SistemaMR.apk`) e o log da última compilação. |

O site **não precisa de novo APK** para atualizar: o app Android carrega o site. Só mexa em `android-app/` se a mudança for no próprio app (permissões do celular, ícone, comportamento de links etc.).

## Banco de dados (Supabase)

- Projeto: `contas-por-empresa`, URL `https://btbxqbozmrbbhjjpajbv.supabase.co`.
- A chave que está no `index.html` é a **chave pública (anon)**. Quem protege os dados é o RLS do banco, não o código.
- **Alterações no banco** (tabelas, colunas, políticas RLS, funções, edge functions) **não são feitas pelo GitHub**. Peça ao Renato / RF Sistemas e descreva exatamente o que precisa.

Tabelas principais:

| Tabela | Uso |
|---|---|
| `empresas` | Os CNPJs do grupo. |
| `movimentos` | Entradas e saídas por CNPJ. `empresa_id` vazio = fila "Apontar depois". |
| `origens` | Cartões e contas bancárias. |
| `regras_fornecedor` | Nomes/fornecedores que o sistema aprendeu, por CNPJ. |
| `perfis` | Logins: `papel` (mestre, dono, operador, leitura, anestesista), `abas` e `hospitais` (permissões, v69). |
| `perfil_empresas` | Quais CNPJs cada login enxerga (nenhum = todos). |
| `esc_hospitais` | Cadastro de hospitais. |
| `esc_locais` | Hospitais/unidades usados na escala. |
| `esc_anestesistas` | Anestesistas (grupo NAFS ou ANESTESIA). |
| `esc_dias` | Plantões da escala (dia, turno, local, anestesista, status). |

Edge functions chamadas pelo site: `criar-usuario`, `ler-empresa`, `ler-escala`, `ler-nota`.

Funções de permissão usadas no RLS: `cpe_papel()`, `cpe_mestre()`, `cpe_edita()`, `cpe_nao_anes()`, `cpe_ve_empresa(id)`, `cpe_ve_hosp(nome)`, `cpe_ve_local(id)`.

## Regras de acesso (não quebrar)

- **mestre**: vê tudo, sempre.
- **dono**: vê tudo e administra usuários (a não ser que tenha trava de CNPJ).
- **operador**: lança e edita; **leitura**: só consulta.
- **anestesista**: vê só a escala, só os próprios valores, e só confirma os próprios plantões.
- **Permissões por login (v69)**: em Usuários → 🔒 permissões, cada login pode ter as abas, os hospitais e os CNPJs que enxerga. No código: `veAba(chave)`, `veHosp(nome)` e a lista `CPE_ABAS`. Se criar uma aba nova, inclua a chave dela em `CPE_ABAS` e proteja com `veAba()`.
- **Áreas**: NAFS (escala por turno: Manhã 7h–13h, Tarde 13h–19h, Noite 19h–7h) e Anestesia (Hospital Evanice Rocha, que fica **só** na Anestesia e nunca na NAFS).

## Como testar

Não há build: abra o `index.html` no navegador ou publique e teste em https://rf-sistemas.github.io/contas-por-empresa/. Depois de publicar, confira se o rodapé mostra a versão nova. Se o celular continuar com a versão antiga, recarregue a página, porque o service worker guarda cache.
