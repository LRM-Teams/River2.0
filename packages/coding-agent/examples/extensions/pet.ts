/**
 * Terminal pet extension - shows a small animated companion near the editor.
 *
 * Usage:
 *   pi --extension examples/extensions/pet.ts
 *
 * Commands:
 *   /pet                         Show pet profile
 *   /pet on|off                  Show or hide the pet
 *   /pet cat|dog|fox|bot         Switch species
 *   /pet name <name>             Rename the pet
 *   /pet mood                    Show mood, stats, and progress
 *   /pet checkin                 Claim the daily check-in reward
 *   /pet feed                    Feed the pet
 *   /pet bag                     Show inventory items
 *   /pet equip <item>            Equip a cosmetic item
 *   /pet unequip                 Remove the equipped item
 *   /pet position widget|overlay Move between editor widget and floating overlay
 *   /pet reset                   Reset pet profile
 *   /pet ask <question>          Ask about current context without saving the answer
 *   /pet <message>               Talk to the pet locally
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type PetMood = "idle" | "thinking" | "tool" | "chat" | "celebrate" | "concerned";
type PetKind = "cat" | "dog" | "fox" | "bot";
type PetRarity = "common" | "rare" | "epic" | "legendary";
type PetPersonality = "calm" | "curious" | "snarky" | "loyal" | "sleepy";
type PetPosition = "widget" | "overlay";
type PetItemRarity = "common" | "rare" | "epic" | "legendary";
type PetItemTrigger = "tool" | "memory" | "checkin";

interface PetItem {
	id: string;
	name: string;
	rarity: PetItemRarity;
	glyph: string;
	color: "accent" | "success" | "warning" | "error" | "muted";
	trigger: PetItemTrigger;
}

interface PetInventoryItem {
	itemId: string;
	count: number;
}

interface PetDropPity {
	tool: number;
	memory: number;
	checkin: number;
}

interface PetCommandCompletion {
	name: string;
	description: string;
	usage?: string;
}

interface PetStats {
	focus: number;
	energy: number;
	curiosity: number;
	sass: number;
	loyalty: number;
}

interface PetProfile {
	name: string;
	species: PetKind;
	rarity: PetRarity;
	personality: PetPersonality;
	stats: PetStats;
	xp: number;
	level: number;
	interactions: number;
	toolsCompleted: number;
	position: PetPosition;
	enabled: boolean;
	lastCheckInDay?: string;
	feedCount: number;
	inventory: PetInventoryItem[];
	itemDropPity: PetDropPity;
	equippedItemId?: string;
}

const PET_PROFILE_TYPE = "pet-profile";
const BASE_TICK_MS = 500;
const CHAT_MOOD_MS = 5500;
const SLEEP_AFTER_MS = 25_000;
const PET_KINDS: PetKind[] = ["cat", "dog", "fox", "bot"];
const PERSONALITIES: PetPersonality[] = ["calm", "curious", "snarky", "loyal", "sleepy"];
const RARITIES: PetRarity[] = ["common", "rare", "epic", "legendary"];
const PET_ITEMS: PetItem[] = [
	{ id: "tin-bell", name: "Tin Bell", rarity: "common", glyph: "o", color: "muted", trigger: "tool" },
	{ id: "green-scarf", name: "Green Scarf", rarity: "common", glyph: "~", color: "success", trigger: "checkin" },
	{ id: "amber-token", name: "Amber Token", rarity: "rare", glyph: "*", color: "warning", trigger: "tool" },
	{ id: "memory-lens", name: "Memory Lens", rarity: "rare", glyph: "@", color: "accent", trigger: "memory" },
	{ id: "violet-badge", name: "Violet Badge", rarity: "epic", glyph: "#", color: "error", trigger: "memory" },
	{ id: "star-crown", name: "Star Crown", rarity: "legendary", glyph: "^", color: "warning", trigger: "memory" },
];
const PET_COMMAND_COMPLETIONS: PetCommandCompletion[] = [
	{ name: "on", description: "Show the pet" },
	{ name: "off", description: "Hide the pet" },
	{ name: "cat", description: "Switch species to cat" },
	{ name: "dog", description: "Switch species to dog" },
	{ name: "fox", description: "Switch species to fox" },
	{ name: "bot", description: "Switch species to bot" },
	{ name: "name", usage: "<name>", description: "Rename the pet" },
	{ name: "mood", description: "Show mood, stats, and progress" },
	{ name: "checkin", description: "Claim the daily check-in reward" },
	{ name: "feed", description: "Feed the pet" },
	{ name: "bag", description: "Show inventory items" },
	{ name: "inventory", description: "Show inventory items" },
	{ name: "equip", usage: "<item>", description: "Equip a cosmetic item" },
	{ name: "unequip", description: "Remove the equipped item" },
	{ name: "position", usage: "widget|overlay", description: "Move between editor widget and floating overlay" },
	{ name: "reset", description: "Reset pet profile" },
	{ name: "ask", usage: "<question>", description: "Ask about current context without saving the answer" },
];
const DAILY_CHECKIN_XP = 2;
const FEED_XP = 1;
const TOOL_DROP_CHANCE = 0.04;
const MEMORY_DROP_CHANCE = 0.12;
const CHECKIN_DROP_CHANCE = 0.2;
const DROP_PITY_LIMITS: Record<PetItemTrigger, number> = { tool: 25, memory: 8, checkin: 7 };
const RARITY_WEIGHTS: Record<PetItemRarity, number> = { common: 80, rare: 16, epic: 3.5, legendary: 0.5 };

const PET_ASK_PROMPT = `You are a tiny terminal pet companion inside pi.
Answer the user's question using the provided conversation context.
Keep the answer concise, friendly, and technically useful.
Do not claim you changed files or interacted with the session.
Your answer is temporary UI output and must not ask the main agent to continue.`;

const PET_ART: Record<PetKind, Record<PetMood | "blink" | "sleep", string[][]>> = {
	cat: {
		idle: [["    /\\_/\\", "   ( o.o )", "    > ^ <"]],
		blink: [["    /\\_/\\", "   ( -.- )", "    > ^ <"]],
		sleep: [
			["    /\\_/\\", "   ( -.- )  z", "    > ^ <"],
			["    /\\_/\\", "   ( -.- )  zz", "    > ^ <"],
			["    /\\_/\\", "   ( -.- )  zzz", "    > ^ <"],
		],
		thinking: [
			["    /\\_/\\", "   ( o.o )  hmm", "    > ? <"],
			["    /\\_/\\", "   ( o.o )  hmm.", "    > ? <"],
			["    /\\_/\\", "   ( o.o )  hmm..", "    > ? <"],
		],
		tool: [
			["    /\\_/\\", "   ( >.< )  tap", "  ./|___|\\."],
			["    /\\_/\\", "   ( o.o )  hunt", "  ./|___|\\."],
		],
		chat: [
			["    /\\_/\\", "   ( ^.^ )  meow", "    > ^ <"],
			["    /\\_/\\", "   ( o.o )  listen", "    > ^ <"],
		],
		celebrate: [["    /\\_/\\", "   ( ^.^ )  done", "   \\> ^ </"]],
		concerned: [["    /\\_/\\", "   ( o.o )  uh oh", "    > ! <"]],
	},
	dog: {
		idle: [["    /-----\\", "   ( o o )", "    \\_^_/"]],
		blink: [["    /-----\\", "   ( - - )", "    \\_^_/"]],
		sleep: [
			["    /-----\\", "   ( - - )  z", "    \\_^_/"],
			["    /-----\\", "   ( - - )  zz", "    \\_^_/"],
			["    /-----\\", "   ( - - )  zzz", "    \\_^_/"],
		],
		thinking: [
			["    /-----\\", "   ( o o )  sniff", "    \\_?_/"],
			["    /-----\\", "   ( o o )  sniff.", "    \\_?_/"],
			["    /-----\\", "   ( o o )  sniff..", "    \\_?_/"],
		],
		tool: [
			["    /-----\\", "   ( > < )  fetch", "   /|___|\\"],
			["    /-----\\", "   ( o o )  dig", "   /|___|\\"],
		],
		chat: [
			["    /-----\\", "   ( ^ ^ )  woof", "    \\_^_/"],
			["    /-----\\", "   ( o o )  listen", "    \\_^_/"],
		],
		celebrate: [["    /-----\\", "   ( ^ ^ )  good", "   \\|___|/"]],
		concerned: [["    /-----\\", "   ( o o )  guard", "    \\_!_/"]],
	},
	fox: {
		idle: [["    /\\   /\\", "   ( o.o )", "    \\ v /"]],
		blink: [["    /\\   /\\", "   ( -.- )", "    \\ v /"]],
		sleep: [
			["    /\\   /\\", "   ( -.- )  z", "    \\ v /"],
			["    /\\   /\\", "   ( -.- )  zz", "    \\ v /"],
			["    /\\   /\\", "   ( -.- )  zzz", "    \\ v /"],
		],
		thinking: [
			["    /\\   /\\", "   ( o.o )  plot", "    \\ ? /"],
			["    /\\   /\\", "   ( o.o )  plot.", "    \\ ? /"],
			["    /\\   /\\", "   ( o.o )  plot..", "    \\ ? /"],
		],
		tool: [
			["    /\\   /\\", "   ( >.< )  scout", "   /|___|\\"],
			["    /\\   /\\", "   ( o.o )  pounce", "   /|___|\\"],
		],
		chat: [
			["    /\\   /\\", "   ( ^.^ )  yip", "    \\ v /"],
			["    /\\   /\\", "   ( o.o )  listen", "    \\ v /"],
		],
		celebrate: [["    /\\   /\\", "   ( ^.^ )  clever", "    \\ v /"]],
		concerned: [["    /\\   /\\", "   ( o.o )  wait", "    \\ ! /"]],
	},
	bot: {
		idle: [["    .----.", "   [ o_o ]", "   /|___|\\"]],
		blink: [["    .----.", "   [ -_- ]", "   /|___|\\"]],
		sleep: [
			["    .----.", "   [ -_- ]  idle", "   /|___|\\"],
			["    .----.", "   [ -_- ]  idle.", "   /|___|\\"],
			["    .----.", "   [ -_- ]  idle..", "   /|___|\\"],
		],
		thinking: [
			["    .----.", "   [ o_o ]  compute", "   /|_?_|"],
			["    .----.", "   [ o_o ]  compute.", "   /|_?_|"],
			["    .----.", "   [ o_o ]  compute..", "   /|_?_|"],
		],
		tool: [
			["    .----.", "   [ >_< ]  exec", "   /|___|\\"],
			["    .----.", "   [ o_o ]  scan", "   /|___|\\"],
		],
		chat: [
			["    .----.", "   [ ^_^ ]  beep", "   /|___|\\"],
			["    .----.", "   [ o_o ]  listen", "   /|___|\\"],
		],
		celebrate: [["    .----.", "   [ ^_^ ]  pass", "   /|___|\\"]],
		concerned: [["    .----.", "   [ o_o ]  warn", "   /|_!_|\\"]],
	},
};

class PetComponent implements Component {
	private profile: PetProfile;
	private mood: PetMood = "idle";
	private frame = 0;
	private theme: Theme;
	private replyLines: string[] = [];
	private idleSince = Date.now();
	private nextFrameAt = 0;
	private blinkUntil = 0;
	private nextBlinkAt = Date.now() + 8_000;

	constructor(profile: PetProfile, theme: Theme) {
		this.profile = profile;
		this.theme = theme;
	}

	setProfile(profile: PetProfile): void {
		this.profile = profile;
	}

	setMood(mood: PetMood): void {
		if (this.mood === mood) return;
		this.mood = mood;
		this.frame = 0;
		this.nextFrameAt = 0;
		if (mood === "idle") {
			this.idleSince = Date.now();
			this.nextBlinkAt = Date.now() + this.nextBlinkDelay();
		}
	}

	setReply(reply: string): void {
		this.replyLines = reply
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(0, 4);
	}

	tick(now = Date.now()): void {
		if (this.mood === "idle" && now >= this.nextBlinkAt) {
			this.blinkUntil = now + 800;
			this.nextBlinkAt = now + this.nextBlinkDelay();
		}

		if (now < this.nextFrameAt) return;
		this.frame++;
		this.nextFrameAt = now + this.frameInterval();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const pose = this.getPose();
		const frames = PET_ART[this.profile.species][pose];
		const art = frames[this.frame % frames.length] ?? frames[0];
		const equipped = getPetItem(this.profile.equippedItemId);
		const charm = equipped ? ` ${this.theme.fg(equipped.color, equipped.glyph)}` : "";
		const title = `${this.profile.name} ${this.profile.rarity} ${this.profile.personality}`;
		const label = this.theme.fg("accent", `pet:${this.profile.species}`);
		const mood = this.theme.fg("dim", this.mood);
		const lines = [` ${label}${charm} ${this.theme.fg("muted", title)} ${mood}`, ...art];

		for (const line of this.replyLines) {
			lines.push(this.theme.fg("muted", `  < ${line}`));
		}

		if (this.profile.position !== "widget") {
			return lines.map((line) => truncateToWidth(line, width));
		}

		const blockWidth = Math.min(width, Math.max(...lines.map((line) => visibleWidth(line))));
		return lines.map((line) => this.rightAlignBlockLine(line, width, blockWidth));
	}

	private getPose(): PetMood | "blink" | "sleep" {
		if (this.mood !== "idle") return this.mood;
		const now = Date.now();
		if (now < this.blinkUntil) return "blink";
		if (now - this.idleSince > SLEEP_AFTER_MS || this.profile.personality === "sleepy") return "sleep";
		return "idle";
	}

	private frameInterval(): number {
		switch (this.mood) {
			case "tool":
				return 650;
			case "thinking":
				return 1100;
			case "chat":
				return 900;
			case "celebrate":
			case "concerned":
				return 800;
			case "idle":
				return this.getPose() === "sleep" ? 1800 : 1500;
		}
	}

	private nextBlinkDelay(): number {
		const base = this.profile.personality === "sleepy" ? 12_000 : 8_000;
		return base + Math.floor(Math.random() * 6_000);
	}

	private rightAlignBlockLine(line: string, width: number, blockWidth: number): string {
		const content = truncateToWidth(line, Math.max(1, blockWidth));
		const paddedContent = content + " ".repeat(Math.max(0, blockWidth - visibleWidth(content)));
		return " ".repeat(Math.max(0, width - blockWidth)) + paddedContent;
	}
}

function defaultProfile(): PetProfile {
	return {
		name: "Pip",
		species: "cat",
		rarity: "common",
		personality: "curious",
		stats: { focus: 1, energy: 5, curiosity: 7, sass: 2, loyalty: 4 },
		xp: 0,
		level: 1,
		interactions: 0,
		toolsCompleted: 0,
		position: "widget",
		enabled: true,
		feedCount: 0,
		inventory: [],
		itemDropPity: { tool: 0, memory: 0, checkin: 0 },
	};
}

function normalizeProfile(value: unknown): PetProfile | undefined {
	if (!value || typeof value !== "object") return undefined;
	const partial = value as Partial<PetProfile>;
	const fallback = defaultProfile();
	const species = partial.species && PET_KINDS.includes(partial.species) ? partial.species : fallback.species;
	const rarity = partial.rarity && RARITIES.includes(partial.rarity) ? partial.rarity : fallback.rarity;
	const personality =
		partial.personality && PERSONALITIES.includes(partial.personality) ? partial.personality : fallback.personality;
	const position =
		partial.position === "overlay" || partial.position === "widget" ? partial.position : fallback.position;
	const stats = partial.stats ?? fallback.stats;
	const inventory = Array.isArray(partial.inventory)
		? partial.inventory.map(normalizeInventoryItem).filter((item) => item !== undefined)
		: fallback.inventory;
	const equippedItemId =
		typeof partial.equippedItemId === "string" && PET_ITEMS.some((item) => item.id === partial.equippedItemId)
			? partial.equippedItemId
			: undefined;
	const itemDropPity = normalizeDropPity(partial.itemDropPity, fallback.itemDropPity);

	return {
		name: typeof partial.name === "string" && partial.name.trim() ? partial.name.trim().slice(0, 24) : fallback.name,
		species,
		rarity,
		personality,
		stats: {
			focus: safeStat(stats.focus, fallback.stats.focus),
			energy: safeStat(stats.energy, fallback.stats.energy),
			curiosity: safeStat(stats.curiosity, fallback.stats.curiosity),
			sass: safeStat(stats.sass, fallback.stats.sass),
			loyalty: safeStat(stats.loyalty, fallback.stats.loyalty),
		},
		xp: safeCount(partial.xp, fallback.xp),
		level: Math.max(1, safeCount(partial.level, fallback.level)),
		interactions: safeCount(partial.interactions, fallback.interactions),
		toolsCompleted: safeCount(partial.toolsCompleted, fallback.toolsCompleted),
		position,
		enabled: typeof partial.enabled === "boolean" ? partial.enabled : fallback.enabled,
		lastCheckInDay: typeof partial.lastCheckInDay === "string" ? partial.lastCheckInDay : undefined,
		feedCount: safeCount(partial.feedCount, fallback.feedCount),
		inventory,
		itemDropPity,
		equippedItemId,
	};
}

function normalizeDropPity(value: unknown, fallback: PetDropPity): PetDropPity {
	const partial = value && typeof value === "object" ? (value as Partial<PetDropPity>) : {};
	return {
		tool: safeCount(partial.tool, fallback.tool),
		memory: safeCount(partial.memory, fallback.memory),
		checkin: safeCount(partial.checkin, fallback.checkin),
	};
}

function normalizeInventoryItem(value: unknown): PetInventoryItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const partial = value as Partial<PetInventoryItem>;
	if (typeof partial.itemId !== "string" || !PET_ITEMS.some((item) => item.id === partial.itemId)) return undefined;
	return { itemId: partial.itemId, count: Math.max(1, safeCount(partial.count, 1)) };
}

function safeStat(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(10, Math.floor(value))) : fallback;
}

function safeCount(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function parsePetKind(text: string): PetKind | undefined {
	return PET_KINDS.find((kind) => kind === text);
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

function getContextMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}

	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message) => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message) => message !== undefined);
}

function getXpForNextLevel(level: number): number {
	return Math.floor(8 + level * level * 3.5);
}

function getTodayKey(): string {
	return new Date().toISOString().slice(0, 10);
}

function getPetItem(itemId: string | undefined): PetItem | undefined {
	return itemId ? PET_ITEMS.find((item) => item.id === itemId) : undefined;
}

function createStatusCard(profile: PetProfile): string {
	const nextXp = getXpForNextLevel(profile.level);
	const equipped = getPetItem(profile.equippedItemId);
	const itemCount = profile.inventory.reduce((total, item) => total + item.count, 0);
	return [
		`${profile.name} the ${profile.rarity} ${profile.species}`,
		`personality: ${profile.personality}  level: ${profile.level}  xp: ${profile.xp}/${nextXp}`,
		`stats: focus ${profile.stats.focus}/10, energy ${profile.stats.energy}/10, curiosity ${profile.stats.curiosity}/10`,
		`       sass ${profile.stats.sass}/10, loyalty ${profile.stats.loyalty}/10`,
		`activity: ${profile.interactions} chats, ${profile.toolsCompleted} tools, feeds ${profile.feedCount}`,
		`drops: tools ${profile.itemDropPity.tool}/${DROP_PITY_LIMITS.tool}, memory ${profile.itemDropPity.memory}/${DROP_PITY_LIMITS.memory}, check-in ${profile.itemDropPity.checkin}/${DROP_PITY_LIMITS.checkin}`,
		`bag: ${itemCount} items${equipped ? `, equipped ${equipped.name}` : ""}  check-in: ${profile.lastCheckInDay ?? "never"}`,
	].join("\n");
}

function createPetReply(profile: PetProfile, message: string): string {
	const text = message.toLowerCase();
	const sound =
		profile.species === "bot"
			? "beep"
			: profile.species === "dog"
				? "woof"
				: profile.species === "fox"
					? "yip"
					: "meow";
	const suffix = personalitySuffix(profile.personality);

	if (text.includes("你好") || text.includes("hello") || text.includes("hi")) {
		return `${sound}. 我在这儿。${suffix}`;
	}
	if (text.includes("怎么样") || text.includes("how are")) {
		return `状态不错，${profile.name} 正在看着你的代码。${suffix}`;
	}
	if (text.includes("累") || text.includes("困") || text.includes("sleep")) {
		return profile.personality === "sleepy" ? "我也想睡，但还能再陪你一会儿。" : "可以小憩，但先把 bug 抓完。";
	}
	if (text.includes("bug") || text.includes("错误") || text.includes("报错")) {
		return profile.personality === "snarky" ? "我闻到 bug 了，它躲得不算聪明。" : "我闻到 bug 了，交给我盯着。";
	}
	if (text.includes("谢谢") || text.includes("thanks")) {
		return profile.personality === "loyal" ? "一直在。继续推进。" : "收到。继续推进。";
	}
	if (text.includes("名字") || text.includes("name")) {
		return `我是 ${profile.name}，一只 ${profile.rarity} ${profile.species}。`;
	}

	const replies = personalityReplies(profile.personality);
	let hash = 0;
	for (const char of message) hash = (hash + char.charCodeAt(0)) % replies.length;
	return replies[hash] ?? replies[0];
}

function personalitySuffix(personality: PetPersonality): string {
	switch (personality) {
		case "calm":
			return "慢慢来。";
		case "curious":
			return "要不要继续查？";
		case "snarky":
			return "我会尽量少吐槽。";
		case "loyal":
			return "我守着。";
		case "sleepy":
			return "如果我打盹，叫我。";
	}
}

function personalityReplies(personality: PetPersonality): string[] {
	switch (personality) {
		case "calm":
			return ["我听到了。先稳住节奏。", "这可以慢慢拆。", "别急，先看事实。"];
		case "curious":
			return ["这听起来可以继续深挖。", "要不要让我闻闻上下文？", "我想知道下一步是什么。"];
		case "snarky":
			return ["听起来像代码又想搞事。", "我先不评价，但我有预感。", "这个方向至少不无聊。"];
		case "loyal":
			return ["收到，我陪你看。", "我会盯着进展。", "交给我们一起推进。"];
		case "sleepy":
			return ["我听到了，虽然有点困。", "可以，我先睁一只眼。", "好，记在小枕头旁边。"];
	}
}

async function askPet(question: string, ctx: ExtensionCommandContext): Promise<string | null> {
	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return null;
	}

	const contextMessages = getContextMessages(ctx.sessionManager.getBranch());
	if (contextMessages.length === 0) {
		ctx.ui.notify("No conversation context found", "warning");
		return null;
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Pet is sniffing the current context...");
		loader.onAbort = () => done(null);

		const generate = async () => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (auth.ok === false) {
				throw new Error(auth.error);
			}
			if (!auth.apiKey) {
				throw new Error(`No API key for ${ctx.model!.provider}`);
			}

			const conversationText = serializeConversation(convertToLlm(contextMessages));
			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Current conversation context\n\n${conversationText}\n\n## User question for the pet\n\n${question}`,
					},
				],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model!,
				{ systemPrompt: PET_ASK_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
			);

			if (response.stopReason === "aborted") return null;
			return response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
		};

		generate()
			.then(done)
			.catch((error) => {
				ctx.ui.notify(error instanceof Error ? error.message : "Pet ask failed", "error");
				done(null);
			});

		return loader;
	});

	return result?.trim() ? result : null;
}

export default function petExtension(pi: ExtensionAPI) {
	let profile = defaultProfile();
	let component: PetComponent | null = null;
	let tui: TUI | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let chatTimer: ReturnType<typeof setTimeout> | null = null;
	let overlayHandle: OverlayHandle | null = null;
	let closeOverlay: (() => void) | null = null;
	let activeToolCount = 0;
	let agentRunning = false;

	function saveProfile(): void {
		pi.appendEntry(PET_PROFILE_TYPE, profile);
	}

	function restoreProfile(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "custom" || entry.customType !== PET_PROFILE_TYPE) continue;
			const saved = normalizeProfile(entry.data);
			if (saved) profile = saved;
			return;
		}
	}

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = null;
	}

	function stopChatTimer(): void {
		if (!chatTimer) return;
		clearTimeout(chatTimer);
		chatTimer = null;
	}

	function startTimer(): void {
		stopTimer();
		timer = setInterval(() => {
			component?.tick();
			tui?.requestRender();
		}, BASE_TICK_MS);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const text = profile.enabled ? ctx.ui.theme.fg("dim", `Pet: ${profile.name} L${profile.level}`) : undefined;
		ctx.ui.setStatus("pet", text);
	}

	function setMood(mood: PetMood): void {
		component?.setMood(mood);
		tui?.requestRender();
	}

	function restoreActivityMood(): void {
		setMood(activeToolCount > 0 ? "tool" : agentRunning ? "thinking" : "idle");
	}

	function setReply(message: string, mood: PetMood = "chat", ttlMs = CHAT_MOOD_MS): void {
		component?.setReply(message);
		setMood(mood);
		stopChatTimer();
		chatTimer = setTimeout(() => {
			component?.setReply("");
			restoreActivityMood();
		}, ttlMs);
		tui?.requestRender();
	}

	function gainXp(amount: number): void {
		profile.xp += amount;
		let leveled = false;
		while (profile.xp >= getXpForNextLevel(profile.level)) {
			profile.xp -= getXpForNextLevel(profile.level);
			profile.level++;
			leveled = true;
		}
		if (leveled) {
			setReply(`${profile.name} reached level ${profile.level}.`, "celebrate");
		}
	}

	function bumpStat(key: keyof PetStats, amount = 1): void {
		profile.stats[key] = Math.max(0, Math.min(10, profile.stats[key] + amount));
	}

	function addItem(item: PetItem): void {
		const existing = profile.inventory.find((inventoryItem) => inventoryItem.itemId === item.id);
		if (existing) existing.count++;
		else profile.inventory.push({ itemId: item.id, count: 1 });
	}

	function rollWeightedItem(candidates: PetItem[]): PetItem | undefined {
		const weighted = candidates.map((item) => ({ item, weight: RARITY_WEIGHTS[item.rarity] ?? 1 }));
		const totalWeight = weighted.reduce((total, entry) => total + entry.weight, 0);
		if (totalWeight <= 0) return candidates[0];

		let roll = Math.random() * totalWeight;
		for (const entry of weighted) {
			roll -= entry.weight;
			if (roll <= 0) return entry.item;
		}
		return weighted[weighted.length - 1]?.item;
	}

	function rollDrop(trigger: PetItemTrigger, chance: number): PetItem | undefined {
		profile.itemDropPity[trigger] = safeCount(profile.itemDropPity[trigger], 0) + 1;
		const forced = profile.itemDropPity[trigger] >= DROP_PITY_LIMITS[trigger];
		if (!forced && Math.random() >= chance) return undefined;

		const candidates = PET_ITEMS.filter((item) => item.trigger === trigger);
		if (candidates.length === 0) return undefined;
		const item = rollWeightedItem(candidates);
		if (item) profile.itemDropPity[trigger] = 0;
		return item;
	}

	function maybeDropItem(trigger: PetItemTrigger, chance: number): PetItem | undefined {
		const item = rollDrop(trigger, chance);
		if (!item) return undefined;
		addItem(item);
		setReply(`Found ${item.rarity} item: ${item.name} ${item.glyph}`, "celebrate", 7000);
		saveProfile();
		return item;
	}

	function getPetArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
		const trimmed = argumentPrefix.trimStart();
		const firstSpace = trimmed.indexOf(" ");

		if (firstSpace === -1) {
			const lower = trimmed.toLowerCase();
			const matches = PET_COMMAND_COMPLETIONS.filter((command) => command.name.startsWith(lower)).map((command) => ({
				value: command.usage ? `${command.name} ` : command.name,
				label: command.usage ? `${command.name} ${command.usage}` : command.name,
				description: command.description,
			}));
			return matches.length > 0 ? matches : null;
		}

		const subcommand = trimmed.slice(0, firstSpace).toLowerCase();
		const subArg = trimmed
			.slice(firstSpace + 1)
			.trimStart()
			.toLowerCase();

		const usageCompletion = PET_COMMAND_COMPLETIONS.find((command) => command.name === subcommand && command.usage);
		if (usageCompletion && subArg.length === 0 && subcommand !== "position" && subcommand !== "equip") {
			return [
				{
					value: `${subcommand} `,
					label: usageCompletion.usage ?? "",
					description: usageCompletion.description,
				},
			];
		}

		if (subcommand === "position") {
			return filterPetCompletions(subArg, [
				{ value: "position widget", label: "widget", description: "Show pet above the editor" },
				{ value: "position overlay", label: "overlay", description: "Show pet as a bottom-right overlay" },
			]);
		}

		if (subcommand === "equip") {
			const items = profile.inventory
				.map((owned) => getPetItem(owned.itemId))
				.filter((item) => item !== undefined)
				.map((item) => ({
					value: `equip ${item.id}`,
					label: item.name,
					description: `${item.rarity} item (${item.id})`,
				}));
			return filterPetCompletions(subArg, items);
		}

		return null;
	}

	function filterPetCompletions(prefix: string, items: AutocompleteItem[]): AutocompleteItem[] | null {
		const matches = items.filter((item) => {
			const text = `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase();
			return text.includes(prefix);
		});
		return matches.length > 0 ? matches : null;
	}

	function createBagCard(): string {
		if (profile.inventory.length === 0) return "Bag is empty. Try /pet checkin or keep working with tools.";
		return profile.inventory
			.map((inventoryItem) => {
				const item = getPetItem(inventoryItem.itemId);
				if (!item) return undefined;
				const equipped = profile.equippedItemId === item.id ? " equipped" : "";
				return `${item.glyph} ${item.name} (${item.rarity}) x${inventoryItem.count}${equipped}`;
			})
			.filter((line) => line !== undefined)
			.join("\n");
	}

	function talkToPet(message: string): string {
		profile.interactions++;
		bumpStat("loyalty", /谢谢|thanks/i.test(message) ? 1 : 0);
		gainXp(1);
		const reply = createPetReply(profile, message);
		setReply(reply);
		saveProfile();
		return reply;
	}

	function syncComponentProfile(): void {
		component?.setProfile(profile);
	}

	function clearOverlay(): void {
		overlayHandle?.hide();
		overlayHandle = null;
		closeOverlay?.();
		closeOverlay = null;
	}

	function applyWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("pet", undefined, { placement: "aboveEditor" });
		clearOverlay();

		if (!profile.enabled) {
			component = null;
			tui = null;
			stopTimer();
			stopChatTimer();
			updateStatus(ctx);
			return;
		}

		ctx.ui.setWidget(
			"pet",
			(nextTui, theme) => {
				tui = nextTui;
				component = new PetComponent(profile, theme);
				restoreActivityMood();
				return component;
			},
			{ placement: "aboveEditor" },
		);
		startTimer();
		updateStatus(ctx);
	}

	function applyOverlay(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("pet", undefined, { placement: "aboveEditor" });
		clearOverlay();

		if (!profile.enabled) {
			component = null;
			tui = null;
			stopTimer();
			stopChatTimer();
			updateStatus(ctx);
			return;
		}

		void ctx.ui
			.custom<void>(
				(nextTui, theme, _kb, done) => {
					tui = nextTui;
					closeOverlay = () => done(undefined);
					component = new PetComponent(profile, theme);
					restoreActivityMood();
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-right",
						width: 38,
						margin: { right: 2, bottom: 4 },
						nonCapturing: true,
					},
					onHandle: (handle) => {
						overlayHandle = handle;
					},
				},
			)
			.catch(() => {});
		startTimer();
		updateStatus(ctx);
	}

	function applyPet(ctx: ExtensionContext): void {
		if (profile.position === "overlay") applyOverlay(ctx);
		else applyWidget(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreProfile(ctx);
		applyPet(ctx);
	});

	pi.on("agent_start", async (_event, _ctx) => {
		agentRunning = true;
		activeToolCount = 0;
		if (!chatTimer) setMood("thinking");
	});

	pi.on("tool_execution_start", async (_event, _ctx) => {
		activeToolCount++;
		if (!chatTimer) setMood("tool");
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		activeToolCount = Math.max(0, activeToolCount - 1);
		profile.toolsCompleted++;
		bumpStat(event.isError ? "sass" : "focus", 1);
		gainXp(event.isError ? 0 : 1);
		if (!event.isError) {
			const isMemoryTool = event.toolName.toLowerCase().includes("memory");
			maybeDropItem(isMemoryTool ? "memory" : "tool", isMemoryTool ? MEMORY_DROP_CHANCE : TOOL_DROP_CHANCE);
		}
		if (event.isError && !chatTimer) setMood("concerned");
		else if (activeToolCount === 0 && !chatTimer) setMood("thinking");
		saveProfile();
	});

	pi.on("agent_end", async (_event, _ctx) => {
		agentRunning = false;
		activeToolCount = 0;
		bumpStat("energy", 1);
		gainXp(1);
		if (!chatTimer) setMood("idle");
		saveProfile();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		stopChatTimer();
		clearOverlay();
		if (ctx.hasUI) ctx.ui.setStatus("pet", undefined);
	});

	pi.registerCommand("pet", {
		description: "Show, hide, switch, talk to, or ask the terminal pet about current context.",
		getArgumentCompletions: getPetArgumentCompletions,
		handler: async (args, ctx) => {
			const raw = args.trim();
			const next = raw.toLowerCase();
			if (!next) {
				setReply(createStatusCard(profile), "chat", 8000);
				ctx.ui.notify(
					`${profile.name}: ${profile.species}, ${profile.personality}, level ${profile.level}`,
					"info",
				);
				return;
			}

			if (next === "on") {
				profile.enabled = true;
				applyPet(ctx);
				saveProfile();
				ctx.ui.notify("Pet enabled", "info");
				return;
			}

			if (next === "off") {
				profile.enabled = false;
				applyPet(ctx);
				saveProfile();
				ctx.ui.notify("Pet hidden", "info");
				return;
			}

			if (next === "mood") {
				setReply(createStatusCard(profile), "chat", 8000);
				ctx.ui.notify("Pet mood shown", "info");
				return;
			}

			if (next === "bag" || next === "inventory") {
				setReply(createBagCard(), "chat", 9000);
				ctx.ui.notify("Pet bag shown", "info");
				return;
			}

			if (next === "checkin" || next === "签到") {
				const today = getTodayKey();
				if (profile.lastCheckInDay === today) {
					setReply("今天已经签到过了。明天再来。", "chat");
					return;
				}
				profile.lastCheckInDay = today;
				gainXp(DAILY_CHECKIN_XP);
				bumpStat("loyalty", 1);
				const item = maybeDropItem("checkin", CHECKIN_DROP_CHANCE);
				if (!item) setReply(`签到完成。${profile.name} +${DAILY_CHECKIN_XP} xp。`, "celebrate");
				saveProfile();
				return;
			}

			if (next === "feed" || next === "喂食") {
				profile.feedCount++;
				gainXp(FEED_XP);
				bumpStat("energy", 1);
				setReply(`${profile.name} 吃饱了。+${FEED_XP} xp。`, "celebrate");
				saveProfile();
				return;
			}

			if (next === "reset") {
				profile = defaultProfile();
				syncComponentProfile();
				applyPet(ctx);
				saveProfile();
				ctx.ui.notify("Pet profile reset", "info");
				return;
			}

			if (next.startsWith("equip ")) {
				const itemName = raw.slice(6).trim().toLowerCase();
				const inventoryItem = profile.inventory.find((owned) => {
					const item = getPetItem(owned.itemId);
					return item?.id === itemName || item?.name.toLowerCase() === itemName;
				});
				if (!inventoryItem) {
					ctx.ui.notify("Item not found in bag. Use /pet bag.", "error");
					return;
				}
				profile.equippedItemId = inventoryItem.itemId;
				syncComponentProfile();
				const item = getPetItem(inventoryItem.itemId);
				setReply(item ? `Equipped ${item.name} ${item.glyph}.` : "Equipped item.");
				saveProfile();
				return;
			}

			if (next === "unequip") {
				profile.equippedItemId = undefined;
				syncComponentProfile();
				setReply("Item removed.");
				saveProfile();
				return;
			}

			if (next.startsWith("name ")) {
				const name = raw.slice(5).trim();
				if (!name) {
					ctx.ui.notify("Usage: /pet name <name>", "error");
					return;
				}
				profile.name = name.slice(0, 24);
				syncComponentProfile();
				setReply(`现在叫我 ${profile.name}。`);
				saveProfile();
				return;
			}

			if (next.startsWith("position ")) {
				const position = next.slice(9).trim();
				if (position !== "widget" && position !== "overlay") {
					ctx.ui.notify("Usage: /pet position [widget|overlay]", "error");
					return;
				}
				profile.position = position;
				applyPet(ctx);
				saveProfile();
				ctx.ui.notify(`Pet position set to ${position}`, "info");
				return;
			}

			if (next.startsWith("ask ")) {
				const question = raw.slice(4).trim();
				if (!question) {
					ctx.ui.notify("Usage: /pet ask <question>", "error");
					return;
				}
				if (!profile.enabled) {
					profile.enabled = true;
					applyPet(ctx);
				}
				bumpStat("curiosity", 1);
				setReply("我先看看当前上下文...");
				const answer = await askPet(question, ctx);
				if (answer) {
					profile.interactions++;
					gainXp(1);
					setReply(answer, "chat", 9000);
					saveProfile();
				}
				return;
			}

			const petKind = parsePetKind(next);
			if (petKind) {
				profile.species = petKind;
				syncComponentProfile();
				if (profile.enabled) applyPet(ctx);
				else updateStatus(ctx);
				saveProfile();
				ctx.ui.notify(`Pet switched to ${petKind}`, "info");
				return;
			}

			if (!profile.enabled) {
				profile.enabled = true;
				applyPet(ctx);
			}
			ctx.ui.notify(talkToPet(raw), "info");
		},
	});
}
