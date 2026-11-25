/**
 * A response sent from inside a `store.tx` callback goes out once the
 * transaction has committed: on JSON the file is written at the end of the
 * transaction, and a failed write exits before anything was answered
 * (store/db.ts persist). A transaction that fails drops the held response,
 * and the error handler answers instead.
 */
import type express from "express";
import { deferToCommit } from "../store/backend.js";

export const sendAfterCommit: express.RequestHandler = (_req, res, next) => {
  const send = res.send.bind(res);
  const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
  res.send = ((body?: unknown) => (deferToCommit(() => void send(body)) ? res : send(body))) as typeof res.send;
  res.end = ((...args: unknown[]) => (deferToCommit(() => void end(...args)) ? res : end(...args))) as typeof res.end;
  next();
};
