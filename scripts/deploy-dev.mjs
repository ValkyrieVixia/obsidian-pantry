import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

/** Separate plugin id so this coexists with the real "pantry" install in the same vault. */
const DEV_PLUGIN_ID = "pantry-dev";

const deployDir = path.join(
	homedir(),
	"Documents",
	"Domus",
	".obsidian",
	"plugins",
	DEV_PLUGIN_ID,
);

/** Copy build output into the dev test vault, patching id/version so it's clearly the dev build. */
export function deployToTestVault() {
	mkdirSync(deployDir, { recursive: true });

	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	manifest.id = DEV_PLUGIN_ID;
	manifest.version = `${manifest.version}-dev`;
	writeFileSync(
		path.join(deployDir, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);

	copyFileSync("main.js", path.join(deployDir, "main.js"));
	if (existsSync("styles.css")) {
		copyFileSync("styles.css", path.join(deployDir, "styles.css"));
	}

	console.log(`[deploy] synced to ${deployDir} (id: ${manifest.id}, version: ${manifest.version})`);
}

// Allow `node scripts/deploy-dev.mjs` to run this standalone (used by the "deploy" npm script).
if (import.meta.url === `file://${process.argv[1]}`) {
	deployToTestVault();
}
