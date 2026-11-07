import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import { join, relative } from "node:path";
import net from "node:net";
import { object, type LocalPorts } from "./local.js";

export class Store {
  constructor(readonly directory: string) {}

  private path(key: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key))
      throw new Error("record-name-invalid");
    return join(this.directory, `${key}.json`);
  }

  async read(key: string): Promise<Record<string, unknown> | undefined> {
    try {
      return object(JSON.parse(await readFile(this.path(key), "utf8")));
    } catch (error) {
      if (object(error).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const path = this.path(key);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async records(): Promise<[string, Record<string, unknown>][]> {
    const files = await readdir(this.directory).catch((error: unknown) => {
      if (object(error).code === "ENOENT") return [];
      throw error;
    });
    const records: [string, Record<string, unknown>][] = [];
    for (const file of files.filter((name) =>
      /^[A-Za-z0-9_-]+\.json$/.test(name),
    )) {
      const key = file.slice(0, -5);
      const value = await this.read(key);
      if (value !== undefined) records.push([key, value]);
    }
    return records;
  }
}

export const serviceRequest: (
  directory: string,
  request: Parameters<LocalPorts["send"]>[0],
) => ReturnType<LocalPorts["send"]> = (directory, request) => {
  const absolute = join(directory, "control.sock");
  const path = [absolute, relative(process.cwd(), absolute)]
    .filter(Boolean)
    .sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b))[0]!;
  if (Buffer.byteLength(path) > 103)
    return Promise.reject(new Error("runtime-path-too-long"));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path });
    let buffered = "";
    const fail = () => {
      socket.destroy();
      reject(new Error("service-unavailable"));
    };
    socket.setTimeout(10000, fail);
    socket.once("error", fail);
    socket.once("connect", () =>
      socket.write(JSON.stringify({ protocol: 1, ...request }) + "\n"),
    );
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      if (Buffer.byteLength(buffered) > 1048576) return fail();
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      try {
        resolve(object(JSON.parse(buffered.slice(0, end))));
      } catch {
        reject(new Error("service-response-invalid"));
      }
      socket.destroy();
    });
    socket.once("close", () => reject(new Error("service-unavailable")));
  });
};
