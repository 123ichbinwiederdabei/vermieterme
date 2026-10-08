"use client";
import { useEffect, useState } from "react";
import { Nav } from "@/components/nav";
import {
  CategoryInvoices,
  invoiceInputClass,
} from "@/components/category-invoices";
import { categoryCode } from "@/lib/invoice-categories";

type Period = {
  id: string;
  status: string;
  startDate: string;
  endDate: string;
  property: { street: string };
};
type Category = { id: string; name: string; code: string };
export default function SmallWastewaterPage() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [periodId, setPeriodId] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [message, setMessage] = useState("");
  const [tenants, setTenants] = useState<
    Array<{ id: string; firstName: string; lastName: string }>
  >([]);
  const [agreement, setAgreement] = useState({
    tenantId: "",
    validFrom: "",
    validTo: "",
    note: "",
    contractDocumentId: "",
  });
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    void Promise.all([
      fetch("/api/billing-periods").then((r) => r.json()),
      fetch("/api/cost-categories").then((r) => r.json()),
    ]).then(([periods, categories]) => {
      const active = periods.filter((p: Period) => p.status !== "SUPERSEDED");
      setPeriods(active);
      setPeriodId(active[0]?.id || "");
      setCategory(
        categories.find((c: Category) => categoryCode(c) === "WASTEWATER") ??
          null,
      );
    });
  }, []);
  useEffect(() => {
    if (!periodId) return;
    void fetch(`/api/billing-periods/${periodId}/workspace`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setMessage(data.error);
          return;
        }
        setLocked(data.locked);
        setTenants(
          data.period.property.units.flatMap(
            (unit: { tenants: typeof tenants }) => unit.tenants,
          ),
        );
      });
  }, [periodId]);
  async function saveAgreement(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/lease-cost-category-agreements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...agreement, costCategoryId: category?.id }),
    });
    const data = await response.json();
    setMessage(response.ok ? "Vertragsbestätigung gespeichert" : data.error);
  }
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-semibold">Kleinkläranlage</h1>
        <p className="text-sm text-zinc-600">
          Laufende Kosten und Anlagenstrom · ein Drittel je Wohnung
          einschließlich Vermieter · keine Reparaturen
        </p>
        <label className="block text-sm">
          Abrechnungszeitraum
          <select
            className={invoiceInputClass}
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.property.street} · {p.startDate.slice(0, 10)} –{" "}
                {p.endDate.slice(0, 10)}
              </option>
            ))}
          </select>
        </label>
        {category && periodId && (
          <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Rechnung erfassen</h2>
            <CategoryInvoices
              key={periodId}
              periodId={periodId}
              category={{ id: category.id, code: "WASTEWATER" }}
              tanks={[]}
              locked={locked}
              onChanged={() => undefined}
            />
            <a
              className="mt-4 inline-block text-sm text-red-700 underline"
              href={`/billing/${periodId}`}
            >
              Zur Berechnung und Abrechnung
            </a>
          </section>
        )}
        <form
          onSubmit={saveAgreement}
          className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <h2 className="mb-3 text-lg font-semibold">Vertragsbestätigung</h2>
          <label className="block text-sm">
            Mietverhältnis
            <select
              className={invoiceInputClass}
              required
              value={agreement.tenantId}
              onChange={(e) =>
                setAgreement({ ...agreement, tenantId: e.target.value })
              }
            >
              <option value="">Bitte wählen</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.firstName} {t.lastName}
                </option>
              ))}
            </select>
          </label>
          {["validFrom", "validTo", "note", "contractDocumentId"].map((key) => (
            <label key={key} className="mt-3 block text-sm">
              {
                {
                  validFrom: "Gültig ab",
                  validTo: "Gültig bis",
                  note: "Dokumentierte Prüfung des Vertrags",
                  contractDocumentId: "Vertragsbeleg-ID",
                }[key]
              }
              <input
                className={invoiceInputClass}
                type={key.startsWith("valid") ? "date" : "text"}
                required={key === "validFrom" || key === "note"}
                value={agreement[key as keyof typeof agreement]}
                onChange={(e) =>
                  setAgreement({ ...agreement, [key]: e.target.value })
                }
              />
            </label>
          ))}
          <button className="mt-3 rounded-lg bg-red-700 px-4 py-2 text-sm text-white">
            Bestätigung speichern
          </button>
        </form>
        {message && <p role="status">{message}</p>}
      </main>
    </>
  );
}
