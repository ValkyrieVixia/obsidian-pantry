import { InventoryItem } from "../types";

/** Inventory item status for visual flagging. */
export enum ItemStatus {
	/** Stock-tracked (desired > 0) and currently at/below zero. */
	OUT_OF_STOCK = "out-of-stock",
	/** Item has expired. */
	EXPIRED = "expired",
	/** Item is expiring soon (within threshold days). */
	EXPIRING_SOON = "expiring-soon",
	/** Stock-tracked and below half the desired amount, but not out. */
	LOW = "low",
	/** Not stock-tracked (no desired amount set) and currently at zero. */
	UNTRACKED = "untracked",
	/** Sufficient stock (or untracked with some on hand) and not expiring. */
	OK = "ok",
}

/** Configuration for status calculation. */
export interface StatusConfig {
	/** Days until expiration considered "soon" (default: 7). */
	expiringThresholdDays: number;
}

const DEFAULT_CONFIG: StatusConfig = {
	expiringThresholdDays: 7,
};

/**
 * Determine the status of an inventory item from its have/want quantities
 * and expiration date. Priority: out of stock > expired > low/expiring soon
 * > untracked > ok.
 */
export function getItemStatus(
	item: InventoryItem,
	config: StatusConfig = DEFAULT_CONFIG,
): ItemStatus {
	const have = item.quantity || 0;
	const want = item.desiredQuantity || 0;
	const isTracked = want > 0;

	if (isTracked && have <= 0) {
		return ItemStatus.OUT_OF_STOCK;
	}

	if (item.expirationDate) {
		const expDate = new Date(item.expirationDate);
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		if (expDate < today) {
			return ItemStatus.EXPIRED;
		}

		const expiringDate = new Date(today);
		expiringDate.setDate(
			expiringDate.getDate() + config.expiringThresholdDays,
		);
		if (expDate < expiringDate) {
			return ItemStatus.EXPIRING_SOON;
		}
	}

	if (isTracked && have < want / 2) {
		return ItemStatus.LOW;
	}

	if (!isTracked && have <= 0) {
		return ItemStatus.UNTRACKED;
	}

	return ItemStatus.OK;
}

/** Get CSS class for status color. */
export function getStatusClass(status: ItemStatus): string {
	switch (status) {
		case ItemStatus.OUT_OF_STOCK:
		case ItemStatus.EXPIRED:
			return "pantry-status-danger";
		case ItemStatus.LOW:
		case ItemStatus.EXPIRING_SOON:
			return "pantry-status-warning";
		case ItemStatus.UNTRACKED:
			return "pantry-status-neutral";
		default:
			return "pantry-status-ok";
	}
}

/** Get human-readable status label. */
export function getStatusLabel(status: ItemStatus): string {
	switch (status) {
		case ItemStatus.OUT_OF_STOCK:
			return "Out of stock";
		case ItemStatus.EXPIRED:
			return "Expired";
		case ItemStatus.EXPIRING_SOON:
			return "Expiring soon";
		case ItemStatus.LOW:
			return "Low stock";
		case ItemStatus.UNTRACKED:
			return "Not tracked";
		default:
			return "In stock";
	}
}

/** Get icon name for status. */
export function getStatusIcon(status: ItemStatus): string {
	switch (status) {
		case ItemStatus.OUT_OF_STOCK:
			return "circle-x";
		case ItemStatus.EXPIRED:
			return "alert-circle";
		case ItemStatus.EXPIRING_SOON:
			return "clock-alert";
		case ItemStatus.LOW:
			return "trending-down";
		case ItemStatus.UNTRACKED:
			return "circle-dashed";
		default:
			return "check-circle-2";
	}
}
