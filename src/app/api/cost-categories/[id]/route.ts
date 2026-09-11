import { prisma } from "@/lib/prisma";
import { apiHandler, requireAuth, jsonOk } from "@/lib/api-utils";
import { validateCalculationType } from "@/lib/cost-category";

export function PUT(
  request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> }
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    const body = await request.json();
    const { name, distributionKey, sortOrder, calculationType } = body;
    const normalizedCalculationType = calculationType || "MANUAL";
    await validateCalculationType(normalizedCalculationType, id);

    const category = await prisma.costCategory.update({
      where: { id },
      data: {
        name,
        distributionKey,
        sortOrder,
        calculationType: normalizedCalculationType,
      },
    });

    return jsonOk(category);
  });
}

export function DELETE(
  _request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string }> }
) {
  return apiHandler(async () => {
    await requireAuth();
    const { id } = await paramsPromise;
    await prisma.costCategory.delete({
      where: { id },
    });

    return jsonOk({ success: true });
  });
}
