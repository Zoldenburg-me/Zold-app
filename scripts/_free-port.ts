import { createServer } from "node:net";

/** A port nothing listens on right now, so parallel runs never share a node. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (!address || typeof address === "string") {
        s.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const port = address.port;
      s.close(() => resolve(port));
    });
  });
}
