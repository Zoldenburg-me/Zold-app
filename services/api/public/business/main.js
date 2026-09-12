/**
 * Entry point. Every other module holds declarations; this is the only one
 * that starts anything.
 */
import { toast } from "./core.js";
import { boot } from "./shell.js";

boot().catch((e) => toast(e.message, true));
