/**
 * Unit checks for the WRITE-ONLY Postiz secrets store (settings/postizSecrets):
 *   - persistence is 0600 and survives reload
 *   - getSettings() / updateSettings() NEVER return a secret value (the core
 *     write-only guarantee) — asserted by scanning the entire JSON response
 *   - the shared env file is generated with correctly-escaped KEY='value' lines
 *   - update sets, empty-string leaves unchanged, null / remove deletes
 *
 * Runs against throwaway DATA_DIR + POSTIZ_CONFIG_DIR so it never touches real
 * lab data or the Docker volume. Run:
 *   cd lab/server && npx tsx src/scripts/postiz-secrets.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

async function main() {
  // Point data + config dirs at fresh temp dirs BEFORE importing the module.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-postiz-test-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-postiz-cfg-"));
  process.env.DATA_DIR = root;
  process.env.POSTIZ_CONFIG_DIR = configDir;
  // Ensure no real socket interferes with the dockerSocketAvailable check.
  process.env.DOCKER_SOCKET = path.join(configDir, "nonexistent.sock");

  const mod = await import("../settings/postizSecrets.js");
  const { getSettings, updateSettings, buildEnvFileContents, POSTIZ_KEY_DEFS } = mod;

  const SECRET = "super-secret-jwt-value-1234567890";
  const storePath = path.join(path.resolve(root), "postiz-settings.json");
  const envPath = path.join(configDir, "postiz.env");

  // ── initial state: nothing configured, no values leaked ──────────────────────
  await check("getSettings reports all keys not-configured initially", () => {
    const s = getSettings();
    assert.ok(s.keys.length === POSTIZ_KEY_DEFS.length);
    assert.ok(s.keys.every((k) => k.configured === false));
  });

  // ── set a key ─────────────────────────────────────────────────────────────────
  await check("updateSettings sets a key and reports it configured", () => {
    const r = updateSettings({ values: { POSTIZ_JWT_SECRET: SECRET } });
    const jwt = r.keys.find((k) => k.key === "POSTIZ_JWT_SECRET");
    assert.equal(jwt?.configured, true);
  });

  // ── WRITE-ONLY GUARANTEE: the value must NEVER appear in any response ─────────
  await check("no endpoint response contains the secret value (write-only)", () => {
    const responses = [
      JSON.stringify(getSettings()),
      JSON.stringify(updateSettings({ values: { X_API_KEY: SECRET } })),
    ];
    for (const r of responses) {
      assert.ok(!r.includes(SECRET), "a response leaked the secret value");
    }
  });

  // ── persistence: 0600 + survives reload ──────────────────────────────────────
  await check("store file is written 0600", () => {
    const mode = fs.statSync(storePath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  await check("stored value survives a fresh read (round-trips on disk)", () => {
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.equal(onDisk.POSTIZ_JWT_SECRET, SECRET);
  });

  // ── env-file generation ───────────────────────────────────────────────────────
  await check("env file is written 0600 with correct KEY='value' lines", () => {
    const mode = fs.statSync(envPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    const text = fs.readFileSync(envPath, "utf8");
    assert.ok(text.includes(`POSTIZ_JWT_SECRET='${SECRET}'`), "JWT line missing/incorrect");
    assert.ok(text.includes(`X_API_KEY='${SECRET}'`), "X_API_KEY line missing/incorrect");
  });

  await check("env-file generation escapes embedded single quotes safely", () => {
    const tricky = `it's a "test" $VAR`;
    const text = buildEnvFileContents({ POSTIZ_JWT_SECRET: tricky });
    // sh-safe single-quote escaping: ' becomes '\'' inside the quoted value.
    assert.ok(text.includes(`POSTIZ_JWT_SECRET='it'\\''s a "test" $VAR'`), `bad escaping: ${text}`);
  });

  await check("env-file only includes configured keys", () => {
    const text = buildEnvFileContents({ POSTIZ_JWT_SECRET: SECRET });
    assert.ok(text.includes("POSTIZ_JWT_SECRET="));
    assert.ok(!text.includes("X_API_KEY="));
  });

  // ── empty string = unchanged ──────────────────────────────────────────────────
  await check("empty string leaves an existing key unchanged (no accidental wipe)", () => {
    const r = updateSettings({ values: { POSTIZ_JWT_SECRET: "" } });
    const jwt = r.keys.find((k) => k.key === "POSTIZ_JWT_SECRET");
    assert.equal(jwt?.configured, true, "empty string wiped a configured key");
  });

  await check("whitespace-only string is treated as unchanged", () => {
    const r = updateSettings({ values: { POSTIZ_JWT_SECRET: "   " } });
    const jwt = r.keys.find((k) => k.key === "POSTIZ_JWT_SECRET");
    assert.equal(jwt?.configured, true);
  });

  // ── remove ──────────────────────────────────────────────────────────────────────
  await check("remove deletes a key and drops it from the env file", () => {
    const r = updateSettings({ remove: ["X_API_KEY"] });
    const x = r.keys.find((k) => k.key === "X_API_KEY");
    assert.equal(x?.configured, false);
    const text = fs.readFileSync(envPath, "utf8");
    assert.ok(!text.includes("X_API_KEY="), "removed key still in env file");
  });

  await check("null value also removes a key", () => {
    updateSettings({ values: { POSTIZ_JWT_SECRET: SECRET } });
    const r = updateSettings({ values: { POSTIZ_JWT_SECRET: null as unknown as string } });
    const jwt = r.keys.find((k) => k.key === "POSTIZ_JWT_SECRET");
    assert.equal(jwt?.configured, false);
  });

  // ── unknown keys are ignored ──────────────────────────────────────────────────
  await check("unknown keys are ignored (never persisted)", () => {
    const r = updateSettings({ values: { NOT_A_REAL_KEY: "x" } as Record<string, string> });
    assert.ok(!r.keys.some((k) => k.key === "NOT_A_REAL_KEY"));
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.ok(!("NOT_A_REAL_KEY" in onDisk));
  });

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });

  console.log(`\n${passed} checks passed`);
}

void main();
