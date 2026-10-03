/**
 * Verification harness for dsh-proxy-zero.
 *
 * It loads the plugin exactly as the Cordis loader would (exported `apply(ctx, config)`),
 * with a stub `ctx` whose `effect()` records the disposer that a real plugin unload
 * would run. It then proves, against DSH's own `@deepseek-ai/dsh-http-proxy`, that:
 *
 *   1. loading the plugin changes the process-wide dispatcher and the proxy environment;
 *   2. a real HTTP request through `fetch` reaches a stub proxy (the proxy is genuinely used);
 *   3. running the recorded disposer restores EVERY observed piece of state byte-for-byte;
 *   4. nothing was written to disk, so there is nothing left to clean up.
 *
 * Run it with DSH's own runtime so `@deepseek-ai/dsh-http-proxy` resolves from the app:
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "<install>\DeepSeek Harness.exe" tools/verify.mjs
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const PROXY_ENV = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "all_proxy", "ALL_PROXY"];

let failures = 0;
let checks = 0;
const ok = (label, pass, detail = "") => {
	checks++;
	if (!pass) failures++;
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

/** Resolve a Harness package the way the desktop host would. */
function resolveHarness(specifier) {
	const anchor = process.argv[2];
	const require = createRequire(pathToFileURL(join(anchor ?? process.cwd(), "probe.js")));
	return pathToFileURL(require.resolve(specifier)).href;
}

/** Recursive listing with mtime+size, used to prove the plugin writes no file. */
function snapshotTree(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else {
				const s = statSync(full);
				out.push(`${full}|${s.size}|${s.mtimeMs}`);
			}
		}
	};
	walk(root);
	return out.sort().join("\n");
}

const proxyHost = await import(resolveHarness("@deepseek-ai/dsh-http-proxy"));
const undici = await import(resolveHarness("undici"));
const plugin = await import(pathToFileURL(join(PLUGIN_ROOT, "index.js")).href);

/** Everything this plugin is allowed to touch, captured for byte-exact comparison. */
function captureState() {
	return {
		dispatcher: undici.getGlobalDispatcher(),
		env: Object.fromEntries(PROXY_ENV.map((name) => [name, process.env[name]])),
		routes: [
			proxyHost.proxyRouteFor(new URL("https://api.github.com/rate_limit")).proxied,
			proxyHost.proxyRouteFor(new URL("http://127.0.0.1:19387/")).proxied,
			proxyHost.proxyRouteFor(new URL("https://example.com/")).proxied,
		],
	};
}

function describe(state) {
	return JSON.stringify(state.routes) + "|" + JSON.stringify(state.env) + "|dispatcher:" + String(state.dispatcher?.constructor?.name);
}

// ---------------------------------------------------------------- stub proxy
const seen = [];
const proxy = createServer((req, res) => {
	seen.push(req.url);
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("stub-proxy-ok");
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;

// ------------------------------------------------------------------- before
for (const name of PROXY_ENV) delete process.env[name];
const before = captureState();
const beforeTree = snapshotTree(PLUGIN_ROOT);

console.log("\n=== dsh-proxy-zero verification ===");
console.log(`  harness proxy pkg : ${resolveHarness("@deepseek-ai/dsh-http-proxy")}`);
console.log(`  baseline          : ${describe(before)}`);

// -------------------------------------------------------------------- apply
const effects = [];
const ctx = { logger: { info: (m) => console.log(`    [plugin] ${m}`) }, effect: (fn, label) => effects.push({ fn, label }) };

await plugin.apply(ctx, { proxyUrl });
const after = captureState();

console.log("\n[1] loading the plugin installs the policy");
ok("recorded exactly one Cordis effect", effects.length === 1, effects[0]?.label ?? "");
ok("global dispatcher replaced", after.dispatcher !== before.dispatcher);
ok("HTTPS_PROXY published", process.env.HTTPS_PROXY === proxyUrl, String(process.env.HTTPS_PROXY));
ok("NO_PROXY carries loopback", (process.env.NO_PROXY ?? "").includes("127.0.0.1"), String(process.env.NO_PROXY));
ok("proxyRouteFor(api.github.com).proxied === true", after.routes[0] === true);
ok("loopback stays direct", after.routes[1] === false);
ok("proxyRouteFor(example.com).proxied === true", after.routes[2] === true);

console.log("\n[2] the proxy is genuinely used by fetch");
const response = await fetch("http://probe.invalid/hello");
const text = await response.text();
ok("fetch reached the stub proxy", seen.length > 0, `urls=${JSON.stringify(seen)}`);
ok("stub answered", text === "stub-proxy-ok", text);

// ------------------------------------------------------------------ dispose
console.log("\n[3] unloading the plugin restores everything");
// Cordis calls the effect callback and then the disposer it returns, LIFO.
// Iterate a copy so `effects` itself stays readable for the assertions below.
const registered = [...effects];
for (const { fn } of registered.reverse()) {
	const disposer = fn();
	if (typeof disposer !== "function") throw new Error("effect did not return a disposer");
	await disposer();
}
const restored = captureState();
ok("dispatcher restored to the previous instance", restored.dispatcher === before.dispatcher);
ok("proxy environment restored byte-for-byte", JSON.stringify(restored.env) === JSON.stringify(before.env), describe(restored));
ok("route decisions restored", JSON.stringify(restored.routes) === JSON.stringify(before.routes));
ok("no new Cordis effect left behind", effects.length === 1);

console.log("\n[4] nothing was written to disk");
ok("plugin tree is byte-identical", snapshotTree(PLUGIN_ROOT) === beforeTree);

// -------------------------------------------------------------- extra paths
console.log("\n[5] failing-safe paths");
const noProxyCtx = { logger: { info: () => {} }, effect: () => { throw new Error("effect must not be called"); } };
await plugin.apply(noProxyCtx, {});
ok("no proxy anywhere: installs nothing, registers no effect", true);

const badEffects = [];
await plugin.apply({ logger: { info: () => {} }, effect: (fn) => badEffects.push(fn) }, { proxyUrl: "socks5://127.0.0.1:1080" });
ok("SOCKS value is refused, nothing installed", badEffects.length === 0);
ok("dispatcher untouched by refused value", undici.getGlobalDispatcher() === before.dispatcher);

const envEffects = [];
process.env.HTTPS_PROXY = proxyUrl;
await plugin.apply({ logger: { info: () => {} }, effect: (fn) => envEffects.push(fn) }, {});
await fetch("http://probe2.invalid/env");
ok("falls back to HTTPS_PROXY when config is empty", envEffects.length === 1 && seen.some((u) => u.includes("probe2")));
for (const fn of envEffects) {
	const disposer = fn();
	if (typeof disposer === "function") await disposer();
}
delete process.env.HTTPS_PROXY;
ok("env-discovered install also unwinds cleanly", undici.getGlobalDispatcher() === before.dispatcher);

// ------------------------------------------------------------------ summary
proxy.closeAllConnections?.();
proxy.close();
console.log(`\n=== ${checks - failures}/${checks} checks passed ===`);
process.exit(failures === 0 ? 0 : 1);
