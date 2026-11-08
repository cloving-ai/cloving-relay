# Cloving Relay: encrypted MCP and Zapier

Start local Cloving workflows and read their state through an encrypted relay.
Zapier and your computer encrypt, decrypt, and verify messages. `cloving-app`
stores ciphertext and routing metadata; it has no workflow decryption keys.

The installable package is named `cloving-relay`. Its source and release downloads
are public at [cloving-ai/cloving-relay](https://github.com/cloving-ai/cloving-relay). It provides the
`cloving-mcp` and `cloving-zapier` commands used by the Cloving CLI. The
Zapier OAuth client ID remains unchanged.

## Components

- `src/index.ts`: Zapier Platform integration, targeting Node 22.
- `src/cli.ts`: local enrollment and polling adapter, using Cloving's control socket.
- `src/protocol.ts`: signed HPKE with P-256, HKDF-SHA256, and AES-256-GCM; padded messages.
- The sibling `cloving-app` changes add dedicated automation connections and mailboxes.
- The sibling `cloving` changes add the `cloving integrations` command.

The integration provides Start Workflow, Get Workflow Run, Workflow Run State
Changed, and a dropdown populated from the locally permitted workflows. String
and ticket inputs have individual fields; Input JSON supports other declared
input types. The local Cloving service validates the complete input contract.

## Build and install locally

Use Node 22.23.1 or later. Test the Zapier code on Node 22.

```sh
npm ci --ignore-scripts
npm run check
npm pack --ignore-scripts
npm install --global ./cloving-relay-2.0.1.tgz --ignore-scripts
```

### Updating from cloving-zapier 2.0.0

Existing installations continue to work. The rename does not require an upgrade.
To install the new package in place of the old one, first run
`npm uninstall --global cloving-zapier`, then install the new tarball as above.
Saved connections remain in their private state directories. Pair MCP again
and replace the harness configuration with the newly printed configuration: it
contains absolute executable paths that change with the package name.

## Connect Zapier

Run the updated Cloving CLI from the repository whose workflows you want to
expose. Start its service first. The Rails relay must have the new migrations
and the automation controllers deployed before connecting.

```sh
cloving start
cloving integrations connect zapier
```

The terminal lists the workflows discovered in the running local service, with
all workflows selected. Use the arrow keys to move, Space to toggle a workflow,
A to select all or none, and Enter to confirm. Escape or Ctrl+C cancels without
registering a connection. The selection grants access to the workflows shown
at that moment; newly added workflows require connecting again.
For scripts, pass `--workflow NAME` repeatedly to choose explicitly without a
prompt. `--name "My computer"` sets the label shown during OAuth sign-in.

Setup explains each step and opens the linking page in your browser. Sign in
to cloving.ai and click **Link computer**. An open Zapier authorization window
updates automatically as soon as linking finishes. Choose the linked computer
and click **Authorize Zapier**. Use `--no-open` to open the printed link yourself.
For automation, `--json` returns the enrollment data without opening a browser.
OAuth uses an authorization code with S256 PKCE and
rotating refresh tokens; no credential copying is needed.

The Zapier account connection label shows a pairing code. Read that code from
Zapier, then run:

```sh
cloving integrations approve zapier
cloving integrations serve zapier
```

Approval finds the pending connection and asks you to paste its pairing code.
If there are several pending connections, it asks you to choose one. Scripts
can use `approve zapier CONNECTION_ID --pairing-code CODE_FROM_ZAPIER --json`.
`list zapier` shows readable connection status; add `--json` for structured data.
Run these commands from the same project folder used during setup. If no local
service is available, the command explains how to start it with `cloving start`.

Approval verifies the code against both endpoints' public keys before granting
local access. An incorrect code changes no local permissions. The relay cannot
approve a connection on your computer. Each connection is bound to one local
runtime and its explicit workflow grant. The adapter must remain running; it
can be supervised alongside `cloving start`.

The hosted Zapier app signs in through cloving.ai. A self-hosted OAuth deployment
requires configuring the integration's origin and its registered redirect URI;
the local adapter accepts `--origin` (HTTPS, or loopback HTTP for development).
The Zapier adapter command `cloving-zapier` also accepts
`--runtime-dir /absolute/path/to/run`. `--state-dir` overrides private storage.

```sh
cloving integrations list zapier --json
cloving integrations remove zapier CONNECTION_ID
```

Removal first revokes the local grant, then deletes queued relay data and
disables its token. If the relay is unavailable, the local revocation persists;
repeat removal when it becomes available to finish the remote cleanup. Revoke
and reconnect to change permissions or rotate keys. Already delivered data in
Zapier remains subject to Zapier's retention.

## Zap behavior

Map a stable source event ID into **Request Key**. Retrying that key returns the
original run. Reusing it with different workflow inputs is refused. Different
events must have different keys, even when their inputs are identical.

Start Workflow returns `request_id`, `delivery_status: queued`, and `expires_at`.
Only a signed local receipt changes the delivery status to `admitted` and
provides `run_id`. Queueing does not mean that a workflow has started. A request
expires after 60 seconds; an offline computer will not execute it hours later.
Get Workflow Run accepts either the request ID or run ID. A pending response
means no signed receipt is available; compare it with the start step's expiry.

State includes run/workflow IDs, status, revision, current step when available,
and `observed_at`. Cached state remains readable when the computer is offline.
Full prompts, transcripts, raw execution results, and approval controls are not
exported. Completed, failed, and cancelled runs stop polling. State and catalog
snapshots replace their older ciphertext; events and cached state expire after
seven days. Admission receipts remain locally for duplicate prevention.

The polling trigger follows all available pages, newest first, using a unique
ID per state revision. It fails explicitly if reading the retained history
exceeds its 20-second catch-up budget. A very large event history can require a
fresh connection or waiting for retention cleanup; it never silently skips an
older page. Polling cadence is controlled by Zapier.

## Privacy boundary

Zapier has the dedicated client private keys and can read the inputs and state
used in Zaps. Your computer keeps its own private keys and enforces permissions.
OAuth creates the client keys inside Zapier. Local pairing verifies a code
binding both endpoints' public keys, the connection, and the relay origin;
this pins the peers independently of the relay. Neither the encryption
credential nor a private key is sent to `cloving-app`. OAuth tokens grant
access only to that connection's mailbox, not to the rest of your Cloving
account. Access tokens expire after an hour; refresh tokens rotate on use,
expire after 90 days, and revoke the connection if an old token is replayed.

The relay sees public keys, opaque connection/message/slot IDs, channels,
timestamps, and padded message sizes. It can delay or drop messages. Signatures,
connection bindings, expiry checks, and local command IDs prevent it from
forging an authorized workflow submission. Endpoint or integration-code
compromise is outside this relay/database protection.

Requests and responses use separate authenticated directions. Transport tokens
allow only that connection's mailbox operations and are stored as digests.
Requests are acknowledged only after local processing and durable receipt
storage. Invalid ciphertext is discarded individually; transient service or
transport failures preserve the request for retry. Workflow approval operations
are never admitted through the Zapier adapter.

## Encrypted MCP bridge

The package also installs `cloving-mcp`. It speaks MCP over standard input/output
alongside your harness and encrypts calls before they reach the relay. The
workflow computer decrypts them and enforces its local workflow and tool grants.
The relay never receives plaintext tool arguments or results. `/mcp` on the
Cloving site is a setup guide, rather than a standard HTTP MCP endpoint.

On the workflow computer, start Cloving in your project, then run:

```sh
cloving integrations connect mcp
```

All currently discovered workflows start selected. Confirm or change them in
the terminal, open the printed link, and click **Link computer**. On the machine
where your MCP harness runs, pair a separate connection for that harness:

```sh
cloving integrations pair mcp --name studio
```

Sign in, choose the linked MCP computer, and click **Authorize MCP**. The harness
terminal prints a pairing code. On the workflow computer, run:

```sh
cloving integrations approve mcp
cloving integrations serve mcp
```

Paste that pairing code at the approval prompt. Keep `serve` running on the
workflow computer. It connects outward to the relay; no inbound port is needed
on that computer. Configure a harness that supports local MCP processes:

```json
{
  "mcpServers": {
    "cloving": {
      "command": "cloving-mcp",
      "args": ["--connection", "studio"]
    }
  }
}
```

`cloving mcp --connection studio` launches the same bridge. Use the full path
to the installed executable if the harness has a different PATH. Pairing prints
configuration with the full Node and bridge paths and the resolved private
state directory, so the harness can use a different PATH or working directory. Client credentials
default to `$XDG_STATE_HOME/cloving/mcp/clients`, or
`~/.local/state/cloving/mcp/clients`, with private directories and mode 0600 files.
`CLOVING_MCP_STATE_DIR` overrides this base directory. Host grants remain in the
selected project's private `state/mcp` directory, separately from Zapier.
For a headless harness machine, forward its printed loopback callback port to
your browser machine before completing sign-in. `--no-open` prints the link.

The bridge supports MCP `2026-07-28` stateless discovery and legacy initialization
versions `2025-11-25`, `2025-06-18`, and `2025-03-26`. Its default tools are
`cloving_workflows`, `cloving_run`, `cloving_status`, `cloving_questions`, and
`cloving_events`. Discovery returns input fields so the harness can choose a
workflow without asking you to remember its name. Event and run lists accept
bounded `limit` and `after` parameters; run results include a `next` cursor.
Reads of runs outside the selected workflows are refused.

Additional tools require flags during host setup: `--allow-control` grants
pause/resume/drop; `--allow-answer` grants question answers; `--allow-approvals`
grants approve/deny. Decision calls require the exact run, decision reference,
revision, generation, and subject digest returned by `cloving_questions`.
Changing permissions requires a new pairing; additions to the project workflow
catalog are not implicitly granted.

Mutations require a stable `commandId`. Retry a lost reply with the same ID and
arguments; changed arguments conflict. Pending native commands are recorded
before submission so a bridge restart can recover their original receipts.
Requests expire after at most 60 seconds, normally 30. Offline reads return an
error rather than pretending to have live state. Cancelling a tool request stops
waiting for its reply; it does not retract an already queued or admitted command.
Use the explicit run controls when granted. Oversized results return
`result-too-large`; request fewer records. Replies are limited to 16 KiB before
encryption wrapping. A run scan that exceeds its local work budget returns
`status-scan-limit-reached` rather than silently hiding later runs.

OAuth client tokens are bound to MCP and isolated from Zapier. Multiple bridge
processes sharing one saved connection coordinate token rotation under a local
SQLite lock and reload the rotated credential. An interrupted refresh is marked
locally; the old refresh token is never automatically replayed. Recover or remove
a saved harness connection with:

```sh
cloving integrations unpair mcp --name studio
cloving integrations pair mcp --name studio
```

Unpair revokes the server connection before removing its local credential.
The workflow computer can revoke a grant immediately with
`cloving integrations remove mcp CONNECTION_ID`. Relay revocation also removes
queued data. Data already delivered to a harness is subject to that harness's
retention. Each endpoint can read its workflow data; the relay sees routing
metadata, public keys, timestamps, and padded ciphertext sizes.

## Verification

```sh
npm run check
npx zapier-platform validate --without-style
```

End-to-end tests require the sibling `cloving` and `cloving-app` checkouts, their
installed dependencies, Node 26.9.0, and Ruby 4.0.9. Supply executable paths:

```sh
CLOVING_NODE26=/path/to/node26/bin/node \
CLOVING_RUBY=/path/to/ruby4/bin/ruby \
npm run test:e2e
```

The suite creates isolated SQLite databases and temporary local services. It
exercises the actual Zapier action functions, Rails HTTP relay, Cloving control
socket, duplicate/restart handling, permission refusal, state events, and
revocation. An interoperability test exchanges messages between the Node 22
HPKE implementation and Cloving's native encryption. It uses synthetic inputs
and keys and removes test services and temporary data afterward.

## Private Zapier release

The private [Cloving integration](https://developer.zapier.com/app/249365/versions)
is already registered. Version 2.0.0 introduces OAuth; version 1.0.1 used a
manually copied connection credential.
After deploying the Rails relay changes and installing the updated local CLI,
authenticate the Zapier CLI with the account that owns this integration. Use
`ZAPIER_DEPLOY_KEY` for a separate account without replacing an existing CLI login.
Keep that key outside this checkout. Then select Cloving when linking:

```sh
npx zapier-platform link
npx zapier-platform push
```

The initial version is private. Connect it to a test repository and run a real
Zap before inviting others. Keep deploy credentials out of this checkout.
Public listing and instant REST Hook triggers are later release work.

## Dependencies

Direct dependency versions are exact and committed in `package-lock.json`.
`@hpke/core` supplies maintained WebCrypto HPKE compatible with Zapier's Node 22
runtime. `zapier-platform-core` is Zapier's runtime/schema API. The CLI,
TypeScript compiler, and Node type definitions are development dependencies.
The local adapter uses Node's standard library for files, sockets, and HTTPS.
