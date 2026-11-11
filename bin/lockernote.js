#!/usr/bin/env node
import { createAgentClient } from "../lib/agent-client.js";
import { runMcpServer } from "../lib/mcp-server.js";

function usage() {
  return `LockerNote CLI

Usage:
  lockernote create --text "hello" --ttl 10
  lockernote create --file note.md --ttl 60
  lockernote create --text "handoff" --attach report.pdf --ttl 1440
  lockernote create --attach screenshot.png --attach notes.zip --ttl 60
  lockernote status
  lockernote open AB12CD
  lockernote download AB12CD --dir ./downloads
  lockernote clear --id note_xxx --code AB12CD
  lockernote mcp

Useful flags:
  --format text|json       Output format. Defaults to json for scripts.
  --file-root ./handoffs   Local file boundary for --file, --json, --attach, and downloads.
  --idempotency-key KEY    Reuse this key when retrying an open or download.

Environment:
  LOCKERNOTE_API_URL       Base URL, defaults to https://lockernote.com
  AGENT_API_TOKEN          Bearer token for /api/agent/*
  LOCKERNOTE_AGENT_TOKEN   Alternate token env for local clients
  LOCKERNOTE_MCP_FILE_ROOT Local file boundary for CLI/MCP handoffs, defaults to current directory
`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const setFlag = (key, value) => {
    if (flags[key] === undefined) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value);
    } else {
      flags[key] = [flags[key], value];
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split(/=(.*)/s, 2);
    const key = rawKey;
    if (inlineValue !== undefined) {
      setFlag(key, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      setFlag(key, true);
    } else {
      setFlag(key, next);
      index += 1;
    }
  }
  return { positional, flags };
}

function flagValue(flags, key) {
  const value = flags[key];
  return Array.isArray(value) ? value[0] : value;
}

function requiredFlagValue(flags, key) {
  const value = flagValue(flags, key);
  if (value === true) throw new Error(`Missing value for --${key}.`);
  return value;
}

function flagValues(flags, ...keys) {
  return keys.flatMap((key) => {
    const value = flags[key];
    if (value === undefined || value === true) return [];
    return Array.isArray(value) ? value : [value];
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printText(value) {
  const text = String(value || "");
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function formatValue(flags) {
  const format = String(requiredFlagValue(flags, "format") || "json").trim().toLowerCase();
  if (!["json", "text"].includes(format)) {
    throw new Error("Use --format text or --format json.");
  }
  return format;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function textForCreate(result) {
  const lines = [
    `code: ${result.code}`,
    `url: ${result.url}`,
    `id: ${result.id}`,
  ];
  if (result.locker?.expiresAt) lines.push(`expiresAt: ${result.locker.expiresAt}`);
  if (result.attachments?.length) lines.push(`attachments: ${result.attachments.length}`);
  return lines.join("\n");
}

function textForStatus(result) {
  return [
    `service: ${result.service || "LockerNote Agent API"}`,
    `ok: ${Boolean(result.ok)}`,
    `baseUrl: ${result.baseUrl || ""}`,
    `storage: ${result.storage?.mode || "unknown"} / ${result.storage?.attachmentMode || "unknown"}`,
    `redisHealthy: ${Boolean(result.storage?.redisHealthy)}`,
    `ttlMinutes: ${(result.limits?.ttlMinutes || []).join(", ")}`,
    `maxAttachment: ${formatBytes(result.limits?.maxAttachmentBytes)}`,
    `docs: ${result.docs?.guide || ""}`,
  ].join("\n");
}

function textForOpen(result) {
  const lines = [
    `id: ${result.id || result.locker?.id || ""}`,
  ];
  if (result.locker?.expiresAt) lines.push(`expiresAt: ${result.locker.expiresAt}`);
  if (result.locker?.attachmentCount) lines.push(`attachments: ${result.locker.attachmentCount}`);
  lines.push("content:");
  lines.push(result.locker?.content || "");
  return lines.join("\n");
}

function textForDownload(result) {
  const lines = [
    `code: ${result.code}`,
    `directory: ${result.directory}`,
    `attachments: ${result.attachments?.length || 0}`,
  ];
  for (const attachment of result.attachments || []) {
    lines.push(`- ${attachment.path} (${formatBytes(attachment.downloadedBytes || attachment.size)})`);
  }
  return lines.join("\n");
}

function textForClear(result) {
  return `cleared: ${result.id}`;
}

function printResult(value, flags, textFormatter) {
  if (formatValue(flags) === "json") {
    printJson(value);
    return;
  }
  printText(textFormatter(value));
}

function ttlValue(flags) {
  const raw = requiredFlagValue(flags, "ttlMinutes") ?? requiredFlagValue(flags, "ttl");
  return raw == null ? undefined : Number(raw);
}

function fileRootValue(flags) {
  return requiredFlagValue(flags, "file-root") || requiredFlagValue(flags, "fileRoot");
}

async function createCommand(flags, client) {
  const attachments = flagValues(flags, "attach", "attachment");
  const sources = [flags.text != null, flags.file, flags.json].filter(Boolean);
  if (sources.length > 1 || (sources.length === 0 && !attachments.length)) {
    throw new Error("Use one of --text, --file, --json, or at least one --attach.");
  }
  const payload = {
    ttl: ttlValue(flags),
  };
  if (flags.text != null) {
    payload.text = String(requiredFlagValue(flags, "text"));
  } else if (flags.file) {
    payload.text = await client.readLocalTextFile(requiredFlagValue(flags, "file"));
  } else if (flags.json) {
    payload.json = JSON.parse(await client.readLocalTextFile(String(requiredFlagValue(flags, "json"))));
  }
  if (flags.code) payload.code = requiredFlagValue(flags, "code");
  if (flags.deleteAfterOpen) payload.deleteAfterOpen = true;
  if (flags.burnAfterReads) payload.burnAfterReads = Number(requiredFlagValue(flags, "burnAfterReads"));
  printResult(await client.createLockerWithFiles(payload, attachments), flags, textForCreate);
}

async function downloadCommand(positional, flags, client) {
  const code = positional[0] || requiredFlagValue(flags, "code");
  if (!code) throw new Error("Missing locker code.");
  const directory = requiredFlagValue(flags, "dir") || requiredFlagValue(flags, "directory") || ".";
  const idempotencyKey = requiredFlagValue(flags, "idempotency-key")
    || requiredFlagValue(flags, "idempotencyKey");
  printResult(await client.downloadLockerAttachments(code, { directory, idempotencyKey }), flags, textForDownload);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  if (command === "mcp") {
    const { flags } = parseArgs(rest);
    runMcpServer({
      client: createAgentClient({
        baseUrl: requiredFlagValue(flags, "url") || requiredFlagValue(flags, "baseUrl"),
        token: requiredFlagValue(flags, "token"),
        fileRoot: fileRootValue(flags),
      }),
    });
    return;
  }

  const { positional, flags } = parseArgs(rest);
  const client = createAgentClient({
    baseUrl: requiredFlagValue(flags, "url") || requiredFlagValue(flags, "baseUrl"),
    token: requiredFlagValue(flags, "token"),
    fileRoot: fileRootValue(flags),
  });

  if (command === "create") {
    await createCommand(flags, client);
    return;
  }

  if (command === "status") {
    printResult(await client.status(), flags, textForStatus);
    return;
  }

  if (command === "open") {
    const code = positional[0] || requiredFlagValue(flags, "code");
    if (!code) throw new Error("Missing locker code.");
    const idempotencyKey = requiredFlagValue(flags, "idempotency-key")
      || requiredFlagValue(flags, "idempotencyKey");
    printResult(await client.openLocker(code, { idempotencyKey }), flags, textForOpen);
    return;
  }

  if (command === "download") {
    await downloadCommand(positional, flags, client);
    return;
  }

  if (command === "clear") {
    if (!flags.id) throw new Error("Missing --id.");
    if (!flags.code) throw new Error("Missing --code.");
    printResult(await client.clearLocker({
      id: requiredFlagValue(flags, "id"),
      code: requiredFlagValue(flags, "code"),
    }), flags, textForClear);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  if (error?.details?.idempotencyKey) {
    process.stderr.write(`idempotencyKey: ${error.details.idempotencyKey}\n`);
  }
  process.exitCode = 1;
});
