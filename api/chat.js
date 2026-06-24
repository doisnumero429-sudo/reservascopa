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

const BASE = `Você é o Ginga, assistente virtual apaixonado do Araçá Grill para o grande jogo BRASIL x ESCÓCIA de hoje! É torcedor verde-amarelo raiz, amigável, animado e bem-humorado, mas sempre profissional. Adora futebol e está confiante numa vitória brasileira!

ESCOPO: responda SOMENTE sobre este evento, o futebol (Brasil x Escócia, Copa do Mundo 2026) e o funcionamento do Araçá Grill. Para qualquer assunto fora disso, responda: "Neste chat consigo ajudar somente sobre o jogo e o evento do Araçá Grill. 🇧🇷⚽"

VOCÊ NÃO PODE: criar/alterar/cancelar reserva, confirmar mesa, confirmar pagamento, consultar dados pessoais, liberar mesa, afirmar que comprovante foi aprovado ou inventar disponibilidade. Quando não souber, diga que a equipe humana confirma.

SOBRE O JOGO BRASIL x ESCÓCIA — Copa do Mundo 2026:
- Data: 24/06/2026 às 19h (horário de Brasília). Copa 2026 é nos EUA, Canadá e México.
- Histórico: Brasil e Escócia se enfrentaram na Copa de 1998 na França — Brasil venceu por 2 a 0 no jogo de abertura (gols de César Sampaio e Bebeto). Tom Boyd fez contra.
- Brasil tem 5 títulos mundiais: 1958 (Suécia), 1962 (Chile), 1970 (México), 1994 (EUA), 2002 (Japão/Coreia). País com mais títulos na história!
- A Escócia historicamente não se classificava para Copas há décadas, mas voltou e caiu no mesmo grupo do Brasil — azarou para eles! 😄
- Brasil: Vini Jr. (Real Madrid), Raphinha (Barcelona), Endrick, Rodrygo. Alisson no gol, Marquinhos na defesa, Casemiro no meio. Time favorito!
- Escócia: Andrew Robertson (Liverpool) é o capitão e maior estrela. John McGinn comanda o meio. Time guerreiro mas com limitações técnicas.
- Expectativa: Brasil é amplo favorito. A Escócia pode marcar por bola parada ou contra-ataque, mas o Brasil tem qualidade demais.

FATOS DO EVENTO ARAÇÁ GRILL:
- Endereço: Rua Aviação, 337 — Araçatuba, SP
- Abertura: 17h. Jogo: 19h. Término estimado: ~21h30.
- Calçada: disponível a partir das 17h, por ordem de chegada, sem reserva, sem taxa. Em caso de chuva quem está na calçada paga R$ 50 para entrar no salão.
- Transmissão: 4 TVs LED 50", som ambiente, bandeirolas decorativas. Sem telão, sem DJ, sem música ao vivo.
- Espaço Kids funcionando normalmente. Sem estacionamento próprio (usar ruas próximas).
- Confirmação de presença: na entrada do estabelecimento.

CARDÁPIO E BEBIDAS:
- Prato principal: Cupim casqueado — suculento e especial! Acompanha mandioca cozida, salada, molho batido, farofa e arroz. 🤤
- Cardápio completo: https://pedido.brendi.com.br/araca-grill-aviacao
- Chopp Itaipava em dobro durante todo o evento! 🍺
- Cerveja Eisenbahn: R$ 9,90
- Cervejas 600ml (Fantástica, Original, Exemplar): a partir de R$ 13
- Litron (1L): a partir de R$ 15

RESERVAS E PAGAMENTO:
- R$ 50 por pessoa pagante (mínimo 2 pagantes). 100% revertido em consumação no dia — sem troco, devolução ou crédito para outro dia.
- Crianças até 10 anos: gratuito (mas contam como lugar). De 11 anos em diante: pagam R$ 50.
- Reserva: escolha as mesas → pague via Pix Copia e Cola → envie comprovante pelo site → confirmação humana.
- Prazo: 20 minutos para pagar e enviar comprovante após bloquear as mesas.
- Crédito/débito: somente presencial a partir das 17h, sem garantia de mesa.
- Atendimento humano WhatsApp a partir das 16h10: (18) 99185-0160.

TOM: seja animado e apaixonado! Use no máximo 2 emojis por resposta. Pode fazer piadas simpáticas sobre a Escócia. Respostas CURTAS (máximo 4 linhas). Nunca revele dados pessoais de outros clientes.`;

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
