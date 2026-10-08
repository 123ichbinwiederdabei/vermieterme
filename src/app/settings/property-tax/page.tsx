"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Nav } from "@/components/nav";
import type { Property } from "@/types";
import { euroToCents, euroToMicroEuros } from "@/lib/money";

type Form = {
  allocationMethod: "ALLOCATABLE_AMOUNT" | "RATE_PER_M2";
  assessment: string;
  allocatable: string;
  rate: string;
  note: string;
};
const empty: Form = {
  allocationMethod: "ALLOCATABLE_AMOUNT",
  assessment: "",
  allocatable: "",
  rate: "",
  note: "",
};
function decimalToScaled(value: string, scale: number) {
  return scale === 2 ? euroToCents(value) : euroToMicroEuros(value);
}
function scaledToDecimal(value: string | null | undefined, scale: number) {
  if (!value) return "";
  const raw = value.padStart(scale + 1, "0");
  return `${raw.slice(0, -scale)}.${raw.slice(-scale)}`;
}

export default function PropertyTaxSettingsPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [form, setForm] = useState<Form>(empty);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void fetch("/api/properties")
      .then((r) => r.json())
      .then((rows) => {
        setProperties(rows);
        if (rows[0]) setPropertyId(rows[0].id);
      });
  }, []);
  useEffect(() => {
    if (!propertyId) return;
    const controller = new AbortController();
    void fetch(`/api/properties/${propertyId}/property-tax-setting`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok)
          throw new Error(
            "Grundsteuer-Einstellungen konnten nicht geladen werden",
          );
        return response.json();
      })
      .then((row) => {
        setForm(
          row
            ? {
                allocationMethod: row.allocationMethod,
                assessment: scaledToDecimal(row.annualAssessmentCents, 2),
                allocatable: scaledToDecimal(
                  row.annualAllocatableAmountCents,
                  2,
                ),
                rate: scaledToDecimal(row.annualRateMicroCentsPerM2, 6),
                note: row.allocationNote ?? "",
              }
            : empty,
        );
        setLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setStatus(error.message);
      });
    return () => controller.abort();
  }, [propertyId]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus("");
    try {
      const response = await fetch(
        `/api/properties/${propertyId}/property-tax-setting`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allocationMethod: form.allocationMethod,
            annualAssessmentCents: form.assessment
              ? decimalToScaled(form.assessment, 2)
              : null,
            annualAllocatableAmountCents: form.allocatable
              ? decimalToScaled(form.allocatable, 2)
              : null,
            annualRateMicroCentsPerM2: form.rate
              ? decimalToScaled(form.rate, 6)
              : null,
            allocationNote: form.note,
          }),
        },
      );
      setStatus(
        response.ok
          ? "Gespeichert"
          : (await response.json()).error || "Speichern fehlgeschlagen",
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Speichern fehlgeschlagen",
      );
    }
  }
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <p className="mb-2 text-sm text-zinc-500">
          <Link href="/settings" className="hover:underline">
            Einstellungen
          </Link>{" "}
          / Grundsteuerumlage
        </p>
        <h1 className="mb-2 text-2xl font-bold text-zinc-900">
          Grundsteuerumlage
        </h1>
        <p className="mb-6 text-sm text-zinc-600">
          Nur der tatsächlich auf die Mietwohnungen entfallende Anteil wird
          verteilt. Der Rest bleibt Vermieteranteil.
        </p>
        <form
          onSubmit={save}
          className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
        >
          <fieldset disabled={loading}>
            <label className="mb-1 block text-sm font-medium">Objekt</label>
            <select
              value={propertyId}
              onChange={(e) => {
                setLoading(true);
                setStatus("");
                setPropertyId(e.target.value);
              }}
              className="mb-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.street}, {p.zip} {p.city}
                </option>
              ))}
            </select>
            <label className="mb-1 block text-sm font-medium">
              Grundsteuer laut Bescheid pro Jahr (€)
            </label>
            <input
              required
              value={form.assessment}
              onChange={(e) => setForm({ ...form, assessment: e.target.value })}
              inputMode="decimal"
              className="mb-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            />
            <label className="mb-1 block text-sm font-medium">
              Umlageverfahren
            </label>
            <select
              value={form.allocationMethod}
              onChange={(e) =>
                setForm({
                  ...form,
                  allocationMethod: e.target.value as Form["allocationMethod"],
                })
              }
              className="mb-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="ALLOCATABLE_AMOUNT">
                Umlagefähiger Wohnanteil
              </option>
              <option value="RATE_PER_M2">Satz je m² Wohnfläche</option>
            </select>
            {form.allocationMethod === "ALLOCATABLE_AMOUNT" ? (
              <>
                <label className="mb-1 block text-sm font-medium">
                  Umlagefähiger Wohnanteil pro Jahr (€)
                </label>
                <input
                  required
                  value={form.allocatable}
                  onChange={(e) =>
                    setForm({ ...form, allocatable: e.target.value })
                  }
                  inputMode="decimal"
                  className="mb-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                />
              </>
            ) : (
              <>
                <label className="mb-1 block text-sm font-medium">
                  Jährlicher Satz je m² (€)
                </label>
                <input
                  required
                  value={form.rate}
                  onChange={(e) => setForm({ ...form, rate: e.target.value })}
                  inputMode="decimal"
                  className="mb-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                />
              </>
            )}
            <label className="mb-1 block text-sm font-medium">
              Abgrenzung / Hinweis
            </label>
            <textarea
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              className="mb-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              rows={3}
            />
            <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">
              Speichern
            </button>
          </fieldset>
          {loading && !status && (
            <p role="status" className="mt-3 text-sm text-zinc-600">
              Einstellungen werden geladen…
            </p>
          )}
          {status && (
            <span className="ml-3 text-sm text-zinc-600">{status}</span>
          )}
        </form>
      </main>
    </>
  );
}
