"use client";
import { useCallback, useEffect, useState } from "react";
import { DocumentUpload } from "@/components/document-upload";
import { InvoiceTemplateEditor } from "@/components/invoice-template-editor";
import { SECTION_LABELS } from "@/lib/invoice-labels";
import { INVOICE_SECTIONS, LINE_CLASSES } from "@/lib/invoice-categories";
import {
  type ExtractionResult,
  type OcrDocument,
} from "@/lib/invoice-extraction";
import { centsToEuro, euroToCents, euroToMicroEuros } from "@/lib/money";
import { fromScaledInteger } from "@/lib/billing-v2";

export const invoiceInputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none";
const button =
  "rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50";
type Attachment = {
  document: { id: string; originalName: string; mimeType: string };
};
type Job = {
  id: string;
  documentId: string;
  status: string;
  ocrJson: string | null;
  resultJson: string | null;
  error: string | null;
};
type Invoice = {
  id: string;
  billingPeriodId: string;
  costCategoryId: string;
  section: string;
  status: string;
  invoiceNumber: string | null;
  totalAmountCents: string;
  dataJson: string;
  attachments: Attachment[];
  lines: Line[];
  extractionJobs: Job[];
};
type Line = {
  amountInput?: string;
  description: string;
  amountCents: string;
  classification: string;
  confirmedRunningExpense: boolean;
};
type Template = {
  id: string;
  name: string;
  supplier: string;
  section: string;
  rulesJson: string;
  markersJson: string;
  version: number;
  status: string;
};
const labels: Record<string, string> = {
  supplier: "Lieferant",
  invoiceNumber: "Rechnungsnummer",
  invoiceDate: "Rechnungsdatum",
  servicePeriodStart: "Leistungsbeginn",
  servicePeriodEnd: "Leistungsende",
  totalAmountCents: "Bruttobetrag (€)",
  netAmountCents: "Nettobetrag (€)",
  vatAmountCents: "Umsatzsteuer (€)",
  vatRate: "Umsatzsteuer (%)",
  deliveryDate: "Lieferdatum",
  quantityLiters: "Heizölmenge (L)",
  co2CostCents: "CO₂-Kosten (€)",
  co2Grams: "CO₂-Ausstoß (g)",
  consumptionKwh: "Verbrauch laut Rechnung (kWh)",
  meterNumber: "Zählernummer",
  priceMicroEuroPerKwh: "Arbeitspreis (€/kWh)",
  monthlyBasePriceCents: "Grundpreis (€/Monat)",
  tariffValidFrom: "Tarif gültig ab",
  tariffValidTo: "Tarif gültig bis",
  annualAllocatableAmountCents: "Wohnanteil der beiden Mietwohnungen (€)",
  taxBasisNote: "Belegte Berechnung des Wohnanteils",
  energyContentKwh: "Energiegehalt (kWh)",
  emissionFactorMicrogWh: "Emissionsfaktor",
  annualRateMicroCentsPerM2: "Jahressatz je m² (€)",
};
const common = [
  "supplier",
  "invoiceNumber",
  "invoiceDate",
  "servicePeriodStart",
  "servicePeriodEnd",
  "totalAmountCents",
  "netAmountCents",
  "vatAmountCents",
  "vatRate",
];
const extra: Record<string, string[]> = {
  HEATING: [
    "deliveryDate",
    "quantityLiters",
    "co2CostCents",
    "co2Grams",
    "energyContentKwh",
  ],
  ELECTRICITY: [
    "meterNumber",
    "consumptionKwh",
    "priceMicroEuroPerKwh",
    "monthlyBasePriceCents",
    "tariffValidFrom",
    "tariffValidTo",
  ],
  PROPERTY_TAX: ["annualAllocatableAmountCents", "taxBasisNote"],
};
function scaledField(key: string) {
  return key.endsWith("Cents")
    ? 2
    : key === "priceMicroEuroPerKwh" || key === "annualRateMicroCentsPerM2"
      ? 6
      : null;
}
function displayValue(key: string, value: string) {
  const scale = scaledField(key);
  return scale !== null && /^-?\d+$/.test(value)
    ? fromScaledInteger(BigInt(value), scale)
    : value;
}
function valuesToInputs(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      displayValue(key, value),
    ]),
  );
}
function inputsToValues(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => [
        key,
        scaledField(key) === 2
          ? euroToCents(value)
          : scaledField(key) === 6
            ? euroToMicroEuros(value)
            : value,
      ]),
  );
}

async function api(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Aktion fehlgeschlagen");
  return data;
}

function InvoiceReview({
  periodId,
  invoice,
  code,
  tanks,
  contracts,
  onChanged,
  locked,
}: {
  periodId: string;
  invoice: Invoice;
  code: string;
  tanks: { id: string; name: string }[];
  contracts: { id: string; provider: string }[];
  onChanged: () => void;
  locked: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    valuesToInputs(JSON.parse(invoice.dataJson)),
  );
  const [lines, setLines] = useState<Line[]>(invoice.lines);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [duplicateReason, setDuplicateReason] = useState("");
  const job = invoice.extractionJobs[0];
  const proposal: ExtractionResult | null = job?.resultJson
    ? JSON.parse(job.resultJson)
    : null;
  const fields = [
    ...common,
    ...(code === "HEATING" && invoice.section !== "HEATING_OIL"
      ? []
      : (extra[code] ?? [])),
  ];
  async function confirm() {
    setBusy(true);
    setMessage("");
    try {
      const data = inputsToValues(values);
      await api(`/api/cost-invoices/${invoice.id}`, "PATCH", {
        action: "confirm",
        values: data,
        lines: lines.map((line) => ({
          ...line,
          amountCents:
            line.amountInput === undefined
              ? line.amountCents
              : euroToCents(line.amountInput),
        })),
        duplicateReason,
      });
      onChanged();
      setMessage("Rechnung bestätigt");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Fehler");
    } finally {
      setBusy(false);
    }
  }
  async function extract() {
    setBusy(true);
    try {
      await api(`/api/cost-invoices/${invoice.id}/extract`, "POST", {});
      onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Fehler");
    } finally {
      setBusy(false);
    }
  }
  const readOnly = locked || invoice.status !== "DRAFT";
  return (
    <details
      className="rounded-lg border border-zinc-200 bg-zinc-50 p-4"
      open={invoice.status === "DRAFT"}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {SECTION_LABELS[invoice.section] || invoice.section} ·{" "}
        {invoice.invoiceNumber || "Neue Rechnung"} · {invoice.status} ·{" "}
        {centsToEuro(invoice.totalAmountCents)}
      </summary>
      <div className="mt-4 space-y-4">
        <DocumentUpload
          costInvoiceId={invoice.id}
          category="invoice"
          label="Rechnung hochladen"
          readOnly={readOnly}
          onUploaded={onChanged}
        />
        {invoice.attachments.map(({ document }) => (
          <a
            key={document.id}
            href={`/api/documents/${document.id}/file`}
            target="_blank"
            rel="noopener noreferrer"
            className="mr-3 text-sm text-red-700 underline"
          >
            {document.originalName}
          </a>
        ))}
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              className={button}
              disabled={busy || !invoice.attachments.length}
              onClick={() => void extract()}
            >
              Google OCR starten
            </button>
            <span className="text-sm text-zinc-600">
              {job?.status || "Noch nicht extrahiert"}
            </span>
          </div>
        )}
        {job?.error && (
          <p role="alert" className="text-sm text-red-700">
            {job.error}
          </p>
        )}
        {proposal && !readOnly && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            <p className="font-medium">
              OCR-Vorschläge · vor Bestätigung mit dem Beleg vergleichen
            </p>
            {Object.entries(proposal.fields).map(([field, result]) => (
              <p key={field}>
                {labels[field] || field}:{" "}
                {result.value === null
                  ? "—"
                  : displayValue(field, result.value)}{" "}
                {result.errors.join(" ")}
              </p>
            ))}
            {proposal.errors.map((error, i) => (
              <p key={i} className="text-red-700">
                {error}
              </p>
            ))}
            <button
              className={`${button} mt-2`}
              disabled={
                readOnly ||
                (!Object.values(proposal.fields).some(
                  (field) => field.value !== null,
                ) &&
                  !proposal.lines.length)
              }
              onClick={() => {
                setValues({
                  ...values,
                  ...valuesToInputs(
                    Object.fromEntries(
                      Object.entries(proposal.fields)
                        .filter(([, result]) => result.value !== null)
                        .map(([key, result]) => [key, result.value!]),
                    ),
                  ),
                });
                if (proposal.lines.length) setLines(proposal.lines);
              }}
            >
              Vorschläge in Formular übernehmen
            </button>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {invoice.attachments[0] && (
            <iframe
              title="Originalrechnung"
              className="h-[600px] w-full rounded-lg border border-zinc-200 bg-white"
              src={`/api/documents/${invoice.attachments[0].document.id}/file`}
            />
          )}
          <div className="grid content-start gap-3 sm:grid-cols-2">
            {fields.map((key) => (
              <label key={key} className="text-sm text-zinc-700">
                {labels[key] || key}
                <input
                  className={invoiceInputClass}
                  type={
                    /Date$|Start$|End$|ValidFrom$|ValidTo$/.test(key)
                      ? "date"
                      : "text"
                  }
                  value={values[key] ?? ""}
                  disabled={readOnly}
                  onChange={(e) =>
                    setValues({ ...values, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            {invoice.section === "TARIF" && (
              <label className="text-sm">
                Stromvertrag
                <select
                  className={invoiceInputClass}
                  value={values.contractId ?? ""}
                  disabled={readOnly}
                  onChange={(e) =>
                    setValues({ ...values, contractId: e.target.value })
                  }
                >
                  <option value="">Vertrag wählen</option>
                  {contracts.map((contract) => (
                    <option key={contract.id} value={contract.id}>
                      {contract.provider}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-zinc-500">
                  Bestätigte Brutto-Arbeits- und Grundpreise werden in den
                  Vertrag übernommen.
                </span>
              </label>
            )}
            {invoice.section === "HEATING_OIL" && (
              <label className="text-sm">
                Tank
                <select
                  className={invoiceInputClass}
                  value={values.tankId ?? ""}
                  disabled={readOnly}
                  onChange={(e) =>
                    setValues({ ...values, tankId: e.target.value })
                  }
                >
                  <option value="">Tank wählen</option>
                  {tanks.map((tank) => (
                    <option key={tank.id} value={tank.id}>
                      {tank.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
        {invoice.status === "CONFIRMED" && !locked && (
          <button
            className={button}
            onClick={() =>
              void api("/api/cost-invoices", "POST", {
                billingPeriodId: periodId,
                costCategoryId: (
                  invoice as Invoice & { costCategoryId: string }
                ).costCategoryId,
                section: invoice.section,
                revisionOfId: invoice.id,
              })
                .then(onChanged)
                .catch((e) => setMessage(e.message))
            }
          >
            Korrektur als Revision erfassen
          </button>
        )}
        {!readOnly && (
          <>
            <p className="text-sm text-zinc-500">
              Bei gemischten Rechnungen alle Positionen erfassen. Reparatur- und
              Erneuerungskosten bleiben beim Vermieter.
            </p>
            {lines.map((line, index) => (
              <div key={index} className="grid items-end gap-2 sm:grid-cols-4">
                <label className="text-sm">
                  Position
                  <input
                    className={invoiceInputClass}
                    value={line.description}
                    onChange={(e) =>
                      setLines(
                        lines.map((r, i) =>
                          i === index
                            ? { ...r, description: e.target.value }
                            : r,
                        ),
                      )
                    }
                  />
                </label>
                <label className="text-sm">
                  Brutto (€)
                  <input
                    className={invoiceInputClass}
                    value={
                      line.amountInput ??
                      displayValue("totalAmountCents", line.amountCents)
                    }
                    onChange={(e) =>
                      setLines(
                        lines.map((r, i) =>
                          i === index
                            ? { ...r, amountInput: e.target.value }
                            : r,
                        ),
                      )
                    }
                  />
                </label>
                <label className="text-sm">
                  Klassifikation
                  <select
                    className={invoiceInputClass}
                    value={line.classification}
                    onChange={(e) =>
                      setLines(
                        lines.map((r, i) =>
                          i === index
                            ? { ...r, classification: e.target.value }
                            : r,
                        ),
                      )
                    }
                  >
                    {LINE_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {SECTION_LABELS[c] || c}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <label className="text-xs">
                    <input
                      type="checkbox"
                      checked={line.confirmedRunningExpense}
                      onChange={(e) =>
                        setLines(
                          lines.map((r, i) =>
                            i === index
                              ? {
                                  ...r,
                                  confirmedRunningExpense: e.target.checked,
                                }
                              : r,
                          ),
                        )
                      }
                    />{" "}
                    Sonstiges als Betriebskosten bestätigt
                  </label>
                  <button
                    className={button}
                    onClick={() =>
                      setLines(lines.filter((_, i) => i !== index))
                    }
                  >
                    Entfernen
                  </button>
                </div>
              </div>
            ))}
            <button
              className={button}
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    description: "",
                    amountCents: "0",
                    classification: invoice.section,
                    confirmedRunningExpense: false,
                  },
                ])
              }
            >
              Position hinzufügen
            </button>
            <label className="block text-sm">
              Begründung bei möglicher Dublette
              <input
                className={invoiceInputClass}
                value={duplicateReason}
                onChange={(e) => setDuplicateReason(e.target.value)}
              />
            </label>
            <div className="flex gap-2">
              <button
                className="rounded-lg bg-red-700 px-4 py-2 text-sm text-white disabled:opacity-50"
                disabled={busy}
                onClick={() => void confirm()}
              >
                Geprüfte Rechnung bestätigen
              </button>
              <button
                className={button}
                onClick={() =>
                  void api(`/api/cost-invoices/${invoice.id}`, "DELETE")
                    .then(onChanged)
                    .catch((e) => setMessage(e.message))
                }
              >
                Entwurf verwerfen
              </button>
            </div>
          </>
        )}
        {message && (
          <p role="status" className="text-sm text-red-700">
            {message}
          </p>
        )}
      </div>
    </details>
  );
}

export function CategoryInvoices({
  periodId,
  category,
  tanks,
  contracts = [],
  locked,
  onChanged,
}: {
  periodId: string;
  category: { id: string; code: string };
  tanks: { id: string; name: string }[];
  contracts?: { id: string; provider: string }[];
  locked: boolean;
  onChanged: () => void;
}) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [section, setSection] = useState(
    (INVOICE_SECTIONS[category.code] ?? ["OPERATING"])[0],
  );
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<{
    section: string;
    template?: Template;
  } | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const load = useCallback(async () => {
    try {
      const [invoices, templates] = await Promise.all([
        api(
          `/api/cost-invoices?billingPeriodId=${periodId}&costCategoryId=${category.id}`,
        ),
        api(`/api/invoice-templates?costCategoryId=${category.id}`),
      ]);
      setInvoices(invoices);
      setTemplates(templates);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Laden fehlgeschlagen");
    }
  }, [periodId, category.id]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const processing = invoices.some((invoice) =>
    invoice.extractionJobs.some(
      (job) => job.status === "QUEUED" || job.status === "PROCESSING",
    ),
  );
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [processing, load]);
  function changed() {
    void load();
    onChanged();
  }
  const samples = invoices
    .filter((invoice) => invoice.section === (editor?.section || section))
    .flatMap((invoice) =>
      invoice.attachments.flatMap(({ document }) => {
        const job = invoice.extractionJobs.find(
          (job) => job.documentId === document.id && job.ocrJson,
        );
        return job?.ocrJson
          ? [
              {
                documentId: document.id,
                name: document.originalName,
                mimeType: document.mimeType,
                ocr: JSON.parse(job.ocrJson) as OcrDocument,
              },
            ]
          : [];
      }),
    );
  async function create() {
    try {
      await api("/api/cost-invoices", "POST", {
        billingPeriodId: periodId,
        costCategoryId: category.id,
        section,
      });
      changed();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Fehler");
    }
  }
  async function reprocess() {
    try {
      for (const invoice of invoices.filter(
        (invoice) =>
          invoice.status === "DRAFT" &&
          invoice.section === section &&
          invoice.attachments.length,
      ))
        await api(`/api/cost-invoices/${invoice.id}/extract`, "POST", {
          templateId: selectedTemplate,
        });
      changed();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Fehler");
    }
  }
  return (
    <div className="mt-4 space-y-3">
      {!locked && (
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Rechnungsabschnitt"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            value={section}
            onChange={(e) => setSection(e.target.value)}
          >
            {(INVOICE_SECTIONS[category.code] ?? ["OPERATING"]).map(
              (section) => (
                <option key={section} value={section}>
                  {SECTION_LABELS[section] || section}
                </option>
              ),
            )}
          </select>
          <button className={button} onClick={() => void create()}>
            Rechnung erfassen
          </button>
        </div>
      )}
      <details className="rounded-lg border border-zinc-200 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Rechnungsvorlagen
        </summary>
        <div className="mt-3 space-y-2">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span>
                {template.name} ·{" "}
                {SECTION_LABELS[template.section] || template.section} · Version{" "}
                {template.version} · {template.status}
              </span>
              {!locked && (
                <button
                  className={button}
                  onClick={() => {
                    if (
                      !invoices.some(
                        (invoice) =>
                          invoice.section === template.section &&
                          invoice.extractionJobs.some((job) => job.ocrJson),
                      )
                    ) {
                      setMessage(
                        "Zuerst einen passenden Musterbeleg hochladen und OCR starten.",
                      );
                      return;
                    }
                    setEditor({ section: template.section, template });
                  }}
                >
                  Neue Version bearbeiten
                </button>
              )}
            </div>
          ))}
          {!locked && (
            <>
              <button
                className={button}
                disabled={!samples.length}
                onClick={() => setEditor({ section })}
              >
                Vorlage aus Musterbeleg erstellen
              </button>
              <p className="text-xs text-zinc-500">
                Für den visuellen Editor zuerst einen Beleg hochladen und Google
                OCR starten.
              </p>
              <select
                aria-label="Vorlage auswählen"
                className={invoiceInputClass}
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
              >
                <option value="">Veröffentlichte Vorlage auswählen</option>
                {templates
                  .filter(
                    (t) => t.status === "PUBLISHED" && t.section === section,
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · v{t.version}
                    </option>
                  ))}
              </select>
              <button
                className={button}
                disabled={!selectedTemplate}
                onClick={() => void reprocess()}
              >
                Entwürfe mit Vorlage neu extrahieren
              </button>
            </>
          )}
        </div>
      </details>
      {invoices.map((invoice) => (
        <InvoiceReview
          key={`${invoice.id}-${invoice.status}`}
          periodId={periodId}
          invoice={invoice}
          code={category.code}
          tanks={tanks}
          contracts={contracts}
          onChanged={changed}
          locked={locked}
        />
      ))}
      {!invoices.length && (
        <p className="text-sm text-zinc-500">Noch keine Rechnungen erfasst.</p>
      )}
      {message && (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      )}
      {editor && (
        <InvoiceTemplateEditor
          costCategoryId={category.id}
          section={editor.section}
          samples={samples}
          template={editor.template}
          onClose={() => setEditor(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}
