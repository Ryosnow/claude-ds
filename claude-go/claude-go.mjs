#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const MODEL = DEFAULT_MODEL;
export const DEFAULT_UPSTREAM =
  "https://opencode.ai/zen/go/v1/chat/completions";

const MAX_REQUEST_BYTES = 128 * 1024 * 1024;

export function configPath() {
  return (
    process.env.CLAUDE_GO_CONFIG ||
    join(homedir(), ".config", "claude-go", "config.json")
  );
}

export function loadConfig(path = configPath()) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`无法读取配置文件 ${path}：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${error.message}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${path} 的顶层必须是一个 JSON 对象`);
  }
  if (parsed.models != null && typeof parsed.models === "object" && !Array.isArray(parsed.models)) {
    for (const [name, entry] of Object.entries(parsed.models)) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`配置文件 ${path} 中 models.${name} 必须是对象`);
      }
    }
  }
  return parsed;
}

function expandTilde(path) {
  const home = process.env.HOME || homedir();
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function normalizeChatCompletionsUrl(url) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function readKeyFile(path) {
  const resolved = expandTilde(path);
  let raw;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`无法读取 api_key_file "${path}"（${resolved}）：${error.message}`);
  }
  const key = raw.trim();
  if (!key) throw new Error(`api_key_file "${path}"（${resolved}）内容为空`);
  return key;
}

export function resolveModelProfile(config, requestedName) {
  const models =
    config.models && typeof config.models === "object" ? config.models : {};
  const defaultName =
    typeof config.default === "string" && config.default ? config.default : null;
  const name = requestedName || process.env.CLAUDE_GO_MODEL || defaultName;

  if (!name) {
    return {
      name: "(内置默认)",
      model: DEFAULT_MODEL,
      apiKey: null,
      upstreamUrl: null,
    };
  }
  const entry = models[name];
  if (entry == null || typeof entry !== "object") {
    const known = Object.keys(models).join(", ") || "(无)";
    throw new Error(
      `未知模型档案 "${name}"。可用的有：${known}（配置文件：${configPath()}）`,
    );
  }

  let apiKey = null;
  if (typeof entry.api_key === "string" && entry.api_key) {
    apiKey = entry.api_key;
  } else if (typeof entry.api_key_file === "string" && entry.api_key_file) {
    apiKey = readKeyFile(entry.api_key_file);
  }

  return {
    name,
    model:
      typeof entry.model === "string" && entry.model
        ? entry.model
        : DEFAULT_MODEL,
    apiKey,
    upstreamUrl:
      typeof entry.base_url === "string" && entry.base_url
        ? normalizeChatCompletionsUrl(entry.base_url)
        : null,
  };
}

export function resolveDeepSeekKey({ env = process.env } = {}) {
  if (typeof env.DEEPSEEK_API_KEY === "string" && env.DEEPSEEK_API_KEY) {
    return { source: "$DEEPSEEK_API_KEY", apiKey: env.DEEPSEEK_API_KEY };
  }
  const home = env.HOME || homedir();
  const tilde = (path) => (path.startsWith("~/") ? join(home, path.slice(2)) : path);
  for (const [path, legacy] of [
    ["~/.config/deepseek/api_key", false],
    ["~/.config/deepseek/token", true],
  ]) {
    const resolved = tilde(path);
    if (!existsSync(resolved)) continue;
    let raw = "";
    try {
      raw = readFileSync(resolved, "utf8").trim();
    } catch {
      continue;
    }
    if (!raw) continue;
    if (legacy && !raw.startsWith("sk-")) continue;
    return { source: resolved, apiKey: raw };
  }
  return null;
}

export async function fetchBalance({
  apiKey,
  baseUrl = "https://api.deepseek.com",
  timeoutMs = 15_000,
} = {}) {
  if (!apiKey) throw new Error("未找到 DeepSeek API Key");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/user/balance`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.trim();
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {}
    throw new Error(`HTTP ${response.status}${message ? `：${message}` : ""}`);
  }
  return JSON.parse(text);
}

function printBalance(data) {
  const info = data?.balance_infos?.[0];
  if (!info) throw new Error("响应中没有 balance_infos，原始数据见 --raw");
  const symbol = info.currency === "CNY" ? "¥" : info.currency === "USD" ? "$" : `${info.currency} `;
  const money = (v) =>
    Number.isFinite(Number(v)) ? `${symbol}${Number(v).toFixed(2)}` : `${symbol}${v}`;
  console.log("================ DeepSeek 账户余额 ================");
  console.log(`账户状态  : ${data.is_available ? "✅ 可用" : "⛔️ 不可用"}`);
  console.log(`币种      : ${info.currency}`);
  console.log(`总余额    : ${money(info.total_balance)}`);
  console.log(`充值余额  : ${money(info.topped_up_balance)}`);
  console.log(`赠送余额  : ${money(info.granted_balance)}`);
  console.log("===================================================");
}

async function balanceCommand(args) {
  const raw = args.includes("--raw");
  const found = resolveDeepSeekKey();
  if (!found) {
    console.error(
      "未找到 DeepSeek API Key。请设置 DEEPSEEK_API_KEY，或写入 ~/.config/deepseek/api_key",
    );
    return 1;
  }
  try {
    const data = await fetchBalance({ apiKey: found.apiKey });
    if (raw) console.log(JSON.stringify(data, null, 2));
    else printBalance(data);
    return 0;
  } catch (error) {
    console.error(`查询余额失败：${error.message}`);
    return 1;
  }
}

export function extractModelSelection(args, config) {
  const models =
    config.models && typeof config.models === "object" ? config.models : {};
  const names = new Set(Object.keys(models));
  const rest = [];
  let selected = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value = null;
    if ((arg === "--model" || arg === "-m") && i + 1 < args.length) {
      const next = args[i + 1];
      if (names.has(next)) {
        value = next;
        i++;
      }
    } else if (arg.startsWith("--model=")) {
      const candidate = arg.slice("--model=".length);
      if (names.has(candidate)) value = candidate;
    }
    if (value != null) {
      selected = value;
      continue;
    }
    rest.push(arg);
  }
  return { args: rest, selected };
}

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

export function toOpenAIRequest(body, model = DEFAULT_MODEL) {
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
    model,
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

export function fromOpenAIResponse(data, model = DEFAULT_MODEL) {
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
    model,
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

async function translateStream(upstream, res, model = DEFAULT_MODEL) {
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
      model,
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
  model = DEFAULT_MODEL,
  localToken = randomBytes(24).toString("hex"),
  upstreamUrl = DEFAULT_UPSTREAM,
  host = "127.0.0.1",
  port = 0,
} = {}) {
  if (!apiKey) throw new Error("OPENCODE_API_KEY is required");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      jsonResponse(res, 200, { ok: true, model, version: VERSION });
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
        body: JSON.stringify(toOpenAIRequest(body, model)),
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
        await translateStream(upstream, res, model);
      } else {
        const data = await upstream.json();
        jsonResponse(res, 200, fromOpenAIResponse(data, model));
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

Run Claude Code with OpenCode Go models (default: ${DEFAULT_MODEL}).

Usage:
  claude-go [claude arguments...]
  claude-go --model <profile> [claude arguments...]
  claude-go doctor
  claude-go --claude-go-help

Selecting a model:
  claude-go --model <profile>    Use a profile defined in the config file
  CLAUDE_GO_MODEL=<profile>      Same, via environment variable
  Without either, the config's "default" profile (or ${DEFAULT_MODEL}) is used.
  "--model"/"-m" is only intercepted when its value matches a profile name;
  otherwise it is passed through to Claude Code unchanged.

Config file:
  $CLAUDE_GO_CONFIG or ~/.config/claude-go/config.json
  {
    "default": "flash",
    "models": {
      "flash":   { "model": "deepseek-v4-flash" },
      "pro":     { "model": "deepseek-v4-pro", "api_key": "..." },
      "ds-chat": { "model": "deepseek-chat",
                   "base_url": "https://api.deepseek.com",
                   "api_key_file": "~/.config/deepseek/api_key" }
    }
  }
  Per-profile fields are all optional:
    model          defaults to ${DEFAULT_MODEL}
    api_key        inline key; falls back to api_key_file, then OPENCODE_API_KEY
    api_key_file   path to a key file (~ expanded), e.g. ~/.config/deepseek/api_key
    base_url       any OpenAI-compatible endpoint; "/chat/completions" is
                   appended when missing. Defaults to the OpenCode Go endpoint.

Balance (DeepSeek platform):
  claude-go balance           pretty-print DeepSeek account balance
  claude-go balance --raw     raw JSON
  Uses DEEPSEEK_API_KEY or ~/.config/deepseek/api_key.

Required environment:
  OPENCODE_API_KEY    Your OpenCode Go API key (unless set per profile)

Examples:
  claude-go
  claude-go -p "explain this project"
  claude-go --model pro
  claude-go --model ds-chat
  claude-go balance
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

  let config = {};
  let configError = null;
  try {
    config = loadConfig();
  } catch (error) {
    configError = error.message;
  }
  const profiles = Object.keys(config.models ?? {});
  if (configError) {
    console.log(`✗ 配置文件：${configError}`);
  } else if (profiles.length === 0) {
    console.log(`ℹ 配置文件：未找到 ${configPath()}（使用内置默认 ${DEFAULT_MODEL} + OPENCODE_API_KEY）`);
  } else {
    const fallback = typeof config.default === "string" ? config.default : "(未设置)";
    console.log(`✓ 配置文件：${configPath()}`);
    console.log(`  默认档案: ${fallback}`);
    for (const name of profiles) {
      const entry = config.models[name];
      const model = entry.model || DEFAULT_MODEL;
      const keyFrom = entry.api_key ? "config" : entry.api_key_file ? `file: ${entry.api_key_file}` : "env";
      console.log(`  - ${name} → ${model}（api_key: ${keyFrom}${entry.base_url ? `, base_url: 自定义` : ""}）`);
    }
  }

  const deepseekKey = resolveDeepSeekKey();
  console.log(`${deepseekKey ? "✓" : "ℹ"} DeepSeek 余额查询 Key${deepSeekLabel(deepseekKey)}`);

  let selectedLabel;
  try {
    const profile = resolveModelProfile(config, process.env.CLAUDE_GO_MODEL);
    selectedLabel = `${profile.name} → ${profile.model}`;
  } catch (error) {
    selectedLabel = `无法解析：${error.message}`;
  }
  console.log(`ℹ 当前生效模型: ${selectedLabel}`);
  return nodeOk && claudeOk && (keyOk || configError == null && hasProfileApiKey(config)) ? 0 : 1;
}

function hasProfileApiKey(config) {
  const models = config.models ?? {};
  const defaultName = typeof config.default === "string" ? config.default : null;
  if (!defaultName) return false;
  const entry = models[defaultName];
  if (!entry || typeof entry !== "object") return false;
  return Boolean(
    (typeof entry.api_key === "string" && entry.api_key) ||
      (typeof entry.api_key_file === "string" && entry.api_key_file),
  );
}

function deepSeekLabel(found) {
  if (!found) return "：未配置（DEEPSEEK_API_KEY 或 ~/.config/deepseek/api_key，仅影响 balance 子命令）";
  return `：${found.source}`;
}

async function runClaude(args) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node.js 20+ is required; found ${process.versions.node}`);

  const config = loadConfig();
  const { args: claudeArgs, selected } = extractModelSelection(args, config);
  const profile = resolveModelProfile(config, selected);
  const apiKey = profile.apiKey ?? process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "未找到 API Key：请在配置文件对应模型档案里设置 \"api_key\" 或 \"api_key_file\"，或 export OPENCODE_API_KEY=...",
    );
  }

  const proxy = await startProxy({
    apiKey,
    model: profile.model,
    ...(profile.upstreamUrl ? { upstreamUrl: profile.upstreamUrl } : {}),
  });
  const childEnv = { ...process.env };
  delete childEnv.OPENCODE_API_KEY;
  Object.assign(childEnv, {
    ANTHROPIC_BASE_URL: proxy.baseUrl,
    ANTHROPIC_AUTH_TOKEN: proxy.localToken,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model,
    CLAUDE_CODE_SUBAGENT_MODEL: profile.model,
  });

  const child = spawn("claude", claudeArgs, { stdio: "inherit", env: childEnv });
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
  if (args[0] === "balance") return balanceCommand(args.slice(1));
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
