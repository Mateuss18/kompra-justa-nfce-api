const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function check(ref) {
  const commands = [];
  let result;
  const mocks = {
    "node:assert/strict": assert,
    "node:fs": {
      writeFileSync: (_, text) => {
        result = JSON.parse(text);
      },
      appendFileSync() {},
    },
    "node:child_process": {
      execFileSync: (_, args) => {
        commands.push(args);
        const operation = args[1];
        const output = {
          "get-function-configuration": {
            Runtime: "nodejs20.x",
            Role: "arn:aws:iam::123456789012:role/test",
            Handler: "dist/handler.handler",
            Timeout: 30,
            MemorySize: 128,
            Architectures: ["x86_64"],
          },
          "get-api": { ProtocolType: "HTTP" },
          "create-function": {
            FunctionArn:
              "arn:aws:lambda:sa-east-1:123456789012:function:nfce-staging-issue100-123456",
          },
          "create-api": {
            ApiId: "staging123",
            ApiEndpoint: "https://staging123.example.com",
          },
          "create-integration": { IntegrationId: "integration1" },
        };
        return JSON.stringify(output[operation] || {});
      },
    },
  };
  await vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../scripts/staging.cjs"), "utf8"),
    {
      require: (name) => mocks[name],
      process: {
        env: {
          GITHUB_REF: ref,
          GITHUB_RUN_ID: "123456",
          GITHUB_SHA: "test-sha",
          GITHUB_STEP_SUMMARY: "summary",
        },
      },
      console: { log() {}, error() {} },
      AbortSignal,
      fetch: async (_, options) => {
        if (options.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "access-control-allow-methods": "POST,OPTIONS",
              "access-control-allow-headers": "content-type",
            },
          });
        }
        const invalid = JSON.parse(options.body).url.includes("example");
        const requestId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        return new Response(
          JSON.stringify({
            requestId,
            code: invalid ? "INVALID_URL" : "UNSUPPORTED_STATE",
          }),
          {
            status: invalid ? 400 : 422,
            headers: {
              "x-request-id": requestId,
              "access-control-allow-origin": "*",
            },
          },
        );
      },
    },
  );
  if (ref === "refs/heads/main") {
    assert.equal(commands.length, 0);
    assert.equal(result.status, "blocked");
  } else {
    assert.equal(result.status, "http-contract-passed", result.error);
    assert.equal(result.checks.length, 4);
    for (const args of commands) {
      if (args[1] === "wait") {
        assert.equal(args[2], "function-active");
      }
      assert.ok(!["create-integration", "create-route", "create-stage"].includes(args[1]));
      if (args[1] === "create-api") {
        assert.ok(args.includes("--target"));
        assert.ok(args.includes("POST /nfce/parse"));
      }
      if (args[0] === "lambda" && args[1] !== "get-function-configuration") {
        assert.ok(!args.includes("nfce-parser"));
      }
      if (args[0] === "apigatewayv2" && args[1] !== "get-api") {
        assert.ok(!args.includes("scb4lft3c8"));
      }
    }
  }
}

async function run() {
  await check("refs/heads/main");
  await check("refs/heads/fix/nfce-import-diagnostics");
  console.log(
    "Staging guards, isolated AWS resource targets and HTTP/CORS assertions passed",
  );
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
