import { createAgentClient } from "./agent-client.js";

const TOOL_DEFINITIONS = [
  {
    name: "lockernote_status",
    description: "Check LockerNote Agent API connectivity, limits, and supported capabilities.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "lockernote_create",
    description: "Create a temporary LockerNote locker with text, Markdown, JSON content, and optional local files.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        markdown: { type: "string" },
        json: {},
        files: {
          type: "array",
          items: { type: "string" },
          description: "Local file paths under LOCKERNOTE_MCP_FILE_ROOT, uploaded as temporary attachments.",
        },
        ttl: { type: "integer", enum: [10, 60, 1440] },
        ttlMinutes: { type: "integer", enum: [10, 60, 1440] },
        code: { type: "string", pattern: "^[A-Za-z0-9]{6}$" },
        deleteAfterOpen: { type: "boolean" },
        burnAfterReads: { type: "integer", minimum: 1, maximum: 20 },
        metadata: { type: "object", additionalProperties: true },
      },
      oneOf: [
        { required: ["text"] },
        { required: ["markdown"] },
        { required: ["json"] },
        { required: ["files"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "lockernote_open",
    description: "Open a LockerNote locker by 6-character locker code.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string", pattern: "^[A-Za-z0-9]{6}$" },
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lockernote_download",
    description: "Download all attachments from a LockerNote locker by code into a local directory.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string", pattern: "^[A-Za-z0-9]{6}$" },
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
        directory: {
          type: "string",
          description: "Local destination directory under LOCKERNOTE_MCP_FILE_ROOT. Defaults to the current directory.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lockernote_clear",
    description: "Clear a LockerNote locker before it expires.",
    inputSchema: {
      type: "object",
      required: ["id", "code"],
      properties: {
        id: { type: "string" },
        code: { type: "string", pattern: "^[A-Za-z0-9]{6}$" },
      },
      additionalProperties: false,
    },
  },
];

function jsonText(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function callTool(name, args, client) {
  if (name === "lockernote_status") {
    return jsonText(await client.status());
  }
  if (name === "lockernote_create") {
    const { files = [], ...input } = args || {};
    if (Array.isArray(files) && files.length && client.createLockerWithFiles) {
      return jsonText(await client.createLockerWithFiles(input, files));
    }
    return jsonText(await client.createLocker(input));
  }
  if (name === "lockernote_open") {
    return jsonText(await client.openLocker(args?.code, { idempotencyKey: args?.idempotencyKey }));
  }
  if (name === "lockernote_download") {
    return jsonText(await client.downloadLockerAttachments(args?.code, {
      directory: args?.directory || ".",
      idempotencyKey: args?.idempotencyKey,
    }));
  }
  if (name === "lockernote_clear") {
    return jsonText(await client.clearLocker(args || {}));
  }
  throw new Error(`Unknown tool: ${name}`);
}

function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function writeMessage(message, output = process.stdout, { framed = true } = {}) {
  if (framed) {
    output.write(encodeMessage(message));
    return;
  }
  output.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id, error) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error?.message || "LockerNote MCP error",
      data: error?.code ? { code: error.code, status: error.status, details: error.details } : undefined,
    },
  };
}

async function handleRequest(message, client) {
  const { id, method, params } = message;
  if (!id && id !== 0) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lockernote-mcp", version: "0.1.0" },
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOL_DEFINITIONS },
    };
  }

  if (method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id,
      result: await callTool(params?.name, params?.arguments || {}, client),
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

function headerEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) return { headerLength: crlf, bodyOffset: crlf + 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf !== -1) return { headerLength: lf, bodyOffset: lf + 2 };
  return null;
}

function removeLeadingWhitespace(buffer) {
  let offset = 0;
  while (offset < buffer.length && /\s/.test(String.fromCharCode(buffer[offset]))) offset += 1;
  return offset ? buffer.subarray(offset) : buffer;
}

async function processRawMessage(raw, client, output, options) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    writeMessage(errorResponse(null, error), output, options);
    return;
  }

  try {
    const response = await handleRequest(message, client);
    if (response) writeMessage(response, output, options);
  } catch (error) {
    writeMessage(errorResponse(message.id ?? null, error), output, options);
  }
}

function runMcpServer({ input = process.stdin, output = process.stdout, client = createAgentClient() } = {}) {
  process.stdout.on("error", (error) => {
    if (error && error.code === "EPIPE") process.exit(0);
  });
  let buffer = Buffer.alloc(0);
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;

    try {
      while (buffer.length > 0) {
        buffer = removeLeadingWhitespace(buffer);
        if (!buffer.length) break;

        const preview = buffer.toString("utf8", 0, Math.min(buffer.length, 32));
        if (/^Content-Length:/i.test(preview)) {
          const boundary = headerEnd(buffer);
          if (!boundary) break;

          const headers = buffer.subarray(0, boundary.headerLength).toString("utf8");
          const lengthMatch = /^Content-Length:\s*(\d+)\s*$/im.exec(headers);
          if (!lengthMatch) {
            writeMessage(errorResponse(null, new Error("Missing MCP Content-Length header.")), output);
            buffer = Buffer.alloc(0);
            break;
          }

          const contentLength = Number(lengthMatch[1]);
          const messageEnd = boundary.bodyOffset + contentLength;
          if (buffer.length < messageEnd) break;

          const raw = buffer.subarray(boundary.bodyOffset, messageEnd).toString("utf8");
          buffer = buffer.subarray(messageEnd);
          await processRawMessage(raw, client, output, { framed: true });
          continue;
        }

        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const raw = buffer.subarray(0, newline).toString("utf8").trim();
        buffer = buffer.subarray(newline + 1);
        if (raw) await processRawMessage(raw, client, output, { framed: false });
      }
    } finally {
      draining = false;
    }
  }

  input.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    drain();
  });
}

export {
  TOOL_DEFINITIONS,
  encodeMessage,
  handleRequest,
  runMcpServer,
};
