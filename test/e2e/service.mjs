import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const { scene, withoutChildren } = await import(
  pathToFileURL(join(process.cwd(), "test/self-host-fixture.ts"))
);
await withoutChildren(async () => {
  const fixture = await scene();
  const folder = join(fixture.repository, ".cloving", "workflows");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "develop.ts"),
    'import { sleep } from "cloving/workflows/steps/sleep";\nexport async function develop() {\n  "use workflow";\n  await sleep({ seconds: 1 });\n  return { kind: "handoff_requested" };\n}\n',
  );
  await writeFile(
    join(folder, "develop.declaration.json"),
    JSON.stringify({
      workflow: {
        workflowId: "develop",
        effectLimit: 1,
        capabilities: ["claude"],
        input: { maximumBytes: 4096, fields: { prompt: { type: "string" } } },
      },
      methods: { claude: ["run-turn"] },
    }),
  );
  await fixture.start({
    CLOVING_PHONE_RELAY: "off",
    CLOVING_HOST_BOUND: "8",
    CLOVING_SELF_UPDATE_SECONDS: undefined,
  });
  process.stdout.write(
    JSON.stringify({ runtime: fixture.runtimeDirectory }) + "\n",
  );
  await new Promise((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
});
