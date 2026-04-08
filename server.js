require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { exec } = require("child_process");

const app = express();

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_USER_ID,
  PROJECT_DIR,
  BUILD_COMMAND = "npm run build",
  DEPLOY_COMMAND = "vercel --yes",
  CODE_COMMAND_PREFIX = "codex exec",
  PORT = "8787",
  TASK_TIMEOUT_MS = "1800000", // 30 min
  MAX_OUTPUT_CHARS = "3500"
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALLOWED_USER_ID || !PROJECT_DIR) {
  console.error("Missing required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, PROJECT_DIR");
  process.exit(1);
}

const RESOLVED_PROJECT_DIR = path.resolve(PROJECT_DIR);
const STATUS_FILE = path.join(__dirname, "status.json");
const LOG_DIR = path.join(__dirname, "logs");
const MAX_OUTPUT = Number(MAX_OUTPUT_CHARS);
const TIMEOUT_MS = Number(TASK_TIMEOUT_MS);

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const botOptions = { polling: true };
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  botOptions.request = { proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY };
}
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, botOptions);

function nowIso() {
  return new Date().toISOString();
}

function defaultStatus() {
  return {
    busy: false,
    currentTask: "",
    currentTaskType: "",
    lastMessage: "idle",
    lastBuildOk: null,
    lastDeployOk: null,
    lastCodeOk: null,
    lastPreviewUrl: "",
    lastLogFile: "",
    lastUpdatedAt: nowIso()
  };
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return defaultStatus();
  }
}

function writeStatus(status) {
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf8");
}

function setStatus(patch) {
  const current = readStatus();
  const next = {
    ...current,
    ...patch,
    lastUpdatedAt: nowIso()
  };
  writeStatus(next);
  return next;
}

function isAllowed(msg) {
  return String(msg.from?.id || "") === String(TELEGRAM_ALLOWED_USER_ID);
}

function sanitizeText(text) {
  if (!text) return "";
  return text.replace(/\0/g, "").trim();
}

function shortText(text, max = MAX_OUTPUT) {
  const clean = sanitizeText(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n\n...已截断`;
}

function shellQuoteSingle(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function makeLogFile(prefix) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(LOG_DIR, `${prefix}-${ts}.log`);
}

function appendLog(file, content) {
  fs.appendFileSync(file, content, "utf8");
}

function runCommand(command, cwd, logFile) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    appendLog(logFile, `\n=== ${nowIso()} ===\n`);
    appendLog(logFile, `CWD: ${cwd}\n`);
    appendLog(logFile, `CMD: ${command}\n\n`);

    exec(
      command,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 20,
        env: process.env,
        shell: "/bin/bash"
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const out = stdout || "";
        const err = stderr || "";

        appendLog(logFile, `STDOUT:\n${out}\n`);
        appendLog(logFile, `STDERR:\n${err}\n`);
        appendLog(
          logFile,
          `RESULT: ${error ? "FAILED" : "SUCCESS"} | duration_ms=${durationMs}\n`
        );

        resolve({
          ok: !error,
          stdout: out,
          stderr: err,
          error: error ? error.message : "",
          durationMs
        });
      }
    );
  });
}

function extractUrl(text) {
  if (!text) return "";
  const matches = text.match(/https?:\/\/[^\s)]+/g);
  if (!matches || !matches.length) return "";
  return matches[matches.length - 1];
}

async function sendLongMessage(chatId, text) {
  const content = String(text || "");
  const chunkSize = 3500;
  for (let i = 0; i < content.length; i += chunkSize) {
    await bot.sendMessage(chatId, content.slice(i, i + chunkSize));
  }
}

async function rejectIfBusy(chatId) {
  const status = readStatus();
  if (!status.busy) return false;
  await bot.sendMessage(
    chatId,
    `当前有任务正在执行：${status.currentTask || "unknown"}`
  );
  return true;
}

async function handleBuild(chatId) {
  if (await rejectIfBusy(chatId)) return;

  const logFile = makeLogFile("build");
  setStatus({
    busy: true,
    currentTask: "build",
    currentTaskType: "build",
    lastMessage: "building",
    lastLogFile: logFile
  });

  await bot.sendMessage(chatId, "开始 build...");

  const result = await runCommand(BUILD_COMMAND, RESOLVED_PROJECT_DIR, logFile);

  if (result.ok) {
    setStatus({
      busy: false,
      currentTask: "",
      currentTaskType: "",
      lastBuildOk: true,
      lastMessage: "build success"
    });
    await bot.sendMessage(
      chatId,
      `Build 成功。\n耗时 ${Math.round(result.durationMs / 1000)} 秒`
    );
  } else {
    setStatus({
      busy: false,
      currentTask: "",
      currentTaskType: "",
      lastBuildOk: false,
      lastMessage: "build failed"
    });

    const message = shortText(result.stderr || result.error || result.stdout || "Build failed");
    await sendLongMessage(chatId, `Build 失败。\n\n${message}`);
  }
}

async function handleDeploy(chatId) {
  if (await rejectIfBusy(chatId)) return;

  const logFile = makeLogFile("deploy");
  setStatus({
    busy: true,
    currentTask: "deploy",
    currentTaskType: "deploy",
    lastMessage: "deploying",
    lastLogFile: logFile
  });

  await bot.sendMessage(chatId, "开始 deploy...");

  const result = await runCommand(DEPLOY_COMMAND, RESOLVED_PROJECT_DIR, logFile);
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  const previewUrl = extractUrl(combined);

  if (result.ok && previewUrl) {
    setStatus({
      busy: false,
      currentTask: "",
      currentTaskType: "",
      lastDeployOk: true,
      lastPreviewUrl: previewUrl,
      lastMessage: "deploy success"
    });

    await bot.sendMessage(
      chatId,
      `Deploy 成功。\n耗时 ${Math.round(result.durationMs / 1000)} 秒\n\n预览地址：\n${previewUrl}`
    );
  } else if (result.ok) {
    setStatus({
      busy: false,
      currentTask: "",
      currentTaskType: "",
      lastDeployOk: true,
      lastMessage: "deploy success but no url"
    });

    await sendLongMessage(
      chatId,
      `Deploy 看起来成功了，但没有识别到预览链接。\n\n${shortText(combined || "No output")}`
    );
  } else {
    setStatus({
      busy: false,
      currentTask: "",
      currentTaskType: "",
      lastDeployOk: false,
      lastMessage: "deploy failed"
    });

    const message = shortText(result.stderr || result.error || result.stdout || "Deploy failed");
    await sendLongMessage(chatId, `Deploy 失败。\n\n${message}`);
  }
}

async function handleCode(chatId, promptText) {
  if (await rejectIfBusy(chatId)) return;

  const cleanedPrompt = sanitizeText(promptText);
  if (!cleanedPrompt) {
    await bot.sendMessage(chatId, "用法：/code 你的需求");
    return;
  }

  const logFile = makeLogFile("code");
  setStatus({
    busy: true,
    currentTask: cleanedPrompt,
    currentTaskType: "code",
    lastMessage: "coding",
    lastLogFile: logFile
  });

  await bot.sendMessage(chatId, `开始执行代码任务：\n${shortText(cleanedPrompt, 1000)}`);

  const command = `${CODE_COMMAND_PREFIX} ${shellQuoteSingle(cleanedPrompt)}`;
  const result = await runCommand(command, RESOLVED_PROJECT_DIR, logFile);

  if (result.ok) {
    setStatus({
      busy: false,
      currentTask: "",
      currentTaskType: "",
      lastCodeOk: true,
      lastMessage: "code success"
    });

    await sendLongMessage(
      chatId,
      `代码任务完成。\n耗时 ${Math.round(result.durationMs / 1000)} 秒\n\n${shortText(result.stdout || "已执行完成")}`
    );
  } else {
    setStatus({
      busy: false,
      currentTask: "",
      currentTaskType: "",
      lastCodeOk: false,
      lastMessage: "code failed"
    });

    const message = shortText(result.stderr || result.error || result.stdout || "Code task failed");
    await sendLongMessage(chatId, `代码任务失败。\n\n${message}`);
  }
}

async function handleLogs(chatId) {
  const status = readStatus();
  const logFile = status.lastLogFile;

  if (!logFile || !fs.existsSync(logFile)) {
    await bot.sendMessage(chatId, "还没有日志。");
    return;
  }

  const content = fs.readFileSync(logFile, "utf8");
  const tail = content.slice(-MAX_OUTPUT);
  await sendLongMessage(chatId, `最近日志：\n${tail}`);
}

async function handlePreview(chatId) {
  const status = readStatus();
  if (!status.lastPreviewUrl) {
    await bot.sendMessage(chatId, "还没有预览地址。");
    return;
  }
  await bot.sendMessage(chatId, `最近预览地址：\n${status.lastPreviewUrl}`);
}

async function handleStatus(chatId) {
  const status = readStatus();
  await sendLongMessage(chatId, JSON.stringify(status, null, 2));
}

bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    [
      "已连接你的 Mac 控制器。",
      "",
      "可用命令：",
      "/build",
      "/deploy",
      "/preview",
      "/status",
      "/logs",
      "/code 你的需求"
    ].join("\n")
  );
});

bot.onText(/\/build/, async (msg) => {
  if (!isAllowed(msg)) return;
  await handleBuild(msg.chat.id);
});

bot.onText(/\/deploy/, async (msg) => {
  if (!isAllowed(msg)) return;
  await handleDeploy(msg.chat.id);
});

bot.onText(/\/preview/, async (msg) => {
  if (!isAllowed(msg)) return;
  await handlePreview(msg.chat.id);
});

bot.onText(/\/status/, async (msg) => {
  if (!isAllowed(msg)) return;
  await handleStatus(msg.chat.id);
});

bot.onText(/\/logs/, async (msg) => {
  if (!isAllowed(msg)) return;
  await handleLogs(msg.chat.id);
});

bot.onText(/\/code(?:\s+([\s\S]+))?/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const promptText = match?.[1] || "";
  await handleCode(msg.chat.id, promptText);
});

bot.on("message", async (msg) => {
  if (!isAllowed(msg)) return;
  if (!msg.text) return;

  const knownCommands = ["/start", "/build", "/deploy", "/preview", "/status", "/logs", "/code"];
  if (knownCommands.some((cmd) => msg.text.startsWith(cmd))) return;

  await bot.sendMessage(
    msg.chat.id,
    "未知命令。\n可用：/build /deploy /preview /status /logs /code 你的需求"
  );
});

app.get("/", (_, res) => {
  res.send("telegram-mac-control running");
});

app.listen(Number(PORT), () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Project dir: ${RESOLVED_PROJECT_DIR}`);
});