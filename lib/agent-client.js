import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DEFAULT_BASE_URL = "https://lockernote.com";

const MIME_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveBaseUrl(options = {}) {
  return trimTrailingSlash(
    options.baseUrl
      || process.env.LOCKERNOTE_API_URL
      || process.env.LOCKERNOTE_PUBLIC_URL
      || DEFAULT_BASE_URL,
  );
}

function resolveToken(options = {}) {
  return String(
    options.token
      || process.env.LOCKERNOTE_AGENT_TOKEN
      || process.env.AGENT_API_TOKEN
      || "",
  ).trim();
}

function resolveFileRoot(options = {}) {
  return path.resolve(String(
    options.fileRoot
      || process.env.LOCKERNOTE_FILE_ROOT
      || process.env.LOCKERNOTE_MCP_FILE_ROOT
      || process.cwd(),
  ));
}

function lockerNoteUrl(baseUrl, path) {
  return new URL(path, `${trimTrailingSlash(baseUrl)}/`);
}

function isInsidePath(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileBoundaryError(kind, root, target) {
  return new Error(`${kind} is outside LOCKERNOTE_MCP_FILE_ROOT (${root}): ${target}. Re-run with --file-root <dir> or set LOCKERNOTE_MCP_FILE_ROOT=<dir> to allow it.`);
}

async function resolveFileRootPath(fileRoot) {
  try {
    return await realpath(fileRoot);
  } catch {
    throw new Error(`LockerNote file root does not exist: ${fileRoot}`);
  }
}

async function resolveExistingPathPrefix(targetPath) {
  const missing = [];
  let current = path.resolve(targetPath);

  while (true) {
    try {
      return {
        realExistingPath: await realpath(current),
        missingSegments: missing.reverse(),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function resolveLocalFilePath(filePath, fileRoot = resolveFileRoot()) {
  const inputPath = String(filePath || "");
  if (!inputPath) throw new Error("Missing local file path.");

  const root = await resolveFileRootPath(fileRoot);

  const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath);
  const target = await realpath(path.resolve(candidate));
  if (!isInsidePath(root, target)) {
    throw fileBoundaryError("File", root, target);
  }
  return target;
}

async function resolveLocalDirectoryPath(directory = ".", fileRoot = resolveFileRoot()) {
  const inputPath = String(directory || ".");
  const root = await resolveFileRootPath(fileRoot);
  const candidate = path.resolve(path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath));
  const { realExistingPath, missingSegments } = await resolveExistingPathPrefix(candidate);
  if (!isInsidePath(root, realExistingPath)) {
    throw fileBoundaryError("Directory", root, realExistingPath);
  }

  const target = path.resolve(realExistingPath, ...missingSegments);
  if (!isInsidePath(root, target)) {
    throw fileBoundaryError("Directory", root, target);
  }

  await mkdir(target, { recursive: true });
  const realTarget = await realpath(target);
  if (!isInsidePath(root, realTarget)) {
    throw fileBoundaryError("Directory", root, realTarget);
  }
  return realTarget;
}

function cleanFileName(value) {
  const cleaned = String(value || "file")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[/\\?%*:|"<>()[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/(^|\s)\.+(?=\s|$)/g, " ")
    .replace(/\.{2,}/g, ".")
    .trim()
    .slice(0, 180)
    .trim();

  return cleaned || "file";
}

function sanitizeMimeType(value) {
  const type = String(value || "application/octet-stream").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream";
}

function mimeTypeForPath(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function attachmentKind(type) {
  const mime = sanitizeMimeType(type);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function attachmentMarkdown(attachment) {
  const name = cleanFileName(attachment.name);
  const type = sanitizeMimeType(attachment.type);
  const kind = attachment.kind || attachmentKind(type);
  const size = Number(attachment.size || 0);
  return `\n[locker-attachment:${attachment.id}|${kind}|${name}|${type}|${size}]\n`;
}

function contentFromInput(input = {}) {
  if (input.content != null) return String(input.content);
  if (input.text != null) return String(input.text);
  if (input.markdown != null) return String(input.markdown);
  if (input.json != null) return JSON.stringify(input.json, null, 2);
  return "";
}

function contentPayload(input = {}, content) {
  const payload = { ...input, content };
  delete payload.text;
  delete payload.markdown;
  delete payload.json;
  return payload;
}

function parseAttachmentMarkdown(content) {
  const attachments = [];
  const pattern = /\[locker-attachment:([a-f0-9]{32})\|([^\]|]*)\|([^\]|]*)\|([^\]|]*)\|([^\]|]*)(?:\|([^\]]+))?]/gi;
  for (const match of String(content || "").matchAll(pattern)) {
    attachments.push({
      id: match[1].toLowerCase(),
      kind: match[2] || "file",
      name: cleanFileName(match[3] || "file"),
      type: sanitizeMimeType(match[4]),
      size: Number(match[5] || 0),
      encrypted: Boolean(match[6]),
    });
  }
  return attachments;
}

async function writeUniqueFile(directory, fileName, bytes) {
  const parsed = path.parse(cleanFileName(fileName));
  const base = parsed.name || "attachment";
  const ext = parsed.ext || "";

  for (let index = 0; index < 1000; index += 1) {
    const candidateName = index === 0 ? `${base}${ext}` : `${base}-${index + 1}${ext}`;
    const candidatePath = path.join(directory, candidateName);
    try {
      await writeFile(candidatePath, bytes, { flag: "wx" });
      return candidatePath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  throw new Error(`Could not find a free filename for ${fileName}.`);
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  let body;
  try {
    body = contentType.includes("application/json")
      ? await response.json()
      : { error: await response.text() };
  } catch (cause) {
    const error = new Error("LockerNote returned an incomplete response.", { cause });
    error.code = "LOCKERNOTE_RESPONSE_INCOMPLETE";
    error.status = response.status;
    throw error;
  }
  if (response.ok) return body;

  const error = new Error(body.error || `LockerNote request failed with HTTP ${response.status}`);
  error.status = response.status;
  error.code = body.code || "LOCKERNOTE_REQUEST_FAILED";
  error.details = body.details || {};
  throw error;
}

class LockerNoteAgentClient {
  constructor(options = {}) {
    this.baseUrl = resolveBaseUrl(options);
    this.attachmentPublicOrigin = trimTrailingSlash(
      options.attachmentPublicOrigin || process.env.ATTACHMENT_PUBLIC_ORIGIN || "",
    );
    this.token = resolveToken(options);
    this.fileRoot = resolveFileRoot(options);
  }

  headers(extra = {}) {
    if (!this.token) {
      throw new Error("Missing AGENT_API_TOKEN or LOCKERNOTE_AGENT_TOKEN.");
    }
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  resolveLocalFilePath(filePath) {
    return resolveLocalFilePath(filePath, this.fileRoot);
  }

  async readLocalTextFile(filePath) {
    return readFile(await this.resolveLocalFilePath(filePath), "utf8");
  }

  async createLocker(input = {}) {
    const url = lockerNoteUrl(this.baseUrl, "/api/agent/lockers");
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    });
    return this.captureRuntimeConfig(await parseResponse(response));
  }

  async status() {
    const url = lockerNoteUrl(this.baseUrl, "/api/agent/status");
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    return this.captureRuntimeConfig(await parseResponse(response));
  }

  captureRuntimeConfig(payload) {
    if (payload?.attachmentPublicOrigin) {
      this.attachmentPublicOrigin = trimTrailingSlash(payload.attachmentPublicOrigin);
    }
    return payload;
  }

  async uploadAttachment(filePath) {
    const absolutePath = await this.resolveLocalFilePath(filePath);
    const bytes = await readFile(absolutePath);
    if (!bytes.length) throw new Error(`Attachment is empty: ${filePath}`);

    const name = cleanFileName(path.basename(absolutePath));
    const type = mimeTypeForPath(absolutePath);
    const url = lockerNoteUrl(this.baseUrl, "/api/attachments");
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers({
        "Content-Type": type,
        "X-File-Name": encodeURIComponent(name),
      }),
      body: bytes,
    });
    const result = await parseResponse(response);
    return result.attachment;
  }

  async deletePendingAttachment(id) {
    if (!id) return { ok: false };
    const url = lockerNoteUrl(this.baseUrl, `/api/attachments/${encodeURIComponent(id)}`);
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers(),
    });
    return parseResponse(response);
  }

  async createLockerWithFiles(input = {}, filePaths = []) {
    const paths = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [filePaths].filter(Boolean);
    if (!paths.length) return this.createLocker(input);

    const uploaded = [];
    try {
      for (const filePath of paths) {
        uploaded.push(await this.uploadAttachment(filePath));
      }

      const baseContent = contentFromInput(input).trimEnd();
      const attachmentContent = uploaded.map(attachmentMarkdown).join("");
      const content = [baseContent, attachmentContent.trim()].filter(Boolean).join("\n\n");
      const payload = contentPayload(input, content);
      payload.attachmentIds = uploaded.map((attachment) => attachment.id);
      const result = await this.createLocker(payload);
      return {
        ...result,
        attachments: uploaded,
      };
    } catch (error) {
      await Promise.allSettled(uploaded.map((attachment) => this.deletePendingAttachment(attachment.id)));
      throw error;
    }
  }

  async openLocker(code, { idempotencyKey = randomUUID() } = {}) {
    const url = lockerNoteUrl(this.baseUrl, "/api/agent/lockers");
    url.searchParams.set("code", code);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: this.headers({ "Idempotency-Key": idempotencyKey }),
        });
        const payload = await parseResponse(response);
        if (!payload?.locker || typeof payload.locker !== "object") {
          const error = new Error("LockerNote returned an invalid locker response.");
          error.code = "LOCKERNOTE_RESPONSE_INVALID";
          throw error;
        }
        return this.captureRuntimeConfig(payload);
      } catch (error) {
        error.details = { ...(error.details || {}), idempotencyKey };
        const retryable = !Number.isInteger(error.status)
          || error.status >= 500
          || ["BURN_READ_OUTCOME_UNKNOWN", "LOCKERNOTE_RESPONSE_INCOMPLETE", "LOCKERNOTE_RESPONSE_INVALID"]
            .includes(error.code);
        if (attempt === 0 && retryable) continue;
        throw error;
      }
    }
    throw new Error("LockerNote open retry exhausted.");
  }

  async downloadAttachment(attachment, { readToken = "", code = "", directory = "." } = {}) {
    const outputDirectory = await resolveLocalDirectoryPath(directory, this.fileRoot);
    const attachmentBaseUrl = this.attachmentPublicOrigin || this.baseUrl;
    const url = lockerNoteUrl(attachmentBaseUrl, `/api/attachments/${encodeURIComponent(attachment.id)}`);
    if (readToken) url.searchParams.set("readToken", readToken);
    else if (code) url.searchParams.set("code", code);

    const response = await fetch(url);
    if (!response.ok) await parseResponse(response);

    const bytes = Buffer.from(await response.arrayBuffer());
    const filePath = await writeUniqueFile(outputDirectory, attachment.name, bytes);
    return {
      ...attachment,
      path: filePath,
      downloadedBytes: bytes.length,
    };
  }

  async downloadLockerAttachments(code, { directory = ".", idempotencyKey = randomUUID() } = {}) {
    const outputDirectory = await resolveLocalDirectoryPath(directory, this.fileRoot);
    const opened = await this.openLocker(code, { idempotencyKey });
    const attachments = parseAttachmentMarkdown(opened.locker?.content || "");
    const downloaded = [];
    for (const attachment of attachments) {
      downloaded.push(await this.downloadAttachment(attachment, {
        readToken: opened.readSession?.token || "",
        code,
        directory: outputDirectory,
      }));
    }
    return {
      locker: opened.locker,
      id: opened.id,
      code,
      directory: outputDirectory,
      attachments: downloaded,
    };
  }

  async clearLocker({ id, code }) {
    if (!id) throw new Error("Missing locker id.");
    const url = lockerNoteUrl(this.baseUrl, `/api/agent/lockers/${encodeURIComponent(id)}`);
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ code }),
    });
    return parseResponse(response);
  }
}

function createAgentClient(options = {}) {
  return new LockerNoteAgentClient(options);
}

export {
  LockerNoteAgentClient,
  createAgentClient,
  parseAttachmentMarkdown,
  resolveBaseUrl,
  resolveFileRoot,
  resolveLocalDirectoryPath,
  resolveLocalFilePath,
  resolveToken,
};
