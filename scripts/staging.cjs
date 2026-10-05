const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const region = "sa-east-1";
const productionApiId = "scb4lft3c8";
const productionFunction = "nfce-parser";
const result = {
  region,
  commit: process.env.GITHUB_SHA,
  resources: {},
  checks: [],
};

function save() {
  fs.writeFileSync("staging-result.json", JSON.stringify(result, null, 2));
}

function aws(...args) {
  try {
    const output = execFileSync(
      "aws",
      [...args, "--region", region, "--output", "json", "--no-cli-pager"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AWS_PAGER: "" },
      },
    );
    return output.trim() ? JSON.parse(output) : {};
  } catch (error) {
    throw new Error(
      `${args[0]} ${args[1]}: ${String(error.stderr || "AWS command failed").trim()}`,
    );
  }
}

async function run() {
  assert.equal(
    process.env.GITHUB_REF,
    "refs/heads/fix/nfce-import-diagnostics",
  );
  assert.match(process.env.GITHUB_RUN_ID || "", /^\d+$/);
  const name = `nfce-staging-issue100-${process.env.GITHUB_RUN_ID}`;
  assert.notEqual(name, productionFunction);
  const config = aws(
    "lambda",
    "get-function-configuration",
    "--function-name",
    productionFunction,
    "--query",
    "{Runtime:Runtime,Role:Role,Handler:Handler,Timeout:Timeout,MemorySize:MemorySize,Architectures:Architectures,VpcConfig:VpcConfig}",
  );
  const productionApi = aws(
    "apigatewayv2",
    "get-api",
    "--api-id",
    productionApiId,
  );
  assert.equal(
    productionApi.ProtocolType,
    "HTTP",
    "Production API must be inspected before creating staging",
  );
  const tags = {
    purpose: "nfce-issue100-staging",
    githubRun: process.env.GITHUB_RUN_ID,
  };
  const create = {
    FunctionName: name,
    Runtime: config.Runtime,
    Role: config.Role,
    Handler: config.Handler,
    Timeout: config.Timeout,
    MemorySize: config.MemorySize,
    Architectures: config.Architectures,
    Tags: tags,
  };
  if (config.VpcConfig?.SubnetIds?.length) {
    create.VpcConfig = {
      SubnetIds: config.VpcConfig.SubnetIds,
      SecurityGroupIds: config.VpcConfig.SecurityGroupIds,
    };
  }
  const lambda = aws(
    "lambda",
    "create-function",
    "--cli-input-json",
    JSON.stringify(create),
    "--zip-file",
    "fileb://lambda.zip",
  );
  result.resources.functionName = name;
  result.resources.functionArn = lambda.FunctionArn;
  save();
  aws("lambda", "wait", "function-active-v2", "--function-name", name);
  const cors = productionApi.CorsConfiguration || {
    AllowOrigins: ["*"],
    AllowMethods: ["POST", "OPTIONS"],
    AllowHeaders: ["content-type"],
  };
  cors.ExposeHeaders = [
    ...new Set([...(cors.ExposeHeaders || []), "X-Request-Id"]),
  ];
  const api = aws(
    "apigatewayv2",
    "create-api",
    "--name",
    name,
    "--protocol-type",
    "HTTP",
    "--cors-configuration",
    JSON.stringify(cors),
    "--tags",
    JSON.stringify(tags),
  );
  assert.notEqual(api.ApiId, productionApiId);
  result.resources.apiId = api.ApiId;
  result.resources.endpoint = api.ApiEndpoint;
  save();
  const integration = aws(
    "apigatewayv2",
    "create-integration",
    "--api-id",
    api.ApiId,
    "--integration-type",
    "AWS_PROXY",
    "--integration-method",
    "POST",
    "--integration-uri",
    lambda.FunctionArn,
    "--payload-format-version",
    "1.0",
  );
  aws(
    "apigatewayv2",
    "create-route",
    "--api-id",
    api.ApiId,
    "--route-key",
    "POST /nfce/parse",
    "--target",
    `integrations/${integration.IntegrationId}`,
  );
  const account = lambda.FunctionArn.split(":")[4];
  aws(
    "lambda",
    "add-permission",
    "--function-name",
    name,
    "--statement-id",
    "staging-http-api",
    "--action",
    "lambda:InvokeFunction",
    "--principal",
    "apigateway.amazonaws.com",
    "--source-arn",
    `arn:aws:execute-api:${region}:${account}:${api.ApiId}/*/POST/nfce/parse`,
  );
  aws(
    "apigatewayv2",
    "create-stage",
    "--api-id",
    api.ApiId,
    "--stage-name",
    "$default",
    "--auto-deploy",
  );
  console.log(`Staging endpoint: ${api.ApiEndpoint}`);
  const endpoint = `${api.ApiEndpoint}/nfce/parse`;
  assert.ok(!endpoint.includes(productionApiId));
  for (const [label, url, status, code] of [
    ["MG", "https://nfce.fazenda.mg.gov.br/nota", 422, "UNSUPPORTED_STATE"],
    ["RS", "https://www.sefaz.rs.gov.br/nfce", 422, "UNSUPPORTED_STATE"],
    ["invalid URL", "https://example.com/nota", 400, "INVALID_URL"],
  ]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://localhost",
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(25000),
    });
    const body = await response.json();
    assert.equal(response.status, status, `${label} HTTP status`);
    assert.equal(body.code, code, `${label} API error code`);
    assert.equal(response.headers.get("x-request-id"), body.requestId);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    assert.ok(
      allowedOrigin === "*" || allowedOrigin === "https://localhost",
      "Origin must be allowed",
    );
    result.checks.push({ label, status, code, requestId: body.requestId });
    save();
    console.log(
      `PASS: ${label}, HTTP ${status}, code ${code}, correlation header`,
    );
  }
  const preflight = await fetch(endpoint, {
    method: "OPTIONS",
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(25000),
  });
  assert.ok(preflight.ok, "Preflight must succeed");
  assert.match(
    preflight.headers.get("access-control-allow-methods") || "",
    /POST/i,
  );
  assert.match(
    preflight.headers.get("access-control-allow-headers") || "",
    /content-type|\*/i,
  );
  result.checks.push({ label: "CORS preflight", status: preflight.status });
  result.status = "http-contract-passed";
  save();
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## NFC-e staging\n\nEndpoint: ${api.ApiEndpoint}\n\nCandidate: ${process.env.GITHUB_SHA}\n\nLambda/API Gateway contract and CORS preflight passed. Real SP receipt and Android device remain to be tested.\n`,
  );
}

run().catch((error) => {
  result.status = "blocked";
  result.error = error.message;
  save();
  console.error(error.message);
  process.exitCode = 1;
});
