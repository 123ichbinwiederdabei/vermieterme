import { processNextInvoiceJob } from "../src/lib/invoice-jobs";
import { processNextBackgroundJob, scheduleBackgroundJobs } from "../src/lib/background-jobs";
import { prisma } from "../src/lib/prisma";

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function run() {
  let nextSchedule = 0;
  while (!stopping) {
    try {
      if (Date.now() >= nextSchedule) { await scheduleBackgroundJobs(); nextSchedule = Date.now() + 30_000; }
      const imported = await processNextBackgroundJob();
      const worked = await processNextInvoiceJob() || imported;
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
      console.error("Invoice worker database/processing failure; retrying.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  await prisma.$disconnect();
}
void run();
