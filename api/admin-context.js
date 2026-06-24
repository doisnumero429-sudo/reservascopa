// GET  /api/admin-context?senha=xxx        → { ok, conteudo, atualizado_em, atualizado_por }
// POST /api/admin-context { senha, conteudo } → { ok }
// Protegido pela variável de ambiente ADMIN_SENHA (obrigatória — sem ela, retorna 503).

import {
  sendJson,
  applyCommonHeaders,
  handlePreflight,
  readJsonBody,
  rateLimit,
  clientError,
  serverError,
} from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";

function checkSenha(senha) {
  const expected = process.env.ADMIN_SENHA;
  if (!expected) return false;
  return String(senha || "") === expected;
}

function getSenhaFromUrl(url) {
  try {
    return new URL("http://x" + url).searchParams.get("senha") || "";
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  applyCommonHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (!process.env.ADMIN_SENHA)
    return sendJson(res, 503, { ok: false, error: "ADMIN_SENHA não configurada." });

  // Rate limit agressivo: 10 req/min por IP (freio a força bruta)
  if (!rateLimit(req, { max: 10, windowMs: 60000 }))
    return clientError(res, "Muitas tentativas. Aguarde.", 429);

  try {
    if (req.method === "GET") {
      const senha = req.query?.senha || getSenhaFromUrl(req.url);
      if (!checkSenha(senha)) return clientError(res, "Senha incorreta.", 403);

      const supa = getServiceClient();
      const { data, error } = await supa
        .from("copa_chat_contexto")
        .select("conteudo,atualizado_em,atualizado_por")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;

      return sendJson(res, 200, {
        ok: true,
        conteudo: data?.conteudo || "",
        atualizado_em: data?.atualizado_em || null,
        atualizado_por: data?.atualizado_por || "",
      });
    }

    if (req.method !== "POST") return clientError(res, "Método não permitido.", 405);

    const body = await readJsonBody(req, 64 * 1024);
    if (body === "TOO_LARGE") return clientError(res, "Conteúdo muito grande.", 413);
    if (body === null) return clientError(res, "JSON inválido.", 400);
    if (!checkSenha(body.senha)) return clientError(res, "Senha incorreta.", 403);

    const conteudo = String(body.conteudo || "").slice(0, 8000);
    const supa = getServiceClient();
    const { error } = await supa.from("copa_chat_contexto").upsert(
      {
        id: 1,
        conteudo,
        atualizado_em: new Date().toISOString(),
        atualizado_por: "admin",
      },
      { onConflict: "id" },
    );
    if (error) throw error;

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
