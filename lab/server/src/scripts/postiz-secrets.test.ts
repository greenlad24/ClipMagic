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
  const { getSettings, updateSettings, buildEnvFileContents, POSTIZ_KEY_DEFS, getPostizApiKey, getPostPeerApiKey } = mod;

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

  // ── native-name translation (the bug that broke localhost:5000) ──────────────
  await check("POSTIZ_URL is translated to MAIN_URL/FRONTEND_URL/NEXT_PUBLIC_BACKEND_URL", () => {
    const text = buildEnvFileContents({ POSTIZ_URL: "http://139.59.250.178:5000/" });
    // trailing slash stripped; /api appended only for the backend URL
    assert.ok(text.includes(`MAIN_URL='http://139.59.250.178:5000'`), `MAIN_URL missing: ${text}`);
    assert.ok(text.includes(`FRONTEND_URL='http://139.59.250.178:5000'`), "FRONTEND_URL missing");
    assert.ok(
      text.includes(`NEXT_PUBLIC_BACKEND_URL='http://139.59.250.178:5000/api'`),
      "NEXT_PUBLIC_BACKEND_URL missing/incorrect",
    );
  });

  await check("POSTIZ_JWT_SECRET is also emitted as native JWT_SECRET", () => {
    const text = buildEnvFileContents({ POSTIZ_JWT_SECRET: SECRET });
    assert.ok(text.includes(`JWT_SECRET='${SECRET}'`), "native JWT_SECRET missing");
  });

  await check("POSTIZ_DISABLE_REGISTRATION is emitted as native DISABLE_REGISTRATION", () => {
    const text = buildEnvFileContents({ POSTIZ_DISABLE_REGISTRATION: "true" });
    assert.ok(text.includes(`DISABLE_REGISTRATION='true'`), "native DISABLE_REGISTRATION missing");
  });

  await check("Postgres password is NOT translated to DATABASE_URL (would break live DB)", () => {
    const text = buildEnvFileContents({ POSTIZ_POSTGRES_PASSWORD: SECRET });
    assert.ok(!text.includes("DATABASE_URL"), "DATABASE_URL must not be emitted from the UI");
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

  // ── POSTIZ_API_KEY: write-only + server-only getter + NOT in Postiz env ──────
  const API_KEY = "postiz-public-api-key-abcdef-9999";

  await check("POSTIZ_API_KEY value never leaks via getSettings/updateSettings", () => {
    delete process.env.POSTIZ_API_KEY; // ensure we test the STORE path, not env
    const responses = [
      JSON.stringify(updateSettings({ values: { POSTIZ_API_KEY: API_KEY } })),
      JSON.stringify(getSettings()),
    ];
    for (const r of responses) {
      assert.ok(!r.includes(API_KEY), "a response leaked the Postiz API key");
    }
  });

  await check("POSTIZ_API_KEY is reported configured after save", () => {
    const s = getSettings();
    const k = s.keys.find((x) => x.key === "POSTIZ_API_KEY");
    assert.equal(k?.configured, true);
  });

  await check("getPostizApiKey() returns the raw value for server-side use only", () => {
    delete process.env.POSTIZ_API_KEY;
    assert.equal(getPostizApiKey(), API_KEY);
  });

  await check("POSTIZ_API_KEY is NOT emitted into the Postiz container env file", () => {
    // It's used by the lab server, not by Postiz — must never reach postiz.env.
    const text = buildEnvFileContents({ POSTIZ_API_KEY: API_KEY, POSTIZ_JWT_SECRET: SECRET });
    assert.ok(!text.includes("POSTIZ_API_KEY"), "POSTIZ_API_KEY leaked into the Postiz env file");
    assert.ok(text.includes("POSTIZ_JWT_SECRET="), "other keys should still be emitted");
  });

  await check("env var POSTIZ_API_KEY takes precedence over the store", () => {
    process.env.POSTIZ_API_KEY = "from-env-override";
    assert.equal(getPostizApiKey(), "from-env-override");
    delete process.env.POSTIZ_API_KEY;
  });

  // ── POSTPEER_API_KEY: write-only + server-only getter + NOT in Postiz env ────
  const POSTPEER_KEY = "postpeer-api-key-zzz-7777";

  await check("POSTPEER_API_KEY is in the registry under the Bulk Scheduler group", () => {
    const def = POSTIZ_KEY_DEFS.find((d) => d.key === "POSTPEER_API_KEY");
    assert.ok(def, "POSTPEER_API_KEY missing from the registry");
    assert.equal(def?.group, "Bulk Scheduler");
  });

  await check("POSTPEER_API_KEY value never leaks via getSettings/updateSettings", () => {
    delete process.env.POSTPEER_API_KEY; // test the STORE path, not env
    const responses = [
      JSON.stringify(updateSettings({ values: { POSTPEER_API_KEY: POSTPEER_KEY } })),
      JSON.stringify(getSettings()),
    ];
    for (const r of responses) {
      assert.ok(!r.includes(POSTPEER_KEY), "a response leaked the PostPeer API key");
    }
  });

  await check("POSTPEER_API_KEY is reported configured after save", () => {
    const s = getSettings();
    const k = s.keys.find((x) => x.key === "POSTPEER_API_KEY");
    assert.equal(k?.configured, true);
  });

  await check("getPostPeerApiKey() returns the raw value for server-side use only", () => {
    delete process.env.POSTPEER_API_KEY;
    assert.equal(getPostPeerApiKey(), POSTPEER_KEY);
  });

  await check("POSTPEER_API_KEY is NOT emitted into the Postiz container env file", () => {
    // It's used by the lab server (PostPeer client), not by Postiz.
    const text = buildEnvFileContents({ POSTPEER_API_KEY: POSTPEER_KEY, POSTIZ_JWT_SECRET: SECRET });
    assert.ok(!text.includes("POSTPEER_API_KEY"), "POSTPEER_API_KEY leaked into the Postiz env file");
    assert.ok(text.includes("POSTIZ_JWT_SECRET="), "other keys should still be emitted");
  });

  await check("env var POSTPEER_API_KEY takes precedence over the store", () => {
    process.env.POSTPEER_API_KEY = "pp-env-override";
    assert.equal(getPostPeerApiKey(), "pp-env-override");
    delete process.env.POSTPEER_API_KEY;
  });

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });

  console.log(`\n${passed} checks passed`);
}

void main();
