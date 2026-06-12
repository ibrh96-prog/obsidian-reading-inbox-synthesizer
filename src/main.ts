import { Plugin } from "obsidian";

export default class ReadingInboxSynthesizerPlugin extends Plugin {
	override async onload(): Promise<void> {
		console.log("Reading Inbox Synthesizer loaded.");
	}

	override onunload(): void {}
}
