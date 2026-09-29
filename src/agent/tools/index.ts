// Tools available to Nod. Later Phase 1 steps add theirs here.
import type { NodTool } from "../tools";
import { sendPrivateMessage } from "./private-message";

export const defaultTools: NodTool<any>[] = [sendPrivateMessage];
