export const POSIX_SUPERVISOR_SIDECAR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
let child = null;
let stopping = false;
let nonce = null;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const terminate = () => {
  if (stopping) return;
  stopping = true;
  if (!child || !child.pid) return process.exit(0);
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
    if (error && error.code !== "ESRCH") send({ type: "diagnostic", message: String(error.message || error) });
  }
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error && error.code !== "ESRCH") send({ type: "diagnostic", message: String(error.message || error) });
    }
  }, 3000);
};
const exitAfterGroupCleanup = (code, signal) => {
  const cleaned = () => {
    send({ type: "cleaned", code, signal });
    process.exit(0);
  };
  if (!child || !child.pid) return cleaned();
  const group = -child.pid;
  const deadline = Date.now() + 3000;
  const poll = () => {
    try { process.kill(group, 0); } catch (error) {
      if (error && error.code === "ESRCH") return cleaned();
    }
    if (Date.now() >= deadline) {
      try { process.kill(group, "SIGKILL"); } catch (error) {
        if (error && error.code !== "ESRCH") send({ type: "diagnostic", message: String(error.message || error) });
      }
      return setTimeout(() => {
        try {
          process.kill(group, 0);
          send({ type: "diagnostic", message: "Process group cleanup could not be verified" });
          process.exit(1);
        } catch (error) {
          if (error && error.code === "ESRCH") return cleaned();
          send({ type: "diagnostic", message: String(error.message || error) });
          process.exit(1);
        }
      }, 100);
    }
    setTimeout(poll, 50);
  };
  try { process.kill(group, "SIGTERM"); } catch (error) {
    if (error && error.code === "ESRCH") return cleaned();
  }
  poll();
};
process.stdin.on("end", terminate);
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return send({ type: "error", message: "Invalid supervisor command" }); }
  if (message.type === "stop") {
    if (!nonce || message.nonce !== nonce) return send({ type: "error", message: "Supervisor capability rejected" });
    return terminate();
  }
  if (message.type !== "start" || child) return send({ type: "error", message: "Unexpected supervisor command" });
  if (typeof message.nonce !== "string" || !/^[a-f0-9]{64}$/.test(message.nonce)) {
    return send({ type: "error", message: "Supervisor capability rejected" });
  }
  nonce = message.nonce;
  try {
    child = spawn(message.command, message.args, {
      cwd: message.cwd,
      env: message.environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    send({ type: "error", message: String(error.message || error) });
    return process.exit(1);
  }
  child.stdout.on("data", (chunk) => send({ type: "log", stream: "stdout", data: chunk.toString("base64") }));
  child.stderr.on("data", (chunk) => send({ type: "log", stream: "stderr", data: chunk.toString("base64") }));
  child.once("error", (error) => send({ type: "error", message: String(error.message || error) }));
  child.once("spawn", () => send({ type: "started", pid: child.pid }));
  child.once("exit", (code, signal) => {
    exitAfterGroupCleanup(code, signal);
  });
});
send({ type: "ready", pid: process.pid });
`;
