"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import {
  anchorMatches,
  EXTRACTABLE_FIELDS,
  extractInvoice,
  type FieldFormat,
  type FieldRule,
  type OcrDocument,
  type Region,
  type TemplateRules,
} from "@/lib/invoice-extraction";
import {
  FIELD_LABELS,
  SECTION_LABELS,
  FORMAT_LABELS,
} from "@/lib/invoice-labels";
import { LINE_CLASSES } from "@/lib/invoice-categories";

const input =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm";
const button =
  "rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50";
type Sample = {
  documentId: string;
  name: string;
  mimeType: string;
  ocr: OcrDocument;
};
type Template = {
  id: string;
  name: string;
  supplier: string;
  section: string;
  rulesJson: string;
  markersJson: string;
  version: number;
};

function PagePreview({ sample, page }: { sample: Sample; page: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (sample.mimeType !== "application/pdf") return;
    let cancelled = false;
    let destroy: (() => void) | undefined;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc =
          "/api/invoice-templates/pdf-worker";
        const task = pdfjs.getDocument({
          url: `/api/documents/${sample.documentId}/file`,
        });
        destroy = () => {
          void task.destroy();
        };
        const pdf = await task.promise;
        const pdfPage = await pdf.getPage(page);
        if (cancelled || !canvas.current) return;
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        const context = canvas.current.getContext("2d");
        if (context)
          await pdfPage.render({
            canvas: canvas.current,
            canvasContext: context,
            viewport,
          }).promise;
      } catch {
        if (!cancelled) setError("PDF-Vorschau konnte nicht geladen werden.");
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [sample.documentId, sample.mimeType, page]);
  return sample.mimeType === "application/pdf" ? (
    <>
      <canvas ref={canvas} className="block w-full" />
      {error && <p role="alert">{error}</p>}
    </>
  ) : (
    <Image
      unoptimized
      width={1000}
      height={1000}
      style={{ height: "auto" }}
      src={`/api/documents/${sample.documentId}/file`}
      alt="Rechnungsbeleg"
      className="block w-full"
      draggable={false}
    />
  );
}

export function InvoiceTemplateEditor({
  costCategoryId,
  section,
  samples,
  template,
  onClose,
  onSaved,
}: {
  costCategoryId: string;
  section: string;
  samples: Sample[];
  template?: Template;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sampleIndex, setSampleIndex] = useState(0);
  const [page, setPage] = useState(1);
  const sample = samples[sampleIndex];
  const [name, setName] = useState(template?.name ?? "");
  const [supplier, setSupplier] = useState(template?.supplier ?? "");
  const [markers, setMarkers] = useState<string>(
    template ? JSON.parse(template.markersJson).join("\n") : "",
  );
  const [rules, setRules] = useState<TemplateRules>(
    template ? JSON.parse(template.rulesJson) : { fields: [] },
  );
  const [field, setField] = useState("invoiceDate");
  const [format, setFormat] = useState<FieldFormat>("DATE");
  const [required, setRequired] = useState(true);
  const [unit, setUnit] = useState("");
  const [anchor, setAnchor] = useState("");
  const [pattern, setPattern] = useState("");
  const [region, setRegion] = useState<Region | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [mode, setMode] = useState("field");
  const [classification, setClassification] = useState(section);
  const [expected, setExpected] = useState<
    Record<string, Record<string, string>>
  >({});
  const [expectedLines, setExpectedLines] = useState<Record<string, string>>(
    {},
  );
  const [savedId, setSavedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sampleRole, setSampleRole] = useState<Record<string, string>>({});
  const [sampleApproval, setSampleApproval] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  function change(next: TemplateRules) {
    setRules(next);
    setSavedId(null);
    setTested(false);
  }
  function addSelection() {
    if (!region || !sample) return;
    if (mode !== "field") {
      const current = rules.table ?? {
        page,
        region,
        descriptionRegion: region,
        amountRegion: region,
        classification,
      };
      change({
        ...rules,
        table: { ...current, [mode]: region, page, classification },
      });
      return;
    }
    const anchors = anchorMatches(
      sample.ocr.pages.find((p) => p.page === page) ?? { page, words: [] },
      anchor,
    );
    if (anchor && anchors.length !== 1) {
      setMessage("Textanker muss auf dieser Seite genau einmal vorkommen.");
      return;
    }
    const rule: FieldRule = {
      field,
      page,
      region,
      format,
      required,
      unit: unit || undefined,
      pattern: pattern || undefined,
      anchor: anchor
        ? {
            text: anchor,
            dx: region.x - anchors[0].x,
            dy: region.y - anchors[0].y,
          }
        : undefined,
    };
    change({
      ...rules,
      fields: [...rules.fields.filter((r) => r.field !== field), rule],
    });
    setMessage("Feldregel hinzugefügt. Erwarteten Testwert prüfen.");
  }
  async function request(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Vorlagenaktion fehlgeschlagen");
    return data;
  }
  async function save() {
    setBusy(true);
    try {
      const saved = await request("/api/invoice-templates", {
        costCategoryId,
        section,
        name,
        supplier,
        markers: markers
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        rules,
        revisionOfId: template?.id,
      });
      setSavedId(saved.id);
      setTested(false);
      setMessage(
        `Entwurf Version ${saved.version} gespeichert. Testwerte erfassen und testen.`,
      );
      onSaved();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Fehler");
    } finally {
      setBusy(false);
    }
  }
  async function previewSample() {
    setBusy(true); setMessage(""); setSampleApproval(null);
    try {
      const result = await request("/api/workflow", { operation: "preview_change", action: "confirm_invoice_sample", values: { documentId: sample.documentId, expected: expected[sample.documentId] || {}, expectedLines: rules.table ? JSON.parse(expectedLines[sample.documentId] || "[]") : [], role: sampleRole[sample.documentId] || "TRAINING" }, reason: "Sollwerte unabhängig am Original gelesen" });
      setSampleApproval(result.previewId);
    } catch (e) { setMessage(e instanceof Error ? e.message : "Prüfung fehlgeschlagen"); }
    finally { setBusy(false); }
  }
  async function confirmSample() {
    if (!sampleApproval) return;
    setBusy(true); setMessage("");
    try { await request("/api/workflow", { operation: "commit_change", previewId: sampleApproval, confirmed: true, reason: "Diese Sollwerte am Original ausdrücklich bestätigt" }); setSampleApproval(null); setMessage("Unabhängige Sollwerte gespeichert. Zwei Beispielbelege und einen zurückgehaltenen Vergleich bestätigen."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Bestätigung fehlgeschlagen"); }
    finally { setBusy(false); }
  }
  async function test() {
    if (!savedId) return;
    setBusy(true);
    try {
      const result = await request(`/api/invoice-templates/${savedId}`, {
        action: "test",
        samples: samples
          .filter((s) => expected[s.documentId])
          .map((s) => ({
            documentId: s.documentId,
            expected: expected[s.documentId],
            expectedLines: rules.table
              ? JSON.parse(expectedLines[s.documentId] || "null")
              : undefined,
          })),
      });
      setTested(result.passed);
      setMessage(
        result.passed
          ? "Unabhängige Regression bestanden. Vorlage automatisch veröffentlicht."
          : JSON.stringify(
              result.results.map(
                (r: {
                  mismatches: string[];
                  extracted: { errors: string[] };
                }) => ({
                  abweichendeFelder: r.mismatches,
                  fehler: r.extracted.errors,
                }),
              ),
            ),
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Fehler");
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!savedId) return;
    setBusy(true);
    try {
      await request(`/api/invoice-templates/${savedId}`, { action: "publish" });
      onSaved();
      onClose();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Fehler");
    } finally {
      setBusy(false);
    }
  }
  let preview: ReturnType<typeof extractInvoice> | null = null;
  try {
    if (rules.fields.length && sample)
      preview = extractInvoice(sample.ocr, rules);
  } catch {
    /* Draft rules remain editable. */
  }
  if (!sample) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-zinc-950/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Rechnungsvorlage bearbeiten"
        className="mx-auto max-w-7xl rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex justify-between">
          <h2 className="text-xl font-semibold">
            Rechnungsvorlage · {SECTION_LABELS[section] || section}
          </h2>
          <button className={button} onClick={onClose}>
            Schließen
          </button>
        </div>
        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div>
            <div className="mb-3 flex gap-2">
              <select
                aria-label="Testbeleg"
                className={input}
                value={sampleIndex}
                onChange={(e) => {
                  setSampleApproval(null);
                  setSampleIndex(Number(e.target.value));
                  setPage(1);
                }}
              >
                {samples.map((s, i) => (
                  <option key={s.documentId} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Seite"
                className={input}
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
              >
                {sample.ocr.pages.map((p) => (
                  <option key={p.page} value={p.page}>
                    Seite {p.page}
                  </option>
                ))}
              </select>
            </div>
            <p className="mb-2 text-sm text-zinc-600">
              Ein Rechteck um den Wert ziehen, dann die Feldregel hinzufügen.
            </p>
            <div
              className="relative select-none border border-zinc-200"
              onPointerDown={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setDragStart({
                  x: (e.clientX - box.left) / box.width,
                  y: (e.clientY - box.top) / box.height,
                });
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerUp={(e) => {
                if (!dragStart) return;
                const box = e.currentTarget.getBoundingClientRect();
                const x = Math.max(
                  0,
                  Math.min(1, (e.clientX - box.left) / box.width),
                );
                const y = Math.max(
                  0,
                  Math.min(1, (e.clientY - box.top) / box.height),
                );
                setRegion({
                  x: Math.min(dragStart.x, x),
                  y: Math.min(dragStart.y, y),
                  width: Math.abs(x - dragStart.x),
                  height: Math.abs(y - dragStart.y),
                });
                setDragStart(null);
              }}
            >
              <PagePreview sample={sample} page={page} />
              {rules.fields
                .filter((r) => r.page === page)
                .map((r) => (
                  <div
                    key={r.field}
                    title={r.field}
                    className="pointer-events-none absolute border border-blue-600 bg-blue-100/20"
                    style={{
                      left: `${r.region.x * 100}%`,
                      top: `${r.region.y * 100}%`,
                      width: `${r.region.width * 100}%`,
                      height: `${r.region.height * 100}%`,
                    }}
                  />
                ))}
              {region && (
                <div
                  className="pointer-events-none absolute border-2 border-red-700 bg-red-100/30"
                  style={{
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.width * 100}%`,
                    height: `${region.height * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
          <div className="space-y-4">
            <label className="block text-sm">
              Vorlagenname
              <input
                className={input}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSavedId(null);
                }}
              />
            </label>
            <label className="block text-sm">
              Lieferant
              <input
                className={input}
                value={supplier}
                onChange={(e) => {
                  setSupplier(e.target.value);
                  setSavedId(null);
                }}
              />
            </label>
            <label className="block text-sm">
              Erkennungsmerkmale · eines pro Zeile
              <textarea
                className={input}
                value={markers}
                onChange={(e) => {
                  setMarkers(e.target.value);
                  setSavedId(null);
                  setTested(false);
                }}
              />
            </label>
            <label className="block text-sm">
              Auswahl verwenden für
              <select
                className={input}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="field">Einzelfeld</option>
                <option value="region">Tabellenbereich</option>
                <option value="descriptionRegion">
                  Tabellenspalte Beschreibung
                </option>
                <option value="amountRegion">
                  Tabellenspalte Bruttobetrag
                </option>
              </select>
            </label>
            {mode === "field" ? (
              <>
                <label className="block text-sm">
                  Feld
                  <select
                    className={input}
                    value={field}
                    onChange={(e) => setField(e.target.value)}
                  >
                    {EXTRACTABLE_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABELS[f] || FORMAT_LABELS[f] || f}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Format
                  <select
                    className={input}
                    value={format}
                    onChange={(e) => setFormat(e.target.value as FieldFormat)}
                  >
                    {[
                      "TEXT",
                      "DATE",
                      "CENTS",
                      "DECIMAL",
                      "PERCENT",
                      "GRAMS",
                      "MICRO_EURO",
                    ].map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABELS[f] || FORMAT_LABELS[f] || f}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  Einheit (z. B. kg für CO₂)
                  <input
                    className={input}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Textanker (optional)
                  <input
                    className={input}
                    value={anchor}
                    onChange={(e) => setAnchor(e.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  Einfaches Textmuster (optional)
                  <input
                    className={input}
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  <input
                    type="checkbox"
                    checked={required}
                    onChange={(e) => setRequired(e.target.checked)}
                  />{" "}
                  Pflichtfeld
                </label>
              </>
            ) : (
              <label className="block text-sm">
                Zeilenklassifikation
                <select
                  className={input}
                  value={classification}
                  onChange={(e) => setClassification(e.target.value)}
                >
                  {LINE_CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {SECTION_LABELS[c] || c}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              className={button}
              disabled={!region}
              onClick={addSelection}
            >
              Auswahl als Regel übernehmen
            </button>
            {rules.fields.map((rule) => (
              <div
                key={rule.field}
                className="rounded border border-zinc-200 p-2 text-sm"
              >
                <div className="flex justify-between">
                  <span>
                    {FIELD_LABELS[rule.field]} · {FORMAT_LABELS[rule.format]}
                  </span>
                  <button
                    onClick={() =>
                      change({
                        ...rules,
                        fields: rules.fields.filter(
                          (r) => r.field !== rule.field,
                        ),
                      })
                    }
                  >
                    Entfernen
                  </button>
                </div>
                <p className="text-zinc-500">
                  Erkannt: {preview?.fields[rule.field]?.value ?? "—"}
                </p>
                <label>
                  Erwarteter Testwert (
                  {rule.format === "CENTS"
                    ? "Cent"
                    : rule.format === "MICRO_EURO"
                      ? "Mikro-Euro"
                      : "normalisiert"}
                  )
                  <input
                    className={input}
                    value={expected[sample.documentId]?.[rule.field] ?? ""}
                    onChange={(e) => {
                      setSampleApproval(null);
                      setExpected({
                        ...expected,
                        [sample.documentId]: {
                          ...expected[sample.documentId],
                          [rule.field]: e.target.value,
                        },
                      });
                      setTested(false);
                    }}
                  />
                </label>
              </div>
            ))}
            {rules.table && (
              <div className="space-y-2">
                <p className="text-sm">Erkannte Positionen</p>
                <pre className="overflow-auto text-xs">
                  {JSON.stringify(preview?.lines, null, 2)}
                </pre>
                <label className="block text-sm">
                  Erwartete Tabellenpositionen (JSON, Beträge in Cent)
                  <textarea
                    className={input}
                    rows={6}
                    value={expectedLines[sample.documentId] ?? ""}
                    onChange={(e) => {
                      setSampleApproval(null);
                      setExpectedLines({
                        ...expectedLines,
                        [sample.documentId]: e.target.value,
                      });
                      setTested(false);
                    }}
                  />
                </label>
                <button
                  className={button}
                  onClick={() => change({ fields: rules.fields })}
                >
                  Tabellenregel entfernen
                </button>
              </div>
            )}
            {preview?.errors.map((error) => (
              <p key={error} className="text-sm text-red-700">
                {error}
              </p>
            ))}
            <p className="text-sm text-zinc-600">Mindestens zwei unabhängig geprüfte Beispielbelege und ein zurückgehaltener Vergleichsbeleg. Sollwerte direkt am Original lesen.</p>
            <label>Belegrolle<select aria-label="Belegrolle" className={input} value={sampleRole[sample.documentId] || "TRAINING"} onChange={(e) => { setSampleRole({ ...sampleRole, [sample.documentId]: e.target.value }); setSampleApproval(null); }}><option value="TRAINING">Beispielbeleg</option><option value="HOLDOUT">Zurückgehaltener Vergleich</option></select></label>
            <button className={button} disabled={busy} onClick={() => void previewSample()}>Sollwerte am Original prüfen</button>
            {sampleApproval && <div className="rounded border p-3"><p>{sample.name} · {sampleRole[sample.documentId] || "TRAINING"}</p><dl>{Object.entries(expected[sample.documentId] || {}).map(([field, value]) => <div key={field}><dt>{FIELD_LABELS[field] || field}</dt><dd>{value}</dd></div>)}</dl><button className={button} disabled={busy} onClick={() => void confirmSample()}>Diese Sollwerte bestätigen</button></div>}
            <div className="flex flex-wrap gap-2">
              <button
                className={button}
                disabled={busy}
                onClick={() => void save()}
              >
                Entwurf speichern
              </button>
              <button
                className={button}
                disabled={busy || !savedId}
                onClick={() => void test()}
              >
                Vorlage testen
              </button>
              <button
                className="rounded-lg bg-red-700 px-3 py-2 text-sm text-white disabled:opacity-50"
                disabled={busy || !savedId || !tested}
                onClick={() => void publish()}
              >
                Veröffentlichen
              </button>
            </div>
            {message && (
              <p role="status" className="rounded-lg bg-zinc-100 p-3 text-sm">
                {message}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
