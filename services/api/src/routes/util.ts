import type express from "express";

/** Route an async handler's rejection to Express's error handler. */
export const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);
