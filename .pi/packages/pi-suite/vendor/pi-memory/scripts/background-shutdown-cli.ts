#!/usr/bin/env node
/**
 * Detached background-shutdown worker CLI.
 *
 * Invoked by the memory extension's `session_shutdown` handler (when
 * `PI_MEMORY_BACKGROUND_SHUTDOWN` is active) via:
 *
 *   node <this-script> --payload <path-to-json-payload>
 *
 * The payload (written by the parent) carries the session file, session id,
 * reason, and serialized model. The API key is passed via the private
 * `__PI_MEMORY_BG_KEY` env var so it never lands on disk.
 *
 * This worker performs the full final-exit memory workload (exit summary,
 * learning extractor, curator, qmd update, sync upload) and then removes the
 * payload file. It always exits 0 — failures are best-effort and logged to
 * `<memory>/audit/background-shutdown-errors.jsonl` — because the parent
 * process has already returned to its caller.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runBackgroundShutdown, readPayload, type BackgroundShutdownPayload } from "../src/background-shutdown.ts";

function readOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
	const payloadPath = readOption(process.argv.slice(2), "--payload");
	if (!payloadPath) {
		console.error("background-shutdown-cli: missing --payload <path>");
		process.exit(0);
	}

	const apiKey = process.env.__PI_MEMORY_BG_KEY;
	delete process.env.__PI_MEMORY_BG_KEY;

	let payload: BackgroundShutdownPayload;
	try {
		payload = readPayload(payloadPath);
	} catch (err) {
		console.error(`background-shutdown-cli: failed to read payload: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(0);
	}

	try {
		await runBackgroundShutdown(payload, apiKey);
	} catch (err) {
		// Best-effort: append to the memory audit log if the memory dir is resolvable.
		try {
			const memoryDir = process.env.PI_MEMORY_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent", "memory");
			const auditDir = path.join(memoryDir, "audit");
			fs.mkdirSync(auditDir, { recursive: true });
			fs.appendFileSync(
				path.join(auditDir, "background-shutdown-errors.jsonl"),
				`${JSON.stringify({ ts: new Date().toISOString(), error: err instanceof Error ? err.message : String(err), sessionFile: payload.sessionFile })}\n`,
				"utf-8",
			);
		} catch {
			// Swallow — the parent has already returned.
		}
	} finally {
		try {
			fs.unlinkSync(payloadPath);
		} catch {
			// Payload may already be gone or on a read-only fs; ignore.
		}
	}
}

void main();
