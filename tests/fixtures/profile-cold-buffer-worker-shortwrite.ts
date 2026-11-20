import * as fs from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("SWMODE="));
const dir = args[0]!;
const profileId = args[1]!;
const description = args[2]!;
const preExisting = args[3]!;

const coldBufferPath = join(dir, "cold-buffer.json");
if (preExisting === "") {
  try {
    fs.unlinkSync(coldBufferPath);
  } catch {}
} else {
  fs.writeFileSync(coldBufferPath, preExisting, "utf-8");
}

const { CONFIG } = await import("../../src/config.js");
CONFIG.storagePath = dir;
CONFIG.userProfileEmbeddingMinDescriptionLength = 5;
delete CONFIG.opencodeProvider;
delete CONFIG.opencodeModel;
delete CONFIG.memoryModel;
delete CONFIG.memoryApiUrl;

const { UserProfileManager } =
  await import("../../src/services/user-profile/user-profile-manager.js");
const coldEmbed = { isWarmedUp: false } as any;

const mgr = new UserProfileManager();
let ok = true;
let error: string | null = null;
try {
  await mgr.mergeProfileData(
    { preferences: [], patterns: [], workflows: [] },
    { preferences: [{ category: "style", description }] },
    coldEmbed,
    profileId
  );
} catch (e) {
  ok = false;
  error = String(e);
}

let targetBytes: string | null;
try {
  targetBytes = fs.readFileSync(coldBufferPath, "utf-8");
} catch {
  targetBytes = null;
}
const tmpLeft = fs.readdirSync(dir).filter((f) => f.includes(".tmp")).length;

console.log(JSON.stringify({ ok, error, targetBytes, tmpLeft }));
