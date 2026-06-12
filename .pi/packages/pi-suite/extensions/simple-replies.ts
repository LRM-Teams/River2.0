import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function simpleRepliesExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		if (event.prompt.trim().toLowerCase() !== "hi") return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\nFor this turn only, the user's entire message is "hi". Reply exactly: hi`,
		};
	});
}
