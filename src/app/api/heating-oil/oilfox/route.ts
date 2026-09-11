import { ApiError, apiHandler, jsonOk, requireAuth } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { syncOilFox } from "@/lib/oilfox-sync";

export function GET() {
  return apiHandler(async () => {
    await requireAuth();
    const [devices, syncState] = await Promise.all([
      prisma.oilFoxDevice.findMany({ include: { tank: true }, orderBy: { hwid: "asc" } }),
      prisma.oilFoxSyncState.findUnique({ where: { id: "global" } }),
    ]);
    return jsonOk({ configured: Boolean(process.env.OILFOX_USER && process.env.OILFOX_PW), devices, syncState });
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    if (body.action === "sync") return jsonOk(await syncOilFox(true));
    if (body.action === "assign") {
      if (typeof body.deviceId !== "string" || typeof body.tankId !== "string") throw new ApiError("Gerät und Tank sind erforderlich.", 400);
      const device = await prisma.oilFoxDevice.findUnique({ where: { id: body.deviceId } });
      if (!device || device.quantityUnit !== "L") throw new ApiError("Nur OilFox-Geräte mit Einheit Liter können zugeordnet werden.", 400);
      return jsonOk(await prisma.oilFoxDevice.update({ where: { id: device.id }, data: { tankId: body.tankId } }));
    }
    throw new ApiError("Unbekannte OilFox-Aktion.", 400);
  });
}
