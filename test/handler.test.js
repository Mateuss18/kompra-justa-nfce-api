const assert = require("node:assert/strict");
const axios = require("axios");
const { handler } = require("../dist/handler");

const requestId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const privateUrl =
  "https://www.fazenda.sp.gov.br/nfce?p=35260912345678901234550010000000011000000010";
const logs = [];

async function invoke(url, body = JSON.stringify({ url })) {
  const result = await handler({ body }, { awsRequestId: requestId });
  assert.equal(result.headers["X-Request-Id"], requestId);
  assert.equal(result.headers["Access-Control-Expose-Headers"], "X-Request-Id");
  assert.equal(result.headers["Access-Control-Allow-Origin"], "*");
  return { status: result.statusCode, body: JSON.parse(result.body) };
}

async function run() {
  const originalGet = axios.get;
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => logs.push(args.join(" "));
  console.log = (...args) => logs.push(args.join(" "));
  try {
    axios.get = async () => {
      throw new Error("Unexpected network request");
    };
    const unsupported = await invoke(
      "https://nfce.fazenda.mg.gov.br/nota?p=private",
    );
    assert.equal(unsupported.status, 422);
    assert.deepEqual(unsupported.body, {
      code: "UNSUPPORTED_STATE",
      error: "Ainda não oferecemos suporte para notas fiscais deste estado.",
      stage: "validation",
      requestId,
    });
    assert.deepEqual(JSON.parse(logs[0]), {
      event: "nfce_parse_failed",
      requestId,
      stage: "validation",
      uf: "MG",
      host: "mg.gov.br",
      code: "UNSUPPORTED_STATE",
      statusCode: 422,
    });
    assert.equal((await invoke("", "{broken")).body.code, "INVALID_REQUEST");
    const rs = await invoke("https://www.sefaz.rs.gov.br/nfce?p=private");
    assert.equal(rs.status, 422);
    assert.equal(rs.body.code, "UNSUPPORTED_STATE");
    assert.equal(JSON.parse(logs[logs.length - 1]).uf, "RS");
    const invalid = await invoke("https://fazenda.sp.gov.br.evil.example/nota");
    assert.equal(invalid.body.code, "INVALID_URL");
    assert.equal(JSON.parse(logs[logs.length - 1]).host, "unknown");
    assert.equal(
      (await invoke("", JSON.stringify({ url: 123 }))).body.code,
      "INVALID_URL",
    );
    const withoutContext = await handler({ body: "{broken" });
    assert.match(withoutContext.headers["X-Request-Id"], /^[0-9a-f-]{36}$/);
    assert.equal(
      JSON.parse(withoutContext.body).requestId,
      withoutContext.headers["X-Request-Id"],
    );
    for (const [providerCode, apiStatus, apiCode] of [
      ["ECONNABORTED", 504, "SEFAZ_TIMEOUT"],
      ["ENOTFOUND", 502, "SEFAZ_UNREACHABLE"],
      ["ECONNRESET", 502, "SEFAZ_FETCH_FAILED"],
      [undefined, 502, "SEFAZ_FETCH_FAILED"],
    ]) {
      axios.get = async () => {
        throw Object.assign(new Error(privateUrl), { code: providerCode });
      };
      const result = await invoke(privateUrl);
      assert.equal(result.status, apiStatus);
      assert.equal(result.body.code, apiCode);
      assert.equal(result.body.stage, "sefaz_fetch");
      assert.equal(result.body.upstreamCode, providerCode);
    }
    axios.get = async () => {
      throw Object.assign(new Error(privateUrl), { code: "token=private" });
    };
    assert.equal((await invoke(privateUrl)).body.upstreamCode, undefined);
    for (const [upstreamStatus, apiStatus, apiCode] of [
      [429, 503, "SEFAZ_RATE_LIMITED"],
      [500, 502, "SEFAZ_SERVER_ERROR"],
      [404, 502, "SEFAZ_FETCH_FAILED"],
    ]) {
      axios.get = async () => ({
        status: upstreamStatus,
        data: "private HTML",
      });
      const result = await invoke(privateUrl);
      assert.equal(result.status, apiStatus);
      assert.equal(result.body.code, apiCode);
      assert.equal(result.body.upstreamStatus, upstreamStatus);
    }
    axios.get = async () => ({ status: 200, data: "" });
    assert.equal(
      (await invoke(privateUrl)).body.code,
      "SEFAZ_UNEXPECTED_RESPONSE",
    );
    axios.get = async () => ({
      status: 200,
      data: "<html>" + " ".repeat(500) + "</html>",
    });
    assert.equal((await invoke(privateUrl)).body.code, "NFCE_NOT_AVAILABLE");
    axios.get = async () => ({
      status: 200,
      data:
        '<html><div class="txtTopo">Mercado privado</div>' +
        " ".repeat(500) +
        "</html>",
    });
    const success = await invoke(privateUrl);
    assert.equal(success.status, 200);
    assert.deepEqual(Object.keys(success.body).sort(), [
      "items",
      "marketName",
      "purchaseDate",
      "total",
    ]);
    const serialized = logs.join("\n");
    assert.ok(
      !serialized.includes("35260912345678901234550010000000011000000010"),
    );
    assert.ok(!serialized.includes("https://"));
    assert.ok(!serialized.includes("private"));
    assert.ok(!serialized.includes("Mercado privado"));
  } finally {
    axios.get = originalGet;
    console.error = originalError;
    console.log = originalLog;
  }
  console.log(
    "NFC-e API diagnostics, correlation, success contract and privacy checks passed",
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
