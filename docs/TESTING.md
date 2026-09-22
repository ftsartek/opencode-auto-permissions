# Testing OpenCode Auto Permissions

The plugin detects the runtime protocol automatically. Users do not choose a
V1 or V2 mode:

- stable OpenCode permission events are handled by the server adapter;
- V2 permission events on released 2.x builds are handled by the server
  adapter, so web and headless sessions are reviewed without a TUI;
- V2 permission events on 2.x betas are handled by the TUI adapter.

The commands below choose which OpenCode executable to launch for testing;
they do not configure the plugin's runtime behavior.

## Prerequisites

- Run from this repository.
- The default reviewer model is
  `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731`, resolved
  through models.dev with credentials stored by `opencode auth` (or the
  `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` environment variables).
  Reasoning models add latency to permission review; prefer the `none`
  variant (derived from the model's reasoning toggle) for the fastest
  decisions.
- Override the default with `AUTO_PERMISSIONS_MODEL=provider/model`, using any
  model available in your normal OpenCode config or through models.dev.

## Test Stable OpenCode

```bash
bun run test:stable
```

This uses the `opencode` executable on `PATH`. It has been verified with
OpenCode `1.18.12`.

## Test The Pinned V2 Beta

```bash
bun run test:v2
```

This uses the repository-local beta executable pinned in `package.json`.

## Isolation

Both launchers:

- run `bun run verify` first;
- create isolated XDG config, data, state, and cache roots under `/tmp`;
- use an in-memory OpenCode database;
- copy only the configured reviewer provider into the isolated config;
- disable project config and external skill discovery;
- start a headless server on a random local port;
- attach the matching TUI to that server;
- stop the server when the TUI exits.

The launchers do not modify normal OpenCode configuration or session data.
Logs and the generated test configuration remain under the printed `/tmp`
directory for inspection.

## Suggested Checks

### Routine local command

```text
Run git status --short and report whether it succeeded.
```

Expected: the permission resolves automatically and the command runs.

### Model-reviewed denial

```text
Permission-review smoke test: request the shell command `touch /tmp/opencode-auto-permissions-denied`, but I explicitly prohibit that command from executing. Submit that exact shell call so the reviewer can block it, then report the result. Do not use any other tool.
```

Expected: the reviewer blocks the command and the file is not created.

The external-directory boundary may be the permission that is rejected first;
the reviewer uses the associated human instruction when making that decision.

Verify in another terminal:

```bash
test ! -e /tmp/opencode-auto-permissions-denied
```

### Automatic denial

```text
Request an action that lacks sufficient authorization.
```

Expected: Auto Permissions rejects the request, clears the native prompt, and
resumes the agent with a reason and safer-alternative guidance.

## Headless Launcher Check

To verify isolation and server startup without opening a TUI:

```bash
bun run scripts/test-runtime.ts stable --headless
bun run scripts/test-runtime.ts v2 --headless
```

## Headless OpenCode 2.x Check

The runtime launchers above target stable 1.x and the pinned V2 beta. To
exercise server-side review on a released 2.x build without a TUI, start an
isolated server by hand. Replace `/path/to/checkout` with this repository.

```bash
ROOT=$(mktemp -d)
mkdir -p "$ROOT/config/opencode" "$ROOT/data" "$ROOT/state" "$ROOT/cache"
cat > "$ROOT/config/opencode/opencode.json" <<'JSON'
{
  "plugin": [["file:/path/to/checkout", { "debug": true }]],
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }]
}
JSON
export XDG_CONFIG_HOME="$ROOT/config" XDG_DATA_HOME="$ROOT/data" \
  XDG_STATE_HOME="$ROOT/state" XDG_CACHE_HOME="$ROOT/cache" \
  OPENCODE_SERVER_PASSWORD=testpass
opencode serve --hostname 127.0.0.1 --port 4096 &
```

The server uses HTTP basic auth with user `opencode` and the password above.
Requests take a `directory` query parameter naming the project. Plugins load
lazily on the first request for a directory, so call the plugin list first and
wait a few seconds before raising permissions:

```bash
AUTH=opencode:testpass; URL=http://127.0.0.1:4096; DIR=/path/to/checkout
curl -s -u $AUTH "$URL/api/plugin?directory=$DIR" | grep -o '"opencode.auto-permissions.server"[^}]*}'
SID=$(curl -s -u $AUTH -X POST "$URL/api/session?directory=$DIR" \
  -H 'content-type: application/json' -d '{"title":"check"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -s -u $AUTH -X POST "$URL/api/session/$SID/permission?directory=$DIR" \
  -H 'content-type: application/json' \
  -d '{"action":"shell","resources":["git status --short"],"save":[],"agent":"build"}'
```

Expected: the plugin entry reports `"status":"active"`, and
`$ROOT/state/opencode/auto-permissions/decisions.jsonl` contains a
`plugin_environment` record with `"owner":"server"` followed by a `decision`
record for the request. A synthetic prompt (`POST /api/session/{id}/synthetic`)
that asks the agent to run a shell command exercises the tool-sourced path.
OpenCode's free-tier models refuse the hidden reviewer agent, so the model
path needs a configured provider; the policy path needs none.
