import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookScript = path.join(projectRoot, "adapters", "claude-code-hook.mjs");
const settingsDir = path.join(os.homedir(), ".claude");
const settingsPath = path.join(settingsDir, "settings.json");
const command = `node "${hookScript}"`;

const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "CwdChanged",
  "FileChanged",
  "ConfigChange"
];

fs.mkdirSync(settingsDir, { recursive: true });

let settings = {};
if (fs.existsSync(settingsPath)) {
  const existing = fs.readFileSync(settingsPath, "utf8");
  settings = existing.trim() ? JSON.parse(existing) : {};
  const backupPath = `${settingsPath}.codestatus-backup-${timestamp()}`;
  fs.writeFileSync(backupPath, existing, "utf8");
  console.log(`Backed up existing settings to ${backupPath}`);
}

settings.hooks = settings.hooks || {};

for (const event of events) {
  settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  settings.hooks[event] = settings.hooks[event]
    .map((entry) => ({
      ...entry,
      hooks: Array.isArray(entry?.hooks)
        ? entry.hooks.filter((hook) => !String(hook?.command || "").includes("claude-code-hook.mjs"))
        : []
    }))
    .filter((entry) => entry.hooks.length > 0);

  const hasCommand = settings.hooks[event].some((entry) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook?.type === "command" && hook?.command === command)
  );

  if (!hasCommand) {
    settings.hooks[event].push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command
        }
      ]
    });
  }
}

fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

console.log(`Installed CodeStatus Claude Code hooks in ${settingsPath}`);
console.log(`Hook command: ${command}`);

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
