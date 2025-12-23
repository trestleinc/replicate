import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { ConvexHttpClient } from "convex/browser";
import { api } from "$convex/_generated/api";

const httpClient = new ConvexHttpClient(PUBLIC_CONVEX_URL);

export async function load() {
  const [intervalsMaterial, commentsMaterial] = await Promise.all([
    httpClient.query(api.intervals.material),
    httpClient.query(api.comments.material),
  ]);

  return { intervalsMaterial, commentsMaterial };
}
