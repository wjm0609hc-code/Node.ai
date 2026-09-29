// Browser bundle for the web simulator page (built by scripts/build-sim-web.mjs).
// Runs the real app (src/nod.ts) against the in-memory store; replies go through
// the page's `sample` capability (see src/agent/sample-responder.ts).
import { createSampleAnswerClassifier, createSampleClassifier, createSampleResponder } from "../../../agent/sample-responder";
import { SAMPLE_LISTINGS, sampleListingFetcher } from "../../../rentals/samples";
import { sampleSearcher } from "../../../search/samples";
import { MemoryStore } from "../../../db/memory-store";
import { createNod } from "../../../nod";
import { registerWorldPeople } from "../directory";
import { ChatWorld, NOD_PHONE } from "../world";
import { seedMixedGroup, seedTulumGroup } from "../scenarios";

(globalThis as any).NodSim = {
  ChatWorld,
  NOD_PHONE,
  seedTulumGroup,
  seedMixedGroup,
  createNod,
  MemoryStore,
  registerWorldPeople,
  createSampleResponder,
  createSampleClassifier,
  createSampleAnswerClassifier,
  sampleListingFetcher,
  sampleSearcher,
  SAMPLE_LISTINGS: SAMPLE_LISTINGS.map(({ url, label }) => ({ url, label })),
};
