/**
 * Zero-residue proxy support for DeepSeek Harness.
 *
 * This module is deliberately small and dependency-free. It does exactly three
 * things, and it does all of them inside the live Cordis process:
 *
 *   1. Discover a proxy: an explicit `proxyUrl` in this plugin's config, else the
 *      proxy environment the launcher already resolved (including the user-owned
 *      `$DSH_HOME/.env` layer), else the Windows system proxy when it is enabled.
 *   2. Ask the Harness's own `@deepseek-ai/dsh-http-proxy` to install that policy
 *      process-wide, so `fetch`, `web_fetch`'s route lookup, and the proxy
 *      environment handed to spawned tools all agree on one answer.
 *   3. Register the returned disposer as a Cordis effect, so unloading this
 *      plugin restores the layer beneath it automatically.
 *
 * It writes no file, no registry key, no system setting and no child-process
 * environment of its own. See README.md for the full residue argument.
 *
 * Every import of a Harness module is dynamic and guarded: a static import that
 * fails to resolve on a future Harness version would take the whole profile down.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

export const name = "dsh-proxy-zero";

/** Name used in diagnostics. */
const LOG_NAME = "dsh-proxy-zero";

/**
 * Proxy names this plugin may consider, in precedence order.
 * @type {readonly string[]}
 */
const PROXY_ENV_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"];

/** Loopback is always direct, or the Web UI and local servers would loop. */
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Turn a candidate into a usable HTTP(S) proxy URL.
 *
 * Only `http:` and `https:` are accepted. A plain `host:port` gains `http://`.
 * A value this function rejects is never installed; it is reported instead.
 *
 * @param candidate - raw value from config, environment or registry.
 * @returns the normalized URL, or `undefined` when the value is unusable.
 */
export function normalizeProxyUrl(candidate) {
	const raw = String(candidate ?? "").trim();
	if (raw === "") return undefined;
	let url;
	try {
		url = new URL(raw.includes("://") ? raw : `http://${raw}`);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname === "") return undefined;
	const auth = url.username === "" ? "" : `${url.username}${url.password === "" ? "" : `:${url.password}`}@`;
	return `${url.protocol}//${auth}${url.host}`;
}

/**
 * Parse the two shapes Windows writes into `ProxyServer`.
 *
 * @param raw - `host:port`, or `http=host:port;https=host:port`.
 * @returns the normalized URL, or `undefined`.
 */
export function parseProxyServer(raw) {
	const text = String(raw ?? "").trim();
	if (text === "") return undefined;
	if (!text.includes("=")) return normalizeProxyUrl(text);
	const byScheme = new Map();
	for (const part of text.split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		byScheme.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
	}
	return normalizeProxyUrl(byScheme.get("https") ?? byScheme.get("http"));
}

/**
 * Read the enabled Windows system proxy.
 *
 * The system proxy only counts when `ProxyEnable` is `1`; a disabled setting
 * leaves us direct, matching what every other Windows program sees.
 *
 * @returns the normalized URL, or `undefined` when absent, disabled or unreadable.
 */
export function readWindowsSystemProxy() {
	if (process.platform !== "win32") return undefined;
	const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
	const regExe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
	const query = (name) => execFileSync(regExe, ["query", key, "/v", name], { encoding: "utf8", windowsHide: true });
	try {
		if (!/0x1\b/i.test(query("ProxyEnable"))) return undefined;
		return parseProxyServer(/ProxyServer\s+REG_SZ\s+(.+)/.exec(query("ProxyServer"))?.[1]);
	} catch {
		return undefined;
	}
}

/**
 * Merge the configured bypass list with the mandatory loopback entries.
 *
 * @param configured - hosts from config; a string (comma/newline separated) or an array.
 * @returns one comma-separated `NO_PROXY` value.
 */
export function composeNoProxy(configured) {
	const entries = (Array.isArray(configured) ? configured : String(configured ?? "").split(/[\n,]/))
		.map((entry) => String(entry).trim())
		.filter(Boolean);
	const seen = new Set(entries);
	for (const entry of LOOPBACK_NO_PROXY) if (!seen.has(entry)) entries.push(entry);
	return entries.join(",");
}

/**
 * Build the `env`-shaped view `installProxyFromEnvironment` expects.
 *
 * @param values - name to value; `undefined` leaves the name unset.
 * @returns an object exposing `get(name)`, matching the launcher's snapshot face.
 */
function envView(values) {
	return {
		get(wanted) {
			const hit = values[wanted];
			return hit === undefined ? undefined : { value: hit };
		},
	};
}

/**
 * Decide which proxy to use, in precedence order.
 *
 * Explicit config wins so an operator can override a stale environment; the
 * environment comes next because the launcher (and the user-owned
 * `$DSH_HOME/.env`) is authoritative about the machine's proxy; the Windows
 * system proxy is the last resort, for a harness started without any variable.
 *
 * @param config - this plugin's resolved config.
 * @returns the URL and where it came from, or `undefined` for direct.
 */
export function discoverProxy(config) {
	const configured = normalizeProxyUrl(config?.proxyUrl);
	if (configured !== undefined) return { url: configured, source: "config" };
	if (config?.proxyUrl !== undefined && String(config.proxyUrl).trim() !== "") {
		return { url: undefined, source: `config-invalid:${config.proxyUrl}` };
	}
	for (const entry of PROXY_ENV_NAMES) {
		const found = normalizeProxyUrl(process.env[entry]);
		if (found !== undefined) return { url: found, source: `env:${entry}` };
	}
	const system = readWindowsSystemProxy();
	if (system !== undefined) return { url: system, source: "windows-system-proxy" };
	return undefined;
}

/**
 * Import a package the Harness ships, without this plugin having to declare it.
 *
 * `@deepseek-ai/dsh-http-proxy` and `undici` are peer/platform packages: they
 * live in the Harness installation (inside `app.asar`) or in the profile, not
 * in a plugin's own dependency tree. Importing them by bare name therefore
 * only works by accident, and the Harness runs from an asar archive that the
 * ESM resolver cannot walk — only a CommonJS `createRequire` anchored at a
 * *file* (not a directory) can, which is why each candidate below appends a
 * probe filename.
 *
 * @param specifier - package name to import.
 * @returns the module namespace, or `undefined` when it is not reachable.
 */
async function importHarnessPackage(specifier) {
	const { createRequire } = await import("node:module");
	const { fileURLToPath, pathToFileURL } = await import("node:url");
	const { dirname, join } = await import("node:path");
	/**
	 * Candidate directories, most specific first: this plugin's own tree, the
	 * real paths the host was launched with, and the DSH source directory inside
	 * the archive. `process.argv` entries are used verbatim as well as through
	 * `dirname`, because the desktop host passes the DSH directory itself.
	 */
	const roots = [
		dirname(fileURLToPath(import.meta.url)),
		...process.argv.slice(1),
		...process.argv.slice(1).map((arg) => dirname(arg)),
		process.execPath,
	].filter((root) => typeof root === "string" && root !== "");
	for (const root of roots) {
		try {
			const require = createRequire(pathToFileURL(join(root, "probe.js")));
			return await import(pathToFileURL(require.resolve(specifier)).href);
		} catch {
			/* try the next root, then the bare name */
		}
	}
	return await import(specifier).catch(() => undefined);
}

/**
 * Install the proxy policy, returning the disposer that restores what was there.
 *
 * `@deepseek-ai/dsh-http-proxy` is preferred: it is the very package the
 * launcher uses, so loopback bypass, `NO_PROXY` matching, `proxyRouteFor()`
 * (which is how `web_fetch` decides to skip its public-address check) and the
 * environment handed to spawned tools all behave exactly as upstream. Its
 * installs stack and each disposer restores the layer beneath, which is what
 * makes this plugin reversible.
 *
 * @param proxyUrl - normalized proxy URL to install.
 * @param noProxy - composed `NO_PROXY` value.
 * @returns disposer restoring the previous dispatcher, policy and environment.
 * @throws when neither the peer package nor `undici` is reachable.
 */
export async function installProxy(proxyUrl, noProxy) {
	const hostModule = await importHarnessPackage("@deepseek-ai/dsh-http-proxy");
	if (hostModule?.installProxyFromEnvironment !== undefined) {
		return await hostModule.installProxyFromEnvironment(
			envView({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: noProxy }),
			() => {},
		);
	}
	// Fallback for a Harness that does not ship the package: swap undici directly.
	const undici = await importHarnessPackage("undici");
	if (undici?.setGlobalDispatcher === undefined) throw new Error("neither @deepseek-ai/dsh-http-proxy nor undici is resolvable");
	const previous = undici.getGlobalDispatcher();
	const agent = new undici.EnvHttpProxyAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy });
	undici.setGlobalDispatcher(agent);
	return async () => {
		if (undici.getGlobalDispatcher() === agent) undici.setGlobalDispatcher(previous);
		await agent.close();
	};
}

/**
 * Cordis entry point.
 *
 * Failures are logged and swallowed on purpose: a plugin that cannot find or
 * install a proxy must leave the process exactly as it found it, never break a
 * direct connection that already worked.
 *
 * @param ctx - the Cordis context supplied by the loader.
 * @param config - this row's config.
 * @returns a promise settling once the route is installed.
 */
export async function apply(ctx, config = {}) {
	const log = (message) => {
		const line = `${new Date().toISOString()} [${LOG_NAME}] ${message}`;
		try {
			ctx.logger?.info?.(line);
		} catch {
			/* the logger is optional */
		}
	};

	const found = discoverProxy(config);
	if (found === undefined || found.url === undefined) {
		log(`no usable proxy (${found?.source ?? "none"}); staying direct, nothing installed`);
		return;
	}

	try {
		const dispose = await installProxy(found.url, composeNoProxy(config.noProxy));
		ctx.effect(() => dispose, `${LOG_NAME}: global proxy dispatcher`);
		log(`proxy installed from ${found.source}: ${found.url} (NO_PROXY=${composeNoProxy(config.noProxy)})`);
	} catch (error) {
		log(`install failed, staying direct: ${error?.message ?? String(error)}`);
	}
}

/**
 * Harness home, used only for the log path and the `.env` hint.
 * @returns the resolved harness home directory.
 */
export function dshHome() {
	return process.env.DSH_HOME ?? `${homedir()}\\.dsh`;
}
