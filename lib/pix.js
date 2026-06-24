// Geração de Pix Copia e Cola (EMV BRCode) conforme Manual de Padrões BACEN.

import crypto from "node:crypto";

export const PIX_KEY = "+5518981300251";
export const PIX_RECIPIENT_NAME = "Allan Cristian Barboza";
export const PIX_CITY = "ARACATUBA";

// Gera TXID único: prefixo RES + 8 chars aleatórios (A-Z, 0-9). Total: 11 chars.
// Exemplo: RESA7X2P8K
export function generateTxid() {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(8);
  let id = "RES";
  for (let i = 0; i < 8; i++) {
    id += CHARS[bytes[i] % CHARS.length];
  }
  return id;
}

function tlv(id, value) {
  return id + String(value.length).padStart(2, "0") + value;
}

function sanitize(str, maxLen) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, maxLen);
}

// CRC16-CCITT (polinômio 0x1021), conforme especificação BRCode do BACEN.
function crc16ccitt(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Constrói o Pix Copia e Cola completo (BRCode EMV) com CRC16 válido.
 *
 * @param {number} amountCents - Valor em centavos (obrigatório)
 * @param {string} txid        - Identificador único da reserva (ex: "RESA7X2P8K")
 */
export function buildPixCopiaCola(amountCents, txid) {
  const safeName = sanitize(PIX_RECIPIENT_NAME, 25) || "RECEBEDOR";
  const safeCity = sanitize(PIX_CITY, 15) || "BRASIL";
  const amount = (Number(amountCents) / 100).toFixed(2);

  const mai = tlv("26", tlv("00", "br.gov.bcb.pix") + tlv("01", PIX_KEY));
  const adf = tlv("62", tlv("05", txid));

  const payload =
    tlv("00", "01") +
    tlv("01", "11") +
    mai +
    tlv("52", "0000") +
    tlv("53", "986") +
    tlv("54", amount) +
    tlv("58", "BR") +
    tlv("59", safeName) +
    tlv("60", safeCity) +
    adf +
    "6304";

  return payload + crc16ccitt(payload);
}
