"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MANIFEST, readManifest, sha256, writeBundle } = require("../src/write");

const identity = {
  producer: "postgresql",
  producerVersion: "0.1.0",
  bundle: "shop",
};

test("publication removes stale owned files and preserves hand-authored files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeBundle(root, new Map([
    ["index.md", "first index\n"],
    ["tables/public/old.md", "old\n"],
  ]), identity);
  fs.writeFileSync(path.join(root, "notes.md"), "user owned\n", "utf8");

  const result = writeBundle(root, new Map([["index.md", "second index\n"]]), identity);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(path.join(root, "tables/public/old.md")), false);
  assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf8"), "user owned\n");
  assert.equal(fs.readFileSync(path.join(root, "index.md"), "utf8"), "second index\n");

  const manifest = readManifest(root);
  assert.equal(manifest.producer, "postgresql");
  assert.equal(manifest.producerVersion, "0.1.0");
  assert.equal(manifest.bundle, "shop");
  assert.deepEqual(manifest.files, [{ path: "index.md", sha256: sha256("second index\n") }]);
});

test("publication rejects escaping paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => writeBundle(root, new Map([["../escape.md", "bad\n"]]), identity),
    /Unsafe generated path/,
  );
  assert.throws(
    () => writeBundle(root, new Map([[".git/config.md", "bad\n"]]), identity),
    /Unsafe generated path/,
  );
  assert.throws(
    () => writeBundle(root, new Map([["assets/catalog.json", "bad\n"]]), identity),
    /Unsafe generated path/,
  );
});

test("first publication refuses to overwrite an unowned generated path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "index.md"), "hand authored\n", "utf8");

  assert.throws(
    () => writeBundle(root, new Map([["index.md", "generated\n"]]), identity),
    /collides with an unowned file: index\.md/,
  );
  assert.equal(fs.readFileSync(path.join(root, "index.md"), "utf8"), "hand authored\n");
  assert.equal(fs.existsSync(path.join(root, MANIFEST)), false);
});

test("publication preflight refuses modified owned files before any write", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeBundle(root, new Map([
    ["index.md", "first index\n"],
    ["tables/public/old.md", "owned old\n"],
  ]), identity);
  fs.writeFileSync(path.join(root, "tables/public/old.md"), "manually changed\n", "utf8");

  assert.throws(
    () => writeBundle(root, new Map([["index.md", "second index\n"]]), identity),
    /Owned generated file was modified.*tables\/public\/old\.md/,
  );
  assert.equal(fs.readFileSync(path.join(root, "index.md"), "utf8"), "first index\n");
  assert.equal(fs.readFileSync(path.join(root, "tables/public/old.md"), "utf8"), "manually changed\n");
});

test("publication treats a missing manifest-owned file as a modification", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeBundle(root, new Map([
    ["index.md", "first index\n"],
    ["tables/public/old.md", "owned old\n"],
  ]), identity);
  fs.unlinkSync(path.join(root, "tables/public/old.md"));

  assert.throws(
    () => writeBundle(root, new Map([["index.md", "second index\n"]]), identity),
    /Owned generated file is missing.*tables\/public\/old\.md/,
  );
  assert.equal(fs.readFileSync(path.join(root, "index.md"), "utf8"), "first index\n");
});

test("a forged manifest cannot claim hidden control-plane paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-write-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({
    version: 1,
    producer: "postgresql",
    producerVersion: "0.1.0",
    bundle: "shop",
    files: [{ path: ".git/config", sha256: sha256("owned\n") }],
  }), "utf8");

  assert.throws(() => readManifest(root), /Unsafe generated path/);
});
