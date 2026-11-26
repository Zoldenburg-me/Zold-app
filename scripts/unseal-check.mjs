/**
 * What `secrets.sh unseal` refuses in an archive, and `seal` in a source tree,
 * so seal never writes an archive unseal refuses.
 *
 *   tar -tzf ARCHIVE | node unseal-check.mjs names   a name that is absolute or has a .. part
 *   node unseal-check.mjs tree DIR                    after unpacking: a symlink that points out
 *                                                     of DIR, a file with more than one hard link,
 *                                                     or anything but files, dirs and links
 *   node unseal-check.mjs seal DIR                    the same tree check, before sealing DIR
 *
 * A link target is resolved one component at a time, following the links
 * already in the tree, so `x -> .` plus `d -> x/..` is seen to leave DIR. An
 * absolute target, a step above DIR or more than 40 hops is refused; a
 * component that does not exist cannot be a link and is taken as written.
 *
 * seal checks the tree as unseal will see it: the archive holds DIR's own name,
 * so links resolve from DIR's parent and `../DIR/key` stays inside. Only DIR is
 * read there (a sibling is not in the archive), and a link must stay inside DIR
 * at every step: `../other/../DIR/key` is refused.
 * DIR itself must be a real directory: tar would archive a symlink as the link.
 *
 * Exits 1 with the first offending name (a path in the tree, never its content).
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

const [mode, dir] = process.argv.slice(2);
const refuse = (why) => {
  console.error(`refusing to ${mode === "seal" ? "seal" : "unseal"}: ${why}`);
  process.exit(1);
};

if (mode === "names") {
  for (const name of readFileSync(0, "utf8").split("\n")) {
    if (name.startsWith("/") || name.split("/").includes("..")) refuse(`the archive names ${JSON.stringify(name)}`);
  }
} else if ((mode === "tree" || mode === "seal") && dir) {
  const top = path.resolve(dir);
  // In seal mode the archive's root is DIR's parent and `own` is DIR's name.
  const own = mode === "seal" ? path.basename(top) : undefined;
  const root = own === undefined ? top : path.dirname(top);
  if (own !== undefined) {
    // tar archives `.` or `..` under that name, not DIR's own, so the links would resolve differently.
    if ([".", "..", ""].includes(path.basename(dir))) refuse(`name the directory, not ${JSON.stringify(dir)}`);
    let st;
    try { st = lstatSync(top); } catch { refuse(`${dir} does not exist`); }
    if (st.isSymbolicLink() || !st.isDirectory()) refuse(`${dir} is not a directory (a symlink is archived as the link)`);
  }
  const inArchive = (stack) => own === undefined || stack[0] === own;
  /** Whether the link at `p` (under root, its parents real dirs) resolves outside root, or in seal mode outside DIR. */
  const leaves = (p) => {
    const stack = path.relative(root, path.dirname(p)).split(path.sep).filter(Boolean);
    let target = readlinkSync(p);
    if (path.isAbsolute(target)) return true;
    let todo = target.split("/");
    let hops = 0;
    while (todo.length) {
      const c = todo.shift();
      if (c === "" || c === ".") continue;
      if (c === "..") {
        if (!stack.length) return true;
        stack.pop();
        continue;
      }
      stack.push(c);
      // A step through a sibling is a broken link once unsealed: the sibling is not in the archive.
      if (!inArchive(stack)) return true;
      let st;
      try { st = lstatSync(path.join(root, ...stack)); } catch { continue; }
      if (!st.isSymbolicLink()) continue;
      if (++hops > 40) return true;
      target = readlinkSync(path.join(root, ...stack));
      if (path.isAbsolute(target)) return true;
      stack.pop();
      todo = [...target.split("/"), ...todo];
    }
    return !inArchive(stack);
  };
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const p = path.join(at, entry);
      const st = lstatSync(p);
      const rel = path.relative(root, p);
      if (st.isSymbolicLink()) {
        if (leaves(p)) refuse(`${rel} links out of ${own === undefined ? "the archive" : "the sealed dir"}`);
      } else if (st.isDirectory()) walk(p);
      else if (!st.isFile()) refuse(`${rel} is not a file, a directory or a link`);
      // A hard link shares its content with a name the check cannot see or vouch for.
      else if (st.nlink > 1) refuse(`${rel} has ${st.nlink - 1} other hard link(s)`);
    }
  };
  walk(top);
} else {
  refuse("usage: unseal-check.mjs names | tree DIR | seal DIR");
}
