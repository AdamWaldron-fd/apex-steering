import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "../../fixtures");

export const sampleHls = (): string =>
  fs.readFileSync(path.join(fixturesDir, "sample-hls.m3u8"), "utf-8");

export const sampleDash = (): string =>
  fs.readFileSync(path.join(fixturesDir, "sample-dash.mpd"), "utf-8");

export const providers = (): unknown[] =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, "providers.json"), "utf-8"));
