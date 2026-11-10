# Reply-quality tests

Thirty short group chats played through the real Nod app, to check that its replies stay short,
use sensible defaults instead of asking, take the right actions, and stay quiet when nobody asked.
They make real Claude calls, so they're separate from `npm test` and cost a little each run.

```
ANTHROPIC_API_KEY=… npm run eval                         # all cases once
npm run eval -- --only receipt-split,search-dinner       # a few cases
npm run eval -- --reps 3                                 # each case 3 times (Claude varies run to run)
npm run eval -- --variant v1                             # after a change to Nod's prompt or tools, to compare
```

Results go to `.claude/hillclimb/reply-quality/<variant>/` (`results.jsonl`, one transcript per case in
`traces/`, failures in `errors.jsonl`) and a summary prints at the end. Rerunning resumes: finished
(case, rep) pairs are skipped, so delete a variant's folder to start it over.

**What's real:** Nod's system prompt, tools, context, the "is this for Nod?" classifiers and the Claude
model it runs on (`NOD_MODEL`, default Claude Opus 5.5). **What's fixed:** searches return the made-up
places in `fixtures.ts` (so every run sees the same picks), receipt photos read as the sample receipt,
there are no payments or booking partners (as in production today), and the database is in memory.

**Grading,** per graded step (the last step of each case, and any step with a "good" note):
- Automatic checks (`checks.ts`): replies when it should and stays silent when it should; takes the
  actions the case requires and avoids the ones it forbids; and, for its own words, at most 2 sentences
  and 300 characters, at most one question, no lists or markdown, no pasted links, no explaining its limits.
- The grader (`judge.ts`, Claude Sonnet 5.5, `NOD_EVAL_JUDGE_MODEL` to change): did the job, asked nothing
  needless, brief and natural, honest. It reads the chat, what Nod did and sent, and the case's note on
  what a good reply looks like.

A case passes when every check and every grader answer passes. The summary gives the pass rate with a
95% range: with 30 cases that range is roughly ±15 points, so compare variants with `--reps 3` before
trusting a small difference.

The cases live in `cases.ts`; `npx vitest run evals` checks the checks and the runner's wiring for free.
