/**
 * A response sent from inside a `store.tx` callback goes out once the
 * transaction has committed: on JSON the file is written at the end of the
 * transaction, and a failed write exits before anything was answered
 * (store/db.ts persist); on Postgres after COMMIT, and a failed COMMIT
 * answers nothing but the error handler's 500.
 *
 * A transaction that fails drops the held response, and the error handler
 * answers instead. What the handler set on the response inside that
 * transaction is undone with it: every header set (`Set-Cookie`,
 * `Location`, `Content-Type`, …) and the status, so a session cookie of a
 * dropped login never goes out on the error response.
 *
 * Rules this rests on:
 * - One response per transaction: a second `send`/`end` inside one throws
 *   at once (and so fails the transaction), instead of surfacing after it.
 * - Nothing is awaited after the `res.` call in a `store.tx` body
 *   (scripts/store-gates-test.ts). The JSON backend has no rollback: a body
 *   that answered and then failed would turn writes already on disk into a
 *   500, and a client that retries on a 500 would repeat them.
 * - Only `send` and `end` (and what calls them: `json`, `sendStatus`,
 *   `redirect`) are held. `write`, `sendFile` and piped streams are not, and
 *   none of them runs inside a transaction; one that did would answer before
 *   the commit.
 * - A header set by assigning `res.statusCode` directly is not undone;
 *   `res.status()` is.
 */
import type express from "express";
import { deferToCommit, onTxDropped, openTxToken } from "../store/backend.js";
import { describeCause } from "./log-cause.js";

export const sendAfterCommit: express.RequestHandler = (_req, res, next) => {
  const send = res.send.bind(res);
  const end = res.end.bind(res) as (...args: unknown[]) => express.Response;
  const setHeader = res.setHeader.bind(res);
  const removeHeader = res.removeHeader.bind(res);
  const status = res.status.bind(res);

  /** The transaction whose changes to this response are being recorded, and
   *  the headers as they were before its first change, restored (with the
   *  status) if it is dropped. */
  let recording: object | undefined;
  let headersBefore = new Map<string, number | string | string[] | undefined>();
  let held = false;

  /** Note the state before this transaction's first change to the response. */
  const record = (header?: string) => {
    const token = openTxToken();
    if (!token) return;
    if (recording !== token) {
      recording = token;
      const before = (headersBefore = new Map());
      const statusAtStart = res.statusCode;
      onTxDropped(() => {
        for (const [name, value] of before) {
          if (value === undefined) removeHeader(name);
          else setHeader(name, value);
        }
        res.statusCode = statusAtStart;
        recording = undefined;
      });
    }
    if (header && !headersBefore.has(header.toLowerCase())) headersBefore.set(header.toLowerCase(), res.getHeader(header));
  };

  /** Hold `go` until the commit; false outside a transaction. */
  const hold = (go: () => void): boolean => {
    if (!openTxToken()) return false;
    if (held) throw new Error("a second response inside one store.tx");
    record();
    held = true;
    deferToCommit(
      () => {
        held = false;
        try {
          go();
        } catch (err) {
          // After the commit nobody else will answer: a send that fails here
          // ends the response rather than leaving the request hanging.
          console.error(`send-after-commit: a held response failed: ${describeCause(err)}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            end();
          } else res.destroy();
        }
      },
      () => {
        held = false;
      },
    );
    return true;
  };

  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    record(name);
    return setHeader(name, value);
  }) as typeof res.setHeader;
  res.removeHeader = ((name: string) => {
    record(name);
    removeHeader(name);
  }) as typeof res.removeHeader;
  res.status = ((code: number) => {
    record();
    return status(code);
  }) as typeof res.status;
  res.send = ((body?: unknown) => (hold(() => void send(body)) ? res : send(body))) as typeof res.send;
  res.end = ((...args: unknown[]) => (hold(() => void end(...args)) ? res : end(...args))) as typeof res.end;
  next();
};
