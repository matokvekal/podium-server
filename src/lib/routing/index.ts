// The routing provider this process uses, built once from env. null = ROUTING_URL unset: routing
// is unavailable — /route-builder/config says so and /route-builder/segment answers 503.

import { env } from "../../config/env.js";
import { BrouterProvider } from "./brouter.js";
import { CachedRoutingProvider } from "./cache.js";
import type { RoutingProvider } from "./provider.js";

let provider: RoutingProvider | null | undefined;

export function getRoutingProvider(): RoutingProvider | null {
  if (provider === undefined) {
    provider = env.ROUTING_URL
      ? new CachedRoutingProvider(
          new BrouterProvider({
            baseUrl: env.ROUTING_URL,
            profiles: { road: env.ROUTING_PROFILE_ROAD, mtb: env.ROUTING_PROFILE_MTB },
          }),
        )
      : null;
  }
  return provider;
}
