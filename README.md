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
- Syncs the skills your team publishes: the server is the authority, the plugin pulls the whole
  library every 30 minutes and swaps it in atomically. A failed sync never removes what is already
  on the machine. You can also write your own skill and submit it for review from the panel.

## Install

**Download the tarball and point the plugin page at the local file** — this is the only route that
works without npm, without GitHub, and without a terminal:

1. Get `dsh-team-reporter-0.2.0.tgz` from your team's download page (or from the Releases tab here).
2. DSH → sidebar **插件** → **添加插件** → paste the file's **absolute path** → Install.
3. Restart DSH.

```sh
# CLI equivalent (the path must be absolute; a relative path is rejected by pnpm)
dsh plugin --profile desktop add "C:\Users\you\Downloads\dsh-team-reporter-0.2.0.tgz"
```

Neither of these works, and both were tested:

| Command | What happens |
| --- | --- |
| `add dsh-team-reporter` | Not published to npm → `ERR_PNPM_FETCH_404` |
| `add github:CHENKEYI-MAKER/dsh-team-reporter` | pnpm rewrites it to `git+ssh://` → `Permission denied (publickey)` unless you have GitHub SSH keys |
| `add https://<your-server>/dl/….tgz` | pnpm 11 only skips the integrity check for `file:` and a few git hosts → `ERR_PNPM_MISSING_TARBALL_INTEGRITY` |

`add https://github.com/CHENKEYI-MAKER/dsh-team-reporter.git` does work, but it needs GitHub access.

Restart DSH. A grey dot appears in the bottom-right corner — open it, enter your team server URL and
the enrollment code your administrator gave you, and click 绑定 (Bind). The dot turns green and
reporting starts.

A code is single-use and belongs to one person. Reinstalling or moving to a new machine needs a new
code from your administrator.

## Skills

The plugin keeps two directories strictly apart:

| Directory | Owner |
| --- | --- |
| `~/.dsh/skills/dsh-team/` | the server — replaced wholesale on every sync |
| `~/.dsh/skills/my-skills/` | you — the sync logic never touches it |

Put your own skills in `my-skills/`, then submit them for review from the team panel
(**团队版 → 我写的技能 → 提交审核**). Anything that looks like a credential, a public IP, or a
local absolute path is rejected at submission time and cannot be approved by an administrator either.

## Configuration

The plugin learns everything else from the server's `/api/v1/config` endpoint — the price table used
for local cost estimates and the flush interval. Nothing needs to be configured locally.

## Requirements

- Node.js >= 22.5.0
- A team server you or your administrator run (this plugin only talks to the URL you enter)

## Privacy

Token counts and a hash of the session id are the only things that leave the machine. The workspace
field is the project directory's name, not its full path.
