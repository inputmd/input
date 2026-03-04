#!/usr/bin/env npx tsx

// Parse /export files from Claude Code.
// Usage:
//   npx tsx parse_export.ts <export_file> [output_json_file]

import { readFileSync, writeFileSync } from 'node:fs';
import { parseClaudeExportTrace, renderClaudeTraceMarkdown } from './src/claude_trace';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: npx tsx parse_export.ts <export_file> [output_file]');
  process.exit(1);
}

const inputFile = args[0];
const outputFile = args[1];

const input = readFileSync(inputFile, 'utf-8');
const parsed = parseClaudeExportTrace(input, inputFile);
const json = JSON.stringify(parsed, null, 2);

if (outputFile) {
  writeFileSync(outputFile, json, 'utf-8');
  console.error(`Wrote ${parsed.messages.length} messages to ${outputFile}`);
} else {
  console.log(json);
}

if (process.env.RENDER_MARKDOWN === '1') {
  const markdown = renderClaudeTraceMarkdown(parsed);
  console.error('\n--- markdown preview ---\n');
  console.error(markdown);
}
