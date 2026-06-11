import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function dumpSystemPromptExtension(pi: ExtensionAPI) {
	pi.registerCommand("dump-system-prompt", {
		description: "Write current effective system prompt to .pi/system-prompt.current.md.",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			const path = `${ctx.cwd}/.pi/system-prompt.current.md`;
			writeFileSync(path, prompt);
			ctx.ui.notify(`Wrote ${prompt.length} chars to ${path}`, "info");
		},
	});
}
