#!/usr/bin/env node
import { JsonlAuditLog, runMemoryCuratorOnce } from "./index.ts";
import { DEFAULT_MEMORY_DIR, FileMemoryStore } from "./store/file-store.ts";

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
	const command = argv[0];
	if (!command || command === "--help" || command === "-h") {
		printHelp();
		return command ? 0 : 1;
	}
	if (command !== "run-once") {
		console.error(command === "daemon" ? "daemon is not implemented in this slice" : `Unknown command '${command}'`);
		return 1;
	}

	const args = parseArgs(argv.slice(1));
	const memoryDirArg = args["memory-dir"];
	const memoryDir = typeof memoryDirArg === "string" && memoryDirArg ? memoryDirArg : DEFAULT_MEMORY_DIR;
	const auditArg = args.audit;
	const auditPath = typeof auditArg === "string" && auditArg ? auditArg : undefined;
	const store = new FileMemoryStore(memoryDir);
	const result = await runMemoryCuratorOnce({
		memoryStore: store,
		auditLog: new JsonlAuditLog(memoryDir, auditPath),
		dryRun: Boolean(args["dry-run"]),
		reason: "cli run-once",
	});
	if (args.json) {
		console.log(JSON.stringify(result, null, 2));
	} else if (args["dry-run"]) {
		console.log(`${result.summary} (dry run)`);
		console.log(JSON.stringify(result.patches, null, 2));
	} else {
		console.log(result.summary);
	}
	return 0;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
	const result: Record<string, string | boolean> = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		if (key === "dry-run" || key === "json" || key === "strict-lock") {
			result[key] = true;
			continue;
		}
		result[key] = argv[index + 1] || "";
		index++;
	}
	return result;
}

function printHelp(): void {
	console.log(`Usage:\n  pi-memory-curator run-once --memory-dir ~/.pi/agent/memory [--audit path] [--dry-run] [--json]\n  pi-memory-curator daemon --schedule "0 3 * * *" --memory-dir ~/.pi/agent/memory`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	runCli().then((code) => process.exit(code)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
