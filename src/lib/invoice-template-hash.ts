import { createHash } from "node:crypto";
import type { TemplateRules } from "@/lib/invoice-extraction";
export function templateHash(rules: TemplateRules, markers: string[]) {
  return createHash("sha256")
    .update(JSON.stringify({ rules, markers }))
    .digest("hex");
}
