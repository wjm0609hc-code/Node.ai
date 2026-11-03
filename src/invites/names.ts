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

/** Carrier keywords for turning texts off and on, as the whole message. */
export function stopWord(text: string): "stop" | "start" | null {
  const t = text.trim().replace(/[.!]+$/, "").toLowerCase();
  if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/.test(t)) return "stop";
  if (/^(start|unstop)$/.test(t)) return "start";
  return null;
}

/** A plain hello ("hey", "Hey Nod! I'm Will.") with nothing to answer beyond a welcome. */
export function isJustHello(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const rest = t
    .replace(/^(?:(?:hey|hi|hello|yo|hiya|sup|ok|okay)\b[\s,!.]*)?/i, "")
    .replace(/^(?:@?nod\b[\s,!.]*)?/i, "")
    .replace(/^(?:(?:i'?m|i am|i’m|this is|it'?s|it’s|my name is)\s+\p{L}[\p{L}'’-]*[\s,!.]*)?/iu, "")
    .replace(/^(?:sign me up|let me in|get started)[\s!.]*$/i, "")
    .trim();
  return rest === "" || /^[\p{Emoji}\s!.]+$/u.test(rest) && !/\d/.test(rest);
}

/** Words that answer "what should I call you?" without being a name. */
const NOT_A_REPLY = new Set(
  ("yes no yeah yep nope ok okay sure thanks thank thx hi hey hello yo lol haha cool nice great what why who how idk " +
    "nothing none skip later stop start help me you it the a an and or not maybe nah").split(" "),
);

/**
 * Their name, when this message answers "what should I call you?": "Brian", "brian", "Brian Matthews",
 * "it's Brian", "call me Pete". Null for anything else ("what?", "lol", a question, a long message).
 */
export function nameReply(text: string): string | null {
  const t = text.trim().replace(/[.!]+$/, "");
  const intro = introducedName(t);
  if (intro) return intro;
  const m = /^(?:(?:call me|it'?s|it’s|i'?m|i’m)\s+)?(\p{L}[\p{L}'’-]{1,20})(?:\s+(\p{L}[\p{L}'’-]{1,20}))?$/iu.exec(t);
  if (!m) return null;
  const first = m[1]!;
  if (NOT_A_REPLY.has(first.toLowerCase()) || (m[2] && NOT_A_REPLY.has(m[2].toLowerCase()))) return null;
  const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
  return cap(first); // first names only, like the rest of Nod
}
