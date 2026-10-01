// Everything Nod says during onboarding, in one place. Short, plain, one message per action.

export const copy = {
  introBody:
    "Tag @Nod when you need me. I stay quiet otherwise. " +
    "I can't see anything from before I joined, so re-send any links you're weighing and I'll compare them. " +
    'Say "@Nod forget this chat" to clear what I\'ve saved, or remove me like any contact.',

  intro(lead: string) {
    return `${lead} ${this.introBody}`;
  },
  addedBy: (name: string) => `${name} added me.`,
  askedToStart: (name: string) => `${name} asked me to start this group.`,
  neutralLead: "Hi, I'm Nod.",
  neutralAskedToStart: "Hi, I'm Nod. One of you asked me to start this group.",

  accessNeeded: (groupName: string | null) =>
    `Thanks for adding me to ${groupName ?? "that group"}. I'll help there. Adding me to new groups needs an invite, so I've put you on the waitlist and I'll text you when a spot opens. Have a code? Send it here.`,
  cantWorkHere: (groupName: string | null) =>
    `I can't work in ${groupName ?? "that group"} because not everyone there is on iMessage. Want me to start a new group with the same people? Reply "start a group".`,

  setupWelcome: "Hi, I'm Nod. I help group chats decide on and pay for things. Here's my card, so I show up as Nod.",
  welcomeIn: (lead: string, invites: number) =>
    `${lead} I help group chats decide on and pay for things. Here's my card, so I show up as Nod.${invites > 0 ? ` You have ${invites} invites for friends; ask me for a code anytime.` : ""}`,
  setupHowTo: "To add me to a group: tap the group name, tap Add Contact, type Nod.",
  setupPrivacy:
    'Privacy: I only read chats I\'m in, keep 30 days of messages at most, and anyone can say "@Nod forget this chat".',

  card: "Here's my card.",

  startNeedsAccess: "Starting groups needs an invite. You're on the waitlist and I'll text you when a spot opens. Have a code? Send it here.",
  startWho: "Who should be in it? Try: start a group for Tulum with Jake, Sarah, and Mike.",
  startTooMany: "I can start groups of up to 25 people.",
  startAmbiguous: (name: string) => `You know more than one ${name}. Send their full name or number.`,
  startUnknown: (names: string[]) =>
    names.length === 1
      ? `I don't have a number for ${names[0]}. Share their contact card or send their number, then ask again.`
      : `I don't have a number for ${listOr(names)}. Share their contact cards or send their numbers, then ask again.`,
};

function listOr(items: string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}
