import { prisma } from "@/lib/prisma";
import { apiHandler, requireAuth, jsonOk } from "@/lib/api-utils";

export function PUT(
  request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> }
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    const body = await request.json();
    const { propertyId, name, floor, shares, areaM2, ownerOccupied } = body;

    const unit = await prisma.unit.update({
      where: { id },
      data: {
        propertyId,
        name,
        floor,
        shares,
        areaM2: areaM2 === "" ? null : areaM2,
        ownerOccupied: ownerOccupied === true,
      },
    });

    return jsonOk(unit);
  });
}

export function DELETE(
  _request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> }
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    await prisma.unit.delete({
      where: { id },
    });

    return jsonOk({ success: true });
  });
}
