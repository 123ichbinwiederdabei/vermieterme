"use client";

import { useEffect, useMemo, useState } from "react";
import { Nav } from "@/components/nav";
import { Loading } from "@/components/ui/loading";
import { EmptyState } from "@/components/ui/empty-state";
import { centsToEuro, euroToCents } from "@/lib/money";

type Category = { id: string; name: string };
type Component = { id: string; monthlyAmountCents: string; costCategory: Category };
type Period = { id: string; validFrom: string; validTo?: string | null; monthlyColdRentCents: string; monthlyPrepaymentCents: string; reason?: string | null; revisionReason?: string | null; supersededAt?: string | null; components: Component[] };
type Tenant = { id: string; firstName: string; lastName: string; unit: { name: string; property: { street: string; city: string } }; financialPeriods: Period[] };

const inputClass = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500";

export default function FinancialHistoryPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ tenantId: "", validFrom: "", coldRentEuro: "", reason: "", components: {} as Record<string, string> });

  async function load() {
    const [tenantResponse, categoryResponse] = await Promise.all([fetch("/api/tenants"), fetch("/api/cost-categories")]);
    if (tenantResponse.ok) setTenants(await tenantResponse.json());
    if (categoryResponse.ok) setCategories(await categoryResponse.json());
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  const totalCents = useMemo(() => Object.values(form.components).reduce((sum, value) => sum + BigInt(value ? euroToCents(value) : "0"), 0n), [form.components]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setMessage("");
    try {
      const response = await fetch(`/api/tenants/${form.tenantId}/financial-periods`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ validFrom: form.validFrom, monthlyColdRentCents: euroToCents(form.coldRentEuro), monthlyPrepaymentCents: totalCents.toString(), reason: form.reason || null, components: categories.map((category) => ({ costCategoryId: category.id, monthlyAmountCents: form.components[category.id] ? euroToCents(form.components[category.id]) : "0" })) }),
      });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Speichern fehlgeschlagen");
      setShowForm(false); setMessage("Finanzperiode gespeichert"); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Speichern fehlgeschlagen"); }
  }

  if (loading) return <><Nav /><main className="mx-auto max-w-7xl px-4 py-8"><Loading /></main></>;
  const withPeriods = tenants.filter((tenant) => tenant.financialPeriods?.length);
  return <><Nav /><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold text-zinc-900">Miet- und NK-Historie</h1><p className="mt-1 text-sm text-zinc-500">Gültige Mietbeträge und kostenartbezogene Vorauszahlungen</p></div><button onClick={() => setShowForm(!showForm)} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">Neue Periode</button></div>
    {message && <p className={`mb-4 text-sm ${message.includes("gespeichert") ? "text-green-600" : "text-red-600"}`}>{message}</p>}
    {showForm && <form onSubmit={save} className="mb-8 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"><h2 className="mb-4 text-lg font-semibold text-zinc-900">Vollständigen Stand speichern</h2><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-sm font-medium text-zinc-700">Mietverhältnis<select required className={inputClass} value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })}><option value="">Bitte wählen</option>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.unit.property.street} – {tenant.unit.name} – {tenant.firstName} {tenant.lastName}</option>)}</select></label>
      <label className="text-sm font-medium text-zinc-700">Gültig ab<input required type="date" className={inputClass} value={form.validFrom} onChange={(event) => setForm({ ...form, validFrom: event.target.value })}/></label>
      <label className="text-sm font-medium text-zinc-700">Kaltmiete (€)<input required type="number" min="0" step="0.01" className={inputClass} value={form.coldRentEuro} onChange={(event) => setForm({ ...form, coldRentEuro: event.target.value })}/></label>
      {categories.map((category) => <label key={category.id} className="text-sm font-medium text-zinc-700">NK {category.name} (€)<input required type="number" min="0" step="0.01" className={inputClass} value={form.components[category.id] || "0"} onChange={(event) => setForm({ ...form, components: { ...form.components, [category.id]: event.target.value } })}/></label>)}
      <label className="text-sm font-medium text-zinc-700">Änderungsgrund<input className={inputClass} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })}/></label>
    </div><p className="mt-4 text-sm font-medium text-zinc-700">NK gesamt: {centsToEuro(totalCents)}</p><button className="mt-4 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">Periode speichern</button></form>}
    {withPeriods.length === 0 ? <EmptyState message="Noch keine vollständigen Miet- und NK-Perioden vorhanden." /> : <div className="space-y-6">{withPeriods.map((tenant) => <section key={tenant.id}><h2 className="mb-2 text-lg font-semibold text-zinc-900">{tenant.unit.property.street} · {tenant.unit.name} · {tenant.firstName} {tenant.lastName}</h2><div className="space-y-3">{tenant.financialPeriods.map((period) => <details key={period.id} className={`rounded-xl border bg-white p-5 shadow-sm ${period.supersededAt ? "border-amber-200 opacity-75" : "border-zinc-200"}`}><summary className="cursor-pointer list-none"><div className="flex flex-wrap items-center justify-between gap-3"><div><span className="font-medium text-zinc-900">{new Date(period.validFrom).toLocaleDateString("de-DE")} – {period.validTo ? new Date(period.validTo).toLocaleDateString("de-DE") : "laufend"}</span><p className="text-sm text-zinc-500">{period.reason || "Vollständiger Finanzstand"}{period.revisionReason ? ` · Revision: ${period.revisionReason}` : ""}</p></div><div className="text-right text-sm"><p>Kaltmiete {centsToEuro(period.monthlyColdRentCents)}</p><p>NK {centsToEuro(period.monthlyPrepaymentCents)}</p><p className="font-semibold">Gesamt {centsToEuro(BigInt(period.monthlyColdRentCents) + BigInt(period.monthlyPrepaymentCents))}</p></div></div></summary><div className="mt-4 border-t border-zinc-100 pt-3">{period.components.map((component) => <div key={component.id} className="flex justify-between py-1 text-sm text-zinc-600"><span>{component.costCategory.name}</span><span>{centsToEuro(component.monthlyAmountCents)}</span></div>)}</div></details>)}</div></section>)}</div>}
  </main></>;
}
