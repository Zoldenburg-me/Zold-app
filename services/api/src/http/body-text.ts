import type express from "express";
import { hasUnstorableText } from "../store/text.js";

/** A NUL or half an emoji in any body string is refused, once, before any
 *  router: Postgres cannot store it, and a row holding it could never be
 *  written again. */
export const refuseUnstorableText: express.RequestHandler = (req, res, next) => {
  if (!hasUnstorableText(req.body)) return next();
  res.status(400).json(BAD_TEXT);
};

/** The refusal, for a route that parses its own body (a CSV upload). */
export const BAD_TEXT = { error: "The request contains a NUL character or half of an emoji. Remove it and try again.", code: "BAD_TEXT" };
