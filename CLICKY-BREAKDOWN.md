# Clicky — product and architecture breakdown

Reverse-engineered from `Clicky.app` **1.0.18 (build 25)** installed on macOS,
its runtime state in `~/Library/Application Support/Clicky/`, the frozen
open-source snapshot at `github.com/farzaa/clicky`, and `heyclicky.com`.

Every architectural claim below is traceable to a file in the bundle, a symbol
in the binary, or a runtime config value. Where something could not be
verified it says so. Marketing claims are labelled as such and never presented
as architecture.

**The open-source repo is not this app.** That snapshot is the menu-bar-era
version — 20 commits, no notch, no skills, no agent. Everything interesting
described here exists only in the shipped build.

---

## 1. What it actually is

A macOS menu-bar assistant (`LSUIElement`, no Dock icon) that puts a hotkey
between the user and an agent which can see the screen, talk back, and operate
other applications.

The product's own framing, from its shipped system prompt:

> Clicky handles microphone input, screenshots, onboarding, the floating HUD,
> and spoken task-finished summaries. You handle reasoning, tools, concise
> commentary, and the final answer.

That division is the whole design. **Clicky is a native shell around OpenAI
Codex.** The Swift app owns perception and presentation; Codex owns thinking
and doing.

| | |
|---|---|
| Bundle id | `com.humansongs.clicky` |
| Version | 1.0.18 (25), built against the macOS 26.5 SDK |
| Minimum OS | macOS 14.2 |
| Size | 450 MB |
| Distribution | Sparkle, appcast on GitHub Pages, hourly checks, auto-install |
| URL scheme | `clicky://` (auth callback) |

Interaction model, from strings in the binary:

- **Hold Control+Option** — voice session. "Hold to start a voice session. Release to send."
- **Tap** — "Press to open the text composer."
- **Double-tap Esc** — close.
- Onboarding literally instructs: *"press control + option and introduce yourself"*.

A modifier-only chord is exactly why the OSS repo carried a listen-only
CGEvent tap: AppKit's normal monitors are unreliable for chords with no
regular key.

**Origin trace:** the bundled `AGENTS.md` documents the app target as
`leanring-buddy` (sic), and a stale preference key
`com.learningbuddy.hasPreviouslyConfirmedScreenRecordingPermission` survives
in the plist. Clicky began as a screen-watching *learning* assistant and grew
into an agent.

---

## 2. Process and service topology

```
Clicky.app  (SwiftUI, LSUIElement)
├── Contents/MacOS/Clicky                     34 MB   perception + all UI surfaces
├── Contents/Resources/CodexRuntime/…/codex   →  spawned as: codex app-server
├── Contents/Helpers/ClickyComputerUseRuntime 22.7 MB → local MCP server "computer-use" (Cua)
├── Contents/Helpers/ClickyRuntimeSidecar      1.5 MB
└── Contents/Frameworks/ Sentry · Sparkle
```

Verified at runtime: with Clicky running, the child process is literally
`…/CodexRuntime/bin/../vendor/aarch64-apple-darwin/codex/codex app-server`.

**MCP servers** (from `CodexHome/config.toml`):

| Server | Transport | Role |
|---|---|---|
| `computer-use` | local binary | Cua-backed macOS GUI control, 21 tools |
| `openaiDeveloperDocs` | remote URL | OpenAI docs lookup |
| `composio` | attached dynamically | connected third-party accounts |

**Backing services:** Supabase (Google OAuth + account data) · a Cloudflare
Worker (`clicker-proxy-v2…workers.dev`) as the model proxy · AssemblyAI
streaming v3 over WebSocket (real-time STT) · Anthropic Messages API · OpenAI
chat completions · PostHog (product analytics) · Sentry (crashes).

---

## 3. The Codex embedding, and the proxy

Clicky maintains a real Codex home at
`~/Library/Application Support/Clicky/CodexHome/` — `config.toml`,
`sessions/`, `skills/`, `sqlite/`, `shell_snapshots/`, `memories/`,
`auth.json`, `installation_id`.

```toml
model                  = "gpt-5.5"
model_reasoning_effort = "low"
model_provider         = "clicky"
approval_policy        = "never"
sandbox_mode           = "danger-full-access"
history.persistence    = "save-all"
[features] apps = true, js_repl = true, multi_agent = true, fast_mode = false
[model_providers.clicky]
base_url = "https://clicker-proxy-v2.…workers.dev/agent/openai/v1"
wire_api = "responses"
```

Three consequential choices here.

**All model traffic is proxied.** The user never supplies an API key; the
Cloudflare Worker holds credentials and is where metering and the paywall
live. This is what makes the message-count pricing enforceable, and it means
Clicky sees every prompt, screenshot and transcript that passes through.

**`approval_policy = "never"` with `sandbox_mode = "danger-full-access"`.**
The agent runs unsandboxed, with no per-action confirmation. Safety is
enforced *entirely in the prompt* — "stop before purchases, sends, deletes,
payments, account changes, financial actions, irreversible local changes."
That is a real product position: fluency bought with prompt-level guardrails
rather than mechanical ones.

**`model_reasoning_effort = "low"`.** Tuned for latency, not depth — right for
an assistant expected to answer while you wait.

**The system prompt is composed per session.** The bundled
`ClickyModelInstructions.md` is 87 lines; the installed copy is 93. The
difference is a live *External integrations* block appended at runtime
reflecting current connection state:

> Composio is not attached to this agent session… Obsidian is not configured…
> Do not run OAuth, browser sign-in, local Composio CLI login, or any other
> local OAuth CLI as a fallback.

---

## 4. The skill system — three tiers

This is the largest thing Clicky has that ContextLayer does not.

### Tier 1 — 17 first-party skills

Shipped in `Resources/ClickyBundledSkills/`, mirrored into
`CodexHome/skills/`, each registered explicitly in `config.toml`. Same
`SKILL.md` + YAML-frontmatter convention as Claude Code skills.

*Workflow* — `clicky-artifacts` · `clicky-research-report` ·
`clicky-repo-operator` · `clicky-google-workspace` · `clicky-email-assistant` ·
`clicky-dev-setup-doctor` · `clicky-build-preview` · `clicky-creative-studio`

*Capability* — `cua-driver` (43 KB) · `pdf` · `doc` · `spreadsheet` ·
`frontend-design` · `read-wiki` · `save-wiki` · `obsidian` · `vercel-deploy`

Each carries a **Use When / Do Not Use When** pair that routes *away* from
itself as precisely as toward itself — `clicky-research-report` explicitly
hands off to `clicky-artifacts` for re-opening an existing report and to
`clicky-google-workspace` for private Drive files.

### Tier 2 — 25 integration skills

Loose `.md` files in `Resources/`, authored by "Hermes Agent", with
frontmatter declaring `env_vars` and required `commands`. Deliberately
**curl/CLI-based — no MCP server, no OAuth flow, no extra dependencies**:

airtable · apple-notes · apple-reminders · blender · claude-code ·
claude-design · codex · excalidraw · findmy · github-auth ·
github-code-review · github-issues · github-pr-workflow ·
github-repo-management · google-workspace · imessage · linear · maps ·
notion · obsidian · ocr-and-documents · polymarket · powerpoint · spotify ·
youtube-content

These are **user-selectable**: the plist carries `selectedHermesSkillIDs`,
and a `hermesSkillsFirstLaunchDefaultsApplied` flag. A default subset is
enabled on first launch and the user curates from there.

### Tier 3 — Composio MCP

Attached at runtime, per connected account, via Settings → Integrations. Not
present in static config. The binary carries a full management surface:
`AgentIntegrations`, `AgentIntegrationToolkit`, `AgentIntegrationStatusBadge`,
`AgentComposioMCPSessionResponse`.

**Users never name skills.** From the system prompt: *"users do not need to
know or name skills; choose skills from intent, descriptions, screenshots,
files, and the task goal… skill names are implementation labels, not
user-facing commands."*

---

## 5. Routing doctrine

Most of the system prompt's length is spent defending one ladder — pick the
**narrowest capable route**:

1. structured/local tools
2. resume the owning child thread
3. Composio MCP for connected external apps
4. **Cua / Computer Use only for last-mile native or browser UI**

The rules that make it work are the interesting part:

- **A screenshot is context, not route selection.** *"Seeing LinkedIn, Gmail,
  Slack… does not count as the user explicitly asking for visible UI control."*
- **No silent downgrade.** If a connector is missing or expired, do not
  quietly start clicking the UI instead. Name the app, send the user to
  Settings → Integrations.
- **Never run OAuth from inside the agent**, and never use Computer Use to
  drive Clicky's *own* settings.
- **Large results are not permission to escalate.** If a structured call
  returns too much, paginate or filter — don't jump to the GUI.
- **Unavailable ≠ broken.** Image, video and slide generation are not shipped;
  the agent must say so rather than present it as an auth problem or offer a
  retry.

Also explicitly not shipped in this release: browser MCPs, and Remote
Tasks/crons — though `AgentCrons` and `AgentCronRunNowResponse` exist in the
binary, so the surface is built and product-disabled.

---

## 6. The Computer Use contract

`cua-driver/SKILL.md` is 43 KB — the single largest piece of design in the
product. Its opening section is titled *"The no-foreground contract — read
this first"*:

> **The user's frontmost app MUST NOT change.** This is the whole reason
> Clicky ships Computer Use. Users pay for the right to keep typing in their
> editor while an agent drives another app in the background. Violate this
> rule and every other nice property the driver gives you stops mattering —
> you just shipped the Accessibility Inspector with extra steps.

Everything that steals focus is banned by name: **every form of `open`**
(all routed through LaunchServices, which foregrounds), `osascript … activate`,
`cliclick` (warps the real cursor), `CGEventPost` at another app's window,
`NSRunningApplication.activate`, Dock clicks, Cmd-Tab, and browser
address-bar hotkeys. `launch_app({bundle_id, urls:[…]})` is the only
sanctioned way to open anything.

**The core invariant — snapshot before *and* after every action.** The
element-index map is rebuilt on every snapshot and keyed on `(pid, window_id)`;
indices from a previous turn or a different window silently fail. The
after-snapshot is the *evidence* the action landed — "If nothing changed, the
action probably failed silently — say so, don't assume success."

The doc even carries its own post-mortem: `get_app_state` used to pick a
window by max area, and IINA's 600×432 off-screen subtitles panel out-area'd
the visible 320×240 player, so clicks landed on an invisible window. Window
selection became the caller's job.

**21 tools:** `check_permissions` `click` `right_click` `type_text`
`set_value` `press_key` `hotkey` `scroll` `page` `launch_app` `list_apps`
`list_windows` `get_window_state` `screenshot` `get_screen_size` `get_config`
`set_config` `get_agent_cursor_state` `set_agent_cursor_enabled`
`set_agent_cursor_motion` `set_agent_cursor_style`

Browser work: use the user's **default browser and normal profile** (never
`--user-data-dir`, which logs them out), open a **new background window** for
new tasks, and only reuse the current tab if the user asked for it.

---

## 7. The surfaces

### The notch HUD

`CodexHUDWindow` · `CodexHUDPanel` · `CodexHUDView` · `CodexHUDWindowManager` ·
`AgentHUDPillChrome` · `CodexHUDInteractiveRectPreferenceKey` ·
`CodexLaunchFlightOverlayView`.

`ClickyUseLegacyMenuBarPanel` and `ClickyPanelStylePreference` show the notch
panel is the *newer* surface and the menu-bar panel of the OSS era is the
legacy path; `ClickyNotchDefaultMigrationV1Done = 1` in the plist shows
existing users were migrated onto it.

### The agent cursor

A first-class, tunable feature — not decoration:

> A triangle pointer Bezier-glides to each click target, ring-ripples on
> landing, idle-hides after ~1.5s. Motion knobs: `set_agent_cursor_motion`
> takes any subset of `start_handle`, `end_handle`, `arc_size`, `arc_flow`,
> `spring` — tuneable at runtime, persisted to config.

Symbols: `AgentSurfaceCursorTriangle`, `CursorTextInputOverlay`,
`DetachedCursorClickPanel`. The plist carries `overlayCursorColorHex` and a
`clicky.cursor.docked.v2` mode. Clicky's MCP helper bootstraps an AppKit
runloop specifically to host this overlay.

### Handoff

`HandoffIndicatorWindow` · `HandoffRegionSelectOverlay` ·
`HandoffVoiceStopPanel` — a region-select and voice-stop control surface for
handing work between user and agent. Not documented publicly; not yet traced
to a user-facing flow.

### Voice

Push-to-talk (`VoiceHoldShortcut`), AssemblyAI streaming v3 for STT, and
**14 selectable TTS personas** shipped as preview clips: bright, bubbly,
cheerful, expert, fun, gentle, hope, kid, lumen, original, polished, smooth,
techy. The picker itself is unusually elaborate — `VoiceOrbitPicker`,
`VoiceWavePicker`, `VoiceDiscoveryMap`, `VoiceWaveformBars` — alongside a mic
test card and volume meter.

~15 sound cues carry state: agent launch/done/close, text open/send/receive,
skill-up/skill-down, hatching, question, surprised. `ClickyNotchSoundsEnabled`
toggles them.

### Memory

A wiki at `~/Library/Application Support/Clicky/wiki/`, seeded from
`ClickyBundledWikiSeed`, read and written through the `read-wiki` /
`save-wiki` skills. Its most product-defining use:

> When a task involves writing prose in the user's voice — emails, messages,
> posts, replies, copy — invoke the `read-wiki` skill first and read
> `preferences/personality.md`… Do this even when the user dictates specific
> content; they want it phrased in their voice, not yours.

Generated work lands in `…/Clicky/projects/<name>/`, marked `trust_level =
"trusted"` in config. Live examples on this machine: `hello-yash-demo`,
`spacex-competitor-research` (with `make_report.py`, `output/pdf`,
`output/reports`).

### Multi-threading

`ClickyRuntimeChild*` symbols plus `multi_agent = true` — several background
agent threads alive at once, with the prompt instructing the model to *resume
the owning child thread* for follow-up rather than starting fresh.

---

## 8. Permissions, safety, and the commercial model

**TCC:** Microphone, Screen Recording, Speech Recognition — each with a
purpose string. `AgentPermissionsInspector` and `AgentPermissionsPage` give it
a first-class settings surface, and `persistedPermissionSnapshot.*` keys cache
grant state.

**One documentation discrepancy, observed directly.** `cua-driver/SKILL.md`
claims the helper is spawned by Codex inside Clicky.app "so macOS attributes
Accessibility and Screen Recording use to Clicky itself." On this machine,
System Settings → Privacy & Security → Accessibility lists **`CuaDriver` as
its own entry**, separate from `Clicky`. The attribution claim does not hold
in practice.

**Commercial** (heyclicky.com, marketing claims):

| Plan | Price | Talk | Agent messages |
|---|---|---|---|
| Free | $0 | 25/mo | 25/mo |
| Pro | $20/mo | unlimited | 150/mo |
| Max | $100/mo | unlimited | 1,000/mo |

Dictation is unlimited on every tier — cheap, and it makes the free tier
genuinely useful. The paywall is a **HUD surface**
(`AgentPaywallHUDWindow`/`View`/`Manager`), not a settings page: you meet it
where you hit the limit. Mac-only; Windows waitlisted.

Stated privacy position: screenshots not permanently stored, screen read only
when the hotkey is pressed. Not independently verified here — and note that
all traffic transits their proxy by design.

**`ClickyCatModeEnabled`** exists. Undocumented.

### Security findings

Two things worth recording, both verified:

1. **Supabase session tokens are stored in plaintext in `NSUserDefaults`**
   (`~/Library/Preferences/com.humansongs.clicky.plist`) as
   `supabaseAccessToken` / `supabaseRefreshToken`, rather than the Keychain.
   Any process running as the user can read them and impersonate the account.
   The app *does* use the Keychain elsewhere in the ecosystem, so this looks
   like an oversight rather than a constraint.
2. **`sandbox_mode = "danger-full-access"` with `approval_policy = "never"`**
   means a prompt-injection reaching the agent — via a screenshot, a web page,
   or a document — has unsandboxed shell access on the user's machine with no
   confirmation step. The only barrier is the prompt's own list of
   "stop before…" actions.

---

## 9. What this means for ContextLayer

### Already built, this session

Notch-anchored HUD with hover-expand and hotkey focus · cursor companion with
a triangle marker · screen capture through a Swift sidecar · Accessibility
element reading with Vision OCR fallback · click-to-copy · a provider registry
covering local/Anthropic/OpenAI/OpenRouter/NVIDIA.

The direction was right. The execution gap is detail: Clicky's cursor
Bezier-glides with tunable spring and arc and ring-ripples on landing; ours
teleports. Clicky's Computer Use has a 43 KB behavioural contract; ours has
`screen_element`.

### The real gaps, in order of leverage

1. **A skill system.** This is the answer to the "skill hub" question left
   open earlier. Clicky's model is worth copying almost wholesale: `SKILL.md`
   with frontmatter, chosen by *intent* rather than named by the user, with
   explicit Do-Not-Use-When routing, in tiers (first-party workflow, curated
   integration, dynamic MCP).
2. **An agent loop at all.** ContextLayer generates artifacts from a prompt.
   Clicky runs a real agent with tools, shell, sub-threads and verification.
   That is the difference between a generator and an assistant.
3. **Routing doctrine.** The narrowest-capable-route ladder, and the discipline
   of never silently downgrading to GUI control, is hard-won design.
4. **Memory that shapes output.** `preferences/personality.md` steering voice
   is a small idea with large product returns — and ContextLayer already has a
   document store to hang it on.
5. **Integrations.** Composio for OAuth-backed apps; curl-based skills for the
   rest. ContextLayer has six connectors and no skill layer above them.

### Deliberately do not copy

- **`danger-full-access` + `approval_policy = "never"`.** ContextLayer's
  local-first, consent-gated posture is a genuine differentiator; adopting
  prompt-only safety would throw it away.
- **Proxy-only model access.** Their Worker exists to meter and bill.
  ContextLayer's provider registry lets a user point at a local Ollama and
  send nothing anywhere — the opposite promise, and the better one for this
  product.
- **Plaintext auth tokens.** ContextLayer already routes secrets through the
  macOS Keychain (`lib.rs`). Keep it that way.
- **450 MB.** Ours is 295 MB with Postgres bundled.

### The honest strategic read

Clicky and ContextLayer are not the same product and shouldn't converge.
Clicky is a *general* assistant whose moat is the no-foreground Computer Use
contract. ContextLayer is a *design-system-constrained generator* whose moat
is `validateUiPlan` — the thing that refuses to emit components your system
doesn't have.

What's worth borrowing is the **shell**: ambient HUD, skills, agent loop,
memory. What is not worth borrowing is the **positioning** — a second general
assistant competing on Computer Use, without the proxy economics or the
43 KB of GUI-driving scar tissue.

---

## Appendix — verification notes

- Bundle inspection: `Info.plist`, `Resources/`, `Helpers/`, `Frameworks/`,
  `strings(1)` over the 34 MB main binary.
- Runtime: `CodexHome/config.toml`, `sessions/*.jsonl`, plist,
  live process tree (`codex app-server` confirmed as a child of Clicky).
- Past-run evidence: three session transcripts show real tool usage —
  `exec_command` ×31, `write_stdin` ×4, `view_image` ×3, `launch_app` ×3,
  `get_window_state` ×2, `list_windows` ×1.
- **Not done:** a live end-to-end run driven by us. Synthesising the
  Control+Option chord sends keys to whatever app is frontmost, which risks
  interfering with the user's other work; it was attempted once, reached a
  different application, and was abandoned. No agent quota was consumed. A
  live run needs the user to press the hotkey while session logs are watched.
- Credentials seen during inspection (Supabase anon key, PostHog key, Sentry
  DSN, and the user's own session tokens) are deliberately not reproduced here.
