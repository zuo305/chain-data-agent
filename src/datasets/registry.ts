import type { Dataset } from "../platform/dataset";
import { solanaValidators } from "./solana-validators";
import { solanaUnlocks } from "./solana-unlocks";

// Every dataset served by the platform. Add new datasets here.
export const datasets: Dataset[] = [solanaValidators, solanaUnlocks];
