// Finding a member of the current group by the name Claude uses.

import type { ChatMember } from "../../db/store";
import { nameMatches } from "../../db/store";
import { displayName } from "../context";
import { ToolError, type ToolContext } from "../tools";

/** "2014", "ending 2014", "Member ending 2014", "...2014": the last four digits of a number Nod has no name for. */
const SUFFIX = /^(?:member\s+)?(?:ending(?:\s+in)?\s+|…|\.{3}|x+)?(\d{4})$/i;

/** Exact display name first, then the last four digits of their number, then first name. Throws a ToolError Claude can act on. */
export function resolveMember(ctx: ToolContext, name: string): ChatMember {
  const wanted = name.trim().toLowerCase();
  const suffix = SUFFIX.exec(wanted)?.[1];
  if (suffix) {
    const bySuffix = ctx.members.filter((m) => m.phone.endsWith(suffix));
    if (bySuffix.length === 1) return bySuffix[0]!;
  }
  const exact = ctx.members.filter((m) => displayName(m).toLowerCase() === wanted);
  const matches = exact.length ? exact : ctx.members.filter((m) => m.name && nameMatches(m.name, name));
  if (!matches.length) {
    const unnamed = ctx.members.filter((m) => !m.name);
    throw new ToolError(
      unnamed.length
        ? `No one Nod knows as “${name}” is in this group. Members without a name yet: ${unnamed.map(displayName).join(", ")}. ` +
            `If it's clear which one is ${name}, set_member_name first and try again; if not, do everything else and ask in one short line at the end.`
        : `No one named “${name}” is in this group.`,
    );
  }
  if (matches.length > 1) {
    throw new ToolError(`More than one member matches “${name}”: ${matches.map(displayName).join(", ")}. Use their full name.`);
  }
  return matches[0]!;
}
