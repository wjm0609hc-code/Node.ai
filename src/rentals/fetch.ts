// Production listing fetcher (Node only: uses the SSRF-guarded fetch). Kept out
// of rentals.ts so the browser simulator bundle doesn't pull in Node modules.
import { safeFetchText } from "../lib/safe-fetch";
import type { ListingFetcher } from "./rentals";

export const webListingFetcher: ListingFetcher = async (url) => (await safeFetchText(url)).text;
