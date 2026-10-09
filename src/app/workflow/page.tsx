"use client";
import { useEffect, useState } from "react";
import { Nav } from "@/components/nav";
import { centsToEuro, euroToCents } from "@/lib/money";

type Property = { id: string; street: string; city: string };
type Artifact = { id: string; documentId: string; tenantId: string; previewId: string; billingPeriodId: string; status: string; revision: number | null };
type Workspace = { units: Array<{ id: string; name: string; tenants: Array<{ id: string; firstName: string; lastName: string }> }>; billingPeriods: Array<{ id: string; startDate: string; endDate: string }>; storage: { enabled: boolean } | null };
type Validation = { ready: boolean; blockers: string[]; warnings: string[]; previewId?: string; documents?: Array<{ documentId: string; path: string; tenantId: string }> };
const inputStyle = "rounded border border-zinc-300 bg-white px-3 py-2 text-sm";
const buttonStyle = "rounded bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-50";

export default function WorkflowPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [archives, setArchives] = useState<Array<{ id: string; documentId: string; status: string; relativePath: string; error: string | null }>>([]);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [send, setSend] = useState({ artifactId: "", mailbox: "", recipient: "", subject: "Nebenkostenabrechnung", bodyText: "Anbei erhalten Sie Ihre Nebenkostenabrechnung." });
  const [sendPreview, setSendPreview] = useState<{ previewId: string } | null>(null);
  const [change, setChange] = useState({ tenantId: "", validFrom: "2026-10-01", cold: "", general: "", electricity: "", documentId: "" });
  const [changePreview, setChangePreview] = useState<{ previewId: string; proposed: { monthlyColdRentCents: string; monthlyGeneralOperatingAndHeatingPrepaymentCents: string; monthlyElectricityPrepaymentCents: string }; affectedDraftPeriods: unknown[] } | null>(null);
  useEffect(() => { fetch("/api/workflow").then((r) => r.json()).then((data) => { setProperties(data.properties || []); setPropertyId(data.properties?.[0]?.id || ""); }).catch(() => setMessage("Objekte konnten nicht geladen werden.")); }, []);
  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    fetch(`/api/workflow?propertyId=${encodeURIComponent(propertyId)}`).then((r) => r.json()).then((data) => {
      if (cancelled) return;
      setWorkspace(data.workspace || null); setArtifacts(data.artifacts || []); setArchives(data.archives || []);
      const requested = new URLSearchParams(window.location.search).get("billingPeriodId");
      setPeriodId(requested && data.workspace?.billingPeriods.some((p: { id: string }) => p.id === requested) ? requested : data.workspace?.billingPeriods[0]?.id || "");
    }).catch(() => setMessage("Arbeitsübersicht konnte nicht geladen werden."));
    return () => { cancelled = true; };
  }, [propertyId]);
  async function refresh() {
    const data = await (await fetch(`/api/workflow?propertyId=${encodeURIComponent(propertyId)}`)).json();
    setArtifacts(data.artifacts || []); setArchives(data.archives || []); setWorkspace(data.workspace || null);
  }
  async function action(body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/workflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      await refresh(); return data;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Prüfung fehlgeschlagen"); return null; }
    finally { setBusy(false); }
  }
  async function download(documentId: string) { const file = await action({ operation: "download", documentId }); if (file) window.open(file.download_url, "_blank", "noopener,noreferrer"); }
  const tenants = workspace?.units.flatMap((unit) => unit.tenants) || [];
  return <><Nav /><main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
    <h1 className="text-2xl font-semibold">Prüfung und Freigabe</h1>
    <p className="text-zinc-600">Prüfen Sie Grundlagen, PDFs und Empfänger. Jede Freigabe bezieht sich auf die angezeigte Fassung.</p>
    <div className="flex flex-wrap gap-3">
      <label>Objekt <select aria-label="Objekt" className={inputStyle} value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setValidation(null); }}><option value="">Auswählen</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.street}, {p.city}</option>)}</select></label>
      <label>Zeitraum <select aria-label="Zeitraum" className={inputStyle} value={periodId} onChange={(e) => { setPeriodId(e.target.value); setValidation(null); }}><option value="">Auswählen</option>{workspace?.billingPeriods.map((p) => <option key={p.id} value={p.id}>{p.startDate.slice(0, 10)} bis {p.endDate.slice(0, 10)}</option>)}</select></label>
    </div>
    {message && <p role="status" className="rounded border border-amber-200 bg-amber-50 p-4">{message}</p>}
    <section className="space-y-4 rounded border border-zinc-200 bg-white p-5">
      <h2 className="text-lg font-semibold">Abrechnung prüfen</h2>
      <p>OneDrive: {workspace?.storage?.enabled ? "aktiviert" : "vor endgültiger Freigabe einzurichten"}</p>
      <div className="flex flex-wrap gap-3"><button className={buttonStyle} disabled={busy || !periodId} onClick={async () => { const data = await action({ operation: "validate", billingPeriodId: periodId }); if (data) setValidation(data); }}>Prüfung starten</button>
      <button className={buttonStyle} disabled={busy || !periodId} onClick={async () => { const data = await action({ operation: "preview_billing", billingPeriodId: periodId }); if (data) setValidation(data); }}>PDF-Vorschau erstellen</button></div>
      {validation && <div><p className="font-medium">{validation.ready ? "Fachprüfung bestanden" : "Offene Prüfungen"}</p><ul className="list-inside list-disc">{validation.blockers.map((b) => <li key={b}>{b}</li>)}</ul>{validation.warnings.map((w) => <p key={w} className="text-amber-800">{w}</p>)}</div>}
      {validation?.documents?.map((doc) => <button key={doc.documentId} className="block text-red-700 underline" onClick={() => download(doc.documentId)}>PDF für {tenants.find((t) => t.id === doc.tenantId)?.firstName || "Mietverhältnis"} ansehen</button>)}
      {validation?.previewId && <button className={buttonStyle} disabled={busy} onClick={async () => {
        if (!window.confirm("Haben Sie alle angezeigten PDFs geprüft und möchten Sie genau diese Fassung freigeben?")) return;
        const data = await action({ operation: "issue", previewId: validation.previewId, confirmed: true });
        if (data) setMessage(data.status === "ARCHIVING" ? "Endgültige Ablage wird geprüft. Status aktualisieren und dieselbe Freigabe erneut aufrufen." : "Abrechnung ausgestellt und unveränderlich gespeichert.");
      }}>Geprüfte PDFs freigeben</button>}
      {validation?.previewId && <button className="ml-3 text-red-700 underline" disabled={busy} onClick={async () => { const data = await action({ operation: "renew_approval", previewId: validation.previewId }); if (data) { setValidation(data); setMessage("Freigabe erneuert. Dieselben unveränderten PDFs erneut prüfen."); } }}>Abgelaufene Freigabe erneut prüfen</button>}
    </section>
    <section className="space-y-3 rounded border border-zinc-200 bg-white p-5">
      <h2 className="text-lg font-semibold">Archivierung</h2><button className="text-red-700 underline" disabled={busy} onClick={() => refresh()}>Status aktualisieren</button>
      <button className="ml-3 text-red-700 underline" disabled={busy || !workspace?.storage?.enabled} onClick={async () => { const data = await action({ operation: "queue_originals", propertyId }); if (data) setMessage("Bestehende Originalbelege für die aktivierte Ablage geprüft und eingeplant."); }}>Bestehende Originale archivieren</button>
      {!archives.length && <p>Noch keine Archivaufträge.</p>}
      {archives.map((a) => <div key={a.id} className="flex flex-wrap justify-between gap-2 border-b py-2"><button className="text-left text-sm underline" onClick={() => download(a.documentId)}>{a.relativePath}</button><span>{a.status === "VERIFIED" ? "Geprüft" : a.status === "FAILED" ? "Prüfung erforderlich" : "Ausstehend"}</span>{a.status === "FAILED" && <button className="text-red-700 underline" onClick={() => action({ operation: "retry_archive", documentId: a.documentId })}>Erneut prüfen</button>}</div>)}
    </section>
    <section className="space-y-3 rounded border border-zinc-200 bg-white p-5">
      <h2 className="text-lg font-semibold">Vereinbarte Miete und Vorauszahlungen</h2>
      <p className="text-sm text-zinc-600">Ab dem Gültigkeitsdatum; Zahlungsrückstände werden separat geführt. Der Vertragsnachweis muss bereits hochgeladen sein.</p>
      <div className="grid gap-3 md:grid-cols-3"><select aria-label="Mietverhältnis" className={inputStyle} value={change.tenantId} onChange={(e) => { setChangePreview(null); setChange({ ...change, tenantId: e.target.value }); }}><option value="">Mietverhältnis</option>{tenants.map((t) => <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>)}</select>
      <input aria-label="Gültig ab" type="date" className={inputStyle} value={change.validFrom} onChange={(e) => { setChangePreview(null); setChange({ ...change, validFrom: e.target.value }); }}/>
      {([['cold', 'Kaltmiete (€)'], ['general', 'Betriebskosten / Heizung (€)'], ['electricity', 'Stromvorauszahlung (€)'], ['documentId', 'Vertragsnachweis-ID']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={label} className={`${inputStyle} block w-full`} value={change[key]} onChange={(e) => { setChangePreview(null); setChange({ ...change, [key]: e.target.value }); }}/></label>)}</div>
      <button className={buttonStyle} disabled={busy || !change.tenantId} onClick={async () => { const data = await action({ operation: "preview_change", action: "set_financial_period", values: { tenantId: change.tenantId, validFrom: change.validFrom, sourceDocumentId: change.documentId, monthlyColdRentCents: String(euroToCents(change.cold)), monthlyGeneralOperatingAndHeatingPrepaymentCents: String(euroToCents(change.general)), monthlyElectricityPrepaymentCents: String(euroToCents(change.electricity)), monthlyFlatRateCents: "0" }, reason: "Neue bestätigte Vertragsvereinbarung" }); if (data) setChangePreview(data); }}>Änderung prüfen</button>
      {changePreview && <div className="rounded bg-zinc-50 p-4"><p>Neue monatliche Beträge: {centsToEuro(BigInt(changePreview.proposed.monthlyColdRentCents))} Kaltmiete, {centsToEuro(BigInt(changePreview.proposed.monthlyGeneralOperatingAndHeatingPrepaymentCents))} Betriebskosten / Heizung, {centsToEuro(BigInt(changePreview.proposed.monthlyElectricityPrepaymentCents))} Strom. Gültig ab {change.validFrom}.</p><p>{changePreview.affectedDraftPeriods.length} Entwürfe werden neu geprüft.</p><button className={buttonStyle} disabled={busy} onClick={async () => { const data = await action({ operation: "commit_change", previewId: changePreview.previewId, confirmed: true }); if (data) { setChangePreview(null); setMessage("Geprüfte Vertragsvereinbarung gespeichert."); } }}>Diese Änderung bestätigen</button></div>}
    </section>
    <section className="space-y-3 rounded border border-zinc-200 bg-white p-5">
      <h2 className="text-lg font-semibold">Freigegebene Fassung versenden</h2>
      <select aria-label="Freigegebene PDF" className={inputStyle} value={send.artifactId} onChange={(e) => { setSend({ ...send, artifactId: e.target.value }); setSendPreview(null); }}><option value="">PDF auswählen</option>{artifacts.filter((a) => a.status === "ISSUED" && a.billingPeriodId === periodId).map((a) => <option key={a.id} value={a.id}>{tenants.find((t) => t.id === a.tenantId)?.firstName} · R{String(a.revision).padStart(3, "0")}</option>)}</select>
      {(['mailbox', 'recipient', 'subject'] as const).map((key) => <label key={key} className="block">{key === 'mailbox' ? 'Microsoft-Absender' : key === 'recipient' ? 'Empfänger' : 'Betreff'}<input className={`${inputStyle} ml-3`} value={send[key]} onChange={(e) => { setSend({ ...send, [key]: e.target.value }); setSendPreview(null); }}/></label>)}
      <textarea aria-label="Nachricht" className={`${inputStyle} w-full`} rows={4} value={send.bodyText} onChange={(e) => { setSend({ ...send, bodyText: e.target.value }); setSendPreview(null); }}/>
      <button className={buttonStyle} disabled={busy || !send.artifactId} onClick={async () => { const data = await action({ operation: "preview_send", values: send }); if (data) setSendPreview(data); }}>Versand prüfen</button>
      {sendPreview && <div className="space-y-3 rounded bg-zinc-50 p-4"><p>An {send.recipient} von {send.mailbox}: {send.subject}</p><p className="whitespace-pre-wrap">{send.bodyText}</p><button className="text-red-700 underline" onClick={() => download(artifacts.find((a) => a.id === send.artifactId)!.documentId)}>Genau diese PDF prüfen</button><button className={buttonStyle} disabled={busy} onClick={async () => { if (!window.confirm("Empfänger, Nachricht und PDF geprüft: Versand verbindlich bestätigen?")) return; const data = await action({ operation: "send", previewId: sendPreview.previewId, confirmed: true }); if (data) { setSendPreview(null); setMessage("Bestätigter Versand in die dauerhafte Outbox aufgenommen."); } }}>Diesen Versand bestätigen</button></div>}
    </section>
  </main></>;
}
