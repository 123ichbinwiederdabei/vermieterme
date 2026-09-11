import { prisma } from "@/lib/prisma";
import { getOilFoxDevices, OilFoxDeviceStatus } from "@/lib/oilfox-client";
import { toScaledInteger } from "@/lib/billing-v2";

export function isPossibleDelivery(previousLiters: string, currentLiters: string, thresholdLiters = "200") {
  return toScaledInteger(currentLiters) - toScaledInteger(previousLiters) >= toScaledInteger(thresholdLiters);
}

export async function detectDeliveryCandidate(tankId: string, afterMeasurementId: string) {
  const after = await prisma.oilStockReading.findUnique({ where: { id: afterMeasurementId }, include: { tank: true } });
  if (!after?.quantityLiters || after.validationError) return null;
  const before = await prisma.oilStockReading.findFirst({
    where: { tankId, readingDate: { lt: after.readingDate }, quantityLiters: { not: null }, validationError: null },
    orderBy: { readingDate: "desc" },
  });
  if (!before?.quantityLiters) return null;
  const increase = toScaledInteger(after.quantityLiters.toString()) - toScaledInteger(before.quantityLiters.toString());
  const threshold = toScaledInteger(after.tank.deliveryDetectionThresholdLiters.toString());
  if (!isPossibleDelivery(before.quantityLiters.toString(), after.quantityLiters.toString(), after.tank.deliveryDetectionThresholdLiters.toString())) return null;
  return prisma.oilDeliveryCandidate.upsert({
    where: { afterMeasurementId: after.id },
    update: {},
    create: {
      tankId,
      beforeMeasurementId: before.id,
      afterMeasurementId: after.id,
      estimatedIncreaseLiters: after.quantityLiters.minus(before.quantityLiters),
      confidence: increase >= threshold * 2n ? "HIGH" : "MEDIUM",
    },
  });
}

async function persistDevice(status: OilFoxDeviceStatus, apiVersion: string | null, apiWarning: string | null) {
  const existing = await prisma.oilFoxDevice.findUnique({ where: { hwid: status.hwid } });
  const device = await prisma.oilFoxDevice.upsert({
    where: { hwid: status.hwid },
    update: {
      quantityUnit: status.quantityUnit,
      connectionStatus: status.validationError ? "WARNING" : "ONLINE",
      lastMeasurementAt: new Date(status.currentMeteringAt),
      nextMeasurementAt: status.nextMeteringAt ? new Date(status.nextMeteringAt) : null,
      lastSyncAt: new Date(), lastError: null, apiVersion, apiWarning,
    },
    create: {
      hwid: status.hwid, quantityUnit: status.quantityUnit,
      connectionStatus: status.validationError ? "WARNING" : "DISCOVERED",
      lastMeasurementAt: new Date(status.currentMeteringAt),
      nextMeasurementAt: status.nextMeteringAt ? new Date(status.nextMeteringAt) : null,
      lastSyncAt: new Date(), apiVersion, apiWarning,
    },
  });
  if (!device.tankId || status.quantityUnit !== "L") return { device, inserted: false };
  const reading = await prisma.oilStockReading.upsert({
    where: { oilFoxDeviceId_readingDate: { oilFoxDeviceId: device.id, readingDate: new Date(status.currentMeteringAt) } },
    update: {},
    create: {
      tankId: device.tankId, oilFoxDeviceId: device.id, deviceHwid: device.hwid,
      readingDate: new Date(status.currentMeteringAt),
      quantityLiters: status.fillLevelQuantity == null ? null : String(status.fillLevelQuantity),
      fillLevelPercent: status.fillLevelPercent ?? null, batteryLevel: status.batteryLevel ?? null,
      validationError: status.validationError ?? null, method: "OILFOX", source: "OILFOX_API",
    },
  });
  const inserted = !existing || reading.createdAt.getTime() >= Date.now() - 5_000;
  if (inserted) await detectDeliveryCandidate(device.tankId, reading.id);
  return { device, inserted };
}

export async function syncOilFox(force = false) {
  const now = new Date();
  const state = await prisma.oilFoxSyncState.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!force && state.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() < 24 * 60 * 60_000) return { skipped: true, reason: "NOT_DUE" };
  if (state.leaseUntil && state.leaseUntil > now) return { skipped: true, reason: "RUNNING" };
  const leaseUntil = new Date(now.getTime() + 5 * 60_000);
  const locked = await prisma.oilFoxSyncState.updateMany({ where: { id: "global", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil, lastAttemptAt: now } });
  if (locked.count !== 1) return { skipped: true, reason: "RUNNING" };
  try {
    const result = await getOilFoxDevices();
    const tanks = await prisma.heatingOilTank.findMany();
    const assigned = await prisma.oilFoxDevice.count({ where: { tankId: { not: null } } });
    const rows = [];
    for (const status of result.devices) rows.push(await persistDevice(status, result.apiVersion, result.apiWarning));
    if (assigned === 0 && tanks.length === 1 && result.devices.filter((device) => device.quantityUnit === "L").length === 1) {
      const only = result.devices.find((device) => device.quantityUnit === "L")!;
      await prisma.oilFoxDevice.update({ where: { hwid: only.hwid }, data: { tankId: tanks[0].id } });
      rows.push(await persistDevice(only, result.apiVersion, result.apiWarning));
    }
    await prisma.oilFoxSyncState.update({ where: { id: "global" }, data: { lastSuccessAt: new Date(), lastError: null, leaseUntil: null } });
    return { skipped: false, devices: rows.length, measurements: rows.filter((row) => row.inserted).length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "OilFox-Synchronisierung fehlgeschlagen.";
    await prisma.oilFoxSyncState.update({ where: { id: "global" }, data: { lastError: message, leaseUntil: null } });
    throw error;
  }
}
