export type VoucherLocator =
  | { kind: "public_id"; value: string }
  | { kind: "display_code"; value: string };

export interface TeamVoucherDetails {
  publicId: string;
  displayCode: string;
  redeemedAt: string | null;
  event: {
    name: string;
    eventDate: string;
  };
  sponsor: {
    name: string;
  };
  voucherType: {
    name: string;
  };
}

export type InspectVoucherResult =
  | { status: "available"; voucher: TeamVoucherDetails & { redeemedAt: null } }
  | {
      status: "already_redeemed";
      voucher: TeamVoucherDetails & { redeemedAt: string };
    }
  | { status: "invalid" };

export type RedeemVoucherResult =
  | { status: "redeemed"; voucher: TeamVoucherDetails & { redeemedAt: string } }
  | {
      status: "already_redeemed";
      voucher: TeamVoucherDetails & { redeemedAt: string };
    }
  | { status: "invalid" };

export interface TeamVoucherRow {
  public_id: string;
  display_code: string;
  redeemed_at: string | null;
  event_name: string;
  event_date: string;
  sponsor_name: string;
  voucher_type_name: string;
}
