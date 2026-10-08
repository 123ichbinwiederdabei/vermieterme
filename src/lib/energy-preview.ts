import { createHash } from "crypto";
import { ALLOCATION_POLICY } from "@/lib/allocation-policy";
import { prisma } from "@/lib/prisma";
import {
  allocateCents,
  calculateFifoConsumption,
  co2TenantPercent,
  daysInclusive,
  isoDay,
  prorateMonthlyCents,
  splitUnitAmountAcrossTenants,
  toScaledInteger,
} from "@/lib/energy-billing";
import {
  fromScaledInteger,
  serializeExact,
  roundFraction,
} from "@/lib/billing-v2";
import { ApiError } from "@/lib/api-utils";
import { buildSmallWastewaterPreview } from "@/lib/cost-invoice-billing";
import { buildManualCostPreview } from "@/lib/manual-cost-preview";
import {
  ELECTRICITY_DENOMINATOR,
  maxDate,
  minDate,
  meterIntervals,
  tariffStart,
  tariffEnd,
} from "@/lib/electricity-intervals";
import { invoicePool } from "@/lib/invoice-pool";
import { plantElectricity } from "@/lib/cost-invoice-billing";

export interface EnergyPreview {
  kind: "HEATING_OIL" | "ELECTRICITY" | "SMALL_WASTEWATER";
  billingPeriodId: string;
  costCategoryId: string;
  totalAmountCents: string;
  tenantAmountCents: string;
  landlordAmountCents: string;
  vacancyAmountCents: string;
  allocations: Array<{
    unitId: string;
    tenantId: string | null;
    periodStart: string;
    periodEnd: string;
    amountCents: string;
    quantity?: string;
    distributionKey: string;
    calculationBasis: string;
    sourceType: string;
    sourceReferenceId?: string;
  }>;
  details: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
  sourceFingerprint: string;
  sourceData?: unknown;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(serializeExact(value)))
    .digest("hex");
}

function boundaryReading<
  T extends {
    readingDate: Date;
    quantityLiters: unknown;
    validationError?: string | null;
  },
>(readings: T[], target: Date) {
  // A nearby OilFox measurement is useful information, but it is not an
  // accounting boundary.  The user must enter/select a documented fallback.
  return readings
    .filter(
      (row) =>
        row.quantityLiters != null &&
        !row.validationError &&
        isoDay(row.readingDate) === isoDay(target),
    )
    .sort(
      (a, b) =>
        Math.abs(a.readingDate.getTime() - target.getTime()) -
        Math.abs(b.readingDate.getTime() - target.getTime()),
    )[0];
}

function dateInside(value: Date, start: Date, end: Date): boolean {
  return value >= start && value <= end;
}

function hasFinancialCoverage(
  tenant: {
    moveInDate: Date;
    moveOutDate: Date | null;
    financialPeriods: Array<{ validFrom: Date; validTo: Date | null }>;
  },
  start: Date,
  end: Date,
) {
  const tenancyStart = tenant.moveInDate > start ? tenant.moveInDate : start;
  const tenancyEnd =
    (tenant.moveOutDate ?? end) < end ? (tenant.moveOutDate ?? end) : end;
  if (tenancyEnd < tenancyStart) return true;
  const periods = tenant.financialPeriods
    .map((row) => ({
      start: row.validFrom > tenancyStart ? row.validFrom : tenancyStart,
      end:
        (row.validTo ?? tenancyEnd) < tenancyEnd
          ? (row.validTo ?? tenancyEnd)
          : tenancyEnd,
    }))
    .filter((row) => row.end >= row.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  let expected = tenancyStart.getTime();
  for (const row of periods) {
    if (row.start.getTime() > expected) return false;
    expected = Math.max(expected, row.end.getTime() + 86_400_000);
  }
  return expected > tenancyEnd.getTime();
}

export async function buildHeatingOilPreview(
  billingPeriodId: string,
  costCategoryId: string,
): Promise<EnergyPreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: {
        include: {
          units: {
            include: {
              tenants: {
                include: {
                  financialPeriods: { where: { supersededAt: null } },
                },
              },
            },
          },
          heatingSystems: {
            include: {
              units: true,
              tanks: {
                include: {
                  stockReadings: true,
                  inventoryLots: {
                    // Revisions of this billing period must start from the
                    // same inventory state as the original preview.  Its own
                    // active snapshot is superseded only after Apply.
                    include: {
                      consumptions: {
                        where: {
                          active: true,
                          snapshot: {
                            billingPeriodId: { not: billingPeriodId },
                            billingPeriod: {
                              OR: [
                                { id: billingPeriodId },
                                {
                                  copies: {
                                    none: {
                                      id: billingPeriodId,
                                      revisionOfPeriodId: { not: null },
                                    },
                                  },
                                },
                              ],
                            },
                            activeHead: { isNot: null },
                          },
                        },
                      },
                    },
                  },
                  deliveries: { where: { revisions: { none: {} } } },
                  deliveryCandidates: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const system = period.property.heatingSystems[0];
  if (!system)
    throw new ApiError("Für das Objekt ist kein Heizsystem konfiguriert", 400);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (system.centralHotWater)
    blockers.push("Zentrale Warmwasserabrechnung ist derzeit deaktiviert.");
  if (system.billingRegime === "STANDARD_HEIZKOSTENV")
    blockers.push(
      "Standard-Heizkostenabrechnung bleibt bis zur implementierten Wärmeverbrauchsberechnung gesperrt.",
    );
  if (
    system.billingRegime !== "STANDARD_HEIZKOSTENV" &&
    !system.evidenceValidatedAt
  )
    blockers.push(
      "Heizkostennachweis muss ausdrücklich geprüft und bestätigt sein.",
    );
  if (system.billingRegime === "SECTION_11_EXCEPTION") {
    if (
      !system.exceptionReason?.trim() ||
      !["TECHNICALLY_IMPOSSIBLE", "UNECONOMIC", "OTHER_STATUTORY"].includes(
        system.exceptionReasonCode ?? "",
      ) ||
      !system.exceptionDocumentId ||
      !system.exceptionValidFrom ||
      system.exceptionValidFrom > period.startDate ||
      !system.exceptionValidTo ||
      system.exceptionValidTo < period.endDate
    )
      blockers.push(
        "§-11-Ausnahme: Grundcode, Begründung, Beleg und gültiger Zeitraum erforderlich.",
      );
  } else if (system.billingRegime === "SECTION_2_CONTRACTUAL_DEVIATION") {
    if (
      period.property.units.length > 2 ||
      !period.property.units.some(
        (unit) => unit.ownerOccupied && unit.id === system.ownerOccupiedUnitId,
      ) ||
      !system.contractualReason?.trim() ||
      !system.contractualDocumentId ||
      !system.contractualValidFrom ||
      system.contractualValidFrom > period.startDate
    )
      blockers.push(
        "§-2-Modus: Gebäude mit höchstens zwei Wohnungen, Eigentümerwohnung und Vertragsnachweis erforderlich.",
      );
  } else if (system.billingRegime !== "STANDARD_HEIZKOSTENV")
    blockers.push("Nicht unterstützter Heizkostenmodus.");
  const connectedIds = new Set(system.units.map((row) => row.unitId));
  const units = period.property.units.filter((unit) =>
    connectedIds.has(unit.id),
  );
  for (const unit of units)
    if (!unit.areaM2 || toScaledInteger(unit.areaM2.toString()) <= 0n)
      blockers.push(`Wohnfläche für ${unit.name} fehlt.`);
  for (const unit of units)
    for (const tenant of unit.tenants)
      if (!hasFinancialCoverage(tenant, period.startDate, period.endDate))
        blockers.push(
          `Miet-/NK-Finanzperioden für ${tenant.firstName} ${tenant.lastName} decken den Abrechnungszeitraum nicht lückenlos ab.`,
        );

  let totalAmount = 0n;
  let totalCo2Cost = 0n;
  let totalCo2Grams = 0n;
  const fifoRows: Array<Record<string, unknown>> = [];
  const source: Array<Record<string, unknown>> = [];

  for (const tank of system.tanks) {
    const startReading = boundaryReading(tank.stockReadings, period.startDate);
    const endReading = boundaryReading(tank.stockReadings, period.endDate);
    if (!startReading?.quantityLiters)
      blockers.push(`Valider Anfangstankstand für ${tank.name} fehlt.`);
    if (!endReading?.quantityLiters)
      blockers.push(`Valider Endtankstand für ${tank.name} fehlt.`);
    if (!startReading?.quantityLiters || !endReading?.quantityLiters) continue;
    const startGap = Math.round(
      Math.abs(
        startReading.readingDate.getTime() - period.startDate.getTime(),
      ) / 86_400_000,
    );
    const endGap = Math.round(
      Math.abs(endReading.readingDate.getTime() - period.endDate.getTime()) /
        86_400_000,
    );
    for (const reading of [startReading, endReading])
      if (
        reading.method === "DOCUMENTED_ESTIMATE" &&
        (!reading.confirmed || !reading.note?.trim() || !reading.documentId)
      )
        blockers.push(
          "Ersatz-Tankstand benötigt bestätigte Methode und Beleg.",
        );
    if (startGap > 0 || endGap > 0)
      blockers.push(
        `Die Grenzmessung für ${tank.name} muss am Abrechnungsstichtag liegen oder als Ersatzmessung dokumentiert sein.`,
      );
    if (
      tank.deliveryCandidates.some(
        (candidate) => candidate.status === "PENDING",
      )
    )
      warnings.push(`${tank.name} hat ungeklärte mögliche Lieferungen.`);
    if (
      tank.capacityLiters &&
      toScaledInteger(endReading.quantityLiters.toString()) >
        toScaledInteger(tank.capacityLiters.toString())
    )
      blockers.push(
        `Endbestand für ${tank.name} überschreitet die Tankkapazität.`,
      );
    const delivered = tank.deliveries
      .filter((delivery) =>
        dateInside(delivery.deliveryDate, period.startDate, period.endDate),
      )
      .reduce(
        (sum, delivery) =>
          sum + toScaledInteger(delivery.quantityLiters.toString()),
        0n,
      );
    const consumption =
      toScaledInteger(startReading.quantityLiters.toString()) +
      delivered -
      toScaledInteger(endReading.quantityLiters.toString());
    if (consumption < 0n) {
      blockers.push(`Der berechnete Verbrauch für ${tank.name} ist negativ.`);
      continue;
    }

    const currentLots = tank.inventoryLots.filter(
      (lot) =>
        !tank.inventoryLots.some(
          (other) =>
            (other.revisionOfId ?? other.id) === (lot.revisionOfId ?? lot.id) &&
            other.revisionNumber > lot.revisionNumber,
        ),
    );
    for (const lot of currentLots.filter(
      (lot) => lot.sourceDate <= period.endDate,
    ))
      if (!lot.co2EvidenceReference)
        blockers.push(
          `CO₂-Beleg für Bestand ${lot.id} fehlt (Null ist kein Ersatz für fehlende Daten).`,
        );
    const lots = currentLots
      .filter((lot) => lot.sourceDate <= period.endDate)
      .map((lot) => {
        const consumptions = tank.inventoryLots
          .filter(
            (other) =>
              (other.revisionOfId ?? other.id) === (lot.revisionOfId ?? lot.id),
          )
          .flatMap((other) => other.consumptions);
        const consumed = consumptions.reduce(
          (sum, row) => sum + toScaledInteger(row.quantityLiters.toString()),
          0n,
        );
        const original = toScaledInteger(lot.quantityLiters.toString());
        const remaining = original - consumed;
        const remainingAmount =
          lot.totalAmountCents -
          consumptions.reduce((sum, row) => sum + row.amountCents, 0n);
        const remainingCo2Cost =
          lot.co2CostCents -
          consumptions.reduce((sum, row) => sum + row.co2CostCents, 0n);
        const remainingCo2 =
          lot.co2Grams -
          consumptions.reduce((sum, row) => sum + row.co2Grams, 0n);
        if (
          remaining < 0n ||
          remainingAmount < 0n ||
          remainingCo2Cost < 0n ||
          remainingCo2 < 0n
        )
          blockers.push(
            "Bestandsrevision unterschreitet bereits verbrauchte Mengen/Kosten. Betroffene frühere Abrechnung zuerst revidieren.",
          );
        return {
          id: lot.id,
          sourceDate: lot.sourceDate,
          quantityLiters: fromScaledInteger(remaining),
          totalAmountCents: remainingAmount,
          co2CostCents: remainingCo2Cost,
          co2Grams: remainingCo2,
        };
      })
      .filter((lot) => toScaledInteger(lot.quantityLiters) > 0n);
    try {
      const fifo = calculateFifoConsumption(
        lots,
        fromScaledInteger(consumption),
      );
      totalAmount += fifo.totalAmountCents;
      totalCo2Cost += fifo.totalCo2CostCents;
      totalCo2Grams += fifo.totalCo2Grams;
      fifoRows.push(
        ...fifo.consumptions.map((row) => ({
          tankId: tank.id,
          tankName: tank.name,
          ...row,
        })),
      );
    } catch (error) {
      blockers.push(
        error instanceof Error
          ? `${tank.name}: ${error.message}`
          : `${tank.name}: FIFO-Berechnung fehlgeschlagen.`,
      );
    }
    source.push({
      tankId: tank.id,
      startReading,
      startGapDays: startGap,
      endReading,
      endGapDays: endGap,
      deliveredLiters: fromScaledInteger(delivered),
      physicalConsumptionLiters: fromScaledInteger(consumption),
    });
  }

  const operating = await invoicePool(
    period.propertyId,
    billingPeriodId,
    costCategoryId,
    "HEATING",
    period.startDate,
    period.endDate,
  );
  const electricity = await plantElectricity(
    period.propertyId,
    period.startDate,
    period.endDate,
    "HEATING_ELECTRICITY",
  );
  if (
    electricity.details.length &&
    operating.invoices.some((invoice) =>
      invoice.lines.some((line) => line.classification === "BETRIEBSSTROM"),
    )
  )
    blockers.push(
      "Heizungsstrom darf nicht gleichzeitig als Rechnung und Zählerverbrauch berechnet werden.",
    );
  blockers.push(...operating.blockers, ...electricity.blockers);
  totalAmount +=
    operating.eligible + operating.excluded + electricity.amountCents;
  const totalArea = units.reduce(
    (sum, unit) => sum + toScaledInteger(unit.areaM2?.toString() ?? "0"),
    0n,
  );
  const tenantPercent = co2TenantPercent(
    totalCo2Grams,
    fromScaledInteger(totalArea),
    daysInclusive(period.startDate, period.endDate),
  );
  const landlordCo2 = (totalCo2Cost * BigInt(100 - tenantPercent) + 50n) / 100n;
  const allocatable = totalAmount - landlordCo2 - operating.excluded;
  const unitAmounts = allocateCents(
    allocatable,
    units.map((unit) => toScaledInteger(unit.areaM2?.toString() ?? "0")),
  );
  const allocations: EnergyPreview["allocations"] = [];
  let vacancy = 0n;
  units.forEach((unit, index) => {
    const split = splitUnitAmountAcrossTenants(
      unitAmounts[index],
      unit.id,
      unit.tenants,
      period.startDate,
      period.endDate,
      {
        distributionKey: "AREA",
        calculationBasis: `${unit.areaM2?.toString() ?? "0"} m² von ${fromScaledInteger(totalArea)} m²`,
        sourceType: "HEATING_OIL",
        sourceReferenceId: system.id,
      },
    );
    allocations.push(...split.allocations);
    vacancy += split.vacancyCents;
  });
  const tenantAmount = allocations.reduce(
    (sum, row) => sum + BigInt(row.amountCents),
    0n,
  );
  const sourceData = {
    system,
    source,
    fifoRows,
    operating: operating.invoices,
    electricity,
    units,
  };
  const sourceFingerprint = fingerprint(sourceData);
  return {
    kind: "HEATING_OIL",
    billingPeriodId,
    costCategoryId,
    totalAmountCents: totalAmount.toString(),
    tenantAmountCents: tenantAmount.toString(),
    landlordAmountCents: (
      landlordCo2 +
      vacancy +
      operating.excluded
    ).toString(),
    vacancyAmountCents: vacancy.toString(),
    allocations,
    details: {
      fifoRows,
      operatingInvoices: serializeExact(operating.details),
      plantElectricity: serializeExact(electricity.details),
      totalAreaM2: fromScaledInteger(totalArea),
      periodDays: daysInclusive(period.startDate, period.endDate),
      co2CostCents: totalCo2Cost.toString(),
      co2Grams: totalCo2Grams.toString(),
      co2TenantPercent: tenantPercent,
      landlordCo2Cents: landlordCo2.toString(),
    },
    blockers,
    warnings,
    sourceFingerprint,
    sourceData: serializeExact(sourceData),
  };
}

export async function buildElectricityPreview(
  billingPeriodId: string,
  costCategoryId: string,
): Promise<EnergyPreview> {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: billingPeriodId },
    include: {
      property: {
        include: {
          units: { include: { tenants: true } },
          electricityContracts: {
            include: { tariffs: true, meters: { include: { readings: true } } },
          },
        },
      },
    },
  });
  if (!period) throw new ApiError("Abrechnungszeitraum nicht gefunden", 404);
  const invoiceSource = await invoicePool(
    period.propertyId,
    billingPeriodId,
    costCategoryId,
    "ELECTRICITY",
    period.startDate,
    period.endDate,
  );
  const blockers: string[] = [...invoiceSource.blockers];
  const warnings: string[] = [];
  const allocations: EnergyPreview["allocations"] = [];
  const variable: Array<{
    numerator: bigint;
    unitId: string;
    tenantId: string | null;
    start: string;
    end: string;
    quantity: string;
    basis: string;
  }> = [];
  const intervalDetails: unknown[] = [];
  let fixedOwner = 0n;
  let totalBase = 0n;
  const units = period.property.units;
  for (const contract of period.property.electricityContracts) {
    const start = maxDate(
      period.startDate,
      contract.validFrom ?? period.startDate,
    );
    const end = minDate(period.endDate, contract.validTo ?? period.endDate);
    if (end < start) continue;
    const meters = contract.meters.filter(
      (meter) =>
        ["UNIT_CONSUMPTION", "COMMON_ELECTRICITY"].includes(meter.role) &&
        (meter.validFrom ?? start) <= end &&
        (!meter.validTo || meter.validTo >= start),
    );
    if (!meters.length) continue;
    const consumption = new Map<string, bigint>();
    for (const meter of meters) {
      const unit = units.find((unit) => unit.id === meter.unitId);
      if (meter.role === "UNIT_CONSUMPTION" && !unit) {
        blockers.push(
          `Wohnungszuordnung für Zähler ${meter.meterNumber} fehlt.`,
        );
        continue;
      }
      const result = meterIntervals(
        contract,
        meter,
        start,
        end,
        unit?.tenants ?? [],
      );
      blockers.push(...result.blockers);
      intervalDetails.push(...serializeExact(result.intervals));
      for (const row of result.intervals) {
        if (meter.role === "UNIT_CONSUMPTION") {
          consumption.set(
            unit!.id,
            (consumption.get(unit!.id) ?? 0n) +
              toScaledInteger(row.consumptionKwh),
          );
          variable.push({
            numerator: row.numerator,
            unitId: unit!.id,
            tenantId: row.tenantId,
            start: row.start,
            end: row.end,
            quantity: row.consumptionKwh,
            basis: `${row.consumptionKwh} kWh · Zähler ${row.meterNumber} · ${row.priceMicroEuroPerKwh} µ€/kWh${row.fallbackNotes ? ` · Ersatzablesung: ${row.fallbackNotes}` : ""}`,
          });
        } else {
          if (
            row.numerator > 0n &&
            units.every(
              (unit) => toScaledInteger(unit.areaM2?.toString() ?? "0") === 0n,
            )
          ) {
            blockers.push("Wohnflächen für Allgemeinstrom fehlen.");
            continue;
          }
          const shares = allocateCents(
            row.numerator,
            units.map((unit) =>
              toScaledInteger(unit.areaM2?.toString() ?? "0"),
            ),
          );
          units.forEach((unit, i) => {
            const split = splitUnitAmountAcrossTenants(
              shares[i],
              unit.id,
              unit.tenants,
              new Date(row.start),
              new Date(row.end),
              {
                distributionKey: "AREA",
                calculationBasis:
                  "Allgemeinstrom nach Wohnfläche und Belegungstagen",
                sourceType: "ELECTRICITY",
              },
            );
            for (const allocation of split.allocations)
              variable.push({
                numerator: BigInt(allocation.amountCents),
                unitId: unit.id,
                tenantId: allocation.tenantId,
                start: allocation.periodStart,
                end: allocation.periodEnd,
                quantity: "0",
                basis: allocation.calculationBasis,
              });
            variable.push({
              numerator: split.vacancyCents,
              unitId: unit.id,
              tenantId: null,
              start: row.start,
              end: row.end,
              quantity: "0",
              basis: "Eigentümer/Leerstand Allgemeinstrom",
            });
          });
        }
      }
    }
    let contractBase = 0n;
    const tariffs = contract.tariffs.filter(
      (tariff) => tariffStart(tariff) <= end && tariffEnd(tariff, end) >= start,
    );
    let cursor = start;
    for (const tariff of [...tariffs].sort(
      (a, b) => tariffStart(a).getTime() - tariffStart(b).getTime(),
    )) {
      const a = maxDate(start, tariffStart(tariff));
      const b = minDate(end, tariffEnd(tariff, end));
      if (a.getTime() !== cursor.getTime())
        blockers.push(
          `Grundpreis: Tariflücke/Überlappung für ${contract.provider}.`,
        );
      contractBase += prorateMonthlyCents(tariff.monthlyBasePriceCents, a, b);
      cursor = new Date(b.getTime() + 86_400_000);
    }
    if (cursor <= end)
      blockers.push(`Grundpreis: Tarifdeckung für ${contract.provider} fehlt.`);
    totalBase += contractBase;
    if (contractBase > 0n && !contract.basePriceAgreementNote?.trim())
      blockers.push("Vereinbarung zum Strom-Grundpreisschlüssel fehlt.");
    const billable = units.filter((unit) =>
      meters.some(
        (meter) =>
          meter.unitId === unit.id && meter.role === "UNIT_CONSUMPTION",
      ),
    );
    const weights =
      contract.basePriceAllocation === "EQUAL_PER_UNIT"
        ? billable.map(() => 1n)
        : billable.map((unit) => consumption.get(unit.id) ?? 0n);
    if (contractBase > 0n && weights.every((weight) => weight === 0n)) {
      blockers.push(
        "Grundpreis bei Nullverbrauch: vereinbarten Ersatzschlüssel dokumentieren.",
      );
      fixedOwner += contractBase;
      continue;
    }
    const shares = allocateCents(contractBase, weights);
    billable.forEach((unit, i) => {
      const split = splitUnitAmountAcrossTenants(
        shares[i],
        unit.id,
        unit.tenants,
        start,
        end,
        {
          distributionKey: contract.basePriceAllocation,
          calculationBasis: `Grundpreis · ${contract.basePriceAllocation} · Belegungstage`,
          sourceType: "ELECTRICITY",
        },
      );
      allocations.push(
        ...split.allocations.filter((row) => BigInt(row.amountCents) !== 0n),
      );
      fixedOwner += split.vacancyCents;
    });
  }
  // Accumulate micro-euro products across every interval before final cents.
  const numerator = variable.reduce((sum, row) => sum + row.numerator, 0n);
  const totalVariable = roundFraction(numerator, ELECTRICITY_DENOMINATOR);
  const shares = allocateCents(
    totalVariable,
    variable.map((row) => row.numerator),
  );
  let owner = fixedOwner;
  variable.forEach((row, i) => {
    if (!row.tenantId) {
      owner += shares[i];
      return;
    }
    if (shares[i] === 0n) return;
    allocations.push({
      unitId: row.unitId,
      tenantId: row.tenantId,
      periodStart: row.start,
      periodEnd: row.end,
      amountCents: shares[i].toString(),
      quantity: row.quantity,
      distributionKey: "DIRECT_CONSUMPTION",
      calculationBasis: row.basis,
      sourceType: "ELECTRICITY",
    });
  });
  const tenantAmount = allocations.reduce(
    (sum, row) => sum + BigInt(row.amountCents),
    0n,
  );
  const sourceData = {
    invoices: invoiceSource.invoices,
    contracts: period.property.electricityContracts,
    units,
    intervalDetails,
    period: [isoDay(period.startDate), isoDay(period.endDate)],
  };
  return {
    kind: "ELECTRICITY",
    billingPeriodId,
    costCategoryId,
    totalAmountCents: (totalVariable + totalBase).toString(),
    tenantAmountCents: tenantAmount.toString(),
    landlordAmountCents: owner.toString(),
    vacancyAmountCents: owner.toString(),
    allocations,
    details: { intervalDetails, basePriceCents: totalBase.toString() },
    blockers,
    warnings,
    sourceFingerprint: fingerprint(sourceData),
    sourceData: serializeExact(sourceData),
  };
}

export async function buildEnergyPreview(
  kind: string,
  billingPeriodId: string,
  costCategoryId: string,
) {
  const category = await prisma.costCategory.findUnique({
    where: { id: costCategoryId },
  });
  if (!category) throw new ApiError("Kostenart nicht gefunden", 404);
  const expected =
    category.calculationType === "HEATING_OIL"
      ? "HEATING_OIL"
      : category.calculationType === "ELECTRICITY"
        ? "ELECTRICITY"
        : category.code === "WASTEWATER" ||
            category.name.includes("Kleinkläranlage")
          ? "SMALL_WASTEWATER"
          : "MANUAL";
  if (kind !== expected)
    throw new ApiError("Berechnungsart passt nicht zur Kostenart", 400);
  const preview =
    kind === "HEATING_OIL"
      ? await buildHeatingOilPreview(billingPeriodId, costCategoryId)
      : kind === "ELECTRICITY"
        ? await buildElectricityPreview(billingPeriodId, costCategoryId)
        : kind === "SMALL_WASTEWATER"
          ? await buildSmallWastewaterPreview(billingPeriodId, costCategoryId)
          : await buildManualCostPreview(billingPeriodId, costCategoryId);
  const sourceData = { inputs: preview.sourceData, policy: ALLOCATION_POLICY };
  return { ...preview, sourceData, sourceFingerprint: fingerprint(sourceData) };
}
