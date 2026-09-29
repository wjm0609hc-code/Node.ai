// Browser bundle for the web simulator page (built by scripts/build-sim-web.mjs).
import { ChatWorld, NOD_PHONE } from "../world";
import { seedMixedGroup, seedTulumGroup } from "../scenarios";

(globalThis as any).NodSim = { ChatWorld, NOD_PHONE, seedTulumGroup, seedMixedGroup };
