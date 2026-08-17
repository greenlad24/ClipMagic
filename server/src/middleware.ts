import type { NextFunction, Request, Response } from "express";

/**
 * Wrap an async route handler so a rejected promise reaches Express's error
 * handler instead of hanging the request. Express 4 does not await handlers.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}
