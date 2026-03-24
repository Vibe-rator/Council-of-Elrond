import stringWidth from "string-width";

/** First letter of name, uppercased. Used for agent initial badges. */
export function initial(name: string): string {
  return (name[0] ?? "?").toUpperCase();
}

/**
 * CJK-aware text wrapping. Wraps text to fit within `maxWidth` columns,
 * properly handling double-width CJK characters, emoji, etc.
 * Returns an array of wrapped lines.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth < 1) return [text];

  const result: string[] = [];
  // Split by explicit newlines first
  const paragraphs = text.split("\n");

  for (const para of paragraphs) {
    if (para === "") {
      result.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;

    // Walk character by character for CJK-aware wrapping
    for (const char of para) {
      const charW = stringWidth(char);

      if (lineWidth + charW > maxWidth) {
        result.push(line);
        line = char;
        lineWidth = charW;
      } else {
        line += char;
        lineWidth += charW;
      }
    }

    if (line) result.push(line);
  }

  return result.length > 0 ? result : [""];
}

/**
 * Measure the visual width of a string in terminal columns.
 * CJK characters count as 2, most others as 1.
 */
export function visualWidth(text: string): number {
  return stringWidth(text);
}
