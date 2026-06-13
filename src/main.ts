import { Plugin } from "obsidian";
import {
	DEFAULT_SETTINGS,
	ReadingInboxSettingTab,
	type ReadingInboxSettings,
} from "./settings";
import { LLMAdapter } from "./llm";
import { ClippingCollector } from "./collector";
import { SynthesisEngine } from "./synthesizer";
import type { SynthesisCache } from "./types";

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
