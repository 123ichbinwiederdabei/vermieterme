import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { api } from "../../lib/api";
import { formatCents, formatDateRange } from "../../lib/format";
import type { BillingPeriodSummary } from "../../lib/types";

function getStatusBadge(bp: BillingPeriodSummary) {
  if (bp.paidDate) return { label: "Bezahlt", bg: "#dcfce7", color: "#16a34a" };
  if (bp.sentDate)
    return { label: "Versendet", bg: "#dbeafe", color: "#2563eb" };
  if (bp.billingDate)
    return { label: "Abgeschlossen", bg: "#d1fae5", color: "#059669" };
  return { label: "Offen", bg: "#f4f4f5", color: "#71717a" };
}

export default function BillingScreen() {
  const router = useRouter();
  const [billingPeriods, setBillingPeriods] = useState<BillingPeriodSummary[]>(
    [],
  );
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const bp = await api.getBillingPeriods();
      setBillingPeriods(bp);
    } catch {
      // handled by auth guard
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Laden...</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.listContent}
      data={billingPeriods}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#b91c1c"
        />
      }
      ListEmptyComponent={
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            Noch keine Abrechnungen vorhanden.
          </Text>
        </View>
      }
      renderItem={({ item }) => {
        const status = getStatusBadge(item);
        const isPositive = BigInt(item.differenceCents) >= 0n;

        return (
          <TouchableOpacity
            style={styles.card}
            onPress={() => router.push(`/billing/${item.id}`)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.periodText}>
                {formatDateRange(item.startDate, item.endDate)}
              </Text>
              <View style={[styles.badge, { backgroundColor: status.bg }]}>
                <Text style={[styles.badgeText, { color: status.color }]}>
                  {status.label}
                </Text>
              </View>
            </View>

            <View style={styles.cardBody}>
              <View style={styles.costRow}>
                <Text style={styles.costLabel}>Ihr Anteil</Text>
                <Text style={styles.costValue}>
                  {formatCents(item.totalUnitCostsCents)} EUR
                </Text>
              </View>
              <View style={styles.costRow}>
                <Text style={styles.costLabel}>Vorauszahlung</Text>
                <Text style={styles.costValue}>
                  {formatCents(item.totalPrepaymentCents)} EUR
                </Text>
              </View>
              <View style={[styles.costRow, styles.resultRow]}>
                <Text style={styles.resultLabel}>
                  {isPositive ? "Erstattung" : "Nachzahlung"}
                </Text>
                <Text
                  style={[
                    styles.resultValue,
                    { color: isPositive ? "#16a34a" : "#dc2626" },
                  ]}
                >
                  {formatCents(item.differenceCents, true)} EUR
                </Text>
              </View>
            </View>
          </TouchableOpacity>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f4f4f5",
  },
  listContent: {
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
  emptyContainer: {
    paddingVertical: 48,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    color: "#a1a1aa",
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#e4e4e7",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  periodText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#18181b",
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  cardBody: {
    gap: 6,
  },
  costRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  costLabel: {
    fontSize: 14,
    color: "#71717a",
  },
  costValue: {
    fontSize: 14,
    color: "#3f3f46",
  },
  resultRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#f4f4f5",
  },
  resultLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#3f3f46",
  },
  resultValue: {
    fontSize: 15,
    fontWeight: "700",
  },
});
