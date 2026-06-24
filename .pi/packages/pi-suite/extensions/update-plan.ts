import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type PlanStatus = "pending" | "in_progress" | "completed" | "abandoned";

interface PlanItem {
	content: string;
	status: PlanStatus;
	notes?: string[];
}

interface PlanPhase {
	name: string;
	items: PlanItem[];
}

interface PlanDetails {
	op: string;
	phases: PlanPhase[];
	error?: string;
}

const PLAN_TOOL_NAME = "update_plan";
const PLAN_STATE_TYPE = "update-plan-state";
const WIDGET_KEY = "update-plan";

const PlanOp = StringEnum(["list", "init", "start", "done", "drop", "rm", "append", "note"] as const);

const PlanOperation = Type.Object({
	op: PlanOp,
	list: Type.Optional(
		Type.Array(
			Type.Object({
				phase: Type.String({ description: "Phase name" }),
				items: Type.Array(Type.String({ description: "Task content" }), { minItems: 1 }),
			}),
		),
	),
	task: Type.Optional(Type.String({ description: "Exact task content" })),
	phase: Type.Optional(Type.String({ description: "Exact phase name" })),
	items: Type.Optional(Type.Array(Type.String({ description: "Task content" }), { minItems: 1 })),
	text: Type.Optional(Type.String({ description: "Note text" })),
});

const UpdatePlanParams = Type.Object({
	ops: Type.Array(PlanOperation, { minItems: 1, description: "Ordered plan operations" }),
});

type PlanOperationInput = {
	op: "list" | "init" | "start" | "done" | "drop" | "rm" | "append" | "note";
	list?: Array<{ phase: string; items: string[] }>;
	task?: string;
	phase?: string;
	items?: string[];
	text?: string;
};

type UpdatePlanInput = { ops: PlanOperationInput[] };

function cloneItem(item: PlanItem): PlanItem {
	return {
		content: item.content,
		status: item.status,
		...(item.notes && item.notes.length > 0 ? { notes: [...item.notes] } : {}),
	};
}

function clonePhases(phases: PlanPhase[]): PlanPhase[] {
	return phases.map((phase) => ({ name: phase.name, items: phase.items.map(cloneItem) }));
}

function countItems(phases: PlanPhase[]): { total: number; done: number; open: number } {
	let total = 0;
	let done = 0;
	let open = 0;
	for (const phase of phases) {
		for (const item of phase.items) {
			total++;
			if (item.status === "completed") done++;
			if (item.status === "pending" || item.status === "in_progress") open++;
		}
	}
	return { total, done, open };
}

function normalizeOpenTask(phases: PlanPhase[]): void {
	const items = phases.flatMap((phase) => phase.items);
	const active = items.filter((item) => item.status === "in_progress");
	for (const item of active.slice(1)) {
		item.status = "pending";
	}
	if (active.length > 0) return;
	const next = items.find((item) => item.status === "pending");
	if (next) next.status = "in_progress";
}

function findPhase(phases: PlanPhase[], name: string | undefined): PlanPhase | undefined {
	if (!name) return undefined;
	return phases.find((phase) => phase.name === name);
}

function findTask(phases: PlanPhase[], content: string | undefined): { phase: PlanPhase; item: PlanItem } | undefined {
	if (!content) return undefined;
	for (const phase of phases) {
		const item = phase.items.find((candidate) => candidate.content === content);
		if (item) return { phase, item };
	}
	return undefined;
}

function renderTextPlan(phases: PlanPhase[]): string {
	if (phases.length === 0) return "No active plan.";
	const lines: string[] = [];
	for (const phase of phases) {
		lines.push(`${phase.name}:`);
		for (const item of phase.items) {
			const marker = item.status === "completed" ? "[x]" : item.status === "abandoned" ? "[-]" : item.status === "in_progress" ? "[>]" : "[ ]";
			lines.push(`  ${marker} ${item.content}`);
			if (item.status === "in_progress" && item.notes && item.notes.length > 0) {
				for (const note of item.notes.slice(-2)) lines.push(`      note: ${note}`);
			}
		}
	}
	const counts = countItems(phases);
	lines.push(``);
	lines.push(`${counts.done}/${counts.total} completed, ${counts.open} open`);
	return lines.join("\n");
}

function renderWidgetLines(ctx: ExtensionContext, phases: PlanPhase[]): string[] | undefined {
	if (phases.length === 0) return undefined;
	const th = ctx.ui.theme;
	const counts = countItems(phases);
	const lines: string[] = [th.fg("accent", `Plan ${counts.done}/${counts.total}`)];
	let shown = 0;
	let hidden = 0;
	for (const phase of phases) {
		const openItems = phase.items.filter((item) => item.status === "pending" || item.status === "in_progress");
		if (openItems.length === 0) continue;
		if (shown >= 6) {
			hidden += openItems.length;
			continue;
		}
		lines.push(th.fg("muted", phase.name));
		for (const item of openItems) {
			if (shown >= 6) {
				hidden++;
				continue;
			}
			const marker = item.status === "in_progress" ? th.fg("accent", "[>]") : th.fg("muted", "[ ]");
			lines.push(`${marker} ${item.content}`);
			shown++;
		}
	}
	if (hidden > 0) lines.push(th.fg("dim", `... ${hidden} more`));
	if (counts.open === 0) lines.push(th.fg("success", "All plan items are closed."));
	return lines;
}

function updatePlanUi(ctx: ExtensionContext, phases: PlanPhase[]): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, renderWidgetLines(ctx, phases));
	const counts = countItems(phases);
	ctx.ui.setStatus(WIDGET_KEY, counts.total > 0 ? ctx.ui.theme.fg("accent", `plan ${counts.done}/${counts.total}`) : undefined);
}

function applyOperation(phases: PlanPhase[], op: PlanOperationInput): string | undefined {
	switch (op.op) {
		case "list":
			return undefined;
		case "init": {
			if (!op.list || op.list.length === 0) return "init requires list";
			phases.splice(
				0,
				phases.length,
				...op.list.map((phase) => ({
					name: phase.phase,
					items: phase.items.map((content, index) => ({ content, status: index === 0 && phases.length === 0 ? "in_progress" : "pending" as PlanStatus })),
				})),
			);
			normalizeOpenTask(phases);
			return undefined;
		}
		case "append": {
			if (!op.phase) return "append requires phase";
			if (!op.items || op.items.length === 0) return "append requires items";
			let phase = findPhase(phases, op.phase);
			if (!phase) {
				phase = { name: op.phase, items: [] };
				phases.push(phase);
			}
			phase.items.push(...op.items.map((content) => ({ content, status: "pending" as PlanStatus })));
			normalizeOpenTask(phases);
			return undefined;
		}
		case "start": {
			const hit = findTask(phases, op.task);
			if (!hit) return "start requires an existing task";
			for (const phase of phases) {
				for (const item of phase.items) {
					if (item.status === "in_progress") item.status = "pending";
				}
			}
			hit.item.status = "in_progress";
			return undefined;
		}
		case "done":
		case "drop": {
			const status: PlanStatus = op.op === "done" ? "completed" : "abandoned";
			if (op.task) {
				const hit = findTask(phases, op.task);
				if (!hit) return `${op.op} requires an existing task`;
				hit.item.status = status;
			} else if (op.phase) {
				const phase = findPhase(phases, op.phase);
				if (!phase) return `${op.op} requires an existing phase`;
				for (const item of phase.items) item.status = status;
			} else {
				return `${op.op} requires task or phase`;
			}
			normalizeOpenTask(phases);
			return undefined;
		}
		case "rm": {
			if (!op.task && !op.phase) {
				phases.splice(0, phases.length);
				return undefined;
			}
			if (op.task) {
				const hit = findTask(phases, op.task);
				if (!hit) return "rm requires an existing task";
				hit.phase.items = hit.phase.items.filter((item) => item !== hit.item);
			} else if (op.phase) {
				const index = phases.findIndex((phase) => phase.name === op.phase);
				if (index < 0) return "rm requires an existing phase";
				phases.splice(index, 1);
			}
			for (let i = phases.length - 1; i >= 0; i--) {
				if (phases[i].items.length === 0) phases.splice(i, 1);
			}
			normalizeOpenTask(phases);
			return undefined;
		}
		case "note": {
			if (!op.text) return "note requires text";
			const hit = findTask(phases, op.task);
			if (!hit) return "note requires an existing task";
			hit.item.notes = [...(hit.item.notes ?? []), op.text];
			return undefined;
		}
	}
}

export default function updatePlanExtension(pi: ExtensionAPI): void {
	let phases: PlanPhase[] = [];

	function restoreFromEntries(ctx: ExtensionContext): void {
		phases = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PLAN_STATE_TYPE) {
				const data = entry.data as { phases?: PlanPhase[] } | undefined;
				if (data?.phases) phases = clonePhases(data.phases);
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
			if (message.role !== "toolResult" || message.toolName !== PLAN_TOOL_NAME || message.isError) continue;
			const details = message.details as PlanDetails | undefined;
			if (details?.phases) phases = clonePhases(details.phases);
		}
		updatePlanUi(ctx, phases);
	}

	pi.on("session_start", async (_event, ctx) => restoreFromEntries(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreFromEntries(ctx));

	pi.on("before_agent_start", async () => {
		if (!pi.getActiveTools().includes(PLAN_TOOL_NAME)) return;
		return {
			message: {
				customType: "update-plan-guidance",
				content: `<update_plan_guidance>\nFor non-trivial tasks with 3+ distinct steps, or when the user provides a checklist/plan, call update_plan before implementation. Keep exactly one open task in_progress, update it immediately after each completed step, and do not use update_plan for trivial one-step requests.\n</update_plan_guidance>`,
				display: false,
			},
		};
	});

	pi.registerTool({
		name: PLAN_TOOL_NAME,
		label: "Update Plan",
		description:
			"Maintain a visible execution plan. Use for multi-step tasks: init the plan, mark exactly one task in_progress, and mark tasks done/drop as work proceeds.",
		promptSnippet: "Maintain a visible execution plan for non-trivial multi-step tasks.",
		promptGuidelines: [
			"For tasks with 3+ distinct steps, or when the user provides a checklist, call update_plan with init before doing the work.",
			"Keep exactly one open task in_progress; mark tasks done immediately after completing them.",
			"Do not use update_plan for trivial single-step requests.",
		],
		parameters: UpdatePlanParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: UpdatePlanInput, _signal, _onUpdate, ctx) {
			let error: string | undefined;
			for (const op of params.ops) {
				error = applyOperation(phases, op);
				if (error) break;
			}
			updatePlanUi(ctx, phases);
			const lastOp = params.ops[params.ops.length - 1]?.op ?? "list";
			const text = error ? `Error: ${error}` : renderTextPlan(phases);
			return {
				content: [{ type: "text", text }],
				details: { op: lastOp, phases: clonePhases(phases), error } satisfies PlanDetails,
				isError: error ? true : undefined,
			};
		},
		renderCall(args: UpdatePlanInput, theme: Theme) {
			const ops = args.ops?.map((op) => op.op).join("+") || "list";
			return new Text(`${theme.fg("toolTitle", theme.bold("update_plan"))} ${theme.fg("muted", ops)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme: Theme) {
			const details = result.details as PlanDetails | undefined;
			if (!details) {
				const block = result.content?.find((item) => item.type === "text");
				return new Text(block?.text ?? "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const snapshot = details.phases ?? [];
			if (snapshot.length === 0) return new Text(theme.fg("dim", "No active plan"), 0, 0);
			const counts = countItems(snapshot);
			const lines = [theme.fg("accent", `Plan ${counts.done}/${counts.total}`)];
			for (const phase of snapshot) {
				lines.push(theme.fg("muted", phase.name));
				const items = expanded ? phase.items : phase.items.slice(0, 5);
				for (const item of items) {
					const marker = item.status === "completed" ? theme.fg("success", "[x]") : item.status === "abandoned" ? theme.fg("dim", "[-]") : item.status === "in_progress" ? theme.fg("accent", "[>]") : theme.fg("muted", "[ ]");
					const text = item.status === "completed" || item.status === "abandoned" ? theme.fg("dim", item.content) : item.content;
					lines.push(`${marker} ${text}`);
				}
				if (!expanded && phase.items.length > items.length) lines.push(theme.fg("dim", `... ${phase.items.length - items.length} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show the current update_plan state",
		handler: async (_args, ctx) => {
			restoreFromEntries(ctx);
			ctx.ui.notify(renderTextPlan(phases), "info");
		},
	});

	pi.registerCommand("plan-clear", {
		description: "Clear the current update_plan state",
		handler: async (_args, ctx) => {
			phases = [];
			pi.appendEntry(PLAN_STATE_TYPE, { phases: [] });
			updatePlanUi(ctx, phases);
			ctx.ui.notify("Plan cleared.", "info");
		},
	});
}
