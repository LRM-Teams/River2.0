#!/usr/bin/env node
import { JsonlAuditLog } from "./curator-core/audit.ts";
import { runMemoryCuratorOnce } from "./curator-core/curate.ts";
import { FileMemoryStore } from "./curator-store/file-store.ts";
import { pushEvolution, resolveEvolutionConfig, syncEvolutionAfterChange, createEvolutionSnapshot } from "./evolution/index.ts";
import { disableCuratorService, enableCuratorService, getCuratorServiceStatus, resolveMemoryDir } from "./service-controller.ts";

function cliPath(): string {
	return new URL(import.meta.url).pathname;
}

function readOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

function usage(): string {
	return [
		"Usage:",
		"  jhp-pi-memory-curator run-once [--memory-dir <path>] [--reason <text>] [--dry-run] [--json]",
		"  jhp-pi-memory-curator snapshot [--memory-dir <path>] [--reason <text>] [--json]",
		"  jhp-pi-memory-curator push [--memory-dir <path>]",
		"  jhp-pi-memory-curator enable [--memory-dir <path>] [--schedule HH:MM]",
		"  jhp-pi-memory-curator disable [--memory-dir <path>]",
		"  jhp-pi-memory-curator status [--memory-dir <path>]",
	].join("\n");
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	const memoryDir = readOption(args, "--memory-dir") || resolveMemoryDir();

	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}

	if (command === "run-once") {
		const reason = readOption(args, "--reason") || "cli";
		const config = resolveEvolutionConfig(memoryDir);
		if (!hasFlag(args, "--dry-run")) {
			createEvolutionSnapshot(config, { reason: `curator before ${reason}`, trigger: "external_curator", commitMessage: "memory: snapshot before curator" });
		}
		const result = await runMemoryCuratorOnce({
			memoryStore: new FileMemoryStore(memoryDir),
			auditLog: new JsonlAuditLog(memoryDir),
			reason,
			dryRun: hasFlag(args, "--dry-run"),
		});
		let evolutionCommit = null;
		if (!hasFlag(args, "--dry-run")) {
			evolutionCommit = syncEvolutionAfterChange(config, "memory: sync after external curator");
			if (config.autoPush) pushEvolution(config);
		}
		if (hasFlag(args, "--json")) console.log(JSON.stringify({ ...result, evolutionCommit }, null, 2));
		else console.log(result.summary);
		return;
	}

	if (command === "snapshot") {
		const result = createEvolutionSnapshot(resolveEvolutionConfig(memoryDir), {
			reason: readOption(args, "--reason") || "cli snapshot",
			trigger: "cli",
			commitMessage: "memory: manual snapshot",
		});
		if (hasFlag(args, "--json")) console.log(JSON.stringify(result, null, 2));
		else console.log(result.manifest ? `Snapshot ${result.manifest.id}` : `Snapshot skipped: ${result.skipped}`);
		return;
	}

	if (command === "push") {
		console.log(pushEvolution(resolveEvolutionConfig(memoryDir)) || "Pushed evolution repo.");
		return;
	}

	if (command === "enable" || command === "install-service") {
		const result = enableCuratorService({ memoryDir, cliPath: cliPath(), schedule: readOption(args, "--schedule") });
		console.log(result.message);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	if (command === "disable" || command === "uninstall-service") {
		const result = disableCuratorService({ memoryDir, cliPath: cliPath() });
		console.log(result.message);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	if (command === "status") {
		const result = getCuratorServiceStatus({ memoryDir, cliPath: cliPath() });
		console.log(result.message);
		return;
	}

	console.error(`Unknown command: ${command}\n\n${usage()}`);
	process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
