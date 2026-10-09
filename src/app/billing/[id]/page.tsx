"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/nav";
import { Loading } from "@/components/ui/loading";
import {
  CategoryInvoices,
  invoiceInputClass,
} from "@/components/category-invoices";
import { centsToEuro } from "@/lib/money";
import type { TenantStatement } from "@/lib/billing-statement";

type Preview = {
  totalAmountCents: string;
  tenantAmountCents: string;
  landlordAmountCents: string;
  vacancyAmountCents: string;
  blockers: string[];
  warnings: string[];
  allocations: {
    unitId: string;
    tenantId: string | null;
    amountCents: string;
    calculationBasis: string;
  }[];
};
type Category = {
  id: string;
  code: string;
  label: string;
  kind: string;
  stale: boolean;
  preview: Preview | null;
};
type Workspace = {
  period: {
    id: string;
    startDate: string;
    endDate: string;
    property: {
      street: string;
      zip: string;
      city: string;
      electricityContracts: { id: string; provider: string }[];
      heatingSystems: { tanks: { id: string; name: string }[] }[];
    };
    statementRevisions: { id: string; revision: number }[];
  };
  categories: Category[];
  statements: {
    tenantId: string;
    statement: TenantStatement | null;
    error: string | null;
  }[];
  locked: boolean;
};
const button =
  "rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50";
const descriptions: Record<string, string> = {
  HEATING:
    "FIFO-Tankverbrauch, Heizungsbetrieb und dokumentierter Heizkostenmodus",
  ELECTRICITY:
    "Zwischenzähler, Tarifintervalle und vereinbarter Grundpreisschlüssel",
  WATER: "Tatsächliche Rechnung einschließlich Grundgebühr · 80/200/110 m²",
  WASTE: "Tatsächliche Gebühren · jeweils ein Drittel",
  WASTEWATER:
    "Laufender Betrieb und Anlagenstrom · jeweils ein Drittel · keine Reparaturen",
  PROPERTY_TAX:
    "Belegter Wohnanteil ausschließlich der beiden Mietwohnungen · 80/200 m²",
};
export default function BillingPeriodPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [zeroReasons, setZeroReasons] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/billing-periods/${id}/workspace`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setWorkspace(data);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Abrechnung konnte nicht geladen werden",
      );
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  async function calculate(category: Category, apply = false) {
    setBusy(category.id);
    setMessage("");
    try {
      const response = await fetch(
        `/api/billing-periods/${id}/energy-preview${apply ? "" : `?kind=${category.kind}&costCategoryId=${category.id}`}`,
        apply
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                kind: category.kind,
                costCategoryId: category.id,
                zeroReason: zeroReasons[category.id],
              }),
            }
          : undefined,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (apply) {
        setMessage("Berechnung als unveränderliche Revision übernommen");
        await load();
      } else setPreviews({ ...previews, [category.id]: data });
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Berechnung fehlgeschlagen",
      );
    } finally {
      setBusy(null);
    }
  }
  async function revise() {
    const reason = window.prompt("Korrekturgrund");
    if (!reason) return;
    const response = await fetch(`/api/billing-periods/${id}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const data = await response.json();
    if (response.ok) window.location.href = `/billing/${data.id}`;
    else setMessage(data.error);
  }
  async function cutover() {
    const response = await fetch(`/api/billing-periods/${id}/cutover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: "2026-10-01", dryRun: true }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error);
      return;
    }
    const reason = window.prompt(
      `Stichtagsaufteilung: bisheriger Zeitraum bis ${data.previousEnd.slice(0, 10)}, neuer Zeitraum ${data.newStart.slice(0, 10)} bis ${data.newEnd.slice(0, 10)}. Begründung eingeben; Grenzablesungen sind anschließend erforderlich.`,
    );
    if (!reason) return;
    const saved = await fetch(`/api/billing-periods/${id}/cutover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: "2026-10-01", dryRun: false, reason }),
    });
    const result = await saved.json();
    if (saved.ok) window.location.href = `/billing/${result.id}`;
    else setMessage(result.error);
  }
  async function issue() {
    window.location.href = `/workflow?billingPeriodId=${id}`;
  }
  if (!workspace)
    return (
      <>
        <Nav />
        <main className="mx-auto max-w-7xl px-4 py-8">
          {message ? <p role="alert">{message}</p> : <Loading />}
        </main>
      </>
    );
  const tanks = workspace.period.property.heatingSystems.flatMap(
    (system) => system.tanks,
  );
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap justify-between gap-3">
          <div>
            <Link href="/billing" className="text-sm text-zinc-500">
              ← Abrechnungen
            </Link>
            <h1 className="text-2xl font-semibold">Nebenkostenabrechnung</h1>
            <p className="text-zinc-600">
              {workspace.period.property.street},{" "}
              {workspace.period.property.zip} {workspace.period.property.city} ·{" "}
              {workspace.period.startDate.slice(0, 10)} –{" "}
              {workspace.period.endDate.slice(0, 10)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a className={button} href="/rent-changes">
              Vorauszahlungen und Mietperioden
            </a>
            <a
              className={button}
              href={`/api/billing-periods/${id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
            >
              PDF herunterladen
            </a>
            {workspace.locked && (
              <button className={button} onClick={() => void revise()}>
                Korrekturzeitraum anlegen
              </button>
            )}
            {!workspace.locked && (
              <button className={button} onClick={() => void cutover()}>
                Stichtag 01.10.2026 vorbereiten
              </button>
            )}
            {!workspace.locked && (
              <button
                className="rounded-lg bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-50"
                disabled={!!busy}
                onClick={() => void issue()}
              >
                Abrechnung ausstellen
              </button>
            )}
          </div>
        </div>
        {workspace.locked && (
          <p className="rounded-lg bg-blue-50 p-4 text-sm text-blue-900">
            Gespeicherte Abrechnung · Änderungen erfolgen in einem
            Korrekturzeitraum.
          </p>
        )}
        {message && (
          <p
            role="status"
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            {message}
          </p>
        )}
        {workspace.categories.map((category) => {
          const preview = previews[category.id] ?? category.preview;
          return (
            <section
              key={category.id}
              aria-label={category.label}
              className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{category.label}</h2>
                  <p className="text-sm text-zinc-500">
                    {descriptions[category.code]}
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  {category.code === "HEATING" && (
                    <a href="/heating-oil" className={button}>
                      Heizöl und Nachweise
                    </a>
                  )}
                  {category.code === "ELECTRICITY" && (
                    <a href="/electricity" className={button}>
                      Zähler und Tarife
                    </a>
                  )}
                  {category.code === "PROPERTY_TAX" && (
                    <a href="/settings/property-tax" className={button}>
                      Grundsteuer-Einstellungen
                    </a>
                  )}
                  {!workspace.locked && (
                    <button
                      className={button}
                      disabled={busy === category.id}
                      onClick={() => void calculate(category)}
                    >
                      Vorschau berechnen
                    </button>
                  )}
                </div>
              </div>
              {category.stale && (
                <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">
                  Quelldaten geändert · Berechnung erneut übernehmen.
                </p>
              )}
              <CategoryInvoices
                periodId={id}
                category={category}
                tanks={tanks}
                contracts={workspace.period.property.electricityContracts}
                locked={workspace.locked}
                onChanged={() => {
                  setPreviews({});
                  void load();
                }}
              />
              {preview && (
                <div className="mt-4 border-t border-zinc-200 pt-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      ["Gesamtkosten", preview.totalAmountCents],
                      ["Mieteranteile", preview.tenantAmountCents],
                      ["Vermieteranteil", preview.landlordAmountCents],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg bg-zinc-50 p-3">
                        <p className="text-xs text-zinc-500">{label}</p>
                        <p className="font-semibold">{centsToEuro(value)}</p>
                      </div>
                    ))}
                  </div>
                  {preview.blockers.map((blocker, i) => (
                    <p
                      key={i}
                      className="mt-2 rounded-lg bg-red-50 p-2 text-sm text-red-700"
                    >
                      Blocker: {blocker}
                    </p>
                  ))}
                  {preview.warnings.map((warning, i) => (
                    <p key={i} className="mt-2 text-sm text-amber-700">
                      {warning}
                    </p>
                  ))}
                  {preview.allocations.map((row, i) => (
                    <p key={i} className="mt-2 text-sm text-zinc-600">
                      {row.calculationBasis}: {centsToEuro(row.amountCents)}
                    </p>
                  ))}
                  {!workspace.locked && (
                    <div className="mt-3 space-y-2">
                      {preview.totalAmountCents === "0" && (
                        <label className="block text-sm">
                          Begründung für Nullkosten
                          <input
                            className={invoiceInputClass}
                            value={zeroReasons[category.id] ?? ""}
                            onChange={(e) =>
                              setZeroReasons({
                                ...zeroReasons,
                                [category.id]: e.target.value,
                              })
                            }
                          />
                        </label>
                      )}
                      <button
                        className="rounded-lg bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-50"
                        disabled={!!preview.blockers.length || !!busy}
                        onClick={() => void calculate(category, true)}
                      >
                        Unveränderlich übernehmen
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">Mieterabrechnungen</h2>
          {workspace.statements.map((row) =>
            row.statement ? (
              <div
                key={row.tenantId}
                className="mb-3 flex flex-wrap justify-between gap-3 rounded-lg bg-zinc-50 p-4"
              >
                <p>
                  {row.statement.tenant.firstName}{" "}
                  {row.statement.tenant.lastName} · Kosten{" "}
                  {centsToEuro(row.statement.totalActualCents)} ·
                  Vorauszahlungen{" "}
                  {centsToEuro(row.statement.totalPrepaymentCents)} · Saldo{" "}
                  {centsToEuro(row.statement.balanceCents)}
                </p>
                <a
                  href={`/api/billing-periods/${id}/pdf?tenantId=${row.tenantId}`}
                  className="text-sm text-red-700 underline"
                >
                  PDF
                </a>
              </div>
            ) : (
              <p key={row.tenantId} className="mb-2 text-sm text-red-700">
                {row.error}
              </p>
            ),
          )}
        </section>
      </main>
    </>
  );
}
