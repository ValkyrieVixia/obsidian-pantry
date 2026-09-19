import { App, TFile } from "obsidian";
import {
	DEFAULT_INVENTORY_STATE_PATH,
	PantrySavedInventoryState,
} from "../settings";
import { InventoryItem, ShopLink } from "../types";

export { DEFAULT_INVENTORY_STATE_PATH };

const STATE_VERSION = 2;

interface InventoryStateFile {
	version: number;
	collapsedGroups: Record<string, boolean>;
	groupBy: "flat" | "section" | "tag";
	rowScale: number;
	filterTags: string[];
	sectionFilter: string[];
	lastManagedPage: string;
}

const MIN_ROW_SCALE = 0.8;
const MAX_ROW_SCALE = 1.4;

function clampRowScale(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 1;
	return Math.min(MAX_ROW_SCALE, Math.max(MIN_ROW_SCALE, n));
}

function normalizeGroupBy(value: unknown): "flat" | "section" | "tag" {
	return value === "section" || value === "tag" || value === "flat"
		? value
		: "flat";
}

/** Empty runtime state used when the vault file is missing or invalid. */
export function emptyInventoryState(): PantrySavedInventoryState {
	return {
		collapsedGroups: {},
		groupBy: "flat",
		rowScale: 1,
		filterTags: [],
		sectionFilter: [],
		lastManagedPage: "",
	};
}

/** True when any inventory runtime fields have content worth preserving. */
export function inventoryStateHasContent(
	state: PantrySavedInventoryState,
): boolean {
	return (
		Object.keys(state.collapsedGroups).length > 0 ||
		state.filterTags.length > 0 ||
		state.sectionFilter.length > 0 ||
		state.lastManagedPage !== ""
	);
}

/**
 * Merge vault state with legacy plugin-data state during migration.
 * Vault values win; legacy-only collapsed-group entries are kept.
 */
export function mergeInventoryState(
	vault: PantrySavedInventoryState,
	legacy: PantrySavedInventoryState,
): PantrySavedInventoryState {
	return {
		collapsedGroups: {
			...legacy.collapsedGroups,
			...vault.collapsedGroups,
		},
		groupBy: vault.groupBy,
		rowScale: vault.rowScale,
		filterTags: vault.filterTags.length > 0 ? vault.filterTags : legacy.filterTags,
		sectionFilter:
			vault.sectionFilter.length > 0 ? vault.sectionFilter : legacy.sectionFilter,
		lastManagedPage: vault.lastManagedPage || legacy.lastManagedPage,
	};
}

/** Serialize inventory view state for the vault JSON file. */
export function serializeInventoryState(state: PantrySavedInventoryState): string {
	const payload: InventoryStateFile = {
		version: STATE_VERSION,
		collapsedGroups: state.collapsedGroups,
		groupBy: state.groupBy,
		rowScale: state.rowScale,
		filterTags: state.filterTags,
		sectionFilter: state.sectionFilter,
		lastManagedPage: state.lastManagedPage,
	};
	return `${JSON.stringify(payload, null, "\t")}\n`;
}

/** Parse an inventory-state JSON file. Returns null when the content is unusable. */
export function parseInventoryState(raw: string): PantrySavedInventoryState | null {
	const trimmed = raw.trim();
	if (!trimmed) return emptyInventoryState();
	try {
		const data = JSON.parse(trimmed) as unknown;
		if (!data || typeof data !== "object") return null;
		const obj = data as Partial<InventoryStateFile>;
		return {
			collapsedGroups: normalizeStringBoolMap(obj.collapsedGroups),
			groupBy: normalizeGroupBy(obj.groupBy),
			rowScale: clampRowScale(obj.rowScale),
			filterTags: normalizeTags(obj.filterTags),
			sectionFilter: normalizeTags(obj.sectionFilter),
			lastManagedPage:
				typeof obj.lastManagedPage === "string" ? obj.lastManagedPage : "",
		};
	} catch {
		return null;
	}
}

/**
 * Read inventory state from the vault. Returns null when the file does not
 * exist yet (caller may migrate from legacy plugin data). Returns empty
 * state (and logs) when the file exists but cannot be parsed.
 */
export async function readInventoryStateFile(
	app: App,
	path: string,
): Promise<PantrySavedInventoryState | null> {
	const resolved = resolveInventoryStatePath(path);
	const file = app.vault.getAbstractFileByPath(resolved);
	if (!(file instanceof TFile)) return null;
	const raw = await app.vault.cachedRead(file);
	const parsed = parseInventoryState(raw);
	if (!parsed) {
		console.error(`pantry: failed to parse inventory state at ${resolved}`);
		return emptyInventoryState();
	}
	return parsed;
}

/**
 * Write inventory state to the vault. Creates parent folders and the JSON file
 * if they don't exist.
 */
export async function writeInventoryStateFile(
	app: App,
	path: string,
	state: PantrySavedInventoryState,
): Promise<void> {
	const resolved = resolveInventoryStatePath(path);
	const parentPath = resolved.substring(0, resolved.lastIndexOf("/"));

	if (parentPath && !app.vault.getAbstractFileByPath(parentPath)) {
		await app.vault.createFolder(parentPath);
	}

	const existing = app.vault.getAbstractFileByPath(resolved);
	const content = serializeInventoryState(state);

	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
	} else {
		await app.vault.create(resolved, content);
	}
}

/**
 * Normalize the vault path. Blank settings fall back to the default path
 * (same behaviour as shopping-state resolution).
 */
export function resolveInventoryStatePath(path: string): string {
	const trimmed = path.trim().replace(/^\/+/, "").replace(/^\.\//, "");
	return trimmed || DEFAULT_INVENTORY_STATE_PATH;
}

// ============================================================================
// Legacy migration (pre-file-based inventory) — v1.x stored items directly
// in this JSON file. Used once at startup to seed the first inventory page.
// ============================================================================

/**
 * Read the `items` array out of a legacy (v1.x) inventory-state JSON file, if
 * present. Returns an empty array for current-shape files (no `items` key)
 * or when the file is missing/unparseable.
 */
export async function readLegacyInventoryItems(
	app: App,
	path: string,
): Promise<InventoryItem[]> {
	const resolved = resolveInventoryStatePath(path);
	const file = app.vault.getAbstractFileByPath(resolved);
	if (!(file instanceof TFile)) return [];
	try {
		const raw = await app.vault.cachedRead(file);
		const data = JSON.parse(raw.trim() || "{}") as { items?: unknown };
		return normalizeInventoryItems(data.items);
	} catch {
		return [];
	}
}

/** Normalize a raw (legacy) items array into well-formed {@link InventoryItem}s. */
export function normalizeInventoryItems(raw: unknown): InventoryItem[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item) => {
			if (typeof item !== "object" || !item) return null;
			const obj = item as Record<string, unknown>;
			const id = typeof obj.id === "string" ? obj.id : null;
			if (!id) return null;
			// Legacy shapes had either a boolean `inStock` flag or nothing at all
			// (pre-quantity model). Best-effort carry the signal forward: "in
			// stock" becomes a nominal quantity of 1, unset/false becomes 0.
			// Neither legacy shape tracked a desired amount, so that's untracked
			// (0) until the user sets a target in the new stepper UI.
			const quantity =
				typeof obj.quantity === "number" && Number.isFinite(obj.quantity)
					? obj.quantity
					: obj.inStock === false
						? 0
						: 1;
			const desiredQuantity =
				typeof obj.desiredQuantity === "number" && Number.isFinite(obj.desiredQuantity)
					? obj.desiredQuantity
					: 0;
			return {
				id,
				name: typeof obj.name === "string" ? obj.name : "",
				quantity,
				desiredQuantity,
				unit: typeof obj.unit === "string" ? obj.unit : "",
				category:
					typeof obj.category === "string" ? obj.category : null,
				dateAdded:
					typeof obj.dateAdded === "string"
						? obj.dateAdded
						: new Date().toISOString(),
				expirationDate:
					typeof obj.expirationDate === "string"
						? obj.expirationDate
						: null,
				notes: typeof obj.notes === "string" ? obj.notes : null,
				tags: normalizeTags(obj.tags),
				shopLinks: normalizeShopLinks(obj.shopLinks),
			};
		})
		.filter((item) => item !== null);
}

function normalizeTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((t): t is string => typeof t === "string" && t.trim() !== "");
}

function normalizeShopLinks(raw: unknown): ShopLink[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((link) => {
			if (typeof link !== "object" || !link) return null;
			const obj = link as Record<string, unknown>;
			const url = typeof obj.url === "string" ? obj.url.trim() : "";
			if (!url) return null;
			return {
				nickname: typeof obj.nickname === "string" ? obj.nickname : "",
				url,
			};
		})
		.filter((link): link is ShopLink => link !== null)
		.slice(0, 4);
}

function normalizeStringBoolMap(raw: unknown): Record<string, boolean> {
	if (typeof raw !== "object" || !raw) return {};
	const result: Record<string, boolean> = {};
	for (const [key, val] of Object.entries(raw)) {
		if (typeof val === "boolean") result[key] = val;
	}
	return result;
}
