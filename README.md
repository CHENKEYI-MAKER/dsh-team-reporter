# dsh-team-reporter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that reports
this machine's real token usage to a team dashboard you run yourself, so a team can see its own
usage and cost in one place.

## What it does

- Collects one record per model call, from the host's `session/event` stream — `input_tokens`,
  `cache_read_tokens`, `output_tokens`, the model name, and the project directory. Reasoning tokens
  are already included in `output_tokens` and are not counted separately.
- Queues records on disk, so usage survives a restart or a network outage and is replayed later.
  Records are idempotent, so a replay cannot double-count.
- Sends only token counts and cost. It never sends prompts, replies, file contents, or credentials.

## Install

```sh
dsh plugin --profile desktop add dsh-team-reporter
```

Restart DSH. A grey dot appears in the bottom-right corner — open it, enter your team server URL and
the enrollment code your administrator gave you, and click 绑定 (Bind). The dot turns green and
reporting starts.

A code is single-use and belongs to one person. Reinstalling or moving to a new machine needs a new
code from your administrator.

## Configuration

The plugin learns everything else from the server's `/api/v1/config` endpoint — the price table used
for local cost estimates and the flush interval. Nothing needs to be configured locally.

## Requirements

- Node.js >= 22.5.0
- A team server you or your administrator run (this plugin only talks to the URL you enter)

## Privacy

Token counts and a hash of the session id are the only things that leave the machine. The workspace
field is the project directory's name, not its full path.
