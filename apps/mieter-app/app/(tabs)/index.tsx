import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from "react-native";
import { useRouter } from "expo-router";
import { api } from "../../lib/api";
import { formatCurrency, formatDateRange } from "../../lib/format";
import type { TenantProfile, BillingPeriodSummary } from "../../lib/types";

export default function DashboardScreen() {
  const router = useRouter();
  const [profile, setProfile] = useState<TenantProfile | null>(null);
  const [billingPeriods, setBillingPeriods] = useState<BillingPeriodSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [p, bp] = await Promise.all([
        api.getProfile(),
        api.getBillingPeriods(),
      ]);
      setProfile(p);
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

  const latestBp = billingPeriods[0];

  if (loading) {
    return (
      <View style={styles.center}>
        <Text style={styles.loadingText}>Laden...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#b91c1c" />
      }
    >
      {/* Property Card */}
      {profile && (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Meine Wohnung</Text>
          <Text style={styles.cardTitle}>
            {profile.property.street}
          </Text>
          <Text style={styles.cardSubtitle}>
            {profile.property.zip} {profile.property.city}
          </Text>
          <View style={styles.cardRow}>
            <View style={styles.cardDetail}>
              <Text style={styles.detailLabel}>Einheit</Text>
              <Text style={styles.detailValue}>{profile.unit.name}</Text>
            </View>
            <View style={styles.cardDetail}>
              <Text style={styles.detailLabel}>Etage</Text>
              <Text style={styles.detailValue}>{profile.unit.floor}</Text>
            </View>
            <View style={styles.cardDetail}>
              <Text style={styles.detailLabel}>Anteile</Text>
              <Text style={styles.detailValue}>
                {profile.unit.shares}/{profile.property.totalShares}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* Latest Billing Period */}
      {latestBp && (
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push(`/billing/${latestBp.id}`)}
          activeOpacity={0.7}
        >
          <Text style={styles.cardLabel}>Aktuelle Abrechnung</Text>
          <Text style={styles.cardTitle}>
            {formatDateRange(latestBp.startDate, latestBp.endDate)}
          </Text>
          <View style={styles.resultRow}>
            <Text style={styles.resultLabel}>
              {latestBp.difference >= 0 ? "Erstattung" : "Nachzahlung"}
            </Text>
            <Text
              style={[
                styles.resultValue,
                { color: latestBp.difference >= 0 ? "#16a34a" : "#dc2626" },
              ]}
            >
              {formatCurrency(Math.abs(latestBp.difference))} EUR
            </Text>
          </View>
          <View style={styles.resultDetails}>
            <Text style={styles.detailText}>
              Ihr Anteil: {formatCurrency(latestBp.totalUnitCosts)} EUR
            </Text>
            <Text style={styles.detailText}>
              Vorauszahlung: {formatCurrency(latestBp.totalPrepayment)} EUR
            </Text>
          </View>
          <Text style={styles.chevron}>Details ansehen →</Text>
        </TouchableOpacity>
      )}

      {billingPeriods.length === 0 && (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Noch keine Abrechnungen vorhanden.
          </Text>
        </View>
      )}
      {profile?.externalBillings?.map((closing) => (
        <View key={closing.id} style={styles.card}>
          <Text style={styles.cardLabel}>Abrechnungsarchiv</Text>
          <Text style={styles.cardTitle}>Extern erledigt bis {new Date(closing.closingDate).toLocaleDateString("de-DE")}</Text>
          <Text style={styles.emptyText}>{closing.note || "Für diesen Abschluss wurden keine Kostenwerte nacherfasst."}</Text>
        </View>
      ))}
    </ScrollView>
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
  cardLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#b91c1c",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#18181b",
    marginBottom: 2,
  },
  cardSubtitle: {
    fontSize: 14,
    color: "#71717a",
    marginBottom: 16,
  },
  cardRow: {
    flexDirection: "row",
    gap: 24,
  },
  cardDetail: {},
  detailLabel: {
    fontSize: 11,
    color: "#a1a1aa",
    marginBottom: 2,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: "600",
    color: "#3f3f46",
  },
  resultRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  resultLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#3f3f46",
  },
  resultValue: {
    fontSize: 20,
    fontWeight: "700",
  },
  resultDetails: {
    marginBottom: 12,
  },
  detailText: {
    fontSize: 13,
    color: "#71717a",
    marginBottom: 2,
  },
  chevron: {
    fontSize: 13,
    color: "#b91c1c",
    fontWeight: "500",
  },
  emptyText: {
    fontSize: 14,
    color: "#a1a1aa",
    textAlign: "center",
    paddingVertical: 24,
  },
});
