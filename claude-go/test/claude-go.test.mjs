import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODEL,
  fromOpenAIResponse,
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
