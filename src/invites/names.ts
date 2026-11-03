// First names people give when they first text Nod ("Hey Nod! I'm Will."), so the
// waitlist reply can greet them by name. The home page types this greeting for them
// when they fill in the optional name field; people can also just say it.

/** Capitalised words that follow "I'm" without being names. */
const NOT_NAMES = new Set(
  ("a an the here on in just new not so still trying looking curious interested excited back from with your ok okay good fine sure ready me " +
    "monday tuesday wednesday thursday friday saturday sunday today tonight tomorrow").split(" "),
);

const INTRO = /^(?:(?:hey|hi|hello|yo|hiya)\b[\s,!.]*)?(?:@?nod\b[\s,!.]*)?(?:(?:i'?m|i am|i’m|this is|it'?s|it’s|my name is|name'?s)\s+)(\p{L}[\p{L}'’-]{0,29})(?=$|[\s,.!?])/iu;

/** The first name someone introduces themselves with at the start of a message, else null. */
export function introducedName(text: string): string | null {
  const m = INTRO.exec(text.trim());
  if (!m) return null;
  const name = m[1]!;
  if (!/^\p{Lu}/u.test(name) || NOT_NAMES.has(name.toLowerCase())) return null; // "I'm interested", "I'm Not sure"
  if (name.length < 2) return null;
  return name;
}
