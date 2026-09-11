"use client";

import { useEffect, useMemo, useState } from "react";
import { Nav } from "@/components/nav";
import { Loading } from "@/components/ui/loading";
import { EmptyState } from "@/components/ui/empty-state";
import { centsToEuro, euroToCents } from "@/lib/money";
import { DocumentUpload } from "@/components/document-upload";

type Unit = { id: string; name: string; areaM2: string | null };
type Property = { id: string; street: string; city: string; units?: Unit[] };
type Delivery = { id: string; deliveryDate: string; quantityLiters: string; totalAmountCents: string; supplier?: string | null };
type Reading = { id: string; readingDate: string; quantityLiters: string | null; fillLevelPercent?: number | null; batteryLevel?: string | null; validationError?: string | null; distanceCm?: string | null; source: string; method: string };
type Lot = { id: string; sourceType: string; sourceDate: string; quantityLiters: string; totalAmountCents: string };
type Device = { id: string; hwid: string; tankId?: string | null; connectionStatus: string; lastMeasurementAt?: string | null; lastSyncAt?: string | null; lastError?: string | null };
type Candidate = { id: string; status: string; estimatedIncreaseLiters: string; beforeMeasurement: Reading; afterMeasurement: Reading };
type Tank = { id: string; name: string; capacityLiters: string | null; deliveryDetectionThresholdLiters: string; deliveries: Delivery[]; stockReadings: Reading[]; inventoryLots: Lot[]; oilFoxDevices: Device[]; deliveryCandidates: Candidate[] };
type System = { id: string; name: string; billingRegime: string; exceptionReason?: string | null; property: Property; units: Array<{ unit: Unit }>; tanks: Tank[] };

const inputClass = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500";
const buttonClass = "rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50";

export default function HeatingOilPage() {
  const [systems, setSystems] = useState<System[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [oilFox, setOilFox] = useState<{ configured: boolean; devices: Device[]; syncState?: { lastSuccessAt?: string | null; lastError?: string | null } | null }>({ configured: false, devices: [] });
  const [syncing, setSyncing] = useState(false);
  const [csv, setCsv] = useState<{ tankId: string; deviceId: string; file: File | null }>({ tankId: "", deviceId: "", file: null });
  const [csvPreview, setCsvPreview] = useState<{ imported: number; skippedDuplicates: number; invalidRows: number; warnings: string[]; candidateCount?: number; measuredFrom?: string | null; measuredTo?: string | null } | null>(null);
  const [systemForm, setSystemForm] = useState({ propertyId: "", name: "Ölheizung", billingRegime: "STANDARD_HEIZKOSTENV", exceptionReason: "", unitIds: [] as string[] });
  const [editingSystemId, setEditingSystemId] = useState<string | null>(null);
  const [tankForm, setTankForm] = useState({ heatingSystemId: "", name: "Heizöltank", capacityLiters: "" });
  const [openingForm, setOpeningForm] = useState({ tankId: "", sourceDate: "", quantityLiters: "", totalAmountEuro: "", co2CostEuro: "0", co2Grams: "0", energyContentKwh: "0", emissionFactorMicrogWh: "0" });
  const [deliveryForm, setDeliveryForm] = useState({ tankId: "", deliveryDate: "", quantityLiters: "", totalAmountEuro: "", co2CostEuro: "0", co2Grams: "0", energyContentKwh: "0", emissionFactorMicrogWh: "0", supplier: "", invoiceNumber: "", candidateId: "" });
  const [readingForm, setReadingForm] = useState({ tankId: "", readingDate: "", quantityLiters: "", method: "MANUAL" });

  async function load() {
    const [systemsResponse, propertiesResponse, oilFoxResponse] = await Promise.all([fetch("/api/heating-oil"), fetch("/api/properties"), fetch("/api/heating-oil/oilfox")]);
    if (systemsResponse.ok) setSystems(await systemsResponse.json());
    if (propertiesResponse.ok) {
      const base: Property[] = await propertiesResponse.json();
      const details = await Promise.all(base.map((property) => fetch(`/api/properties/${property.id}`).then((response) => response.json())));
      setProperties(details);
    }
    if (oilFoxResponse.ok) setOilFox(await oilFoxResponse.json());
    setLoading(false);
  }

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(initialLoad);
  }, []);

  const tanks = useMemo(() => systems.flatMap((system) => system.tanks.map((tank) => ({ ...tank, systemName: system.name }))), [systems]);
  const selectedProperty = properties.find((property) => property.id === systemForm.propertyId);

  async function submit(action: string, payload: Record<string, unknown>) {
    setStatus(null);
    const response = await fetch("/api/heating-oil", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
    const data = await response.json();
    if (!response.ok) { setStatus(data.error || "Speichern fehlgeschlagen"); return false; }
    setStatus("Gespeichert");
    await load();
    return true;
  }

  async function syncOilFox() {
    setSyncing(true); setStatus(null);
    const response = await fetch("/api/heating-oil/oilfox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync" }) });
    const data = await response.json(); setSyncing(false);
    if (!response.ok) setStatus(data.error || "OilFox-Aktualisierung fehlgeschlagen"); else { setStatus(`OilFox aktualisiert: ${data.measurements || 0} neue Messung(en)`); await load(); }
  }

  async function previewCsv(event: React.FormEvent) {
    event.preventDefault(); if (!csv.file || !csv.tankId || !csv.deviceId) return;
    setStatus(null);
    const form = new FormData(); form.set("file", csv.file); form.set("tankId", csv.tankId); form.set("deviceId", csv.deviceId);
    form.set("dryRun", "true");
    const response = await fetch("/api/heating-oil/oilfox/import", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) setStatus(data.error || "CSV-Vorschau fehlgeschlagen"); else { setCsvPreview(data); setStatus("CSV-Vorschau bereit"); }
  }

  async function importCsv() {
    if (!csv.file || !csvPreview) return;
    const form = new FormData(); form.set("file", csv.file); form.set("tankId", csv.tankId); form.set("deviceId", csv.deviceId);
    const response = await fetch("/api/heating-oil/oilfox/import", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) setStatus(data.error || "CSV-Import fehlgeschlagen"); else { setStatus(`CSV importiert: ${data.imported} Messungen, ${data.candidateCount || 0} Lieferhinweise`); setCsvPreview(null); await load(); }
  }

  if (loading) return <><Nav /><main className="mx-auto max-w-7xl px-4 py-8"><Loading /></main></>;

  return <>
    <Nav />
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-zinc-900">Heizöl</h1><p className="mt-1 text-sm text-zinc-500">Tankbestand, OilFox, Lieferungen und FIFO-Bewertung</p></div>
        {status && <span className={`text-sm ${/Gespeichert|aktualisiert|importiert|bereit/.test(status) ? "text-green-600" : "text-red-600"}`}>{status}</span>}
      </div>

      <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-zinc-900">OilFox-Status</h2><p className="text-sm text-zinc-500">{oilFox.configured ? `${oilFox.devices.length} Gerät(e) erkannt` : "Zugangsdaten nicht konfiguriert"}{oilFox.syncState?.lastSuccessAt ? ` · zuletzt ${new Date(oilFox.syncState.lastSuccessAt).toLocaleString("de-DE")}` : ""}</p></div><button disabled={syncing || !oilFox.configured} onClick={() => void syncOilFox()} className={buttonClass}>{syncing ? "Aktualisiere…" : "Jetzt aktualisieren"}</button></div>
        {oilFox.syncState?.lastError && <p className="mt-3 text-sm text-red-600">{oilFox.syncState.lastError}</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">{oilFox.devices.map((device) => <div key={device.id} className="rounded-lg border border-zinc-200 p-3 text-sm"><p className="font-medium text-zinc-900">{device.hwid}</p><p className="text-zinc-500">{device.connectionStatus} · {device.tankId ? "Tank zugeordnet" : "noch nicht zugeordnet"}</p></div>)}</div>
      </section>

      <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-zinc-900">{editingSystemId ? "Heizsystem bearbeiten" : "Heizsystem anlegen"}</h2>
        <form className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={async (event) => { event.preventDefault(); const saved = await submit(editingSystemId ? "updateSystem" : "createSystem", { ...systemForm, ...(editingSystemId ? { id: editingSystemId } : {}) }); if (saved) { setEditingSystemId(null); setSystemForm({ propertyId: "", name: "Ölheizung", billingRegime: "STANDARD_HEIZKOSTENV", exceptionReason: "", unitIds: [] }); } }}>
          <label className="text-sm font-medium text-zinc-700">Objekt<select required disabled={Boolean(editingSystemId)} className={inputClass} value={systemForm.propertyId} onChange={(e) => setSystemForm({ ...systemForm, propertyId: e.target.value, unitIds: [] })}><option value="">Bitte wählen</option>{properties.map((property) => <option key={property.id} value={property.id}>{property.street}, {property.city}</option>)}</select></label>
          <label className="text-sm font-medium text-zinc-700">Bezeichnung<input required className={inputClass} value={systemForm.name} onChange={(e) => setSystemForm({ ...systemForm, name: e.target.value })} /></label>
          <label className="text-sm font-medium text-zinc-700">Abrechnungsregime<select className={inputClass} value={systemForm.billingRegime} onChange={(e) => setSystemForm({ ...systemForm, billingRegime: e.target.value })}><option value="SECTION_11_EXCEPTION">§ 11 Ausnahme</option><option value="SECTION_2_CONTRACTUAL_DEVIATION">§ 2 Vereinbarung</option><option value="STANDARD_HEIZKOSTENV">Standard HeizkostenV (gesperrt)</option></select></label>
          <label className="text-sm font-medium text-zinc-700">Begründung<input required className={inputClass} value={systemForm.exceptionReason} onChange={(e) => setSystemForm({ ...systemForm, exceptionReason: e.target.value })} /></label>
          <div className="sm:col-span-2 lg:col-span-4"><p className="mb-2 text-sm font-medium text-zinc-700">Angeschlossene Wohnungen</p><div className="flex flex-wrap gap-4">{selectedProperty?.units?.map((unit) => <label key={unit.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={systemForm.unitIds.includes(unit.id)} onChange={(e) => setSystemForm({ ...systemForm, unitIds: e.target.checked ? [...systemForm.unitIds, unit.id] : systemForm.unitIds.filter((id) => id !== unit.id) })} />{unit.name} ({unit.areaM2 || "keine Fläche"} m²)</label>)}</div></div>
          <div className="flex gap-2"><button className={buttonClass}>Heizsystem speichern</button>{editingSystemId && <button type="button" className="rounded-lg border border-zinc-300 px-4 py-2 text-sm" onClick={() => { setEditingSystemId(null); setSystemForm({ propertyId: "", name: "Ölheizung", billingRegime: "STANDARD_HEIZKOSTENV", exceptionReason: "", unitIds: [] }); }}>Abbrechen</button>}</div>
        </form>
      </section>

      {systems.length === 0 ? <EmptyState message="Noch kein Heizsystem vorhanden." /> : <div className="mb-8 space-y-5">{systems.map((system) => <section key={system.id} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-start justify-between"><div><h2 className="text-lg font-semibold text-zinc-900">{system.name}</h2><p className="text-sm text-zinc-500">{system.property.street}, {system.property.city} · {system.billingRegime}</p></div><div className="flex gap-2"><button className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50" onClick={() => { setEditingSystemId(system.id); setSystemForm({ propertyId: system.property.id, name: system.name, billingRegime: system.billingRegime, exceptionReason: system.exceptionReason || "", unitIds: system.units.map((row) => row.unit.id) }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Bearbeiten</button><span className="rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700">{system.units.length} Wohnungen</span></div></div>
        {system.tanks.map((tank) => <div key={tank.id} className="mt-4 rounded-lg border border-zinc-200 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-medium text-zinc-900">{tank.name}</h3><p className="text-xs text-zinc-500">Kapazität {tank.capacityLiters || "—"} L · Liefererkennung ab {tank.deliveryDetectionThresholdLiters} L · {tank.inventoryLots.length} FIFO-Lots</p></div>{tank.stockReadings[0] && <div className="text-right"><p className="text-xl font-semibold text-zinc-900">{tank.stockReadings[0].quantityLiters ?? "—"} L</p><p className="text-xs text-zinc-500">{tank.stockReadings[0].fillLevelPercent ?? "—"}% · Batterie {tank.stockReadings[0].batteryLevel ?? "—"}</p></div>}</div>
          <TankChart readings={tank.stockReadings}/>
          <div className="mt-3 grid gap-4 lg:grid-cols-3"><div><h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">FIFO-Bestand</h4>{tank.inventoryLots.map((lot) => <p key={lot.id} className="text-sm text-zinc-600">{new Date(lot.sourceDate).toLocaleDateString("de-DE")}: {lot.quantityLiters} L · {centsToEuro(lot.totalAmountCents)}</p>)}</div><div><h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Lieferungen</h4>{tank.deliveries.map((delivery) => <div key={delivery.id} className="mb-3 text-sm text-zinc-600"><p>{new Date(delivery.deliveryDate).toLocaleDateString("de-DE")}: {delivery.quantityLiters} L · {centsToEuro(delivery.totalAmountCents)}</p><DocumentUpload heatingOilDeliveryId={delivery.id} category="heating-oil-invoice" label="Rechnung"/></div>)}</div><div><h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Messverlauf</h4>{tank.stockReadings.slice(0, 8).map((reading) => <p key={reading.id} className="text-sm text-zinc-600">{new Date(reading.readingDate).toLocaleString("de-DE")}: {reading.quantityLiters ?? "—"} L · {reading.source}{reading.validationError ? ` · ${reading.validationError}` : ""}</p>)}</div></div>
          {tank.deliveryCandidates.filter((candidate) => candidate.status === "PENDING").map((candidate) => <div key={candidate.id} className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4"><p className="font-medium text-amber-900">Mögliche Heizöllieferung erkannt: +{candidate.estimatedIncreaseLiters} L</p><p className="text-sm text-amber-700">{candidate.beforeMeasurement.quantityLiters} L → {candidate.afterMeasurement.quantityLiters} L am {new Date(candidate.afterMeasurement.readingDate).toLocaleString("de-DE")}</p><div className="mt-2 flex gap-2"><button className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white" onClick={() => { setDeliveryForm({ ...deliveryForm, tankId: tank.id, deliveryDate: candidate.afterMeasurement.readingDate.slice(0, 10), quantityLiters: candidate.estimatedIncreaseLiters, candidateId: candidate.id }); document.getElementById("delivery-form")?.scrollIntoView({ behavior: "smooth" }); }}>Rechnung erfassen</button><button className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs" onClick={() => void submit("updateCandidate", { id: candidate.id, status: "IGNORED" })}>Ignorieren</button></div></div>)}
        </div>)}
      </section>)}</div>}

      <div className="grid gap-6 lg:grid-cols-2">
        <DataForm title="Tank anlegen" onSubmit={() => submit("createTank", tankForm)}><Select label="Heizsystem" value={tankForm.heatingSystemId} onChange={(value) => setTankForm({ ...tankForm, heatingSystemId: value })} options={systems.map((system) => [system.id, system.name])} /><Field label="Bezeichnung" value={tankForm.name} onChange={(value) => setTankForm({ ...tankForm, name: value })} /><Field label="Kapazität (l)" type="number" value={tankForm.capacityLiters} onChange={(value) => setTankForm({ ...tankForm, capacityLiters: value })} /></DataForm>
        <DataForm title="Anfangsbestand" onSubmit={() => submit("createOpeningLot", { ...openingForm, totalAmountCents: euroToCents(openingForm.totalAmountEuro), co2CostCents: euroToCents(openingForm.co2CostEuro) })}><TankSelect tanks={tanks} value={openingForm.tankId} onChange={(value) => setOpeningForm({ ...openingForm, tankId: value })} /><Field label="Datum" type="date" value={openingForm.sourceDate} onChange={(value) => setOpeningForm({ ...openingForm, sourceDate: value })} /><Field label="Menge (L)" type="number" value={openingForm.quantityLiters} onChange={(value) => setOpeningForm({ ...openingForm, quantityLiters: value })} /><Field label="Bestandswert (€)" type="number" value={openingForm.totalAmountEuro} onChange={(value) => setOpeningForm({ ...openingForm, totalAmountEuro: value })} /></DataForm>
        <div id="delivery-form"><DataForm title="Heizöllieferung" onSubmit={() => submit("createDelivery", { ...deliveryForm, totalAmountCents: euroToCents(deliveryForm.totalAmountEuro), co2CostCents: euroToCents(deliveryForm.co2CostEuro) })}><TankSelect tanks={tanks} value={deliveryForm.tankId} onChange={(value) => setDeliveryForm({ ...deliveryForm, tankId: value })} /><Field label="Lieferdatum" type="date" value={deliveryForm.deliveryDate} onChange={(value) => setDeliveryForm({ ...deliveryForm, deliveryDate: value })} /><Field label="Menge (L)" type="number" value={deliveryForm.quantityLiters} onChange={(value) => setDeliveryForm({ ...deliveryForm, quantityLiters: value })} /><Field label="Gesamtbetrag (€)" type="number" value={deliveryForm.totalAmountEuro} onChange={(value) => setDeliveryForm({ ...deliveryForm, totalAmountEuro: value })} /><Field label="Lieferant" value={deliveryForm.supplier} onChange={(value) => setDeliveryForm({ ...deliveryForm, supplier: value })} /><Field label="Rechnungsnummer" value={deliveryForm.invoiceNumber} onChange={(value) => setDeliveryForm({ ...deliveryForm, invoiceNumber: value })} /></DataForm></div>
        <DataForm title="Tankstand erfassen" onSubmit={() => submit("createReading", readingForm)}><TankSelect tanks={tanks} value={readingForm.tankId} onChange={(value) => setReadingForm({ ...readingForm, tankId: value })} /><Field label="Ablesedatum" type="date" value={readingForm.readingDate} onChange={(value) => setReadingForm({ ...readingForm, readingDate: value })} /><Field label="Tankstand (l)" type="number" value={readingForm.quantityLiters} onChange={(value) => setReadingForm({ ...readingForm, quantityLiters: value })} /></DataForm>
        <form onSubmit={previewCsv} className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"><h2 className="mb-4 text-lg font-semibold text-zinc-900">OilFox-CSV importieren</h2><p className="mb-4 text-sm text-zinc-500">Zuerst Vorschau prüfen, danach Import ausdrücklich bestätigen.</p><div className="grid gap-4 sm:grid-cols-2"><TankSelect tanks={tanks} value={csv.tankId} onChange={(value) => { setCsv({ ...csv, tankId: value, deviceId: "" }); setCsvPreview(null); }} /><Select label="OilFox-Gerät (Liter)" value={csv.deviceId} onChange={(value) => { setCsv({ ...csv, deviceId: value }); setCsvPreview(null); }} options={oilFox.devices.filter((item) => !item.tankId || item.tankId === csv.tankId).map((item) => [item.id, `${item.hwid}${item.tankId ? " · diesem Tank zugeordnet" : " · noch zuordnen"}`])} /><label className="text-sm font-medium text-zinc-700">CSV-Datei<input required type="file" accept=".csv,text/csv" className={inputClass} onChange={(event) => { setCsv({ ...csv, file: event.target.files?.[0] || null }); setCsvPreview(null); }}/></label></div>{csv.tankId && csv.deviceId && !oilFox.devices.find((item) => item.id === csv.deviceId)?.tankId && <button type="button" className="mt-4 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50" onClick={() => void submit("assignOilFoxDevice", { deviceId: csv.deviceId, tankId: csv.tankId })}>Gerät diesem Tank zuordnen</button>}<button className={`${buttonClass} mt-4`}>Vorschau erstellen</button>{csvPreview && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-medium">{csvPreview.imported} neue Messungen · {csvPreview.skippedDuplicates} Duplikate · {csvPreview.invalidRows} ungültig · {csvPreview.candidateCount || 0} mögliche Lieferungen</p>{csvPreview.measuredFrom && <p className="mt-1">Zeitraum: {new Date(csvPreview.measuredFrom).toLocaleString("de-DE")} bis {csvPreview.measuredTo ? new Date(csvPreview.measuredTo).toLocaleString("de-DE") : "—"}</p>}{csvPreview.warnings.map((warning) => <p key={warning} className="mt-1">Warnung: {warning}</p>)}<button type="button" className={`${buttonClass} mt-3`} onClick={() => void importCsv()}>Import verbindlich starten</button></div>}</form>
      </div>
    </main>
  </>;
}

function DataForm({ title, children, onSubmit }: { title: string; children: React.ReactNode; onSubmit: () => Promise<boolean> }) { return <form className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}><h2 className="mb-4 text-lg font-semibold text-zinc-900">{title}</h2><div className="grid gap-4 sm:grid-cols-2">{children}</div><button className={`${buttonClass} mt-4`}>Speichern</button></form>; }
function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) { return <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700"><span>{label}</span><input required type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.01" : undefined} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} /></label>; }
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) { return <label className="flex flex-col gap-1 text-sm font-medium text-zinc-700"><span>{label}</span><select required className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Bitte wählen</option>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>; }
function TankSelect({ tanks, value, onChange }: { tanks: Array<Tank & { systemName: string }>; value: string; onChange: (value: string) => void }) { return <Select label="Tank" value={value} onChange={onChange} options={tanks.map((tank) => [tank.id, `${tank.systemName} – ${tank.name}`])} />; }
function TankChart({ readings }: { readings: Reading[] }) { const values = readings.filter((row) => row.quantityLiters != null).slice(0, 30).reverse(); if (values.length < 2) return null; const max = Math.max(...values.map((row) => Number(row.quantityLiters))); const points = values.map((row, index) => `${(index / (values.length - 1)) * 100},${50 - (Number(row.quantityLiters) / max) * 45}`).join(" "); return <svg aria-label="Tankverlauf" viewBox="0 0 100 50" className="mt-4 h-28 w-full rounded-lg bg-zinc-50 p-2" preserveAspectRatio="none"><polyline fill="none" stroke="#b91c1c" strokeWidth="1.5" points={points}/></svg>; }
