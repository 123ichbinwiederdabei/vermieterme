import { randomUUID } from "node:crypto";
import {
  apiHandler,
  requireAuth,
  jsonOk,
  jsonCreated,
  ApiError,
} from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { requiredString } from "@/lib/billing-v2-input";
import { validateRules } from "@/lib/invoice-extraction";
import {
  categoryCode,
  INVOICE_SECTIONS,
  LINE_CLASSES,
} from "@/lib/invoice-categories";

export function GET(request: Request) {
  return apiHandler(async () => {
    await requireAuth();
    const categoryId = new URL(request.url).searchParams.get("costCategoryId");
    return jsonOk(
      await prisma.invoiceTemplate.findMany({
        where: categoryId ? { costCategoryId: categoryId } : {},
        orderBy: [{ name: "asc" }, { version: "desc" }],
      }),
    );
  });
}
export function POST(request: Request) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const body = await request.json();
    const category = await prisma.costCategory.findUnique({
      where: { id: body.costCategoryId },
    });
    if (!category) throw new ApiError("Kostenart fehlt", 404);
    if (
      !(INVOICE_SECTIONS[categoryCode(category)] ?? []).includes(body.section)
    )
      throw new ApiError("Vorlagenabschnitt ist ungültig", 400);
    try {
      validateRules(body.rules);
    } catch (e) {
      throw new ApiError(
        e instanceof Error ? e.message : "Ungültige Regeln",
        400,
      );
    }
    if (
      body.rules.table &&
      !LINE_CLASSES.includes(body.rules.table.classification)
    )
      throw new ApiError("Ungültige Tabellenklassifikation", 400);
    if (
      !Array.isArray(body.markers) ||
      !body.markers.length ||
      body.markers.length > 12 ||
      body.markers.some(
        (m: unknown) => typeof m !== "string" || !m.trim() || m.length > 200,
      )
    )
      throw new ApiError(
        "Mindestens ein eindeutiges Erkennungsmerkmal erforderlich",
        400,
      );
    let seriesId: string = randomUUID();
    let version = 1;
    if (body.revisionOfId) {
      const previous = await prisma.invoiceTemplate.findUnique({
        where: { id: body.revisionOfId },
      });
      if (
        !previous ||
        previous.costCategoryId !== category.id ||
        previous.section !== body.section
      )
        throw new ApiError("Vorlagenrevision passt nicht", 400);
      seriesId = previous.seriesId;
      const latest = await prisma.invoiceTemplate.findFirst({
        where: { seriesId },
        orderBy: { version: "desc" },
      });
      version = (latest?.version ?? 0) + 1;
    }
    return jsonCreated(
      await prisma.invoiceTemplate.create({
        data: {
          seriesId,
          version,
          costCategoryId: category.id,
          section: body.section,
          name: requiredString(body.name, "Vorlagenname"),
          supplier: requiredString(body.supplier, "Lieferant"),
          rulesJson: JSON.stringify(body.rules),
          markersJson: JSON.stringify(body.markers),
          createdBy: session.user.id,
        },
      }),
    );
  });
}
