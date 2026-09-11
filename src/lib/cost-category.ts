import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-utils";

const calculationTypes = ["MANUAL", "HEATING_OIL", "ELECTRICITY"] as const;

export async function validateCalculationType(calculationType: string, exceptId?: string) {
  if (!calculationTypes.includes(calculationType as (typeof calculationTypes)[number])) {
    throw new ApiError("Ungültige Berechnungsart", 400);
  }
  if (calculationType === "MANUAL") return;
  const duplicate = await prisma.costCategory.findFirst({
    where: { calculationType, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (duplicate) {
    const label = calculationType === "HEATING_OIL" ? "Heizöl" : "Strom";
    throw new ApiError(`Es darf nur eine automatische Kostenart für ${label} geben.`, 409);
  }
}
