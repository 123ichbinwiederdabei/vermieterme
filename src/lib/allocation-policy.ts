// Every applied snapshot retains this policy, its effective date and its version.
// Change the version when a billing key or evidence rule changes.
export const ALLOCATION_POLICY = {
  version: "krandorf-dated-boundaries-v2",
  effectiveFrom: "2026-10-01",
  heating: "FIFO_ACTUAL_CONSUMPTION_VALIDATED_HEIZKOSTENV_LESS_LANDLORD_CO2",
  electricity: "INTERMEDIATE_METER_READINGS_EXACT_TARIFF_AGREED_BASE_KEY",
  water: "ALL_RESIDENTIAL_AREA_INCLUDING_OWNER",
  waste: "EQUAL_THIRDS_INCLUDING_OWNER",
  wastewater: "EQUAL_THIRDS_INCLUDING_OWNER_EXCLUDE_CAPITAL_COSTS",
  propertyTax: "EVIDENCED_RENTED_RESIDENTIAL_COMPONENT_ONLY",
  expectedAreaM2: {
    isabella: "80",
    vladimir: "200",
    landlord: "110",
    total: "390",
  },
} as const;
