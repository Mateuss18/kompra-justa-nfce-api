import { APIGatewayProxyHandler } from "aws-lambda";
import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    let url: string = (body.url || "").trim();

    // Normaliza quebras de linha e espaços extras que podem vir do QR code
    url = url.replace(/\s+/g, "");

    // Converte pipe literal para encoded (alguns QR codes de SP usam | no param p)
    url = url.replace(/\|/g, "%7C");

    // Garante https
    if (url.startsWith("http://")) {
      url = url.replace("http://", "https://");
    }

    if (!url || !url.includes("fazenda")) {
      return response(400, { error: "URL inválida" });
    }

    // Valida se a URL é parseável antes de passar pro axios
    try {
      new URL(url);
    } catch {
      return response(400, { error: "URL malformada" });
    }

    console.log("Fetching NFC-e URL:", url);

    let html: string;
    try {
      html = await fetchNfce(url);
    } catch (fetchErr: any) {
      const axiosErr = fetchErr as AxiosError;

      if (axiosErr.code === "ECONNABORTED" || axiosErr.code === "ETIMEDOUT") {
        return response(504, {
          error:
            "A consulta à SEFAZ demorou muito. Tente novamente em instantes.",
        });
      }

      if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
        return response(502, {
          error: "Não foi possível conectar à SEFAZ. Serviço pode estar indisponível.",
        });
      }

      if (axiosErr.response) {
        const status = axiosErr.response.status;
        if (status === 403 || status === 429) {
          return response(503, {
            error:
              "A SEFAZ está bloqueando requisições temporariamente. Tente novamente mais tarde.",
          });
        }
        if (status >= 500) {
          return response(502, {
            error: "A SEFAZ retornou erro interno. Tente novamente mais tarde.",
          });
        }
      }

      return response(502, {
        error: "Falha ao consultar a SEFAZ: " + (axiosErr.message || "Erro desconhecido"),
      });
    }

    // Valida se o HTML parece ser uma página da NFC-e
    if (!html || html.length < 500) {
      return response(502, {
        error: "Resposta inesperada da SEFAZ. Página muito curta ou vazia.",
      });
    }

    let parsed;

    if (url.includes("sp.gov.br")) {
      try {
        parsed = parseSP(html);
      } catch (parseErr: any) {
        console.error("Erro ao fazer parse do HTML:", parseErr.message);
        return response(502, {
          error: "Erro ao interpretar a página da nota. Layout pode ter mudado.",
        });
      }
    } else {
      parsed = parseFallback(html);
    }

    if (isEmptyResult(parsed)) {
      return response(404, {
        error:
          "Nota ainda não disponível para consulta pública. Tente novamente em alguns minutos.",
      });
    }

    return response(200, parsed);
  } catch (err: any) {
    console.error("Erro inesperado no handler:", err);
    return response(500, { error: "Erro interno no servidor. Tente novamente." });
  }
};

function response(status: number, data: any) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
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
// FALLBACK
// ==========================
//

function parseFallback(html: string) {
  const $ = cheerio.load(html);

  return {
    marketName: $("strong").first().text().trim(),
    purchaseDate: "",
    total: 0,
    items: [],
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
