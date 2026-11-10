// The reply-quality test cases (see evals/reply-quality/README.md). Each case is a short group chat
// played through the real Nod app: the `steps` are sent in order, and every step says whether Nod
// should speak, which actions it must take, and what a good reply looks like (for the grader).
//
// Written from the user's real group tests: too many bubbles, asking who paid a receipt, not knowing
// people's names, explaining its own limits, and having to tag Nod for every reply.

export type Who = "will" | "sarah" | "jake" | "mike" | "priya";

export interface Step {
  who: Who;
  text: string;
  /** Attach the labelled sample receipt photo. */
  photo?: boolean;
  expect: {
    /** Should Nod say anything to this message? */
    reply: "speak" | "silent";
    /** Actions (tool names) Nod must take for this message. */
    calls?: string[];
    /** Actions Nod must not take. */
    avoid?: string[];
    /** What a good reply does, for the grader. Leave out for steps that only set up the chat. */
    good?: string;
  };
}

export interface Case {
  id: string;
  tags: string[];
  /** Which chat: "friends" is a New York group (Will, Sarah, Jake, Mike, Priya); "tulum" is a trip group. */
  group: "friends" | "tulum";
  /** Extra state before the chat starts. */
  seed?: Array<"mike_unnamed" | "past_dinner" | "mike_vegetarian">;
  steps: Step[];
}

const setup = (who: Who, text: string): Step => ({ who, text, expect: { reply: "speak" } });
const chatter = (who: Who, text: string): Step => ({ who, text, expect: { reply: "silent" } });

export const CASES: Case[] = [
  // ---- searching ----
  {
    id: "search-dinner",
    tags: ["search", "restaurants"],
    group: "friends",
    steps: [
      {
        who: "sarah",
        text: "@Nod dinner for 5 Saturday at 7pm in the West Village?",
        expect: { reply: "speak", calls: ["search_web", "show_options"], good: "Searches with party size 5, Saturday at 7pm, West Village, and sends the picks as one picture with links. Its own text is a few words at most, with no list of the places." },
      },
    ],
  },
  {
    id: "search-drinks-no-place",
    tags: ["search", "restaurants"],
    group: "friends",
    steps: [
      {
        who: "jake",
        text: "@Nod good bars for drinks tonight?",
        expect: { reply: "speak", good: "Either searches using a sensible default for the area and says the default, or asks one short question about the neighborhood. Never both a long explanation and a question." },
      },
    ],
  },
  {
    id: "search-trip-activities",
    tags: ["search", "activities"],
    group: "tulum",
    steps: [
      // Nod never sees messages from before it joined, so the trip dates come up after it does.
      chatter("will", "reminder we land march 14 and fly home the 18th"),
      {
        who: "will",
        text: "@Nod fun stuff to do saturday afternoon?",
        expect: { reply: "speak", calls: ["search_web"], good: "Reads 'saturday' and the place from the group (Tulum trip, March 14–18) without asking, searches activities, and shows about 4 picks without listing them in text." },
      },
    ],
  },
  {
    id: "search-tickets",
    tags: ["search", "events"],
    group: "friends",
    steps: [
      {
        who: "mike",
        text: "@Nod can we get Knicks tickets for 5 this week",
        expect: { reply: "speak", calls: ["search_web"], good: "Searches Knicks games this week with where to get tickets for 5 people, shows the picks as cards, and doesn't claim it bought anything." },
      },
    ],
  },
  {
    id: "search-must-have",
    tags: ["search", "notes"],
    group: "friends",
    seed: ["mike_vegetarian"],
    steps: [
      {
        who: "will",
        text: "@Nod steakhouse for the 5 of us friday 8pm, midtown",
        expect: { reply: "speak", calls: ["search_web"], good: "Searches steakhouses as asked (doesn't swap the cuisine because of Mike's vegetarian note) while making sure there are options for a vegetarian. Short reply." },
      },
    ],
  },
  {
    id: "search-more",
    tags: ["search", "restaurants"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      {
        who: "sarah",
        text: "@Nod any more options? maybe a bit cheaper",
        expect: { reply: "speak", calls: ["search_web"], good: "Finds more, cheaper places in the same area and time without asking again for the details it already has." },
      },
    ],
  },

  // ---- deciding ----
  {
    id: "vote-on-picks",
    tags: ["vote"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      {
        who: "will",
        text: "@Nod let's vote on the top 3",
        expect: { reply: "speak", calls: ["start_vote"], good: "Starts a vote on three of the picks. Doesn't write the options as a list in its own reply (the vote posts them for tapping)." },
      },
    ],
  },
  {
    id: "vote-instead-of-asking",
    tags: ["vote", "defaults"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      {
        who: "jake",
        text: "@Nod which one should we pick? everyone's being indecisive",
        expect: { reply: "speak", calls: ["start_vote"], good: "Gets the group to decide by starting a vote people tap (or recommends one pick with a reason). Doesn't ask the group an open question like 'what do you all prefer?'." },
      },
    ],
  },
  {
    id: "date-poll",
    tags: ["vote", "dates"],
    group: "friends",
    steps: [
      {
        who: "priya",
        text: "@Nod can you see which weekend works for everyone for a beach trip, march 13-15 or march 20-22",
        expect: { reply: "speak", calls: ["run_date_poll"], good: "Runs a date poll with the two weekends, so people tap. Doesn't list the dates in its own reply or ask people to reply with numbers." },
      },
    ],
  },
  {
    id: "close-vote",
    tags: ["vote"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      setup("will", "@Nod let's vote on the top 3"),
      {
        who: "will",
        text: "@Nod just close it, we're going with whatever's winning",
        expect: { reply: "speak", calls: ["close_vote"], good: "Closes the vote. The result is posted by the vote itself, so its own text is short or empty." },
      },
    ],
  },

  // ---- the tab ----
  {
    id: "receipt-split",
    tags: ["tab", "receipts"],
    group: "friends",
    steps: [
      {
        who: "sarah",
        text: "@Nod split this",
        photo: true,
        expect: { reply: "speak", calls: ["split_receipt"], avoid: ["send_balances"], good: "Records the receipt as paid by Sarah and split evenly across the group without asking who paid or how to split, and says the default in a few words." },
      },
    ],
  },
  {
    id: "expense-stated",
    tags: ["tab"],
    group: "friends",
    steps: [
      {
        who: "jake",
        text: "@Nod I paid $120 for the uber, split it with everyone",
        expect: { reply: "speak", calls: ["record_expense"], good: "Records $120 paid by Jake, split evenly across the group. One short confirmation, no per-person amounts needed unless short." },
      },
    ],
  },
  {
    id: "tab-summary",
    tags: ["tab"],
    group: "friends",
    steps: [
      setup("jake", "@Nod I paid $120 for the uber, split it with everyone"),
      chatter("sarah", "$85 for the wine was mine btw"),
      {
        who: "will",
        text: "@Nod what's the tab",
        expect: { reply: "speak", calls: ["tab_summary"], avoid: ["send_balances"], good: "Adds Sarah's $85 wine to the tab (she said it was hers) and posts the whole tab in the group with one message, without asking her to confirm or sending private texts." },
      },
    ],
  },
  {
    id: "tab-unnamed-member",
    tags: ["tab", "names"],
    group: "friends",
    seed: ["mike_unnamed"],
    steps: [
      chatter("mike", "dinner was $250, I got it"),
      {
        who: "will",
        text: "@Nod add Mike's dinner to the tab, split 5 ways",
        expect: { reply: "speak", calls: ["record_expense"], good: "Works out that the member who said 'I got it' is Mike (saving his name) and records $250 paid by him, split 5 ways. If it can't tell, it still records what it can and asks one short question about the name." },
      },
    ],
  },
  {
    id: "settle-up",
    tags: ["tab"],
    group: "friends",
    steps: [
      setup("jake", "@Nod I paid $120 for the uber, split it with everyone"),
      setup("sarah", "@Nod I paid $300 for dinner, split it evenly"),
      {
        who: "mike",
        text: "@Nod ok let's settle up",
        expect: { reply: "speak", avoid: ["send_balances"], good: "Posts who pays whom in one message (fewest payments). Doesn't send private texts or explain how payments work." },
      },
    ],
  },
  {
    id: "undo-expense",
    tags: ["tab"],
    group: "friends",
    steps: [
      setup("jake", "@Nod I paid $120 for the uber, split it with everyone"),
      {
        who: "jake",
        text: "@Nod wait undo that, it was $102",
        expect: { reply: "speak", calls: ["undo_expense", "record_expense"], good: "Removes the $120 entry and records $102 instead, split the same way, in one short reply." },
      },
    ],
  },

  // ---- booking ----
  {
    id: "booking-link",
    tags: ["booking"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      {
        who: "will",
        text: "@Nod book the first one for 5 at 7 saturday",
        expect: { reply: "speak", calls: ["booking_link"], avoid: ["mark_booked"], good: "Sends the booking link for 5 at 7pm Saturday (as a card). Never says it's booked: someone still has to book it." },
      },
    ],
  },
  {
    id: "mark-booked",
    tags: ["booking"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      setup("will", "@Nod book the first one for 5 at 7 saturday"),
      {
        who: "will",
        text: "@Nod booked it, confirmation is R8K2P",
        expect: { reply: "speak", calls: ["mark_booked"], good: "Marks it booked with code R8K2P and sends the calendar invite, in one short line." },
      },
    ],
  },

  // ---- no tag needed ----
  {
    id: "followup-change",
    tags: ["follow-up"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      {
        who: "sarah",
        text: "actually make it 8pm",
        expect: { reply: "speak", good: "Picks up Sarah's change without a tag and updates to 8pm (new links or a short confirmation). One short reply." },
      },
    ],
  },
  {
    id: "followup-chatter",
    tags: ["follow-up", "silence"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      {
        who: "sarah",
        text: "lol jake you're always late",
        expect: { reply: "silent", good: "Stays silent: Sarah is talking to Jake, not to Nod." },
      },
    ],
  },
  {
    id: "followup-other-person",
    tags: ["follow-up", "silence"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      {
        who: "mike",
        text: "make it 9 instead",
        expect: { reply: "silent", good: "Stays silent: Mike didn't call Nod and Nod didn't ask him anything. (The next time someone tags Nod it should use 9pm.)" },
      },
    ],
  },
  {
    id: "latest-number-later",
    tags: ["follow-up", "defaults"],
    group: "friends",
    steps: [
      setup("sarah", "@Nod dinner for 5 Saturday at 7pm in the West Village?"),
      chatter("jake", "jake here, I can come too so we're 6"),
      chatter("will", "nice"),
      {
        who: "will",
        text: "@Nod book the first one",
        expect: { reply: "speak", calls: ["booking_link"], good: "Uses the latest party size from the chat (6, after Jake joined) and Saturday at 7pm, and says the number it used." },
      },
    ],
  },

  // ---- staying quiet ----
  {
    id: "silent-gave-the-nod",
    tags: ["silence"],
    group: "friends",
    steps: [{ who: "jake", text: "honestly I'd give the pool one the nod", expect: { reply: "silent", good: "Stays silent: 'the nod' isn't addressed to Nod." } }],
  },
  {
    id: "silent-nodding-off",
    tags: ["silence"],
    group: "friends",
    steps: [{ who: "priya", text: "I'm literally nodding off at my desk", expect: { reply: "silent", good: "Stays silent." } }],
  },
  {
    id: "silent-could-help",
    tags: ["silence"],
    group: "friends",
    steps: [{ who: "mike", text: "we should get tacos this weekend", expect: { reply: "silent", good: "Stays silent even though it could help: nobody called Nod." } }],
  },
  {
    id: "silent-tapback-text",
    tags: ["silence"],
    group: "friends",
    steps: [{ who: "sarah", text: "Liked “@Nod dinner for 5 Saturday at 7pm”", expect: { reply: "silent", good: "Stays silent: this is an SMS tapback, not a message." } }],
  },

  // ---- memory ----
  {
    id: "memory-last-time",
    tags: ["memory"],
    group: "friends",
    seed: ["past_dinner"],
    steps: [
      {
        who: "will",
        text: "@Nod where did we go for dinner last time?",
        expect: { reply: "speak", good: "Answers from the group's history: Lupa in the West Village, a few weeks ago. One short line; doesn't guess." },
      },
    ],
  },
  {
    id: "memory-same-again",
    tags: ["memory", "booking"],
    group: "friends",
    seed: ["past_dinner"],
    steps: [
      {
        who: "sarah",
        text: "@Nod let's do the same place as last time, friday 8pm for 5",
        expect: { reply: "speak", calls: ["booking_link"], good: "Finds Lupa from the group's history and sends its booking link for 5 on Friday at 8pm, without asking which place." },
      },
    ],
  },

  // ---- everything else ----
  {
    id: "what-can-you-do",
    tags: ["other"],
    group: "friends",
    steps: [
      {
        who: "priya",
        text: "@Nod what can you do?",
        expect: { reply: "speak", good: "Two short sentences on what it does for the group (find places, run votes, book, split the tab). No bullet list, no long tour." },
      },
    ],
  },
  {
    id: "remember-note",
    tags: ["notes"],
    group: "friends",
    steps: [
      {
        who: "sarah",
        text: "@Nod remember Priya is allergic to nuts",
        expect: { reply: "speak", calls: ["remember_group_note"], good: "Saves it as a must-have for Priya and confirms in a few words." },
      },
    ],
  },
];
