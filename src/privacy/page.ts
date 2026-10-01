// A member's private settings page for one group (/group/[id]/settings?t=…),
// linked from a private message. It shows what Nod keeps for the group and lets
// this person stop Nod reading their messages and delete saved notes.

import { esc, statusHtml, webPage } from "../web/theme";

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

export function renderSettingsPage(v: SettingsView): string {
  const action = `/group/${encodeURIComponent(v.groupId)}/settings`;
  const hidden = `<input type="hidden" name="t" value="${esc(v.token)}">`;
  const noteList = (kind: SettingsNote["kind"]) =>
    v.notes
      .filter((n) => n.kind === kind)
      .map(
        (n) => `<div class="item"><span>${esc(n.about)}: ${esc(n.note)}</span>
<form method="post" action="${action}">${hidden}<input type="hidden" name="action" value="delete_note"><input type="hidden" name="note" value="${esc(n.id)}"><button class="btn quiet" type="submit">Delete</button></form></div>`,
      )
      .join("\n");
  const must = noteList("must_have");
  const prefs = noteList("preference");
  const reading = v.optedOut
    ? `<p>Nod doesn't read your messages in this chat. It still answers when you tag @Nod, and you can still vote and pay.</p>
<form method="post" action="${action}">${hidden}<input type="hidden" name="action" value="opt_in"><button class="btn" type="submit">Let Nod read my messages again</button></form>`
    : `<p>Nod keeps this chat's recent messages (the last 200, or 30 days, whichever is fewer) so it can follow along when someone tags it.</p>
<form method="post" action="${action}">${hidden}<input type="hidden" name="action" value="opt_out"><button class="btn" type="submit">Stop reading my messages</button></form>
<p class="tag">This also deletes your messages Nod has stored from this chat.</p>`;
  return webPage({
    title: `Nod settings: ${v.groupName ?? "group"}`,
    body: `<h1>${esc(v.groupName ?? "Your group")}</h1>
<p class="sub">Settings for ${esc(v.viewerName)}. This link is just for you.</p>
${v.flash ? statusHtml("done", v.flash, "") : ""}
<h2>Your messages</h2>
<div class="sheet">${reading}</div>
<h2>Spending</h2>
<div class="sheet"><p>${esc(v.approverLine)} ${esc(v.limitLine)}</p><p class="tag">To change the organizer, ask in the chat: “@Nod make Sarah the organizer.”</p></div>
<h2>Saved notes</h2>
<div class="sheet">
${must ? `<p class="tag">Must-haves: Nod makes sure there's an option for them.</p><div class="list">${must}</div>` : ""}
${prefs ? `<p class="tag">Preferences: context only, never used to rule anything out.</p><div class="list">${prefs}</div>` : ""}
${must || prefs ? "" : `<p class="sub" style="margin:0">Nothing saved. Notes are only saved when someone asks Nod to remember something.</p>`}
</div>
<h2>Forget everything</h2>
<div class="sheet"><p>To delete this chat's stored messages and notes, say “@Nod forget this chat” in the group. The tab, bookings and payments are kept.</p></div>`,
  });
}

export function settingsNotFoundPage(): string {
  return webPage({ title: "Link not valid", body: `<h1>This link isn't valid</h1><p class="sub">Ask Nod for a new one: text “@Nod settings” in your group.</p>` });
}
