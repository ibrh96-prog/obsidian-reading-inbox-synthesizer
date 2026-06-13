import type { LLMAdapter } from "./llm";
import type { Clipping, ClipExtraction, SynthesisCache } from "./types";

/** One new/changed clipping plus its prepared article body (frontmatter
 * stripped and truncated by the caller — the engine never reads files). */
export interface ClippingInput {
	clipping: Clipping;
	body: string;
}

export interface SyncResult {
	extracted: number;
	skipped: number;
	failed: number;
}

// --- Shape the LLM is asked to return (validated before use) ---

interface RawExtraction {
	summary: string;
	keyClaims: string[];
	topics: string[];
	language?: string;
}

/**
 * Why a parse attempt yielded nothing usable. "invalid-json" and "empty"
 * (syntactically valid JSON but no real extraction in it) have different
 * causes in the field — weak JSON mode vs. a body the model couldn't read —
 * so they are reported separately.
 */
type ParseOutcome =
	| { kind: "ok"; extraction: RawExtraction }
	| { kind: "invalid-json" }
	| { kind: "empty" };

const EXTRACTION_SYSTEM_PROMPT = [
	"You are a reading-inbox extraction engine. Read the saved web article",
	"and extract its summary, key claims, topics, and language.",
	"",
	"Return ONLY a valid JSON object — no markdown code fences, no commentary,",
	"no prose before or after. The object must match exactly this shape:",
	"{",
	'  "summary": string,',
	'  "keyClaims": string[],',
	'  "topics": string[],',
	'  "language": string',
	"}",
	"",
	"Rules:",
	'- "summary" is 2-3 sentences, written in the article\'s own language.',
	'- "keyClaims" are the article\'s main claims or arguments, one sentence',
	"  each, written in the article's own language.",
	'- "topics" are 2-5 short lowercase labels (1-3 words each).',
	'- "language" is the ISO 639-1 code of the article\'s language,',
	'  e.g. "en", "tr", "de".',
	'- If a field is unknown, use an empty array or "" as appropriate.',
	"- Do NOT invent content that is not in the article.",
].join("\n");

/**
 * Owns the synthesis cache and answers cross-clipping queries.
 *
 * The engine is deliberately free of any Obsidian Plugin API: it never touches
 * the vault, settings, or saveData. It reads clipping bodies that were
 * collected and prepared for it, reaches the network only through the injected
 * {@link LLMAdapter}, and mutates the {@link SynthesisCache} it was
 * constructed with. Persisting that cache is the caller's job. It also never
 * asks the clock for "today" — the caller passes dates in — so the engine
 * stays deterministic and testable.
 */
export class SynthesisEngine {
	private readonly llm: LLMAdapter;
	private readonly cache: SynthesisCache;

	constructor(llm: LLMAdapter, cache: SynthesisCache) {
		this.llm = llm;
		this.cache = cache;
	}

	/**
	 * True when a clipping has no cached extraction, or its file changed since
	 * the cached one (mtime mismatch). The caller uses this to decide which
	 * bodies to read — unchanged clippings never cost a BYOK API call twice.
	 */
	needsExtraction(clipping: Clipping): boolean {
		const existing = this.cache.extractions[clipping.path];
		return existing === undefined || existing.mtime !== clipping.mtime;
	}

	/**
	 * Extract every new/changed clipping, incrementally.
	 *
	 * `allClippings` is the full current inbox (used to drop cache entries for
	 * clippings that vanished from the vault); `inputs` is the subset that
	 * actually needs (re-)extraction, with bodies prepared by the caller. One
	 * LLM call per input, plus at most one retry on malformed JSON; a clipping
	 * that still fails is warned and skipped — its stale cache entry (if any)
	 * is left untouched so the next sync retries it. Never aborts the sync.
	 *
	 * The cache is mutated in place; the caller persists it afterwards.
	 */
	async syncClippings(
		allClippings: Clipping[],
		inputs: ClippingInput[],
		todayISO: string
	): Promise<SyncResult> {
		const result: SyncResult = {
			extracted: 0,
			skipped: allClippings.length - inputs.length,
			failed: 0,
		};

		for (const { clipping, body } of inputs) {
			const extraction = await this.extractClipping(clipping, body);
			if (!extraction) {
				result.failed += 1;
				continue;
			}

			this.cache.extractions[clipping.path] = {
				mtime: clipping.mtime,
				extraction,
			};
			result.extracted += 1;
			console.log(`[Reading Inbox Synthesizer] Extracted: ${clipping.path}`);
		}

		// Drop cache entries for clippings that no longer exist in the vault.
		const seenPaths = new Set(allClippings.map((c) => c.path));
		for (const path of Object.keys(this.cache.extractions)) {
			if (!seenPaths.has(path)) {
				delete this.cache.extractions[path];
			}
		}

		this.cache.lastSynced = todayISO;
		return result;
	}

	/**
	 * Render the synthesis report as a markdown document. Pure and free: reads
	 * the in-memory cache and the collected clippings — zero LLM calls — and
	 * returns a string; writing it to the vault is the caller's job. `todayISO`
	 * (YYYY-MM-DD) is the caller's clock and anchors the "This week" window.
	 */
	buildReportMarkdown(clippings: Clipping[], todayISO: string): string {
		const lines: string[] = [];

		// Newest saved first; undated clippings last ("" sorts after any date
		// in descending order).
		const sorted = [...clippings].sort((a, b) =>
			this.dateKey(b.savedDate).localeCompare(this.dateKey(a.savedDate))
		);
		const extractionOf = (clipping: Clipping) =>
			this.cache.extractions[clipping.path]?.extraction;

		lines.push("# Reading Synthesis");
		lines.push("");
		lines.push(`_Last synced: ${this.cache.lastSynced || "never"}_`);
		lines.push("");

		// --- 1. Reading inbox ---
		lines.push("## Reading inbox");
		if (sorted.length === 0) {
			lines.push("_No clippings found._");
		} else {
			for (const clipping of sorted) {
				const name = this.noteName(clipping.path);
				const extraction = extractionOf(clipping);
				if (!extraction) {
					lines.push(`- [[${name}]] — _not synced yet_`);
					continue;
				}
				const topics =
					extraction.topics.length > 0
						? extraction.topics.join(", ")
						: "no topics";
				const read = extraction.readTimeMinutes
					? ` — ${extraction.readTimeMinutes} min read`
					: "";
				lines.push(`- [[${name}]] — ${topics}${read}`);
			}
		}
		lines.push("");

		// --- 2. Themes (deterministic topic grouping, zero LLM) ---
		lines.push("## Themes");
		const themes = this.groupByTopic(sorted);
		if (themes.length === 0) {
			lines.push("_No shared topics across clippings yet._");
			lines.push("");
		} else {
			for (const theme of themes) {
				lines.push(`### ${theme.topic}`);
				for (const member of theme.members) {
					const name = this.noteName(member.clipping.path);
					lines.push(`- [[${name}]] — ${this.oneLine(member.summary)}`);
				}
				lines.push("");
			}
		}

		// --- 3. This week ---
		lines.push("## This week");
		const weekStart = this.weekStartOf(todayISO);
		const weekEnd = this.addDays(weekStart, 7);
		const thisWeek = sorted.filter((clipping) => {
			const day = this.dateKey(clipping.savedDate);
			return day !== "" && day >= weekStart && day < weekEnd;
		});
		lines.push(`_Week of ${weekStart}_`);
		lines.push("");
		if (thisWeek.length === 0) {
			lines.push("_Nothing saved this week._");
		} else {
			for (const clipping of thisWeek) {
				const name = this.noteName(clipping.path);
				lines.push(
					`- [[${name}]] — saved ${this.dateKey(clipping.savedDate)}`
				);
			}
		}
		lines.push("");

		// --- 4. Summaries ---
		lines.push("## Summaries");
		const synced = sorted.filter((c) => extractionOf(c) !== undefined);
		if (synced.length === 0) {
			lines.push('_No extractions yet — run "Sync clippings" first._');
		} else {
			for (const clipping of synced) {
				const extraction = extractionOf(clipping);
				if (!extraction) {
					continue;
				}
				lines.push(`### ${this.noteName(clipping.path)}`);
				lines.push(extraction.summary);
				if (extraction.keyClaims.length > 0) {
					// Claims as flowing prose, not bullets.
					lines.push("");
					lines.push(extraction.keyClaims.join(" "));
				}
				lines.push("");
			}
		}

		return lines.join("\n");
	}

	// --- Report internals (all pure) ---

	/**
	 * Group synced clippings by shared topic (exact lowercase match). Only
	 * topics carried by 2+ clippings count as a theme. Ordered biggest theme
	 * first, then alphabetically — fully deterministic, no LLM.
	 */
	private groupByTopic(
		clippings: Clipping[]
	): Array<{ topic: string; members: Array<{ clipping: Clipping; summary: string }> }> {
		const groups = new Map<
			string,
			Array<{ clipping: Clipping; summary: string }>
		>();

		for (const clipping of clippings) {
			const extraction = this.cache.extractions[clipping.path]?.extraction;
			if (!extraction) {
				continue;
			}
			for (const topic of extraction.topics) {
				const members = groups.get(topic) ?? [];
				members.push({ clipping, summary: extraction.summary });
				groups.set(topic, members);
			}
		}

		return [...groups.entries()]
			.filter(([, members]) => members.length >= 2)
			.sort(
				([topicA, a], [topicB, b]) =>
					b.length - a.length || topicA.localeCompare(topicB)
			)
			.map(([topic, members]) => ({ topic, members }));
	}

	/**
	 * Monday of the week containing `todayISO`, as YYYY-MM-DD. Sunday belongs
	 * to the previous Monday (steps back 6 days). Pure arithmetic on the
	 * passed-in date via UTC — never reads the clock, and the window check
	 * itself compares YYYY-MM-DD strings lexicographically, so no timezone
	 * parsing can shift the boundary.
	 */
	private weekStartOf(todayISO: string): string {
		const day = todayISO.slice(0, 10);
		const [year, month, date] = day.split("-").map(Number);
		const dow = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
		const daysSinceMonday = dow === 0 ? 6 : dow - 1;
		return this.addDays(day, -daysSinceMonday);
	}

	/**
	 * Add days to a YYYY-MM-DD calendar date, returning YYYY-MM-DD. Arithmetic
	 * runs in UTC so month boundaries and DST never shift the result.
	 */
	private addDays(dateOnly: string, days: number): string {
		const [year, month, day] = dateOnly.split("-").map(Number);
		const dt = new Date(Date.UTC(year, month - 1, day));
		dt.setUTCDate(dt.getUTCDate() + days);
		const y = dt.getUTCFullYear();
		const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
		const d = String(dt.getUTCDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}

	/**
	 * Reduce a date string to its calendar-date key (YYYY-MM-DD) for timezone-
	 * safe lexicographic comparison. Returns "" for missing/invalid dates.
	 */
	private dateKey(date: string | undefined): string {
		const day = (date ?? "").slice(0, 10);
		return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
	}

	/** Vault path → wikilink-friendly note name (drop folders and .md). */
	private noteName(sourcePath: string): string {
		const base = sourcePath.split("/").pop() ?? sourcePath;
		return base.replace(/\.md$/i, "");
	}

	/** Flatten a summary to a single line for list items. */
	private oneLine(text: string): string {
		return text.replace(/\s*\n\s*/g, " ").trim();
	}

	// --- Extraction internals ---

	/**
	 * Ask the LLM to extract one clipping. Parses the response defensively and
	 * retries once on invalid JSON. Returns null (and warns) if both attempts
	 * fail — or if the request itself throws (network/auth) — so the caller
	 * can count the failure without aborting the whole sync.
	 */
	private async extractClipping(
		clipping: Clipping,
		body: string
	): Promise<ClipExtraction | null> {
		const userPrompt = this.buildUserPrompt(clipping, body);

		try {
			const first = await this.llm.complete(
				EXTRACTION_SYSTEM_PROMPT,
				userPrompt
			);
			const firstOutcome = this.parseExtraction(first);
			if (firstOutcome.kind === "ok") {
				return this.toClipExtraction(clipping, body, firstOutcome.extraction);
			}

			const complaint =
				firstOutcome.kind === "empty"
					? "Your previous output was valid JSON but contained no summary. " +
						"Return the JSON object with a non-empty summary."
					: "Your previous output was not valid JSON. Return ONLY the JSON object.";
			const retryPrompt = `${userPrompt}\n\n${complaint}`;
			const second = await this.llm.complete(
				EXTRACTION_SYSTEM_PROMPT,
				retryPrompt
			);
			const secondOutcome = this.parseExtraction(second);
			if (secondOutcome.kind === "ok") {
				return this.toClipExtraction(clipping, body, secondOutcome.extraction);
			}

			// Response body text only — never API keys or headers.
			const reason =
				secondOutcome.kind === "empty"
					? "valid JSON but empty extraction"
					: "invalid JSON";
			console.warn(
				`[Reading Inbox Synthesizer] Extraction failed (${reason}) for clipping: ${clipping.path}. ` +
					`Raw response (first 300 chars): ${second.slice(0, 300)}`
			);
			return null;
		} catch (error) {
			console.warn(
				`[Reading Inbox Synthesizer] Extraction request failed for clipping: ${clipping.path}`,
				error
			);
			return null;
		}
	}

	private buildUserPrompt(clipping: Clipping, body: string): string {
		const lines = [`Title: ${clipping.title}`];
		if (clipping.url) {
			lines.push(`URL: ${clipping.url}`);
		}
		if (clipping.author) {
			lines.push(`Author: ${clipping.author}`);
		}
		if (clipping.savedDate) {
			lines.push(`Saved: ${clipping.savedDate}`);
		}
		lines.push("", "Article content:", body);
		return lines.join("\n");
	}

	/** Assemble the cached extraction from a validated LLM result. */
	private toClipExtraction(
		clipping: Clipping,
		body: string,
		raw: RawExtraction
	): ClipExtraction {
		const extraction: ClipExtraction = {
			id: this.hash(clipping.path),
			summary: raw.summary,
			keyClaims: raw.keyClaims,
			topics: raw.topics,
			readTimeMinutes: this.estimateReadTime(body),
		};
		if (raw.language !== undefined) {
			extraction.language = raw.language;
		}
		return extraction;
	}

	/** ~200 words per minute, never less than 1 minute. Deterministic. */
	private estimateReadTime(body: string): number {
		const words = body.split(/\s+/).filter((w) => w !== "").length;
		return Math.max(1, Math.round(words / 200));
	}

	private parseExtraction(raw: string): ParseOutcome {
		const cleaned = this.stripFences(raw);

		let value = this.tryParseJson(cleaned);
		if (value === undefined) {
			// Weak models often wrap the JSON in prose ("Here is the JSON: {…}").
			// Recover by slicing from the first "{" to the last "}".
			const start = cleaned.indexOf("{");
			const end = cleaned.lastIndexOf("}");
			if (start !== -1 && end > start) {
				value = this.tryParseJson(cleaned.slice(start, end + 1));
			}
		}
		if (value === undefined) {
			return { kind: "invalid-json" };
		}

		const extraction = this.coerceExtraction(value);
		if (extraction === null) {
			return { kind: "empty" };
		}
		return { kind: "ok", extraction };
	}

	/** JSON.parse that returns undefined instead of throwing. (JSON.parse
	 * itself can never produce undefined, so it's a safe failure sentinel.) */
	private tryParseJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}

	/** Remove an accidental ```json … ``` wrapper before parsing. */
	private stripFences(raw: string): string {
		let text = raw.trim();
		if (text.startsWith("```")) {
			text = text
				.replace(/^```[a-zA-Z]*\s*/, "")
				.replace(/\s*```$/, "");
		}
		return text.trim();
	}

	/** Validate/normalize an arbitrary parsed value into a RawExtraction. */
	private coerceExtraction(value: unknown): RawExtraction | null {
		if (typeof value !== "object" || value === null) {
			return null;
		}
		const obj = value as Record<string, unknown>;

		const summary =
			typeof obj["summary"] === "string" ? obj["summary"].trim() : "";
		if (summary === "") {
			return null;
		}

		const extraction: RawExtraction = {
			summary,
			keyClaims: this.toStringArray(obj["keyClaims"]),
			topics: this.toStringArray(obj["topics"]).map((t) => t.toLowerCase()),
		};

		// Accept "en" but also sloppy variants like "en-US"; keep the 639-1 part.
		const language =
			typeof obj["language"] === "string"
				? obj["language"].trim().toLowerCase()
				: "";
		const languageMatch = language.match(/^[a-z]{2}/);
		if (languageMatch) {
			extraction.language = languageMatch[0];
		}

		return extraction;
	}

	private toStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}
		return value
			.filter((v): v is string => typeof v === "string")
			.map((v) => v.trim())
			.filter((v) => v !== "");
	}

	/** Small deterministic djb2 hash, rendered as base-36. */
	private hash(input: string): string {
		let h = 5381;
		for (let i = 0; i < input.length; i++) {
			h = (((h << 5) + h) + input.charCodeAt(i)) | 0;
		}
		return (h >>> 0).toString(36);
	}
}
