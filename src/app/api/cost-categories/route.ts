import { prisma } from "@/lib/prisma";
import { apiHandler, requireAuth, jsonOk, jsonCreated } from "@/lib/api-utils";
import { validateCalculationType } from "@/lib/cost-category";

export function GET() {
  return apiHandler(async () => {
    await requireAuth();
    const categories = await prisma.costCategory.findMany({
      orderBy: { sortOrder: "asc" },
    });

    return jsonOk(categories);
  });
}

export function POST(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const body = await request.json();
    const { name, distributionKey, sortOrder, calculationType } = body;
    const normalizedCalculationType = calculationType || "MANUAL";
    await validateCalculationType(normalizedCalculationType);

    const category = await prisma.costCategory.create({
      data: {
        name,
        distributionKey,
        sortOrder,
        calculationType: normalizedCalculationType,
      },
    });

    return jsonCreated(category);
  });
}
