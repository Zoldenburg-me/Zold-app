import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

/**
 * A port nothing listens on right now, so parallel runs never share one.
 * It is released before the caller binds it, so call it right before the
 * listen or spawn that uses it; a hardhat node uses hardhatNode instead.
 */
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

/**
 * A hardhat node on a port the OS assigns (--port 0), with the URL read from
 * the node's own banner: the port is never free between choosing and binding,
 * so a parallel run cannot take it. Killed when this process exits.
 */
export async function hardhatNode(root: string, timeout = 30_000): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [path.join(root, "node_modules/.bin/hardhat"), "node", "--port", "0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  });
  process.on("exit", () => child.kill());
  const stdout = child.stdout!;
  stdout.setEncoding("utf8");
  const url = await new Promise<string>((resolve, reject) => {
    let banner = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("hardhat node did not start")); }, timeout);
    const onData = (chunk: string) => {
      banner += chunk;
      const m = banner.match(/JSON-RPC server at (http:\/\/127\.0\.0\.1:\d+)\//);
      if (!m) return;
      clearTimeout(timer);
      stdout.off("data", onData);
      resolve(m[1]);
    };
    stdout.on("data", onData);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`hardhat node exited (${code}) before listening`)); });
  });
  // Keep draining: the node logs every call, and a full pipe would stall it.
  stdout.resume();
  return { child, url };
}
