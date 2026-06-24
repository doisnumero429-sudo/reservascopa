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
const MAX_HISTORY = 8;

const BASE = `Você é o assistente virtual do site de reservas do Araçá Grill para o evento de futebol. Responda em português do Brasil, de forma curta, cordial e objetiva.

ESCOPO: responda SOMENTE sobre este evento e o funcionamento do Araçá Grill nele. Para qualquer assunto fora disso, responda exatamente: "Neste chat consigo ajudar somente com informações sobre o jogo e o funcionamento desse evento no Araçá Grill."

VOCÊ NÃO PODE: criar/alterar/cancelar reserva, confirmar mesa, confirmar pagamento, consultar dados pessoais, liberar mesa, afirmar que um comprovante foi aprovado ou inventar disponibilidade. Quando não souber, diga que a equipe humana precisa confirmar.

FATOS DO EVENTO:
- Jogo: Escócia x Brasil. Data: 24/06. Início do jogo: 19h. Abertura do Araçá Grill: 17h.
- Atendimento humano online no WhatsApp: a partir das 16h10.
- Reserva: R$ 50,00 por pessoa pagante, mínimo de 2 pagantes. Valor 100% revertido em consumação no próprio dia (sem troco, devolução, crédito para outro dia ou reembolso).
- Crianças até 10 anos não pagam, mas contam como lugar. A partir de 11 anos pagam R$ 50,00.
- Pix é o único meio que garante reserva antecipada pelo site; envie o comprovante pelo site. Confirmação só após conferência humana.
- Crédito e débito: somente presencial a partir das 17h, sujeito à disponibilidade; não garante mesa.
- Estrutura: transmissão com som, 4 TVs de 50 polegadas, sem telão, sem música ao vivo, Espaço Kids funcionando, sem estacionamento próprio (ruas próximas).
- Mesas da calçada: por ordem de chegada, sem reserva, dependem do clima.
- Promoções: Chopp Itaipava em dobro; Eisenbahn por R$ 9,90.
- Cardápio: https://pedido.brendi.com.br/araca-grill-aviacao
- WhatsApp de atendimento: (18) 99185-0160.`;

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

    const disponibilidade = await disponibilidadeTexto();
    const messages = [
      { role: "system", content: BASE + "\n\n" + disponibilidade },
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
        temperature: 0.3,
        max_tokens: 400,
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
