import { App, TFile, TFolder } from "obsidian";
import { PantrySettings } from "../settings";

/** Collect markdown files under a folder without calling vault.getMarkdownFiles(). */
export function collectMarkdownFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "md") {
			files.push(child);
		} else if (child instanceof TFolder) {
			files.push(...collectMarkdownFiles(child));
		}
	}
	return files;
}

/** True when a file lives inside one of `folders` (or `folders` is empty = whole vault). */
export function fileInFolders(file: TFile, folders: string[]): boolean {
	if (folders.length === 0) return true;
	return folders.some((folder) => {
		const f = folder.replace(/\/+$/, "").trim();
		if (!f) return true;
		return file.path === f || file.path.startsWith(`${f}/`);
	});
}

/** Markdown files under `folders`, or the entire vault when `folders` is empty. */
export function listMarkdownFilesInFolders(
	app: App,
	folders: string[],
): TFile[] {
	const cleaned = folders.map((f) => f.replace(/\/+$/, "").trim()).filter(Boolean);

	if (cleaned.length === 0) {
		return collectMarkdownFiles(app.vault.getRoot());
	}

	const seen = new Set<string>();
	const out: TFile[] = [];
	for (const folderPath of cleaned) {
		const folder = app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) continue;
		for (const file of collectMarkdownFiles(folder)) {
			if (seen.has(file.path)) continue;
			seen.add(file.path);
			out.push(file);
		}
	}
	return out;
}

/**
 * Markdown files under the user's configured recipe folders, or the
 * entire vault root when no folders are configured.
 */
export function listMarkdownFilesInRecipeFolders(
	app: App,
	settings: PantrySettings,
): TFile[] {
	return listMarkdownFilesInFolders(app, settings.recipeFolders);
}
