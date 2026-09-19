import { AbstractInputSuggest, App } from "obsidian";

/**
 * Generic type-ahead for a text input backed by a fixed list of strings
 * (item names, section names, tags, ...). Case-insensitive substring match,
 * exact-prefix matches sorted first.
 */
export class StringSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		textInputEl: HTMLInputElement,
		private getCandidates: () => string[],
		private onPick?: (value: string) => void,
	) {
		super(app, textInputEl);
	}

	protected getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase();
		const candidates = this.getCandidates();
		if (!q) return candidates.slice(0, 50);
		const starts: string[] = [];
		const contains: string[] = [];
		for (const c of candidates) {
			const lower = c.toLowerCase();
			if (lower.startsWith(q)) starts.push(c);
			else if (lower.includes(q)) contains.push(c);
		}
		return [...starts, ...contains].slice(0, 50);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.setValue(value);
		this.close();
		this.onPick?.(value);
	}
}
