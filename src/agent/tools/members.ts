// Finding a member of the current group by the name Claude uses.

import type { ChatMember } from "../../db/store";
import { nameMatches } from "../../db/store";
import { displayName } from "../context";
import { ToolError, type ToolContext } from "../tools";

/** Exact display name first, then first name. Throws a ToolError Claude can act on. */
export function resolveMember(ctx: ToolContext, name: string): ChatMember {
  const wanted = name.trim().toLowerCase();
  const exact = ctx.members.filter((m) => displayName(m).toLowerCase() === wanted);
  const matches = exact.length ? exact : ctx.members.filter((m) => m.name && nameMatches(m.name, name));
  if (!matches.length) throw new ToolError(`No one named “${name}” is in this group.`);
  if (matches.length > 1) {
    throw new ToolError(`More than one member matches “${name}”: ${matches.map(displayName).join(", ")}. Use their full name.`);
  }
  return matches[0]!;
}
