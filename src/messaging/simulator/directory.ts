// Tells Nod's store who the simulator's people are, as if they had onboarded:
// their names (Sendblue doesn't provide names) and whether they have access.

import type { Store } from "../../db/store";
import type { ChatWorld } from "./world";

export async function registerWorldPeople(
  world: ChatWorld,
  store: Store,
  opts: { access?: "active" | "waitlist" } = {},
): Promise<void> {
  for (const person of world.allUsers()) {
    const user = await store.upsertUser(person.phone);
    await store.setUserName(user.id, person.name);
    if (opts.access) await store.setUserAccess(user.id, opts.access);
  }
}
