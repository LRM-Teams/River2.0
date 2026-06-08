import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import path from "node:path";
import crypto from "node:crypto";
import { createPlaintextBearerAuthGuard } from "./security.ts";

type TextBlock = { type?: string; text?: string };
type AssistantMessage = { role?: string; content?: unknown };
type SmartSearchResult = {
  title?: string;
  narrative?: string;
  type?: string;
  combinedScore?: number;
  score?: number;
  observation?: {
    title?: string;
    narrative?: string;
    type?: string;
  };
};

type HealthResponse = {
  status?: string;
  service?: string;
  version?: string;
  health?: {
    status?: string;
    notes?: string[];
  };
};
type McpContentBlock = { type?: string; text?: string };
type McpCallResponse = {
  content?: McpContentBlock[];
  isError?: boolean;
};

const DEFAULT_URL = process.env.AGENTMEMORY_URL || "http://localhost:3111";
const guardPlaintextBearerAuth = createPlaintextBearerAuthGuard();
const TOOL_GUIDANCE = [
  "agentmemory is available for cross-session memory.",
  "Use agentmemory_search to recall prior decisions, preferences, bugs, and workflows.",
  "Use agentmemory_save when you discover durable facts worth remembering beyond this session.",
].join(" ");

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function getText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [] as string[];
      const block = part as TextBlock;
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      return [] as string[];
    })
    .join("\n")
    .trim();
}

function getLastAssistantText(messages: unknown[]): string {
  for (const msg of [...messages].reverse()) {
    if (!msg || typeof msg !== "object") continue;
    const assistant = msg as AssistantMessage;
    if (assistant.role !== "assistant") continue;
    const text = getText(assistant.content);
    if (text) return text;
  }
  return "";
}

function formatSearchResults(results: SmartSearchResult[]): string {
  if (!results.length) return "No relevant memories found.";
  return results
    .slice(0, 5)
    .map((result, index) => {
      const obs = result.observation ?? result;
      const title = obs.title?.trim() || `Memory ${index + 1}`;
      const narrative = obs.narrative?.trim() || "";
      const type = obs.type?.trim() || "memory";
      const score = result.combinedScore ?? result.score;
      const scoreText = typeof score === "number" ? ` [score=${score.toFixed(3)}]` : "";
      return `- ${title} (${type})${scoreText}${narrative ? `: ${narrative}` : ""}`;
    })
    .join("\n");
}

async function callAgentMemory<T>(
  pathname: string,
  options?: {
    method?: "DELETE" | "GET" | "POST";
    body?: unknown;
    baseUrl?: string;
  },
): Promise<T | null> {
  const baseUrl = normalizeBaseUrl(options?.baseUrl || process.env.AGENTMEMORY_URL || DEFAULT_URL);
  const method = options?.method || "POST";
  const url = `${baseUrl}/agentmemory/${pathname.replace(/^\/+/, "")}`;
  const headers: Record<string, string> = {};
  const secret = process.env.AGENTMEMORY_SECRET;
  guardPlaintextBearerAuth(baseUrl, secret);
  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  if (secret) headers.Authorization = `Bearer ${secret}`;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function callMcpTool(name: string, args: Record<string, unknown>): Promise<McpCallResponse | null> {
  return await callAgentMemory<McpCallResponse>("mcp/call", {
    body: {
      name,
      arguments: args,
    },
  });
}

function formatMcpResponse(response: McpCallResponse | null): string {
  if (!response) return "agentmemory MCP call failed.";
  const text = response.content
    ?.map((block) => block.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || JSON.stringify(response, null, 2);
}

export default function agentmemoryExtension(pi: ExtensionAPI) {
  if (process.env.AGENTMEMORY_REQUIRE_HTTPS === "1") {
    guardPlaintextBearerAuth(
      normalizeBaseUrl(process.env.AGENTMEMORY_URL || DEFAULT_URL),
      process.env.AGENTMEMORY_SECRET,
    );
  }
  let sessionId = `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
  let currentProject = process.cwd();
  let lastPrompt = "";
  let lastHealthOk = false;

  async function getHealth() {
    return await callAgentMemory<HealthResponse>("health", { method: "GET" });
  }

  async function refreshStatus(ctx: { ui: { setStatus: (key: string, text: string) => void } }) {
    const health = await getHealth();
    lastHealthOk = !!health && (health.status === "healthy" || health.health?.status === "healthy");
    ctx.ui.setStatus("agentmemory", lastHealthOk ? "agentmemory" : "agentmemory off");
  }

  pi.registerCommand("agentmemory-status", {
    description: "Check local agentmemory server health",
    handler: async (_args, ctx) => {
      const health = await getHealth();
      if (!health) {
        ctx.ui.notify("agentmemory is unreachable at http://localhost:3111", "warning");
        return;
      }
      ctx.ui.notify(
        `agentmemory ${health.status || health.health?.status || "unknown"}${health.version ? ` v${health.version}` : ""}`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "agentmemory_health",
    label: "Memory Health",
    description: "Check whether the local agentmemory server is reachable and healthy",
    parameters: Type.Object({}),
    async execute() {
      const health = await getHealth();
      if (!health) {
        return {
          content: [{ type: "text", text: "agentmemory is unreachable at http://localhost:3111" }],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `agentmemory status: ${health.status || health.health?.status || "unknown"}${health.version ? ` (v${health.version})` : ""}`,
          },
        ],
        details: health,
      };
    },
  });

  pi.registerTool({
    name: "agentmemory_search",
    label: "Memory Search",
    description: "Search agentmemory for cross-session project memory, prior decisions, bugs, and user preferences",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for in memory" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Maximum results" })),
    }),
    async execute(_toolCallId, params) {
      const result = await callAgentMemory<{ results?: SmartSearchResult[] }>("smart-search", {
        body: { query: params.query, limit: params.limit ?? 5 },
      });
      const results = result?.results || [];
      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
        details: { query: params.query, results },
      };
    },
  });

  pi.registerTool({
    name: "agentmemory_save",
    label: "Memory Save",
    description: "Save a durable fact, convention, workflow, preference, or bug fix into agentmemory",
    parameters: Type.Object({
      content: Type.String({ description: "What should be remembered" }),
      type: Type.Optional(
        Type.String({
          description: "Memory type",
          default: "fact",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await callAgentMemory<Record<string, unknown>>("remember", {
        body: { content: params.content, type: params.type || "fact" },
      });
      if (!result) {
        return {
          content: [{ type: "text", text: "Failed to save memory to agentmemory." }],
          details: { ok: false },
        };
      }
      return {
        content: [{ type: "text", text: `Saved memory (${params.type || "fact"}): ${params.content}` }],
        details: result,
      };
    },
  });

  function registerMcpTool(options: {
    name: string;
    mcpName: string;
    label: string;
    description: string;
    parameters: TSchema;
  }) {
    pi.registerTool({
      name: options.name,
      label: options.label,
      description: options.description,
      parameters: options.parameters,
      async execute(_toolCallId, params) {
        const result = await callMcpTool(options.mcpName, params as Record<string, unknown>);
        return {
          content: [{ type: "text", text: formatMcpResponse(result) }],
          details: result || { ok: false },
          isError: result?.isError || !result,
        };
      },
    });
  }

  registerMcpTool({
    name: "agentmemory_sessions",
    mcpName: "memory_sessions",
    label: "Memory Sessions",
    description: "List recent agentmemory sessions with status and observation counts.",
    parameters: Type.Object({}),
  });

  registerMcpTool({
    name: "agentmemory_export",
    mcpName: "memory_export",
    label: "Memory Export",
    description: "Export all agentmemory data as JSON.",
    parameters: Type.Object({}),
  });

  registerMcpTool({
    name: "agentmemory_audit",
    mcpName: "memory_audit",
    label: "Memory Audit",
    description: "View the agentmemory audit trail, optionally filtered by operation.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max entries to return; default is 50" })),
      operation: Type.Optional(Type.String({ description: "Operation type to filter by" })),
    }),
  });

  registerMcpTool({
    name: "agentmemory_governance_delete",
    mcpName: "memory_governance_delete",
    label: "Memory Governance Delete",
    description: "Delete specific memories with an audit trail. Use only after the user explicitly asks to delete memory.",
    parameters: Type.Object({
      memoryIds: Type.String({ description: "Comma-separated memory IDs to delete" }),
      reason: Type.Optional(Type.String({ description: "Reason for deletion" })),
    }),
  });

  registerMcpTool({
    name: "agentmemory_slot_list",
    mcpName: "memory_slot_list",
    label: "Memory Slot List",
    description: "List all editable agentmemory slots.",
    parameters: Type.Object({}),
  });

  registerMcpTool({
    name: "agentmemory_slot_get",
    mcpName: "memory_slot_get",
    label: "Memory Slot Get",
    description: "Read one editable agentmemory slot by label.",
    parameters: Type.Object({
      label: Type.String({ description: "Slot label, for example persona or pending_items" }),
    }),
  });

  registerMcpTool({
    name: "agentmemory_slot_append",
    mcpName: "memory_slot_append",
    label: "Memory Slot Append",
    description: "Append text to an editable agentmemory slot.",
    parameters: Type.Object({
      label: Type.String({ description: "Slot label" }),
      text: Type.String({ description: "Text to append" }),
    }),
  });

  registerMcpTool({
    name: "agentmemory_slot_replace",
    mcpName: "memory_slot_replace",
    label: "Memory Slot Replace",
    description: "Replace an editable agentmemory slot. Use only when the user explicitly asks to rewrite a slot.",
    parameters: Type.Object({
      label: Type.String({ description: "Slot label" }),
      content: Type.String({ description: "New full slot content" }),
    }),
  });

  registerMcpTool({
    name: "agentmemory_consolidate",
    mcpName: "memory_consolidate",
    label: "Memory Consolidate",
    description: "Run agentmemory consolidation across episodic, semantic, or procedural tiers.",
    parameters: Type.Object({
      tier: Type.Optional(Type.String({ description: "Target tier: episodic, semantic, procedural, or all" })),
    }),
  });

  registerMcpTool({
    name: "agentmemory_diagnose",
    mcpName: "memory_diagnose",
    label: "Memory Diagnose",
    description: "Run agentmemory diagnostics across memory subsystems.",
    parameters: Type.Object({
      categories: Type.Optional(Type.String({ description: "Comma-separated categories to check; default is all" })),
    }),
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = sessionFile ? path.basename(sessionFile).replace(/\.[^.]+$/, "") : `ephemeral-${crypto.randomUUID().slice(0, 8)}`;
    currentProject = process.cwd();
    await refreshStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentProject = event.systemPromptOptions.cwd || process.cwd();
    lastPrompt = event.prompt?.trim() || "";
    if (!lastPrompt) return;

    const result = await callAgentMemory<{ results?: SmartSearchResult[] }>("smart-search", {
      body: { query: lastPrompt, limit: 5 },
    });
    const results = result?.results || [];
    const recallBlock = results.length
      ? [
          "Relevant long-term memory from agentmemory:",
          formatSearchResults(results),
        ].join("\n")
      : "";

    await refreshStatus(ctx);
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE, recallBlock].filter(Boolean).join("\n\n"),
    };
  });

  pi.on("agent_end", async (event) => {
    if (!lastHealthOk || !lastPrompt) return;
    const assistantText = getLastAssistantText(event.messages as unknown[]);
    if (!assistantText) return;
    void callAgentMemory("observe", {
      body: {
        hookType: "post_tool_use",
        sessionId,
        project: currentProject,
        cwd: currentProject,
        timestamp: new Date().toISOString(),
        data: {
          tool_name: "conversation",
          tool_input: lastPrompt.slice(0, 500),
          tool_output: assistantText.slice(0, 4000),
        },
      },
    });
  });
}
