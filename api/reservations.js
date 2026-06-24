// /api/reservations
//  GET  ?action=occupied            -> { ok, occupied:[numeros] }
//  POST { action:"create", ... }    -> { ok, reservation }
//  POST { action:"cancel", ... }    -> { ok }
//  POST { action:"resume", ... }    -> { ok, reservation }

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
import {
  getServiceClient,
  EVENTO_ID,
  VALOR_POR_PAGANTE_CENTAVOS,
  newAccessToken,
  hashAccessToken,
  isValidAccessToken,
  toReservationDTO,
  erroPt,
} from "../lib/supabase.js";
import {
  generateTxid,
  buildPixCopiaCola,
  getPixKey,
  PIX_RECIPIENT_NAME,
  PIX_CITY,
} from "../lib/pix.js";

export default async function handler(req, res) {
  applyCommonHeaders(req, res);
  if (handlePreflight(req, res)) return;

  try {
    if (req.method === "GET") return await handleOccupied(req, res);
    if (req.method !== "POST")
      return clientError(res, "Método não permitido.", 405);

    if (!isAllowedOrigin(req))
      return clientError(res, "Origem não autorizada.", 403);
    if (!rateLimit(req, { max: 40, windowMs: 60000 }))
      return clientError(res, "Muitas tentativas. Aguarde um momento.", 429);

    const body = await readJsonBody(req);
    if (body === "TOO_LARGE")
      return clientError(res, "Requisição muito grande.", 413);
    if (body === null) return clientError(res, "JSON inválido.", 400);

    switch (body.action) {
      case "create":
        return await handleCreate(req, res, body);
      case "cancel":
        return await handleCancel(req, res, body);
      case "resume":
        return await handleResume(req, res, body);
      default:
        return clientError(res, "Ação inválida.", 400);
    }
  } catch (err) {
    if (err.public) return sendJson(res, 503, { ok: false, error: err.public });
    return serverError(res, err);
  }
}

async function handleOccupied(req, res) {
  const supa = getServiceClient();
  const { data, error } = await supa.rpc("listar_mesas_ocupadas_copa_v2", {
    p_evento: EVENTO_ID,
  });
  if (error) throw error;
  const occupied = (data || []).map((r) => Number(r.mesa ?? r));
  return sendJson(res, 200, { ok: true, occupied });
}

async function handleCreate(req, res, body) {
  const supa = getServiceClient();
  const pagantes = Number(body.pagantes);
  const criancas = Number(body.criancas || 0);
  const mesas = Array.isArray(body.mesas) ? body.mesas.map(Number) : [];

  if (!body.nome || !String(body.nome).trim())
    return clientError(res, erroPt("NOME_INVALIDO"), 400);
  if (!Number.isInteger(pagantes) || pagantes < 2)
    return clientError(res, erroPt("PAGANTES_INVALIDO"), 400);
  if (!mesas.length || mesas.some((m) => !Number.isInteger(m)))
    return clientError(res, erroPt("QUANTIDADE_MESAS_INVALIDA"), 400);

  const accessToken = newAccessToken();
  const acessoHash = hashAccessToken(accessToken);

  const { data, error } = await supa.rpc("criar_reserva_copa_v2", {
    p_nome: String(body.nome).trim(),
    p_whatsapp: String(body.whatsapp || ""),
    p_pagantes: pagantes,
    p_criancas: criancas,
    p_observacao: body.observacao ? String(body.observacao) : "",
    p_mesas: mesas,
    p_acesso_hash: acessoHash,
    p_evento: EVENTO_ID,
  });
  if (error) throw error;

  if (!data || data.ok !== true) {
    const code = data?.erro || "DESCONHECIDO";
    const status = code === "MESA_INDISPONIVEL" ? 409 : 400;
    return sendJson(res, status, {
      ok: false,
      error: erroPt(code),
      code,
    });
  }

  // Gera TXID único e Pix Copia e Cola no backend — a chave Pix nunca vai ao navegador.
  const txid = generateTxid();
  const amountCents = pagantes * VALOR_POR_PAGANTE_CENTAVOS;
  let pixCopiaCola = null;
  try {
    pixCopiaCola = buildPixCopiaCola(
      getPixKey(),
      PIX_RECIPIENT_NAME,
      PIX_CITY,
      amountCents,
      txid,
    );
    await supa
      .from("copa_reservas")
      .update({
        txid,
        pix_copia_e_cola: pixCopiaCola,
        pix_gerado_em: new Date().toISOString(),
      })
      .eq("protocolo", data.protocolo)
      .eq("evento", EVENTO_ID);
  } catch (pixErr) {
    // Falha no Pix não cancela a reserva; administrador pode regenerar manualmente.
    console.error("PIX generation error:", pixErr.message);
  }

  const reservation = {
    protocol: data.protocolo,
    accessToken,
    name: String(body.nome).trim(),
    whatsapp: String(body.whatsapp || ""),
    payers: pagantes,
    children: criancas,
    totalPeople: pagantes + criancas,
    observation: body.observacao ? String(body.observacao).trim() : "",
    tables: (data.mesas || mesas).map(Number).sort((a, b) => a - b),
    status: "aguardando_pagamento",
    amountCents,
    expiresAt: data.expira_em,
    proofSubmittedAt: null,
    txid,
    pixCopiaCola,
  };
  return sendJson(res, 201, { ok: true, reservation });
}

async function handleCancel(req, res, body) {
  const supa = getServiceClient();
  if (!body.protocol || !isValidAccessToken(body.accessToken))
    return clientError(res, erroPt("ACESSO_INVALIDO"), 400);

  const { data, error } = await supa.rpc("cancelar_reserva_copa_cliente_v2", {
    p_protocolo: String(body.protocol),
    p_acesso_hash: hashAccessToken(body.accessToken),
    p_evento: EVENTO_ID,
  });
  if (error) throw error;
  if (!data || data.ok !== true) {
    const code = data?.erro || "DESCONHECIDO";
    return clientError(res, erroPt(code, "Não foi possível cancelar."), 400);
  }
  return sendJson(res, 200, { ok: true });
}

async function handleResume(req, res, body) {
  const supa = getServiceClient();
  if (!body.protocol || !isValidAccessToken(body.accessToken))
    return clientError(res, erroPt("ACESSO_INVALIDO"), 400);

  // Garante que bloqueios vencidos sejam marcados antes de devolver o status.
  await supa.rpc("copa_limpar_bloqueios_expirados_v2");

  const { data, error } = await supa
    .from("copa_reservas")
    .select(
      "protocolo,status,nome,whatsapp,pagantes,criancas,total_pessoas,valor_centavos,observacao,expira_em,comprovante_enviado_em,txid,pix_copia_e_cola,copa_reserva_mesas(mesa)",
    )
    .eq("evento", EVENTO_ID)
    .eq("protocolo", String(body.protocol).toUpperCase().trim())
    .eq("acesso_hash", hashAccessToken(body.accessToken))
    .maybeSingle();

  if (error) throw error;
  if (!data) return clientError(res, erroPt("RESERVA_NAO_ENCONTRADA"), 404);

  // Retro-preenche Pix para reservas criadas antes desta funcionalidade.
  if (
    (!data.txid || !data.pix_copia_e_cola) &&
    data.status === "aguardando_pagamento"
  ) {
    const txid = generateTxid();
    try {
      const pixCopiaCola = buildPixCopiaCola(
        getPixKey(),
        PIX_RECIPIENT_NAME,
        PIX_CITY,
        Number(data.valor_centavos),
        txid,
      );
      await supa
        .from("copa_reservas")
        .update({
          txid,
          pix_copia_e_cola: pixCopiaCola,
          pix_gerado_em: new Date().toISOString(),
        })
        .eq("protocolo", data.protocolo)
        .eq("evento", EVENTO_ID);
      data.txid = txid;
      data.pix_copia_e_cola = pixCopiaCola;
    } catch (pixErr) {
      console.error("PIX backfill error:", pixErr.message);
    }
  }

  return sendJson(res, 200, {
    ok: true,
    reservation: toReservationDTO(data, body.accessToken),
  });
}
