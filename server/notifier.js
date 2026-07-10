import net from "node:net";
import tls from "node:tls";

// 推送设置默认值（settings.notify）
export const DEFAULT_NOTIFY_SETTINGS = {
  enabled: true,
  // 哪些状态变化时推送
  states: ["completed", "failed", "waiting_permission", "waiting_user"],
  // 同一实例同一状态的最小推送间隔，防止刷屏
  cooldownSeconds: 60,
  serverchan: { enabled: false, sendKey: "" },
  pushplus: { enabled: false, token: "" },
  email: { enabled: false, host: "smtp.qq.com", port: 465, user: "", pass: "", to: "" }
};

// 深合并存量设置与默认值，保证新增字段有默认值
export function mergeNotifySettings(base = {}, incoming = {}) {
  const defaults = DEFAULT_NOTIFY_SETTINGS;
  return {
    ...defaults,
    ...base,
    ...incoming,
    states: Array.isArray(incoming.states) ? incoming.states : Array.isArray(base.states) ? base.states : defaults.states,
    serverchan: { ...defaults.serverchan, ...(base.serverchan || {}), ...(incoming.serverchan || {}) },
    pushplus: { ...defaults.pushplus, ...(base.pushplus || {}), ...(incoming.pushplus || {}) },
    email: { ...defaults.email, ...(base.email || {}), ...(incoming.email || {}) }
  };
}

const stateLabels = {
  completed: "任务完成",
  failed: "出现问题",
  waiting_permission: "等待授权",
  waiting_user: "等待输入",
  paused: "已暂停"
};

const lastSentByInstance = new Map();

// 状态发生变化时决定是否推送；由 server 的 ingest() 调用
export function maybeNotify(event, prevState, settings) {
  const notify = mergeNotifySettings(settings?.notify);
  if (!notify.enabled) return;
  if (!notify.states.includes(event.state)) return;
  if (prevState === event.state) return; // 只在状态跳变时推送

  const key = `${event.instanceId}::${event.state}`;
  const now = Date.now();
  const last = lastSentByInstance.get(key) || 0;
  if (now - last < Math.max(10, Number(notify.cooldownSeconds) || 60) * 1000) return;
  lastSentByInstance.set(key, now);
  if (lastSentByInstance.size > 500) {
    lastSentByInstance.delete(lastSentByInstance.keys().next().value);
  }

  const { title, body } = composeMessage(event, settings);
  dispatch(notify, title, body).then((results) => {
    for (const result of results) {
      if (!result.ok) console.warn(`[notify] ${result.channel} 推送失败：${result.error}`);
    }
  });
}

function composeMessage(event, settings) {
  const stateText = stateLabels[event.state] || event.state;
  const name = event.sourceLabel || event.source || "编码工具";
  const privacy = Boolean(settings?.privacyMode);
  const project = !privacy && event.projectName ? ` · ${event.projectName}` : "";
  const title = `${name}${project} ${stateText}`;
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  const lines = privacy
    ? [`${name}：${stateText}`, `时间：${time}`]
    : [
        event.message || "",
        event.workspace ? `工作区：${event.workspace}` : "",
        event.model ? `模型：${event.model}` : "",
        `时间：${time}`
      ];
  return { title, body: lines.filter(Boolean).join("\n") };
}

// 群发所有启用的渠道，返回每个渠道的结果（也供“发送测试”用）
export async function dispatch(notify, title, body) {
  const jobs = [];
  if (notify.serverchan?.enabled && notify.serverchan.sendKey) {
    jobs.push(run("serverchan", () => sendServerChan(notify.serverchan.sendKey, title, body)));
  }
  if (notify.pushplus?.enabled && notify.pushplus.token) {
    jobs.push(run("pushplus", () => sendPushPlus(notify.pushplus.token, title, body)));
  }
  if (notify.email?.enabled && notify.email.user) {
    jobs.push(run("email", () => sendEmail(notify.email, title, body)));
  }
  if (!jobs.length) return [{ channel: "none", ok: false, error: "没有启用任何推送渠道" }];
  return Promise.all(jobs);
}

async function run(channel, fn) {
  try {
    await withTimeout(fn(), 20000, `${channel} 超时`);
    return { channel, ok: true };
  } catch (error) {
    return { channel, ok: false, error: error.message };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

// ---- Server酱（微信推送）----
// Turbo 版 key 走 sctapi.ftqq.com；Server酱3 的 key（sctp 开头）走 push.ft07.com
async function sendServerChan(sendKey, title, body) {
  const key = String(sendKey).trim();
  const match = key.match(/^sctp(\d+)t/i);
  const endpoint = match
    ? `https://${match[1]}.push.ft07.com/send/${key}.send`
    : `https://sctapi.ftqq.com/${key}.send`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: title.slice(0, 32), desp: body }).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code !== 0 && data.code !== undefined)) {
    throw new Error(data.message || data.info || `HTTP ${response.status}`);
  }
}

// ---- PushPlus（微信推送）----
async function sendPushPlus(token, title, body) {
  const response = await fetch("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: String(token).trim(), title: title.slice(0, 100), content: body, template: "txt" })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code !== 200 && data.code !== undefined)) {
    throw new Error(data.msg || `HTTP ${response.status}`);
  }
}

// ---- 邮件（极简 SMTP 客户端，465 隐式 TLS / 其他端口 STARTTLS）----
async function sendEmail(email, subject, body) {
  const host = String(email.host || "").trim();
  const port = Number(email.port) || 465;
  const user = String(email.user || "").trim();
  const pass = String(email.pass || "").trim();
  const to = String(email.to || user).trim();
  if (!host || !user || !pass) throw new Error("邮箱 SMTP 配置不完整");

  let session = await smtpOpen(host, port);
  try {
    await session.expect(220);
    let ehlo = await session.command(`EHLO codestatus.local`, 250);

    if (port !== 465 && /STARTTLS/i.test(ehlo)) {
      await session.command("STARTTLS", 220);
      session = await session.upgradeTls(host);
      await session.command(`EHLO codestatus.local`, 250);
    }

    await session.command("AUTH LOGIN", 334);
    await session.command(Buffer.from(user).toString("base64"), 334);
    await session.command(Buffer.from(pass).toString("base64"), 235);
    await session.command(`MAIL FROM:<${user}>`, 250);
    for (const rcpt of to.split(/[,;，；\s]+/).filter(Boolean)) {
      await session.command(`RCPT TO:<${rcpt}>`, 250);
    }
    await session.command("DATA", 354);
    await session.command(buildMime(user, to, subject, body) + "\r\n.", 250);
    await session.command("QUIT", 221).catch(() => {});
  } finally {
    session.destroy();
  }
}

function buildMime(from, to, subject, body) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const encodedBody = Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: =?UTF-8?B?${Buffer.from("CodeStatus").toString("base64")}?= <${from}>`,
    `To: <${to.split(/[,;，；\s]+/).filter(Boolean).join(">, <")}>`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    `Date: ${new Date().toUTCString()}`,
    "",
    encodedBody
  ].join("\r\n");
}

function smtpOpen(host, port) {
  return new Promise((resolve, reject) => {
    const socket =
      port === 465
        ? tls.connect({ host, port, servername: host }, () => resolve(wrapSmtpSocket(socket)))
        : net.connect({ host, port }, () => resolve(wrapSmtpSocket(socket)));
    socket.once("error", reject);
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error("SMTP 连接超时"));
    });
  });
}

// 把 socket 包装成顺序化的「命令-应答」会话
function wrapSmtpSocket(socket) {
  let buffer = "";
  let pending = null;

  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    deliver();
  };
  const onError = (error) => {
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(error);
    }
  };
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", () => onError(new Error("SMTP 连接已关闭")));

  function deliver() {
    if (!pending) return;
    const lines = buffer.split("\r\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\d{3} /.test(lines[i])) {
        const consumed = lines.slice(0, i + 1).join("\r\n") + "\r\n";
        buffer = buffer.slice(consumed.length);
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.resolve(consumed.trim());
        return;
      }
    }
  }

  function read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error("SMTP 应答超时"));
      }, 15000);
      pending = { resolve, reject, timer };
      deliver();
    });
  }

  async function expect(code) {
    const reply = await read();
    if (!reply.startsWith(String(code))) throw new Error(`SMTP：${reply.split("\r\n").at(-1)}`);
    return reply;
  }

  return {
    expect,
    async command(text, code) {
      socket.write(text + "\r\n");
      return expect(code);
    },
    upgradeTls(host) {
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      return new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: host }, () => resolve(wrapSmtpSocket(secure)));
        secure.once("error", reject);
      });
    },
    destroy() {
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
    }
  };
}
