import { spawn } from "node:child_process";
import { once } from "node:events";

const bridge = `
import errno, os, pty, select, sys
child, terminal = pty.fork()
if child == 0:
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    ready, _, _ = select.select([terminal, 0], [], [])
    try:
        if terminal in ready:
            data = os.read(terminal, 65536)
            if not data: break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if data: os.write(terminal, data)
    except OSError as error:
        if error.errno == errno.EIO: break
        raise
_, status = os.waitpid(child, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export async function terminalConnect(executable, args, env, pairingCode) {
  const child = spawn("/usr/bin/python3", ["-c", bridge, executable, ...args], {
    env: { ...env, TERM: "xterm" },
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  let confirmed = false;
  let approved = false;
  child.stdout.on("data", (data) => {
    stdout += data.toString();
    if (!confirmed && stdout.includes("workflows selected")) {
      confirmed = true;
      child.stdin.write("\r");
    }
    if (
      !approved &&
      pairingCode &&
      stdout.includes("Pairing code from Zapier: ")
    ) {
      approved = true;
      child.stdin.write(pairingCode + "\n");
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  try {
    const [code] = await once(child, "close", {
      signal: AbortSignal.timeout(20000),
    });
    if (code !== 0)
      throw new Error(`terminal connect failed: ${stdout}\n${stderr}`);
    return stdout;
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
