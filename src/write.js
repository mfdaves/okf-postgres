"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST = ".okf-producer.json";

function safeRelative(relativePath) {
  const value = String(relativePath).replace(/\\/g, "/");
  const normalized = path.posix.normalize(value);
  const segments = value.split("/");
  if (!value
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || !normalized.endsWith(".md")
    || normalized === MANIFEST) {
    throw new Error(`Unsafe generated path: ${relativePath}`);
  }
  return normalized;
}

function sha256(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function assertRoot(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Bundle output must be a real directory, not a file or symbolic link.");
  }
}

function assertNoSymlink(root, relativePath) {
  let cursor = path.resolve(root);
  for (const part of safeRelative(relativePath).split("/")) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`Generated path traverses a symbolic link: ${relativePath}`);
    }
    if (cursor !== path.join(root, relativePath) && !stat.isDirectory()) {
      throw new Error(`Generated path traverses a non-directory: ${relativePath}`);
    }
  }
}

function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function normalizeManifestFile(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Invalid ${MANIFEST}; refusing to change generated files.`);
  }
  const relativePath = safeRelative(entry.path);
  if (typeof entry.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`Invalid ${MANIFEST}; refusing to change generated files.`);
  }
  return { path: relativePath, sha256: entry.sha256 };
}

function readManifest(root) {
  const file = path.join(root, MANIFEST);
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`Invalid ${MANIFEST}; manifest cannot be a symbolic link.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${MANIFEST}; refusing to change generated files.`, { cause: error });
  }
  if (!parsed
    || parsed.version !== 1
    || typeof parsed.producer !== "string"
    || !parsed.producer
    || typeof parsed.producerVersion !== "string"
    || !parsed.producerVersion
    || typeof parsed.bundle !== "string"
    || !parsed.bundle
    || !Array.isArray(parsed.files)) {
    throw new Error(`Invalid ${MANIFEST}; refusing to change generated files.`);
  }
  const files = parsed.files.map(normalizeManifestFile);
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new Error(`Invalid ${MANIFEST}; duplicate owned paths are not allowed.`);
  }
  return { ...parsed, files };
}

function normalizeFiles(files) {
  if (!(files instanceof Map)) throw new TypeError("Generated files must be provided as a Map.");
  const normalized = new Map();
  files.forEach((content, filePath) => {
    const relativePath = safeRelative(filePath);
    if (normalized.has(relativePath)) throw new Error(`Duplicate generated path: ${relativePath}`);
    if (typeof content !== "string") throw new TypeError(`Generated file ${relativePath} must contain text.`);
    normalized.set(relativePath, content);
  });
  return new Map([...normalized].sort(([left], [right]) => left.localeCompare(right)));
}

function publicationIdentity(options) {
  const producer = String(options && options.producer || "").trim();
  const producerVersion = String(options && options.producerVersion || "").trim();
  const bundle = String(options && options.bundle || "").trim();
  if (!producer || !producerVersion || !bundle) {
    throw new Error("Publication requires producer, producerVersion, and bundle identifiers.");
  }
  return { producer, producerVersion, bundle };
}

function writeBundle(output, files, options = {}) {
  const root = path.resolve(output);
  const identity = publicationIdentity(options);
  const nextFiles = normalizeFiles(files);
  assertRoot(root);
  const previous = fs.existsSync(root) ? readManifest(root) : null;
  if (previous && (previous.producer !== identity.producer || previous.bundle !== identity.bundle)) {
    throw new Error(`${MANIFEST} belongs to a different producer or bundle.`);
  }

  const owned = new Map((previous ? previous.files : []).map((entry) => [entry.path, entry.sha256]));
  const nextPaths = new Set(nextFiles.keys());

  if (fs.existsSync(root)) {
    for (const [relativePath, expectedDigest] of owned) {
      assertNoSymlink(root, relativePath);
      const target = path.join(root, relativePath);
      if (!fs.existsSync(target)) {
        throw new Error(`Owned generated file is missing; refusing to continue: ${relativePath}`);
      }
      if (!fs.lstatSync(target).isFile() || sha256(fs.readFileSync(target)) !== expectedDigest) {
        throw new Error(`Owned generated file was modified; refusing to overwrite or remove it: ${relativePath}`);
      }
    }

    for (const relativePath of nextFiles.keys()) {
      assertNoSymlink(root, relativePath);
      const target = path.join(root, relativePath);
      if (fs.existsSync(target) && !owned.has(relativePath)) {
        throw new Error(`Generated path collides with an unowned file: ${relativePath}`);
      }
      if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) {
        throw new Error(`Generated path is not a regular file: ${relativePath}`);
      }
    }
  }

  const manifest = {
    version: 1,
    producer: identity.producer,
    producerVersion: identity.producerVersion,
    bundle: identity.bundle,
    files: [...nextFiles].map(([relativePath, content]) => ({
      path: relativePath,
      sha256: sha256(content),
    })),
  };
  const stale = [...owned.keys()].filter((relativePath) => !nextPaths.has(relativePath));

  fs.mkdirSync(root, { recursive: true });
  nextFiles.forEach((content, relativePath) => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, content);
  });
  let removed = 0;
  stale.forEach((relativePath) => {
    const target = path.join(root, relativePath);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed += 1;
    }
  });

  atomicWrite(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { output: root, files: nextFiles.size, removed };
}

module.exports = { MANIFEST, readManifest, safeRelative, sha256, writeBundle };
