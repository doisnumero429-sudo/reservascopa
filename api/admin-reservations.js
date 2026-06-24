// GET  /api/admin-reservations?senha=xxx
//   → { ok, reservations:[...], tableStatus:{mesa:status} }
// POST /api/admin-reservations { senha, action, protocolo, observacao? }
//   actions: "confirm" | "cancel"

import {
  sendJson,
  applyCommonHeaders,
  handlePreflight,
  readJsonBody,
  rateLimit,
  clientError,
  serverError,
} from "../lib/http.js";
import { getServiceClient, EVENTO_ID } from "../lib/supabase.js";

function checkSenha(senha) {
  const expected = process.env.ADMIN_SENHA;
  if (!expected) return false;
  return String(senha || "") === expected;
}

function getSenhaFromUrl(url) {
  try { return new URL("http://x" + url).searchParams.get("senha") || ""; }
  catch { return ""; }
}

const STATUS_ORDER = {
  comprovante_enviado: 0,
  aguardando_pagamento: 1,
  confirmada: 2,
  cancelada: 3,
  expirada: 4,
};

export default async function handler(req, res) {
  applyCommonHeaders(req, res);
  if (handlePreflight(req, res)) return;

  if (!process.env.ADMIN_SENHA)
    return sendJson(res, 503, { ok: false, error: "ADMIN_SENHA não configurada." });

  if (!rateLimit(req, { max: 30, windowMs: 60000 }))
    return clientError(res, "Muitas tentativas.", 429);

  try {
    // ── GET: listar reservas + status das mesas ──────────────────────────────
    if (req.method === "GET") {
      const senha = req.query?.senha || getSenhaFromUrl(req.url);
      if (!checkSenha(senha)) return clientError(res, "Senha incorreta.", 403);

      const supa = getServiceClient();
      const { data, error } = await supa
        .from("copa_reservas_admin")
        .select(
          "protocolo,nome,whatsapp,pagantes,criancas,total_pessoas,valor_centavos," +
          "status,expira_em,comprovante_enviado_em,confirmado_em,cancelado_em," +
          "criado_em,observacao,observacao_interna,mesas",
        )
        .eq("evento", EVENTO_ID)
        .order("criado_em", { ascending: false });

      if (error) throw error;

      // Monta mapa mesa → status (mais grave vence em caso de sobreposição)
      const tableStatus = {};
      for (const r of data || []) {
        if (!["aguardando_pagamento","comprovante_enviado","confirmada"].includes(r.status)) continue;
        for (const mesa of r.mesas || []) {
          const prev = tableStatus[mesa];
          if (!prev || (STATUS_ORDER[r.status] ?? 99) < (STATUS_ORDER[prev] ?? 99)) {
            tableStatus[mesa] = r.status;
          }
        }
      }

      return sendJson(res, 200, { ok: true, reservations: data || [], tableStatus });
    }

    // ── POST: ações admin ────────────────────────────────────────────────────
    if (req.method !== "POST") return clientError(res, "Método não permitido.", 405);

    const body = await readJsonBody(req, 16 * 1024);
    if (body === "TOO_LARGE") return clientError(res, "Requisição muito grande.", 413);
    if (body === null) return clientError(res, "JSON inválido.", 400);
    if (!checkSenha(body.senha)) return clientError(res, "Senha incorreta.", 403);

    const protocolo = String(body.protocolo || "").toUpperCase().trim();
    const observacao = String(body.observacao || "").slice(0, 500);
    if (!protocolo) return clientError(res, "Protocolo obrigatório.", 400);

    const supa = getServiceClient();

    if (body.action === "confirm") {
      const { data, error } = await supa.rpc("confirmar_reserva_copa_admin", {
        p_protocolo: protocolo,
        p_observacao: observacao || null,
        p_evento: EVENTO_ID,
      });
      if (error) throw error;
      if (!data?.ok) return clientError(res, data?.erro || "Não foi possível confirmar.", 400);
      return sendJson(res, 200, { ok: true });
    }

    if (body.action === "cancel") {
      const { data, error } = await supa.rpc("cancelar_reserva_copa_admin", {
        p_protocolo: protocolo,
        p_observacao: observacao || null,
        p_evento: EVENTO_ID,
      });
      if (error) throw error;
      if (!data?.ok) return clientError(res, data?.erro || "Não foi possível cancelar.", 400);
      return sendJson(res, 200, { ok: true });
    }

    return clientError(res, "Ação inválida.", 400);
  } catch (err) {
    return serverError(res, err);
  }
}
