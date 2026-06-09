import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function memoryCuratorExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.notify(
			"memory-curator.ts is deprecated. Use @jhp/pi-memory's memory_curator_enable, memory_curator_disable, and memory_curator_status tools instead.",
			"info",
		);
	});
}
