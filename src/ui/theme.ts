/**
 * ASHIGARU-inspired theme system — 4 switchable themes.
 * Dark background + neon accent colors, CRT/cyberpunk terminal aesthetic.
 */

export interface ElrondTheme {
  name: "cyberpunk" | "matrix" | "amber" | "mono";
  colors: {
    bg: string;
    bgPanel: string;
    fg: string;
    fgSecondary: string;
    fgMuted: string;
    accent: string;
    accentSecondary: string;
    success: string;
    warning: string;
    error: string;
  };
  border: {
    chars: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
    focused: string;
    unfocused: string;
  };
  agentSlots: string[];
  frodoColor: string;
  systemColor: string;
}

const AGENT_SLOTS = ["#00ffff", "#ff00ff", "#00ff88", "#ffaa00", "#5588ff", "#ff5577", "#88ffcc", "#ddaa55", "#aa88ff", "#55ddff"];

export const THEMES: Record<ElrondTheme["name"], ElrondTheme> = {
  cyberpunk: {
    name: "cyberpunk",
    colors: {
      bg: "#000000",
      bgPanel: "#111111",
      fg: "#ffffff",
      fgSecondary: "#888888",
      fgMuted: "#555555",
      accent: "#00ffff",
      accentSecondary: "#ff00ff",
      success: "#00ff88",
      warning: "#ffaa00",
      error: "#ff4444",
    },
    border: {
      chars: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
      focused: "#00ffff",
      unfocused: "#333333",
    },
    agentSlots: AGENT_SLOTS,
    frodoColor: "#ffffff",
    systemColor: "#555555",
  },
  matrix: {
    name: "matrix",
    colors: {
      bg: "#000000",
      bgPanel: "#001100",
      fg: "#00ff00",
      fgSecondary: "#00aa00",
      fgMuted: "#006600",
      accent: "#00ff00",
      accentSecondary: "#88ff00",
      success: "#00ff00",
      warning: "#88ff00",
      error: "#ff0000",
    },
    border: {
      chars: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
      focused: "#00ff00",
      unfocused: "#003300",
    },
    agentSlots: AGENT_SLOTS.map(() => "#00ff00"), // all green in matrix
    frodoColor: "#88ff88",
    systemColor: "#006600",
  },
  amber: {
    name: "amber",
    colors: {
      bg: "#0a0500",
      bgPanel: "#140a00",
      fg: "#ffaa00",
      fgSecondary: "#aa7700",
      fgMuted: "#664400",
      accent: "#ffaa00",
      accentSecondary: "#ff6600",
      success: "#88ff00",
      warning: "#ffaa00",
      error: "#ff4400",
    },
    border: {
      chars: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
      focused: "#ffaa00",
      unfocused: "#664400",
    },
    agentSlots: AGENT_SLOTS,
    frodoColor: "#ffcc44",
    systemColor: "#664400",
  },
  mono: {
    name: "mono",
    colors: {
      bg: "#000000",
      bgPanel: "#101010",
      fg: "#ffffff",
      fgSecondary: "#aaaaaa",
      fgMuted: "#666666",
      accent: "#ffffff",
      accentSecondary: "#888888",
      success: "#ffffff",
      warning: "#aaaaaa",
      error: "#ff4444",
    },
    border: {
      chars: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
      focused: "#ffffff",
      unfocused: "#333333",
    },
    agentSlots: AGENT_SLOTS.map(() => "#ffffff"),
    frodoColor: "#ffffff",
    systemColor: "#666666",
  },
};

const THEME_ORDER: ElrondTheme["name"][] = ["cyberpunk", "matrix", "amber", "mono"];

export function nextTheme(current: ElrondTheme["name"]): ElrondTheme["name"] {
  const idx = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(idx + 1) % THEME_ORDER.length]!;
}

/** Get a consistent color for an agent based on its index. */
export function agentColor(theme: ElrondTheme, index: number): string {
  return theme.agentSlots[index % theme.agentSlots.length]!;
}

/** Get a color for a sender id. */
export function senderColor(theme: ElrondTheme, senderId: string, agentIndex: number): string {
  if (senderId === "frodo") return theme.frodoColor;
  if (senderId === "system") return theme.systemColor;
  return agentColor(theme, agentIndex);
}
