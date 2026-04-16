export interface Block {
  type: "user" | "assistant";
  text: string;
  lineStart: number; // 1-based line number in source file
  lineEnd: number;
}

export interface ParseResult {
  blocks: Block[];
}

/** Strip the ❯ prefix from the first line of a user message block */
function stripUserPrefix(lines: string[]): string[] {
  return lines.map((line, i) => {
    if (i === 0) {
      return line.replace(/^❯\s?/, "");
    }
    return line;
  });
}

export function parseExport(content: string): ParseResult {
  const lines = content.split("\n");
  const blocks: Block[] = [];

  // Find line indices (0-based) where a user message begins (line starts with ❯)
  const userStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("❯")) {
      userStarts.push(i);
    }
  }

  if (userStarts.length === 0) {
    return { blocks: [] };
  }

  for (let idx = 0; idx < userStarts.length; idx++) {
    const sectionStart = userStarts[idx];
    const sectionEnd =
      idx + 1 < userStarts.length ? userStarts[idx + 1] : lines.length;

    const sectionLines = lines.slice(sectionStart, sectionEnd);

    // Find the first line starting with ⏺ (assistant marker) in this section
    let assistantOffset = -1;
    for (let i = 1; i < sectionLines.length; i++) {
      if (sectionLines[i].startsWith("⏺")) {
        assistantOffset = i;
        break;
      }
    }

    if (assistantOffset === -1) {
      // No assistant response in this section — entire chunk is user
      const userText = stripUserPrefix(sectionLines).join("\n").trim();
      if (userText) {
        blocks.push({
          type: "user",
          text: userText,
          lineStart: sectionStart + 1,
          lineEnd: sectionEnd,
        });
      }
    } else {
      // Split into user and assistant portions
      const userLines = sectionLines.slice(0, assistantOffset);
      const assistantLines = sectionLines.slice(assistantOffset);

      const userText = stripUserPrefix(userLines).join("\n").trim();
      const assistantText = assistantLines.join("\n").trim();

      if (userText) {
        blocks.push({
          type: "user",
          text: userText,
          lineStart: sectionStart + 1,
          lineEnd: sectionStart + assistantOffset,
        });
      }
      if (assistantText) {
        blocks.push({
          type: "assistant",
          text: assistantText,
          lineStart: sectionStart + assistantOffset + 1,
          lineEnd: sectionEnd,
        });
      }
    }
  }

  return { blocks };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("fs");

  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx parse-export.ts <file>");
    process.exit(1);
  }

  const content = readFileSync(filePath, "utf-8");
  const result = parseExport(content);
  console.log(JSON.stringify(result, null, 2));
}
