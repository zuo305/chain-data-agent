import type { Dataset } from "../platform/dataset";
import { solanaValidators } from "./solana-validators";

// Every dataset served by the platform. Add new datasets here.
export const datasets: Dataset[] = [solanaValidators];
