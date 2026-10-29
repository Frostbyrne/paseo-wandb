Shows your active Weights & Biases runs in the Paseo sidebar and charts each run in a tab of the workspace whose agent started it.

A sidebar footer row shows how many runs are running, with a status dot: green while they heartbeat, amber when a running run has not sent a heartbeat for five minutes, red when a run crashed or failed in the last half hour or W&B cannot be reached. It refreshes every 30 seconds. A toast appears when a run starts, finishes, crashes, or fails.

Pressing the row opens a popover listing runs that are running or ended in the last six hours. Each card shows the run's name, project, group, host, state, step, a headline metric with a sparkline of its recent values, and the workspace and Claude Code session that started it. Charts opens a W&B tab next to that workspace's terminals with a chart for every numeric metric, grouped by prefix as W&B groups them, plus GPU, CPU, and memory charts from the run's system metrics. Running runs refresh every 30 seconds. Details opens a full screen with every listed run, for runs not traced to a workspace. The Command Center has "Show W&B runs from this workspace" and "Show all W&B runs".

## How runs are traced to a workspace

Paseo terminals export `PASEO_WORKSPACE_ID` and `PASEO_TERMINAL_ID`, and anything an agent starts inherits them. For runs on the daemon machine, the daemon finds the process holding the run's `wandb/run-*` directory open and reads those variables, which is exact. Runs started elsewhere, for example over SSH on a GPU host, are traced when the run's URL, run directory, or `WANDB_RUN_ID` appears in a Claude Code transcript within 30 minutes of the run starting; wandb prints the URL when a run starts, so the session that launched it usually sees it. Runs that neither method explains are still listed and charted, just not tied to a workspace. Links are saved in `~/.local/state/paseo-wandb/links.json` for 30 days.

## Setup

The daemon reads the API key that `wandb login` stores in `~/.netrc`, or the `WANDB_API_KEY` environment variable of the daemon. For W&B Server, it uses `WANDB_BASE_URL` or the `base_url` that `wandb login --host` writes. Runs from your own entity and your teams are listed. Process tracing needs Linux; transcript tracing reads `~/.claude` (or `CLAUDE_CONFIG_DIR`).

## What it reads and sends

The daemon queries the W&B GraphQL API for your projects, recent runs, sampled metric history, and system metrics. It reads `/proc` for local run processes and their Paseo variables, `~/.claude/sessions` for session names, and recent Claude Code transcripts when a run is not otherwise explained. The key and transcripts stay on the daemon; the app receives only run summaries and chart points. The plugin does not change, stop, or tag runs.

Up to 48 metrics per run are charted, each sampled to 300 points; open the run in W&B for the rest.
