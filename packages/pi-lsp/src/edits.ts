import fs from "node:fs/promises";
import path from "node:path";
import { LspToolError } from "./errors.ts";
import { formatPathRelativeToCwd, uriToFile } from "./path-utils.ts";
import type { DocumentChange, Range, TextDocumentEdit, TextEdit, WorkspaceEdit } from "./types.ts";

function comparePositions(a: Range["start"], b: Range["start"]): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

export function rangesOverlap(a: Range, b: Range): boolean {
	return comparePositions(a.start, b.end) < 0 && comparePositions(b.start, a.end) < 0;
}

function splitLinesWithEndings(content: string): string[] {
	const lines = content.match(/.*(?:\r\n|\n|\r|$)/g) ?? [content];
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

function offsetAt(content: string, position: Range["start"]): number {
	const lines = splitLinesWithEndings(content);
	let offset = 0;
	for (let i = 0; i < position.line; i++) {
		offset += lines[i]?.length ?? 0;
	}
	return offset + position.character;
}

export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	const sorted = [...edits].sort((a, b) => comparePositions(b.range.start, a.range.start));
	let next = content;
	for (const edit of sorted) {
		const start = offsetAt(next, edit.range.start);
		const end = offsetAt(next, edit.range.end);
		next = next.slice(0, start) + edit.newText + next.slice(end);
	}
	return next;
}

export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await fs.readFile(filePath, "utf8");
	const updated = applyTextEditsToString(content, edits);
	await fs.writeFile(filePath, updated, "utf8");
}

function isTextDocumentEdit(change: DocumentChange): change is TextDocumentEdit {
	return "textDocument" in change && "edits" in change;
}

export function flattenWorkspaceTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
	const editsByUri = new Map<string, TextEdit[]>();
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		editsByUri.set(uri, [...(editsByUri.get(uri) ?? []), ...edits]);
	}
	for (const change of edit.documentChanges ?? []) {
		if (!isTextDocumentEdit(change)) continue;
		const uri = change.textDocument.uri;
		editsByUri.set(uri, [...(editsByUri.get(uri) ?? []), ...change.edits]);
	}
	return editsByUri;
}

export function formatWorkspaceEdit(edit: WorkspaceEdit, cwd: string): string[] {
	const lines: string[] = [];
	for (const [uri, edits] of flattenWorkspaceTextEdits(edit)) {
		const filePath = uriToFile(uri);
		const rel = formatPathRelativeToCwd(filePath, cwd);
		for (const textEdit of edits) {
			lines.push(
				`${rel}:${textEdit.range.start.line + 1}:${textEdit.range.start.character + 1} -> ${JSON.stringify(textEdit.newText.slice(0, 80))}`,
			);
		}
	}
	for (const change of edit.documentChanges ?? []) {
		if (isTextDocumentEdit(change)) continue;
		if (change.kind === "create") lines.push(`create ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
		if (change.kind === "rename")
			lines.push(
				`rename ${formatPathRelativeToCwd(uriToFile(change.oldUri), cwd)} -> ${formatPathRelativeToCwd(uriToFile(change.newUri), cwd)}`,
			);
		if (change.kind === "delete") lines.push(`delete ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
	}
	return lines;
}

export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const applied: string[] = [];
	for (const [uri, edits] of flattenWorkspaceTextEdits(edit)) {
		const filePath = uriToFile(uri);
		await applyTextEdits(filePath, edits);
		applied.push(`${formatPathRelativeToCwd(filePath, cwd)}: ${edits.length} edit(s)`);
	}
	for (const change of edit.documentChanges ?? []) {
		if (isTextDocumentEdit(change)) continue;
		if (change.kind === "create") {
			const filePath = uriToFile(change.uri);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, "", { flag: change.options?.overwrite ? "w" : "wx" });
			applied.push(`created ${formatPathRelativeToCwd(filePath, cwd)}`);
		} else if (change.kind === "rename") {
			const oldPath = uriToFile(change.oldUri);
			const newPath = uriToFile(change.newUri);
			await fs.mkdir(path.dirname(newPath), { recursive: true });
			await fs.rename(oldPath, newPath);
			applied.push(`renamed ${formatPathRelativeToCwd(oldPath, cwd)} -> ${formatPathRelativeToCwd(newPath, cwd)}`);
		} else if (change.kind === "delete") {
			const filePath = uriToFile(change.uri);
			await fs.rm(filePath, {
				recursive: change.options?.recursive ?? false,
				force: change.options?.ignoreIfNotExists ?? false,
			});
			applied.push(`deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
		} else {
			throw new LspToolError("Unsupported workspace edit document change");
		}
	}
	return applied;
}
