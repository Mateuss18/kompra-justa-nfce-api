import { APIGatewayProxyHandler } from "aws-lambda";
import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import { randomUUID } from "node:crypto";

export const handler: APIGatewayProxyHandler = async (event, context) => {
  const requestId = context?.awsRequestId || randomUUID();
  let stage = "validation";
  let uf = "unknown";
  let host = "unknown";
  let upstreamCode: string | undefined;
  const fail = (
    status: number,
    code: string,
    error: string,
    upstreamStatus?: number,
  ) => {
    const diagnostics = {
      requestId,
      stage,
      uf,
      host,
      code,
      statusCode: status,
      upstreamStatus,
      upstreamCode,
    };
    console.error(
      JSON.stringify({ event: "nfce_parse_failed", ...diagnostics }),
    );
    return response(
      status,
      { error, code, stage, requestId, upstreamStatus, upstreamCode },
      requestId,
    );
  };
  try {
    let body: { url?: string };
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return fail(400, "INVALID_REQUEST", "Corpo da requisição inválido.");
    }
    if (!body || typeof body.url !== "string") {
      return fail(400, "INVALID_URL", "URL inválida");
    }
    let url: string = (body.url || "").trim();

    // Normaliza quebras de linha e espaços extras que podem vir do QR code
    url = url.replace(/\s+/g, "");

    // Converte pipe literal para encoded (alguns QR codes de SP usam | no param p)
    url = url.replace(/\|/g, "%7C");

    // Garante https
    if (url.startsWith("http://")) {
      url = url.replace("http://", "https://");
    }

    if (!url) {
      return fail(400, "INVALID_URL", "URL inválida");
    }

    // Valida se a URL é parseável antes de passar pro axios
    let nfceUrl: URL;
    try {
      nfceUrl = new URL(url);
    } catch {
      return fail(400, "INVALID_URL", "URL malformada");
    }

    const candidateUf = nfceUrl.hostname
      .match(/(?:^|\.)([a-z]{2})\.gov\.br$/)?.[1]
      ?.toUpperCase();
    if (
      candidateUf &&
      /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(
        candidateUf,
      )
    ) {
      uf = candidateUf;
      host = `${uf.toLowerCase()}.gov.br`;
    }
    if (uf === "unknown" || nfceUrl.protocol !== "https:") {
      return fail(400, "INVALID_URL", "URL inválida");
    }
    if (
      nfceUrl.hostname !== "sp.gov.br" &&
      !nfceUrl.hostname.endsWith(".sp.gov.br")
    ) {
      return fail(
        422,
        "UNSUPPORTED_STATE",
        "Ainda não oferecemos suporte para notas fiscais deste estado.",
      );
    }

    stage = "sefaz_fetch";

    let html: string;
    try {
      html = await fetchNfce(url);
    } catch (fetchErr: unknown) {
      const axiosErr = fetchErr as AxiosError;
      if (
        /^(ECONNABORTED|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ERR_NETWORK|ERR_BAD_RESPONSE|ERR_BAD_REQUEST|ERR_FR_TOO_MANY_REDIRECTS|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(
          axiosErr.code || "",
        )
      ) {
        upstreamCode = axiosErr.code;
      }

      if (axiosErr.code === "ECONNABORTED" || axiosErr.code === "ETIMEDOUT") {
        return fail(
          504,
          "SEFAZ_TIMEOUT",
          "A consulta à SEFAZ demorou muito. Tente novamente em instantes.",
        );
      }

      if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
        return fail(
          502,
          "SEFAZ_UNREACHABLE",
          "Não foi possível conectar à SEFAZ. Serviço pode estar indisponível.",
        );
      }

      if (axiosErr.response) {
        const status = axiosErr.response.status;
        if (status === 403 || status === 429) {
          return fail(
            503,
            "SEFAZ_RATE_LIMITED",
            "A SEFAZ está bloqueando requisições temporariamente. Tente novamente mais tarde.",
            status,
          );
        }
        if (status >= 500) {
          return fail(
            502,
            "SEFAZ_SERVER_ERROR",
            "A SEFAZ retornou erro interno. Tente novamente mais tarde.",
            status,
          );
        }
      }

      return fail(
        502,
        "SEFAZ_FETCH_FAILED",
        "Falha ao consultar a SEFAZ. Tente novamente mais tarde.",
        axiosErr.response?.status,
      );
    }

    stage = "parse";
    // Valida se o HTML parece ser uma página da NFC-e
    if (!html || html.length < 500) {
      return fail(
        502,
        "SEFAZ_UNEXPECTED_RESPONSE",
        "Resposta inesperada da SEFAZ. Página muito curta ou vazia.",
      );
    }

    let parsed;
    try {
      parsed = parseSP(html);
    } catch {
      return fail(
        502,
        "PARSE_LAYOUT_CHANGED",
        "Erro ao interpretar a página da nota. Layout pode ter mudado.",
      );
    }

    if (isEmptyResult(parsed)) {
      return fail(
        404,
        "NFCE_NOT_AVAILABLE",
        "Nota ainda não disponível para consulta pública. Tente novamente em alguns minutos.",
      );
    }

    return response(200, parsed, requestId);
  } catch {
    return fail(
      500,
      "UNEXPECTED_ERROR",
      "Erro interno no servidor. Tente novamente.",
    );
  }
};

function response(status: number, data: unknown, requestId: string) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "X-Request-Id",
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(data),
  };
}

async function fetchNfce(url: string): Promise<string> {
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true, // Não throwa em status 4xx/5xx da SEFAZ — tratamos manualmente
  });

  if (res.status >= 400) {
    const err = new Error(`SEFAZ retornou status ${res.status}`) as AxiosError;
    err.response = res;
    throw err;
  }

  return res.data;
}

//
// ==========================
// PARSER SP
// ==========================
//

function parseSP(html: string) {
  const $ = cheerio.load(html);

  const marketName = $(".txtTopo").first().text().trim();

  let purchaseDate = "";
  $("#infos li").each((_, el) => {
    const text = $(el).text();
    const match = text.match(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
    if (match) {
      purchaseDate = normalizeDate(match[0]);
    }
  });

  const totalText = $(".txtMax").first().text();
  const total = parseNumber(totalText);

  const items: any[] = [];

  $("#tabResult tr").each((_, el) => {
    const name = $(el).find(".txtTit").first().text().trim();
    if (!name) return;

    const quantityRaw = $(el).find(".Rqtd").text();
    const unitRaw = $(el).find(".RUN").text();
    const unitPriceRaw = $(el).find(".RvlUnit").text();
    const totalItemText = $(el).find(".valor").text();

    const quantityMatch = quantityRaw.match(/Qtde\.:([\d,]+)/);
    const quantity = quantityMatch
      ? parseFloat(quantityMatch[1].replace(",", "."))
      : 0;

    const unitMatch = unitRaw.match(/UN:\s*([A-Z]+)/);
    const unit = unitMatch ? unitMatch[1] : "";

    const unitPriceMatch = unitPriceRaw.match(/([\d,]+)/);
    const unitPrice = unitPriceMatch
      ? parseFloat(unitPriceMatch[1].replace(",", "."))
      : 0;

    items.push({
      name,
      quantity,
      unit,
      unitPrice,
      totalPrice: parseNumber(totalItemText),
    });
  });

  return {
    marketName,
    purchaseDate,
    total,
    items,
  };
}

//
// ==========================
// HELPERS
// ==========================
//

function parseNumber(text: string): number {
  if (!text) return 0;

  const match = text.match(/[\d,.]+/);
  if (!match) return 0;

  return parseFloat(match[0].replace(",", "."));
}

function normalizeDate(text: string): string {
  const [date, time] = text.split(" ");
  const [d, m, y] = date.split("/");

  return `${y}-${m}-${d}T${time}`;
}

function isEmptyResult(parsed: any): boolean {
  return (
    !parsed.marketName &&
    (!parsed.items || parsed.items.length === 0) &&
    parsed.total === 0
  );
}
