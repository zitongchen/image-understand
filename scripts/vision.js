#!/usr/bin/env node
/**
 * image-understand 识图脚本（零依赖）
 *
 * 用法:
 *   node vision.js <图片路径...> [--prompt <问题>]
 *   node vision.js --url <图片链接...> [--prompt <问题>]
 *   node vision.js <图片路径...> --json
 *   --url 可重复使用；本地路径与 --url 可混用；带问题必须使用 --prompt
 *
 * 配置（优先级：环境变量 > scripts/.env）:
 *   VISION_API_KEY           识图模型 API Key（必填）
 *   VISION_MODEL             模型名（必填，推荐使用百炼大模型 qwen3.7-flash）
 *   VISION_BASE_URL          OpenAI 兼容接口地址（必填，如 https://api.openai.com/v1）
 *   VISION_REASONING_EFFORT  思考强度，默认 none（none/minimal/low/medium/high）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SCRIPT_DIR = __dirname;
const DEFAULT_PROMPT = "请简要描述图片的内容。";
const DEFAULT_PROMPT_MULTI = "请简要描述这些图片的内容。";
const TIMEOUT_MS = 120000;
const MAX_OUTPUT_TOKENS = 1024;
const MAX_RETRIES = 2; // 空响应或临时故障时的最大重试次数（共 MAX_RETRIES + 1 次请求）
const RETRY_DELAY_MS = 1000; // 重试间隔基数，按第几次重试递增（1s、2s）
const MIME_MAP = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markRetryable(err) {
  err.retryable = true;
  return err;
}

// 简易 .env 解析（KEY=VALUE，支持 # 注释与引号），不依赖 dotenv
function loadEnvFile() {
  const envPath = path.join(SCRIPT_DIR, ".env");
  let content;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // .env 不存在时忽略
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getConfig() {
  const apiKey = process.env.VISION_API_KEY || "";
  const model = process.env.VISION_MODEL || "";
  const baseUrl = (process.env.VISION_BASE_URL || "").replace(/\/+$/, "");
  const effort = process.env.VISION_REASONING_EFFORT || "none";
  return { apiKey, model, baseUrl, effort };
}

function parseArgs(argv) {
  const imageSources = []; // { source, isUrl }
  let prompt = "";
  let jsonMode = false;
  let expectUrl = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") {
      expectUrl = true;
    } else if (arg === "--json") {
      jsonMode = true;
    } else if (arg === "--prompt" || arg === "-p") {
      prompt = argv[++i] ?? "";
    } else if (arg.startsWith("--")) {
      // 忽略未知选项
    } else if (expectUrl) {
      imageSources.push({ source: arg, isUrl: true });
      expectUrl = false;
    } else {
      imageSources.push({ source: arg, isUrl: false });
    }
  }

  return { imageSources, prompt, jsonMode };
}

function resolveImageUrl(source, isUrl) {
  if (isUrl || /^https?:\/\//i.test(source)) {
    if (!/^https?:\/\//i.test(source)) {
      throw new Error(`无效的图片链接: ${source}`);
    }
    return source;
  }
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new Error(`文件不存在: ${resolved}`);
  }
  if (fs.statSync(resolved).isDirectory()) {
    throw new Error(`路径是目录，不是图片文件: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase().slice(1);
  const mime = MIME_MAP[ext];
  if (!mime) {
    throw new Error(`不支持的图片格式: ${ext || "未知"}（支持 jpg/jpeg/png/gif/webp/bmp）`);
  }
  const data = fs.readFileSync(resolved);
  return `data:image/${mime};base64,${data.toString("base64")}`;
}

function extractApiError(raw, status) {
  let message = "";
  try {
    const parsed = JSON.parse(raw);
    message = parsed.error?.message || parsed.message || "";
  } catch {
    // 非 JSON 错误体，使用原文片段
  }
  const fallback = raw.slice(0, 300).trim();
  if (status === 401) {
    return `API Key 无效或未开通（401）: ${message || fallback || "请检查 Key 与模型服务开通状态"}`;
  }
  if (status === 429) {
    return `请求过于频繁或额度不足（429）: ${message || fallback || "请稍后重试"}`;
  }
  if (status >= 500) {
    return `模型服务暂时不可用（${status}）: ${message || fallback || "请稍后重试"}`;
  }
  return `API 请求失败（${status}）: ${message || fallback}`;
}

function extractOutputText(response) {
  const parts = [];
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || item.type !== "message") continue; // 跳过 reasoning 等非消息项
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part && typeof part.text === "string" && part.text) {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

// 清理模型偶发输出的残留标签（如开头的 </think>）
function sanitizeText(text) {
  return text.replace(/^\s*<\/think>\s*/i, "").trim();
}

async function callResponsesOnce(config, imageUrls, prompt) {
  const url = `${config.baseUrl}/responses`;
  const content = [{ type: "input_text", text: prompt }];
  for (const imageUrl of imageUrls) {
    content.push({ type: "input_image", image_url: imageUrl });
  }
  const body = {
    model: config.model,
    input: [{ role: "user", content }],
    reasoning: { effort: config.effort },
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw markRetryable(new Error(`请求超时（${TIMEOUT_MS / 1000} 秒），请稍后重试`));
    }
    throw markRetryable(new Error(`网络请求失败: ${err.message}`));
  }

  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(extractApiError(raw, res.status));
    if (res.status === 429 || res.status >= 500) markRetryable(err);
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`API 返回了无法解析的内容: ${raw.slice(0, 200)}`);
  }

  const text = extractOutputText(parsed);
  if (!text) {
    throw markRetryable(new Error(`模型未返回文字内容（status=${parsed.status || "unknown"}）`));
  }
  return { text: sanitizeText(text), usage: parsed.usage || null, model: parsed.model || config.model };
}

async function callResponses(config, imageUrls, prompt) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
    try {
      return await callResponsesOnce(config, imageUrls, prompt);
    } catch (err) {
      lastError = err;
      if (!err.retryable) throw err;
    }
  }
  throw lastError;
}

async function main() {
  loadEnvFile();
  const config = getConfig();
  if (!config.apiKey || config.apiKey === "sk-xxx") {
    console.error("未配置 VISION_API_KEY。请在 skill 目录 scripts/.env 中填入识图模型 API Key，或设置环境变量。");
    process.exit(1);
  }
  if (!config.model) {
    console.error("未配置 VISION_MODEL。请在 skill 目录 scripts/.env 中填入模型名（推荐使用百炼大模型 qwen3.7-flash），或设置环境变量。");
    process.exit(1);
  }
  if (!config.baseUrl) {
    console.error("未配置 VISION_BASE_URL。请在 skill 目录 scripts/.env 中填入 OpenAI 兼容接口地址（如 https://api.openai.com/v1），或设置环境变量。");
    process.exit(1);
  }

  const { imageSources, prompt, jsonMode } = parseArgs(process.argv.slice(2));
  if (imageSources.length === 0) {
    console.error("用法: node vision.js <图片路径...> [--prompt <问题>]");
    console.error("      node vision.js --url <图片链接...> [--prompt <问题>]");
    console.error("可选: --json 输出 JSON（含 usage）；带问题必须使用 --prompt");
    process.exit(1);
  }

  try {
    const imageUrls = imageSources.map(({ source, isUrl }) => resolveImageUrl(source, isUrl));
    const finalPrompt = prompt || (imageUrls.length > 1 ? DEFAULT_PROMPT_MULTI : DEFAULT_PROMPT);
    const result = await callResponses(config, imageUrls, finalPrompt);
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.text);
    }
  } catch (err) {
    console.error(`识图失败: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

// 供测试/复用
module.exports = { parseArgs, resolveImageUrl, callResponses, DEFAULT_PROMPT, DEFAULT_PROMPT_MULTI };
