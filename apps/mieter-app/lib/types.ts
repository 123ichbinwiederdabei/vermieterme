export interface TenantProfile {
  id: string;
  salutation: string;
  firstName: string;
  lastName: string;
  salutation2: string | null;
  firstName2: string | null;
  lastName2: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  iban: string | null;
  accountHolder: string | null;
  moveInDate: string;
  moveOutDate: string | null;
  unit: {
    id: string;
    name: string;
    floor: string;
    shares: number;
  };
  property: {
    id: string;
    street: string;
    zip: string;
    city: string;
    totalShares: number;
  };
  externalBillings?: Array<{ id: string; closingDate: string; note: string | null }>;
}

export interface BillingPeriodSummary {
  id: string;
  startDate: string;
  endDate: string;
  billingDate: string | null;
  sentDate: string | null;
  paidDate: string | null;
  property: {
    street: string;
    zip: string;
    city: string;
  };
  totalUnitCosts: number;
  totalPrepayment: number;
  difference: number;
}

export interface BillingPeriodDetail {
  id: string;
  startDate: string;
  endDate: string;
  billingDate: string | null;
  sentDate: string | null;
  paidDate: string | null;
  property: {
    street: string;
    zip: string;
    city: string;
  };
  costs: Array<{
    id: string;
    category: string;
    distributionKey: string;
    totalAmount: number;
    unitAmount: number;
  }>;
  prepayments: Array<{
    id: string;
    monthlyAmount: number;
  }>;
  totals: {
    totalCosts: number;
    totalUnitCosts: number;
    totalPrepayment: number;
    difference: number;
  };
  documents: Array<DocumentItem>;
}

export interface DocumentItem {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  category: string;
  billingPeriodId: string | null;
  tenantId: string | null;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  tenant: {
    id: string;
    firstName: string;
    lastName: string;
  };
  unit: {
    id: string;
    name: string;
  };
  property: {
    street: string;
    zip: string;
    city: string;
  };
}
