import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { centsToEuro } from "@/lib/money";
import { fromScaledInteger, toScaledInteger } from "@/lib/billing-v2";
import type { TenantStatement } from "@/lib/billing-statement";

const styles = StyleSheet.create({
  page: { padding: 38, fontSize: 9, color: "#27272a" },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 6 },
  subtitle: { color: "#71717a", marginBottom: 18 },
  section: { marginTop: 16 },
  heading: { fontSize: 12, fontWeight: 700, marginBottom: 7, color: "#991b1b" },
  row: {
    display: "flex",
    flexDirection: "row",
    borderBottom: "1px solid #e4e4e7",
    paddingVertical: 5,
  },
  name: { width: "46%" },
  amount: { width: "18%", textAlign: "right" },
  total: { fontWeight: 700, backgroundColor: "#f4f4f5" },
  note: { marginTop: 5, color: "#52525b", lineHeight: 1.4 },
});

function StatementPage({ statement }: { statement: TenantStatement }) {
  const heating = statement.heatingDetails as {
    fifoRows?: Array<{ consumedLiters?: string; amountCents?: string }>;
    co2Grams?: string;
    landlordCo2Cents?: string;
    co2CostCents?: string;
    co2TenantPercent?: number;
    totalAreaM2?: string;
    periodDays?: number;
  } | null;
  const consumedLiters = heating?.fifoRows?.reduce(
    (sum, row) => sum + toScaledInteger(row.consumedLiters || "0"),
    0n,
  );
  return (
    <Page size="A4" style={styles.page}>
      <Text style={styles.title}>
        {statement.draft
          ? "Entwurf · Betriebskostenabrechnung"
          : "Betriebskostenabrechnung"}
      </Text>
      <Text style={styles.subtitle}>
        {statement.property.street}, {statement.property.zip}{" "}
        {statement.property.city} · {statement.unit.name} ·{" "}
        {statement.startDate} bis {statement.endDate}
      </Text>
      <Text>
        {statement.tenant.salutation} {statement.tenant.firstName}{" "}
        {statement.tenant.lastName}
      </Text>
      <View style={styles.section}>
        <Text style={styles.heading}>Kostenartenvergleich</Text>
        <View style={styles.row}>
          <Text style={styles.name}>Kostenart</Text>
          <Text style={styles.amount}>Anteil</Text>
          <Text style={styles.amount}>Vorauszahlung</Text>
          <Text style={styles.amount}>Differenz</Text>
        </View>
        {statement.categories.map((row) => (
          <View key={row.id} style={styles.row}>
            <Text style={styles.name}>{row.name}</Text>
            <Text style={styles.amount}>{centsToEuro(row.actualCents)}</Text>
            <Text style={styles.amount}>
              {centsToEuro(row.prepaymentCents)}
            </Text>
            <Text style={styles.amount}>
              {centsToEuro(row.differenceCents)}
            </Text>
          </View>
        ))}
        <View style={[styles.row, styles.total]}>
          <Text style={styles.name}>Gesamt</Text>
          <Text style={styles.amount}>
            {centsToEuro(statement.totalActualCents)}
          </Text>
          <Text style={styles.amount}>
            {centsToEuro(statement.totalPrepaymentCents)}
          </Text>
          <Text style={styles.amount}>
            {centsToEuro(statement.balanceCents)}
          </Text>
        </View>
      </View>
      <View style={styles.section}>
        <Text style={styles.heading}>Berechnungsgrundlagen</Text>
        {statement.categories.map((category) => (
          <View key={category.id} style={{ marginBottom: 6 }}>
            <Text>{category.name}</Text>
            {category.allocations.map((allocation, index) => (
              <Text key={index} style={styles.note}>
                {allocation.periodStart} bis {allocation.periodEnd}:{" "}
                {allocation.calculationBasis} ·{" "}
                {centsToEuro(allocation.amountCents)}
              </Text>
            ))}
          </View>
        ))}
      </View>
      {heating && (
        <View style={styles.section}>
          <Text style={styles.heading}>Heizölberechnung</Text>
          <Text style={styles.note}>
            Verbrauchtes Heizöl:{" "}
            {consumedLiters == null
              ? "—"
              : `${fromScaledInteger(consumedLiters)} L`}
            . Die Bewertung erfolgt nach FIFO anhand der bestätigten
            Anfangsbestände und Lieferungen.
          </Text>
          <Text style={styles.note}>
            CO₂-Ausstoß: {heating.co2Grams || "0"} g · Fläche:{" "}
            {heating.totalAreaM2} m² · Zeitraum: {heating.periodDays} Tage ·
            Stufe: Mieter {heating.co2TenantPercent}% / Vermieter{" "}
            {100 - (heating.co2TenantPercent ?? 100)}% · CO₂-Gesamtkosten:{" "}
            {centsToEuro(heating.co2CostCents || "0")} · Vermieterabzug:{" "}
            {centsToEuro(heating.landlordCo2Cents || "0")} · CO₂-Mieteranteil:{" "}
            {centsToEuro(
              BigInt(heating.co2CostCents || "0") -
                BigInt(heating.landlordCo2Cents || "0"),
            )}
          </Text>
        </View>
      )}
      <View style={styles.section}>
        <Text style={styles.heading}>Ergebnis</Text>
        <Text style={{ fontSize: 14, fontWeight: 700 }}>
          {BigInt(statement.balanceCents) > 0n
            ? `Nachzahlung ${centsToEuro(statement.balanceCents)}`
            : BigInt(statement.balanceCents) < 0n
              ? `Erstattung ${centsToEuro(-BigInt(statement.balanceCents))}`
              : "Ausgeglichen"}
        </Text>
      </View>
    </Page>
  );
}

export function BillingV2Pdf({
  statements,
}: {
  statements: TenantStatement[];
}) {
  return (
    <Document
      title="Betriebskostenabrechnung"
      creationDate={
        new Date(`${statements[0]?.endDate || "2000-01-01"}T00:00:00Z`)
      }
      modificationDate={
        new Date(`${statements[0]?.endDate || "2000-01-01"}T00:00:00Z`)
      }
    >
      {statements.map((statement) => (
        <StatementPage key={statement.tenant.id} statement={statement} />
      ))}
    </Document>
  );
}

export function ExternalBillingClosingPdf({
  closing,
}: {
  closing: {
    property: { street: string; zip: string; city: string };
    closingDate: Date;
    note: string | null;
    tenants: Array<{
      tenant: {
        salutation: string;
        firstName: string;
        lastName: string;
        unit: { name: string };
      };
    }>;
  };
}) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Abrechnungsabschluss - extern erledigt</Text>
        <Text style={styles.subtitle}>
          {closing.property.street}, {closing.property.zip}{" "}
          {closing.property.city}
        </Text>
        <View style={styles.section}>
          <Text style={styles.heading}>Dokumentierter Abschluss</Text>
          <Text style={styles.note}>
            Die Betriebskostenabrechnung bis einschließlich{" "}
            {closing.closingDate.toLocaleDateString("de-DE")} wurde extern
            erledigt. Dieses Dokument hält ausschließlich den Abschlussmarker
            fest und enthält bewusst keine nachträglich erfundenen Kosten,
            Vorauszahlungen oder einen nicht belegten Beginn.
          </Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.heading}>Betroffene Mietverhältnisse</Text>
          {closing.tenants.map(({ tenant }) => (
            <Text
              key={`${tenant.firstName}-${tenant.lastName}`}
              style={styles.note}
            >
              {tenant.salutation} {tenant.firstName} {tenant.lastName} -{" "}
              {tenant.unit.name}
            </Text>
          ))}
        </View>
        {closing.note && (
          <View style={styles.section}>
            <Text style={styles.heading}>Hinweis</Text>
            <Text style={styles.note}>{closing.note}</Text>
          </View>
        )}
      </Page>
    </Document>
  );
}
