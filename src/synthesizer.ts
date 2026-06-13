import type { LLMAdapter } from "./llm";
import type { Clipping, SynthesisCache } from "./types";

/**
 * Owns the synthesis cache and answers cross-clipping queries.
 *
 * The engine is deliberately free of any Obsidian Plugin API: it never touches
 * the vault, settings, or saveData. It reads clippings that were collected for
 * it, reaches the network only through the injected {@link LLMAdapter}, and
 * mutates the {@link SynthesisCache} it was constructed with. Persisting that
 * cache is the caller's job. It also never asks the clock for "today" — the
 * caller passes dates in — so the engine stays deterministic and testable.
 */
export class SynthesisEngine {
	private readonly llm: LLMAdapter;
	private readonly cache: SynthesisCache;

	constructor(llm: LLMAdapter, cache: SynthesisCache) {
		this.llm = llm;
		this.cache = cache;
	}

	/**
	 * Extract a summary/claims/topics for every clipping, incrementally.
	 *
	 * Unchanged clippings (same mtime as the cache) will be skipped so we don't
	 * pay for a BYOK API call we've already made; vanished clippings will be
	 * dropped from the cache. `todayISO` is the caller's clock (YYYY-MM-DD).
	 *
	 * TODO Phase 2: implement extraction via this.llm.
	 */
	async syncClippings(clippings: Clipping[], todayISO: string): Promise<void> {
		void clippings;
		void todayISO;
		this.cache.lastSynced = todayISO;
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
}
