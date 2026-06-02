import type { Request } from "express";
import { config } from "../config.js";

/**
 * Build an absolute URL for a server-relative path. Prefers PUBLIC_BASE_URL
 * (set this to the droplet's public origin in production) and otherwise infers
 * the origin from the incoming request.
 */
export function publicUrlFor(req: Request, relativePath: string): string {
  const base = config.publicBaseUrl
    ? config.publicBaseUrl.replace(/\/+$/, "")
    : `${req.protocol}://${req.get("host")}`;
  const rel = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  return `${base}${rel}`;
}
