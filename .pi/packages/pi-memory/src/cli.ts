#!/usr/bin/env node
import { JsonlAuditLog } from "./curator-core/audit.ts";
import { runMemoryCuratorOnce } from "./curator-core/curate.ts";
import { FileMemoryStore } from "./curator-store/file-store.ts";
import { defaultRegistryPath, markCurrentRootDirty, scanDirtyRoots } from "./manager/local-curator-manager.ts";
import {
	disableCuratorManagerService,
	disableCuratorService,
	enableCuratorManagerService,
	enableCuratorService,
	getCuratorManagerServiceStatus,
	getCuratorServiceStatus,
	resolveMemoryDir,
} from "./service-controller.ts";

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
		"  jhp-pi-memory-curator enable [--memory-dir <path>] [--schedule HH:MM]",
		"  jhp-pi-memory-curator disable [--memory-dir <path>]",
		"  jhp-pi-memory-curator status [--memory-dir <path>]",
		"  jhp-pi-memory-curator mark-dirty [--registry <path>]",
		"  jhp-pi-memory-curator manager-scan [--registry <path>] [--json]",
		"  jhp-pi-memory-curator manager-enable [--registry <path>] [--schedule '0 */6 * * *']",
		"  jhp-pi-memory-curator manager-disable [--registry <path>]",
		"  jhp-pi-memory-curator manager-status [--registry <path>]",
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
		const result = await runMemoryCuratorOnce({
			memoryStore: new FileMemoryStore(memoryDir),
			auditLog: new JsonlAuditLog(memoryDir),
			reason: readOption(args, "--reason") || "cli",
			dryRun: hasFlag(args, "--dry-run"),
		});
		if (hasFlag(args, "--json")) console.log(JSON.stringify(result, null, 2));
		else console.log(result.summary);
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

	if (command === "mark-dirty") {
		const registryPath = readOption(args, "--registry") || defaultRegistryPath();
		const record = markCurrentRootDirty(process.env, registryPath);
		if (hasFlag(args, "--json")) console.log(JSON.stringify(record, null, 2));
		else console.log(`Marked dirty: ${record.agent_root}`);
		return;
	}

	if (command === "manager-scan") {
		const registryPath = readOption(args, "--registry") || defaultRegistryPath();
		const result = await scanDirtyRoots(registryPath);
		if (hasFlag(args, "--json")) console.log(JSON.stringify(result, null, 2));
		else console.log(`Local curator manager processed ${result.processed} root(s), ${result.failures} failure(s).`);
		return;
	}

	if (command === "manager-enable") {
		const registryPath = readOption(args, "--registry") || defaultRegistryPath();
		const result = enableCuratorManagerService({ registryPath, cliPath: cliPath(), schedule: readOption(args, "--schedule") });
		console.log(result.message);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	if (command === "manager-disable") {
		const registryPath = readOption(args, "--registry") || defaultRegistryPath();
		const result = disableCuratorManagerService({ registryPath, cliPath: cliPath() });
		console.log(result.message);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	if (command === "manager-status") {
		const registryPath = readOption(args, "--registry") || defaultRegistryPath();
		const result = getCuratorManagerServiceStatus({ registryPath, cliPath: cliPath() });
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
