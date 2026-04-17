#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_CLAUDE_CLI_PATH = path.resolve(
  __dirname,
  '../vendor/overlay/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
);

export const CLAUDE_EDITOR_LAUNCH_BEFORE =
  'try{let A=cTY[z]??z;return P06(`${A} "${q}"`,{stdio:"inherit"}),{content:K.readFileSync(q,{encoding:"utf-8"})}}catch(A){if(typeof A==="object"&&A!==null&&"status"in A&&typeof A.status==="number"){let O=A.status;if(O!==0)return{content:null,error:`${tj(z)} exited with code ${O}`}}return{content:null}}finally{if(Y)_.exitAlternateScreen();else _.resumeStdin(),_.resume()}}';

export const CLAUDE_EDITOR_LAUNCH_AFTER =
  'try{let A=cTY[z]??z,B=A.split(" "),E=B[0]??A,R=B.slice(1),x;if(process.platform==="win32")x=RRK(`${A} "${q}"`,{stdio:"inherit",shell:!0});else x=RRK(E,[...R,q],{stdio:"inherit"});if(x.error)throw x.error;if(typeof x.status==="number"&&x.status!==0)throw{status:x.status};return{content:K.readFileSync(q,{encoding:"utf-8"})}}catch(A){if(typeof A==="object"&&A!==null&&"status"in A&&typeof A.status==="number"){let O=A.status;if(O!==0)return{content:null,error:`${tj(z)} exited with code ${O}`}}return{content:null}}finally{if(Y)_.exitAlternateScreen();else _.resumeStdin(),_.resume()}}';

export function getClaudeEditorLaunchPatchStatus(source) {
  return {
    hasPatchedSnippet: source.includes(CLAUDE_EDITOR_LAUNCH_AFTER),
    hasUnpatchedSnippet: source.includes(CLAUDE_EDITOR_LAUNCH_BEFORE),
  };
}

export function patchClaudeEditorLaunch(cliPath = DEFAULT_CLAUDE_CLI_PATH) {
  const current = fs.readFileSync(cliPath, 'utf8');
  const status = getClaudeEditorLaunchPatchStatus(current);

  if (status.hasPatchedSnippet) {
    return {
      changed: false,
      cliPath,
      status,
    };
  }

  if (!status.hasUnpatchedSnippet) {
    throw new Error(`Expected Claude editor launcher snippet not found in ${cliPath}`);
  }

  fs.writeFileSync(cliPath, current.replace(CLAUDE_EDITOR_LAUNCH_BEFORE, CLAUDE_EDITOR_LAUNCH_AFTER), 'utf8');
  return {
    changed: true,
    cliPath,
    status: getClaudeEditorLaunchPatchStatus(fs.readFileSync(cliPath, 'utf8')),
  };
}

function parseArgs(argv) {
  let cliPath = DEFAULT_CLAUDE_CLI_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { cliPath, help: true };
    }
    if (arg === '--cli-path') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --cli-path');
      }
      cliPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  return { cliPath, help: false };
}

function printHelp() {
  console.log('Usage: node scripts/patch-claude-editor-launch.js [--cli-path <path>]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }

    const result = patchClaudeEditorLaunch(args.cliPath);
    if (result.changed) {
      console.log(`Patched Claude editor launcher in ${result.cliPath}`);
    } else {
      console.log('Claude editor launcher already patched.');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
