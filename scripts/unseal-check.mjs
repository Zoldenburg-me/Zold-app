/**
 * What `secrets.sh unseal` refuses in an archive. seal never writes any of it,
 * so finding one means the file is not one of ours.
 *
 *   tar -tzf ARCHIVE | node unseal-check.mjs names   a name that is absolute or has a .. part
 *   node unseal-check.mjs tree DIR                    after unpacking: a symlink that points out
 *                                                     of DIR, or anything but files, dirs and links
 *
 * Exits 1 with the first offending name (a path in the archive, never its content).
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

const refuse = (why) => {
  console.error(`refusing to unseal: ${why}`);
  process.exit(1);
};
const [mode, dir] = process.argv.slice(2);

if (mode === "names") {
  for (const name of readFileSync(0, "utf8").split("\n")) {
    if (name.startsWith("/") || name.split("/").includes("..")) refuse(`the archive names ${JSON.stringify(name)}`);
  }
} else if (mode === "tree" && dir) {
  const root = path.resolve(dir);
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const p = path.join(at, entry);
      const st = lstatSync(p);
      const rel = path.relative(root, p);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(p);
        const to = path.resolve(path.dirname(p), target);
        if (path.isAbsolute(target) || (to !== root && !to.startsWith(root + path.sep))) refuse(`${rel} links out of the archive`);
      } else if (st.isDirectory()) walk(p);
      else if (!st.isFile()) refuse(`${rel} is not a file, a directory or a link`);
    }
  };
  walk(root);
} else {
  refuse("usage: unseal-check.mjs names | tree DIR");
}
