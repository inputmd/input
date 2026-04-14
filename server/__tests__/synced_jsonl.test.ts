import test from 'ava';
import { flattenBrowserHistoryTree, toBrowserHistoryModel } from '../../src/synced_jsonl/browser_tree.ts';
import { parseSyncedJsonl } from '../../src/synced_jsonl.ts';

test('parseSyncedJsonl recognizes OpenAI Codex session logs', (t) => {
  const content = [
    '{"type":"session","version":3,"id":"c27300c9-7606-4842-8be8-c79b28432836","timestamp":"2026-04-11T01:47:35.244Z","cwd":"/workspace/project"}',
    '{"type":"model_change","id":"4aa0f67b","parentId":null,"timestamp":"2026-04-11T01:47:35.248Z","provider":"openai-codex","modelId":"gpt-5.4"}',
    '{"type":"thinking_level_change","id":"d9e5312f","parentId":"4aa0f67b","timestamp":"2026-04-11T01:47:35.248Z","thinkingLevel":"medium"}',
    '{"type":"message","id":"a526ee73","parentId":"d9e5312f","timestamp":"2026-04-11T01:47:38.028Z","message":{"role":"user","content":[{"type":"text","text":"message one"}],"timestamp":1775872058025}}',
    '{"type":"message","id":"22ac59dd","parentId":"a526ee73","timestamp":"2026-04-11T01:48:53.355Z","message":{"role":"user","content":[{"type":"text","text":"inspect the current directory"}],"timestamp":1775872133354}}',
    '{"type":"message","id":"3986acbc","parentId":"22ac59dd","timestamp":"2026-04-11T01:48:56.218Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"**Inspecting current workspace**","thinkingSignature":"{\\"id\\":\\"rs_123\\"}"},{"type":"toolCall","id":"call_123","name":"bash","arguments":{"command":"ls -la"},"partialJson":"{\\"command\\":\\"ls -la\\"}"}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.4","usage":{"input":1033,"output":48,"cacheRead":0,"cacheWrite":0,"totalTokens":1081,"cost":{"input":0.0025825,"output":0.00072,"cacheRead":0,"cacheWrite":0,"total":0.0033025}},"stopReason":"toolUse","timestamp":1775872133356,"responseId":"resp_123"}}',
    '{"type":"message","id":"64781082","parentId":"3986acbc","timestamp":"2026-04-11T01:48:56.450Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"sample output\\n"}],"isError":false,"timestamp":1775872136450}}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.claude/sessions/example.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'openai-codex');
  t.is(parsed?.entries.length, 7);
  t.is(parsed?.entries[0]?.label, 'session');
  t.is(parsed?.entries[1]?.label, 'model_change · gpt-5.4');
  t.is(parsed?.entries[5]?.label, 'message · assistant');
  if (!parsed || parsed.kind !== 'openai-codex') return;
  t.is(parsed.entries[5]?.value.type, 'message');
  t.is(parsed.entries[5]?.value.message.role, 'assistant');
  t.is(parsed.entries[6]?.value.message.role, 'toolResult');
  t.is(parsed.tree.standaloneEntries.length, 1);
  t.is(parsed.tree.roots.length, 1);
  t.is(parsed.skippedLineCount, 0);
  const assistantNode = parsed.tree.roots[0]?.children[0]?.children[0]?.children[0]?.children[0];
  t.is(assistantNode?.value.type, 'message');
  t.is(assistantNode?.label, 'message · assistant');
  t.is(assistantNode?.children[0]?.label, 'message · toolResult');
});

test('parseSyncedJsonl recognizes Claude Code session logs', (t) => {
  const content = [
    '{"type":"permission-mode","permissionMode":"default","sessionId":"0af4a767-39e7-4b6e-95fe-ca82e891110d"}',
    '{"type":"file-history-snapshot","messageId":"8d5ca0e6-2235-4814-a094-9f8520505ee4","snapshot":{"messageId":"8d5ca0e6-2235-4814-a094-9f8520505ee4","trackedFileBackups":{},"timestamp":"2026-04-10T23:02:21.471Z"},"isSnapshotUpdate":false}',
    '{"parentUuid":"0bf0f541-26ae-4841-8426-dab10174d53d","isSidechain":false,"attachment":{"type":"skill_listing","content":"- task-a","skillCount":6,"isInitial":true},"type":"attachment","uuid":"64bb380d-ade5-453a-bcec-f9a9e93d8856","timestamp":"2026-04-10T23:02:29.994Z","userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"0af4a767-39e7-4b6e-95fe-ca82e891110d","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"37ae2060-9c50-41a5-819e-378ad7399604","isSidechain":false,"promptId":"f90c0d7b-eb56-4014-b203-4ace187bd7cd","type":"user","message":{"role":"user","content":"list the current directory only"},"uuid":"0bf0f541-26ae-4841-8426-dab10174d53d","timestamp":"2026-04-10T23:02:29.995Z","permissionMode":"default","userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"0af4a767-39e7-4b6e-95fe-ca82e891110d","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"64bb380d-ade5-453a-bcec-f9a9e93d8856","isSidechain":false,"message":{"model":"claude-opus-4-6","id":"msg_01XHhmh1vRKci13J8h8ykz8E","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_018QMdq63vz2jg4gWLW9W2Ds","name":"Bash","input":{"command":"ls -la /workspace/project","description":"List files in current directory"},"caller":{"type":"direct"}}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":4673,"cache_read_input_tokens":11367,"output_tokens":80,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":4673,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"}},"requestId":"req_011CZvvZQgMKvWnxGpnV7tUZ","type":"assistant","uuid":"a48fc27b-1ed0-439c-ae1a-d32a7cc3a6ea","timestamp":"2026-04-10T23:02:32.526Z","userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"0af4a767-39e7-4b6e-95fe-ca82e891110d","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"a48fc27b-1ed0-439c-ae1a-d32a7cc3a6ea","isSidechain":false,"promptId":"f90c0d7b-eb56-4014-b203-4ace187bd7cd","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Command failed\\n","is_error":true,"tool_use_id":"toolu_018QMdq63vz2jg4gWLW9W2Ds"}]},"uuid":"e2f65290-c793-4044-8129-abe5d8cbcd0e","timestamp":"2026-04-10T23:02:33.173Z","toolUseResult":"Command failed\\n","sourceToolAssistantUUID":"a48fc27b-1ed0-439c-ae1a-d32a7cc3a6ea","userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"0af4a767-39e7-4b6e-95fe-ca82e891110d","version":"2.1.97","gitBranch":"HEAD"}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.pi/agent/sessions/example.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'claude-code');
  t.is(parsed?.entries.length, 6);
  t.is(parsed?.entries[0]?.label, 'permission-mode · default');
  t.is(parsed?.entries[2]?.label, 'attachment · skill_listing');
  t.is(parsed?.entries[4]?.label, 'assistant · tool_use');
  if (!parsed || parsed.kind !== 'claude-code') return;
  t.is(parsed.entries[4]?.value.type, 'assistant');
  t.is(parsed.entries[4]?.value.message.content[0]?.type, 'tool_use');
  t.is(parsed.entries[5]?.value.type, 'user');
  t.is(parsed.tree.standaloneEntries.length, 2);
  t.is(parsed.tree.roots.length, 1);
  t.is(parsed.skippedLineCount, 0);
  t.is(parsed.tree.roots[0]?.children[0]?.value.type, 'attachment');
  t.is(parsed.tree.roots[0]?.children[0]?.children[0]?.value.type, 'assistant');
});

test('parseSyncedJsonl keeps Claude Code format when unsupported Claude event types appear alongside user and assistant events', (t) => {
  const content = [
    '{"type":"permission-mode","permissionMode":"default","sessionId":"sess_123"}',
    '{"parentUuid":null,"isSidechain":false,"promptId":"prompt_1","type":"user","message":{"role":"user","content":"message one"},"uuid":"user_1","timestamp":"2026-04-11T08:04:15.893Z","permissionMode":"default","userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"user_1","isSidechain":false,"message":{"model":"claude-opus-4-6","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"response one"}],"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":1,"output_tokens":1,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":1,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"}},"requestId":"req_1","type":"assistant","uuid":"assistant_1","timestamp":"2026-04-11T08:04:23.164Z","userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"assistant_1","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":55164,"messageCount":5,"timestamp":"2026-04-11T08:05:11.082Z","uuid":"system_1","isMeta":false,"userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-04-11T08:05:12.000Z","sessionId":"sess_123","content":"/effort"}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.pi/agent/sessions/example.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'claude-code');
  if (!parsed || parsed.kind !== 'claude-code') return;

  t.is(parsed.entries.length, 5);
  t.is(parsed.entries[3]?.label, 'system · turn_duration');
  t.is(parsed.entries[4]?.label, 'queue-operation · enqueue');
  t.is(parsed.tree.standaloneEntries.length, 2);
  t.is(parsed.tree.standaloneEntries[1]?.label, 'queue-operation · enqueue');
  t.is(parsed.tree.roots.length, 1);
  t.is(parsed.tree.roots[0]?.value.type, 'user');
  t.is(parsed.tree.roots[0]?.children[0]?.value.type, 'assistant');
  t.is(parsed.tree.roots[0]?.children[0]?.children[0]?.value.type, 'system');
});

test('parseSyncedJsonl recognizes Claude Code transcripts with tool result arrays and synthetic assistant rows', (t) => {
  const content = [
    '{"type":"permission-mode","permissionMode":"default","sessionId":"sess_123"}',
    '{"parentUuid":null,"isSidechain":false,"promptId":"prompt_1","type":"user","message":{"role":"user","content":"message one"},"uuid":"user_1","timestamp":"2026-04-11T08:04:15.893Z","permissionMode":"default","userType":"external","entrypoint":"cli","cwd":"/home/notes","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"user_1","isSidechain":false,"message":{"model":"claude-opus-4-6","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"response one"}],"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":1,"output_tokens":1,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":1,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"}},"requestId":"req_1","type":"assistant","uuid":"assistant_1","timestamp":"2026-04-11T08:04:23.164Z","userType":"external","entrypoint":"cli","cwd":"/home/notes","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"assistant_1","isSidechain":false,"promptId":"prompt_1","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"tool_reference","tool_name":"WebFetch"},{"type":"tool_reference","tool_name":"WebSearch"}]}]},"uuid":"user_2","timestamp":"2026-04-13T17:56:53.174Z","toolUseResult":{"matches":["WebFetch","WebSearch"],"query":"select:WebFetch,WebSearch","total_deferred_tools":21},"sourceToolAssistantUUID":"assistant_1","userType":"external","entrypoint":"cli","cwd":"/home/notes","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"parentUuid":"user_2","isSidechain":false,"type":"assistant","uuid":"assistant_2","timestamp":"2026-04-13T17:55:35.907Z","message":{"id":"bd8ab23c-ab22-4b04-95fb-8ee4fa122184","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"No response requested."}],"context_management":null},"isApiErrorMessage":false,"userType":"external","entrypoint":"cli","cwd":"/home/notes","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-04-13T17:56:56.339Z","sessionId":"sess_123","content":"/effort"}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.claude/sessions/example.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'claude-code');
  if (!parsed || parsed.kind !== 'claude-code') return;

  t.is(parsed.entries.length, 6);
  t.is(parsed.entries[3]?.label, 'user');
  t.true(parsed.entries[3]?.summary?.startsWith('tool_result') ?? false);
  t.is(parsed.entries[4]?.label, 'assistant');
  t.is(parsed.entries[4]?.value.type, 'assistant');
  t.is(parsed.entries[4]?.value.requestId, undefined);
  t.is(parsed.entries[4]?.value.message.usage?.service_tier ?? null, null);
  t.is(parsed.entries[5]?.label, 'queue-operation · enqueue');
});

test('parseSyncedJsonl still falls back to generic JSONL for unsupported Claude-shaped rows without a user and assistant exchange', (t) => {
  const content = [
    '{"type":"permission-mode","permissionMode":"default","sessionId":"sess_123"}',
    '{"parentUuid":null,"isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":55164,"messageCount":5,"timestamp":"2026-04-11T08:05:11.082Z","uuid":"system_1","isMeta":false,"userType":"external","entrypoint":"cli","cwd":"/workspace/project","sessionId":"sess_123","version":"2.1.97","gitBranch":"HEAD"}',
    '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-04-11T08:05:12.000Z","sessionId":"sess_123","content":"/effort"}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.pi/agent/sessions/example.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'generic');
});

test('parseSyncedJsonl recognizes pi-style branch and label entries', (t) => {
  const content = [
    '{"type":"session","version":3,"id":"sess_123","timestamp":"2026-04-11T01:47:35.244Z","cwd":"/workspace/project"}',
    '{"type":"model_change","id":"root_1","parentId":null,"timestamp":"2026-04-11T01:47:35.248Z","provider":"openai-codex","modelId":"gpt-5.4"}',
    '{"type":"message","id":"user_1","parentId":"root_1","timestamp":"2026-04-11T01:47:38.028Z","message":{"role":"user","content":[{"type":"text","text":"message one"}],"timestamp":1775872058025}}',
    '{"type":"branch_summary","id":"branch_1","parentId":"user_1","timestamp":"2026-04-11T01:47:40.028Z","fromId":"user_1","summary":"Alternative branch."}',
    '{"type":"label","id":"label_1","parentId":"branch_1","timestamp":"2026-04-11T01:47:41.028Z","targetId":"branch_1","label":"bookmark"}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.pi/agent/sessions/example.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'openai-codex');
  if (!parsed || parsed.kind !== 'openai-codex') return;
  t.is(parsed.tree.roots.length, 1);
  t.is(parsed.tree.roots[0]?.children[0]?.children[0]?.value.type, 'branch_summary');
  t.is(parsed.tree.roots[0]?.children[0]?.children[0]?.resolvedLabel, 'bookmark');
});

test('parseSyncedJsonl falls back to generic JSONL for unknown event shapes', (t) => {
  const content = ['{"kind":"alpha","count":1}', '{"kind":"beta","count":2}'].join('\n');

  const parsed = parseSyncedJsonl(content, 'custom.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'generic');
  t.is(parsed?.entries[0]?.label, 'kind, count');
  t.is(parsed?.tree.roots.length, 2);
  t.is(parsed?.skippedLineCount, 0);
});

test('parseSyncedJsonl skips malformed lines and still renders valid events', (t) => {
  const content = [
    '{"type":"session","version":3,"id":"sess_123","timestamp":"2026-04-11T01:47:35.244Z","cwd":"/workspace/project"}',
    'not json at all',
    '{"type":"model_change","id":"root_1","parentId":null,"timestamp":"2026-04-11T01:47:35.248Z","provider":"openai-codex","modelId":"gpt-5.4"}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.pi/agent/sessions/example.jsonl');

  t.truthy(parsed);
  t.is(parsed?.kind, 'openai-codex');
  t.is(parsed?.skippedLineCount, 1);
  t.deepEqual(parsed?.skippedLineNumbers, [2]);
  t.is(parsed?.entries.length, 2);
});

test('parseSyncedJsonl ignores single-line JSON documents that are not JSONL files', (t) => {
  const parsed = parseSyncedJsonl('{"theme":"dark"}', '.claude.json');

  t.is(parsed, null);
});

test('toBrowserHistoryModel derives compact display rows for parsed OpenAI logs', (t) => {
  const content = [
    '{"type":"session","version":3,"id":"sess_123","timestamp":"2026-04-11T01:47:35.244Z","cwd":"/workspace/project"}',
    '{"type":"model_change","id":"root_1","parentId":null,"timestamp":"2026-04-11T01:47:35.248Z","provider":"openai-codex","modelId":"gpt-5.4"}',
    '{"type":"message","id":"user_1","parentId":"root_1","timestamp":"2026-04-11T01:47:38.028Z","message":{"role":"user","content":[{"type":"text","text":"message one"}],"timestamp":1775872058025}}',
    '{"type":"message","id":"assistant_1","parentId":"user_1","timestamp":"2026-04-11T01:47:39.028Z","message":{"role":"assistant","content":[{"type":"text","text":"response one"}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.4","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1775872059028,"responseId":"resp_123"}}',
    '{"type":"message","id":"tool_1","parentId":"assistant_1","timestamp":"2026-04-11T01:47:40.028Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"item-a\\n"}],"isError":false,"timestamp":1775872060028}}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.pi/agent/sessions/example.jsonl');

  t.truthy(parsed);
  if (!parsed || parsed.kind !== 'openai-codex') return;

  const model = toBrowserHistoryModel(parsed);

  t.is(model.currentLeafId, 'tool_1');
  t.is(model.defaultSelectedKey, 'tool_1');
  t.is(model.standaloneEntries[0]?.display.lead, '[session]');
  t.is(model.roots[0]?.display.lead, '[model]');
  t.is(model.roots[0]?.children[0]?.display.lead, 'user:');
  t.is(model.roots[0]?.children[0]?.children[0]?.display.lead, 'assistant:');
  t.is(model.roots[0]?.children[0]?.children[0]?.children[0]?.display.lead, '[bash]');
});

test('flattenBrowserHistoryTree prioritizes the active branch in branched JSONL logs', (t) => {
  const content = [
    '{"type":"session","version":3,"id":"sess_123","timestamp":"2026-04-11T01:47:35.244Z","cwd":"/workspace/project"}',
    '{"type":"model_change","id":"root_1","parentId":null,"timestamp":"2026-04-11T01:47:35.248Z","provider":"openai-codex","modelId":"gpt-5.4"}',
    '{"type":"message","id":"user_1","parentId":"root_1","timestamp":"2026-04-11T01:47:36.028Z","message":{"role":"user","content":[{"type":"text","text":"message one"}],"timestamp":1775872056028}}',
    '{"type":"message","id":"assistant_1","parentId":"user_1","timestamp":"2026-04-11T01:47:37.028Z","message":{"role":"assistant","content":[{"type":"text","text":"response one"}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.4","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1775872057028,"responseId":"resp_a"}}',
    '{"type":"message","id":"user_2","parentId":"assistant_1","timestamp":"2026-04-11T01:47:38.028Z","message":{"role":"user","content":[{"type":"text","text":"message two"}],"timestamp":1775872058028}}',
    '{"type":"message","id":"assistant_old","parentId":"user_2","timestamp":"2026-04-11T01:47:39.028Z","message":{"role":"assistant","content":[{"type":"text","text":"response two"}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.4","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1775872059028,"responseId":"resp_b"}}',
    '{"type":"branch_summary","id":"branch_1","parentId":"user_2","timestamp":"2026-04-11T01:47:40.028Z","fromId":"user_2","summary":"Alternative branch."}',
    '{"type":"message","id":"assistant_new","parentId":"branch_1","timestamp":"2026-04-11T01:47:41.028Z","message":{"role":"assistant","content":[{"type":"text","text":"response three"}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-5.4","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1775872061028,"responseId":"resp_c"}}',
  ].join('\n');

  const parsed = parseSyncedJsonl(content, '.pi/agent/sessions/example.jsonl');

  t.truthy(parsed);
  if (!parsed || parsed.kind !== 'openai-codex') return;

  const model = toBrowserHistoryModel(parsed);
  const flatNodes = flattenBrowserHistoryTree(model.roots, model.currentLeafId);
  const nodeIds = flatNodes.map((node) => node.node.id);

  t.is(model.currentLeafId, 'assistant_new');
  t.deepEqual(nodeIds, ['root_1', 'user_1', 'assistant_1', 'user_2', 'branch_1', 'assistant_new', 'assistant_old']);
  t.true(flatNodes[4]?.isOnActivePath ?? false);
  t.true(flatNodes[5]?.isOnActivePath ?? false);
  t.false(flatNodes[6]?.isOnActivePath ?? true);
});
