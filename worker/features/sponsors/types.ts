export type VoucherStatus = "available" | "redeemed";

export interface PublicEventSummary {
  name: string;
  eventDate: string;
}

export interface PublicSponsorSummary {
  name: string;
}

export interface PublicVoucherSummary {
  publicId: string;
  displayCode: string;
  status: VoucherStatus;
  voucherType: {
    name: string;
  };
}

export interface PublicVoucherTypeGroup {
  name: string;
  totals: {
    total: number;
    available: number;
    redeemed: number;
  };
  vouchers: PublicVoucherSummary[];
}

export interface SponsorSnapshot {
  event: PublicEventSummary;
  sponsor: PublicSponsorSummary;
  totals: {
    total: number;
    available: number;
    redeemed: number;
  };
  voucherTypes: PublicVoucherTypeGroup[];
}

export interface PublicVoucherSnapshot {
  event: PublicEventSummary;
  sponsor: PublicSponsorSummary;
  voucher: PublicVoucherSummary;
}
