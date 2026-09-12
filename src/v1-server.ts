import serverPlugin, { type PluginModule } from "./server.ts"

// The ./server entry is resolved by both runtimes:
// - v1 validates the default export and rejects any `tui` key ("has invalid
//   tui export"), but tolerates extra keys like `setup`.
// - v2 requires `setup` (or `effect`) on every module it loads, including
//   this subpath.
// The current V2 plugin API no longer declares a TUI capability flag, but
// strip any `tui` key defensively so a stale flag can never break v1 loading.
const { tui: _tuiCapability, ...dualPlugin } = serverPlugin as typeof serverPlugin & {
  tui?: unknown
}

const v1Plugin = {
  ...dualPlugin,
} satisfies PluginModule

export default v1Plugin
