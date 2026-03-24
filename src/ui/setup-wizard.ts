/**
 * Elrond Setup Wizard — pi-tui based.
 * Multi-step interactive wizard for configuring meetings.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Input, Key, matchesKey, ProcessTerminal, TUI, truncateToWidth } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { CATEGORIES, type Preset, presetsByCategory } from "../presets.ts";
import type { MeetingState } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizardResult {
  topic: string;
  agents: WizardAgent[];
  restoreFile?: string;
}

interface WizardAgent {
  name: string;
  model: string;
  effort: string;
  persona: string;
}

type Step =
  | "mode"
  | "preset_cat"
  | "preset_pick"
  | "topic"
  | "custom_count"
  | "resume_pick"
  | "custom_agent"
  | "config_path"
  | "confirm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const C = {
  accent: "#00ffff",
  accentSec: "#ff00ff",
  fg: "#ffffff",
  fgSec: "#888888",
  fgMuted: "#555555",
  success: "#00ff88",
  error: "#ff4444",
};

const h = (color: string) => chalk.hex(color);
const bold = (color: string, text: string) => chalk.hex(color).bold(text);

const MODEL_OPTIONS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const MODEL_LABELS = ["opus-4-6", "sonnet-4-6", "haiku"];
const EFFORT_OPTIONS = ["low", "medium", "high", "max"];

function modelLabel(model: string): string {
  const idx = MODEL_OPTIONS.indexOf(model);
  return idx >= 0 ? MODEL_LABELS[idx]! : model.replace("claude-", "");
}

function initial(name: string): string {
  return (name[0] ?? "?").toUpperCase();
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Saved meetings
// ---------------------------------------------------------------------------

interface SavedMeetingEntry {
  file: string;
  topic: string;
  savedAt: number;
  agentCount: number;
  messageCount: number;
}

function listSavedMeetings(): SavedMeetingEntry[] {
  const dir = join(homedir(), ".elrond", "meetings");
  if (!existsSync(dir)) return [];
  const entries: SavedMeetingEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, f), "utf8");
      const state = JSON.parse(raw) as MeetingState;
      entries.push({
        file: join(dir, f),
        topic: state.topic,
        savedAt: state.savedAt,
        agentCount: state.agents.length,
        messageCount: state.messages.length,
      });
    } catch {}
  }
  return entries.sort((a, b) => b.savedAt - a.savedAt);
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export async function runSetupWizard(): Promise<WizardResult | null> {
  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);

    // State
    let step: Step = "mode";
    let modeIdx = 0;
    let catIdx = 0;
    let presetIdx = 0;
    let selectedPreset: Preset | null = null;
    let topic = "";
    const agentCount = "3";
    let customAgents: WizardAgent[] = [];
    let customAgentIdx = 0;
    let agentField: "name" | "model" | "effort" | "persona" = "name";
    let confirmAgentIdx = 0;
    let configError = "";
    const savedMeetings = listSavedMeetings();
    let resumeIdx = 0;

    // Input component for text fields
    const textInput = new Input();
    let textInputActive = false;

    function done(result: WizardResult | null) {
      tui.stop();
      resolve(result);
    }

    function goToConfirm(agents: WizardAgent[]) {
      customAgents = [...agents];
      confirmAgentIdx = 0;
      step = "confirm";
      textInputActive = false;
      tui.requestRender();
    }

    function activateTextInput(value: string) {
      textInput.setValue(value);
      textInputActive = true;
      tui.setFocus(root);
      tui.requestRender();
    }

    // Root component
    const root = {
      render(width: number): string[] {
        const lines: string[] = [];
        const w = Math.min(width, 100);

        // Header
        lines.push("");
        lines.push(
          `  ${h(C.accentSec)("◢◤")} ${bold(C.accent, "ELROND")} ${h(C.accentSec)("◤◢")} ${h(C.fgSec)(step === "confirm" ? "— Review & Launch" : "— Meeting Setup")}`,
        );
        lines.push("");

        switch (step) {
          case "mode":
            lines.push(...renderMode(w));
            break;
          case "preset_cat":
            lines.push(...renderCategory(w));
            break;
          case "preset_pick":
            lines.push(...renderPresetPick(w));
            break;
          case "topic":
            lines.push(...renderTopic(w));
            break;
          case "custom_count":
            lines.push(...renderCustomCount(w));
            break;
          case "custom_agent":
            lines.push(...renderCustomAgent(w));
            break;
          case "config_path":
            lines.push(...renderConfigPath(w));
            break;
          case "resume_pick":
            lines.push(...renderResumePick(w));
            break;
          case "confirm":
            lines.push(...renderConfirm(w));
            break;
        }

        return lines;
      },

      handleInput(data: string): void {
        // Text input mode: forward to input component
        if (textInputActive) {
          if (matchesKey(data, Key.escape)) {
            textInputActive = false;
            handleEscape();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const value = textInput.getValue?.() ?? "";
            textInputActive = false;
            handleTextSubmit(value);
            tui.requestRender();
            return;
          }
          textInput.handleInput?.(data);
          tui.requestRender();
          return;
        }

        // Escape: back navigation
        if (matchesKey(data, Key.escape)) {
          handleEscape();
          tui.requestRender();
          return;
        }

        // Enter
        if (matchesKey(data, Key.enter)) {
          handleEnter();
          tui.requestRender();
          return;
        }

        // Arrow keys
        if (matchesKey(data, Key.up)) {
          handleArrow("up");
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down)) {
          handleArrow("down");
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.left)) {
          handleArrow("left");
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.right)) {
          handleArrow("right");
          tui.requestRender();
          return;
        }

        // 's' to start from confirm
        if (step === "confirm" && (data === "s" || data === "S")) {
          done({ topic, agents: customAgents });
          return;
        }
      },

      invalidate() {},
    };

    // --- Navigation handlers ---

    function handleEscape(): void {
      switch (step) {
        case "mode":
          done(null);
          break;
        case "preset_cat":
          step = "mode";
          break;
        case "preset_pick":
          step = "preset_cat";
          presetIdx = 0;
          break;
        case "topic":
          step = selectedPreset ? "preset_pick" : "custom_count";
          break;
        case "custom_count":
          step = "mode";
          break;
        case "custom_agent":
          if (customAgentIdx > 0) {
            customAgentIdx--;
            agentField = "name";
          } else {
            step = "custom_count";
          }
          break;
        case "config_path":
          step = "mode";
          break;
        case "resume_pick":
          step = "mode";
          break;
        case "confirm":
          step = "topic";
          activateTextInput(topic);
          break;
      }
    }

    function handleEnter(): void {
      switch (step) {
        case "mode":
          if (modeIdx === 0) step = "preset_cat";
          else if (modeIdx === 1) {
            step = "custom_count";
            activateTextInput(agentCount);
          } else if (modeIdx === 2) {
            step = "config_path";
            activateTextInput("");
          } else if (modeIdx === 3 && savedMeetings.length > 0) {
            step = "resume_pick";
            resumeIdx = 0;
          }
          break;

        case "preset_cat":
          step = "preset_pick";
          presetIdx = 0;
          break;

        case "preset_pick": {
          const list = presetsByCategory(CATEGORIES[catIdx]!.key);
          if (list[presetIdx]) {
            selectedPreset = list[presetIdx]!;
            topic = "";
            step = "topic";
            activateTextInput("");
          }
          break;
        }

        case "resume_pick": {
          const saved = savedMeetings[resumeIdx];
          if (saved) {
            try {
              const raw = readFileSync(saved.file, "utf8");
              const state = JSON.parse(raw) as MeetingState;
              done({
                topic: state.topic,
                agents: state.agents.map((a) => ({
                  name: a.name,
                  model: a.model,
                  effort: a.effort,
                  persona: a.persona,
                })),
                restoreFile: saved.file,
              });
            } catch {}
          }
          break;
        }

        case "confirm": {
          break;
        }

        case "custom_agent": {
          if (agentField === "model" || agentField === "effort") {
            // Enter = advance to next field
            advanceAgentField();
          }
          break;
        }
      }
    }

    function handleArrow(dir: "up" | "down" | "left" | "right"): void {
      switch (step) {
        case "mode": {
          const maxMode = savedMeetings.length > 0 ? 3 : 2;
          if (dir === "up") modeIdx = clamp(modeIdx - 1, 0, maxMode);
          else if (dir === "down") modeIdx = clamp(modeIdx + 1, 0, maxMode);
          break;
        }

        case "preset_cat":
          if (dir === "up") catIdx = clamp(catIdx - 1, 0, CATEGORIES.length - 1);
          else if (dir === "down") catIdx = clamp(catIdx + 1, 0, CATEGORIES.length - 1);
          break;

        case "resume_pick":
          if (dir === "up") resumeIdx = clamp(resumeIdx - 1, 0, savedMeetings.length - 1);
          else if (dir === "down") resumeIdx = clamp(resumeIdx + 1, 0, savedMeetings.length - 1);
          break;

        case "preset_pick": {
          const list = presetsByCategory(CATEGORIES[catIdx]!.key);
          if (dir === "up") presetIdx = clamp(presetIdx - 1, 0, list.length - 1);
          else if (dir === "down") presetIdx = clamp(presetIdx + 1, 0, list.length - 1);
          break;
        }

        case "confirm":
          if (dir === "up")
            confirmAgentIdx = clamp(confirmAgentIdx - 1, 0, customAgents.length - 1);
          else if (dir === "down")
            confirmAgentIdx = clamp(confirmAgentIdx + 1, 0, customAgents.length - 1);
          break;

        case "custom_agent": {
          if (agentField === "model") {
            const cur = customAgents[customAgentIdx]!;
            const idx = MODEL_OPTIONS.indexOf(cur.model);
            if (dir === "left")
              cur.model = MODEL_OPTIONS[(idx - 1 + MODEL_OPTIONS.length) % MODEL_OPTIONS.length]!;
            else if (dir === "right") cur.model = MODEL_OPTIONS[(idx + 1) % MODEL_OPTIONS.length]!;
          } else if (agentField === "effort") {
            const cur = customAgents[customAgentIdx]!;
            const idx = EFFORT_OPTIONS.indexOf(cur.effort);
            if (dir === "left")
              cur.effort =
                EFFORT_OPTIONS[(idx - 1 + EFFORT_OPTIONS.length) % EFFORT_OPTIONS.length]!;
            else if (dir === "right")
              cur.effort = EFFORT_OPTIONS[(idx + 1) % EFFORT_OPTIONS.length]!;
          }
          break;
        }
      }
    }

    function handleTextSubmit(value: string): void {
      switch (step) {
        case "topic":
          if (value.trim()) {
            topic = value.trim();
            const agents = selectedPreset ? [...selectedPreset.agents] : [...customAgents];
            goToConfirm(agents);
          }
          break;

        case "custom_count": {
          const n = Number(value);
          if (n >= 1 && n <= 10) {
            customAgents = [];
            for (let i = 0; i < n; i++) {
              customAgents.push({
                name: `Agent-${i + 1}`,
                model: "claude-opus-4-6",
                effort: "max",
                persona: "",
              });
            }
            customAgentIdx = 0;
            agentField = "name";
            step = "custom_agent";
            activateTextInput(customAgents[0]!.name);
          }
          break;
        }

        case "custom_agent": {
          advanceAgentField(value);
          break;
        }

        case "config_path": {
          try {
            const raw = readFileSync(value.trim(), "utf8");
            const config = JSON.parse(raw);
            if (!config.agents?.length) throw new Error("No agents in config");
            selectedPreset = {
              name: "Custom Config",
              description: value.trim(),
              category: "special",
              agents: config.agents,
            };
            topic = config.topic ?? "";
            step = "topic";
            activateTextInput(topic);
          } catch (err) {
            configError = err instanceof Error ? err.message : String(err);
          }
          break;
        }
      }
    }

    function advanceAgentField(textValue?: string): void {
      const cur = customAgents[customAgentIdx]!;
      if (agentField === "name") {
        if (textValue) cur.name = textValue;
        agentField = "model";
        textInputActive = false;
      } else if (agentField === "model") {
        agentField = "effort";
      } else if (agentField === "effort") {
        agentField = "persona";
        activateTextInput("");
      } else if (agentField === "persona") {
        if (textValue !== undefined) cur.persona = textValue || "A helpful meeting participant.";
        // Next agent or go to topic
        if (customAgentIdx < customAgents.length - 1) {
          customAgentIdx++;
          agentField = "name";
          activateTextInput(customAgents[customAgentIdx]!.name);
        } else {
          selectedPreset = null;
          step = "topic";
          activateTextInput("");
        }
      }
      tui.requestRender();
    }

    // --- Render functions ---

    function renderMode(_w: number): string[] {
      const lines: string[] = [];
      lines.push(`  ${h(C.fg)("? How would you like to start?")}`);
      lines.push("");

      const modes = [
        { icon: "🎯", label: "Preset", desc: "Ready-made meeting templates" },
        { icon: "🛠", label: "Custom", desc: "Configure agents manually" },
        { icon: "📄", label: "Config", desc: "Load from JSON file" },
        ...(savedMeetings.length > 0
          ? [
              {
                icon: "💾",
                label: "Resume",
                desc: `Continue a saved meeting (${savedMeetings.length})`,
              },
            ]
          : []),
      ];

      for (let i = 0; i < modes.length; i++) {
        const m = modes[i]!;
        const arrow = i === modeIdx ? bold(C.accent, "  ▸ ") : "    ";
        const label = i === modeIdx ? bold(C.fg, m.label) : h(C.fgSec)(m.label);
        lines.push(`${arrow}${m.icon} ${label} ${h(C.fgMuted)(`— ${m.desc}`)}`);
      }

      lines.push("");
      lines.push(`  ${h(C.fgMuted)("↑↓ Navigate  Enter Select  Esc Quit")}`);
      return lines;
    }

    function renderCategory(_w: number): string[] {
      const lines: string[] = [];
      lines.push(`  ${h(C.fg)("? Choose a category:")}`);
      lines.push("");

      for (let i = 0; i < CATEGORIES.length; i++) {
        const cat = CATEGORIES[i]!;
        const arrow = i === catIdx ? bold(C.accent, "  ▸ ") : "    ";
        const label = i === catIdx ? bold(C.fg, cat.label) : h(C.fgSec)(cat.label);
        lines.push(`${arrow}${label}`);
      }

      lines.push("");
      lines.push(`  ${h(C.fgMuted)("↑↓ Navigate  Enter Select  Esc Back")}`);
      return lines;
    }

    function renderPresetPick(_w: number): string[] {
      const lines: string[] = [];
      const list = presetsByCategory(CATEGORIES[catIdx]!.key);
      lines.push(`  ${h(C.fg)("? Choose a preset:")}`);
      lines.push("");

      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        const arrow = i === presetIdx ? bold(C.accent, "  ▸ ") : "    ";
        const label = i === presetIdx ? bold(C.fg, p.name) : h(C.fgSec)(p.name);
        lines.push(`${arrow}${label} ${h(C.fgMuted)(`(${p.agents.length} agents)`)}`);
        if (i === presetIdx) {
          lines.push(`      ${h(C.fgSec)(p.description)}`);
          lines.push(`      ${h(C.fgMuted)(p.agents.map((a) => a.name).join(", "))}`);
        }
      }

      lines.push("");
      lines.push(`  ${h(C.fgMuted)("↑↓ Navigate  Enter Select  Esc Back")}`);
      return lines;
    }

    function renderTopic(w: number): string[] {
      const lines: string[] = [];
      if (selectedPreset) {
        lines.push(
          truncateToWidth(`  ${h(C.success)("✓")} Preset: ${bold(C.fg, selectedPreset.name)} (${selectedPreset.agents.length} agents)`, w, ""),
        );
        lines.push("");
      }
      lines.push(`  ${h(C.fg)("? Meeting topic:")}`);
      lines.push("");
      if (textInputActive) {
        lines.push(truncateToWidth(`  ${bold(C.accent, ">")} ${textInput.getValue?.() ?? ""}█`, w, ""));
      } else {
        lines.push(
          truncateToWidth(`  ${bold(C.accent, ">")} ${topic || h(C.fgMuted)("What should the meeting discuss?")}`, w, ""),
        );
      }
      lines.push("");
      lines.push(`  ${h(C.fgMuted)("Enter Confirm  Esc Back")}`);
      return lines;
    }

    function renderCustomCount(_w: number): string[] {
      const lines: string[] = [];
      lines.push(`  ${h(C.fg)("? How many agents? (1-10)")}`);
      lines.push("");
      if (textInputActive) {
        lines.push(`  ${bold(C.accent, ">")} ${textInput.getValue?.() ?? ""}█`);
      } else {
        lines.push(`  ${bold(C.accent, ">")} ${agentCount}`);
      }
      lines.push("");
      lines.push(`  ${h(C.fgMuted)("Enter Confirm  Esc Back")}`);
      return lines;
    }

    function renderCustomAgent(_w: number): string[] {
      const lines: string[] = [];
      const cur = customAgents[customAgentIdx]!;
      lines.push(`  ${h(C.fg)(`Agent ${customAgentIdx + 1} of ${customAgents.length}`)}`);

      if (agentField !== "name") lines.push(`  ${h(C.fgMuted)("Name:")} ${cur.name}`);
      if (agentField === "effort" || agentField === "persona")
        lines.push(`  ${h(C.fgMuted)("Model:")} ${modelLabel(cur.model)}`);
      if (agentField === "persona") lines.push(`  ${h(C.fgMuted)("Effort:")} ${cur.effort}`);
      lines.push("");

      if (agentField === "name" || agentField === "persona") {
        const label = agentField === "name" ? "Name" : "Persona";
        if (textInputActive) {
          lines.push(`  ${bold(C.accent, `${label}:`)} ${textInput.getValue?.() ?? ""}█`);
        } else {
          lines.push(`  ${bold(C.accent, `${label}:`)} ...`);
        }
        lines.push("");
        lines.push(`  ${h(C.fgMuted)("Enter Next  Esc Back")}`);
      } else if (agentField === "model") {
        const row = MODEL_OPTIONS.map((m, i) => {
          return cur.model === m
            ? bold(C.accent, `[●${MODEL_LABELS[i]}]`)
            : h(C.fgMuted)(MODEL_LABELS[i]!);
        }).join("  ");
        lines.push(`  ${bold(C.accent, "Model:")} ${row}`);
        lines.push("");
        lines.push(`  ${h(C.fgMuted)("←→ Change  Enter Next  Esc Back")}`);
      } else if (agentField === "effort") {
        const row = EFFORT_OPTIONS.map((e) => {
          return cur.effort === e ? bold(C.accent, `[●${e}]`) : h(C.fgMuted)(e);
        }).join("  ");
        lines.push(`  ${bold(C.accent, "Effort:")} ${row}`);
        lines.push("");
        lines.push(`  ${h(C.fgMuted)("←→ Change  Enter Next  Esc Back")}`);
      }

      return lines;
    }

    function renderConfigPath(_w: number): string[] {
      const lines: string[] = [];
      lines.push(`  ${h(C.fg)("? Path to config JSON:")}`);
      lines.push("");
      if (textInputActive) {
        lines.push(`  ${bold(C.accent, ">")} ${textInput.getValue?.() ?? ""}█`);
      } else {
        lines.push(`  ${bold(C.accent, ">")} ${h(C.fgMuted)("./configs/example.json")}`);
      }
      if (configError) {
        lines.push(`  ${h(C.error)(`✕ ${configError}`)}`);
      }
      lines.push("");
      lines.push(`  ${h(C.fgMuted)("Enter Load  Esc Back")}`);
      return lines;
    }

    function renderResumePick(_w: number): string[] {
      const lines: string[] = [];
      lines.push(`  ${h(C.fg)("? Choose a saved meeting:")}`);
      lines.push("");

      if (savedMeetings.length === 0) {
        lines.push(`    ${h(C.fgMuted)("No saved meetings found.")}`);
      } else {
        for (let i = 0; i < savedMeetings.length; i++) {
          const s = savedMeetings[i]!;
          const arrow = i === resumeIdx ? bold(C.accent, "  ▸ ") : "    ";
          const label = i === resumeIdx ? bold(C.fg, s.topic) : h(C.fgSec)(s.topic);
          const date = new Date(s.savedAt).toLocaleString();
          lines.push(`${arrow}${label}`);
          lines.push(
            `      ${h(C.fgMuted)(`${s.agentCount} agents · ${s.messageCount} msgs · ${date}`)}`,
          );
        }
      }

      lines.push("");
      lines.push(`  ${h(C.fgMuted)("↑↓ Navigate  Enter Resume  Esc Back")}`);
      return lines;
    }

    function renderConfirm(w: number): string[] {
      const lines: string[] = [];
      lines.push(truncateToWidth(`  ${h(C.fgSec)("Topic:")} ${bold(C.fg, topic)}`, w, ""));
      lines.push("");
      lines.push(`  ${h(C.fgSec)("─═")} ${bold(C.fgSec, "Agents")} ${h(C.fgSec)("═─")}`);
      lines.push("");

      for (let i = 0; i < customAgents.length; i++) {
        const a = customAgents[i]!;
        const selected = i === confirmAgentIdx;
        const arrow = selected ? bold(C.accent, " ▸ ") : "   ";
        const nameColor = selected ? C.fg : C.fgSec;

        lines.push(
          truncateToWidth(`${arrow}${chalk.bgHex(C.accent).black(` ${initial(a.name)} `)} ${bold(nameColor, a.name)}       ${h(C.fgMuted)(`${modelLabel(a.model)} · ${a.effort}`)}`, w, ""),
        );

        const persona = a.persona.length > 60 ? `${a.persona.slice(0, 60)}...` : a.persona;
        lines.push(truncateToWidth(`      ${h(C.fgMuted)(persona || "(no persona)")}`, w, ""));
        lines.push("");
      }

      lines.push(`  ${h(C.fgMuted)("↑↓ Navigate   S Start   Esc Back")}`);
      return lines;
    }

    // --- Start TUI ---
    tui.addChild(root);
    tui.setFocus(root);
    tui.start();
  });
}
