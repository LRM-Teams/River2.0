import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shutdownAll } from "./client.ts";
import { configCacheClear, createLspToolDefinition, syncWrittenFile } from "./tool.ts";

export default function piLsp(pi: ExtensionAPI): void {
	pi.registerTool(createLspToolDefinition(process.cwd()));

	pi.on("session_start", (_event, ctx) => {
		pi.registerTool(createLspToolDefinition(ctx.cwd));
		ctx.ui.setStatus("pi-lsp", "LSP enabled");
	});

	pi.on("session_shutdown", async () => {
		await shutdownAll();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const input = event.input as { path?: unknown; content?: unknown };
		if (typeof input.path !== "string") return;
		const content =
			typeof input.content === "string"
				? input.content
				: await fs.readFile(path.resolve(ctx.cwd, input.path), "utf8").catch(() => undefined);
		if (content === undefined) return;
		const diagnostics = await syncWrittenFile(ctx.cwd, input.path, content, ctx.signal).catch(() => undefined);
		if (!diagnostics) return;
		return {
			content: [...event.content, { type: "text" as const, text: `\n${diagnostics}` }],
		};
	});

	pi.registerCommand("lsp-reload", {
		description: "Reload pi-lsp configuration and restart language servers",
		handler: async (_args, ctx) => {
			configCacheClear(ctx.cwd);
			await shutdownAll();
			ctx.ui.notify("pi-lsp reloaded", "info");
		},
	});
}

export { createLspToolDefinition } from "./tool.ts";
export type { LspParams, LspToolDetails } from "./types.ts";
