import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { Store, serviceRequest } from "../dist/runtime.js";

test("admission records survive reopening in private files and unsafe record names are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloving-zapier-test-"));
  try {
    const directory = join(root, "state");
    const store = new Store(directory);
    await store.write("request-1", { runId: "run-1" });
    assert.deepEqual(await new Store(directory).read("request-1"), {
      runId: "run-1",
    });
    assert.equal(
      (await stat(join(directory, "request-1.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await assert.rejects(store.write("../outside", {}), /record-name-invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the adapter sends the Cloving protocol over its local control socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "cz-"));
  const server = createServer((socket) =>
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString());
      assert.equal(request.protocol, 1);
      assert.equal(request.operation, "status");
      socket.end(
        JSON.stringify({ ok: true, result: { workflows: ["develop"] } }) + "\n",
      );
    }),
  );
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(root, "control.sock"), resolve);
    });
    assert.deepEqual(
      await serviceRequest(root, { operation: "status", parameters: {} }),
      { ok: true, result: { workflows: ["develop"] } },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
