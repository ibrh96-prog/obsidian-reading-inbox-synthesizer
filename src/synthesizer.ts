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
	 * Render the synthesis report (batch summaries, cross-article themes,
	 * weekly digest) as a markdown document. Pure: reads the in-memory cache
	 * and returns a string — writing it to the vault is the caller's job.
	 *
	 * TODO Phase 3: implement report sections.
	 */
	buildReportMarkdown(todayISO: string): string {
		void todayISO;
		return [
			"# Reading Synthesis",
			"",
			`_Last synced: ${this.cache.lastSynced || "never"}_`,
			"",
			"_Coming soon._",
			"",
		].join("\n");
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
			const parsedFirst = this.parseExtraction(first);
			if (parsedFirst) {
				return this.toClipExtraction(clipping, body, parsedFirst);
			}

			const retryPrompt =
				`${userPrompt}\n\n` +
				"Your previous output was not valid JSON. Return ONLY the JSON object.";
			const second = await this.llm.complete(
				EXTRACTION_SYSTEM_PROMPT,
				retryPrompt
			);
			const parsedSecond = this.parseExtraction(second);
			if (parsedSecond) {
				return this.toClipExtraction(clipping, body, parsedSecond);
			}

			console.warn(
				`[Reading Inbox Synthesizer] Could not parse extraction for clipping: ${clipping.path}`
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

	private parseExtraction(raw: string): RawExtraction | null {
		const cleaned = this.stripFences(raw);
		try {
			const value: unknown = JSON.parse(cleaned);
			return this.coerceExtraction(value);
		} catch {
			return null;
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
