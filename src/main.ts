import { Notice, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ReadingInboxSettingTab,
	type ReadingInboxSettings,
} from "./settings";
import { LLMAdapter, MAX_INPUT_CHARS } from "./llm";
import { ClippingCollector } from "./collector";
import { SynthesisEngine, type ClippingInput } from "./synthesizer";
import type { Clipping, SynthesisCache } from "./types";

function emptyCache(): SynthesisCache {
	return { extractions: {}, lastSynced: "" };
}

/**
 * Shape of the single JSON blob Obsidian persists for this plugin. Settings and
 * the synthesis cache live side by side so saving one never clobbers the other.
 */
interface PersistedData {
	settings: ReadingInboxSettings;
	cache: SynthesisCache;
}

export default class ReadingInboxSynthesizerPlugin extends Plugin {
	settings: ReadingInboxSettings = DEFAULT_SETTINGS;
	cache: SynthesisCache = emptyCache();

	llm!: LLMAdapter;
	collector!: ClippingCollector;
	engine!: SynthesisEngine;

	override async onload(): Promise<void> {
		console.log("Reading Inbox Synthesizer loaded.");

		await this.loadSettings();

		this.llm = new LLMAdapter(this.settings);
		this.collector = new ClippingCollector(this.app, this.settings);
		this.engine = new SynthesisEngine(this.llm, this.cache);

		this.addSettingTab(new ReadingInboxSettingTab(this.app, this));

		this.addCommand({
			id: "sync-clippings",
			name: "Sync clippings",
			callback: () => {
				void this.runSync();
			},
		});
	}

	override onunload(): void {}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<PersistedData> | null;

		// Tolerate a legacy flat-settings layout (a build that saved the settings
		// object at the top level) so an existing API key survives.
		const settingsSource =
			data && "settings" in data
				? data.settings
				: (data as Partial<ReadingInboxSettings> | null);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsSource ?? {});

		this.cache =
			(data && "cache" in data ? data.cache : null) ?? emptyCache();
	}

	async saveSettings(): Promise<void> {
		await this.persist();
	}

	/** Persist settings and cache together as one blob. */
	private async persist(): Promise<void> {
		const data: PersistedData = {
			settings: this.settings,
			cache: this.cache,
		};
		await this.saveData(data);
	}

	/**
	 * Sync the reading inbox: collect clippings, prepare bodies for the
	 * new/changed ones, hand them to the pure engine, persist the cache.
	 * All vault I/O happens here — the engine never touches files.
	 */
	private async runSync(): Promise<void> {
		try {
			const clippings = this.collector.collect();

			const inputs: ClippingInput[] = [];
			for (const clipping of clippings) {
				if (!this.engine.needsExtraction(clipping)) {
					continue;
				}
				const body = await this.readBody(clipping);
				if (body === null) {
					continue;
				}
				inputs.push({ clipping, body });
			}

			const result = await this.engine.syncClippings(
				clippings,
				inputs,
				this.todayISO()
			);
			await this.persist();

			new Notice(
				`Synced ${result.extracted} clippings (${result.skipped} skipped, ${result.failed} failed).`
			);
		} catch (error) {
			console.error("Reading Inbox Synthesizer: sync failed", error);
			new Notice("Sync failed. See console for details.");
		}
	}

	/**
	 * Read a clipping's article body: frontmatter stripped, truncated to
	 * MAX_INPUT_CHARS so long articles fit small-context models. Returns null
	 * when the path no longer resolves to a file (vanished mid-sync).
	 */
	private async readBody(clipping: Clipping): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(clipping.path);
		if (!(file instanceof TFile)) {
			return null;
		}
		const raw = await this.app.vault.cachedRead(file);
		const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
		return body.slice(0, MAX_INPUT_CHARS);
	}

	/**
	 * Today as a calendar-date string (YYYY-MM-DD) in LOCAL time — never
	 * toISOString(), which would shift the date across the UTC boundary in
	 * non-UTC timezones. The engine never reads the clock; this is where
	 * "today" enters the system.
	 */
	private todayISO(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	}
}
