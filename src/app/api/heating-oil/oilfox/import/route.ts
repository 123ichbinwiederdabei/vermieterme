import { ApiError, apiHandler, jsonOk, requireAuth } from "@/lib/api-utils";
import { parseOilFoxCsv } from "@/lib/oilfox-csv";
import { detectDeliveryCandidate } from "@/lib/oilfox-sync";
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
import { toScaledInteger } from "@/lib/billing-v2";

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
    if (device.quantityUnit && device.quantityUnit !== "L") throw new ApiError("Nur OilFox-Geräte mit Einheit Liter können importiert werden.", 400);
    const tank = await prisma.heatingOilTank.findUnique({ where: { id: tankId } });
    if (!tank) throw new ApiError("Tank nicht gefunden.", 404);
    const fileText = await file.text();
    const fileHash = createHash("sha256").update(fileText).digest("hex");
    const parsed = parseOilFoxCsv(fileText);
    let imported = 0;
    let duplicates = 0;
    const warnings = [...parsed.warnings];
    const pending: typeof parsed.rows = [];
    for (const row of [...parsed.rows].sort((left, right) => left.measuredAt.getTime() - right.measuredAt.getTime())) {
      if (toScaledInteger(row.fillLevelLiters) < 0n || (tank.capacityLiters && toScaledInteger(row.fillLevelLiters) > toScaledInteger(tank.capacityLiters.toString()))) {
        warnings.push(`Tankstand ${row.fillLevelLiters} L am ${row.measuredAt.toISOString()} liegt außerhalb der Tankkapazität.`);
        continue;
      }
      const exists = await prisma.oilStockReading.findUnique({ where: { oilFoxDeviceId_readingDate: { oilFoxDeviceId: device.id, readingDate: row.measuredAt } } });
      if (exists) duplicates += 1; else pending.push(row);
    }
    const invalidRows = parsed.invalidRows + (parsed.rows.length - pending.length - duplicates);
    if (!dryRun) {
      const priorImport = await prisma.oilFoxCsvImport.findUnique({ where: { tankId_deviceId_fileHash: { tankId, deviceId, fileHash } } });
      if (priorImport) return jsonOk({ dryRun: false, imported: 0, skippedDuplicates: duplicates, invalidRows, warnings: [...warnings, "Diese Datei wurde bereits importiert."], importId: priorImport.id, candidateCount: 0 });
      const batch = await prisma.oilFoxCsvImport.create({ data: { tankId, deviceId, fileName: file.name, fileHash, importedRows: pending.length, skippedDuplicates: duplicates, invalidRows, warningsJson: JSON.stringify(warnings) } });
      const readingIds: string[] = [];
      for (const row of pending) {
        const reading = await prisma.oilStockReading.create({
          data: { tankId, oilFoxDeviceId: device.id, oilFoxCsvImportId: batch.id, deviceHwid: device.hwid, readingDate: row.measuredAt, quantityLiters: row.fillLevelLiters, distanceCm: row.distanceCm, method: "OILFOX", source: "OILFOX_CSV" },
        });
        imported += 1;
        readingIds.push(reading.id);
      }
      // Detect only after every chronologically ordered row is durable. This
      // also catches a delivery in a reverse-sorted FoxMobile export.
      for (const readingId of readingIds) await detectDeliveryCandidate(tankId, readingId);
      const candidates = await prisma.oilDeliveryCandidate.count({ where: { tankId, afterMeasurement: { oilFoxCsvImportId: batch.id } } });
      return jsonOk({ dryRun: false, imported, skippedDuplicates: duplicates, invalidRows, warnings, importId: batch.id, candidateCount: candidates });
    }
    return jsonOk({ dryRun: true, imported: pending.length, skippedDuplicates: duplicates, invalidRows, warnings, measuredFrom: pending[0]?.measuredAt ?? null, measuredTo: pending[pending.length - 1]?.measuredAt ?? null, candidateCount: estimateIncreases(pending, tank.deliveryDetectionThresholdLiters.toString()) });
  });
}

function estimateIncreases(rows: Array<{ fillLevelLiters: string }>, threshold: string): number {
  let candidates = 0;
  for (let index = 1; index < rows.length; index += 1) if (toScaledInteger(rows[index].fillLevelLiters) - toScaledInteger(rows[index - 1].fillLevelLiters) >= toScaledInteger(threshold)) candidates += 1;
  return candidates;
}
