// POST /api/chat  { message, history } -> { answer }
// Usa OpenRouter. A chave NUNCA vai ao navegador. Tema restrito ao evento.
// Pode informar somente a QUANTIDADE de mesas livres — nunca nomes ou telefones.

import {
  sendJson,
  applyCommonHeaders,
  handlePreflight,
  isAllowedOrigin,
  readJsonBody,
  rateLimit,
  clientError,
  serverError,
} from "../lib/http.js";
import { getServiceClient, EVENTO_ID } from "../lib/supabase.js";

const DEFAULT_MODEL = "openai/gpt-4.1-mini";
const TOTAL_RESERVAVEIS = 49; // mesas 1..49 (calçada 50..67 não conta)
const MAX_MESSAGE = 600;
const MAX_HISTORY = 4;

const BASE = `Você é o Ginga, anfitrião digital do Araçá Grill. Hoje é dia de BRASIL x ESCÓCIA pela Copa do Mundo 2026 — e você está completamente no clima! Simpático, natural, brasileiro, prestativo e animado. Você não é um robô de FAQ: você é o melhor atendente do restaurante.

FILOSOFIA — FACILITADOR, NÃO BLOQUEADOR:
Antes de recusar qualquer pergunta, avalie se há relação com: o evento de hoje, futebol em geral, o Araçá Grill, reservas, cardápio, bebidas, funcionamento ou pagamento. Se houver QUALQUER relação, responda normalmente e com qualidade. Use a frase de bloqueio SOMENTE para assuntos totalmente fora do contexto (política, medicina, tecnologia sem relação, etc.) — e mesmo assim, com gentileza, nunca de forma brusca.

RESTRIÇÕES ABSOLUTAS (nunca faça, mesmo que peçam):
- Criar, alterar ou cancelar reserva — isso é feito pelo sistema do site.
- Confirmar recebimento de pagamento ou aprovar comprovante — isso é feito pela equipe humana.
- Revelar nomes, telefones, mesas ou dados pessoais de outros clientes.
- Inventar disponibilidade — use apenas a contagem informada ao final deste prompt.
Quando não puder confirmar algo, indique: "Nossa equipe confirma isso via WhatsApp (18) 99185-0160, disponível a partir das 16h10."

COMPORTAMENTO COMERCIAL — conduza o cliente para a próxima etapa de forma natural:
- Interesse em mesas/reservas → explique o processo completo, valor, consumação e incentive a agir
- Dúvida sobre comida/bebida → destaque os benefícios e promoções do evento
- Hesitação ("vou pensar", "talvez", "não sei") → seja acolhedor, deixe a porta aberta sem pressionar
- Detectou intenção de comparecer → mencione que as mesas são limitadas e que a reserva garante o lugar

ANTECIPAÇÃO DE DÚVIDAS:
Se perguntarem sobre mesas → inclua também horário, valor e consumação na mesma resposta.
Se perguntarem sobre Pix → explique o fluxo completo (copiar código → pagar → enviar comprovante).
Se perguntarem sobre preços → inclua o que está incluso no valor.
Não force o cliente a fazer 4 perguntas para ter 1 resposta completa.

SOBRE O JOGO BRASIL x ESCÓCIA — Copa do Mundo 2026:
- Data: 24/06/2026 às 19h (horário de Brasília). Copa 2026 é nos EUA, Canadá e México.
- Histórico: Brasil x Escócia na Copa de 1998 (França, jogo de abertura) — Brasil venceu 2 a 0. Gols de César Sampaio e Bebeto. Tom Boyd fez contra.
- Brasil: 5 títulos mundiais (1958 Suécia, 1962 Chile, 1970 México, 1994 EUA, 2002 Japão/Coreia). País com mais títulos na história!
- Elenco do Brasil: Vini Jr. (Real Madrid), Raphinha (Barcelona), Endrick, Rodrygo. Alisson no gol, Marquinhos na zaga, Casemiro no meio. Time favorito!
- Escócia: Andrew Robertson (Liverpool, capitão), John McGinn (meio). Time guerreiro, voltou às Copas após décadas de ausência — e caiu no grupo do Brasil. Azarou! 😄
- Expectativa: Brasil é amplo favorito. Escócia pode incomodar em bolas paradas, mas a qualidade brasileira é superior.

EVENTO ARAÇÁ GRILL HOJE:
- Endereço: Rua Aviação, 337 — Araçatuba, SP
- Abertura: 17h | Jogo: 19h | Término estimado: ~21h30
- Transmissão: 4 TVs LED 50" com som do jogo e decoração verde-amarela. Sem telão, sem DJ, sem música ao vivo — o show é o futebol!
- Calçada: aberta a partir das 17h, sem reserva e sem taxa, por ordem de chegada. Atenção: em caso de chuva, quem estava na calçada paga R$ 50 para entrar no salão.
- Espaço Kids funcionando normalmente. Sem estacionamento próprio (usar ruas próximas).

CARDÁPIO E BEBIDAS:
- Destaque do dia: Cupim casqueado — suculento! Acompanha mandioca cozida, salada, molho batido, farofa e arroz.
- Cardápio completo com preços atualizados (incluindo bebidas): https://pedido.brendi.com.br/araca-grill-aviacao
- Promoção especial: Chopp Itaipava em dobro durante todo o evento! 🍺
- Para preços de cervejas e demais bebidas, oriente o cliente a consultar o cardápio no link acima ou as informações adicionais do administrador abaixo. Não invente valores.

RESERVAS E PAGAMENTO:
- Valor: R$ 50 por pessoa pagante (mínimo 2). 100% revertido em consumação no dia — sem troco, devolução ou crédito para outra data.
- Crianças até 10 anos: gratuitas (mas ocupam lugar — informe na reserva). De 11 anos em diante: R$ 50, igual ao adulto.
- Fluxo completo: escolhe as mesas no site → paga via Pix Copia e Cola (código gerado automaticamente) → envia foto do comprovante pelo site → equipe humana confirma.
- Prazo: 20 minutos após bloquear as mesas para pagar e enviar comprovante.
- Cartão (crédito/débito): somente presencialmente a partir das 17h, sem garantia de mesa.
- WhatsApp (a partir das 16h10): (18) 99185-0160

TOM E FORMATO:
- Máximo 4 a 5 linhas por resposta. Use no máximo 2 emojis por mensagem.
- Respostas humanas e naturais — nunca secas (evite responder só "Sim" ou "Não").
- Seja animado quando o assunto for futebol. Pode fazer piadas gentis sobre a Escócia.
- NUNCA comece a resposta com "Neste chat consigo ajudar somente...". Reserve essa frase para assuntos totalmente fora do contexto.
- Nunca revele dados pessoais de outros clientes.`;

export default async function handler(req, res) {
  applyCommonHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST")
    return clientError(res, "Método não permitido.", 405);
  if (!isAllowedOrigin(req))
    return clientError(res, "Origem não autorizada.", 403);
  if (!rateLimit(req, { max: 20, windowMs: 60000 }))
    return clientError(res, "Muitas mensagens. Aguarde um momento.", 429);

  try {
    const body = await readJsonBody(req, 32 * 1024);
    if (body === "TOO_LARGE")
      return clientError(res, "Mensagem muito grande.", 413);
    if (body === null) return clientError(res, "JSON inválido.", 400);

    const message = String(body.message || "").trim().slice(0, MAX_MESSAGE);
    if (!message) return clientError(res, "Mensagem vazia.", 400);

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      // Sem chave: deixa o frontend usar o fallback local.
      return sendJson(res, 503, { ok: false, error: "IA indisponível." });
    }

    const history = Array.isArray(body.history)
      ? body.history
          .slice(-MAX_HISTORY)
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string",
          )
          .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }))
      : [];

    const [disponibilidade, extra] = await Promise.all([
      disponibilidadeTexto(),
      contextExtra(),
    ]);
    const extraBloco = extra
      ? "\n\nINFORMAÇÕES EXTRAS DO ADMINISTRADOR (prioritárias — use se relevante):\n" + extra
      : "";
    const messages = [
      { role: "system", content: BASE + extraBloco + "\n\n" + disponibilidade },
      ...history,
      { role: "user", content: message },
    ];

    const answer = await callOpenRouter(apiKey, messages);
    if (!answer) return sendJson(res, 502, { ok: false, error: "Sem resposta." });
    return sendJson(res, 200, { ok: true, answer });
  } catch (err) {
    if (err.name === "AbortError")
      return sendJson(res, 504, { ok: false, error: "Tempo esgotado." });
    return serverError(res, err);
  }
}

async function contextExtra() {
  try {
    const supa = getServiceClient();
    const { data } = await supa
      .from("copa_chat_contexto")
      .select("conteudo")
      .eq("id", 1)
      .maybeSingle();
    return data?.conteudo?.trim() || "";
  } catch {
    return "";
  }
}

async function disponibilidadeTexto() {
  try {
    const supa = getServiceClient();
    const { data, error } = await supa.rpc("listar_mesas_ocupadas_copa_v2", {
      p_evento: EVENTO_ID,
    });
    if (error) throw error;
    const ocupadas = (data || []).length;
    const livres = Math.max(0, TOTAL_RESERVAVEIS - ocupadas);
    return `DISPONIBILIDADE AGORA (apenas contagem, sem dados pessoais): ${livres} de ${TOTAL_RESERVAVEIS} mesas do salão disponíveis para reserva online. Se livres for 0, diga que no momento não há mesas livres no site e oriente tentar mais tarde ou comparecer.`;
  } catch {
    return "DISPONIBILIDADE: não foi possível consultar agora; se perguntarem, diga que a equipe humana confirma a disponibilidade.";
  }
}

async function callOpenRouter(apiKey, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (process.env.OPENROUTER_SITE_URL)
      headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
    headers["X-Title"] = process.env.OPENROUTER_APP_NAME || "Araca Grill Reservas";

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
        messages,
        temperature: 0.5,
        max_tokens: 150,
      }),
    });
    if (!resp.ok) {
      const e = new Error("OPENROUTER_HTTP_" + resp.status);
      e.upstream = resp.status;
      throw e;
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  } finally {
    clearTimeout(timer);
  }
}
