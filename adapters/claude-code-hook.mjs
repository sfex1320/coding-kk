const agentUrl = process.env.CODESTATUS_AGENT_URL || "http://127.0.0.1:4317/events";

let payload = {};

try {
  const input = await readStdin();
  payload = input ? JSON.parse(input) : {};
} catch (error) {
  console.error(`[CodeStatus] Failed to parse hook payload: ${error.message}`);
}

try {
  await fetch(agentUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      raw: payload,
      source: "claude-code"
    })
  });
} catch (error) {
  console.error(`[CodeStatus] Failed to forward hook payload: ${error.message}`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
