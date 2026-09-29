// The Inngest client (INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY come from the environment).
import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "nod" });
