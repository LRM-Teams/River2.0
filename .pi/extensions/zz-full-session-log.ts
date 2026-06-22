import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const LOG_ROOT_ENV = "PI_FULL_SESSION_LOG_ROOT";

function safeJson(value: unknown): JsonValue {
	const seen = new WeakSet<object>();
	const normalized = JSON.parse(
		JSON.stringify(value, (_key, current) => {
			if (typeof current === "bigint") return current.toString();
			if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
			if (current instanceof Error) {
				return { name: current.name, message: current.message, stack: current.stack };
			}
			if (current && typeof current === "object") {
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
			}
			return current;
		}),
	);
	return normalized as JsonValue;
}

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function sessionDir(ctx: ExtensionContext): string {
	const logRoot = process.env[LOG_ROOT_ENV]
		? resolve(ctx.cwd, process.env[LOG_ROOT_ENV])
		: join(ctx.cwd, ".pi", "agent", "full_session");
	const sessionFile = ctx.sessionManager.getSessionFile();
	const sessionBase = sessionFile ? basename(sessionFile, ".jsonl") : ctx.sessionManager.getSessionId();
	return join(logRoot, sessionBase);
}

function writeEvent(ctx: ExtensionContext, eventName: string, data: unknown): void {
	try {
		const dir = sessionDir(ctx);
		mkdirSync(dir, { recursive: true });

		const fileName = `${stamp()}_${eventName}.json`;
		const filePath = join(dir, fileName);
		const record = {
			event: eventName,
			timestamp: new Date().toISOString(),
			session: {
				id: ctx.sessionManager.getSessionId(),
				file: ctx.sessionManager.getSessionFile(),
				name: ctx.sessionManager.getSessionName(),
				cwd: ctx.cwd,
			},
			data,
		};

		writeFileSync(filePath, `${JSON.stringify(safeJson(record), null, 2)}\n`, "utf-8");
		appendFileSync(
			join(dir, "index.jsonl"),
			`${JSON.stringify({ event: eventName, timestamp: record.timestamp, file: relative(dir, filePath) })}\n`,
			"utf-8",
		);
	} catch (error) {
		const message = error instanceof Error ? error.stack || error.message : String(error);
		console.error(`[full-session-log] failed to write ${eventName}: ${message}`);
	}
}

export default function fullSessionLogExtension(pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		writeEvent(ctx, "session_start", {
			reason: event.reason,
			previousSessionFile: event.previousSessionFile,
			model: ctx.model,
			activeTools: pi.getActiveTools(),
			tools: pi.getAllTools(),
			commands: pi.getCommands(),
			systemPrompt: ctx.getSystemPrompt(),
		});
	});

	pi.on("input", (event, ctx) => {
		writeEvent(ctx, "input", {
			text: event.text,
			source: event.source,
			streamingBehavior: event.streamingBehavior,
			images: event.images,
		});
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		writeEvent(ctx, "before_agent_start", {
			prompt: event.prompt,
			images: event.images,
			systemPrompt: event.systemPrompt,
			systemPromptOptions: event.systemPromptOptions,
			currentSystemPrompt: ctx.getSystemPrompt(),
			model: ctx.model,
			activeTools: pi.getActiveTools(),
			tools: pi.getAllTools(),
			commands: pi.getCommands(),
		});
	});

	pi.on("context", (event, ctx) => {
		writeEvent(ctx, "context", {
			messages: event.messages,
		});
	});

	pi.on("before_provider_request", (event, ctx) => {
		writeEvent(ctx, "before_provider_request", {
			payload: event.payload,
		});
	});

	pi.on("after_provider_response", (event, ctx) => {
		writeEvent(ctx, "after_provider_response", {
			status: event.status,
			headers: event.headers,
		});
	});

	pi.on("agent_start", (_event, ctx) => {
		writeEvent(ctx, "agent_start", {});
	});

	pi.on("agent_end", (event, ctx) => {
		writeEvent(ctx, "agent_end", {
			messages: event.messages,
		});
	});

	pi.on("turn_start", (event, ctx) => {
		writeEvent(ctx, "turn_start", event);
	});

	pi.on("turn_end", (event, ctx) => {
		writeEvent(ctx, "turn_end", event);
	});

	pi.on("message_start", (event, ctx) => {
		writeEvent(ctx, "message_start", event);
	});

	pi.on("message_end", (event, ctx) => {
		writeEvent(ctx, "message_end", event);
	});

	pi.on("tool_call", (event, ctx) => {
		writeEvent(ctx, "tool_call", event);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		writeEvent(ctx, "tool_execution_start", event);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		writeEvent(ctx, "tool_execution_update", event);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		writeEvent(ctx, "tool_execution_end", event);
	});

	pi.on("tool_result", (event, ctx) => {
		writeEvent(ctx, "tool_result", event);
	});

	pi.on("model_select", (event, ctx) => {
		writeEvent(ctx, "model_select", event);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		writeEvent(ctx, "thinking_level_select", event);
	});

	pi.on("session_before_compact", (event, ctx) => {
		writeEvent(ctx, "session_before_compact", event);
	});

	pi.on("session_compact", (event, ctx) => {
		writeEvent(ctx, "session_compact", event);
	});

	pi.on("session_shutdown", (event, ctx) => {
		writeEvent(ctx, "session_shutdown", event);
	});
}
