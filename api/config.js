// GET /api/config — devolve apenas o que o navegador precisa para o upload assinado.
// NUNCA retorna service role nem chave da OpenRouter.

import {
  sendJson,
  applyCommonHeaders,
  handlePreflight,
  clientError,
  serverError,
} from "../lib/http.js";
import { getPublishableKey } from "../lib/supabase.js";

export default async function handler(req, res) {
  applyCommonHeaders(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET") return clientError(res, "Método não permitido.", 405);

  try {
    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabasePublishableKey = getPublishableKey();
    if (!supabaseUrl || !supabasePublishableKey) {
      return sendJson(res, 503, {
        ok: false,
        error: "Configuração pública indisponível.",
      });
    }
    return sendJson(res, 200, {
      ok: true,
      supabaseUrl,
      supabasePublishableKey,
      evento: "escocia_brasil_2026_06_24",
    });
  } catch (err) {
    return serverError(res, err);
  }
}
