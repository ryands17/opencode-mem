const fs = require("node:fs") as typeof import("node:fs");
const real = fs.writeSync;
const argv = process.argv as unknown as string[];
const mode = argv.find((a) => a.startsWith("SWMODE="))?.slice("SWMODE=".length) ?? "";
let callIndex = 0;

(fs as any).writeSync = function (fd: number, ...rest: any[]) {
  if (fd === 1 || fd === 2) {
    return (real as any)(fd, ...rest);
  }
  callIndex++;
  const buffer = rest[0] as Buffer;
  if (mode === "zero") {
    if (callIndex === 1) return 0;
    return (real as any)(fd, ...rest);
  }
  if (mode === "half") {
    if (callIndex === 1) {
      const len = rest[2] as number;
      return (real as any)(fd, buffer, rest[1], Math.max(0, Math.floor(len / 2)));
    }
    if (callIndex === 2) {
      const err = new Error("simulated EIO mid-payload") as any;
      err.code = "EIO";
      throw err;
    }
    return (real as any)(fd, ...rest);
  }
  return (real as any)(fd, buffer, rest[1], 1);
};
