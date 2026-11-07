import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { selectWorkflows } from "../dist/selection.js";

function terminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value) => {
    input.isRaw = value;
    return input;
  };
  const output = new PassThrough();
  output.isTTY = true;
  output.rows = 12;
  let text = "";
  output.on("data", (data) => {
    text += data.toString();
  });
  return { input, output, text: () => text };
}

test("the workflow selector starts with every discovered workflow selected and waits for confirmation", async () => {
  const io = terminal();
  const pending = selectWorkflows(["review-day", "develop", "develop"], io);
  assert.match(io.text(), /\[x\] develop/);
  assert.match(io.text(), /\[x\] review-day/);
  io.input.write("\r");
  assert.deepEqual(await pending, ["develop", "review-day"]);
  assert.equal(io.input.isRaw, false);
});

test("arrow keys and space restrict the connection to the selected workflows", async () => {
  const io = terminal();
  const pending = selectWorkflows(["develop", "review-day", "triage"], io);
  io.input.write(" \u001b[B\u001b[B \r");
  assert.deepEqual(await pending, ["review-day"]);
});

test("select all can be toggled and an empty selection cannot be confirmed", async () => {
  const io = terminal();
  const pending = selectWorkflows(["develop", "triage"], io);
  io.input.write("a\r");
  assert.match(io.text(), /Select at least one workflow/);
  io.input.write("a\r");
  assert.deepEqual(await pending, ["develop", "triage"]);
});

test("cancelling restores the terminal and grants no workflow access", async () => {
  const io = terminal();
  const pending = selectWorkflows(["develop"], io);
  io.input.write("\u0003");
  await assert.rejects(pending, /workflow-selection-cancelled/);
  assert.equal(io.input.isRaw, false);
  assert.match(io.text(), /\u001b\[\?25h/);
});

test("selection needs a terminal and at least one available workflow", async () => {
  await assert.rejects(selectWorkflows([], terminal()), /workflow-unavailable/);
  const io = terminal();
  io.input.isTTY = false;
  await assert.rejects(
    selectWorkflows(["develop"], io),
    /workflow-selection-requires-terminal/,
  );
  assert.equal(io.input.isRaw, false);
});
