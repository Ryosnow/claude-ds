import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL,
  MODEL,
  extractModelSelection,
  fetchBalance,
  fromOpenAIResponse,
  loadConfig,
  normalizeChatCompletionsUrl,
  resolveDeepSeekKey,
  resolveModelProfile,
  startProxy,
  toOpenAIRequest,
} from "../claude-go.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("converts Anthropic messages and tools to OpenAI format", () => {
  const result = toOpenAIRequest({
    model: "claude-sonnet-4-5",
    system: [{ type: "text", text: "Be concise", cache_control: { type: "ephemeral" } }],
    max_tokens: 2048,
    stream: true,
    tools: [{
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
    tool_choice: { type: "auto" },
    messages: [
      { role: "user", content: "Read a.txt" },
      { role: "assistant", content: [
        { type: "text", text: "I'll read it." },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "hello" },
      ] },
    ],
  });

  assert.equal(result.model, MODEL);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[2].tool_calls[0].function.name, "read_file");
  assert.equal(result.messages[3].role, "tool");
  assert.equal(result.messages[3].tool_call_id, "toolu_1");
  assert.equal(result.tools[0].function.parameters.required[0], "path");
  assert.equal(result.tool_choice, "auto");
});

test("converts non-streaming OpenAI tool response", () => {
  const result = fromOpenAIResponse({
    id: "chatcmpl_1",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "Checking.",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "run", arguments: "{\"command\":\"pwd\"}" },
        }],
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  });

  assert.equal(result.model, MODEL);
  assert.equal(result.content[0].text, "Checking.");
  assert.deepEqual(result.content[1].input, { command: "pwd" });
  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 8 });
});

test("streams text and tool calls through the proxy", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl_test",
      choices: [{ index: 0, delta: { role: "assistant", content: "Let me " }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "check." }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "{\"command\":" } }] }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"pwd\"}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));

  const proxy = await startProxy({
    apiKey: "test-opencode-key",
    localToken: "test-local-token",
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/chat/completions`,
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-local-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "check" }],
      tools: [{ name: "run", description: "Run", input_schema: { type: "object" } }],
    }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(received.authorization, "Bearer test-opencode-key");
  assert.equal(received.body.model, MODEL);
  assert.match(body, /event: message_start/);
  assert.match(body, /"text":"Let me "/);
  assert.match(body, /"name":"run"/);
  assert.match(body, /"partial_json":"\{\\"command\\":\\"pwd\\"\}"/);
  assert.match(body, /"stop_reason":"tool_use"/);
  assert.match(body, /event: message_stop/);
});

test("rejects requests without the per-run local token", async (t) => {
  const proxy = await startProxy({ apiKey: "test-key", localToken: "secret" });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.type, "authentication_error");
});

test("provides a local token estimate without contacting upstream", async (t) => {
  const proxy = await startProxy({ apiKey: "test-key", localToken: "secret" });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).input_tokens > 0);
});

test("config: missing file yields an empty config, invalid JSON throws", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-go-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.deepEqual(loadConfig(join(directory, "absent.json")), {});

  const bad = join(directory, "bad.json");
  await writeFile(bad, "{ not json");
  assert.throws(() => loadConfig(bad), /不是合法 JSON/);

  const good = join(directory, "good.json");
  await writeFile(good, JSON.stringify({
    default: "flash",
    models: { flash: { model: "deepseek-v4-flash" }, pro: { model: "deepseek-v4-pro" } },
  }));
  assert.deepEqual(Object.keys(loadConfig(good).models), ["flash", "pro"]);
});

test("resolveModelProfile picks requested, env, default, or built-in profile", () => {
  const config = {
    default: "flash",
    models: {
      flash: { model: "deepseek-v4-flash" },
      pro: { model: "deepseek-v4-pro", api_key: "sk-profile-key", base_url: "https://example.test/v1/chat/completions" },
    },
  };

  const fallback = resolveModelProfile({}, null);
  assert.equal(fallback.model, DEFAULT_MODEL);
  assert.equal(fallback.apiKey, null);

  delete process.env.CLAUDE_GO_MODEL;
  assert.equal(resolveModelProfile(config, null).model, "deepseek-v4-flash");
  assert.equal(resolveModelProfile(config, "pro").model, "deepseek-v4-pro");

  process.env.CLAUDE_GO_MODEL = "pro";
  try {
    assert.equal(resolveModelProfile(config, null).name, "pro");
  } finally {
    delete process.env.CLAUDE_GO_MODEL;
  }

  const pro = resolveModelProfile(config, "pro");
  assert.equal(pro.apiKey, "sk-profile-key");
  assert.equal(pro.upstreamUrl, "https://example.test/v1/chat/completions");

  assert.throws(() => resolveModelProfile(config, "nope"), /未知模型档案/);
});

test("extractModelSelection intercepts only known profile names", () => {
  const config = { models: { pro: { model: "deepseek-v4-pro" } } };

  const picked = extractModelSelection(["--model", "pro", "-p", "hi"], config);
  assert.deepEqual(picked.args, ["-p", "hi"]);
  assert.equal(picked.selected, "pro");

  const inline = extractModelSelection(["--model=pro"], config);
  assert.deepEqual(inline.args, []);
  assert.equal(inline.selected, "pro");

  const short = extractModelSelection(["-m", "pro"], config);
  assert.equal(short.selected, "pro");

  // Unknown model values must pass through to Claude Code untouched.
  const passthrough = extractModelSelection(["--model", "sonnet"], config);
  assert.deepEqual(passthrough.args, ["--model", "sonnet"]);
  assert.equal(passthrough.selected, null);
});

test("proxy uses the selected profile's model end to end", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_pro",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));

  const proxy = await startProxy({
    apiKey: "k",
    model: "deepseek-v4-pro",
    localToken: "profile-token",
    upstreamUrl: `http://127.0.0.1:${upstreamAddress.port}/v1/chat/completions`,
  });
  t.after(() => proxy.close());

  assert.match((await (await fetch(proxy.baseUrl)).json()).model, /pro$/);

  const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer profile-token", "content-type": "application/json" },
    body: JSON.stringify({ max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(received.model, "deepseek-v4-pro");
  assert.equal((await response.json()).model, "deepseek-v4-pro");
});

test("launcher hides the real key and injects the temporary gateway", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-go-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeClaude = join(directory, "claude");
  await writeFile(fakeClaude, `#!/bin/sh
exec node -e 'fetch(process.env.ANTHROPIC_BASE_URL + "/health").then(r => r.json()).then(health => console.log(JSON.stringify({ health, keyVisible: Boolean(process.env.OPENCODE_API_KEY), model: process.env.ANTHROPIC_MODEL, tokenSet: Boolean(process.env.ANTHROPIC_AUTH_TOKEN) })))'
`);
  await chmod(fakeClaude, 0o755);

  const entrypoint = fileURLToPath(new URL("../claude-go.mjs", import.meta.url));
  const result = await run(process.execPath, [entrypoint, "-p", "test"], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      OPENCODE_API_KEY: "real-key-must-not-reach-child",
      CLAUDE_GO_CONFIG: join(directory, "no-config.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.code, 0, result.stderr);
  const childState = JSON.parse(result.stdout.trim());
  assert.equal(childState.health.ok, true);
  assert.equal(childState.health.model, MODEL);
  assert.equal(childState.keyVisible, false);
  assert.equal(childState.model, MODEL);
  assert.equal(childState.tokenSet, true);
});

test("normalizeChatCompletionsUrl appends the chat path exactly once", () => {
  assert.equal(
    normalizeChatCompletionsUrl("https://api.deepseek.com"),
    "https://api.deepseek.com/chat/completions",
  );
  assert.equal(
    normalizeChatCompletionsUrl("https://api.deepseek.com/"),
    "https://api.deepseek.com/chat/completions",
  );
  assert.equal(
    normalizeChatCompletionsUrl("https://opencode.ai/zen/go/v1/chat/completions"),
    "https://opencode.ai/zen/go/v1/chat/completions",
  );
  assert.equal(
    normalizeChatCompletionsUrl("https://x.test/v1/chat/completions/"),
    "https://x.test/v1/chat/completions",
  );
});

test("profile api_key_file loads keys from disk and fails loudly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-go-keyfile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "api_key");
  await writeFile(keyFile, "sk-from-file\n");

  const config = {
    models: {
      byFile: { model: "deepseek-chat", api_key_file: keyFile },
      missing: { api_key_file: join(directory, "absent") },
      emptyFile: { api_key_file: join(directory, "empty") },
    },
  };
  await writeFile(join(directory, "empty"), "   \n");

  const profile = resolveModelProfile(config, "byFile");
  assert.equal(profile.apiKey, "sk-from-file");
  // base_url normalization flows through resolveModelProfile
  assert.equal(profile.upstreamUrl, null);

  assert.throws(() => resolveModelProfile(config, "missing"), /无法读取 api_key_file/);
  assert.throws(() => resolveModelProfile(config, "emptyFile"), /内容为空/);

  const withBase = resolveModelProfile({
    models: { ds: { base_url: "https://api.deepseek.com", api_key: "inline-wins" } },
  }, "ds");
  assert.equal(withBase.upstreamUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(withBase.apiKey, "inline-wins");
});

test("resolveDeepSeekKey prefers env, then files, and skips legacy non-sk tokens", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-go-dskey-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeHome = join(directory, "home");
  await mkdir(join(fakeHome, ".config/deepseek"), { recursive: true });

  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;

  const readWithHome = () =>
    resolveDeepSeekKey({ env: { ...env, HOME: fakeHome } });

  assert.equal(readWithHome(), null);

  await writeFile(join(fakeHome, ".config/deepseek/token"), "browser-token-not-a-key");
  assert.equal(readWithHome(), null, "legacy token file without sk- prefix must be ignored");

  await writeFile(join(fakeHome, ".config/deepseek/token"), "sk-legacy");
  assert.deepEqual(readWithHome(), {
    source: join(fakeHome, ".config/deepseek/token"),
    apiKey: "sk-legacy",
  });

  await writeFile(join(fakeHome, ".config/deepseek/api_key"), "sk-primary\n");
  assert.equal(readWithHome().apiKey, "sk-primary");

  const withEnv = resolveDeepSeekKey({ env: { ...env, DEEPSEEK_API_KEY: "sk-env" } });
  assert.deepEqual(withEnv, { source: "$DEEPSEEK_API_KEY", apiKey: "sk-env" });
});

test("fetchBalance parses a mocked /user/balance response", async (t) => {
  let auth;
  const server = createServer((req, res) => {
    if (req.url === "/user/balance") {
      auth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: "CNY",
          total_balance: "8.52",
          granted_balance: "0.00",
          topped_up_balance: "8.52",
        }],
      }));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  const address = await listen(server);
  t.after(() => close(server));

  const data = await fetchBalance({
    apiKey: "sk-test",
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  assert.equal(auth, "Bearer sk-test");
  assert.equal(data.balance_infos[0].total_balance, "8.52");

  await assert.rejects(
    fetchBalance({ apiKey: "bad", baseUrl: `http://127.0.0.1:${address.port}/nope` }),
    /HTTP 404/,
  );
});
