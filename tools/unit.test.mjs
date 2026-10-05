/**
 * Unit tests for dsh-proxy-zero's pure logic.
 *
 * Run with any Node 20+ — no Harness runtime, no network, no subprocess:
 *
 *   node --test tools/unit.test.mjs
 *
 * Why this file exists next to `verify.mjs`: `verify.mjs` proves the
 * *integration* — that loading the plugin really installs
 * `@deepseek-ai/dsh-http-proxy` and that unloading restores it — but it needs the
 * Electron runtime, an absolute install path and a hand-passed argument.
 * Everything here is a pure function, so the parsing rules — the part that
 * silently gets a proxy or bypass list wrong — stay covered by an ordinary
 * `node --test` run, including inside a restricted sandbox.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
	composeNoProxy,
	describeWindowsProxy,
	discoverProxy,
	normalizeProxyUrl,
	parseProxyServer,
	parseRegistryValues,
	readWindowsSystemProxy,
} from "../index.js";

/**
 * A Cordis-context stub whose `launchEnvironment` service answers like the launcher's.
 *
 * The real service exposes a `get(name)` returning a record, and the context itself
 * exposes `get("launchEnvironment")` returning that service — so the stub has to
 * nest the same way to exercise the plugin's lookup honestly.
 *
 * @param values - the snapshot's own values, keyed by name.
 * @param includeProcess - whether the snapshot's process layer also answers (the
 *   launcher's real layering: an exported variable is the most trusted layer).
 * @returns a context stub.
 */
const snapshotContext = (values, includeProcess) => ({
	get: () => ({
		get: (name) => {
			const value = includeProcess && process.env[name] !== undefined ? process.env[name] : values[name];
			return value === undefined ? undefined : { value, source: includeProcess ? "process" : "user-env" };
		},
	}),
});

/** A context reporting a snapshot-only value, as when it came from `$DSH_HOME/.env`. */
const snapshotOnlyContext = (values) => snapshotContext(values, false);

/** Whether two environment names denote the same variable on this platform. */
const sameEnvName = (a, b) => (process.platform === "win32" ? a.toUpperCase() === b.toUpperCase() : a === b);

/** A context with no launch-environment service at all. */
const plainContext = {};

const NO_PROXY_NAMES = ["no_proxy", "NO_PROXY"];
const PROXY_NAMES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];

/**
 * Run `body` with exactly the named variables set, clearing every other proxy
 * name so a developer's own shell cannot decide the outcome.
 *
 * @param values - name to value to set for the duration.
 * @param body - the assertions to run.
 */
const withCleanEnv = (values, body) => {
	const names = [...PROXY_NAMES, ...NO_PROXY_NAMES];
	const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	Object.assign(process.env, values);
	try {
		return body();
	} finally {
		for (const name of names) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	}
};

/**
 * Assert that a single exported name is discovered and reported truthfully.
 *
 * Windows looks environment names up case-insensitively, so `process.env.https_proxy
 * = x` also answers to `HTTPS_PROXY` and the *name* in `source` cannot tell the two
 * branches apart there. What is load-bearing — both spellings are reachable, the
 * value is right, and the named source is one this platform could have read — is
 * asserted on every platform.
 *
 * @param set - the environment name to set for the duration.
 * @param expectedSource - the name discovery is expected to report.
 */
const assertDiscoverySource = (set, expectedSource) => {
	withCleanEnv({ [set]: "http://127.0.0.1:1111" }, () => {
		const found = discoverProxy(plainContext, {});
		assert.equal(found.url, "http://127.0.0.1:1111");
		const reported = found.source.replace(/^env:/, "");
		assert.equal(sameEnvName(reported, expectedSource) || sameEnvName(reported, set), true, `unexpected source ${found.source}`);
	});
};

test("normalizeProxyUrl accepts only http(s) and drops path and query", () => {
	assert.equal(normalizeProxyUrl("127.0.0.1:7897"), "http://127.0.0.1:7897");
	assert.equal(normalizeProxyUrl("http://user:secret@proxy.local:8080"), "http://user:secret@proxy.local:8080");
	assert.equal(normalizeProxyUrl("  https://proxy.local:8443  "), "https://proxy.local:8443");
	// A PAC-style path is not part of a proxy URL, and must not survive into one.
	assert.equal(normalizeProxyUrl("http://proxy.local:8080/proxy.pac?x=1"), "http://proxy.local:8080");
	assert.equal(normalizeProxyUrl("socks5://127.0.0.1:1080"), undefined);
	assert.equal(normalizeProxyUrl("ftp://proxy.local:21"), undefined);
	assert.equal(normalizeProxyUrl(""), undefined);
	assert.equal(normalizeProxyUrl("   "), undefined);
	assert.equal(normalizeProxyUrl(undefined), undefined);
	assert.equal(normalizeProxyUrl("http://"), undefined);
});

test("parseProxyServer handles both shapes Windows writes", () => {
	assert.equal(parseProxyServer("127.0.0.1:7897"), "http://127.0.0.1:7897");
	assert.equal(parseProxyServer("https=h:1;http=h:2"), "http://h:1");
	assert.equal(parseProxyServer("http=h:2;https=h:1"), "http://h:1");
	assert.equal(parseProxyServer("http=h:2"), "http://h:2");
	assert.equal(parseProxyServer(""), undefined);
	assert.equal(parseProxyServer(undefined), undefined);
	// A SOCKS-only slot has no http(s) answer; the caller reports it separately.
	assert.equal(parseProxyServer("socks=h:3"), undefined);
});

test("composeNoProxy merges every layer, honours all three separators, and dedupes by case", () => {
	assert.equal(composeNoProxy("a.com"), "a.com,localhost,127.0.0.1,::1,[::1]");
	// Spaces (curl/Node) and semicolons (Windows) separate entries just like commas.
	assert.equal(composeNoProxy("a.com b.com;c.com"), "a.com,b.com,c.com,localhost,127.0.0.1,::1,[::1]");
	// An inherited list is additive: this is the regression the merge exists to prevent.
	assert.equal(
		composeNoProxy("configured.com", undefined, "*.corp.example,10.0.0.0/8"),
		"configured.com,*.corp.example,10.0.0.0/8,localhost,127.0.0.1,::1,[::1]",
	);
	assert.equal(composeNoProxy(["LOCALHOST", "localhost"]), "LOCALHOST,127.0.0.1,::1,[::1]");
	assert.equal(composeNoProxy(), "localhost,127.0.0.1,::1,[::1]");
	assert.equal(composeNoProxy(undefined, null, ""), "localhost,127.0.0.1,::1,[::1]");
});

test("parseRegistryValues reads a reg query dump and ignores everything else", () => {
	const dump = [
		"",
		"HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
		"    DisableCachingOfSSLPages    REG_DWORD    0x0",
		"    ProxyEnable    REG_DWORD    0x1",
		"    ProxyOverride    REG_SZ    localhost;127.*;<local>",
		"    ProxyServer    REG_SZ    127.0.0.1:7897",
		"    LockDatabase    REG_QWORD    0x1dbadac90c189b3",
		"",
		"HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\5.0",
		"",
	].join("\r\n");
	const values = parseRegistryValues(dump);
	assert.equal(values.ProxyEnable, "0x1");
	assert.equal(values.ProxyServer, "127.0.0.1:7897");
	assert.equal(values.ProxyOverride, "localhost;127.*;<local>");
	// The subkey listing line has no value shape and must not become an entry.
	assert.equal(Object.keys(values).includes("5.0"), false);
	assert.deepEqual(parseRegistryValues(""), {});
});

test("describeWindowsProxy translates ProxyOverride into a usable bypass list", () => {
	const live = describeWindowsProxy("127.0.0.1:7897", "localhost;127.*;192.168.*;10.*;172.16.*;172.31.*;<local>");
	assert.equal(live.status, "ok");
	assert.equal(live.url, "http://127.0.0.1:7897");
	// Windows prefix wildcards become CIDR, the notation Node's own NO_PROXY reader knows.
	// The block size follows the number of octets Windows wrote: `10.*` is all of 10/8.
	assert.deepEqual(live.bypass, [
		"localhost",
		"127.0.0.0/8",
		"192.168.0.0/16",
		"10.0.0.0/8",
		"172.16.0.0/16",
		"172.31.0.0/16",
	]);
	// `<local>` cannot be expressed by any bypass list, so it is reported, not dropped silently.
	assert.deepEqual(live.unsupported, ["<local>"]);

	assert.equal(describeWindowsProxy("http=a:1;https=b:2", "").url, "http://b:2");
	assert.equal(describeWindowsProxy("http=a:1;https=b:2", "").bypass.length, 0);
	// A SOCKS slot is reported instead of being flattened into "no proxy at all".
	assert.equal(describeWindowsProxy("socks=127.0.0.1:1080", "").status, "socks");
	assert.equal(describeWindowsProxy("socks=127.0.0.1:1080", "").url, undefined);
	assert.equal(describeWindowsProxy(undefined, undefined).status, "none");
	assert.equal(describeWindowsProxy("", "").status, "none");
});

test("readWindowsSystemProxy reports a status and never throws", () => {
	const result = readWindowsSystemProxy();
	assert.ok(["ok", "socks", "none"].includes(result.status), `unexpected status ${result.status}`);
	assert.ok(Array.isArray(result.bypass));
	assert.ok(Array.isArray(result.unsupported));
	// This machine has ProxyEnable=0, so the read must not fabricate a proxy.
	if (process.platform === "win32") assert.equal(result.url, undefined);
});

test("discoverProxy prefers config, then the environment in undici's order", () => {
	withCleanEnv({}, () => {
		assert.equal(discoverProxy(plainContext, {}).url, undefined);
		assert.equal(discoverProxy(plainContext, {}).source, "none");

		const configured = discoverProxy(plainContext, { proxyUrl: "http://127.0.0.1:7897" });
		assert.equal(configured.url, "http://127.0.0.1:7897");
		assert.equal(configured.source, "config");

		const invalid = discoverProxy(plainContext, { proxyUrl: "socks5://127.0.0.1:1080" });
		assert.equal(invalid.url, undefined);
		assert.equal(invalid.source, "config-invalid:socks5://127.0.0.1:1080");

		// Both spellings are reachable, and the reported source names the one read.
		assertDiscoverySource("https_proxy", "https_proxy");
		assertDiscoverySource("HTTPS_PROXY", "HTTPS_PROXY");

		// The launcher's snapshot answers even when process.env carries nothing.
		const fromSnapshot = discoverProxy(snapshotOnlyContext({ HTTPS_PROXY: "http://127.0.0.1:3333" }), {});
		assert.equal(fromSnapshot.url, "http://127.0.0.1:3333");
		assert.equal(fromSnapshot.source, "env:HTTPS_PROXY");
	});
});

test("discoverProxy carries an inherited bypass list through to the caller", () => {
	withCleanEnv({ NO_PROXY: "*.corp.example" }, () => {
		const found = discoverProxy(plainContext, { proxyUrl: "http://127.0.0.1:7897" });
		assert.equal(found.inherited, "*.corp.example");
		assert.equal(composeNoProxy(undefined, found.bypass, found.inherited).startsWith("*.corp.example"), true);
	});
	// A snapshot-only bypass list is inherited as well, with an empty environment.
	withCleanEnv({}, () => {
		const fromSnapshot = discoverProxy(snapshotOnlyContext({ NO_PROXY: "only.in.snapshot" }), { proxyUrl: "http://127.0.0.1:7897" });
		assert.equal(fromSnapshot.inherited, "only.in.snapshot");
	});
});
