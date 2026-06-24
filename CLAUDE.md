# Araçá Grill — Reservas da Copa (Escócia x Brasil, 24/06, 19h)

Site de reserva antecipada de mesas por Pix, com bloqueio atômico no Supabase,
upload privado de comprovante, redirecionamento para WhatsApp e chatbot (OpenRouter).
Confirmação final é sempre humana (após as 17h).

## Arquitetura real
- **Frontend:** `index.html` único (HTML+CSS+JS inline). Mapa é um PNG base64 na
  linha ~758 (`const MAPIMG="data:image/png;base64,..."`, ~3,2 MB).
  ⚠️ NUNCA leia o index.html inteiro / não use `cat`. Use `rg` e leia trechos.
  A seção JS começa na linha ~759. Constantes do evento: linhas ~750–758.
- **Backend:** funções serverless da Vercel em `api/` + helpers em `lib/`.
  Tudo ESM (`package.json` tem `"type":"module"`, Node ≥20).
- **Banco:** Supabase (Postgres + Storage privado). Toda lógica sensível é RPC
  `security definer`; só a `service_role` executa. RLS bloqueia anon/authenticated.

## Arquivos principais
- `index.html` — site público (mapa, formulário, Pix, upload, chatbot). NÃO reescrever.
- `lib/supabase.js` — client service_role (lazy), constantes, token/hash, DTO, erros PT.
- `lib/http.js` — JSON, CORS/OPTIONS, validação de origem, rate limit, leitura de body.
- `api/config.js` — GET: URL pública + chave publishable (nunca service role/OpenRouter).
- `api/reservations.js` — GET occupied; POST create/cancel/resume.
- `api/proof.js` — POST prepare (signed upload URL) / confirm (verifica arquivo + RPC).
- `api/chat.js` — POST chat OpenRouter, tema restrito, injeta só CONTAGEM de mesas livres.
- `supabase_copa_instalacao_limpa.sql` — instalação do zero (aborta se houver dados reais).
- `supabase_copa_completo.sql` — mesma estrutura, idempotente (re-executável).
- `LEIA-ME.txt`, `INSTRUCAO-BRENDA.txt`, `CHAVES-VERCEL.txt` (só nomes de variáveis).

## Rotas / contratos (frontend ↔ backend)
- `GET /api/config` → `{ok, supabaseUrl, supabasePublishableKey}`
- `GET /api/reservations?action=occupied` → `{ok, occupied:[numeros]}`
- `POST /api/reservations {action:"create", nome, whatsapp, pagantes, criancas, observacao, mesas}`
  → `{ok, reservation}`; conflito → 409 + `code:"MESA_INDISPONIVEL"`
- `POST /api/reservations {action:"cancel"|"resume", protocol, accessToken}`
- `POST /api/proof {action:"prepare", protocol, accessToken, filename, mimeType, size}`
  → `{ok, bucket, path, token}` (frontend faz `sb.storage.from(bucket).uploadToSignedUrl(path, token, file)`)
- `POST /api/proof {action:"confirm", protocol, accessToken, path, filename, mimeType, size}`
  → `{ok, proofSubmittedAt}`
- `POST /api/chat {message, history}` → `{ok, answer}`

**reservation DTO:** `{protocol, accessToken, name, whatsapp, payers, children,
totalPeople, observation, tables[], status, amountCents, expiresAt, proofSubmittedAt}`

## Variáveis na Vercel (apenas nomes)
Obrigatórias: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_PUBLISHABLE_KEY` (fallback `SUPABASE_ANON_KEY`), `OPENROUTER_API_KEY`.
Opcionais: `OPENROUTER_MODEL` (padrão `openai/gpt-4.1-mini`),
`OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`, `ALLOWED_ORIGIN`.
A `SUPABASE_SERVICE_ROLE_KEY` NUNCA vai ao navegador. Alterar env exige novo deploy.

## Banco (prefixo copa_)
Tabelas: `copa_eventos`, `copa_mesas` (1–49 reserváveis; 50–67 calçada não),
`copa_reservas`, `copa_reserva_mesas` (histórico), `copa_mesas_bloqueios`
(somente isto = mesa indisponível agora; PK (evento,mesa) garante atomicidade),
`copa_reserva_historico`. View: `copa_reservas_admin`.
Bucket privado: **`copa-comprovantes`** (5 MB; jpg/png/webp/pdf).
RPCs: `listar_mesas_ocupadas_copa_v2`, `criar_reserva_copa_v2`,
`registrar_comprovante_copa_v2`, `cancelar_reserva_copa_cliente_v2`,
`confirmar_reserva_copa_admin`, `cancelar_reserva_copa_admin`,
`copa_limpar_bloqueios_expirados_v2`.
Status: `aguardando_pagamento` → `comprovante_enviado` → `confirmada` /
`cancelada` / `expirada`. (Frontend e SQL já usam exatamente estes nomes.)
EVENTO_ID = `escocia_brasil_2026_06_24`. Valor: 5000 centavos/pagante, mín. 2.

## Fluxo de reserva
cadastro → mapa (occupied) → revisão → create (bloqueio 20 min, atômico) →
Pix (chave 18981300250, Allan C. Barboza, Santander) → upload comprovante →
confirm (status comprovante_enviado, expira_em=null) → WhatsApp com marcador
`[ARACA_COPA_COMPROVANTE_RECEBIDO_PELO_SITE]` → conferência humana.
WhatsApp destino: 5518991850160. Exibido: (18) 99185-0160.

## Regras do evento (não alterar)
R$ 50/pagante, mín. 2 pagantes; crianças ≤10 não pagam mas contam lugar; 11+ pagam.
Consumação 100% revertida, sem troco/reembolso. Cartão só presencial após 17h
(não garante mesa). Atendimento humano online 16h10. 4 TVs 50", som, sem telão,
sem música ao vivo, Espaço Kids, sem estacionamento próprio. Calçada por ordem
de chegada. Chopp Itaipava em dobro; Eisenbahn R$ 9,90.
Cardápio: https://pedido.brendi.com.br/araca-grill-aviacao

## Comandos de teste
- Sintaxe JS: `for f in lib/*.js api/*.js; do node --check "$f"; done`
- Sintaxe inline do index: extrair blocos `<script>` (sem src) e `node --check`.
- Em produção/preview: `GET /api/config`, `GET /api/reservations?action=occupied`,
  `POST /api/chat` (faça só 1 chamada real à OpenRouter — economia de créditos).
- ⚠️ `npm install` é bloqueado por política de egress nesta sessão; a Vercel
  instala `@supabase/supabase-js` no build. Sem node_modules local não dá para
  rodar os handlers que importam o supabase-js localmente.

## Decisões / histórico
- **Causa raiz corrigida:** `api/` e `lib/` nunca foram commitados (sem .gitignore);
  todas as rotas davam 404. Backend reconstruído conforme contrato do SQL+frontend.
- `index.html`, mapa, coordenadas, SQL e identidade visual: preservados intactos.
- Resume não tem RPC própria → SELECT direto via service_role (bypassa RLS).
- Confirmação de comprovante valida existência real do arquivo (createSignedUrl)
  antes de mudar status — não confia só no frontend.
- Caminho do comprovante é sempre gerado pelo servidor (`evento/protocolo/arquivo.ext`).

## Pendente (Fase 6 — não bloqueia o evento)
Página administrativa protegida (Supabase Auth) usando a view `copa_reservas_admin`
e as RPCs `confirmar_reserva_copa_admin` / `cancelar_reserva_copa_admin` +
geração de URL temporária do comprovante. Building blocks já existem no SQL.
