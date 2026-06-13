import { App, TFile, getAllTags } from "obsidian";
import type { ReadingInboxSettings } from "./settings";
import type { Clipping } from "./types";

/**
 * Gathers web clippings from the vault. Pure collection — no LLM calls.
 * A note qualifies if it lives under the configured folder OR carries the
 * configured tag.
 */
export class ClippingCollector {
	private readonly app: App;
	private readonly settings: ReadingInboxSettings;

	constructor(app: App, settings: ReadingInboxSettings) {
		this.app = app;
		this.settings = settings;
	}

	collect(): Clipping[] {
		const clippings: Clipping[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.isClipping(file)) {
				continue;
			}
			clippings.push(this.toClipping(file));
		}

		return clippings;
	}

	private isClipping(file: TFile): boolean {
		return this.matchesFolder(file) || this.matchesTag(file);
	}

	private matchesFolder(file: TFile): boolean {
		const folder = this.settings.clippingsFolder.trim().replace(/\/+$/, "");
		if (folder === "") {
			return false;
		}
		return file.path === folder || file.path.startsWith(`${folder}/`);
	}

	private matchesTag(file: TFile): boolean {
		const wanted = this.normalizeTag(this.settings.clippingsTag);
		if (wanted === "") {
			return false;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) {
			return false;
		}
		const tags = getAllTags(cache) ?? [];
		return tags.some((tag) => this.normalizeTag(tag) === wanted);
	}

	private normalizeTag(tag: string): string {
		return tag.trim().replace(/^#/, "").toLowerCase();
	}

	/**
	 * Map a vault file to a Clipping. Clipper templates vary wildly, so every
	 * frontmatter field is optional and read defensively: the URL may live under
	 * "source" or "url", the saved date under "created" or "date saved".
	 */
	private toClipping(file: TFile): Clipping {
		const frontmatter =
			this.app.metadataCache.getFileCache(file)?.frontmatter;

		const clipping: Clipping = {
			path: file.path,
			title: file.basename,
			mtime: file.stat.mtime,
		};

		const url =
			this.asString(frontmatter?.["source"]) ??
			this.asString(frontmatter?.["url"]);
		if (url !== undefined) {
			clipping.url = url;
		}

		const author = this.asString(frontmatter?.["author"]);
		if (author !== undefined) {
			clipping.author = author;
		}

		const savedDate =
			this.asString(frontmatter?.["created"]) ??
			this.asString(frontmatter?.["date saved"]);
		if (savedDate !== undefined) {
			clipping.savedDate = savedDate;
		}

		const status = this.asString(frontmatter?.["status"]);
		if (status !== undefined) {
			clipping.status = status;
		}

		return clipping;
	}

	/** Non-empty trimmed string, or undefined for anything else. */
	private asString(value: unknown): string | undefined {
		if (typeof value !== "string") {
			return undefined;
		}
		const trimmed = value.trim();
		return trimmed === "" ? undefined : trimmed;
	}
}
