// A member's private settings page for one group (/group/[id]/settings?t=…),
// linked from a private message. It shows what Nod keeps for the group and lets
// this person stop Nod reading their messages and delete saved notes.

export interface SettingsNote {
  id: string;
  about: string;
  note: string;
  kind: "must_have" | "preference";
}

export interface SettingsView {
  groupId: string;
  token: string;
  groupName: string | null;
  viewerName: string;
  optedOut: boolean;
  /** "Will approves spending" or "No organizer set; Sarah approves spending". */
  approverLine: string;
  /** "Over $200 per person needs 3 approvals." */
  limitLine: string;
  notes: SettingsNote[];
  flash?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f6f3;--fg:#17181b;--muted:#63666d;--line:#dedfda;--accent:#a8520a;--on-accent:#fff;--ok:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#ecedef;--muted:#9a9ea6;--line:#2b2d31;--accent:#f0a04a;--on-accent:#17181b;--ok:#7fc48b}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.sub{color:var(--muted);font-size:14px;margin:0}
section{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-top:12px}
ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}li{display:flex;gap:10px;align-items:center;justify-content:space-between}
.flash{border-color:var(--ok);color:var(--ok)}form{margin:0}
button{background:var(--accent);color:var(--on-accent);border:0;border-radius:8px;padding:8px 14px;font:600 14px system-ui,sans-serif;cursor:pointer}
button.quiet{background:transparent;color:var(--accent);border:1px solid var(--line);padding:4px 10px;font-weight:500}
.tag{font-size:12px;color:var(--muted)}
section>:first-child{margin-top:0}section>:last-child{margin-bottom:0}
</style></head><body><main>
${body}
</main></body></html>`;
}

export function renderSettingsPage(v: SettingsView): string {
  const action = `/group/${encodeURIComponent(v.groupId)}/settings`;
  const hidden = `<input type="hidden" name="t" value="${esc(v.token)}">`;
  const noteList = (kind: SettingsNote["kind"]) =>
    v.notes
      .filter((n) => n.kind === kind)
      .map(
        (n) => `<li><span>${esc(n.about)}: ${esc(n.note)}</span>
<form method="post" action="${action}">${hidden}<input type="hidden" name="action" value="delete_note"><input type="hidden" name="note" value="${esc(n.id)}"><button class="quiet" type="submit">Delete</button></form></li>`,
      )
      .join("\n");
  const must = noteList("must_have");
  const prefs = noteList("preference");
  const reading = v.optedOut
    ? `<p>Nod doesn't read your messages in this chat. It still answers when you tag @Nod, and you can still vote and pay.</p>
<form method="post" action="${action}">${hidden}<input type="hidden" name="action" value="opt_in"><button type="submit">Let Nod read my messages again</button></form>`
    : `<p>Nod keeps this chat's recent messages (the last 200, or 30 days, whichever is fewer) so it can follow the conversation when someone tags it.</p>
<form method="post" action="${action}">${hidden}<input type="hidden" name="action" value="opt_out"><button type="submit">Stop reading my messages</button></form>
<p class="sub">This also deletes your messages Nod has stored from this chat.</p>`;
  return shell(
    `Nod settings: ${v.groupName ?? "group"}`,
    `<h1>${esc(v.groupName ?? "Your group")}</h1>
<p class="sub">Settings for ${esc(v.viewerName)}. This link is just for you.</p>
${v.flash ? `<section class="flash" role="status">${esc(v.flash)}</section>` : ""}
<h2>Your messages</h2>
<section>${reading}</section>
<h2>Spending</h2>
<section><p>${esc(v.approverLine)} ${esc(v.limitLine)}</p><p class="sub">To change the organizer, ask in the chat: “@Nod make Sarah the organizer.”</p></section>
<h2>Saved notes</h2>
<section>
${must ? `<p class="tag">Must-haves: Nod makes sure there's an option for them.</p><ul>${must}</ul>` : ""}
${prefs ? `<p class="tag">Preferences: context only, never used to rule anything out.</p><ul>${prefs}</ul>` : ""}
${must || prefs ? "" : `<p class="sub">Nothing saved. Notes are only saved when someone asks Nod to remember something.</p>`}
</section>
<h2>Forget everything</h2>
<section><p>To delete all of this chat's stored messages and notes, say “@Nod forget this chat” in the group. The tab, bookings and payments are kept.</p></section>`,
  );
}

export function settingsNotFoundPage(): string {
  return shell("Link not valid", `<h1>This link isn't valid</h1><p class="sub">Ask Nod for a new one: text “@Nod settings” in your group.</p>`);
}
