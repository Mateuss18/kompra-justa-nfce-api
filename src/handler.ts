import { APIGatewayProxyHandler } from "aws-lambda";
import axios from "axios";
import * as cheerio from "cheerio";

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const url = body.url;

    if (!url || !url.includes("fazenda")) {
      return response(400, { error: "URL inválida" });
    }

    const html = await fetchNfce(url);

    let parsed;

    if (url.includes("sp.gov.br")) {
      parsed = parseSP(html);
    } else {
      parsed = parseFallback(html);
    }

    return response(200, parsed);
  } catch (err: any) {
    return response(500, { error: err.message });
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
      "User-Agent": "Mozilla/5.0",
    },
    timeout: 10000,
  });

  return res.data;
}

//
// ==========================
// PARSER SP (CORRIGIDO)
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