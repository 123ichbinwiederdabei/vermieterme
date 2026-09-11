import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function globalSetup() {
  const executable = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [executable, "migrate", "reset", "--force", "--skip-generate"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: "file:./e2e.db",
      ADMIN_EMAIL: "e2e@example.test",
      ADMIN_PASSWORD: "e2e-password",
    },
    stdio: "inherit",
  });
}
