import { emitKeypressEvents, type Key } from "node:readline";

export async function selectWorkflows(
  available: readonly string[],
  terminal: {
    input: NodeJS.ReadStream;
    output: NodeJS.WriteStream;
  } = { input: process.stdin, output: process.stderr },
): Promise<string[]> {
  const workflows = [...new Set(available)].sort();
  if (workflows.length === 0) throw new Error("workflow-unavailable");
  const { input, output } = terminal;
  if (!input.isTTY || !output.isTTY)
    throw new Error("workflow-selection-requires-terminal");
  const selected = new Set(workflows);
  let cursor = 0;
  let painted = 0;
  let message = "";
  const render = () => {
    const height = Math.max(1, (output.rows || 24) - 6);
    const start = Math.max(
      0,
      Math.min(cursor - height + 1, workflows.length - height),
    );
    const visible = workflows.slice(start, start + height);
    const lines = [
      "Choose workflows to connect to Zapier",
      "↑/↓ Move · Space Toggle · A Select all/none · Enter Connect · Esc Cancel",
      ...visible.map(
        (id, index) =>
          `${start + index === cursor ? ">" : " "} [${selected.has(id) ? "x" : " "}] ${id.replace(/[\x00-\x1f\x7f]/g, "")}`,
      ),
      message || `${selected.size} of ${workflows.length} workflows selected`,
    ];
    output.write(
      `${painted ? `\x1b[${painted}A` : ""}\r\x1b[J${lines.join("\n")}\n`,
    );
    painted = lines.length;
  };
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  output.write("\x1b[?25l");
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const cleanup = () => {
        input.off("keypress", keypress);
        input.off("end", cancel);
        process.off("SIGTERM", cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("workflow-selection-cancelled"));
      };
      const keypress = (_value: string, key: Key) => {
        message = "";
        if (key.name === "escape" || (key.ctrl && key.name === "c"))
          return cancel();
        if (key.name === "up")
          cursor = (cursor + workflows.length - 1) % workflows.length;
        if (key.name === "down") cursor = (cursor + 1) % workflows.length;
        if (key.name === "space") {
          const id = workflows[cursor]!;
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
        }
        if (key.name === "a") {
          if (selected.size === workflows.length) selected.clear();
          else for (const id of workflows) selected.add(id);
        }
        if (key.name === "return" || key.name === "enter") {
          if (selected.size > 0) {
            cleanup();
            resolve(workflows.filter((id) => selected.has(id)));
            return;
          }
          message = "Select at least one workflow.";
        }
        render();
      };
      input.on("keypress", keypress);
      input.once("end", cancel);
      process.once("SIGTERM", cancel);
      input.resume();
      render();
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    output.write("\x1b[?25h");
  }
}
