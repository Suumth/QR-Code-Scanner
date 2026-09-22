export type VoucherStatus = "available" | "redeemed";

export interface EventSummary {
  name: string;
  eventDate: string;
}

export interface SponsorSummary {
  name: string;
}

export interface VoucherTypeSummary {
  name: string;
}

export interface VoucherSummary {
  publicId: string;
  displayCode: string;
  status: VoucherStatus;
  voucherType: VoucherTypeSummary;
}

export interface SponsorVoucherType {
  name: string;
  totals: {
    total: number;
    available: number;
    redeemed: number;
  };
  vouchers: VoucherSummary[];
}

export interface SponsorSnapshot {
  event: EventSummary;
  sponsor: SponsorSummary;
  totals: {
    total: number;
    available: number;
    redeemed: number;
  };
  voucherTypes: SponsorVoucherType[];
}

export interface PublicVoucherSnapshot {
  event: EventSummary;
  sponsor: SponsorSummary;
  voucher: VoucherSummary;
}
