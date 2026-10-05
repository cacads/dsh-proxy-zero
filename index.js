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

export const name = "dsh-proxy-zero";

/** Name used in diagnostics. */
const LOG_NAME = "dsh-proxy-zero";

/**
 * Proxy names this plugin may consider, most authoritative first.
 *
 * Lowercase first, uppercase as the fallback: undici reads `http_proxy` before
 * `HTTP_PROXY`, and so does `@deepseek-ai/dsh-http-proxy`'s own resolver. Asking
 * in the other order would pick a different value than the one the installed
 * dispatcher ends up honouring.
 *
 * @type {readonly string[]}
 */
const PROXY_ENV_NAMES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"];

/** Bypass names, in the same precedence order as {@link PROXY_ENV_NAMES}. */
const NO_PROXY_ENV_NAMES = ["no_proxy", "NO_PROXY"];

/** Loopback is always direct, or the Web UI and local servers would loop. */
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * The Windows registry key whose proxy values this plugin reads.
 *
 * `ProxyOverride` is read because the system bypass list is the machine's own
 * statement about which hosts must not go through the proxy; ignoring it would
 * send intranet traffic to a proxy that cannot route it.
 */
const SYSTEM_PROXY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

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
 * Split a bypass list into entries.
 *
 * Windows writes `ProxyOverride` with semicolons, `curl` and Node accept spaces,
 * and the environment is conventionally comma-separated. All three separators
 * are honoured, matching what undici and `@deepseek-ai/dsh-http-proxy` accept.
 *
 * @param raw - a string or an array of candidate entries.
 * @returns the trimmed, non-empty entries.
 */
function splitProxyEntries(raw) {
	return (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s;]+/))
		.map((entry) => String(entry).trim())
		.filter(Boolean);
}

/**
 * Rewrite the Windows bypass conventions into the subset every consumer matches.
 *
 * `<local>` means "every host name without a dot", which no bypass list can
 * express and which is therefore dropped with a report. A trailing `.*` is
 * Windows' prefix wildcard: `127.*`, `10.*` and `192.168.*` all appear in real
 * `ProxyOverride` values and each describes a whole IPv4 prefix, so it becomes a
 * CIDR block with the address padded to four octets — the notation Node's own
 * `NO_PROXY` reader understands. The padding is what makes this correct: dropping
 * `.*` and appending `.0/16` would turn `10.*` into the unparseable `10.0/16`.
 *
 * @param entry - one entry from `ProxyOverride`.
 * @returns the rewritten entry, or `undefined` when no consumer can express it.
 */
function normalizeBypassEntry(entry) {
	const text = String(entry).trim();
	if (text === "" || text.toLowerCase() === "<local>") return undefined;
	if (!/^\d+(\.\d+)*\.\*$/.test(text)) return text;
	const octets = text.slice(0, -2).split(".");
	const written = octets.length;
	while (octets.length < 4) octets.push("0");
	return `${octets.join(".")}/${written * 8}`;
}

/**
 * Parse one `reg query` batch into the values it reported.
 *
 * The output shape is `    Name    REG_TYPE    Value`, one value per line. Values
 * are returned verbatim including any `<local>`-style tokens.
 *
 * @param text - stdout of `reg query <key>`.
 * @returns name to value, for the names the query actually reported.
 */
export function parseRegistryValues(text) {
	const values = {};
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const match = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*?)\s*$/.exec(line);
		if (match !== null) values[match[1]] = match[2];
	}
	return values;
}

/**
 * Interpret the `ProxyServer` and `ProxyOverride` values of the Windows key.
 *
 * Split out from the registry read so the decision — which is where correctness
 * actually lives — is unit-testable without touching this machine's settings.
 *
 * @param proxyServer - the `ProxyServer` value, or `undefined`.
 * @param proxyOverride - the `ProxyOverride` value, or `undefined`.
 * @returns the status (`ok`, `socks` or `none`), the URL, the bypass entries, and
 *   any bypass entries no consumer can express.
 */
export function describeWindowsProxy(proxyServer, proxyOverride) {
	const bypass = [];
	const unsupported = [];
	const seen = new Set();
	for (const entry of splitProxyEntries(proxyOverride)) {
		const usable = normalizeBypassEntry(entry);
		if (usable === undefined) {
			unsupported.push(entry);
			continue;
		}
		const key = usable.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		bypass.push(usable);
	}
	// A `socks=` slot is named explicitly: `parseProxyServer` returns nothing for
	// it, and without this the machine's SOCKS setting would be indistinguishable
	// from a machine that has no proxy at all.
	if (/^\s*socks=/im.test(String(proxyServer ?? ""))) return { status: "socks", url: undefined, bypass, unsupported };
	const url = parseProxyServer(proxyServer);
	return { status: url === undefined ? "none" : "ok", url, bypass, unsupported };
}

/**
 * Read the enabled Windows system proxy and its bypass list.
 *
 * The system proxy only counts when `ProxyEnable` is `1`; a disabled setting
 * leaves us direct, matching what every other Windows program sees. The whole
 * key is dumped in one `reg query` instead of one query per value, because
 * `reg query` accepts a single `/v` and this runs on the profile's boot path,
 * where every extra child process is a visible delay.
 *
 * @returns the status (`ok`, `socks` or `none`), the normalized URL, its bypass
 *   entries, and any entries no consumer can express; the URL is `undefined`
 *   when the setting is absent, disabled, SOCKS-only or unreadable.
 */
export function readWindowsSystemProxy() {
	if (process.platform !== "win32") return { status: "none", url: undefined, bypass: [], unsupported: [] };
	const regExe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
	try {
		const values = parseRegistryValues(execFileSync(regExe, ["query", SYSTEM_PROXY_KEY], { encoding: "utf8", windowsHide: true }));
		if (!/0x1\b/i.test(values.ProxyEnable ?? "")) return { status: "none", url: undefined, bypass: [], unsupported: [] };
		return describeWindowsProxy(values.ProxyServer, values.ProxyOverride);
	} catch {
		return { status: "none", url: undefined, bypass: [], unsupported: [] };
	}
}

/**
 * Merge bypass lists into one `NO_PROXY` value.
 *
 * Every source is treated as additive: the machine's existing `NO_PROXY`, the
 * plugin's own `noProxy`, and the mandatory loopback entries all contribute, and
 * the first layer to name a host wins on case. Overwriting an inherited list
 * would silently re-route hosts the operator had exempted — including the
 * intranet and the private ranges a Windows system bypass list carries.
 *
 * @param layers - bypass sources, most specific first; each a string or an array.
 * @returns one comma-separated `NO_PROXY` value.
 */
export function composeNoProxy(...layers) {
	const entries = [];
	const seen = new Set();
	for (const layer of [...layers.filter((layer) => layer !== undefined && layer !== null), LOOPBACK_NO_PROXY]) {
		for (const entry of splitProxyEntries(layer)) {
			const key = entry.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push(entry);
		}
	}
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
 * Read one environment name through a `.get(name)?.value` face.
 *
 * The launcher's own snapshot is preferred when the host exposes it: its layered
 * view is what the launcher used to install the proxy policy before any plugin
 * mounted, so reading `process.env` instead can disagree with the dispatcher that
 * is already installed (a proxy that exists only in `$DSH_HOME/.env`, for
 * instance, never appears in `process.env`).
 *
 * @param ctx - the Cordis context, or anything else; a missing `get` is fine.
 * @param name - environment name to read.
 * @returns the value, or `undefined`.
 */
function readEnvironmentValue(ctx, name) {
	try {
		const fromSnapshot = ctx?.get?.("launchEnvironment")?.get?.(name)?.value;
		if (typeof fromSnapshot === "string" && fromSnapshot.trim() !== "") return fromSnapshot;
	} catch {
		/* a host without the snapshot service falls through to process.env */
	}
	return process.env[name];
}

/**
 * The bypass list this process already had, before this plugin ran.
 *
 * @param ctx - the Cordis context.
 * @returns the first non-empty inherited `no_proxy` value, or `undefined`.
 */
function inheritedNoProxy(ctx) {
	for (const entry of NO_PROXY_ENV_NAMES) {
		const value = readEnvironmentValue(ctx, entry);
		if (value !== undefined && String(value).trim() !== "") return value;
	}
	return undefined;
}

/**
 * Decide which proxy to use, in precedence order.
 *
 * Explicit config wins so an operator can override a stale environment; the
 * environment comes next because the launcher (and the user-owned
 * `$DSH_HOME/.env`) is authoritative about the machine's proxy; the Windows
 * system proxy is the last resort, for a harness started without any variable.
 *
 * @param ctx - the Cordis context; only its launch environment is read.
 * @param config - this plugin's resolved config.
 * @returns the URL, where it came from, the inherited bypass list, the bypass
 *   entries the chosen source contributes, and any entries no consumer can express.
 */
export function discoverProxy(ctx, config) {
	const inherited = inheritedNoProxy(ctx);
	const configured = normalizeProxyUrl(config?.proxyUrl);
	if (configured !== undefined) return { url: configured, source: "config", inherited, bypass: [], unsupported: [] };
	if (config?.proxyUrl !== undefined && String(config.proxyUrl).trim() !== "") {
		return { url: undefined, source: `config-invalid:${config.proxyUrl}`, inherited, bypass: [], unsupported: [] };
	}
	for (const entry of PROXY_ENV_NAMES) {
		const value = readEnvironmentValue(ctx, entry);
		const found = normalizeProxyUrl(value);
		if (found !== undefined) return { url: found, source: `env:${entry}`, inherited, bypass: [], unsupported: [] };
	}
	const system = readWindowsSystemProxy();
	if (system.url !== undefined) {
		return { url: system.url, source: "windows-system-proxy", inherited, bypass: system.bypass, unsupported: system.unsupported };
	}
	const source = system.status === "socks" ? "windows-system-proxy-socks" : "none";
	return { url: undefined, source, inherited, bypass: [], unsupported: [] };
}

/**
 * Import a package the Harness ships, without this plugin having to declare it.
 *
 * `@deepseek-ai/dsh-http-proxy` is a peer/platform package: it lives in the
 * Harness installation (inside `app.asar`) or in the profile, not in a plugin's
 * own dependency tree. Importing it by bare name therefore only works by
 * accident, and the Harness runs from an asar archive that the ESM resolver
 * cannot walk — only a CommonJS `createRequire` anchored at a *file* (not a
 * directory) can, which is why each candidate below appends a probe filename.
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
 * `@deepseek-ai/dsh-http-proxy` is the only implementation used, because it is
 * the very package the launcher uses: loopback bypass, `NO_PROXY` matching,
 * `proxyRouteFor()` (which is how `web_fetch` decides to skip its public-address
 * check) and the environment handed to spawned tools all behave exactly as
 * upstream. Its installs stack and each disposer restores the layer beneath,
 * which is what makes this plugin reversible.
 *
 * There is deliberately no fallback to a bare undici dispatcher. That substitute
 * cannot record the policy `proxyRouteFor()` reads, so it would silently leave
 * `web_fetch` on its direct branch — the exact failure this plugin exists to fix
 * — while reporting success. A missing package is reported instead.
 *
 * @param proxyUrl - normalized proxy URL to install.
 * @param noProxy - composed `NO_PROXY` value.
 * @returns the disposer restoring the previous dispatcher, policy and
 *   environment, plus every diagnostic the Harness package reported.
 * @throws when the Harness package is not reachable.
 */
export async function installProxy(proxyUrl, noProxy) {
	const hostModule = await importHarnessPackage("@deepseek-ai/dsh-http-proxy");
	if (hostModule?.installProxyFromEnvironment === undefined) {
		throw new Error("@deepseek-ai/dsh-http-proxy is not reachable from this plugin");
	}
	const diagnostics = [];
	const dispose = await hostModule.installProxyFromEnvironment(
		envView({
			http_proxy: proxyUrl,
			HTTP_PROXY: proxyUrl,
			https_proxy: proxyUrl,
			HTTPS_PROXY: proxyUrl,
			all_proxy: proxyUrl,
			ALL_PROXY: proxyUrl,
			no_proxy: noProxy,
			NO_PROXY: noProxy,
		}),
		(message) => diagnostics.push(String(message)),
	);
	return { dispose, diagnostics };
}

/**
 * Config schema, in the standard-schema shape the Cordis loader validates with.
 *
 * Without it a wrong-typed `proxyUrl` from the profile's patch layer was only
 * discoverable from a log line. A violation is reported by the loader as a
 * `ValidationError` naming the offending field, and is contained to this
 * plugin's own fiber.
 */
export const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-proxy-zero",
		validate(value) {
			const issues = [];
			const config = value ?? {};
			if (typeof config !== "object" || Array.isArray(config)) {
				return { issues: [{ message: "config must be a mapping" }] };
			}
			for (const field of ["proxyUrl", "noProxy"]) {
				const entry = config[field];
				const acceptable = entry === undefined || typeof entry === "string" || (field === "noProxy" && Array.isArray(entry));
				if (!acceptable) issues.push({ message: `${field} must be a string${field === "noProxy" ? " or an array of strings" : ""}`, path: [field] });
			}
			return issues.length === 0 ? { value: config } : { issues };
		},
	},
};

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
	const write = (method, message) => {
		const line = `${new Date().toISOString()} [${LOG_NAME}] ${message}`;
		try {
			const logger = ctx?.logger;
			if (typeof logger?.[method] === "function") logger[method](line);
			else logger?.info?.(`${method.toUpperCase()} ${line}`);
		} catch {
			/* the logger is optional */
		}
	};
	const log = (message) => write("info", message);

	const found = discoverProxy(ctx, config);
	if (found.url === undefined) {
		const reason = found.source.startsWith("config-invalid:")
			? `the configured proxyUrl is not a usable http(s) URL (${found.source.slice("config-invalid:".length)}); ` +
				"set an http:// or https:// proxy URL, or clear it to auto-discover"
			: found.source === "none"
				? "nothing found in config, the launch environment or the Windows system proxy"
				: found.source === "windows-system-proxy-socks"
					? "the Windows system proxy is SOCKS-only, which @deepseek-ai/dsh-http-proxy cannot route"
					: found.source;
		log(`no usable proxy (${reason}); staying direct, nothing installed`);
		return;
	}

	const noProxy = composeNoProxy(config.noProxy, found.bypass, found.inherited);
	try {
		const { dispose, diagnostics } = await installProxy(found.url, noProxy);
		ctx.effect(() => dispose, `${LOG_NAME}: global proxy dispatcher`);
		log(`proxy installed from ${found.source}: ${found.url} (NO_PROXY=${noProxy})`);
		for (const diagnostic of diagnostics) write("warn", `@deepseek-ai/dsh-http-proxy: ${diagnostic}`);
		if (found.unsupported.length > 0) {
			write(
				"warn",
				`the Windows system proxy bypasses ${found.unsupported.join(", ")}, which this process cannot match; ` +
					"add explicit hosts to this plugin's noProxy if that traffic must stay direct",
			);
		}
	} catch (error) {
		write("warn", `install failed, staying direct: ${error?.message ?? String(error)}`);
	}
}
