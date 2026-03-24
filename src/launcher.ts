#!/usr/bin/env bun
/**
 * Elrond Launcher — CLI entry point.
 *
 * Usage:
 *   elrond                            # Interactive setup wizard
 *   elrond 3                          # 3 agents with defaults
 *   elrond 5 --topic "Design auth"    # 5 agents with topic
 *   elrond ./configs/team.json        # From config file
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface LaunchOptions {
  agentCount: number;
  topic: string;
  model: string;
  effort: string;
  noViewer: boolean;
  restoreFile?: string;
  agents?: Array<{
    name: string;
    model?: string;
    effort?: string;
    persona?: string;
  }>;
}

function parseArgs(argv: string[]): LaunchOptions | null {
  const args = argv.slice(2); // skip bun, script

  // No args → return null to trigger wizard
  if (args.length === 0) return null;

  const opts: LaunchOptions = {
    agentCount: 0,
    topic: "General discussion",
    model: "claude-opus-4-6",
    effort: "max",
    noViewer: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--topic" && args[i + 1]) {
      opts.topic = args[++i]!;
    } else if (arg === "--model" && args[i + 1]) {
      opts.model = args[++i]!;
    } else if (arg === "--effort" && args[i + 1]) {
      opts.effort = args[++i]!;
    } else if (arg === "--no-viewer") {
      opts.noViewer = true;
    } else if (arg.endsWith(".json") && existsSync(arg)) {
      const config = JSON.parse(readFileSync(arg, "utf8"));
      opts.topic = config.topic ?? opts.topic;
      opts.agents = config.agents;
      opts.agentCount = config.agents?.length ?? 0;
    } else if (/^\d+$/.test(arg)) {
      opts.agentCount = Number(arg);
    }
    i++;
  }

  if (opts.agentCount < 1) {
    process.stderr.write(
      "Usage: elrond [agent-count | config.json] [--topic ...] [--model ...] [--effort ...] [--no-viewer]\n" +
        "  No args: interactive setup wizard\n" +
        "  agent-count: 1–10 (max 10 agents)\n",
    );
    process.exit(1);
  }

  if (opts.agentCount > 10) {
    process.stderr.write(`Error: Maximum 10 agents allowed (got ${opts.agentCount})\n`);
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Agent config builder
// ---------------------------------------------------------------------------

const VALID_EFFORTS = new Set(["low", "medium", "high", "max"]);

function validateEffort(val: string): AgentConfig["effort"] {
  if (VALID_EFFORTS.has(val)) return val as AgentConfig["effort"];
  process.stderr.write(`[elrond] Invalid effort "${val}", defaulting to "high"\n`);
  return "high";
}

function buildAgentConfigs(opts: LaunchOptions): AgentConfig[] {
  const configs: AgentConfig[] = [];
  for (let i = 0; i < opts.agentCount; i++) {
    const fromFile = opts.agents?.[i];
    configs.push({
      id: `agent-${i + 1}`,
      name: fromFile?.name ?? `Agent-${i + 1}`,
      model: fromFile?.model ?? opts.model,
      effort: validateEffort(fromFile?.effort ?? opts.effort),
      persona: fromFile?.persona ?? "A helpful meeting participant.",
      status: "launching",
    });
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Per-agent working directory setup
// ---------------------------------------------------------------------------

function setupAgentWorkdir(
  meetingId: string,
  config: AgentConfig,
  hubPort: number,
  projectRoot: string,
): string {
  const dir = join("/tmp/elrond", meetingId, config.id);
  mkdirSync(dir, { recursive: true });

  // .mcp.json — Claude Code discovers the Channel MCP Server from this
  const mcpConfig = {
    mcpServers: {
      elrond: {
        command: "bun",
        args: ["run", join(projectRoot, "src/server.ts")],
        env: {
          ELROND_AGENT_ID: config.id,
          ELROND_AGENT_NAME: config.name,
          ELROND_HUB_PORT: String(hubPort),
          ELROND_WORKDIR: dir,
        },
      },
    },
  };
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));

  // persona.txt — read by Channel MCP Server (mutable for hot-reload)
  writeFileSync(join(dir, "persona.txt"), config.persona);

  // .claude/settings.json — auto-approve Elrond tools, deny everything else
  const settingsDir = join(dir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify(
      {
        trustPromptDismissed: true,
        permissions: {
          allow: [
            "mcp__elrond__send_message",
            "mcp__elrond__get_history",
            "mcp__elrond__get_participants",
            "mcp__elrond__pass_turn",
          ],
        },
      },
      null,
      2,
    ),
  );

  return dir;
}

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

function tmux(...args: string[]): boolean {
  const result = Bun.spawnSync(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    process.stderr.write(
      `[elrond] tmux ${args[0]} failed: ${stderr || `exit ${result.exitCode}`}\n`,
    );
  }
  return result.exitCode === 0;
}

function tmuxSendKeys(pane: string, text: string): void {
  // Collapse multi-line prompts into a single line so that tmux does not
  // interpret embedded newlines as separate Enter presses.
  const oneLine = text.replace(/\n+/g, " ").trim();
  Bun.spawnSync(["tmux", "send-keys", "-t", pane, "-l", oneLine]);
  Bun.spawnSync(["tmux", "send-keys", "-t", pane, "Enter"]);
}

// ---------------------------------------------------------------------------
// Launch sequence
// ---------------------------------------------------------------------------

export async function launch(opts: LaunchOptions): Promise<void> {
  const agentConfigs = buildAgentConfigs(opts);
  const meetingId = `elrond-${Date.now().toString(36)}`;
  const projectRoot = resolve(import.meta.dir, "..");

  process.stderr.write(`[elrond] Starting meeting: ${meetingId}\n`);
  process.stderr.write(`[elrond] Topic: ${opts.topic}\n`);
  process.stderr.write(`[elrond] Agents: ${agentConfigs.map((a) => a.name).join(", ")}\n`);

  // --- Step 1: Start Hub (detached — survives Viewer crash) ---
  const hubEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELROND_MEETING_ID: meetingId,
  };
  if (opts.restoreFile) {
    hubEnv.ELROND_RESTORE_FILE = opts.restoreFile;
  }
  const hubProc = Bun.spawn(["bun", "run", join(projectRoot, "src/hub.ts")], {
    env: hubEnv,
    stdin: "ignore", // Must not inherit — ink owns process.stdin
    stdout: "pipe",
    stderr: "inherit",
  });
  hubProc.unref(); // Allow Launcher to exit without waiting for Hub

  // Wait for port file
  const portFile = `/tmp/elrond-${meetingId}.port`;
  const hubPort = await waitForPortFile(portFile, 10_000);
  process.stderr.write(`[elrond] Hub ready on port ${hubPort}\n`);

  // --- Step 2: Create tmux session ---
  const tmuxSession = meetingId;
  tmux("new-session", "-d", "-s", tmuxSession, "-x", "200", "-y", "50");

  // --- Step 3: Start agents in tmux panes ---
  const agentPanes: Array<{ config: AgentConfig; pane: string }> = [];

  for (let i = 0; i < agentConfigs.length; i++) {
    const config = agentConfigs[i]!;
    const workdir = setupAgentWorkdir(meetingId, config, hubPort, projectRoot);

    // Create pane (first agent uses the existing pane)
    const pane = `${tmuxSession}:0.${i}`;
    if (i > 0) {
      tmux("split-window", "-t", `${tmuxSession}:0`, "-h");
      tmux("select-layout", "-t", `${tmuxSession}:0`, "tiled");
    }

    // Register agent with Hub (includes tmux pane ID for /model, /effort injection)
    await fetch(`http://127.0.0.1:${hubPort}/api/register-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: config.id,
        name: config.name,
        model: config.model,
        effort: config.effort,
        persona: config.persona,
        tmuxPane: pane,
      }),
    });

    // Start Claude Code in the pane (all agents launched concurrently)
    const claudeCmd = `cd ${workdir} && claude --model ${config.model} --effort ${config.effort} --dangerously-skip-permissions`;
    tmuxSendKeys(pane, claudeCmd);
    agentPanes.push({ config, pane });

    process.stderr.write(`[elrond] Launched ${config.name} in pane ${pane}\n`);
  }

  // --- Step 3b: Background trust-dialog dismisser for ALL panes ---
  // Runs concurrently while we wait for agents sequentially.
  const allPaneIds = agentPanes.map((a) => a.pane);
  const trustWatcher = startTrustDialogWatcher(allPaneIds);

  // --- Step 3c: Wait for each agent's MCP server to connect to Hub, then send initial prompt ---
  for (const { config, pane } of agentPanes) {
    await waitForAgentConnected(hubPort, config.id, 30_000);
    await waitForPaneReady(pane, 30_000);
    process.stderr.write(
      `[elrond] ${config.name} MCP connected & TUI ready, sending initial prompt\n`,
    );
    const prompt = buildInitialPrompt(config, opts.topic);
    tmuxSendKeys(pane, prompt);
  }

  // Stop the background watcher — all agents are past the trust dialog
  trustWatcher.stop();

  // --- Step 4: Send meeting topic or resume message to Hub ---
  if (opts.restoreFile) {
    await fetch(`http://127.0.0.1:${hubPort}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `Meeting resumed. Topic: ${opts.topic}\n\nUse get_history to review the previous discussion and continue where you left off.`,
        sender: { id: "system", name: "System" },
      }),
    });
  } else {
    await fetch(`http://127.0.0.1:${hubPort}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `Meeting topic: ${opts.topic}\n\nThe meeting has started. All participants should introduce themselves and share their initial thoughts.`,
        sender: { id: "system", name: "System" },
      }),
    });
  }

  process.stderr.write(`[elrond] Meeting started. Topic broadcast sent.\n`);
  process.stderr.write(`[elrond] tmux session: ${tmuxSession}\n`);
  process.stderr.write(`[elrond] Hub: http://127.0.0.1:${hubPort}\n`);
  process.stderr.write(`[elrond] Attach: tmux attach -t ${tmuxSession}\n`);

  // --- Step 5: Cleanup handlers (guarded against double invocation) ---
  let cleanedUp = false;

  /** Full shutdown — user intentionally ending the meeting (Ctrl+C / Ctrl+Q) */
  const shutdownMeeting = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    process.stderr.write(`\n[elrond] Shutting down meeting...\n`);
    tmux("kill-session", "-t", tmuxSession);
    if (!hubProc.killed) hubProc.kill();
    try {
      rmSync(`/tmp/elrond/${meetingId}`, { recursive: true, force: true });
    } catch {}
    try {
      unlinkSync(portFile);
    } catch {}
    process.exit(0);
  };

  /** Viewer-only exit — Hub and agents keep running */
  const exitViewer = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    process.stderr.write(`\n[elrond] Viewer exited. Hub and agents still running.\n`);
    process.stderr.write(`[elrond] Hub: http://127.0.0.1:${hubPort}\n`);
    process.stderr.write(`[elrond] tmux: tmux attach -t ${tmuxSession}\n`);
    process.stderr.write(
      `[elrond] Restart viewer: bun run src/launcher.ts --no-viewer is not needed — just re-run.\n`,
    );
    process.exit(0);
  };

  process.on("SIGINT", shutdownMeeting);
  process.on("SIGTERM", shutdownMeeting);

  // Viewer crash should NOT kill Hub — only exit the viewer process
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[elrond] Uncaught exception: ${err?.message ?? err}\n`);
    process.stderr.write(`${err?.stack ?? ""}\n`);
    exitViewer();
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[elrond] Unhandled rejection: ${reason}\n`);
  });

  // --- Step 6: Launch viewer or wait ---
  if (!opts.noViewer) {
    process.stderr.write(`[elrond] Launching viewer...\n`);
    const { startViewer } = await import("./ui/viewer.ts");
    await startViewer(hubPort);
    // startViewer blocks until tui.stop() / Ctrl+Q
    shutdownMeeting();
  } else {
    process.stderr.write(`[elrond] Press Ctrl+C to end the meeting.\n`);
    await new Promise(() => {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Background watcher that continuously checks ALL tmux panes for the
 * Claude Code workspace trust dialog and auto-dismisses it by pressing Enter.
 * This runs concurrently so panes that aren't being waited on yet still get
 * their trust dialogs dismissed.
 */
function startTrustDialogWatcher(panes: string[]): { stop: () => void } {
  const dismissed = new Set<string>();
  let running = true;

  const poll = async () => {
    while (running) {
      for (const pane of panes) {
        if (dismissed.has(pane)) continue;
        try {
          const result = Bun.spawnSync(["tmux", "capture-pane", "-t", pane, "-p"]);
          const content = new TextDecoder().decode(result.stdout);
          if (content.includes("trust this folder")) {
            process.stderr.write(`[elrond] Trust dialog in pane ${pane}, auto-accepting...\n`);
            Bun.spawnSync(["tmux", "send-keys", "-t", pane, "Enter"]);
            dismissed.add(pane);
          }
        } catch {}
      }
      await Bun.sleep(500);
    }
  };

  // Fire and forget — runs in background
  poll();

  return {
    stop: () => {
      running = false;
    },
  };
}

async function waitForAgentConnected(
  hubPort: number,
  agentId: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${hubPort}/api/participants`);
      const data = (await resp.json()) as { participants: Array<{ id: string; status: string }> };
      const agent = data.participants.find((p) => p.id === agentId);
      if (agent && agent.status !== "launching") return;
    } catch {}
    await Bun.sleep(1000);
  }
  process.stderr.write(
    `[elrond] Warning: ${agentId} did not connect within ${timeoutMs / 1000}s, sending prompt anyway\n`,
  );
}

async function waitForPaneReady(pane: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let trustDismissed = false;
  while (Date.now() - start < timeoutMs) {
    const result = Bun.spawnSync(["tmux", "capture-pane", "-t", pane, "-p"]);
    const content = new TextDecoder().decode(result.stdout);

    // Claude Code shows "❯" when ready for input
    if (content.includes("\u276F")) return; // ❯

    // Auto-dismiss workspace trust dialog if it appears
    if (!trustDismissed && content.includes("trust this folder")) {
      process.stderr.write(`[elrond] Trust dialog detected in pane ${pane}, auto-accepting...\n`);
      // "Yes, I trust this folder" is pre-selected (❯ 1.), just press Enter
      Bun.spawnSync(["tmux", "send-keys", "-t", pane, "Enter"]);
      trustDismissed = true;
      await Bun.sleep(500);
      continue;
    }

    await Bun.sleep(1000);
  }
  process.stderr.write(
    `[elrond] Warning: pane ${pane} TUI not ready within ${timeoutMs / 1000}s, sending prompt anyway\n`,
  );
}

async function waitForPortFile(path: string, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      const port = Number(content);
      if (port > 0) return port;
    }
    await Bun.sleep(200);
  }
  throw new Error(`Timeout waiting for port file: ${path}`);
}

function buildInitialPrompt(config: AgentConfig, topic: string): string {
  return [
    `You are joining a meeting in the Elrond meeting room.`,
    ``,
    `Meeting topic: ${topic}`,
    ``,
    `Your role: ${config.persona}`,
    ``,
    `The meeting is starting now. Read the meeting topic carefully, then contribute your perspective using the send_message tool.`,
    `Remember to include nextSpeaker (who should speak after you) and ledger (your progress evaluation) with every send_message call.`,
    `Use get_participants first to see who else is in the meeting.`,
    ``,
    `Begin by introducing yourself briefly and sharing your initial thoughts on the topic.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const cliOpts = parseArgs(process.argv);

if (cliOpts) {
  // Direct launch (args provided)
  launch(cliOpts).catch((err) => {
    process.stderr.write(`[elrond] Fatal: ${err}\n`);
    process.exit(1);
  });
} else {
  // No args → interactive setup wizard
  (async () => {
    const { runSetupWizard } = await import("./ui/setup-wizard.ts");
    const wizardResult = await runSetupWizard();

    if (!wizardResult) process.exit(0);

    const opts: LaunchOptions = {
      agentCount: wizardResult.agents.length,
      topic: wizardResult.topic,
      model: "claude-opus-4-6",
      effort: "max",
      noViewer: false,
      agents: wizardResult.agents,
      restoreFile: wizardResult.restoreFile,
    };
    await launch(opts);
  })().catch((err) => {
    process.stderr.write(`[elrond] Fatal: ${err}\n`);
    process.exit(1);
  });
}
