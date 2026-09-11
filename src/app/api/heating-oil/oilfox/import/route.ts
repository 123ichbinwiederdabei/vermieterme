import { ApiError, apiHandler, jsonOk, requireAuth } from "@/lib/api-utils";
import { parseOilFoxCsv } from "@/lib/oilfox-csv";
import { detectDeliveryCandidate } from "@/lib/oilfox-sync";
import { prisma } from "@/lib/prisma";

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const form = await request.formData();
    const file = form.get("file");
    const tankId = String(form.get("tankId") || "");
    const deviceId = String(form.get("deviceId") || "");
    const dryRun = String(form.get("dryRun") || "false") === "true";
    if (!(file instanceof File) || !tankId || !deviceId) throw new ApiError("CSV-Datei, Tank und OilFox-Gerät sind erforderlich.", 400);
    if (file.size > 5 * 1024 * 1024) throw new ApiError("CSV-Datei ist größer als 5 MB.", 400);
    const device = await prisma.oilFoxDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.tankId !== tankId) throw new ApiError("Das OilFox-Gerät ist diesem Tank nicht zugeordnet.", 400);
    const parsed = parseOilFoxCsv(await file.text());
    let imported = 0;
    let duplicates = 0;
    const pending: typeof parsed.rows = [];
    for (const row of parsed.rows) {
      const exists = await prisma.oilStockReading.findUnique({ where: { oilFoxDeviceId_readingDate: { oilFoxDeviceId: device.id, readingDate: row.measuredAt } } });
      if (exists) duplicates += 1; else pending.push(row);
    }
    if (!dryRun) {
      for (const row of pending) {
        const reading = await prisma.oilStockReading.create({
          data: { tankId, oilFoxDeviceId: device.id, deviceHwid: device.hwid, readingDate: row.measuredAt, quantityLiters: row.fillLevelLiters, distanceCm: row.distanceCm, method: "OILFOX", source: "OILFOX_CSV" },
        });
        imported += 1;
        await detectDeliveryCandidate(tankId, reading.id);
      }
    }
    return jsonOk({ dryRun, imported: dryRun ? pending.length : imported, skippedDuplicates: duplicates, invalidRows: parsed.invalidRows, warnings: parsed.warnings });
  });
}
