import { App, Events, TFile, TFolder } from "obsidian";
import { createInventoryPageContent, listInventoryFiles, readInventoryPage } from "./inventory-library";
import {
	parseInventoryBody,
	replaceInventoryBody,
	splitFrontmatter,
} from "../parser/inventory";
import { PantrySettings } from "../settings";
import { InventoryEntry, InventoryItem, InventoryPageContent, InventorySection } from "../types";
import { generateId } from "../utils/id";

export interface InventorySaveSink {
	readonly settings: PantrySettings;
	save(): Promise<void>;
}

interface PageCacheEntry {
	file: TFile;
	page: InventoryPageContent;
}

/** Deep-clone a page's parsed content so mutations don't corrupt the cache on failed writes. */
function clonePage(page: InventoryPageContent): InventoryPageContent {
	return JSON.parse(JSON.stringify(page)) as InventoryPageContent;
}

/** Effective tags for an item: its own tags plus the tags of the section it lives in. */
function effectiveTags(item: InventoryItem, sectionTags: string[]): string[] {
	return [...new Set([...sectionTags, ...item.tags])];
}

/** Stable key identifying a page's section, for the section filter. */
export function sectionKey(filePath: string, sectionName: string): string {
	return `${filePath}::${sectionName}`;
}

/**
 * Manages the user's pantry inventory, which lives as a set of markdown
 * "inventory pages" (notes cross-referenced from configured folders, the
 * same way recipes are). Each page holds one or more named, taggable
 * sections; each section holds items. Broadcasts a "changed" event whenever
 * the cache is rebuilt or a mutation is written, so views can re-render.
 */
export class InventoryManager extends Events {
	private pages = new Map<string, PageCacheEntry>();
	private refreshPromise: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly sink: InventorySaveSink,
	) {
		super();
	}

	// ------------------------------------------------------------------
	// Reading
	// ------------------------------------------------------------------

	/** All cached inventory pages, sorted by file name. */
	getPages(): PageCacheEntry[] {
		return [...this.pages.values()].sort((a, b) =>
			a.file.basename.localeCompare(b.file.basename, undefined, {
				sensitivity: "base",
			}),
		);
	}

	getPage(filePath: string): PageCacheEntry | undefined {
		return this.pages.get(filePath);
	}

	/** Every item across every page/section, paired with its section context. */
	getEntries(): InventoryEntry[] {
		const out: InventoryEntry[] = [];
		for (const { file, page } of this.pages.values()) {
			for (const section of page.sections) {
				for (const item of section.items) {
					out.push({
						item,
						filePath: file.path,
						pageName: file.basename,
						sectionName: section.name,
						sectionTags: section.tags,
					});
				}
			}
		}
		return out;
	}

	/**
	 * Flattened items for backward-compatible consumers (grocery cross-
	 * reference, status badges). Each item's `category` is set to the name
	 * of the section it lives in.
	 */
	getItems(): InventoryItem[] {
		return this.getEntries().map((e) => ({ ...e.item, category: e.sectionName }));
	}

	/** Distinct item names across the whole inventory, for name auto-complete. */
	getKnownItemNames(): string[] {
		const names = new Set<string>();
		for (const entry of this.getEntries()) names.add(entry.item.name);
		return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	}

	/** Distinct section + item tags across the whole inventory, for filter chips. */
	getKnownTags(): string[] {
		const tags = new Set<string>();
		for (const entry of this.getEntries()) {
			for (const t of effectiveTags(entry.item, entry.sectionTags)) tags.add(t);
		}
		return [...tags].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	}

	/**
	 * Most recently added existing item matching `name` (case-insensitive),
	 * used to prefill unit/tags/shop links when a user picks a known name
	 * from auto-complete instead of retyping everything.
	 */
	findMostRecentItemByName(name: string): InventoryItem | null {
		const wanted = name.trim().toLowerCase();
		if (!wanted) return null;
		const matches = this.getEntries()
			.map((e) => e.item)
			.filter((i) => i.name.trim().toLowerCase() === wanted)
			.sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
		return matches[0] ?? null;
	}

	/** Distinct sections across the whole inventory (page + section), for the section filter chips. */
	getKnownSections(): Array<{ key: string; pageName: string; sectionName: string }> {
		const seen = new Map<string, { key: string; pageName: string; sectionName: string }>();
		for (const { file, page } of this.pages.values()) {
			for (const section of page.sections) {
				const key = sectionKey(file.path, section.name);
				if (!seen.has(key)) {
					seen.set(key, { key, pageName: file.basename, sectionName: section.name });
				}
			}
		}
		return [...seen.values()].sort((a, b) =>
			`${a.pageName} ${a.sectionName}`.localeCompare(
				`${b.pageName} ${b.sectionName}`,
				undefined,
				{ sensitivity: "base" },
			),
		);
	}

	isSectionSelected(key: string): boolean {
		return this.sink.settings.inventoryState.sectionFilter.includes(key);
	}

	async toggleSectionFilter(key: string): Promise<void> {
		const current = this.sink.settings.inventoryState.sectionFilter;
		const has = current.includes(key);
		await this.setSectionFilter(has ? current.filter((k) => k !== key) : [...current, key]);
	}

	async setSectionFilter(keys: string[]): Promise<void> {
		this.sink.settings.inventoryState.sectionFilter = [...new Set(keys)];
		await this.sink.save();
		this.trigger("changed");
	}

	/**
	 * Entries after applying the saved section filter and tag filter, both
	 * OR-match inclusion filters (empty = show everything) that combine
	 * with AND between the two facets.
	 */
	getFilteredEntries(): InventoryEntry[] {
		const { filterTags, sectionFilter } = this.sink.settings.inventoryState;
		let entries = this.getEntries();
		if (sectionFilter.length > 0) {
			const wantedSections = new Set(sectionFilter);
			entries = entries.filter((e) => wantedSections.has(sectionKey(e.filePath, e.sectionName)));
		}
		if (filterTags.length === 0) return entries;
		const wanted = new Set(filterTags.map((t) => t.toLowerCase()));
		return entries.filter((e) =>
			effectiveTags(e.item, e.sectionTags).some((t) => wanted.has(t.toLowerCase())),
		);
	}

	/**
	 * Filtered entries grouped for the overview list, per the saved
	 * `groupBy` mode. "flat" returns a single group; "section" groups by
	 * `page › section`; "tag" groups by each effective tag (items with
	 * multiple tags appear in each group; untagged items land in "Untagged").
	 */
	getGroupedEntries(): Array<[string, InventoryEntry[]]> {
		const groupBy = this.sink.settings.inventoryState.groupBy;
		const entries = [...this.getFilteredEntries()].sort((a, b) =>
			a.item.name.localeCompare(b.item.name, undefined, { sensitivity: "base" }),
		);

		if (groupBy === "flat") {
			return [["All items", entries]];
		}

		const groups = new Map<string, InventoryEntry[]>();
		for (const entry of entries) {
			const keys =
				groupBy === "tag"
					? (() => {
							const tags = effectiveTags(entry.item, entry.sectionTags);
							return tags.length > 0 ? tags : ["Untagged"];
						})()
					: [`${entry.pageName} › ${entry.sectionName}`];
			for (const key of keys) {
				const arr = groups.get(key);
				if (arr) arr.push(entry);
				else groups.set(key, [entry]);
			}
		}
		return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	}

	// ------------------------------------------------------------------
	// View state (grouping / filtering / collapse / zoom) — persisted to
	// the vault UI-state JSON, same mechanism as before.
	// ------------------------------------------------------------------

	async setGroupBy(groupBy: "flat" | "section" | "tag"): Promise<void> {
		this.sink.settings.inventoryState.groupBy = groupBy;
		await this.sink.save();
		this.trigger("changed");
	}

	async setFilterTags(tags: string[]): Promise<void> {
		this.sink.settings.inventoryState.filterTags = [...new Set(tags)];
		await this.sink.save();
		this.trigger("changed");
	}

	async toggleFilterTag(tag: string): Promise<void> {
		const current = this.sink.settings.inventoryState.filterTags;
		const has = current.includes(tag);
		await this.setFilterTags(has ? current.filter((t) => t !== tag) : [...current, tag]);
	}

	async setRowScale(scale: number): Promise<void> {
		this.sink.settings.inventoryState.rowScale = scale;
		await this.sink.save();
		this.trigger("changed");
	}

	async setGroupCollapsed(groupName: string, collapsed: boolean): Promise<void> {
		if (collapsed) {
			this.sink.settings.inventoryState.collapsedGroups[groupName] = true;
		} else {
			delete this.sink.settings.inventoryState.collapsedGroups[groupName];
		}
		await this.sink.save();
		this.trigger("changed");
	}

	isGroupCollapsed(groupName: string): boolean {
		return this.sink.settings.inventoryState.collapsedGroups[groupName] ?? false;
	}

	async setLastManagedPage(filePath: string): Promise<void> {
		this.sink.settings.inventoryState.lastManagedPage = filePath;
		await this.sink.save();
	}

	getLastManagedPage(): string {
		return this.sink.settings.inventoryState.lastManagedPage;
	}

	// ------------------------------------------------------------------
	// Loading
	// ------------------------------------------------------------------

	/** (Re)scan the configured inventory folders and reload every page. */
	async refresh(): Promise<void> {
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.rebuild().finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}

	private async rebuild(): Promise<void> {
		const files = listInventoryFiles(this.app, this.sink.settings);
		const next = new Map<string, PageCacheEntry>();
		for (const file of files) {
			const page = await readInventoryPage(this.app, file);
			next.set(file.path, { file, page });
		}
		this.pages = next;
		this.trigger("changed");
	}

	// ------------------------------------------------------------------
	// Mutations — each writes straight to the owning markdown file via
	// `vault.process`, which reads the file fresh and preserves anything
	// outside the body we don't own (namely frontmatter).
	// ------------------------------------------------------------------

	private async writePage(file: TFile, page: InventoryPageContent): Promise<void> {
		await this.app.vault.process(file, (data) => replaceInventoryBody(data, page));
		this.pages.set(file.path, { file, page });
		this.trigger("changed");
	}

	private requirePage(filePath: string): PageCacheEntry {
		const entry = this.pages.get(filePath);
		if (!entry) throw new Error(`Unknown inventory page: ${filePath}`);
		return entry;
	}

	/** Add a new item to `sectionName` on the given page, creating the section if needed. */
	async addItem(filePath: string, sectionName: string, item: InventoryItem): Promise<void> {
		const entry = this.requirePage(filePath);
		const page = clonePage(entry.page);
		const section = findOrCreateSection(page, sectionName);
		section.items.push(item);
		await this.writePage(entry.file, page);
	}

	/** Update an item's fields by id, wherever it lives on the given page. */
	async updateItem(
		filePath: string,
		itemId: string,
		updates: Partial<InventoryItem>,
	): Promise<void> {
		const entry = this.requirePage(filePath);
		const page = clonePage(entry.page);
		for (const section of page.sections) {
			const item = section.items.find((i) => i.id === itemId);
			if (item) {
				Object.assign(item, updates);
				await this.writePage(entry.file, page);
				return;
			}
		}
	}

	/** Remove an item by id from the given page. */
	async removeItem(filePath: string, itemId: string): Promise<void> {
		const entry = this.requirePage(filePath);
		const page = clonePage(entry.page);
		let changed = false;
		for (const section of page.sections) {
			const before = section.items.length;
			section.items = section.items.filter((i) => i.id !== itemId);
			if (section.items.length !== before) changed = true;
		}
		if (changed) await this.writePage(entry.file, page);
	}

	/** Move an item to a different section on the same page, creating it if needed. */
	async moveItem(filePath: string, itemId: string, targetSectionName: string): Promise<void> {
		const entry = this.requirePage(filePath);
		const page = clonePage(entry.page);
		let moved: InventoryItem | null = null;
		for (const section of page.sections) {
			const idx = section.items.findIndex((i) => i.id === itemId);
			if (idx !== -1) {
				moved = section.items.splice(idx, 1)[0] ?? null;
				break;
			}
		}
		if (!moved) return;
		const target = findOrCreateSection(page, targetSectionName);
		target.items.push(moved);
		await this.writePage(entry.file, page);
	}

	/** Add a new section to a page. No-ops if a section with that name already exists. */
	async addSection(filePath: string, name: string, tags: string[]): Promise<void> {
		const entry = this.requirePage(filePath);
		const page = clonePage(entry.page);
		const trimmed = name.trim() || "Section";
		if (page.sections.some((s) => s.name.toLowerCase() === trimmed.toLowerCase())) return;
		page.sections.push({ name: trimmed, tags, items: [], extraLines: [] });
		await this.writePage(entry.file, page);
	}

	/** Rename a section and/or replace its tags. */
	async updateSection(
		filePath: string,
		oldName: string,
		updates: { name?: string; tags?: string[] },
	): Promise<void> {
		const entry = this.requirePage(filePath);
		const page = clonePage(entry.page);
		const section = page.sections.find((s) => s.name === oldName);
		if (!section) return;
		if (updates.name !== undefined) section.name = updates.name.trim() || section.name;
		if (updates.tags !== undefined) section.tags = updates.tags;
		await this.writePage(entry.file, page);
	}

	/**
	 * Remove a section. Refuses to remove the last remaining section (a
	 * page always needs at least one). Any items in the removed section are
	 * folded into the nearest remaining section instead of being deleted.
	 */
	async removeSection(filePath: string, name: string): Promise<boolean> {
		const entry = this.requirePage(filePath);
		if (entry.page.sections.length <= 1) return false;
		const page = clonePage(entry.page);
		const idx = page.sections.findIndex((s) => s.name === name);
		if (idx === -1) return false;
		const [removed] = page.sections.splice(idx, 1);
		if (removed && removed.items.length > 0) {
			const fallback = page.sections[Math.max(0, idx - 1)] ?? page.sections[0];
			fallback?.items.push(...removed.items);
		}
		await this.writePage(entry.file, page);
		return true;
	}

	/** Create a brand-new inventory page with one starter section. */
	async createPage(name: string, folder: string, firstSectionName: string): Promise<TFile> {
		const folderPath = folder.replace(/\/+$/, "").trim();
		if (folderPath && !(this.app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
			await this.app.vault.createFolder(folderPath);
		}
		const baseName = sanitizeFileName(name.trim() || "Inventory");
		const path = await this.uniqueFilePath(folderPath, baseName);
		const content = createInventoryPageContent(this.sink.settings, firstSectionName);
		const file = await this.app.vault.create(path, content);
		const page = parseInventoryBody(splitFrontmatter(content).body);
		this.pages.set(file.path, { file, page });
		this.trigger("changed");
		return file;
	}

	/** Move a page to trash and drop it from the cache. */
	async deletePage(filePath: string): Promise<void> {
		const entry = this.pages.get(filePath);
		if (!entry) return;
		await this.app.fileManager.trashFile(entry.file);
		this.pages.delete(filePath);
		this.trigger("changed");
	}

	private async uniqueFilePath(folderPath: string, baseName: string): Promise<string> {
		let candidate = folderPath ? `${folderPath}/${baseName}.md` : `${baseName}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = folderPath ? `${folderPath}/${baseName} ${n}.md` : `${baseName} ${n}.md`;
			n++;
		}
		return candidate;
	}
}

function findOrCreateSection(page: InventoryPageContent, name: string): InventorySection {
	const trimmed = name.trim() || "Items";
	let section = page.sections.find((s) => s.name === trimmed);
	if (!section) {
		section = { name: trimmed, tags: [], items: [], extraLines: [] };
		page.sections.push(section);
	}
	return section;
}

function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Inventory";
}

/** Build a brand-new inventory item with sensible defaults for quick capture. */
export function newInventoryItem(name: string): InventoryItem {
	return {
		id: generateId(),
		name: name.trim(),
		quantity: 0,
		desiredQuantity: 0,
		unit: "",
		category: null,
		dateAdded: new Date().toISOString(),
		expirationDate: null,
		notes: null,
		tags: [],
		shopLinks: [],
	};
}
