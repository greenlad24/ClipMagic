import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

/**
 * Optional bearer-token / X-API-KEY gate. When API_TOKEN is unset the API is
 * open (fine for a single-user, firewalled droplet); set it to require auth on
 * every protected call.
 */
export function auth(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiToken) {
    next();
    return;
  }
  const header = req.header("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const key = bearer || req.header("x-api-key");
  if (key && key === config.apiToken) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

/** Wrap async handlers so rejected promises become 500s instead of crashes. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
