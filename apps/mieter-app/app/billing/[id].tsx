import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { api } from "../../lib/api";
import {
  formatCents,
  formatDateRange,
  formatDate,
  formatFileSize,
} from "../../lib/format";
import type { BillingPeriodDetail } from "../../lib/types";

export default function BillingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<BillingPeriodDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api
      .getBillingPeriod(id)
      .then(setDetail)
      .catch(() =>
        Alert.alert("Fehler", "Abrechnung konnte nicht geladen werden."),
      )
      .finally(() => setLoading(false));
  }, [id]);

  async function handleDownloadPdf() {
    if (!id) return;
    try {
      const url = await api.getPdfUrl(id);
      await WebBrowser.openBrowserAsync(url);
    } catch {
      Alert.alert("Fehler", "PDF konnte nicht geöffnet werden.");
    }
  }

  async function handleOpenDocument(docId: string) {
    try {
      const url = await api.getDocumentUrl(docId);
      await WebBrowser.openBrowserAsync(url);
    } catch {
      Alert.alert("Fehler", "Dokument konnte nicht geöffnet werden.");
    }
  }

  if (loading || !detail) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Laden...</Text>
      </View>
    );
  }

  const isPositive = BigInt(detail.totals.differenceCents) >= 0n;

  return (
    <>
      <Stack.Screen
        options={{
          title: formatDateRange(detail.startDate, detail.endDate),
          headerBackTitle: "Zurück",
        }}
      />
      <ScrollView style={styles.container}>
        {/* Result Card */}
        <View style={[styles.card, styles.resultCard]}>
          <Text style={styles.resultTitle}>
            {isPositive ? "Erstattung" : "Nachzahlung"}
          </Text>
          <Text
            style={[
              styles.resultAmount,
              { color: isPositive ? "#16a34a" : "#dc2626" },
            ]}
          >
            {formatCents(detail.totals.differenceCents, true)} EUR
          </Text>
        </View>

        {/* Cost Table */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Kostenaufstellung</Text>
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderText, { flex: 2 }]}>Kostenart</Text>
            <Text
              style={[styles.tableHeaderText, { flex: 1, textAlign: "right" }]}
            >
              Gesamt
            </Text>
            <Text
              style={[styles.tableHeaderText, { flex: 1, textAlign: "right" }]}
            >
              Ihr Anteil
            </Text>
          </View>
          {detail.costs.map((cost) => (
            <View key={cost.id} style={styles.tableRow}>
              <View style={{ flex: 2 }}>
                <Text style={styles.costName}>{cost.category}</Text>
                <Text style={styles.costKey}>{cost.distributionKey}</Text>
              </View>
              <Text
                style={[styles.costAmount, { flex: 1, textAlign: "right" }]}
              >
                {formatCents(cost.totalAmountCents)}
              </Text>
              <Text
                style={[styles.costAmount, { flex: 1, textAlign: "right" }]}
              >
                {formatCents(cost.amountCents)}
              </Text>
            </View>
          ))}
          <View style={styles.tableSumRow}>
            <Text style={[styles.sumText, { flex: 2 }]}>Gesamt</Text>
            <Text style={[styles.sumText, { flex: 1, textAlign: "right" }]}>
              {formatCents(detail.totals.totalCostsCents)}
            </Text>
            <Text style={[styles.sumText, { flex: 1, textAlign: "right" }]}>
              {formatCents(detail.totals.totalUnitCostsCents)}
            </Text>
          </View>
        </View>

        {/* Prepayment */}
        <View style={styles.card}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Ihre Vorauszahlungen</Text>
            <Text style={styles.summaryValue}>
              {formatCents(detail.totals.totalPrepaymentCents)} EUR
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Ihr Kostenanteil</Text>
            <Text style={styles.summaryValue}>
              {formatCents(detail.totals.totalUnitCostsCents)} EUR
            </Text>
          </View>
          <View style={[styles.summaryRow, styles.summaryResultRow]}>
            <Text style={styles.summaryResultLabel}>
              {isPositive ? "Erstattung" : "Nachzahlung"}
            </Text>
            <Text
              style={[
                styles.summaryResultValue,
                { color: isPositive ? "#16a34a" : "#dc2626" },
              ]}
            >
              {formatCents(detail.totals.differenceCents, true)} EUR
            </Text>
          </View>
        </View>

        {/* PDF Download */}
        <TouchableOpacity style={styles.pdfButton} onPress={handleDownloadPdf}>
          <Text style={styles.pdfButtonText}>PDF herunterladen</Text>
        </TouchableOpacity>

        {/* Documents */}
        {detail.documents.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Belege</Text>
            {detail.documents.map((doc) => (
              <TouchableOpacity
                key={doc.id}
                style={styles.documentRow}
                onPress={() => handleOpenDocument(doc.id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.documentName}>{doc.originalName}</Text>
                  <Text style={styles.documentMeta}>
                    {formatFileSize(doc.size)} · {formatDate(doc.createdAt)}
                  </Text>
                </View>
                <Text style={styles.documentAction}>Öffnen</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f4f4f5",
    padding: 16,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#f4f4f5",
  },
  loadingText: {
    color: "#71717a",
    fontSize: 16,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#e4e4e7",
  },
  resultCard: {
    alignItems: "center",
    paddingVertical: 24,
  },
  resultTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#71717a",
    marginBottom: 4,
  },
  resultAmount: {
    fontSize: 32,
    fontWeight: "800",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#b91c1c",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 16,
  },
  tableHeader: {
    flexDirection: "row",
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e4e4e7",
    marginBottom: 8,
  },
  tableHeaderText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#71717a",
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f4f4f5",
  },
  costName: {
    fontSize: 14,
    color: "#18181b",
  },
  costKey: {
    fontSize: 11,
    color: "#a1a1aa",
    marginTop: 1,
  },
  costAmount: {
    fontSize: 14,
    color: "#3f3f46",
  },
  tableSumRow: {
    flexDirection: "row",
    paddingTop: 12,
    borderTopWidth: 2,
    borderTopColor: "#18181b",
    marginTop: 4,
  },
  sumText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#18181b",
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  summaryLabel: {
    fontSize: 15,
    color: "#3f3f46",
  },
  summaryValue: {
    fontSize: 15,
    color: "#3f3f46",
  },
  summaryResultRow: {
    borderTopWidth: 2,
    borderTopColor: "#18181b",
    marginTop: 4,
    paddingTop: 12,
  },
  summaryResultLabel: {
    fontSize: 16,
    fontWeight: "700",
    color: "#18181b",
  },
  summaryResultValue: {
    fontSize: 16,
    fontWeight: "700",
  },
  pdfButton: {
    backgroundColor: "#b91c1c",
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: "center",
    marginBottom: 16,
  },
  pdfButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  documentRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f4f4f5",
  },
  documentName: {
    fontSize: 14,
    color: "#18181b",
  },
  documentMeta: {
    fontSize: 12,
    color: "#a1a1aa",
    marginTop: 2,
  },
  documentAction: {
    fontSize: 14,
    color: "#b91c1c",
    fontWeight: "500",
  },
});
