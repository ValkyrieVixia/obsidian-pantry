import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { InventoryManager, newInventoryItem } from "../grocery/inventory-manager";
import { StringSuggest } from "./name-suggest";
import { InventoryEntry, ShopLink } from "../types";

/** Maximum number of shop links per inventory item. */
const MAX_SHOP_LINKS = 4;

/**
 * Modal that adds a new inventory item or edits an existing one.
 *
 * New items pick a page + section to live in (or create either on the fly);
 * editing an existing item keeps it on its current page but still allows
 * moving it to a different section. Have/want quantity is adjusted directly
 * on the item row's stepper, not here.
 */
export class AddItemModal extends Modal {
	private name: string;
	private unit: string;
	private expirationDate: string;
	private notes: string;
	private tagsText: string;
	private shopLinks: ShopLink[];
	private shopLinksEl!: HTMLElement;
	private pickerEl!: HTMLElement;
	private readonly existingEntry: InventoryEntry | null;

	/** Target page/section for a new item, or the current section while editing. */
	private filePath: string;
	private sectionName: string;
	private newPageMode = false;
	private newPageName = "";
	private newPageFolder: string;
	private newSectionMode = false;
	private newSectionName = "Items";

	constructor(
		app: App,
		private readonly manager: InventoryManager,
		defaultContext: { filePath: string; sectionName: string },
		existingEntry?: InventoryEntry,
	) {
		super(app);
		this.existingEntry = existingEntry ?? null;
		const item = existingEntry?.item;
		this.name = item?.name ?? "";
		this.unit = item?.unit ?? "";
		this.expirationDate = item?.expirationDate ?? "";
		this.notes = item?.notes ?? "";
		this.tagsText = (item?.tags ?? []).join(", ");
		this.shopLinks = (item?.shopLinks ?? []).map((l) => ({ ...l }));

		this.filePath = existingEntry?.filePath ?? defaultContext.filePath;
		this.sectionName = existingEntry?.sectionName ?? defaultContext.sectionName;
		this.newPageFolder = manager.getPages()[0]?.file.parent?.path ?? "";
		if (!this.filePath && manager.getPages().length === 0) {
			this.newPageMode = true;
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const editing = this.existingEntry !== null;
		contentEl.createEl("h2", {
			text: editing ? "Edit inventory item" : "Add inventory item",
		});

		new Setting(contentEl).setName("Name").addText((text) => {
			text
				.setPlaceholder("Item name")
				.setValue(this.name)
				.onChange((value) => {
					this.name = value;
				});
			new StringSuggest(
				this.app,
				text.inputEl,
				() => this.manager.getKnownItemNames(),
				(value) => {
					this.name = value;
					if (!editing) this.prefillFromExisting(value);
				},
			);
		});

		this.pickerEl = contentEl.createDiv({ cls: "pantry-inventory-picker" });
		this.renderPicker();

		new Setting(contentEl).setName("Unit").addText((text) =>
			text
				.setPlaceholder("E.g., cups, lbs, oz (optional)")
				.setValue(this.unit)
				.onChange((value) => {
					this.unit = value;
				}),
		);

		new Setting(contentEl)
			.setName("Tags")
			.setDesc("Labels for filtering and organizing items, on top of the section's own tags.")
			.addText((text) =>
				text
					.setPlaceholder("E.g., baking, breakfast")
					.setValue(this.tagsText)
					.onChange((value) => {
						this.tagsText = value;
					}),
			);

		new Setting(contentEl)
			.setName("Expiration date")
			.setDesc("Date the item expires (optional).")
			.addText((text) =>
				text
					.setPlaceholder("2024-12-31")
					.setValue(this.expirationDate)
					.onChange((value) => {
						this.expirationDate = value;
					}),
			);

		new Setting(contentEl)
			.setName("Notes")
			.setDesc("Optional notes about this item.")
			.addTextArea((text) =>
				text
					.setPlaceholder("E.g., location, opened date, etc.")
					.setValue(this.notes)
					.onChange((value) => {
						this.notes = value;
					}),
			);

		new Setting(contentEl)
			.setName("Shop links")
			.setDesc(`Up to ${MAX_SHOP_LINKS} direct links to this item at stores you shop at. Each opens exactly as entered.`)
			.setHeading();

		this.shopLinksEl = contentEl.createDiv({ cls: "pantry-shop-link-editor" });
		this.renderShopLinks();

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Cancel")
					.onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText(editing ? "Save" : "Add")
					.setCta()
					.onClick(() => {
						void this.submit();
					}),
			);
	}

	private renderShopLinks(): void {
		this.shopLinksEl.empty();

		this.shopLinks.forEach((link, index) => {
			const row = this.shopLinksEl.createDiv({ cls: "pantry-shop-link-row" });

			const nicknameInput = row.createEl("input", {
				cls: "pantry-shop-link-nickname",
				type: "text",
				attr: { placeholder: "Store name" },
			});
			nicknameInput.value = link.nickname;
			nicknameInput.addEventListener("input", () => {
				link.nickname = nicknameInput.value;
			});

			const urlInput = row.createEl("input", {
				cls: "pantry-shop-link-url",
				type: "text",
				attr: { placeholder: "Product page URL" },
			});
			urlInput.value = link.url;
			urlInput.addEventListener("input", () => {
				link.url = urlInput.value;
			});

			const removeBtn = row.createEl("button", {
				cls: "clickable-icon pantry-remove",
				attr: { title: "Remove shop link" },
			});
			setIcon(removeBtn, "trash-2");
			removeBtn.addEventListener("click", () => {
				this.shopLinks.splice(index, 1);
				this.renderShopLinks();
			});
		});

		if (this.shopLinks.length < MAX_SHOP_LINKS) {
			const addBtn = this.shopLinksEl.createEl("button", {
				text: "Add shop link",
			});
			addBtn.addEventListener("click", () => {
				this.shopLinks.push({ nickname: "", url: "" });
				this.renderShopLinks();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Copies unit/tags/expiration/shop links from the most recent match, for one-click refills. */
	private prefillFromExisting(name: string): void {
		const match = this.manager.findMostRecentItemByName(name);
		if (!match) return;
		this.unit = match.unit;
		this.tagsText = match.tags.join(", ");
		this.expirationDate = "";
		this.notes = match.notes ?? "";
		this.shopLinks = match.shopLinks.map((l) => ({ ...l }));
		this.onOpen();
	}

	/** Page + section picker. Editing keeps the page fixed but still allows re-sectioning. */
	private renderPicker(): void {
		this.pickerEl.empty();
		const pages = this.manager.getPages();

		if (this.existingEntry) {
			new Setting(this.pickerEl)
				.setName("Inventory page")
				.setDesc(this.existingEntry.pageName);
			this.renderSectionPicker(pages.find((p) => p.file.path === this.filePath)?.page.sections ?? []);
			return;
		}

		new Setting(this.pickerEl).setName("Inventory page").addDropdown((dd) => {
			for (const p of pages) dd.addOption(p.file.path, p.file.basename);
			dd.addOption("__new__", "New inventory page…");
			dd.setValue(this.newPageMode || pages.length === 0 ? "__new__" : this.filePath);
			dd.onChange((value) => {
				if (value === "__new__") {
					this.newPageMode = true;
				} else {
					this.newPageMode = false;
					this.filePath = value;
					const page = pages.find((p) => p.file.path === value)?.page;
					this.sectionName = page?.sections[0]?.name ?? "Items";
				}
				this.renderPicker();
			});
		});

		if (this.newPageMode || pages.length === 0) {
			new Setting(this.pickerEl).setName("Page name").addText((t) =>
				t
					.setPlaceholder("Dry goods")
					.setValue(this.newPageName)
					.onChange((v) => {
						this.newPageName = v;
					}),
			);
			new Setting(this.pickerEl)
				.setName("Folder")
				.setDesc("Vault-relative folder for the new page.")
				.addText((t) =>
					t.setValue(this.newPageFolder).onChange((v) => {
						this.newPageFolder = v;
					}),
				);
			new Setting(this.pickerEl).setName("First section name").addText((t) =>
				t.setValue(this.newSectionName).onChange((v) => {
					this.newSectionName = v;
				}),
			);
			return;
		}

		const page = pages.find((p) => p.file.path === this.filePath)?.page;
		this.renderSectionPicker(page?.sections ?? []);
	}

	private renderSectionPicker(sections: Array<{ name: string }>): void {
		new Setting(this.pickerEl).setName("Section").addDropdown((dd) => {
			for (const s of sections) dd.addOption(s.name, s.name);
			dd.addOption("__new__", "New section…");
			dd.setValue(this.newSectionMode || sections.length === 0 ? "__new__" : this.sectionName);
			dd.onChange((value) => {
				if (value === "__new__") {
					this.newSectionMode = true;
				} else {
					this.newSectionMode = false;
					this.sectionName = value;
				}
				this.renderPicker();
			});
		});

		if (this.newSectionMode || sections.length === 0) {
			new Setting(this.pickerEl).setName("New section name").addText((t) =>
				t
					.setPlaceholder("Pantry, cabinet")
					.setValue(this.newSectionName)
					.onChange((v) => {
						this.newSectionName = v;
					}),
			);
		}
	}

	private async submit(): Promise<void> {
		const name = this.name.trim();

		if (!name) {
			new Notice("Please enter an item name.");
			return;
		}

		const unit = this.unit.trim();
		const expirationDate = this.expirationDate.trim() || null;
		const notes = this.notes.trim() || null;
		const tags = this.tagsText
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const shopLinks = this.shopLinks
			.map((l) => ({ nickname: l.nickname.trim(), url: l.url.trim() }))
			.filter((l) => l.url !== "");

		const fieldUpdates = { name, unit, expirationDate, notes, tags, shopLinks };

		try {
			if (this.existingEntry) {
				await this.manager.updateItem(
					this.existingEntry.filePath,
					this.existingEntry.item.id,
					fieldUpdates,
				);
				const targetSection = this.newSectionMode
					? this.newSectionName.trim() || "Section"
					: this.sectionName;
				if (targetSection !== this.existingEntry.sectionName) {
					await this.manager.moveItem(
						this.existingEntry.filePath,
						this.existingEntry.item.id,
						targetSection,
					);
				}
			} else {
				const item = { ...newInventoryItem(name), ...fieldUpdates };
				if (this.newPageMode || this.manager.getPages().length === 0) {
					const sectionName = this.newSectionName.trim() || "Items";
					const file = await this.manager.createPage(
						this.newPageName,
						this.newPageFolder,
						sectionName,
					);
					await this.manager.addItem(file.path, sectionName, item);
				} else {
					const sectionName = this.newSectionMode
						? this.newSectionName.trim() || "Section"
						: this.sectionName;
					await this.manager.addItem(this.filePath, sectionName, item);
				}
			}
			this.close();
		} catch (e) {
			new Notice(`Error saving item: ${String(e)}`);
		}
	}
}

