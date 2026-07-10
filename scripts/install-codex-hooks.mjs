import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookScript = path.join(projectRoot, "adapters", "codex-hook.mjs");
const hooksDir = path.join(os.homedir(), ".codex");
const hooksPath = path.join(hooksDir, "hooks.json");
const command = `node "${hookScript}"`;

const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop"
];

fs.mkdirSync(hooksDir, { recursive: true });

let config = { hooks: {} };
if (fs.existsSync(hooksPath)) {
  const existing = fs.readFileSync(hooksPath, "utf8");
  config = existing.trim() ? JSON.parse(existing) : { hooks: {} };
  const backupPath = `${hooksPath}.codestatus-backup-${timestamp()}`;
  fs.writeFileSync(backupPath, existing, "utf8");
  console.log(`Backed up existing hooks to ${backupPath}`);
}

config.hooks = config.hooks || {};

for (const event of events) {
  config.hooks[event] = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
  config.hooks[event] = config.hooks[event]
    .map((entry) => ({
      ...entry,
      hooks: Array.isArray(entry?.hooks)
        ? entry.hooks.filter((hook) => !String(hook?.command || "").includes("codex-hook.mjs"))
        : []
    }))
    .filter((entry) => entry.hooks.length > 0);

  config.hooks[event].push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command,
        commandWindows: command,
        timeout: 30,
        statusMessage: "Sending CodeStatus update"
      }
    ]
  });
}

fs.writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log(`Installed CodeStatus Codex hooks in ${hooksPath}`);
console.log(`Hook command: ${command}`);
console.log("Open /hooks in Codex and trust the new hook before it can run.");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

