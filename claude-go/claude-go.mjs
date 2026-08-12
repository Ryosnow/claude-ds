#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const MODEL = "deepseek-v4-flash";
export const DEFAULT_UPSTREAM =
  "https://opencode.ai/zen/go/v1/chat/completions";

const MAX_REQUEST_BYTES = 128 * 1024 * 1024;

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function anthropicError(status, message) {
  let type = "api_error";
  if (status === 400) type = "invalid_request_error";
  if (status === 401 || status === 403) type = "authentication_error";
  if (status === 404) type = "not_found_error";
  if (status === 429) type = "rate_limit_error";
  if (status === 529) type = "overloaded_error";
  return { type: "error", error: { type, message } };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function systemText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function anthropicPartToOpenAI(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "text") return { type: "text", text: part.text ?? "" };
  if (part.type === "image" && part.source?.type === "base64") {
    const mediaType = part.source.media_type || "application/octet-stream";
    return {
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${part.source.data}` },
    };
  }
  return null;
}

function compactContent(parts) {
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("");
  }
  return parts;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "image") {
        return `[image result omitted: ${part.source?.media_type || "unknown type"}]`;
      }
      return part == null ? "" : JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function convertUserMessage(message) {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }];
  }

  const result = [];
  let parts = [];
  const flushUser = () => {
    if (parts.length === 0) return;
    result.push({ role: "user", content: compactContent(parts) });
    parts = [];
  };

  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "tool_result") {
      flushUser();
      const content = toolResultText(block.content);
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: block.is_error ? `[tool error]\n${content}` : content,
      });
      continue;
    }
    const part = anthropicPartToOpenAI(block);
    if (part) parts.push(part);
  }
  flushUser();

  if (result.length === 0) result.push({ role: "user", content: "" });
  return result;
}

function convertAssistantMessage(message) {
  if (typeof message.content === "string") {
    return [{ role: "assistant", content: message.content }];
  }

  const text = [];
  const toolCalls = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "text") text.push(block.text ?? "");
    if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const converted = { role: "assistant", content: text.join("") || null };
  if (toolCalls.length > 0) converted.tool_calls = toolCalls;
  return [converted];
}

function convertToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

export function toOpenAIRequest(body) {
  const messages = [];
  const system = systemText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === "assistant") {
      messages.push(...convertAssistantMessage(message));
    } else if (message?.role === "user") {
      messages.push(...convertUserMessage(message));
    }
  }

  const request = {
    model: MODEL,
    messages,
    max_tokens: Number.isFinite(body.max_tokens) ? body.max_tokens : 8192,
    stream: Boolean(body.stream),
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    request.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    request.stop = body.stop_sequences;
  }
  if (Number.isFinite(body.temperature)) request.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) request.top_p = body.top_p;

  return request;
}

function stopReason(finishReason, hasTools = false) {
  if (hasTools || finishReason === "tool_calls" || finishReason === "function_call") {
    return "tool_use";
  }
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "stop" || finishReason == null) return "end_turn";
  return "end_turn";
}

function normalizedArguments(value) {
  if (!value) return "{}";
  if (typeof value !== "string") return JSON.stringify(value);
  try {
    JSON.parse(value);
    return value;
  } catch {
    return JSON.stringify({ _raw_arguments: value });
  }
}

export function fromOpenAIResponse(data) {
  const choice = data?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part?.text ?? "").join("")
        : "";
  if (text) content.push({ type: "text", text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    let input = {};
    try {
      input = JSON.parse(normalizedArguments(call.function?.arguments));
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${randomUUID().replaceAll("-", "")}`,
      name: call.function?.name || "unknown_tool",
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: data.id || `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: MODEL,
    content,
    stop_reason: stopReason(choice.finish_reason, content.some((x) => x.type === "tool_use")),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

function writeSse(res, event, value) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function parseSseEvent(raw) {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data || null;
}

async function translateStream(upstream, res) {
  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = null;
  let textOpen = false;
  let textSeen = false;
  let textIndex = -1;
  let nextIndex = 0;
  const toolCalls = new Map();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: MODEL,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const handleChunk = (chunk) => {
    if (chunk?.error) {
      const message = chunk.error.message || JSON.stringify(chunk.error);
      throw new Error(message);
    }
    if (chunk?.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason != null) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textOpen) {
        textIndex = nextIndex++;
        textOpen = true;
        writeSse(res, "content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
      }
      textSeen = true;
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    for (const callDelta of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = callDelta.index ?? 0;
      const call = toolCalls.get(key) ?? { id: "", name: "", arguments: "" };
      if (callDelta.id) call.id += callDelta.id;
      if (callDelta.function?.name) call.name += callDelta.function.name;
      if (callDelta.function?.arguments) call.arguments += callDelta.function.arguments;
      toolCalls.set(key, call);
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of upstream.body) {
    buffer += decoder.decode(bytes, { stream: true });
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = parseSseEvent(raw);
      if (!data || data === "[DONE]") continue;
      handleChunk(JSON.parse(data));
    }
  }
  buffer += decoder.decode();
  const trailing = parseSseEvent(buffer);
  if (trailing && trailing !== "[DONE]") handleChunk(JSON.parse(trailing));

  if (textOpen) {
    writeSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: textIndex,
    });
  }

  for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    const index = nextIndex++;
    const id = call.id || `toolu_${randomUUID().replaceAll("-", "")}`;
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id,
        name: call.name || "unknown_tool",
        input: {},
      },
    });
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: normalizedArguments(call.arguments),
      },
    });
    writeSse(res, "content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }

  if (!textSeen && toolCalls.size === 0) {
    const index = nextIndex++;
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    writeSse(res, "content_block_stop", { type: "content_block_stop", index });
  }

  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: stopReason(finishReason, toolCalls.size > 0),
      stop_sequence: null,
    },
    usage: { output_tokens: outputTokens },
  });
  writeSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function upstreamErrorMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    return (
      parsed?.error?.message ||
      parsed?.error?.error?.message ||
      parsed?.message ||
      `OpenCode Go request failed with HTTP ${status}`
    );
  } catch {
    return text.trim() || `OpenCode Go request failed with HTTP ${status}`;
  }
}

function estimateTokens(body) {
  const serialized = JSON.stringify({
    system: body.system,
    messages: body.messages,
    tools: body.tools,
  });
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, "utf8") / 4));
}

function isAuthorized(req, localToken) {
  const auth = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  return auth === `Bearer ${localToken}` || apiKey === localToken;
}

export async function startProxy({
  apiKey,
  localToken = randomBytes(24).toString("hex"),
  upstreamUrl = DEFAULT_UPSTREAM,
  host = "127.0.0.1",
  port = 0,
} = {}) {
  if (!apiKey) throw new Error("OPENCODE_API_KEY is required");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      jsonResponse(res, 200, { ok: true, model: MODEL, version: VERSION });
      return;
    }
    if (!isAuthorized(req, localToken)) {
      jsonResponse(res, 401, anthropicError(401, "Invalid local proxy token"));
      return;
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/v1/messages") && !url.pathname.endsWith("/v1/messages/count_tokens")) {
      jsonResponse(res, 404, anthropicError(404, `Unsupported endpoint: ${url.pathname}`));
      return;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      const status = error.statusCode || 400;
      jsonResponse(res, status, anthropicError(status, error.message));
      return;
    }

    if (url.pathname.endsWith("/count_tokens")) {
      jsonResponse(res, 200, { input_tokens: estimateTokens(body) });
      return;
    }

    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: body.stream ? "text/event-stream" : "application/json",
          "user-agent": `claude-go/${VERSION}`,
        },
        body: JSON.stringify(toOpenAIRequest(body)),
        signal: controller.signal,
      });
    } catch (error) {
      if (!res.headersSent) {
        jsonResponse(res, 502, anthropicError(502, `Cannot reach OpenCode Go: ${error.message}`));
      }
      return;
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      const message = upstreamErrorMessage(text, upstream.status);
      jsonResponse(res, upstream.status, anthropicError(upstream.status, message));
      return;
    }

    try {
      if (body.stream) {
        await translateStream(upstream, res);
      } else {
        const data = await upstream.json();
        jsonResponse(res, 200, fromOpenAIResponse(data));
      }
    } catch (error) {
      if (res.headersSent) {
        writeSse(res, "error", anthropicError(502, `Invalid upstream response: ${error.message}`));
        res.end();
      } else {
        jsonResponse(res, 502, anthropicError(502, `Invalid upstream response: ${error.message}`));
      }
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    server,
    localToken,
    baseUrl: `http://${host}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())),
  };
}

function printHelp() {
  console.log(`claude-go ${VERSION}

Run Claude Code with OpenCode Go's ${MODEL} model.

Usage:
  claude-go [claude arguments...]
  claude-go doctor
  claude-go --claude-go-help

Required environment:
  OPENCODE_API_KEY    Your OpenCode Go API key

Examples:
  claude-go
  claude-go -p "explain this project"
  claude-go -c
`);
}

function doctor() {
  const major = Number(process.versions.node.split(".")[0]);
  const nodeOk = major >= 20;
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  const claudeOk = claude.status === 0;
  const keyOk = Boolean(process.env.OPENCODE_API_KEY);
  console.log(`${nodeOk ? "✓" : "✗"} Node.js ${process.versions.node} (requires 20+)`);
  console.log(`${claudeOk ? "✓" : "✗"} Claude Code${claudeOk ? `: ${(claude.stdout || claude.stderr).trim()}` : " command not found"}`);
  console.log(`${keyOk ? "✓" : "✗"} OPENCODE_API_KEY${keyOk ? " is set" : " is not set"}`);
  console.log(`✓ Model: ${MODEL}`);
  return nodeOk && claudeOk && keyOk ? 0 : 1;
}

async function runClaude(args) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node.js 20+ is required; found ${process.versions.node}`);
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    throw new Error("OPENCODE_API_KEY is not set. Export it before running claude-go.");
  }

  const proxy = await startProxy({ apiKey });
  const childEnv = { ...process.env };
  delete childEnv.OPENCODE_API_KEY;
  Object.assign(childEnv, {
    ANTHROPIC_BASE_URL: proxy.baseUrl,
    ANTHROPIC_AUTH_TOKEN: proxy.localToken,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
  });

  const child = spawn("claude", args, { stdio: "inherit", env: childEnv });
  const relay = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGTERM", relay);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.removeListener("SIGTERM", relay);
    await proxy.close();
  }
  if (exit.signal) process.kill(process.pid, exit.signal);
  return exit.code ?? 1;
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "doctor") return doctor();
  if (args[0] === "--claude-go-help" || args[0] === "--version") {
    if (args[0] === "--version") console.log(VERSION);
    else printHelp();
    return 0;
  }
  return runClaude(args);
}

const isEntrypoint = process.argv[1]
  ? realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  : false;
if (isEntrypoint) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`claude-go: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
