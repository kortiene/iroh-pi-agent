/** Members tab renderer for the read-only Room Cockpit. */

import type { CockpitSnapshot, MemberSummary } from "./model.js";
import { groupLabel, padCell, sectionTitle, shortId, type RenderKit } from "./layout.js";
import { roomText } from "../sanitize.js";

/**
 * Deterministic roster order for display + selection: admins first, then by
 * identity id. The ambient members poll is a Map (insertion order), so a
 * stable sort here keeps the cursor row from jumping between refreshes.
 */
export function orderedMembers(members: readonly MemberSummary[]): MemberSummary[] {
	return [...members].sort((a, b) => {
		const adminA = a.isAdmin === true ? 0 : 1;
		const adminB = b.isAdmin === true ? 0 : 1;
		if (adminA !== adminB) return adminA - adminB;
		return a.id.localeCompare(b.id);
	});
}

/** Glyph + theme color per member — admin stands out, self is accented. */
function memberStyle(member: MemberSummary, isSelf: boolean): { glyph: string; color: string } {
	if (isSelf) return { glyph: "▸", color: "accent" };
	if (member.isAdmin === true) return { glyph: "★", color: "warning" };
	return { glyph: "•", color: "muted" };
}

function adminText(member: MemberSummary): string {
	if (member.isAdmin === true) return "yes";
	if (member.isAdmin === false) return "no";
	return "?";
}

function headerLine(kit: RenderKit): string {
	const header = `   ${padCell("identity", 10, kit.fit)} ${padCell("role", 10, kit.fit)} ${padCell("status", 8, kit.fit)} admin?`;
	return kit.styler("dim", kit.fit(header, kit.width));
}

function renderMember(member: MemberSummary, selected: boolean, isSelf: boolean, kit: RenderKit): string {
	const marker = selected ? "▌" : " ";
	const { glyph, color } = memberStyle(member, isSelf);
	const id = padCell(roomText(shortId(member.id), 10, kit.fit) || "?", 10, kit.fit);
	const role = padCell(roomText(member.role, 10, kit.fit) || "member", 10, kit.fit);
	const status = padCell(member.status !== undefined ? roomText(member.status, 8, kit.fit) || "—" : "—", 8, kit.fit);
	const admin = padCell(adminText(member), 6, kit.fit);
	const selfTag = isSelf ? " you" : "";
	const plain = `${marker} ${glyph} ${id} ${role} ${status} ${admin}${selfTag}`;
	if (plain.length > kit.width) {
		return kit.styler(selected ? "accent" : "muted", kit.fit(plain, kit.width));
	}
	return `${kit.styler(selected ? "accent" : "dim", marker)} ${kit.styler(color, glyph)} ${kit.styler(selected ? "text" : "muted", id)} ${kit.styler("dim", role)} ${kit.styler("dim", status)} ${kit.styler(member.isAdmin === true ? "warning" : "dim", admin)}${kit.styler("accent", selfTag)}`;
}

export function renderMembers(snapshot: CockpitSnapshot, kit: RenderKit, selectedIndex: number): string[] {
	const lines: string[] = [];
	const members = orderedMembers(snapshot.members);
	lines.push(sectionTitle("Members", kit));
	lines.push(kit.styler("dim", "Roster from the periodic members poll; ★ admin, ▸ you. Read-only in this build."));
	lines.push("");
	if (members.length === 0) {
		lines.push(kit.styler("dim", "No members in the current ambient snapshot."));
		lines.push(kit.styler("dim", "The roster refreshes on a slow cadence; press r to poll now."));
		return lines;
	}
	const selfId = snapshot.identity?.identityId;
	const admins = members.filter((member) => member.isAdmin === true).length;
	lines.push(
		kit.fit(
			` ${kit.styler("muted", "ROSTER")} ${kit.styler("accent", String(members.length))} ${kit.styler("dim", `· ${admins} admin${admins === 1 ? "" : "s"}`)}`,
			kit.width,
		),
	);
	lines.push(headerLine(kit));
	const clamped = Math.max(0, Math.min(selectedIndex, members.length - 1));
	const maxRows = Math.max(4, Math.min(16, kit.width > 100 ? 18 : 12));
	const start = Math.max(0, Math.min(clamped - Math.floor(maxRows / 2), Math.max(0, members.length - maxRows)));
	const shown = members.slice(start, start + maxRows);
	for (const member of shown) {
		const index = members.indexOf(member);
		lines.push(renderMember(member, index === clamped, member.id === selfId, kit));
	}
	if (members.length > shown.length) {
		lines.push(kit.styler("dim", `   +${members.length - shown.length} more`));
	}
	const selected = members[clamped];
	if (selected !== undefined) {
		lines.push("");
		lines.push(groupLabel("Inspector", kit));
		lines.push(`  ${kit.styler("muted", "identity".padEnd(10))} ${roomText(selected.id, Math.max(0, kit.width - 14), kit.fit)}`);
		lines.push(`  ${kit.styler("muted", "role".padEnd(10))} ${kit.styler("dim", roomText(selected.role, Math.max(0, kit.width - 14), kit.fit) || "member")}`);
		lines.push(`  ${kit.styler("muted", "status".padEnd(10))} ${selected.status !== undefined ? roomText(selected.status, Math.max(0, kit.width - 14), kit.fit) : kit.styler("dim", "—")}`);
		lines.push(`  ${kit.styler("muted", "admin".padEnd(10))} ${kit.styler(selected.isAdmin === true ? "warning" : "dim", adminText(selected))}`);
		if (selected.id === selfId) {
			lines.push(`  ${kit.styler("muted", "note".padEnd(10))} ${kit.styler("accent", "this is your agent identity")}`);
		}
	}
	lines.push("");
	lines.push(kit.styler("dim", "untrusted room content"));
	return lines;
}
