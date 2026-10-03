/**
 * Entry point. Every other module holds declarations; this is the only one
 * that starts anything. The screen modules (screens.js, home.js,
 * books-overview.js, getpaid.js, send.js, settings.js, invoice.js) register
 * into RENDER when they load, so they are imported before boot runs.
 */
import { toast } from "./core.js";
import "./screens.js";
import "./home.js";
import "./books-overview.js";
import "./getpaid.js";
import "./send.js";
import "./settings.js";
import "./invoice.js";
import { boot } from "./shell.js";

boot().catch((e) => toast(e.message, true));
