import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProxyAgent, setGlobalDispatcher } from "undici";

dotenv.config();

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`Using proxy: ${proxyUrl}`);
}

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = String(process.env.TELEGRAM_ALLOWED_USER_ID || "");
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || process.cwd();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1200);
const STATE_DIR = join(process.cwd(), ".data");
const STATE_FILE = join(STATE_DIR, "chat-state.json");

if (!TG_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN");
}

const TG_BASE = `https://api.telegram.org/bot${TG_TOKEN}`;

let offset = 0;
let polling = false;

function describeError(err) {
  if (!err) return "unknown error";
  const parts = [err.message, err.cause?.message, err.code, err.cause?.code].filter(Boolean);
  return [...new Set(parts)].join(" | ");
}

/**
 * 每个 chat 只允许一个任务运行
 * chatId -> { child, statusMessageId, replyToMessageId }
 */
const runningJobs = new Map();

/**
 * 每个 chat 的持久化状态
 * chatId -> { workdir?: string, instructionContext?: string }
 */
const chatStates = loadChatStates();

function loadChatStates() {
  if (!existsSync(STATE_FILE)) {
    return new Map();
  }

  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return new Map(Object.entries(raw));
  } catch (err) {
    console.error(`Failed to load chat state: ${describeError(err)}`);
    return new Map();
  }
}

function saveChatStates() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const data = Object.fromEntries(chatStates);
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save chat state: ${describeError(err)}`);
  }
}

function getChatState(chatId) {
  return chatStates.get(String(chatId)) || {};
}

function setChatState(chatId, patch) {
  const key = String(chatId);
  const nextState = { ...getChatState(key), ...patch };
  chatStates.set(key, nextState);
  saveChatStates();
  return nextState;
}

function getChatWorkdir(chatId) {
  return getChatState(chatId).workdir || CODEX_WORKDIR;
}

function getInstructionContext(chatId) {
  return getChatState(chatId).instructionContext || "";
}

function isExistingDirectory(dir) {
  return existsSync(dir) && statSync(dir).isDirectory();
}

function parseReportedWorkdir(text) {
  if (!text) return null;

  const match = text.match(/(?:^|\n)WORKDIR:\s*(.+?)(?:\n|$)/);
  if (!match) return null;

  const dir = match[1].trim();
  if (!dir.startsWith("/")) return null;
  if (!isExistingDirectory(dir)) return null;

  return dir;
}

/**
 * Telegram API with retry logic
 */
async function tg(method, body = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${TG_BASE}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000), // 30s timeout
      });

      const data = await res.json();

      if (!data.ok) {
        throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
      }

      return data.result;
    } catch (err) {
      const isLastRetry = i === retries - 1;
      const isNetworkError = err.code === 'ECONNRESET' || err.cause?.code === 'ECONNRESET' || err.name === 'AbortError';

      if (isNetworkError && !isLastRetry) {
        const delay = Math.min(1000 * Math.pow(2, i), 5000); // exponential backoff, max 5s
        console.log(`Retry ${i + 1}/${retries} for ${method} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw err;
    }
  }
}

async function sendMessage(chatId, text, replyToMessageId = undefined) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_to_message_id: replyToMessageId,
    disable_web_page_preview: true,
  });
}

async function editMessage(chatId, messageId, text) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
}

function safeText(input, max = 3500) {
  if (input == null) return "";
  const s = String(input);
  return s.length > max ? `${s.slice(0, max)}\n…(已截断)` : s;
}

async function sendLongMessage(chatId, text, replyToMessageId = undefined) {
  const MAX = 3500;
  const s = String(text || "");
  if (!s) return;

  for (let i = 0; i < s.length; i += MAX) {
    const part = s.slice(i, i + MAX);
    await sendMessage(chatId, part, replyToMessageId);
  }
}

function isAllowedUser(message) {
  if (!ALLOWED_USER_ID) return true;
  return String(message.from?.id || "") === ALLOWED_USER_ID;
}

async function downloadTelegramPhoto(photo) {
  // 取最大尺寸
  const fileId = photo[photo.length - 1].file_id;
  const fileInfo = await tg("getFile", { file_id: fileId });
  const filePath = fileInfo.file_path;

  const url = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`下载图片失败：${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = filePath.split(".").pop() || "jpg";
  const dir = join(tmpdir(), "tg_codex_images");
  mkdirSync(dir, { recursive: true });
  const localPath = join(dir, `${fileId}.${ext}`);
  writeFileSync(localPath, buffer);
  return localPath;
}

/**
 * 把 codex --json 事件格式化成 Telegram 可读文本
 */
function formatCodexEvent(event) {
  const item = event.item || {};
  const type = item.type || event.type || "unknown";

  // 一些常见事件
  if (type === "agent_message") {
    return `Codex：${safeText(item.text || event.text || "")}`;
  }

  if (type === "plan_update") {
    return `计划更新：${safeText(item.text || item.plan || event.text || "已更新")}`;
  }

  if (type === "command_execution") {
    const cmd = item.command || item.cmd || "(unknown command)";
    const status = item.status || event.status || "running";
    const output = item.output ? `\n输出：\n${safeText(item.output, 1200)}` : "";
    return `执行命令 [${status}]：\n${safeText(cmd, 1200)}${output}`;
  }

  if (type === "file_change") {
    const path = item.path || item.file || "(unknown file)";
    const change = item.change_type || item.change || "modified";
    return `文件变更：${change} ${path}`;
  }

  if (type === "reasoning") {
    return `思考摘要：${safeText(item.text || event.text || "")}`;
  }

  if (type === "web_search") {
    return `搜索：${safeText(item.query || event.query || "")}`;
  }

  // turn 事件
  if (event.type === "turn.started") {
    return "Codex 已启动，正在分析任务…";
  }

  if (event.type === "turn.completed") {
    return "Codex 已完成当前轮次。";
  }

  if (event.type === "turn.failed") {
    return `Codex 执行失败：${safeText(event.error || event.message || "")}`;
  }

  if (event.type === "error") {
    return `错误：${safeText(event.message || JSON.stringify(event), 1500)}`;
  }

  return `${type}：${safeText(JSON.stringify(event), 1200)}`;
}

/**
 * 过滤哪些事件需要发给 Telegram
 */
function shouldNotify(event) {
  if (!event || !event.type) return false;

  if (
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "error"
  ) {
    return true;
  }

  if (event.type === "item.started" || event.type === "item.completed") {
    const t = event.item?.type;
    return [
      "plan_update",
      "agent_message",
      "command_execution",
      "file_change",
      "reasoning",
      "web_search",
    ].includes(t);
  }

  return false;
}

/**
 * 根据任务文本构造 prompt
 */
function buildPrompt(userText, workdir, instructionContext = "", imagePath = null) {
  const imageSection = imagePath
    ? `\n用户附带了一张图片，本地路径为：${imagePath}\n`
    : "";
  const contextSection = instructionContext
    ? `\n持久化指令上下文：\n${instructionContext}\n`
    : "";
  return `
你正在本机工作，工作目录是：${workdir}
${imageSection}
${contextSection}
执行要求：
1. 可以修改代码并运行必要命令
2. 每完成关键步骤都输出简短进度
3. 如果是前端任务，尽量接入现有 play/demo 预览环境
4. 如果可以启动预览服务，请告诉我局域网访问方式
5. 尽量少改动现有结构
6. 完成后总结改动文件、执行过的关键命令、结果
7. 如遇到失败，明确告诉我失败点和下一步建议
8. 最终回复最后单独输出一行：WORKDIR: <绝对路径>
9. 这个 WORKDIR 表示下次任务默认执行目录；如果本次进入了别的目录并决定后续继续在那里工作，就输出那个目录，否则输出当前工作目录

用户任务：
${userText}
  `.trim();
}

/**
 * 调用本机 codex exec --json
 */
async function runCodexJob(chatId, replyToMessageId, userText, imagePath = null) {
  if (runningJobs.has(chatId)) {
    await sendMessage(
      chatId,
      "当前已有一个任务在运行，请先等待完成，或发送 /stop 停止当前任务。",
      replyToMessageId
    );
    return;
  }

  const statusMsg = await sendMessage(chatId, "任务已接收，正在启动 Codex…", replyToMessageId);

  const workdir = getChatWorkdir(chatId);
  const instructionContext = getInstructionContext(chatId);
  const prompt = buildPrompt(userText, workdir, instructionContext, imagePath);

  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--add-dir",
    workdir,
  ];

  if (imagePath) {
    args.push("--image", imagePath);
  }

  args.push(prompt);

  const child = spawn("codex", args, {
    cwd: workdir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  runningJobs.set(chatId, {
    child,
    statusMessageId: statusMsg.message_id,
    replyToMessageId,
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let finalAgentText = "";
  let lastStatusText = "任务已接收，正在启动 Codex…";
  let lastEditAt = 0;

  async function throttledEdit(text) {
    const now = Date.now();
    if (!text || text === lastStatusText) return;
    if (now - lastEditAt < 1200) return;

    lastEditAt = now;
    lastStatusText = text;

    try {
      await editMessage(chatId, statusMsg.message_id, safeText(text, 3900));
    } catch (e) {
      // 某些情况下 edit 失败，忽略即可
    }
  }

  async function notify(text) {
    if (!text) return;
    try {
      await sendLongMessage(chatId, text, replyToMessageId);
    } catch (e) {
      console.error("notify error:", e.message);
    }
  }

  child.stdout.on("data", async (chunk) => {
    stdoutBuffer += chunk.toString("utf8");

    while (true) {
      const idx = stdoutBuffer.indexOf("\n");
      if (idx === -1) break;

      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);

      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (!shouldNotify(event)) continue;

      const text = formatCodexEvent(event);

      if (event.item?.type === "agent_message" && event.item?.text) {
        finalAgentText = event.item.text;
      }

      // 命令执行类主要编辑状态
      if (event.item?.type === "command_execution") {
        await throttledEdit(text);
        continue;
      }

      // turn.started / turn.completed 适合作状态
      if (
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.failed"
      ) {
        await throttledEdit(text);
        continue;
      }

      // 文件变更 / 计划更新 / agent_message 走消息
      await notify(text);
    }
  });

  child.stderr.on("data", async (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    const parts = stderrBuffer.split("\n");
    stderrBuffer = parts.pop() || "";

    for (const line of parts) {
      const s = line.trim();
      if (!s) continue;

      // stderr 更多拿来做“运行中”状态提示
      await throttledEdit(`运行中：${safeText(s, 1000)}`);
    }
  });

  child.on("close", async (code) => {
    runningJobs.delete(chatId);

    if (code === 0) {
      const nextWorkdir = parseReportedWorkdir(finalAgentText) || workdir;
      setChatState(chatId, { workdir: nextWorkdir });

      try {
        await editMessage(chatId, statusMsg.message_id, "任务完成。");
      } catch {}

      if (finalAgentText) {
        await notify(`最终结果：\n${finalAgentText}`);
      } else {
        await notify("任务完成，但没有抓到最终说明。你可以查看项目文件改动确认结果。");
      }
    } else {
      try {
        await editMessage(chatId, statusMsg.message_id, `任务失败，退出码：${code}`);
      } catch {}

      const errText = stderrBuffer.trim()
        ? `stderr：\n${safeText(stderrBuffer, 3000)}`
        : "Codex 执行失败，但没有额外 stderr。";
      await notify(errText);
    }
  });

  child.on("error", async (err) => {
    runningJobs.delete(chatId);
    try {
      await editMessage(chatId, statusMsg.message_id, `启动 Codex 失败：${err.message}`);
    } catch {}
  });
}

/**
 * 处理 Telegram 消息
 */
async function handleMessage(message) {
  if (!message?.text && !message?.photo) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (!isAllowedUser(message)) {
    await sendMessage(chatId, "你没有权限使用这个 bot。", messageId);
    return;
  }

  // 图片消息：下载后直接交给 Codex
  if (message.photo) {
    const text = (message.caption || "请分析这张图片").trim();
    let imagePath;
    try {
      imagePath = await downloadTelegramPhoto(message.photo);
    } catch (e) {
      await sendMessage(chatId, `图片下载失败：${e.message}`, messageId);
      return;
    }
    await runCodexJob(chatId, messageId, text, imagePath);
    return;
  }

  const text = message.text.trim();

  if (text === "/start") {
    await sendMessage(
      chatId,
      [
        "已连接本机 Codex CLI。",
        "直接发自然语言任务即可，例如：",
        "在当前仓库实现一个移动端聊天窗口组件，并接入现有 demo 页面，完成后告诉我手机如何预览。",
        "",
        "可用命令：",
        `/pwd — 查看当前工作目录（默认：${CODEX_WORKDIR}）`,
        "/cd <路径> — 切换工作目录",
        "/ctx — 查看持久化指令上下文",
        "/ctx <内容> — 设置持久化指令上下文",
        "/clearctx — 清空持久化指令上下文",
        "/stop — 停止当前任务",
      ].join("\n"),
      messageId
    );
    return;
  }

  if (text === "/pwd") {
    await sendMessage(chatId, `当前工作目录：${getChatWorkdir(chatId)}`, messageId);
    return;
  }

  if (text.startsWith("/cd ")) {
    const newDir = text.slice(4).trim();
    if (!newDir) {
      await sendMessage(chatId, "用法：/cd <路径>", messageId);
      return;
    }
    if (!isExistingDirectory(newDir)) {
      await sendMessage(chatId, `路径不存在或不是目录：${newDir}`, messageId);
      return;
    }
    setChatState(chatId, { workdir: newDir });
    await sendMessage(chatId, `工作目录已切换为：${newDir}`, messageId);
    return;
  }

  if (text === "/ctx") {
    const context = getInstructionContext(chatId);
    await sendMessage(
      chatId,
      context ? `当前持久化指令上下文：\n${safeText(context, 3000)}` : "当前没有持久化指令上下文。",
      messageId
    );
    return;
  }

  if (text.startsWith("/ctx ")) {
    const context = text.slice(5).trim();
    if (!context) {
      await sendMessage(chatId, "用法：/ctx <内容>", messageId);
      return;
    }
    setChatState(chatId, { instructionContext: context });
    await sendMessage(chatId, "持久化指令上下文已更新。", messageId);
    return;
  }

  if (text === "/clearctx") {
    setChatState(chatId, { instructionContext: "" });
    await sendMessage(chatId, "持久化指令上下文已清空。", messageId);
    return;
  }

  if (text === "/stop") {
    const job = runningJobs.get(chatId);
    if (!job) {
      await sendMessage(chatId, "当前没有运行中的任务。", messageId);
      return;
    }

    job.child.kill("SIGTERM");
    runningJobs.delete(chatId);
    await sendMessage(chatId, "已停止当前任务。", messageId);
    return;
  }

  await runCodexJob(chatId, messageId, text);
}

/**
 * 本地轮询 Telegram
 */
async function pollOnce() {
  const result = await tg("getUpdates", {
    offset,
    timeout: 20,
    allowed_updates: ["message"],
  });

  for (const update of result) {
    offset = update.update_id + 1;

    try {
      if (update.message) {
        await handleMessage(update.message);
      }
    } catch (e) {
      console.error("handle update error:", e);
    }
  }
}

async function startPolling() {
  if (polling) return;
  polling = true;

  console.log("Bot is running with getUpdates polling...");
  console.log("CODEX_WORKDIR =", CODEX_WORKDIR);

  let backoff = POLL_INTERVAL_MS;

  while (true) {
    try {
      await pollOnce();
      backoff = POLL_INTERVAL_MS; // reset on success
    } catch (e) {
      const isNetwork = e.code === 'ECONNRESET' || e.cause?.code === 'ECONNRESET' || e.name === 'AbortError';
      if (isNetwork) {
        backoff = Math.min(backoff * 2, 30000);
        console.error(`poll network error (retrying in ${backoff}ms):`, describeError(e));
      } else {
        backoff = POLL_INTERVAL_MS;
        console.error("poll error:", describeError(e));
      }
    }

    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
}

startPolling().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
