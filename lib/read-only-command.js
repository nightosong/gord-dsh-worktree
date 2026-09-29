/**
 * Read-only classification for `bash` tool calls.
 *
 * The tool-call scheduler runs one step's calls concurrently only when every
 * tool declares itself concurrency-safe, and shell commands vary wildly: two
 * `grep`s overlap harmlessly, two writers racing on one file corrupt state.
 * The decision therefore stays fail-closed — a command is parallel only when
 * every segment of the line starts with a command from a small read-only
 * allowlist and the whole line carries no write-shaped syntax. Anything
 * unknown, unparsed, or ambiguous is exclusive, which is exactly the
 * behaviour every command had before this classifier existed.
 */

/** Commands whose every invocation only reads. */
const SIMPLE = new Set([
	// filesystem / text
	"ls", "cat", "head", "tail", "wc", "nl", "tac", "rev", "cut", "paste", "tr",
	"sort", "uniq", "comm", "join", "column", "fold", "expand", "unexpand",
	"grep", "egrep", "fgrep", "rgrep", "rg", "ag", "ack", "zgrep", "zegrep",
	"sed", "awk", "gawk", "mawk", "jq", "yq",
	"find", "fd", "fdfind", "tree", "du", "df", "stat", "file",
	"readlink", "realpath", "basename", "dirname", "md5", "md5sum", "shasum",
	"sha1sum", "sha256sum", "cksum", "sum", "cmp", "diff", "diff3", "sdiff",
	"strings", "xxd", "hexdump", "od", "iconv",
	// location / identity / environment
	"pwd", "cd", "pushd", "popd", "which", "whence", "type", "env", "printenv",
	"id", "groups", "whoami", "hostname", "uname", "sw_vers", "arch", "date",
	"uptime", "locale", "tty", "logname", "getconf",
	"echo", "printf", "true", "false", "test", "expr", "seq",
	// process / network inspection
	"ps", "pgrep", "pstree", "lsof", "netstat", "ss", "dig", "host", "nslookup",
	"traceroute", "ping", "vmstat", "iostat", "top", "free", "w",
	// HTTP reads (narrowed by the curl guard below)
	"curl",
	// tools that are read-only only for specific subcommands (see SUBCOMMANDS)
	"git", "hg", "svn", "docker", "podman", "npm", "pnpm", "yarn", "kubectl",
	"gh", "go", "cargo", "rustc", "java"
]);

/** Commands that are read-only only for a specific subcommand. */
const SUBCOMMANDS = {
	git: new Set([
		"status", "log", "diff", "show", "rev-parse", "rev-list", "ls-files",
		"ls-remote", "ls-tree", "describe", "shortlog", "blame", "cat-file",
		"version", "merge-base", "diff-tree", "diff-files", "diff-index",
		"whatchanged", "for-each-ref", "name-rev", "symbolic-ref", "show-ref",
		"cherry", "grep", "count-objects", "verify-pack", "verify-commit",
		"verify-tag", "var"
	]),
	docker: new Set(["ps", "images", "logs", "inspect", "version", "info", "stats", "top", "port", "diff", "history", "search"]),
	podman: new Set(["ps", "images", "logs", "inspect", "version", "info", "stats", "history", "search"]),
	npm: new Set(["ls", "list", "view", "outdated", "why", "ping", "root", "prefix"]),
	pnpm: new Set(["ls", "list", "view", "outdated", "why", "root", "prefix"]),
	yarn: new Set(["list", "info", "why", "versions"]),
	kubectl: new Set(["get", "describe", "logs", "version", "explain", "api-resources", "api-versions", "cluster-info"]),
	gh: new Set(["view", "list", "status", "diff", "checks", "version"]),
	hg: new Set(["status", "log", "diff", "show", "cat", "heads", "branch", "branches", "tags", "summary", "parents", "paths", "root", "version"]),
	svn: new Set(["status", "log", "diff", "info", "cat", "list", "ls", "blame", "propget", "proplist", "version"]),
	go: new Set(["version", "env", "list", "doc"]),
	cargo: new Set(["version", "metadata", "tree", "pkgid"]),
	rustc: new Set(["--version", "-vV", "--explain"]),
	java: new Set(["-version", "--version"])
};

/** Commands allowed only when every argument is a version/help probe. */
const VERSION_ONLY = new Set(["python", "python3", "node", "deno", "bun", "ruby", "perl", "php", "dotnet", "pip", "pip3", "uv", "poetry"]);

/** Flags that make an otherwise read-only command write. */
const FIND_WRITES = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprint0"]);
const CURL_WRITES = [
	"-X", "--request", "-d", "--data", "--data-raw", "--data-binary",
	"--data-urlencode", "--data-ascii", "-F", "--form", "--form-string", "-T",
	"--upload-file", "-o", "--output", "-O", "--remote-name", "-c",
	"--cookie-jar", "-D", "--dump-header", "-K", "--config", "--json"
];

/**
 * Decide whether one shell command line can run concurrently with others.
 * @param command - the `command` argument of a `bash` call, when present.
 * @returns true only for a line that provably only reads.
 */
export function isReadOnlyCommand(command) {
	if (typeof command !== "string") return false;
	const text = command.trim();
	if (text.length === 0 || text.length > 20000) return false;
	// `2>&1` and friends redirect between descriptors, not into files.
	const normalized = text.replace(/\d?>&\d/g, " ").replace(/\d?>>?&\d/g, " ");
	// `>` writes a file; a backtick or `$(` hides a command we cannot classify.
	if (/[>`]/.test(normalized)) return false;
	if (normalized.includes("$(")) return false;
	for (const raw of normalized.split(/\|\||&&|[|;\n]/)) {
		if (!segmentIsReadOnly(raw.trim())) return false;
	}
	return true;
}

/**
 * Classify one pipeline / `&&` / `;` segment by its first word.
 * @param segment - a trimmed command segment, possibly empty.
 * @returns true only when the segment provably only reads.
 */
function segmentIsReadOnly(segment) {
	if (segment.length === 0) return true;
	const words = segment.split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) return true;
	const head = words[0].replace(/^.*\//, "");
	const args = words.slice(1);
	// `cd`/`pushd`/`popd` change only the shell's own directory.
	if (head === "cd" || head === "pushd" || head === "popd") return true;
	if (VERSION_ONLY.has(head)) return args.length > 0 && args.every((arg) => /^(-v|-V|--version|-h|--help)$/.test(arg));
	const allowed = SUBCOMMANDS[head];
	if (allowed !== void 0) {
		const rest = head === "git" || head === "hg" || head === "svn" ? skipGlobalFlags(args) : args;
		const sub = rest.find((arg) => !arg.startsWith("-"));
		if (sub === void 0 || !allowed.has(sub)) return false;
		return guardOk(head, args);
	}
	if (!SIMPLE.has(head)) return false;
	return guardOk(head, args);
}

/** Global flags that take a separate value, so the subcommand is further right. */
const GLOBAL_FLAGS_WITH_VALUE = new Set(["-C", "-c", "-R", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--repository", "--config"]);

/**
 * Skip a version-control command's leading global flags to reach its subcommand.
 * The subcommand allowlist stays the gate; this only locates it.
 * @param args - the command's arguments.
 * @returns the arguments from the subcommand onward.
 */
function skipGlobalFlags(args) {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (GLOBAL_FLAGS_WITH_VALUE.has(arg)) { i += 2; continue; }
		if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--repository|--config)=/.test(arg)) { i += 1; continue; }
		break;
	}
	return args.slice(i);
}

/**
 * Narrow an allowlisted command by the arguments it was given.
 * @param head - the command name.
 * @param args - its arguments.
 * @returns false when a flag turns the command into a writer.
 */
function guardOk(head, args) {
	const any = (predicate) => args.some(predicate);
	if (head === "sed") return !any((arg) => arg.startsWith("-i") || arg.startsWith("--in-place"));
	if (head === "yq") return !any((arg) => arg === "-i" || arg.startsWith("--in-place"));
	if (head === "find") return !any((arg) => FIND_WRITES.has(arg) || /^-(fprint|fls)/.test(arg));
	if (head === "sort") return !any((arg) => arg === "-o" || arg.startsWith("--output") || /^-o./.test(arg));
	if (head === "curl") return !any((arg) => CURL_WRITES.some((flag) => arg === flag || arg.startsWith(`${flag}=`) || (flag.length <= 2 && arg.startsWith(flag))));
	if (head === "git" || head === "hg" || head === "svn" || head === "kubectl" || head === "gh") return !any((arg) => arg.startsWith("--output"));
	return true;
}