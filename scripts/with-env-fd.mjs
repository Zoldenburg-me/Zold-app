/**
 * Runs a command with dotenv lines read from file descriptor 3 merged into its
 * environment. secrets.sh pipes `age -d` into fd 3, so the decrypted values
 * exist in memory and in the child's environment, never in a file.
 *
 * A variable already set in the environment wins, as with process.loadEnvFile.
 * An empty or unreadable fd 3 (a wrong identity, a failed decrypt) refuses to
 * start the command rather than starting it without its secrets.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: with-env-fd.mjs COMMAND... 3<dotenv");
  process.exit(1);
}

let text = "";
try {
  text = readFileSync(3, "utf8");
} catch (err) {
  console.error(`could not read secrets on fd 3: ${err.code ?? err.message}`);
  process.exit(1);
}
const secrets = parseEnv(text);
if (Object.keys(secrets).length === 0) {
  console.error("no secrets decrypted (wrong identity, or an empty file); not starting the command");
  process.exit(1);
}

const child = spawn(command, args, { stdio: "inherit", env: { ...secrets, ...process.env } });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
