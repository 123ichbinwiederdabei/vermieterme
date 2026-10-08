import { expect, it } from "vitest";
import { formatCents } from "../../../apps/mieter-app/lib/format";
it("formats final tenant cents without losing integer precision", () => {
  expect(formatCents("9007199254740993")).toBe("90.071.992.547.409,93");
  expect(formatCents("-12345")).toBe("−123,45");
  expect(formatCents("-12345", true)).toBe("123,45");
  expect(formatCents("0")).toBe("0,00");
});
