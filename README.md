# vims-sandbox

The Cloudflare backend for VIMS agent sandboxes. VIMS deploys this Worker to
*your* Cloudflare account from an API token (desktop: Agents → Cloudflare
Sandbox; chat.vims.com: Deploy → your server → Agent sandbox) — no wrangler,
Node or Docker needed on your machine.

## What it does

- **One container per agent.** Each VIMS agent instance is a Durable Object
  that starts its own [Cloudflare container](https://developers.cloudflare.com/containers/)
  — a microVM with its own kernel and network — from its runtime's image
  (`runtimes.lock.json`). OpenClaw and ZeroClaw: their upstream images,
  pinned by digest. Hermes, OpenFang and NemoClaw have none: a pinned public
  base (`buildpack-deps:trixie-curl`) plus their HelloVIMS/Runtimes binaries,
  pinned by SHA-256 and mirrored into each release, which VIMS assembles into
  an image in your registry at deploy (NemoClaw also gets VIMS's adapter from
  the deploying daemon). Nothing to publish, no package visibility to manage.
- **Provider keys never enter the container.** The runtime calls an
  OpenAI-compatible API at `http://vims.gateway/v1` with its instance token.
  The Worker checks the token, uses the model VIMS chose for that instance
  (the runtime's own model id is ignored), adds the provider key it holds as a
  Worker secret and streams the answer back.
- **Egress under the agent's VIMS policy.** Containers start with Internet
  off; every HTTP and HTTPS request goes through the Worker, which applies the
  instance's VIMS egress rules (default deny, the same evaluation as VIMS's
  local egress proxy — `test/egress_vectors.json` is shared with VIMS).

## API

Every `/v1` request carries `X-Vims-Sandbox-Token: <SANDBOX_TOKEN>`.

| Method | Path | |
| --- | --- | --- |
| GET | `/health` | Public: version and runtimes |
| PUT | `/v1/instances/:id` | Start (idempotent for the same spec) |
| GET | `/v1/instances/:id` | Status: `running`, `ready`, `runtime`, `model`, `lastExit` |
| PATCH | `/v1/instances/:id` | Live update `{ egress?, model? }` — applied to a running container without a restart |
| DELETE | `/v1/instances/:id` | Stop and forget |
| POST | `/v1/instances/:id/wake` | Start a stopped container from its saved spec (poll status for `ready`) |
| GET | `/v1/instances/:id/logs?lines=N` | The runtime's recent output |
| any | `/v1/instances/:id/http/<path>` | The runtime's own HTTP / WebSocket API |

A start spec: `runtime`, `port`, `env`, `files` (seeded config, base64), `dirs`,
`args?`, `egress` (`{ default, rules }`), `model` (`{ provider, model }`),
`gatewayToken`, `instance?` (`standard-1`), `inactivityTimeoutMs?` (2 h).
A stopped container with a saved spec is started again on its next request.

## Secrets

`SANDBOX_TOKEN` (VIMS generates it) and the provider keys you choose:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
`XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`,
`MOONSHOT_API_KEY`, `NVIDIA_API_KEY`.

## Develop

```sh
npm ci
npm run typecheck && npm test
node scripts/lock-images.mjs   # re-pin runtime images; review and commit the lock
node scripts/bundle.mjs dist   # what CI publishes
```

Each push to `main` publishes release `vims-sandbox-<sha12>` and the rolling
`latest` that VIMS deploys.
