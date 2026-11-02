import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PREBUILT_DIR } from "../src/demo/setup";

describe("committed contract builds (contracts/prebuilt)", () => {
  it("match SHA256SUMS", () => {
    const sums = readFileSync(join(PREBUILT_DIR, "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums.length).toBe(2);
    for (const line of sums) {
      const [hash, file] = line.split(/\s+/) as [string, string];
      const actual = createHash("sha256").update(readFileSync(join(PREBUILT_DIR, file))).digest("hex");
      expect(actual, file).toBe(hash);
    }
  });
});
