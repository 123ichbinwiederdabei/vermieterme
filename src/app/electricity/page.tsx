"use client";

import { useEffect, useMemo, useState } from "react";
import { Nav } from "@/components/nav";
import { Loading } from "@/components/ui/loading";
import { EmptyState } from "@/components/ui/empty-state";
import { centsToEuro, euroToCents } from "@/lib/money";

type Unit = { id: string; name: string };
type Property = { id: string; street: string; city: string; units?: Unit[] };
type Tariff = { id: string; validFrom: string; validTo?: string | null; billingValidFrom?: string | null; billingValidTo?: string | null; billingEffectiveReason?: string | null; priceCentsPerKwh: number; monthlyBasePriceCents: string; name?: string | null };
type Reading = { id: string; readingDate: string; readingKwh: string; reason: string };
type Meter = { id: string; meterNumber: string; role: string; unit?: Unit | null; readings: Reading[] };
type Contract = { id: string; provider: string; contractReference?: string | null; validFrom: string; basePriceAllocation: string; property: Property; tariffs: Tariff[]; meters: Meter[] };

const fieldClass = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500";
const buttonClass = "rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50";

export default function ElectricityPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [contract, setContract] = useState({ propertyId: "", provider: "", contractReference: "", validFrom: "", basePriceAllocation: "BY_CONSUMPTION" });
  const [tariff, setTariff] = useState({ contractId: "", validFrom: "", validTo: "", billingValidFrom: "", billingValidTo: "", billingEffectiveReason: "", name: "", priceEuroPerKwh: "", monthlyBasePriceEuro: "" });
  const [editingTariff, setEditingTariff] = useState<Tariff | null>(null);
  const [meter, setMeter] = useState({ contractId: "", unitId: "", meterNumber: "", role: "UNIT_CONSUMPTION", validFrom: "" });
  const [reading, setReading] = useState({ meterId: "", readingDate: "", readingKwh: "", reason: "REGULAR" });

  async function load() {
    const [contractResponse, propertyResponse] = await Promise.all([fetch("/api/electricity"), fetch("/api/properties")]);
    if (contractResponse.ok) setContracts(await contractResponse.json());
    if (propertyResponse.ok) {
      const base: Property[] = await propertyResponse.json();
      setProperties(await Promise.all(base.map((item) => fetch(`/api/properties/${item.id}`).then((response) => response.json()))));
    }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  const selectedContract = contracts.find((item) => item.id === meter.contractId);
  const meters = useMemo(() => contracts.flatMap((item) => item.meters.map((row) => ({ ...row, contract: item }))), [contracts]);

  async function submit(action: string, payload: Record<string, unknown>) {
    try {
      const response = await fetch("/api/electricity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Speichern fehlgeschlagen");
      setMessage("Gespeichert"); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Speichern fehlgeschlagen"); }
  }

  if (loading) return <><Nav /><main className="mx-auto max-w-7xl px-4 py-8"><Loading /></main></>;
  return <><Nav /><main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <div className="mb-8 flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-2xl font-bold text-zinc-900">Strom</h1><p className="mt-1 text-sm text-zinc-500">Verträge, Tarife, Zähler und tatsächlicher Verbrauch</p></div>{message && <p className={message === "Gespeichert" ? "text-sm text-green-600" : "text-sm text-red-600"}>{message}</p>}</div>
    {contracts.length === 0 ? <EmptyState message="Noch kein Stromvertrag vorhanden." /> : <div className="mb-8 space-y-5">{contracts.map((item) => <section key={item.id} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-zinc-900">{item.provider}</h2><p className="text-sm text-zinc-500">{item.property.street}, {item.property.city} · ab {new Date(item.validFrom).toLocaleDateString("de-DE")}</p>
      <div className="mt-4 grid gap-5 lg:grid-cols-2"><div><h3 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Tarife</h3>{item.tariffs.map((row) => <div className="mb-2 flex items-start justify-between gap-2 text-sm text-zinc-700" key={row.id}><div><p>{new Date(row.validFrom).toLocaleDateString("de-DE")}: {centsToEuro(String(row.priceCentsPerKwh))}/kWh · Grundpreis {centsToEuro(row.monthlyBasePriceCents)}/Monat</p>{row.billingValidFrom && <p className="text-xs text-zinc-500">Vertrag ab {new Date(row.validFrom).toLocaleDateString("de-DE")} · Abrechnung ab {new Date(row.billingValidFrom).toLocaleDateString("de-DE")}{row.billingValidTo ? ` bis ${new Date(row.billingValidTo).toLocaleDateString("de-DE")}` : ""}{row.billingEffectiveReason ? ` · ${row.billingEffectiveReason}` : ""}</p>}</div><button type="button" className="rounded border border-zinc-300 px-2 py-1 text-xs" onClick={() => setEditingTariff(row)}>Abrechnung</button></div>)}</div><div><h3 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Zähler</h3>{item.meters.map((row) => <div key={row.id} className="mb-2 text-sm text-zinc-700"><span className="font-medium">{row.meterNumber}</span> · {row.unit?.name || row.role} · {row.readings.length} Ablesungen{row.readings[0] && <span> · zuletzt {row.readings[0].readingKwh} kWh</span>}</div>)}</div></div>
    </section>)}</div>}
    <div className="grid gap-6 lg:grid-cols-2">
      <Form title="Stromvertrag" onSubmit={() => submit("createContract", contract)}><Select label="Objekt" value={contract.propertyId} set={(value) => setContract({ ...contract, propertyId: value })} options={properties.map((row) => [row.id, `${row.street}, ${row.city}`])}/><Field label="Anbieter" value={contract.provider} set={(value) => setContract({ ...contract, provider: value })}/><Field label="Vertragsreferenz" value={contract.contractReference} set={(value) => setContract({ ...contract, contractReference: value })} required={false}/><Field label="Gültig ab" type="date" value={contract.validFrom} set={(value) => setContract({ ...contract, validFrom: value })}/><Select label="Grundpreisverteilung" value={contract.basePriceAllocation} set={(value) => setContract({ ...contract, basePriceAllocation: value })} options={[["BY_CONSUMPTION", "Nach Verbrauch"], ["EQUAL_PER_UNIT", "Gleich je Wohnung"]]}/></Form>
      <Form title="Tarifperiode" onSubmit={() => submit("createTariff", { ...tariff, priceCentsPerKwh: euroToCents(tariff.priceEuroPerKwh), monthlyBasePriceCents: euroToCents(tariff.monthlyBasePriceEuro) })}><Select label="Vertrag" value={tariff.contractId} set={(value) => setTariff({ ...tariff, contractId: value })} options={contracts.map((row) => [row.id, row.provider])}/><Field label="Tarifname" value={tariff.name} set={(value) => setTariff({ ...tariff, name: value })} required={false}/><Field label="Vertrag gültig ab" type="date" value={tariff.validFrom} set={(value) => setTariff({ ...tariff, validFrom: value })}/><Field label="Vertrag gültig bis" type="date" value={tariff.validTo} set={(value) => setTariff({ ...tariff, validTo: value })} required={false}/><Field label="Abrechnung wirksam ab" type="date" value={tariff.billingValidFrom} set={(value) => setTariff({ ...tariff, billingValidFrom: value })} required={false}/><Field label="Abrechnung wirksam bis" type="date" value={tariff.billingValidTo} set={(value) => setTariff({ ...tariff, billingValidTo: value })} required={false}/><Field label="Grund der Ersatzregel" value={tariff.billingEffectiveReason} set={(value) => setTariff({ ...tariff, billingEffectiveReason: value })} required={false}/><Field label="Arbeitspreis (€/kWh)" type="number" value={tariff.priceEuroPerKwh} set={(value) => setTariff({ ...tariff, priceEuroPerKwh: value })}/><Field label="Grundpreis (€/Monat)" type="number" value={tariff.monthlyBasePriceEuro} set={(value) => setTariff({ ...tariff, monthlyBasePriceEuro: value })}/></Form>
      {editingTariff && <Form title="Abrechnungswirksamkeit ändern" onSubmit={async () => { await submit("updateTariff", { id: editingTariff.id, billingValidFrom: editingTariff.billingValidFrom || null, billingValidTo: editingTariff.billingValidTo || null, billingEffectiveReason: editingTariff.billingEffectiveReason || null }); setEditingTariff(null); }}><Field label="Vertrag gültig ab" value={new Date(editingTariff.validFrom).toLocaleDateString("de-DE")} set={() => {}} required={false}/><Field label="Abrechnung wirksam ab" type="date" value={editingTariff.billingValidFrom?.slice(0, 10) || ""} set={(value) => setEditingTariff({ ...editingTariff, billingValidFrom: value })} required={false}/><Field label="Abrechnung wirksam bis" type="date" value={editingTariff.billingValidTo?.slice(0, 10) || ""} set={(value) => setEditingTariff({ ...editingTariff, billingValidTo: value })} required={false}/><Field label="Dokumentierte Ersatzregel" value={editingTariff.billingEffectiveReason || ""} set={(value) => setEditingTariff({ ...editingTariff, billingEffectiveReason: value })} required={false}/></Form>}
      <Form title="Stromzähler" onSubmit={() => submit("createMeter", meter)}><Select label="Vertrag" value={meter.contractId} set={(value) => setMeter({ ...meter, contractId: value, unitId: "" })} options={contracts.map((row) => [row.id, row.provider])}/><Select label="Rolle" value={meter.role} set={(value) => setMeter({ ...meter, role: value })} options={[["UNIT_CONSUMPTION", "Wohnungsverbrauch"], ["COMMON_ELECTRICITY", "Allgemeinstrom"], ["INFORMATIONAL_TOTAL", "Summenzähler (informativ)"]]}/>{meter.role === "UNIT_CONSUMPTION" && <Select label="Wohnung" value={meter.unitId} set={(value) => setMeter({ ...meter, unitId: value })} options={(selectedContract?.property.units || properties.find((row) => row.id === selectedContract?.property.id)?.units || []).map((row) => [row.id, row.name])}/>}<Field label="Zählernummer" value={meter.meterNumber} set={(value) => setMeter({ ...meter, meterNumber: value })}/><Field label="Gültig ab" type="date" value={meter.validFrom} set={(value) => setMeter({ ...meter, validFrom: value })}/></Form>
      <Form title="Stromzählerablesung" onSubmit={() => submit("createReading", reading)}><Select label="Zähler" value={reading.meterId} set={(value) => setReading({ ...reading, meterId: value })} options={meters.map((row) => [row.id, `${row.contract.provider} – ${row.meterNumber}`])}/><Field label="Datum" type="date" value={reading.readingDate} set={(value) => setReading({ ...reading, readingDate: value })}/><Field label="Zählerstand (kWh)" type="number" value={reading.readingKwh} set={(value) => setReading({ ...reading, readingKwh: value })}/><Select label="Anlass" value={reading.reason} set={(value) => setReading({ ...reading, reason: value })} options={[["REGULAR", "Regulär"], ["MOVE_IN", "Einzug"], ["MOVE_OUT", "Auszug"], ["TARIFF_CHANGE", "Tarifwechsel"], ["METER_CHANGE_END", "Zählerwechsel Ende"], ["METER_CHANGE_START", "Zählerwechsel Start"]]}/></Form>
    </div>
  </main></>;
}

function Form({ title, children, onSubmit }: { title: string; children: React.ReactNode; onSubmit: () => Promise<void> }) { return <form className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}><h2 className="mb-4 text-lg font-semibold text-zinc-900">{title}</h2><div className="grid gap-4 sm:grid-cols-2">{children}</div><button className={`${buttonClass} mt-4`}>Speichern</button></form>; }
function Field({ label, value, set, type = "text", required = true }: { label: string; value: string; set: (value: string) => void; type?: string; required?: boolean }) { return <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700"><span>{label}</span><input className={fieldClass} type={type} required={required} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} value={value} onChange={(event) => set(event.target.value)}/></label>; }
function Select({ label, value, set, options }: { label: string; value: string; set: (value: string) => void; options: string[][] }) { return <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700"><span>{label}</span><select className={fieldClass} required value={value} onChange={(event) => set(event.target.value)}><option value="">Bitte wählen</option>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>; }
