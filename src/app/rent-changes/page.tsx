"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Nav } from "@/components/nav";
import { Loading } from "@/components/ui/loading";
import { EmptyState } from "@/components/ui/empty-state";
import { centsToEuro, euroToCents } from "@/lib/money";

type Category = { id: string; name: string };
type Component = { id: string; monthlyAmountCents: string; costCategory: Category };
type Period = { id: string; validFrom: string; validTo?: string | null; monthlyColdRentCents: string; monthlyPrepaymentCents: string; reason?: string | null; revisionReason?: string | null; supersededAt?: string | null; components: Component[] };
type Tenant = { id: string; firstName: string; lastName: string; unit: { name: string; property: { street: string; city: string } }; financialPeriods: Period[] };
type ExternalClosing = { id: string; closingDate: string; note?: string | null; tenants: Array<{ tenant: { id: string } }> };

const inputClass = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500";

function centsToInput(value: string) {
  const cents = BigInt(value);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export default function FinancialHistoryPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [closings, setClosings] = useState<ExternalClosing[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [openNewFromLink, setOpenNewFromLink] = useState(false);
  const autoPrefillKey = useRef<string | null>(null);
  const [form, setForm] = useState({ tenantId: "", validFrom: "", coldRentEuro: "", reason: "", components: {} as Record<string, string> });

  async function load() {
    const [tenantResponse, categoryResponse, closingResponse] = await Promise.all([fetch("/api/tenants"), fetch("/api/cost-categories"), fetch("/api/external-billing-closings")]);
    if (tenantResponse.ok) setTenants(await tenantResponse.json());
    if (categoryResponse.ok) setCategories(await categoryResponse.json());
    if (closingResponse.ok) setClosings(await closingResponse.json());
    setLoading(false);
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSelectedTenantId(params.get("tenantId") || "");
    setOpenNewFromLink(params.get("new") === "1");
    void load();
  }, []);

  const startNewPeriod = useCallback((tenantId: string) => {
    const tenant = tenants.find((item) => item.id === tenantId);
    const latest = tenant?.financialPeriods
      .filter((period) => !period.supersededAt)
      .sort((left, right) => new Date(right.validFrom).getTime() - new Date(left.validFrom).getTime())[0];
    const components = Object.fromEntries(categories.map((category) => [category.id, "0"]));
    for (const component of latest?.components || []) components[component.costCategory.id] = centsToInput(component.monthlyAmountCents);
    setForm({
      tenantId,
      validFrom: new Date().toISOString().slice(0, 10),
      coldRentEuro: latest ? centsToInput(latest.monthlyColdRentCents) : "",
      reason: "",
      components,
    });
    setMessage("");
    setShowForm(true);
  }, [categories, tenants]);

  useEffect(() => {
    if (loading || !selectedTenantId || !openNewFromLink || !categories.length) return;
    const key = `${selectedTenantId}:${categories.map((category) => category.id).join(",")}`;
    if (autoPrefillKey.current === key) return;
    autoPrefillKey.current = key;
    startNewPeriod(selectedTenantId);
  }, [loading, selectedTenantId, openNewFromLink, categories, startNewPeriod]);

  const totalCents = useMemo(() => Object.values(form.components).reduce((sum, value) => sum + BigInt(value ? euroToCents(value) : "0"), 0n), [form.components]);
  const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId) || null;
  const displayedTenants = selectedTenant ? [selectedTenant] : selectedTenantId ? [] : tenants;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const response = await fetch(`/api/tenants/${form.tenantId}/financial-periods`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          validFrom: form.validFrom,
          monthlyColdRentCents: euroToCents(form.coldRentEuro),
          monthlyPrepaymentCents: totalCents.toString(),
          reason: form.reason || null,
          components: categories.map((category) => ({ costCategoryId: category.id, monthlyAmountCents: form.components[category.id] ? euroToCents(form.components[category.id]) : "0" })),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Speichern fehlgeschlagen");
      setShowForm(false);
      setMessage("Finanzperiode gespeichert");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Speichern fehlgeschlagen");
    }
  }

  if (loading) return <><Nav /><main className="mx-auto max-w-7xl px-4 py-8"><Loading /></main></>;

  const selectedLabel = selectedTenant && `${selectedTenant.unit.property.street} · ${selectedTenant.unit.name} · ${selectedTenant.firstName} ${selectedTenant.lastName}`;
  return <><Nav /><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-zinc-900">Miet- und NK-Historie</h1><p className="mt-1 text-sm text-zinc-500">{selectedLabel || "Gültige Mietbeträge und kostenartbezogene Vorauszahlungen"}</p></div>
      <div className="flex flex-wrap gap-2">
        {selectedTenantId && <><Link href="/tenants" className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">Zum Mieter</Link><Link href="/rent-changes" className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">Alle Mietverhältnisse</Link></>}
        <button onClick={() => startNewPeriod(selectedTenantId)} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">Neue Periode</button>
      </div>
    </div>
    {message && <p className={`mb-4 text-sm ${message.includes("gespeichert") ? "text-green-600" : "text-red-600"}`}>{message}</p>}
    {showForm && <form onSubmit={save} className="mb-8 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"><h2 className="mb-4 text-lg font-semibold text-zinc-900">Vollständigen Stand speichern</h2><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-sm font-medium text-zinc-700">Mietverhältnis<select required disabled={Boolean(selectedTenantId)} className={inputClass} value={form.tenantId} onChange={(event) => startNewPeriod(event.target.value)}><option value="">Bitte wählen</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.unit.property.street} – {tenant.unit.name} – {tenant.firstName} {tenant.lastName}</option>)}</select></label>
      <label className="text-sm font-medium text-zinc-700">Gültig ab<input required type="date" className={inputClass} value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })}/></label>
      <label className="text-sm font-medium text-zinc-700">Kaltmiete (€)<input required type="number" min="0" step="0.01" className={inputClass} value={form.coldRentEuro} onChange={(event) => setForm({ ...form, coldRentEuro: event.target.value })}/></label>
      {categories.map((category) => <label key={category.id} className="text-sm font-medium text-zinc-700">NK {category.name} (€)<input required type="number" min="0" step="0.01" className={inputClass} value={form.components[category.id] || "0"} onChange={(event) => setForm({ ...form, components: { ...form.components, [category.id]: event.target.value } })}/></label>)}
      <label className="text-sm font-medium text-zinc-700">Änderungsgrund<input className={inputClass} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })}/></label>
    </div><p className="mt-4 text-sm font-medium text-zinc-700">NK gesamt: {centsToEuro(totalCents)}</p><div className="mt-4 flex gap-2"><button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">Periode speichern</button><button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">Abbrechen</button></div></form>}
    {selectedTenantId && !selectedTenant ? <EmptyState message="Dieses Mietverhältnis wurde nicht gefunden." /> : <div className="space-y-6">{displayedTenants.map((tenant) => <section key={tenant.id}><h2 className="mb-2 text-lg font-semibold text-zinc-900">{tenant.unit.property.street} · {tenant.unit.name} · {tenant.firstName} {tenant.lastName}</h2><div className="space-y-3">{closings.filter((closing) => closing.tenants.some((item) => item.tenant.id === tenant.id)).map((closing) => <div key={closing.id} className="rounded-xl border border-blue-200 bg-blue-50 p-5 shadow-sm"><p className="font-medium text-blue-950">Extern erledigte Abrechnung bis {new Date(closing.closingDate).toLocaleDateString("de-DE")}</p><p className="mt-1 text-sm text-blue-800">{closing.note || "Keine Kostenwerte wurden nacherfasst."}</p><a className="mt-3 inline-block rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-900 hover:bg-blue-100" href={`/api/external-billing-closings/${closing.id}/pdf`}>Abschluss-PDF</a></div>)}{tenant.financialPeriods.map((period) => <details key={period.id} className={`rounded-xl border bg-white p-5 shadow-sm ${period.supersededAt ? "border-amber-200 opacity-75" : "border-zinc-200"}`}><summary className="cursor-pointer list-none"><div className="flex flex-wrap items-center justify-between gap-3"><div><span className="font-medium text-zinc-900">{new Date(period.validFrom).toLocaleDateString("de-DE")} – {period.validTo ? new Date(period.validTo).toLocaleDateString("de-DE") : "laufend"}</span><p className="text-sm text-zinc-500">{period.reason || "Vollständiger Finanzstand"}{period.revisionReason ? ` · Revision: ${period.revisionReason}` : ""}</p></div><div className="text-right text-sm"><p>Kaltmiete {centsToEuro(period.monthlyColdRentCents)}</p><p>NK {centsToEuro(period.monthlyPrepaymentCents)}</p><p className="font-semibold">Gesamt {centsToEuro(BigInt(period.monthlyColdRentCents) + BigInt(period.monthlyPrepaymentCents))}</p></div></div></summary><div className="mt-4 border-t border-zinc-100 pt-3">{period.components.map((component) => <div key={component.id} className="flex justify-between py-1 text-sm text-zinc-600"><span>{component.costCategory.name}</span><span>{centsToEuro(component.monthlyAmountCents)}</span></div>)}</div></details>)}{tenant.financialPeriods.length === 0 && !closings.some((closing) => closing.tenants.some((item) => item.tenant.id === tenant.id)) && <EmptyState message="Noch keine vollständigen Miet- und NK-Perioden vorhanden." />}</div></section>)}</div>}
  </main></>;
}
