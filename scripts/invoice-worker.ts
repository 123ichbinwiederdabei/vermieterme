import { processNextInvoiceJob } from "../src/lib/invoice-jobs";
import { prisma } from "../src/lib/prisma";

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function run() {
  while (!stopping) {
    try {
      const worked = await processNextInvoiceJob();
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
      console.error("Invoice worker database/processing failure; retrying.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  await prisma.$disconnect();
}
void run();
