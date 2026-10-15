/**
 * Conservative scheduling for bash calls. Unknown syntax and commands stay
 * exclusive. This classifies scheduling only; it is not a shell sandbox.
 */

// Deliberately omit interpreters, wrappers (env), network clients, and utilities
// with output-file or execution modes (sed, awk, sort, uniq, xxd, fd, ...).
const SIMPLE = new Set([
	"ls", "cat", "head", "tail", "wc", "nl", "tac", "rev", "cut", "paste", "tr",
	"comm", "join", "fold", "expand", "unexpand", "grep", "egrep", "fgrep", "rg",
	"du", "df", "stat", "readlink", "realpath", "basename", "dirname", "cmp",
	"pwd", "cd", "pushd", "popd", "which", "type", "printenv", "id", "groups",
	"whoami", "uname", "sw_vers", "arch", "uptime", "locale", "tty", "logname",
	"echo", "printf", "true", "false", "expr", "seq", "ps", "pgrep", "jq"
]);
const VERSION_ONLY = new Set(["python", "python3", "node", "deno", "bun", "ruby", "perl", "php"]);
const GIT_READS = new Set([
	"status", "rev-parse", "rev-list", "ls-files", "ls-tree", "describe", "shortlog",
	"cat-file", "version", "merge-base", "for-each-ref", "name-rev", "show-ref",
	"cherry", "count-objects", "var", "log"
]);

/** Tokenize only simple quoted words, pipelines, &&, ||, and command lists. */
function segmentsOf(text) {
	const segments = [];
	let words = [];
	let word = "";
	let started = false;
	let quote = "";
	const flushWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	const flushSegment = () => {
		flushWord();
		if (words.length === 0) return false;
		segments.push(words);
		words = [];
		return true;
	};
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (quote !== "") {
			if (char === quote) { quote = ""; continue; }
			if (quote === '"' && /[$`\\]/.test(char)) return undefined;
			word += char;
			continue;
		}
		if (char === "'" || char === '"') { quote = char; started = true; continue; }
		// Reject expansion, substitution, comments, grouping and redirects. An
		// argument expansion could introduce flags this classifier never saw.
		const descriptor = !started ? text.slice(i).match(/^(?:[012])?>&[012](?=$|\s|[|;])/) : undefined;
		if (descriptor) { i += descriptor[0].length - 1; continue; }
		if (/[<>$`\\(){}#*?\[\]~\x00-\x08\x0b-\x1f\x7f]/.test(char)) return undefined;
		if (char === "&" && text[i + 1] !== "&") return undefined;
		if (char === "|" || char === "&" || char === ";" || char === "\n") {
			if (!flushSegment()) return undefined;
			if ((char === "|" || char === "&") && text[i + 1] === char) i += 1;
			if (i === text.length - 1) return undefined;
			continue;
		}
		if (/\s/.test(char)) { flushWord(); continue; }
		started = true;
		word += char;
	}
	if (quote !== "" || !flushSegment()) return undefined;
	return segments;
}

function segmentIsReadOnly(words) {
	const [head, ...args] = words;
	// Explicit executable paths may name arbitrary scripts with familiar names.
	if (VERSION_ONLY.has(head)) return args.length > 0 && args.every((arg) => /^(-v|-V|--version|-h|--help)$/.test(arg));
	if (head === "git") {
		let i = 0;
		// Only -C may precede the subcommand; -c/--exec-path can run programs.
		while (args[i] === "-C" && typeof args[i + 1] === "string") i += 2;
		if (!GIT_READS.has(args[i])) return false;
		// Even a log can invoke diff/textconv helpers. Require the caller to
		// use an exclusive call for patch-producing or configurable output.
		return args.slice(i + 1).every((arg) => !arg.startsWith("-") ||
			/^(--oneline|--graph|--all|--short|--porcelain(?:=v?[12])?|--branch|--show-toplevel|--abbrev-ref|--verify|--quiet|--count|--no-pager|--format=.*|--pretty=.*|--max-count=\d+|-\d+|-s|-sb)$/.test(arg));
	}
	if (!SIMPLE.has(head)) return false;
	// Bash's printf -v may evaluate an array subscript as shell arithmetic.
	if (head === "printf" && args.includes("-v")) return false;
	// ripgrep can launch preprocessors and an executable for hostname lookup;
	// reject long flags except an explicit reading-only subset, including their
	// abbreviated spellings. Short flags have no execution/output-file modes.
	if (head === "rg") return args.every((arg) => !arg.startsWith("--") ||
		/^(--|--files|--hidden|--no-ignore|--line-number|--files-with-matches|--files-without-match|--count|--count-matches|--ignore-case|--fixed-strings|--word-regexp|--glob(?:=.*)?|--iglob(?:=.*)?|--type(?:=.*)?|--type-not(?:=.*)?|--max-count(?:=.*)?)$/.test(arg));
	return true;
}

/** True only when every parsed command has a known reading-only form. */
export function isReadOnlyCommand(command) {
	if (typeof command !== "string") return false;
	const text = command.trim();
	if (text.length === 0 || text.length > 20000) return false;
	const segments = segmentsOf(text);
	return segments !== undefined && segments.every(segmentIsReadOnly);
}
