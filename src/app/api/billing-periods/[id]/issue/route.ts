import {
  apiHandler,
  requireAuth,
  jsonCreated,
  ApiError,
} from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { assertDraftPeriod } from "@/lib/billing-freshness";
import { buildTenantStatement } from "@/lib/billing-statement";
import { buildEnergyPreview } from "@/lib/energy-preview";
import { BILLING_CATEGORIES, categoryCode } from "@/lib/invoice-categories";

export function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return apiHandler(async () => {
    const session = await requireAuth();
    const { id } = await params;
    const draft = await assertDraftPeriod(id);
    const period = await prisma.billingPeriod.findUnique({
      where: { id },
      include: {
        calculationHeads: { include: { snapshot: true } },
        property: { include: { units: { include: { tenants: true } } } },
      },
    });
    if (!period) throw new ApiError("Abrechnung fehlt", 404);
    const categories = await prisma.costCategory.findMany();
    for (const required of BILLING_CATEGORIES) {
      const category = categories.find(
        (category) => categoryCode(category) === required.code,
      );
      if (
        !category ||
        !period.calculationHeads.some(
          (head) => head.costCategoryId === category.id,
        )
      )
        throw new ApiError(
          `${required.name}: Berechnung oder bestätigte Nullkosten fehlen`,
          409,
        );
    }
    for (const head of period.calculationHeads) {
      const preview = await buildEnergyPreview(
        head.snapshot.kind,
        id,
        head.costCategoryId,
      );
      if (
        head.stale ||
        preview.blockers.length ||
        preview.sourceFingerprint !== head.snapshot.sourceFingerprint
      )
        throw new ApiError(
          "Kostenberechnung veraltet oder unvollständig. Neu berechnen.",
          409,
        );
    }
    const tenants = period.property.units.flatMap((unit) =>
      unit.tenants.filter(
        (tenant) =>
          tenant.moveInDate <= period.endDate &&
          (!tenant.moveOutDate || tenant.moveOutDate >= period.startDate),
      ),
    );
    if (!tenants.length)
      throw new ApiError("Keine Mietverhältnisse im Zeitraum", 400);
    const statements = await Promise.all(
      tenants.map((tenant) =>
        buildTenantStatement(id, tenant.id, { draft: true, forIssue: true }),
      ),
    );
    return jsonCreated(
      await prisma.$transaction(async (tx) => {
        const current = await tx.billingPeriod.findUnique({
          where: { id },
          include: { calculationHeads: true, statementRevisions: true },
        });
        if (
          !current ||
          current.updatedAt.getTime() !== draft.updatedAt.getTime() ||
          current.sourceRevision !== draft.sourceRevision ||
          current.calculationHeads.length !== period.calculationHeads.length ||
          current.statementRevisions.length ||
          current.calculationHeads.some(
            (head) =>
              head.stale ||
              !period.calculationHeads.some(
                (old) => old.snapshotId === head.snapshotId,
              ),
          )
        )
          throw new ApiError(
            "Abrechnung wurde zwischenzeitlich verändert",
            409,
          );
        for (const statement of statements) {
          const previous = period.revisionOfPeriodId
            ? await tx.statementRevision.findFirst({
                where: {
                  billingPeriodId: period.revisionOfPeriodId,
                  tenantId: statement.tenant.id,
                },
                orderBy: { revision: "desc" },
              })
            : null;
          await tx.statementRevision.create({
            data: {
              billingPeriodId: id,
              tenantId: statement.tenant.id,
              revision: 1,
              revisionOfId: previous?.id ?? null,
              reason: period.revisionReason,
              payloadJson: JSON.stringify(statement),
              snapshotIdsJson: JSON.stringify(
                period.calculationHeads.map((head) => head.snapshotId),
              ),
              issuedBy: session.user.id,
            },
          });
        }
        await tx.billingPeriod.update({
          where: { id },
          data: { billingDate: new Date() },
        });
        return statements;
      }),
    );
  });
}
